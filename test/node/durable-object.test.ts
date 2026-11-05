// The Durable Object shell under Node, with `cloudflare:workers` aliased to a stand-in (vitest.config.ts) and a fake
// ctx. The real runtime is covered by test/workers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createShopSessionsDurableObject } from '../../src/durable-object.js'
import type { ShopSessionsDurableObjectOptions } from '../../src/durable-object.js'
import { ShopSessionError } from '../../src/types.js'
import type { ShopRecord } from '../../src/types.js'
import { FakeKV } from './core/fakes.js'

const SHOP = 'shell.myshopify.com'
const MINUTE = 60_000

type Env = {
  SHOPIFY_API_KEY?: string
  SHOPIFY_API_SECRET?: string
  SHOPIFY_SESSION_ENCRYPTION_KEYS?: string
  REGISTRY: FakeKV
  LEGACY?: FakeKV
}

function randomKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
}

const KEYS = randomKey()

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SHOPIFY_API_KEY: 'api-key',
    SHOPIFY_API_SECRET: 'api-secret',
    SHOPIFY_SESSION_ENCRYPTION_KEYS: KEYS,
    REGISTRY: new FakeKV(),
    ...overrides,
  }
}

function fakeCtx(name: string | undefined = SHOP) {
  const data = new Map<string, unknown>()
  let alarm: number | null = null
  const order: string[] = []
  const storage = {
    get: vi.fn(async (key: string) => structuredClone(data.get(key))),
    put: vi.fn(async (key: string, value: unknown) => {
      data.set(key, structuredClone(value))
    }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    deleteAll: vi.fn(async () => {
      order.push('deleteAll')
      data.clear()
    }),
    getAlarm: vi.fn(async () => alarm),
    setAlarm: vi.fn(async (at: number) => {
      alarm = at
    }),
    deleteAlarm: vi.fn(async () => {
      order.push('deleteAlarm')
      alarm = null
    }),
  }
  const waitUntil = vi.fn()
  const ctx = { id: { name, toString: () => 'id', equals: () => false }, storage, waitUntil }
  return { ctx: ctx as unknown as DurableObjectState, data, storage, order, waitUntil, alarm: () => alarm }
}

const NOW = Date.UTC(2026, 9, 1)

function tokenResponse(n: number): Response {
  return Response.json({
    access_token: `shpat_new_${n}`,
    refresh_token: `shprt_new_${n}`,
    expires_in: 3600,
    refresh_token_expires_in: 7_776_000,
    scope: 'read_products',
  })
}

function setup(options: Partial<ShopSessionsDurableObjectOptions<Env>> = {}, env = makeEnv(), name?: string | null) {
  const report = vi.fn()
  let calls = 0
  const fetch = vi.fn(async () => tokenResponse(++calls))
  const Class = createShopSessionsDurableObject<Env>({
    registry: (e) => ({ kv: e.REGISTRY }),
    report,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => NOW,
    ...options,
  })
  const fake = fakeCtx(name === null ? undefined : (name ?? SHOP))
  const object = new Class(fake.ctx, env)
  return { object, env, report, fetch, ...fake }
}

function exchange(expires = NOW + 3_600_000) {
  return {
    shop: SHOP,
    session: {
      shop: SHOP,
      accessToken: 'shpat_exchanged',
      refreshToken: 'shprt_exchanged',
      expires,
      refreshTokenExpires: NOW + 90 * 86_400_000,
      scope: 'read_products',
    },
  }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createShopSessionsDurableObject', () => {
  it('requires a registry', () => {
    expect(() => createShopSessionsDurableObject({} as ShopSessionsDurableObjectOptions<Env>)).toThrow(
      /options\.registry\(env\) is required/,
    )
  })

  it('does no I/O in the constructor', () => {
    const { storage, waitUntil } = setup()
    for (const fn of Object.values(storage)) expect(fn).not.toHaveBeenCalled()
    expect(waitUntil).not.toHaveBeenCalled()
  })

  it('serves the shop it is named after through one core', async () => {
    const { object, fetch } = setup()
    expect(await object.putSession(exchange(NOW + 2 * MINUTE))).toEqual({ status: 'stored' })
    // Two concurrent loads share the core's single flight: one refresh.
    const [a, b] = await Promise.all([
      object.getSession({ shop: SHOP, caller: 'library' }),
      object.getSession({ shop: SHOP, caller: 'library' }),
    ])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(a).toMatchObject({ status: 'ok', session: { accessToken: 'shpat_new_1' } })
    expect(b).toEqual(a)
    expect(await object.describe({ shop: SHOP })).toMatchObject({ exists: true, source: 'refresh' })
  })
})

describe('shop checks', () => {
  it.each([
    ['uppercase', SHOP.toUpperCase()],
    ['padded', ` ${SHOP}`],
    ['trailing slash', `${SHOP}/`],
    ['not a shop', 'example.com'],
    ['not a string', 42],
  ])('rejects a %s shop', async (_label, shop) => {
    const { object } = setup()
    await expect(object.describe({ shop } as { shop: string })).rejects.toThrow(/canonical shop domain/)
  })

  it('rejects a missing input', async () => {
    const { object } = setup()
    await expect(object.describe(undefined as unknown as { shop: string })).rejects.toThrow(/canonical shop domain/)
  })

  it('rejects a shop other than ctx.id.name', async () => {
    const { object, storage } = setup()
    await expect(object.describe({ shop: 'other.myshopify.com' })).rejects.toThrow(/does not match this object/)
    expect(storage.get).not.toHaveBeenCalled()
  })

  it('binds to the first shop when the runtime gives no name', async () => {
    const { object } = setup({}, makeEnv(), null)
    expect(await object.describe({ shop: SHOP })).toMatchObject({ exists: false })
    await expect(object.describe({ shop: 'other.myshopify.com' })).rejects.toThrow(/does not match this object/)
  })

  it('refuses a stored record that belongs to another shop', async () => {
    const { object, data, report } = setup()
    data.set('record', { v: 1, shop: 'other.myshopify.com', pairObtainedAt: NOW } satisfies ShopRecord)
    await expect(object.describe({ shop: SHOP })).rejects.toThrow(/belongs to another shop/)
    expect(report.mock.calls[0]?.[1]).toMatchObject({ op: 'config', code: 'shop_mismatch' })
  })

  it('accepts myshopify.io shops only when allowed', async () => {
    const io = 'dev.myshopify.io'
    await expect(setup({}, makeEnv(), io).object.describe({ shop: io })).rejects.toThrow(/canonical/)
    expect(await setup({ allowMyshopifyIo: true }, makeEnv(), io).object.describe({ shop: io })).toMatchObject({
      shop: io,
      exists: false,
    })
  })
})

describe('configuration', () => {
  const calls = (object: ReturnType<typeof setup>['object']) => [
    () => object.getSession({ shop: SHOP, caller: 'library' }),
    () => object.putSession(exchange()),
    () => object.reportUnauthorized({ shop: SHOP, tokenFp: 'fp' }),
    () => object.destroy({ shop: SHOP }),
    () => object.importLegacy({ shop: SHOP }),
    () => object.describe({ shop: SHOP }),
  ]

  it.each([
    ['SHOPIFY_API_KEY', { SHOPIFY_API_KEY: undefined }, /SHOPIFY_API_KEY\) is missing or empty/, 'missing_api_key'],
    [
      'SHOPIFY_API_SECRET',
      { SHOPIFY_API_SECRET: '  ' },
      /SHOPIFY_API_SECRET\) is missing or empty/,
      'missing_api_secret',
    ],
    [
      'SHOPIFY_SESSION_ENCRYPTION_KEYS',
      { SHOPIFY_SESSION_ENCRYPTION_KEYS: undefined },
      /SHOPIFY_SESSION_ENCRYPTION_KEYS is not set/,
      'keyring',
    ],
  ])('fails closed on every call without %s and reports it once', async (_name, overrides, message, code) => {
    const { object, report, storage } = setup({}, makeEnv(overrides))
    for (const call of calls(object)) await expect(call()).rejects.toThrow(message)
    expect(report).toHaveBeenCalledTimes(1)
    const [error, context] = report.mock.calls[0] ?? []
    expect(error).toBeInstanceOf(ShopSessionError)
    expect(context).toEqual({ shop: SHOP, op: 'config', kind: 'configuration', code })
    expect(storage.put).not.toHaveBeenCalled()
  })

  it('never echoes a malformed key', async () => {
    const short = btoa('sixteen byte key')
    const { object } = setup({}, makeEnv({ SHOPIFY_SESSION_ENCRYPTION_KEYS: `${KEYS},${short}` }))
    const error = await object.describe({ shop: SHOP }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(ShopSessionError)
    const { message } = error as ShopSessionError
    expect(message).toMatch(/entry 2 is 16 bytes, not 32/)
    expect(message).not.toContain(short)
    expect(message).not.toContain(KEYS)
  })

  it('fails closed when the registry has no KV namespace', async () => {
    const { object } = setup({ registry: () => ({ kv: undefined as unknown as FakeKV }) })
    await expect(object.describe({ shop: SHOP })).rejects.toThrow(/registry\(env\) returned no KV namespace/)
  })

  it('reads credentials and keys through the option functions when given', async () => {
    const env = makeEnv({ SHOPIFY_API_KEY: undefined, SHOPIFY_API_SECRET: undefined })
    const { object, fetch } = setup(
      { apiKey: () => 'custom-key', apiSecretKey: () => 'custom-secret', encryptionKeys: () => KEYS },
      { ...env, SHOPIFY_SESSION_ENCRYPTION_KEYS: 'not a keyring' },
    )
    await object.putSession(exchange(NOW + 2 * MINUTE))
    await object.getSession({ shop: SHOP, caller: 'library' })
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as unknown
    expect(body).toMatchObject({ client_id: 'custom-key', client_secret: 'custom-secret' })
  })
})

describe('storage bindings', () => {
  it('deletes all storage and then the alarm on destroy', async () => {
    const { object, order, data, alarm } = setup()
    await object.putSession(exchange())
    expect(alarm()).not.toBeNull()
    expect(await object.destroy({ shop: SHOP })).toEqual({ status: 'deleted' })
    expect(order.slice(0, 2)).toEqual(['deleteAll', 'deleteAlarm'])
    expect(data.size).toBe(0)
    expect(alarm()).toBeNull()
  })

  it('stores the record under one key and writes the registry marker', async () => {
    const { object, data, env } = setup()
    await object.putSession(exchange())
    expect([...data.keys()]).toEqual(['record'])
    expect(env.REGISTRY.data.get(`shop-session:${SHOP}`)).toEqual({ value: '', metadata: { since: NOW } })
  })

  it('uses a custom registry prefix', async () => {
    const { object, env } = setup({ registry: (e) => ({ kv: e.REGISTRY, prefix: 'shops/' }) })
    await object.putSession(exchange())
    expect([...env.REGISTRY.data.keys()]).toEqual([`shops/${SHOP}`])
  })

  it('runs background refreshes under ctx.waitUntil', async () => {
    const { object, waitUntil } = setup()
    await object.putSession(exchange(NOW + 10 * MINUTE))
    expect(await object.getSession({ shop: SHOP, caller: 'library' })).toMatchObject({
      session: { accessToken: 'shpat_exchanged' },
    })
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await waitUntil.mock.calls[0]?.[0]
  })

  it('reads legacyKv on every use', async () => {
    const legacy = new FakeKV()
    const legacyKv = vi.fn((_env: Env) => legacy as FakeKV | undefined)
    const { object } = setup({ legacyKv })
    expect(await object.getSession({ shop: SHOP, caller: 'library' })).toEqual({ status: 'none' })
    const reads = legacyKv.mock.calls.length
    expect(reads).toBeGreaterThan(0)
    expect(legacy.ops.some((op) => op.op === 'get')).toBe(true)

    legacyKv.mockReturnValue(undefined)
    legacy.ops.length = 0
    expect(await object.getSession({ shop: SHOP, caller: 'library' })).toEqual({ status: 'none' })
    expect(legacyKv.mock.calls.length).toBeGreaterThan(reads)
    expect(legacy.ops).toEqual([])
  })
})

describe('alarm', () => {
  it('does nothing without a record', async () => {
    const { object, storage, report } = setup({}, makeEnv({ SHOPIFY_API_KEY: undefined }))
    await object.alarm()
    expect(storage.setAlarm).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })

  it('re-arms instead of throwing when the configuration is broken, reporting at most hourly', async () => {
    let now = NOW
    const env = makeEnv({ SHOPIFY_SESSION_ENCRYPTION_KEYS: '' })
    const { object, data, storage, report } = setup({ now: () => now }, env)
    data.set('record', { v: 1, shop: SHOP, pairObtainedAt: NOW } satisfies ShopRecord)

    await object.alarm()
    now += 30 * MINUTE
    await object.alarm()
    expect(storage.setAlarm.mock.calls.map(([at]) => at)).toEqual([NOW + MINUTE, now + 5 * MINUTE])
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0]?.[1]).toMatchObject({ op: 'config', code: 'keyring' })

    now += 31 * MINUTE
    await object.alarm()
    expect(report).toHaveBeenCalledTimes(2)
    expect(report.mock.calls[1]?.[1]).toMatchObject({ op: 'config', code: 'keyring' })
  })

  it('keeps the configuration-error backoff and report throttle across instances, and clears them on success', async () => {
    let now = NOW
    const env = makeEnv({ SHOPIFY_SESSION_ENCRYPTION_KEYS: '' })
    const report = vi.fn()
    const Class = createShopSessionsDurableObject<Env>({
      registry: (e) => ({ kv: e.REGISTRY }),
      report,
      now: () => now,
    })
    const fake = fakeCtx()
    fake.data.set('record', { v: 1, shop: SHOP, pairObtainedAt: NOW } satisfies ShopRecord)
    const delays: number[] = []
    for (const gap of [0, 1, 5, 30, 120, 360]) {
      now += gap * MINUTE
      // A fresh instance every time, as after an eviction between alarms; storage survives.
      await new Class(fake.ctx, env).alarm()
      delays.push((fake.alarm() ?? 0) - now)
    }
    expect(delays).toEqual([1, 5, 30, 120, 360, 360].map((minutes) => minutes * MINUTE))
    // At the first failure, then at the first failure an hour or more after the last report.
    expect(report.mock.calls.map(([, context]) => (context as { count?: number; code: string }).code)).toEqual([
      'keyring',
      'keyring',
      'keyring',
    ])
    expect(fake.data.get('alarm-error')).toEqual({ count: 6, reportedAt: now })

    now += 360 * MINUTE
    await new Class(fake.ctx, makeEnv()).alarm()
    expect(fake.data.has('alarm-error')).toBe(false)
    expect(report).toHaveBeenCalledTimes(3)
  })

  it('reports a configuration error once when an RPC and an alarm hit one instance seconds apart', async () => {
    let now = NOW
    for (const order of [
      ['rpc', 'alarm'],
      ['alarm', 'rpc'],
    ] as const) {
      const env = makeEnv({ SHOPIFY_SESSION_ENCRYPTION_KEYS: 'bm90IGEga2V5' })
      const { object, data, report } = setup({ now: () => now }, env)
      data.set('record', { v: 1, shop: SHOP, pairObtainedAt: NOW } satisfies ShopRecord)
      for (const step of order) {
        if (step === 'rpc')
          await expect(object.getSession({ shop: SHOP, caller: 'library' })).rejects.toThrow(/entry 1/)
        else await object.alarm()
        now += 5_000
      }
      expect(report.mock.calls.map(([, context]) => (context as { code: string }).code)).toEqual(['keyring'])
    }
  })

  it('migrates a legacy token when migrateLegacy says so', async () => {
    const migrateLegacy = vi.fn(() => false)
    const { object, data, fetch } = setup({ migrateLegacy, legacyCutoff: NOW + 86_400_000 })
    await object.putSession({ shop: SHOP, session: { shop: SHOP, accessToken: 'shpat_legacy' } })
    expect((data.get('record') as ShopRecord).source).toBe('legacy_exchange')

    const later = setup({ migrateLegacy, now: () => NOW + 10 * MINUTE })
    later.data.set('record', data.get('record'))
    await later.object.alarm()
    expect(later.fetch).not.toHaveBeenCalled()

    migrateLegacy.mockReturnValue(true)
    await later.object.alarm()
    expect(later.fetch).toHaveBeenCalledTimes(1)
    expect((later.data.get('record') as ShopRecord).source).toBe('migrate')
    expect(fetch).not.toHaveBeenCalled()
  })
})
