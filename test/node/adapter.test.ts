import { Session } from '@shopify/shopify-api'
import { describe, expect, it } from 'vitest'

import { DurableObjectSessionStorage } from '../../src/adapter.js'
import { DEFAULT_LOCATION_HINT, ISSUED } from '../../src/types.js'
import type { GetSessionInput, GetSessionResult, ShopSessionStatus, ShopSessionsRpc } from '../../src/types.js'
import { SHOP as CORE_SHOP, createHarness } from './core/fakes.js'

const SHOP = 'cool-shop.myshopify.com'
const ID = `offline_${SHOP}`
const HOUR = 60 * 60 * 1000
const EXPIRES = Date.UTC(2026, 9, 22, 12)

type Method = keyof ShopSessionsRpc
type Handlers = { [M in Method]?: (input: Parameters<ShopSessionsRpc[M]>[0], stub: number) => unknown }
type Call = { stub: number; shop: string; method: Method; input: Record<string, unknown> }

const METHODS: Method[] = [
  'getSession',
  'putSession',
  'reportUnauthorized',
  'destroy',
  'importLegacy',
  'rollover',
  'describe',
]

function fakeNamespace(handlers: Handlers = {}) {
  const calls: Call[] = []
  const gets: { name: string; options: unknown }[] = []
  let stubs = 0
  const namespace = {
    idFromName(name: string) {
      return { name }
    },
    get(id: never, options?: { locationHint?: string }) {
      const { name } = id as { name: string }
      gets.push({ name, options })
      const stub = ++stubs
      return Object.fromEntries(
        METHODS.map((method) => [
          method,
          async (input: Record<string, unknown>) => {
            calls.push({ stub, shop: name, method, input: structuredClone(input) })
            const handler = handlers[method] as ((input: unknown, stub: number) => unknown) | undefined
            if (!handler) throw new Error(`unexpected ${method}`)
            return handler(input, stub)
          },
        ]),
      )
    },
  }
  return { namespace, calls, gets }
}

function storageFor(handlers: Handlers = {}, options: { locationHint?: string; allowMyshopifyIo?: boolean } = {}) {
  const fake = fakeNamespace(handlers)
  return { ...fake, storage: new DurableObjectSessionStorage({ namespace: fake.namespace, ...options }) }
}

const ok = (overrides: Partial<{ scope: string; expires: number }> = {}, tokenFp = 'fp-1'): GetSessionResult => ({
  status: 'ok',
  session: { shop: SHOP, scope: 'read_products', accessToken: 'shpat_access', expires: EXPIRES, ...overrides },
  tokenFp,
})

function infraError(flags: { retryable?: boolean; overloaded?: boolean }) {
  return Object.assign(new Error('Durable Object reset because its code was updated'), flags)
}

function tagOf(session: object) {
  return Object.getOwnPropertyDescriptor(session, ISSUED)
}

describe('constructor', () => {
  it('does no I/O', () => {
    let touched = 0
    const namespace = {
      idFromName: () => touched++,
      get: () => touched++,
    }
    new DurableObjectSessionStorage({ namespace })
    expect(touched).toBe(0)
  })

  it('requires a namespace', () => {
    expect(() => new DurableObjectSessionStorage({} as never)).toThrow(/namespace/)
  })

  it('places objects with the default location hint, or the given one', async () => {
    const a = storageFor({ getSession: () => ({ status: 'none' }) })
    await a.storage.loadSession(ID)
    expect(a.gets).toEqual([{ name: SHOP, options: { locationHint: DEFAULT_LOCATION_HINT } }])

    const b = storageFor({ getSession: () => ({ status: 'none' }) }, { locationHint: 'weur' })
    await b.storage.loadSession(ID)
    expect(b.gets).toEqual([{ name: SHOP, options: { locationHint: 'weur' } }])
  })
})

describe('loadSession', () => {
  it('maps ok to an offline Session with the access token and expiry', async () => {
    const { storage, calls } = storageFor({ getSession: () => ok() })
    const session = await storage.loadSession(ID)

    expect(calls).toEqual([{ stub: 1, shop: SHOP, method: 'getSession', input: { shop: SHOP, caller: 'library' } }])
    expect(session).toBeInstanceOf(Session)
    expect(session).toMatchObject({
      id: ID,
      shop: SHOP,
      state: '',
      isOnline: false,
      scope: 'read_products',
      accessToken: 'shpat_access',
    })
    expect(session!.expires).toBeInstanceOf(Date)
    expect(session!.expires!.getTime()).toBe(EXPIRES)
    expect(session!.refreshToken).toBeUndefined()
    expect(session!.refreshTokenExpires).toBeUndefined()
    expect(session!.toPropertyArray(true).map(([key]) => key)).toEqual([
      'id',
      'shop',
      'state',
      'isOnline',
      'scope',
      'expires',
      'accessToken',
    ])
  })

  it('maps a legacy token to a Session without expires', async () => {
    const { storage } = storageFor({
      getSession: () => ({ status: 'ok', session: { shop: SHOP, accessToken: 'shpat_legacy' }, tokenFp: 'fp-l' }),
    })
    const session = await storage.loadSession(ID)
    expect(session!.accessToken).toBe('shpat_legacy')
    expect(session!.expires).toBeUndefined()
    expect(session!.scope).toBeUndefined()
    expect(session!.isActive(undefined, 5 * 60 * 1000)).toBe(true)
  })

  it.each([
    ['none', { status: 'none' }],
    ['needs_reauth', { status: 'needs_reauth', since: EXPIRES, reason: 'refresh_rejected' }],
  ] as const)('maps %s to undefined', async (_name, result) => {
    const { storage } = storageFor({ getSession: () => result })
    expect(await storage.loadSession(ID)).toBeUndefined()
  })

  it.each(['token_endpoint', 'unreadable', 'legacy_unusable', 'import_failed'] as const)(
    'maps tokenless (%s) to a Session without an access token',
    async (reason) => {
      const { storage } = storageFor({
        getSession: () => ({ status: 'tokenless', reason, scope: 'read_orders', expires: EXPIRES, retryAfterMs: 5000 }),
      })
      const session = await storage.loadSession(ID)
      expect(session).toBeInstanceOf(Session)
      expect(session).toMatchObject({ id: ID, shop: SHOP, state: '', isOnline: false, scope: 'read_orders' })
      expect(session!.accessToken).toBeUndefined()
      expect(session!.expires!.getTime()).toBe(EXPIRES)
      expect(session!.isActive(undefined)).toBe(false)
      expect(tagOf(session!)?.value).toEqual({ tokenFp: '' })
    },
  )

  it('omits expires on a tokenless session when the object gives none', async () => {
    const { storage } = storageFor({ getSession: () => ({ status: 'tokenless', reason: 'unreadable' }) })
    const session = await storage.loadSession(ID)
    expect(session!.expires).toBeUndefined()
    expect(session!.scope).toBeUndefined()
    expect(session!.accessToken).toBeUndefined()
  })

  it('tags the session non-enumerably with the token fingerprint', async () => {
    const { storage } = storageFor({ getSession: () => ok({}, 'fp-xyz') })
    const session = (await storage.loadSession(ID))!
    const descriptor = tagOf(session)
    expect(descriptor).toMatchObject({ value: { tokenFp: 'fp-xyz' }, enumerable: false })
    expect(Object.keys(session)).not.toContain(String(ISSUED))
    expect(session.toPropertyArray(true).flat()).not.toContain('fp-xyz')
    expect(JSON.stringify(session)).not.toContain('fp-xyz')
    expect(JSON.stringify(session.toObject())).not.toContain('fp-xyz')
    expect(Object.getOwnPropertySymbols({ ...session })).toEqual([])
    // The tag doesn't affect Session equality.
    expect(session.equals(new Session(session.toObject()))).toBe(true)
  })

  it.each([
    'cool-shop_12345',
    'offline_',
    'offline_evil.com',
    'offline_cool-shop.myshopify.com.evil.com',
    'offline_cool-shop.myshopify.io',
    'online_cool-shop.myshopify.com',
    '',
  ])('answers undefined for %j without calling the namespace', async (id) => {
    const { storage, calls, gets } = storageFor()
    expect(await storage.loadSession(id)).toBeUndefined()
    expect(calls).toEqual([])
    expect(gets).toEqual([])
  })

  it('routes non-canonical ids to the canonical shop', async () => {
    const { storage, calls } = storageFor({ getSession: () => ok() })
    const session = await storage.loadSession('offline_Cool-Shop.myshopify.com')
    expect(calls[0]).toMatchObject({ shop: SHOP, input: { shop: SHOP } })
    expect(session!.id).toBe(ID)
  })

  it('accepts myshopify.io shops when allowed', async () => {
    const shop = 'dev-shop.myshopify.io'
    const { storage, calls } = storageFor(
      { getSession: () => ({ status: 'ok', session: { shop, accessToken: 'a' }, tokenFp: 'f' }) },
      { allowMyshopifyIo: true },
    )
    const session = await storage.loadSession(`offline_${shop}`)
    expect(calls[0]).toMatchObject({ shop, input: { shop } })
    expect(session).toMatchObject({ id: `offline_${shop}`, shop })
  })

  it('throws on a status it does not know', async () => {
    const { storage } = storageFor({ getSession: () => ({ status: 'mystery' }) })
    await expect(storage.loadSession(ID)).rejects.toThrow(/unexpected getSession status mystery/)
  })
})

describe('a failed lazy import, through the real core', () => {
  it('gives the library a session without a token and the app unavailable(import_failed)', async () => {
    const h = createHarness({ legacy: true })
    const core = h.core
    const namespace = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        getSession: async (input: GetSessionInput) => structuredClone(await core.getSession(structuredClone(input))),
      }),
    }
    const storage = new DurableObjectSessionStorage({ namespace })
    const id = `offline_${CORE_SHOP}`

    h.legacyKv!.failNext = { op: 'get', error: new Error('KV GET failed: 503') }
    const session = await storage.loadSession(id)
    expect(session).toBeInstanceOf(Session)
    expect(session?.accessToken).toBeUndefined()
    expect(tagOf(session!)?.value).toEqual({ tokenFp: '' })

    h.legacyKv!.failNext = { op: 'get', error: new Error('KV GET failed: 503') }
    expect(await storage.loadOfflineSession(CORE_SHOP)).toEqual({ status: 'unavailable', reason: 'import_failed' })

    // The explicit RPC, which the backfill counts, still throws.
    h.legacyKv!.failNext = { op: 'get', error: new Error('KV GET failed: 503') }
    await expect(core.importLegacy({ shop: CORE_SHOP })).rejects.toThrow('KV GET failed')
  })
})

describe('RPC retries', () => {
  it('retries a retryable error once with a fresh stub', async () => {
    let attempts = 0
    const { storage, calls, gets } = storageFor({
      getSession: () => {
        if (attempts++ === 0) throw infraError({ retryable: true })
        return ok()
      },
    })
    const session = await storage.loadSession(ID)
    expect(session!.accessToken).toBe('shpat_access')
    expect(gets).toHaveLength(2)
    expect(calls.map((call) => call.stub)).toEqual([1, 2])
  })

  it('gives up after the second retryable error', async () => {
    let attempts = 0
    const { storage, gets } = storageFor({
      getSession: () => {
        throw infraError({ retryable: true, ...(attempts++ > 0 && { overloaded: false }) })
      },
    })
    await expect(storage.loadSession(ID)).rejects.toThrow(/reset/)
    expect(gets).toHaveLength(2)
  })

  it.each([
    ['overloaded', { retryable: true, overloaded: true }],
    ['not retryable', { retryable: false }],
    ['a plain error', {}],
  ])('does not retry %s', async (_name, flags) => {
    const { storage, gets } = storageFor({
      getSession: () => {
        throw infraError(flags)
      },
    })
    await expect(storage.loadSession(ID)).rejects.toThrow(/reset/)
    expect(gets).toHaveLength(1)
  })

  it('retries other methods the same way', async () => {
    let attempts = 0
    const { storage, calls } = storageFor({
      destroy: () => {
        if (attempts++ === 0) throw infraError({ retryable: true })
        return { status: 'deleted' }
      },
    })
    expect(await storage.deleteShop(SHOP)).toEqual({ status: 'deleted' })
    expect(calls.map((call) => [call.method, call.stub])).toEqual([
      ['destroy', 1],
      ['destroy', 2],
    ])
  })
})

describe('storeSession', () => {
  const fresh = (overrides: Record<string, unknown> = {}) =>
    new Session({
      id: ID,
      shop: SHOP,
      state: 'state-x',
      isOnline: false,
      scope: 'read_products,write_products',
      accessToken: 'shpat_new',
      expires: new Date(EXPIRES),
      refreshToken: 'shprt_new',
      refreshTokenExpires: new Date(EXPIRES + 90 * 24 * HOUR),
      ...overrides,
    })

  it('sends a plain copy of a library session without an issued tag', async () => {
    const { storage, calls } = storageFor({ putSession: () => ({ status: 'stored' }) })
    expect(await storage.storeSession(fresh())).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ shop: SHOP, method: 'putSession' })
    expect(calls[0]!.input).toEqual({
      shop: SHOP,
      session: {
        shop: SHOP,
        isOnline: false,
        scope: 'read_products,write_products',
        accessToken: 'shpat_new',
        expires: EXPIRES,
        refreshToken: 'shprt_new',
        refreshTokenExpires: EXPIRES + 90 * 24 * HOUR,
      },
    })
    expect(calls[0]!.input).not.toHaveProperty('issued')
  })

  it('omits fields the session lacks', async () => {
    const { storage, calls } = storageFor({ putSession: () => ({ status: 'stored' }) })
    await storage.storeSession(new Session({ id: ID, shop: SHOP, state: '', isOnline: false, accessToken: 'shpat_l' }))
    expect(calls[0]!.input).toEqual({ shop: SHOP, session: { shop: SHOP, isOnline: false, accessToken: 'shpat_l' } })
  })

  it('strips the refresh token from the caller’s session after storing', async () => {
    const { storage } = storageFor({ putSession: () => ({ status: 'stored' }) })
    const session = fresh()
    await storage.storeSession(session)
    expect(session.refreshToken).toBeUndefined()
    expect(session.refreshTokenExpires).toBeUndefined()
    expect(session.toPropertyArray(true).map(([key]) => key)).not.toContain('refreshToken')
    expect(session.accessToken).toBe('shpat_new')
  })

  it('strips the refresh token even when the RPC throws', async () => {
    const { storage } = storageFor({
      putSession: () => {
        throw new Error('boom')
      },
    })
    const session = fresh()
    await expect(storage.storeSession(session)).rejects.toThrow('boom')
    expect(session.refreshToken).toBeUndefined()
    expect(session.refreshTokenExpires).toBeUndefined()
  })

  it('sends the issued tag for a session it handed out (app write-back)', async () => {
    const { storage, calls } = storageFor({
      getSession: () => ok({}, 'fp-issued'),
      putSession: () => ({ status: 'merged' }),
    })
    const session = (await storage.loadSession(ID))!
    session.scope = 'read_products,write_orders'
    await storage.storeSession(session)
    expect(calls[1]!.input).toEqual({
      shop: SHOP,
      session: {
        shop: SHOP,
        isOnline: false,
        scope: 'read_products,write_orders',
        accessToken: 'shpat_access',
        expires: EXPIRES,
      },
      issued: { tokenFp: 'fp-issued' },
    })
  })

  it('sends the issued tag when invalidateAccessToken writes the session back without its token', async () => {
    const { storage, calls } = storageFor({
      getSession: () => ok({}, 'fp-issued'),
      putSession: () => ({ status: 'stored' }),
    })
    const session = (await storage.loadSession(ID))!
    session.accessToken = undefined
    await storage.storeSession(session)
    expect(calls[1]!.input).toEqual({
      shop: SHOP,
      session: { shop: SHOP, isOnline: false, scope: 'read_products', expires: EXPIRES },
      issued: { tokenFp: 'fp-issued' },
    })
  })

  it('sends the empty tag for a tokenless session written back', async () => {
    const { storage, calls } = storageFor({
      getSession: () => ({ status: 'tokenless', reason: 'token_endpoint' }),
      putSession: () => ({ status: 'ignored_stale' }),
    })
    const session = (await storage.loadSession(ID))!
    await storage.storeSession(session)
    expect(calls[1]!.input).toMatchObject({ issued: { tokenFp: '' } })
  })

  it('treats a copy of an issued session as a new library session (the tag does not survive copying)', async () => {
    const { storage, calls } = storageFor({ getSession: () => ok(), putSession: () => ({ status: 'stored' }) })
    const session = (await storage.loadSession(ID))!
    await storage.storeSession(new Session({ ...session }))
    expect(calls[1]!.input).not.toHaveProperty('issued')
  })

  it('canonicalises the shop', async () => {
    const { storage, calls } = storageFor({ putSession: () => ({ status: 'stored' }) })
    await storage.storeSession(fresh({ id: 'offline_Cool-Shop.myshopify.com', shop: 'Cool-Shop.myshopify.com' }))
    expect(calls[0]).toMatchObject({ shop: SHOP, input: { shop: SHOP, session: { shop: SHOP } } })
  })

  it('rejects online sessions without calling the namespace', async () => {
    const { storage, calls } = storageFor()
    const online = new Session({ id: `${SHOP}_42`, shop: SHOP, state: '', isOnline: true, accessToken: 'a' })
    await expect(storage.storeSession(online)).rejects.toThrow(/online sessions are not supported/)
    expect(calls).toEqual([])
  })

  it.each([
    ['an id that is not offline_<shop>', { id: `${SHOP}_42` }],
    ['an id for another shop', { id: 'offline_other-shop.myshopify.com' }],
    ['an invalid shop', { id: 'offline_evil.com', shop: 'evil.com' }],
  ])('rejects %s without calling the namespace', async (_name, overrides) => {
    const { storage, calls } = storageFor()
    const session = fresh(overrides)
    await expect(storage.storeSession(session)).rejects.toThrow(/offline session/)
    expect(calls).toEqual([])
  })
})

describe('findSessionsByShop', () => {
  it('returns the offline session when it has an access token', async () => {
    const { storage, calls } = storageFor({ getSession: () => ok() })
    const sessions = await storage.findSessionsByShop(SHOP)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id: ID, accessToken: 'shpat_access' })
    expect(calls[0]!.input).toEqual({ shop: SHOP, caller: 'library' })
  })

  it.each([
    ['none', { status: 'none' }],
    ['needs_reauth', { status: 'needs_reauth', since: 1, reason: 'no_refresh_token' }],
    ['tokenless', { status: 'tokenless', reason: 'unreadable', scope: 'read_products' }],
  ] as const)('returns [] for %s', async (_name, result) => {
    const { storage } = storageFor({ getSession: () => result })
    expect(await storage.findSessionsByShop(SHOP)).toEqual([])
  })

  it('returns [] for an invalid shop without calling the namespace', async () => {
    const { storage, calls } = storageFor()
    expect(await storage.findSessionsByShop('evil.com')).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('deleteSession / deleteSessions', () => {
  it('destroys the shop of an offline id', async () => {
    const { storage, calls } = storageFor({ destroy: () => ({ status: 'deleted' }) })
    expect(await storage.deleteSession(ID)).toBe(true)
    expect(calls).toEqual([{ stub: 1, shop: SHOP, method: 'destroy', input: { shop: SHOP } }])
  })

  it('answers true for ids it never stores, without calling the namespace', async () => {
    const { storage, calls } = storageFor()
    expect(await storage.deleteSession(`${SHOP}_42`)).toBe(true)
    expect(await storage.deleteSession('offline_evil.com')).toBe(true)
    expect(calls).toEqual([])
  })

  it('destroys each shop once', async () => {
    const other = 'other-shop.myshopify.com'
    const { storage, calls } = storageFor({ destroy: () => ({ status: 'deleted' }) })
    expect(await storage.deleteSessions([ID, `offline_${other}`, ID, `${SHOP}_42`, 'junk'])).toBe(true)
    expect(calls.map((call) => call.input)).toEqual([{ shop: SHOP }, { shop: other }])
  })

  it('propagates a failed destroy', async () => {
    const { storage } = storageFor({
      destroy: () => {
        throw new Error('down')
      },
    })
    await expect(storage.deleteSessions([ID])).rejects.toThrow('down')
  })
})

describe('loadOfflineSession', () => {
  it('maps ok to a tagged session and asks as the app', async () => {
    const { storage, calls } = storageFor({ getSession: () => ok({}, 'fp-app') })
    const result = await storage.loadOfflineSession(SHOP)
    expect(calls[0]!.input).toEqual({ shop: SHOP, caller: 'app' })
    expect(result.status).toBe('ok')
    const session = (result as { session: Session }).session
    expect(session).toBeInstanceOf(Session)
    expect(session).toMatchObject({ id: ID, shop: SHOP, accessToken: 'shpat_access', isOnline: false })
    expect(session.refreshToken).toBeUndefined()
    expect(tagOf(session)).toMatchObject({ value: { tokenFp: 'fp-app' }, enumerable: false })
  })

  it('forwards minValidityMs and canonicalises the shop', async () => {
    const { storage, calls } = storageFor({ getSession: () => ok() })
    await storage.loadOfflineSession(' Cool-Shop.myshopify.com ', { minValidityMs: 20 * 60 * 1000 })
    expect(calls[0]).toMatchObject({ shop: SHOP, input: { shop: SHOP, caller: 'app', minValidityMs: 1_200_000 } })
  })

  it('maps none', async () => {
    const { storage } = storageFor({ getSession: () => ({ status: 'none' }) })
    expect(await storage.loadOfflineSession(SHOP)).toEqual({ status: 'none' })
  })

  it('maps needs_reauth with since as a Date', async () => {
    const { storage } = storageFor({
      getSession: () => ({ status: 'needs_reauth', since: EXPIRES, reason: 'legacy_rejected' }),
    })
    expect(await storage.loadOfflineSession(SHOP)).toEqual({
      status: 'needs_reauth',
      since: new Date(EXPIRES),
      reason: 'legacy_rejected',
    })
  })

  it.each(['token_endpoint', 'unreadable', 'legacy_unusable', 'import_failed'] as const)(
    'maps tokenless (%s) to unavailable',
    async (reason) => {
      const { storage } = storageFor({
        getSession: () => ({
          status: 'tokenless',
          reason,
          scope: 'read_products',
          expires: EXPIRES,
          retryAfterMs: 7000,
        }),
      })
      expect(await storage.loadOfflineSession(SHOP)).toEqual({ status: 'unavailable', reason, retryAfterMs: 7000 })
    },
  )

  it('omits retryAfterMs when the object gives none', async () => {
    const { storage } = storageFor({ getSession: () => ({ status: 'tokenless', reason: 'unreadable' }) })
    expect(await storage.loadOfflineSession(SHOP)).toEqual({ status: 'unavailable', reason: 'unreadable' })
  })

  it('rejects an invalid shop without calling the namespace', async () => {
    const { storage, calls } = storageFor()
    await expect(storage.loadOfflineSession('evil.com')).rejects.toThrow(/valid shop/)
    await expect(storage.loadOfflineSession(`https://${SHOP}`)).rejects.toThrow(/valid shop/)
    expect(calls).toEqual([])
  })

  it('rejects a non-finite minValidityMs', async () => {
    const { storage, calls } = storageFor()
    await expect(storage.loadOfflineSession(SHOP, { minValidityMs: Number.NaN })).rejects.toThrow(/minValidityMs/)
    expect(calls).toEqual([])
  })
})

describe('reportUnauthorized', () => {
  it('reports the fingerprint of the token the session was issued with', async () => {
    const { storage, calls } = storageFor({
      getSession: () => ok({}, 'fp-401'),
      reportUnauthorized: () => ({ status: 'marked' }),
    })
    const session = (await storage.loadSession(ID))!
    await expect(storage.reportUnauthorized(session)).resolves.toBeUndefined()
    expect(calls[1]).toMatchObject({
      shop: SHOP,
      method: 'reportUnauthorized',
      input: { shop: SHOP, tokenFp: 'fp-401' },
    })
  })

  it('still works after the library cleared the access token', async () => {
    const { storage, calls } = storageFor({
      getSession: () => ok({}, 'fp-401'),
      reportUnauthorized: () => ({ status: 'ignored_stale' }),
    })
    const { session } = (await storage.loadOfflineSession(SHOP)) as { session: Session }
    session.accessToken = undefined
    await storage.reportUnauthorized(session)
    expect(calls[1]!.input).toEqual({ shop: SHOP, tokenFp: 'fp-401' })
  })

  it('rejects a session this storage did not issue', async () => {
    const { storage, calls } = storageFor()
    const session = new Session({ id: ID, shop: SHOP, state: '', isOnline: false, accessToken: 'shpat_x' })
    await expect(storage.reportUnauthorized(session)).rejects.toThrow(/loaded from this storage/)
    expect(calls).toEqual([])
  })

  it('rejects a tokenless session', async () => {
    const { storage, calls } = storageFor({ getSession: () => ({ status: 'tokenless', reason: 'unreadable' }) })
    const session = (await storage.loadSession(ID))!
    await expect(storage.reportUnauthorized(session)).rejects.toThrow(/access token/)
    expect(calls.map((call) => call.method)).toEqual(['getSession'])
  })

  it('rejects an issued session whose shop was changed to an invalid one', async () => {
    const { storage, calls } = storageFor({ getSession: () => ok() })
    const session = (await storage.loadSession(ID))!
    session.shop = 'evil.com'
    await expect(storage.reportUnauthorized(session)).rejects.toThrow(/valid shop/)
    expect(calls).toHaveLength(1)
  })
})

describe('deleteShop', () => {
  it('destroys with the uninstall time in ms', async () => {
    const { storage, calls } = storageFor({ destroy: () => ({ status: 'kept_newer_install' }) })
    const result = await storage.deleteShop(SHOP, { uninstalledAt: new Date(EXPIRES) })
    expect(result).toEqual({ status: 'kept_newer_install' })
    expect(calls).toEqual([{ stub: 1, shop: SHOP, method: 'destroy', input: { shop: SHOP, uninstalledAt: EXPIRES } }])
  })

  it('destroys unconditionally without an uninstall time', async () => {
    const { storage, calls } = storageFor({ destroy: () => ({ status: 'deleted' }) })
    expect(await storage.deleteShop(SHOP)).toEqual({ status: 'deleted' })
    expect(calls[0]!.input).toEqual({ shop: SHOP })
  })

  it('rejects an invalid shop or date without calling the namespace', async () => {
    const { storage, calls } = storageFor()
    await expect(storage.deleteShop('nope')).rejects.toThrow(/valid shop/)
    await expect(storage.deleteShop(SHOP, { uninstalledAt: new Date('garbage') })).rejects.toThrow(/uninstalledAt/)
    expect(calls).toEqual([])
  })
})

describe('describe', () => {
  it('passes the object’s status through', async () => {
    const status: ShopSessionStatus = { shop: SHOP, exists: true, state: 'ok', source: 'refresh', nextAlarmAt: null }
    const { storage, calls } = storageFor({ describe: () => status })
    expect(await storage.describe('COOL-SHOP.myshopify.com')).toEqual(status)
    expect(calls[0]).toMatchObject({ shop: SHOP, method: 'describe', input: { shop: SHOP } })
  })

  it('rejects an invalid shop without calling the namespace', async () => {
    const { storage, calls } = storageFor()
    await expect(storage.describe('')).rejects.toThrow(/valid shop/)
    expect(calls).toEqual([])
  })
})

describe('rollover', () => {
  it('sends obtainedBefore as a ms epoch and passes the answer through', async () => {
    const { storage, calls } = storageFor({ rollover: () => ({ status: 'rolled', source: 'refresh' }) })
    const result = await storage.rollover('COOL-SHOP.myshopify.com', { obtainedBefore: new Date(EXPIRES) })
    expect(result).toEqual({ status: 'rolled', source: 'refresh' })
    expect(calls[0]).toMatchObject({ shop: SHOP, method: 'rollover', input: { shop: SHOP, obtainedBefore: EXPIRES } })
  })

  it('rejects an invalid shop or time without calling the namespace', async () => {
    const { storage, calls } = storageFor()
    await expect(storage.rollover('', { obtainedBefore: new Date() })).rejects.toThrow(/valid shop/)
    await expect(storage.rollover(SHOP, { obtainedBefore: new Date('garbage') })).rejects.toThrow(/obtainedBefore/)
    await expect(storage.rollover(SHOP, { obtainedBefore: EXPIRES as unknown as Date })).rejects.toThrow(
      /obtainedBefore/,
    )
    expect(calls).toEqual([])
  })
})

describe('package entry', () => {
  it('loads in plain Node (no cloudflare:workers) and exposes the public API', async () => {
    const entry = await import('../../src/index.js')
    expect(entry.DurableObjectSessionStorage).toBe(DurableObjectSessionStorage)
    expect(typeof entry.migrateLegacySessions).toBe('function')
    expect(typeof entry.validateKeyring).toBe('function')
    expect(entry.canonicalShop(' Cool-Shop.myshopify.com/ ')).toBe(SHOP)
    expect(entry.ISSUED).toBe(Symbol.for('@optizio/shopify-session-storage-do'))
    expect(entry.DEFAULT_LOCATION_HINT).toBe('enam')
    expect(entry.DEFAULT_REGISTRY_PREFIX).toBe('shop-session:')
    expect(entry.DEFAULT_BACKFILL_CURSOR_KEY).toBe('shop-sessions:backfill-cursor')
    expect(typeof entry.rolloverShops).toBe('function')
    expect(entry.DEFAULT_ROLLOVER_REQUEST_KEY).toBe('shop-sessions:rollover')
    expect(entry.DEFAULT_ROLLOVER_STATE_KEY).toBe('shop-sessions:rollover-state')
  })
})
