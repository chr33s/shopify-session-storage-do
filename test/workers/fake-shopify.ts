// An in-memory Shopify token endpoint with Shopify's rotation rules (DESIGN.md §2), injected as the Durable
// Object's `fetch`. It lives on globalThis so the tests and the objects (same isolate) share one instance.
//
// - A refresh token presented for the first time returns a new pair. It stays usable, and returns that same pair,
//   until the new refresh token is presented; then it is retired.
// - `exchange()` mints a pair the way a library token exchange does and retires every other refresh token of the
//   shop. Exchanges themselves aren't sent over HTTP: tests hand the pair to `putSession`.
// - Migrating a legacy token retires it at once (it is no longer accepted anywhere else); repeating the identical
//   request returns the same pair.
// - Scripted responses, a fixed delay and holds simulate failures, slow calls and lost responses.

export const API_KEY = 'test-api-key'
export const API_SECRET = 'test-api-secret'
export const ACCESS_TOKEN_LIFETIME_S = 3600
export const REFRESH_TOKEN_LIFETIME_S = 90 * 86_400

const TOKEN_PATH = '/admin/oauth/access_token'
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'
const OFFLINE_ACCESS_TOKEN = 'urn:shopify:params:oauth:token-type:offline-access-token'

export type Pair = {
  accessToken: string
  refreshToken: string
  scope: string
  expiresIn: number
  refreshTokenExpiresIn: number
}

export type Grant = 'refresh' | 'migrate'

export type Call = { shop: string; grant: Grant; presented: string; status: number }

export type Scripted = {
  status: number
  json?: unknown
  text?: string
  headers?: Record<string, string>
  /** Apply the grant first, as if Shopify processed the request and the response was lost. */
  processed?: boolean
}

/**
 * Holds the next call for a shop after Shopify has processed it, until released. Both sides poll a flag rather than
 * share a promise: a promise settled from another context would run the waiter's continuation in that context (the
 * test pool disables cross-request promise handling), and I/O from the wrong context fails.
 */
export class Hold {
  reached = false
  released = false

  release(): void {
    this.released = true
  }

  /** Resolves once the held call has been processed and is waiting. */
  async waitReached(timeoutMs = 5_000): Promise<void> {
    await poll(() => this.reached, timeoutMs, 'a held call')
  }
}

type RefreshState = { shop: string; retired: boolean; parent?: string; next?: Pair }
type LegacyState = { shop: string; pair?: Pair }

export class FakeShopify {
  readonly calls: Call[] = []
  /** Added to every call after it is processed. */
  delayMs = 0
  scope = 'read_products,write_discounts'
  private counter = 0
  private readonly refreshTokens = new Map<string, RefreshState>()
  private readonly legacyTokens = new Map<string, LegacyState>()
  private readonly scripts = new Map<string, Scripted[]>()
  private readonly holds = new Map<string, Hold[]>()
  private readonly minted = new Map<string, Pair[]>()

  reset(): void {
    this.calls.length = 0
    this.delayMs = 0
    this.scope = 'read_products,write_discounts'
    this.refreshTokens.clear()
    this.legacyTokens.clear()
    this.scripts.clear()
    this.holds.clear()
    this.minted.clear()
  }

  /** A library token exchange: a new pair, and every other refresh token of the shop retired. */
  exchange(shop: string): Pair {
    this.retireAll(shop)
    return this.mint(shop)
  }

  /** A legacy non-expiring offline token, as the old OAuth flow issued. */
  legacyToken(shop: string): string {
    const token = `shpat_legacy_${++this.counter}_${random()}`
    this.legacyTokens.set(token, { shop })
    return token
  }

  /** Queue responses for the shop's next calls, in order. */
  script(shop: string, ...responses: Scripted[]): void {
    this.scripts.set(shop, [...(this.scripts.get(shop) ?? []), ...responses])
  }

  hold(shop: string): Hold {
    const hold = new Hold()
    this.holds.set(shop, [...(this.holds.get(shop) ?? []), hold])
    return hold
  }

  callsFor(shop: string, grant?: Grant): Call[] {
    return this.calls.filter((call) => call.shop === shop && (grant === undefined || call.grant === grant))
  }

  /** Every pair issued for the shop (exchanges, refreshes, migrations), oldest first. */
  pairsFor(shop: string): Pair[] {
    return [...(this.minted.get(shop) ?? [])]
  }

  /** The most recently issued pair for the shop. */
  lastPair(shop: string): Pair {
    const pair = this.minted.get(shop)?.at(-1)
    if (!pair) throw new Error(`no pair issued for ${shop}`)
    return pair
  }

  /** Whether Shopify would accept this refresh token now. */
  isLive(refreshToken: string): boolean {
    const state = this.refreshTokens.get(refreshToken)
    return state !== undefined && !state.retired
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const shop = url.hostname
    if (url.protocol !== 'https:' || url.pathname !== TOKEN_PATH || request.method !== 'POST') {
      return json(404, { errors: 'Not Found' })
    }
    const body = (await request.json()) as Record<string, unknown>
    if (body['client_id'] !== API_KEY || body['client_secret'] !== API_SECRET) {
      return json(400, { error: 'invalid_client' })
    }
    let grant: Grant
    let presented: unknown
    if (body['grant_type'] === 'refresh_token') {
      grant = 'refresh'
      presented = body['refresh_token']
    } else if (
      body['grant_type'] === TOKEN_EXCHANGE &&
      body['subject_token_type'] === OFFLINE_ACCESS_TOKEN &&
      body['requested_token_type'] === OFFLINE_ACCESS_TOKEN &&
      body['expiring'] === '1'
    ) {
      grant = 'migrate'
      presented = body['subject_token']
    } else {
      return json(400, { error: 'unsupported_grant_type' })
    }
    if (typeof presented !== 'string') return json(400, { error: 'invalid_request' })

    const call: Call = { shop, grant, presented, status: 0 }
    this.calls.push(call)
    const scripted = this.scripts.get(shop)?.shift()
    let response: Response
    if (scripted && !scripted.processed) {
      response = toResponse(scripted)
    } else {
      const processed = grant === 'refresh' ? this.refresh(shop, presented) : this.migrate(shop, presented)
      response = scripted ? toResponse(scripted) : processed
    }
    call.status = response.status

    const hold = this.holds.get(shop)?.shift()
    if (hold) {
      hold.reached = true
      await poll(() => hold.released, 30_000, 'the hold to be released')
    }
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    return response
  }

  private refresh(shop: string, presented: string): Response {
    const state = this.refreshTokens.get(presented)
    if (!state || state.shop !== shop || state.retired) {
      return json(401, { error: 'invalid_request', error_description: 'This request requires an active refresh_token' })
    }
    // Presenting a refresh token retires the one it replaced.
    if (state.parent) {
      const parent = this.refreshTokens.get(state.parent)
      if (parent) parent.retired = true
    }
    state.next ??= this.mint(shop, presented)
    return success(state.next)
  }

  private migrate(shop: string, presented: string): Response {
    const state = this.legacyTokens.get(presented)
    if (!state || state.shop !== shop) return json(400, { error: 'invalid_subject_token' })
    if (!state.pair) {
      this.retireAll(shop)
      state.pair = this.mint(shop)
    }
    return success(state.pair)
  }

  private mint(shop: string, parent?: string): Pair {
    const n = ++this.counter
    const pair: Pair = {
      accessToken: `shpat_${n}_${random()}`,
      refreshToken: `shprt_${n}_${random()}`,
      scope: this.scope,
      expiresIn: ACCESS_TOKEN_LIFETIME_S,
      refreshTokenExpiresIn: REFRESH_TOKEN_LIFETIME_S,
    }
    this.refreshTokens.set(pair.refreshToken, { shop, retired: false, parent })
    this.minted.set(shop, [...(this.minted.get(shop) ?? []), pair])
    return pair
  }

  private retireAll(shop: string): void {
    for (const state of this.refreshTokens.values()) if (state.shop === shop) state.retired = true
  }
}

function success(pair: Pair): Response {
  return json(200, {
    access_token: pair.accessToken,
    scope: pair.scope,
    expires_in: pair.expiresIn,
    refresh_token: pair.refreshToken,
    refresh_token_expires_in: pair.refreshTokenExpiresIn,
  })
}

function toResponse(scripted: Scripted): Response {
  const body = scripted.text ?? (scripted.json === undefined ? '' : JSON.stringify(scripted.json))
  const headers = { 'content-type': scripted.text ? 'text/html' : 'application/json', ...scripted.headers }
  return new Response(body, { status: scripted.status, headers })
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': `req-${random()}` },
  })
}

async function poll(done: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function random(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

declare global {
  var __fakeShopify: FakeShopify | undefined
  var __testClockOffsetMs: number | undefined
}

export function fakeShopify(): FakeShopify {
  return (globalThis.__fakeShopify ??= new FakeShopify())
}

/** The objects' clock: real time plus an offset the tests move forward. */
export const clock = {
  now: (): number => Date.now() + (globalThis.__testClockOffsetMs ?? 0),
  advance(ms: number): void {
    globalThis.__testClockOffsetMs = (globalThis.__testClockOffsetMs ?? 0) + ms
  },
  reset(): void {
    globalThis.__testClockOffsetMs = 0
  },
}
