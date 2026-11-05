import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach } from 'vitest'

import type { ShopSessionsDurableObject } from '../../src/durable-object.js'
import type { SessionParams } from '../../src/types.js'
import type { Env } from './entry.js'
import { clock, fakeShopify } from './fake-shopify.js'
import type { Pair } from './fake-shopify.js'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export const fake = fakeShopify()
export { clock }

/** Resets the fake Shopify and the clock before every test of the importing file. */
export function useFreshFake(): void {
  beforeEach(() => {
    fake.reset()
    clock.reset()
  })
}

let counter = 0

/** A shop no other test (or project run sharing storage) uses. */
export function newShop(label: string): string {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')
  return `${label}-${++counter}-${suffix}.myshopify.com`
}

type Namespace = Env['SHOP_SESSIONS']

export function stubFor(shop: string, namespace: Namespace = env.SHOP_SESSIONS) {
  return namespace.get(namespace.idFromName(shop))
}

export type Stub = ReturnType<typeof stubFor>

/** What `authenticate.admin` stores after a token exchange that returned `pair`. */
export function exchangeSession(shop: string, pair: Pair, expiresInMs = pair.expiresIn * 1000): SessionParams {
  const now = clock.now()
  return {
    shop,
    isOnline: false,
    scope: pair.scope,
    accessToken: pair.accessToken,
    expires: now + expiresInMs,
    refreshToken: pair.refreshToken,
    refreshTokenExpires: now + pair.refreshTokenExpiresIn * 1000,
  }
}

/** Exchanges a pair with the fake and stores it, as the library would. */
export async function installShop(shop: string, expiresInMs?: number): Promise<{ stub: Stub; pair: Pair }> {
  const stub = stubFor(shop)
  const pair = fake.exchange(shop)
  const result = await stub.putSession({ shop, session: exchangeSession(shop, pair, expiresInMs) })
  if (result.status !== 'stored') throw new Error(`putSession answered ${result.status}`)
  return { stub, pair }
}

/** The object's raw storage and alarm. */
export function inspect(stub: Stub): Promise<{ keys: string[]; alarm: number | null }> {
  return runInDurableObject(stub, async (_instance: ShopSessionsDurableObject, state) => ({
    keys: [...(await state.storage.list()).keys()],
    alarm: await state.storage.getAlarm(),
  }))
}

type Internals = { shell: { pending?: { core: Promise<{ inflight?: Promise<unknown> }> } } }

/** Waits for the object's in-flight token call, if any, to be applied. Reaches into the core: tests only. */
export function settle(stub: Stub): Promise<void> {
  return runInDurableObject(stub, async (instance: ShopSessionsDurableObject) => {
    const core = await (instance as unknown as Internals).shell.pending?.core.catch(() => undefined)
    await core?.inflight?.catch(() => undefined)
  })
}

export async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A KVSessionStorage value (`Session.toPropertyArray(true)`) for an offline session. */
export function legacyValue(shop: string, fields: Record<string, string | number | boolean>): string {
  return JSON.stringify([
    ['id', `offline_${shop}`],
    ['shop', shop],
    ['state', ''],
    ['isOnline', false],
    ...Object.entries(fields),
  ])
}

export async function putLegacy(shop: string, fields: Record<string, string | number | boolean>): Promise<void> {
  await env.LEGACY.put(`offline_${shop}`, legacyValue(shop, fields))
  await env.LEGACY.put(`shop:${shop}`, JSON.stringify([`offline_${shop}`]))
}

export async function legacyKeys(shop: string): Promise<string[]> {
  const keys = []
  for (const key of [`offline_${shop}`, `shop:${shop}`]) if ((await env.LEGACY.get(key)) !== null) keys.push(key)
  return keys
}

export function marker(shop: string) {
  return env.REGISTRY.getWithMetadata<{ since: number }>(`shop-session:${shop}`)
}
