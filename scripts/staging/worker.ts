// Staging Worker for rehearsing the rotation Workflow against a real store (spec.secret-rotation.md, open question
// 1). It hosts the package straight from src/: the Durable Object, the Workflow, and operator routes behind a bearer
// token. It is not an app: no webhooks, no admin UI. Deploy and drive it with scripts/staging/README.md.

import { DurableObjectSessionStorage } from '../../src/adapter.js'
import { createShopSessionsDurableObject } from '../../src/durable-object.js'
import type { ShopSessionsDurableObject } from '../../src/durable-object.js'
import { canonicalShop } from '../../src/shop.js'
import { createTokenClient } from '../../src/token-client.js'
import { createRotateSecretsWorkflow, rotationKeys } from '../../src/workflow.js'
import type { RotationKind, RotationParams } from '../../src/workflow.js'

export type Env = {
  SHOP_SESSIONS: DurableObjectNamespace<ShopSessionsDurableObject<Env>>
  SESSION: KVNamespace
  ROTATE_SECRETS: Workflow<RotationParams>
  SHOPIFY_API_KEY: string
  SHOPIFY_API_SECRET: string
  SHOPIFY_SESSION_ENCRYPTION_KEYS: string
  /** Bearer token for the operator routes. */
  OPERATOR_TOKEN: string
  /** Keyring retention for the rehearsal (wrangler.jsonc vars); production keeps the 90-day default. */
  KEYRING_RETENTION?: string
}

// Shopify only allows https redirect URLs; the operator pastes the URL the browser lands on (as the rehearsal does).
const REDIRECT_URI = 'https://localhost/callback'
const SCOPES = 'read_products'
const STATE_PREFIX = 'staging:oauth-state:'

export const ShopSessions = createShopSessionsDurableObject<Env>({
  registry: (env) => ({ kv: env.SESSION }),
  report: (error) => console.error(error.message),
})

export const RotateSecrets = createRotateSecretsWorkflow<Env>({
  registry: (env) => ({ kv: env.SESSION }),
  namespace: (env) => env.SHOP_SESSIONS,
  report: (error) => console.error(error.message),
  keyringRetention: (env) => env.KEYRING_RETENTION,
})

export default {
  async fetch(request, env): Promise<Response> {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401)
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    try {
      if (request.method === 'GET' && url.pathname === '/install-url') return await installUrl(url, env)
      if (request.method === 'POST' && url.pathname === '/install') return await install(request, env)
      if (request.method === 'GET' && url.pathname === '/describe') return await describe(url, env)
      if (request.method === 'POST' && url.pathname === '/rotations') return await start(request, env)
      if (parts[0] === 'rotations' && parts[1] && parts.length === 2 && request.method === 'GET') {
        return json(await (await env.ROTATE_SECRETS.get(parts[1])).status())
      }
      if (parts[0] === 'rotations' && parts[1] && parts[2] === 'events' && request.method === 'POST') {
        const { type } = await body<{ type?: unknown }>(request)
        if (typeof type !== 'string') return json({ error: 'type is required' }, 400)
        await (await env.ROTATE_SECRETS.get(parts[1])).sendEvent({ type, payload: {} })
        return json({ sent: type })
      }
      if (parts[0] === 'locks' && parts[1] && request.method === 'DELETE') {
        if (parts[1] !== 'keyring' && parts[1] !== 'api-secret') return json({ error: 'unknown kind' }, 400)
        await env.SESSION.delete(rotationKeys(parts[1] as RotationKind).lock)
        return json({ deleted: parts[1] })
      }
      return json({ error: 'not found' }, 404)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500)
    }
  },
} satisfies ExportedHandler<Env>

async function authorized(request: Request, env: Env): Promise<boolean> {
  const given = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${env.OPERATOR_TOKEN}`
  if (!env.OPERATOR_TOKEN) return false
  const [a, b] = await Promise.all([digest(given), digest(expected)])
  return sameDigest(a, b)
}

async function installUrl(url: URL, env: Env): Promise<Response> {
  const shop = canonicalShop(url.searchParams.get('shop') ?? '')
  if (!shop) return json({ error: 'shop must be a *.myshopify.com domain' }, 400)
  const state = crypto.randomUUID()
  const authorize = new URL(`https://${shop}/admin/oauth/authorize`)
  authorize.search = new URLSearchParams({
    client_id: env.SHOPIFY_API_KEY,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
  }).toString()
  // The state proves the pasted callback answers this request; it lapses with the code.
  await env.SESSION.put(`${STATE_PREFIX}${state}`, shop, { expirationTtl: 600 })
  return json({ url: authorize.toString() })
}

/** Verifies the pasted callback, exchanges the code, migrates the legacy token and stores the expiring pair. */
async function install(request: Request, env: Env): Promise<Response> {
  const { callbackUrl } = await body<{ callbackUrl?: unknown }>(request)
  if (typeof callbackUrl !== 'string' || !URL.canParse(callbackUrl)) return json({ error: 'callbackUrl' }, 400)
  const query = new URL(callbackUrl).searchParams
  const shop = canonicalShop(query.get('shop') ?? '')
  const state = query.get('state') ?? ''
  if (!shop || (await env.SESSION.get(`${STATE_PREFIX}${state}`)) !== shop) {
    return json({ error: 'unknown or expired state' }, 400)
  }
  if (!(await validHmac(query, env.SHOPIFY_API_SECRET))) return json({ error: 'bad hmac' }, 400)
  await env.SESSION.delete(`${STATE_PREFIX}${state}`)

  const exchanged = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.SHOPIFY_API_KEY,
      client_secret: env.SHOPIFY_API_SECRET,
      code: query.get('code'),
    }),
  })
  const token = ((await exchanged.json().catch(() => ({}))) as { access_token?: unknown }).access_token
  if (!exchanged.ok || typeof token !== 'string') return json({ error: `code exchange: HTTP ${exchanged.status}` }, 502)

  const migrated = await createTokenClient({
    apiKey: env.SHOPIFY_API_KEY,
    apiSecretKey: env.SHOPIFY_API_SECRET,
  }).migrate(shop, token)
  if (migrated.outcome !== 'success' || !migrated.refreshToken) {
    return json({ error: `migration: ${migrated.outcome === 'success' ? 'no refresh token' : migrated.code}` }, 502)
  }
  const now = Date.now()
  const stub = env.SHOP_SESSIONS.get(env.SHOP_SESSIONS.idFromName(shop), { locationHint: 'enam' })
  const stored = await stub.putSession({
    shop,
    session: {
      shop,
      isOnline: false,
      scope: migrated.scope,
      accessToken: migrated.accessToken,
      expires: now + (migrated.expiresIn ?? 3600) * 1000,
      refreshToken: migrated.refreshToken,
      refreshTokenExpires: now + (migrated.refreshTokenExpiresIn ?? 90 * 86_400) * 1000,
    },
  })
  return json({ stored: stored.status, describe: await storage(env).describe(shop) })
}

async function describe(url: URL, env: Env): Promise<Response> {
  const shop = canonicalShop(url.searchParams.get('shop') ?? '')
  if (!shop) return json({ error: 'shop must be a *.myshopify.com domain' }, 400)
  return json(await storage(env).describe(shop))
}

async function start(request: Request, env: Env): Promise<Response> {
  // The Workflow validates the params itself and fails the instance on bad ones.
  const params = (await body<RotationParams>(request)) as RotationParams
  const instance = await env.ROTATE_SECRETS.create({ params })
  return json({ id: instance.id, status: await instance.status() })
}

function storage(env: Env): DurableObjectSessionStorage {
  return new DurableObjectSessionStorage({ namespace: env.SHOP_SESSIONS })
}

async function validHmac(query: URLSearchParams, secret: string): Promise<boolean> {
  const signed = new URLSearchParams(query)
  const hmac = signed.get('hmac') ?? ''
  signed.delete('hmac')
  signed.delete('signature')
  signed.sort()
  const key = await crypto.subtle.importKey('raw', encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, encode(signed.toString().replaceAll('+', '%20')))
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const [a, b] = await Promise.all([digest(hmac), digest(expected)])
  return sameDigest(a, b)
}

/** Constant-time comparison of two SHA-256 digests (always 32 bytes, so lengths never differ). */
function sameDigest(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number)
  return diff === 0
}

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encode(value))
}

function encode(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>
}

async function body<T>(request: Request): Promise<Partial<T>> {
  const value: unknown = await request.json().catch(() => ({}))
  return typeof value === 'object' && value !== null ? (value as Partial<T>) : {}
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}
