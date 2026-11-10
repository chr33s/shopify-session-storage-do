import { describe, expect, it } from 'vitest'
import { fingerprint } from '../../../src/fingerprint.js'
import {
  APP_CACHE_SERVE_GRACE,
  MINT_REJECTED_HOLD,
  QUARANTINE_GC,
  RENEW_JITTER_MAX_S,
  RENEW_JITTER_MIN_S,
  appCacheFresh,
  renewAfterAt,
} from '../../../src/core/record.js'
import { DAY, HOUR, MIN, SHOP, createHarness, failure, minted, settle } from './fakes.js'
import type { Harness } from './fakes.js'

const APP_TOKEN = 'primary-app-token-1'
const APP_TOKEN_2 = 'primary-app-token-2'

function primaryHarness(extra: Parameters<typeof createHarness>[0] = {}): Harness {
  return createHarness({ appTokens: true, appTokenMode: 'primary', ...extra })
}

/** The OAuth install's write: the record (and marker) a shop must have before anything is minted for it. */
async function install(h: Harness, scope = 'read_products'): Promise<void> {
  const result = await h.core.putSession({
    shop: SHOP,
    session: { shop: SHOP, accessToken: 'oauth-access', expires: h.clock.now() + HOUR, scope },
  })
  expect(result).toEqual({ status: 'stored' })
}

/** A cached app token, as a mint would have stored it. */
async function seedCache(
  h: Harness,
  token: string,
  fields: { expires?: number; renewAfter?: number; fps?: string[] } = {},
) {
  const expires = fields.expires ?? h.clock.now() + HOUR
  return h.seed({
    source: 'app_token',
    token,
    refresh: null,
    expires,
    renewAfter: fields.renewAfter ?? expires - 5 * MIN,
    signingKid: 'sig-kid-1',
    pairObtainedAt: expires - HOUR,
    scope: 'read_products',
    appTokenFps: fields.fps ?? [await fingerprint(token)],
  })
}

describe('renewAfterAt / appCacheFresh', () => {
  it('applies jitter in the Shopify-recommended 180–480 s window', () => {
    const expiresAt = 1_000_000
    expect(renewAfterAt(expiresAt, 0)).toBe(expiresAt - RENEW_JITTER_MIN_S * 1000)
    expect(renewAfterAt(expiresAt, 1)).toBe(expiresAt - RENEW_JITTER_MAX_S * 1000)
    const mid = renewAfterAt(expiresAt, 0.5)
    expect(mid).toBeGreaterThanOrEqual(expiresAt - RENEW_JITTER_MAX_S * 1000)
    expect(mid).toBeLessThanOrEqual(expiresAt - RENEW_JITTER_MIN_S * 1000)
  })

  it('treats a mismatched signing kid as a miss only in strict mode', () => {
    const record = {
      v: 1 as const,
      shop: SHOP,
      pairObtainedAt: 0,
      source: 'app_token' as const,
      token: { kid: 'k', iv: new Uint8Array(12), ct: new Uint8Array(16) },
      tokenFp: 'fp',
      expires: 10_000,
      renewAfter: 9_000,
      signingKid: 'sig-kid-1',
    }
    expect(appCacheFresh(record, { now: 8_000, signingKid: 'sig-kid-2' })).toBe(true)
    expect(appCacheFresh(record, { now: 8_000, signingKid: 'sig-kid-2', strictSigningKid: true })).toBe(false)
    expect(appCacheFresh(record, { now: 9_500, signingKid: 'sig-kid-1' })).toBe(false)
  })
})

describe('app-token primary mode (§6.11)', () => {
  it('mints on a cache miss and serves the library and app callers the same token', async () => {
    const h = primaryHarness()
    await install(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN, { scope: 'read_products' }))

    const library = await h.get()
    expect(library).toMatchObject({
      status: 'ok',
      source: 'app_token',
      session: { shop: SHOP, accessToken: APP_TOKEN, scope: 'read_products' },
    })
    expect(await h.get(undefined, 'app')).toMatchObject({ session: { accessToken: APP_TOKEN } })
    expect(h.appTokens!.calls).toEqual([SHOP])
    expect(h.tokens.calls).toEqual([])
    expect(h.store.record).toMatchObject({
      source: 'app_token',
      signingKid: 'sig-kid-1',
      scope: 'read_products',
    })
    expect(h.store.record!.renewAfter).toBeLessThan(h.store.record!.expires!)
    expect(h.marker()).toBeDefined()
  })

  it('reuses the cache until renewAfter, then remints', async () => {
    const h = primaryHarness()
    const expires = h.clock.now() + HOUR
    await h.seed({
      source: 'app_token',
      token: APP_TOKEN,
      refresh: null,
      expires,
      renewAfter: h.clock.now() + 10 * MIN,
      signingKid: 'sig-kid-1',
      scope: 'read_products',
      appTokenFps: [await fingerprint(APP_TOKEN)],
    })

    expect(await h.get()).toMatchObject({ session: { accessToken: APP_TOKEN } })
    expect(h.appTokens!.calls).toEqual([])

    h.clock.advance(11 * MIN)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN_2))
    expect(await h.get()).toMatchObject({ session: { accessToken: APP_TOKEN_2 } })
    expect(h.appTokens!.calls).toEqual([SHOP])
  })

  it('ignores a legacy refresh-token row and overwrites it with a fresh app token', async () => {
    const h = primaryHarness()
    await h.seed({ token: 'old-access', refresh: 'old-refresh', source: 'exchange' })
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))

    expect(await h.get()).toMatchObject({ source: 'app_token', session: { accessToken: APP_TOKEN } })
    expect(h.store.record).toMatchObject({ source: 'app_token', signingKid: 'sig-kid-1' })
    expect(h.store.record).not.toHaveProperty('refresh')
  })

  it('returns the still-valid cache when a remint fails inside the pre-expiry window', async () => {
    const h = primaryHarness()
    const expires = h.clock.now() + 20 * MIN
    await h.seed({
      source: 'app_token',
      token: APP_TOKEN,
      refresh: null,
      expires,
      renewAfter: h.clock.now() - 1,
      signingKid: 'sig-kid-1',
      appTokenFps: [await fingerprint(APP_TOKEN)],
    })
    // Initial attempt + 3 retries.
    h.appTokens!.onMint(
      failure(h.clock, 'transient'),
      failure(h.clock, 'transient'),
      failure(h.clock, 'transient'),
      failure(h.clock, 'transient'),
    )

    expect(await h.get()).toMatchObject({ status: 'ok', session: { accessToken: APP_TOKEN } })
    expect(h.appTokens!.calls).toHaveLength(4)
    expect(expires - h.clock.now()).toBeGreaterThan(APP_CACHE_SERVE_GRACE)
  })

  it('does not retry 4xx mint failures', async () => {
    const h = primaryHarness()
    await install(h)
    h.appTokens!.onMint(failure(h.clock, 'terminal', { code: 'invalid_client', status: 401 }))
    expect(await h.get()).toMatchObject({ status: 'needs_reauth', reason: 'app_token_rejected' })
    expect(h.appTokens!.calls).toHaveLength(1)
  })

  it('invalidateAndRefresh remints when the failed token still matches', async () => {
    const h = primaryHarness()
    await install(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN), minted(h.clock, APP_TOKEN_2))
    await h.get()

    const result = await h.core.invalidateAndRefresh({ shop: SHOP, failedAccessToken: APP_TOKEN })
    expect(result).toMatchObject({
      status: 'refreshed',
      session: { accessToken: APP_TOKEN_2 },
    })
    expect(h.appTokens!.calls).toHaveLength(2)
  })

  it('invalidateAndRefresh ignores a stale failed token after another request already refreshed', async () => {
    const h = primaryHarness()
    await install(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN), minted(h.clock, APP_TOKEN_2))
    await h.get()
    await h.core.invalidateAndRefresh({ shop: SHOP, failedAccessToken: APP_TOKEN })

    expect(await h.core.invalidateAndRefresh({ shop: SHOP, failedAccessToken: APP_TOKEN })).toEqual({
      status: 'ignored_stale',
    })
    expect(h.appTokens!.calls).toHaveLength(2)
  })

  it('strictSigningKid remints immediately after a key roll', async () => {
    const h = primaryHarness({ strictSigningKid: true })
    await h.seed({
      source: 'app_token',
      token: APP_TOKEN,
      refresh: null,
      expires: h.clock.now() + HOUR,
      renewAfter: h.clock.now() + 30 * MIN,
      signingKid: 'old-kid',
      appTokenFps: [await fingerprint(APP_TOKEN)],
    })
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN_2))
    expect(await h.get()).toMatchObject({ session: { accessToken: APP_TOKEN_2 } })
    expect(h.store.record?.signingKid).toBe('sig-kid-1')
  })

  it('putSession of an OAuth exchange only marks the shop installed; the next load mints', async () => {
    const h = primaryHarness()
    const result = await h.core.putSession({
      shop: SHOP,
      session: {
        shop: SHOP,
        accessToken: 'oauth-access',
        refreshToken: 'oauth-refresh',
        expires: h.clock.now() + HOUR,
        refreshTokenExpires: h.clock.now() + 90 * DAY,
        scope: 'read_products',
      },
    })
    expect(result).toEqual({ status: 'stored' })
    expect(h.store.record).toMatchObject({ source: 'exchange', scope: 'read_products' })
    expect(h.store.record).not.toHaveProperty('refresh')
    expect(h.store.record).not.toHaveProperty('token')

    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    expect(await h.get()).toMatchObject({ source: 'app_token', session: { accessToken: APP_TOKEN } })
  })

  it('coalesces concurrent mints into a single flight', async () => {
    const h = primaryHarness({ callerWaitMs: 5_000 })
    await install(h)
    const deferred = h.appTokens!.deferMint()
    const first = h.get()
    await settle()
    const second = h.get(undefined, 'app')
    await settle()
    expect(h.appTokens!.calls).toHaveLength(1)
    deferred.resolve(minted(h.clock, APP_TOKEN))
    expect(await first).toMatchObject({ session: { accessToken: APP_TOKEN } })
    expect(await second).toMatchObject({ session: { accessToken: APP_TOKEN } })
    expect(h.appTokens!.calls).toHaveLength(1)
  })
})

describe('app-token primary mode: review regressions', () => {
  it('a destroy during an in-flight mint is not undone', async () => {
    const h = primaryHarness({ callerWaitMs: 5_000 })
    await install(h)
    const pending = h.appTokens!.deferMint()
    const get = h.get()
    await settle()
    expect(await h.core.destroy({ shop: SHOP })).toEqual({ status: 'deleted' })
    pending.resolve(minted(h.clock, APP_TOKEN))
    expect(await get).toEqual({ status: 'none' })
    await h.drain()
    expect(h.store.record).toBeUndefined()
    expect(h.marker()).toBeUndefined()
  })

  it('a late 401 write-back of an older app token leaves the current one alone', async () => {
    const h = primaryHarness()
    await seedCache(h, APP_TOKEN_2, { fps: [await fingerprint(APP_TOKEN_2), await fingerprint(APP_TOKEN)] })
    const result = await h.core.putSession({
      shop: SHOP,
      session: { shop: SHOP, scope: 'read_products' },
      issued: { tokenFp: await fingerprint(APP_TOKEN) },
    })
    expect(result).toEqual({ status: 'merged' })
    expect(h.store.record).not.toHaveProperty('tokenInvalid')
    expect(await h.get()).toMatchObject({ session: { accessToken: APP_TOKEN_2 } })
  })

  it('a 401 write-back of the current app token clears its window', async () => {
    const h = primaryHarness()
    await seedCache(h, APP_TOKEN)
    const result = await h.core.putSession({
      shop: SHOP,
      session: { shop: SHOP },
      issued: { tokenFp: await fingerprint(APP_TOKEN) },
    })
    expect(result).toEqual({ status: 'merged' })
    expect(h.store.record).toMatchObject({ tokenInvalid: true, renewAfter: 0 })
  })

  it('an untagged copy of an older app token does not replace the cache', async () => {
    const h = primaryHarness()
    await seedCache(h, APP_TOKEN_2, { fps: [await fingerprint(APP_TOKEN_2), await fingerprint(APP_TOKEN)] })
    const deletes = h.alarm.deletes
    const result = await h.core.putSession({
      shop: SHOP,
      session: { shop: SHOP, accessToken: APP_TOKEN, scope: 'read_products' },
    })
    expect(result).toEqual({ status: 'merged' })
    expect(h.stored().token).toBe(APP_TOKEN_2)
    expect(h.store.record).toMatchObject({ source: 'app_token' })
    expect(h.alarm.deletes).toBe(deletes)
  })

  it('honours minValidityMs: remints a cache that would not last that long', async () => {
    const h = primaryHarness()
    await seedCache(h, APP_TOKEN, { expires: h.clock.now() + 4 * MIN, renewAfter: h.clock.now() + MIN })
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN_2))
    expect(await h.get(30 * MIN)).toMatchObject({ session: { accessToken: APP_TOKEN_2 } })
    // The new token covers it, so it is served from cache.
    expect(await h.get(30 * MIN)).toMatchObject({ session: { accessToken: APP_TOKEN_2 } })
    expect(h.appTokens!.calls).toHaveLength(1)
  })

  it('serves a token shorter-lived than the jitter from cache for the first half of its life', async () => {
    const h = primaryHarness()
    await install(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN, { expiresIn: 120 }))
    await h.get()
    expect(h.store.record!.renewAfter).toBeGreaterThan(h.clock.now())
    expect(await h.get()).toMatchObject({ session: { accessToken: APP_TOKEN } })
    expect(h.appTokens!.calls).toHaveLength(1)
  })

  it('rollover remints the cache, and answers current for one minted since', async () => {
    const h = primaryHarness()
    await seedCache(h, APP_TOKEN)
    h.keyring.currentKid = 'kid-b'
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN_2))
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toEqual({
      status: 'rolled',
      source: 'app_token',
    })
    expect(h.store.record!.token!.kid).toBe('kid-b')
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toEqual({ status: 'current' })
  })

  it('rollover reports a rejected mint, then holds it', async () => {
    const h = primaryHarness()
    await install(h)
    h.appTokens!.onMint(failure(h.clock, 'terminal', { code: 'invalid_client' }))
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toEqual({
      status: 'rejected',
      reason: 'app_token_rejected',
    })
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toMatchObject({
      status: 'needs_reauth',
      reason: 'app_token_rejected',
    })
  })

  it('never mints for a shop without a record', async () => {
    const h = primaryHarness()
    expect(await h.get()).toEqual({ status: 'none' })
    expect(await h.core.invalidateAndRefresh({ shop: SHOP })).toMatchObject({ status: 'failed', code: 'not_installed' })
    expect(h.store.record).toBeUndefined()
    expect(h.marker()).toBeUndefined()
  })

  it('a rejected mint does not keep a destroy from deleting the record', async () => {
    const h = primaryHarness()
    await install(h)
    const uninstalledAt = h.clock.now()
    h.clock.advance(5 * MIN)
    h.appTokens!.onMint(failure(h.clock, 'terminal', { code: 'invalid_client' }))
    expect(await h.get()).toMatchObject({ status: 'needs_reauth' })
    expect(await h.core.destroy({ shop: SHOP, uninstalledAt })).toEqual({ status: 'deleted' })
  })

  it('invalidateAndRefresh honours a stored rejection and the transient backoff', async () => {
    const h = primaryHarness()
    await install(h)
    h.appTokens!.onMint(failure(h.clock, 'terminal', { code: 'invalid_client' }))
    await h.get()
    expect(await h.core.invalidateAndRefresh({ shop: SHOP })).toEqual({
      status: 'failed',
      kind: 'terminal',
      code: 'invalid_client',
    })
    expect(h.appTokens!.calls).toHaveLength(1)

    const t = primaryHarness()
    await install(t)
    t.appTokens!.onMint(failure(t.clock, 'shop_unavailable', { code: 'http_402' }))
    expect(await t.core.invalidateAndRefresh({ shop: SHOP })).toEqual({
      status: 'failed',
      kind: 'shop_unavailable',
      code: 'http_402',
    })
    expect(await t.core.invalidateAndRefresh({ shop: SHOP })).toEqual({
      status: 'failed',
      kind: 'shop_unavailable',
      code: 'http_402',
    })
    expect(t.appTokens!.calls).toHaveLength(1)
  })

  it('reports the code of the failure at hand, not an earlier one', async () => {
    const h = primaryHarness()
    await install(h)
    h.appTokens!.onMint(...Array.from({ length: 4 }, () => failure(h.clock, 'transient', { code: 'http_503' })))
    expect(await h.core.invalidateAndRefresh({ shop: SHOP })).toMatchObject({ code: 'http_503', kind: 'transient' })
    h.clock.advance(2 * MIN)
    h.appTokens!.onMint(failure(h.clock, 'terminal', { code: 'invalid_client' }))
    expect(await h.core.invalidateAndRefresh({ shop: SHOP })).toEqual({
      status: 'failed',
      kind: 'terminal',
      code: 'invalid_client',
    })
  })

  it('invalidateAndRefresh that joins a mint which fails reports the failure', async () => {
    const h = primaryHarness({ callerWaitMs: 5_000 })
    await install(h)
    const pending = h.appTokens!.deferMint()
    const get = h.get()
    await settle()
    const invalidate = h.core.invalidateAndRefresh({ shop: SHOP })
    await settle()
    pending.resolve(failure(h.clock, 'terminal', { code: 'invalid_client' }))
    expect(await get).toMatchObject({ status: 'needs_reauth' })
    expect(await invalidate).toEqual({ status: 'failed', kind: 'terminal', code: 'invalid_client' })
    expect(h.appTokens!.calls).toHaveLength(1)
  })

  it.each([
    ['a 429 with Retry-After', { code: 'http_429', status: 429, retryAfterMs: 30_000 }],
    ['a challenge', { code: 'challenge', status: 403 }],
    ['a 408', { code: 'http_408', status: 408 }],
  ])('does not retry %s', async (_name, fields) => {
    const h = primaryHarness()
    await install(h)
    h.appTokens!.onMint(failure(h.clock, 'transient', fields))
    expect(await h.get()).toMatchObject({ status: 'tokenless', reason: 'token_endpoint' })
    expect(h.appTokens!.calls).toHaveLength(1)
  })

  it('the alarm takes back a marker it wrote for a record destroyed meanwhile', async () => {
    const h = primaryHarness()
    await seedCache(h, APP_TOKEN)
    const put = h.registry.put.bind(h.registry)
    h.registry.put = async (key, value, options) => {
      await put(key, value, options)
      h.store.record = undefined
    }
    await h.core.alarm()
    expect(h.marker()).toBeUndefined()
  })

  it('re-encrypts off the request path: a failed reseal still answers', async () => {
    const h = primaryHarness()
    await seedCache(h, APP_TOKEN)
    h.keyring.currentKid = 'kid-b'
    h.store.failPut = new Error('storage down')
    expect(await h.get()).toMatchObject({ status: 'ok', session: { accessToken: APP_TOKEN } })
    await h.drain()
    h.store.failPut = undefined
    expect(await h.get()).toMatchObject({ status: 'ok' })
    await h.drain()
    expect(h.store.record!.token!.kid).toBe('kid-b')
  })

  it('writes the marker on the first cache only, not on every remint', async () => {
    const h = primaryHarness()
    await install(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN), minted(h.clock, APP_TOKEN_2))
    await h.get()
    const markerPuts = () => h.registry.ops.filter((op) => op.op === 'put').length
    const after = markerPuts()
    h.clock.advance(HOUR)
    expect(await h.get()).toMatchObject({ session: { accessToken: APP_TOKEN_2 } })
    expect(markerPuts()).toBe(after)
  })
})

describe('app-token primary mode: second review regressions', () => {
  it('an exchange after a rejected mint keeps the hold, shortened, instead of reminting on every admin load', async () => {
    const h = primaryHarness()
    await install(h)
    h.appTokens!.onMint(failure(h.clock, 'terminal', { code: 'invalid_client', status: 401 }))
    expect(await h.get()).toMatchObject({ status: 'needs_reauth', reason: 'app_token_rejected' })
    // authenticate.admin exchanges because loadSession found nothing, many times over.
    for (let i = 0; i < 3; i++) {
      await h.core.putSession({
        shop: SHOP,
        session: { shop: SHOP, accessToken: `oauth-${i}`, expires: h.clock.now() + HOUR },
      })
      expect(await h.get()).toMatchObject({ status: 'needs_reauth', reason: 'app_token_rejected' })
    }
    expect(h.appTokens!.calls).toHaveLength(1)
    expect(h.reports.filter((r) => r.context.op === 'mint')).toHaveLength(1)
    // The cause was fixed (the JWK registered): within MINT_REJECTED_HOLD the next load mints.
    h.clock.advance(MINT_REJECTED_HOLD)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    expect(await h.get()).toMatchObject({ status: 'ok', source: 'app_token' })
    expect(h.store.record?.mintRejected).toBeUndefined()
  })

  it('answers tokenless(import_failed), not none, when the lazy legacy import throws', async () => {
    const h = primaryHarness({ legacy: true })
    h.legacyKv!.setJson(`offline_${SHOP}`, [['accessToken', 'legacy-token']])
    h.legacyKv!.failNext = { op: 'get', error: new Error('kv down') }
    expect(await h.get(undefined, 'app')).toEqual({ status: 'tokenless', reason: 'import_failed' })
    expect(h.appTokens!.calls).toHaveLength(0)
  })

  it('the install stub is not a legacy record: describes ok, and its alarm deletes a legacy KV copy', async () => {
    const h = primaryHarness({ legacy: true })
    await install(h)
    expect(await h.core.describe({ shop: SHOP })).toMatchObject({ state: 'ok', exists: true })
    h.legacyKv!.setJson(`offline_${SHOP}`, [['accessToken', 'legacy-token']])
    await h.core.alarm()
    expect(h.legacyKv!.data.has(`offline_${SHOP}`)).toBe(false)
  })

  it('an exchange over an imported legacy row deletes its KV copy', async () => {
    const h = primaryHarness({ legacy: true })
    await h.seedLegacy()
    h.legacyKv!.setJson(`offline_${SHOP}`, [['accessToken', 'legacy-1']])
    await install(h)
    expect(h.legacyKv!.data.has(`offline_${SHOP}`)).toBe(false)
  })

  it('serves a still-valid cached token while a mint is held rejected', async () => {
    const h = primaryHarness()
    const now = h.clock.now()
    await seedCache(h, APP_TOKEN, { expires: now + 4 * MIN, renewAfter: now - MIN })
    h.appTokens!.onMint(failure(h.clock, 'terminal', { code: 'invalid_assertion', status: 400 }))
    expect(await h.get()).toMatchObject({ status: 'ok', session: { accessToken: APP_TOKEN } })
    expect(await h.get()).toMatchObject({ status: 'ok', session: { accessToken: APP_TOKEN } })
    expect(h.appTokens!.calls).toHaveLength(1)
    h.clock.advance(4 * MIN)
    expect(await h.get()).toMatchObject({ status: 'needs_reauth', reason: 'app_token_rejected' })
  })

  it('stores no rejection for a mint that never left: tokenless, retried after the backoff', async () => {
    const h = primaryHarness()
    await install(h)
    h.appTokens!.onMint(failure(h.clock, 'configuration', { code: 'sign_failed' }))
    expect(await h.get()).toMatchObject({ status: 'tokenless', reason: 'token_endpoint' })
    expect(h.store.record?.mintRejected).toBeUndefined()
    expect(await h.get()).toMatchObject({ status: 'tokenless' })
    expect(h.appTokens!.calls).toHaveLength(1)
    h.clock.advance(MIN)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    expect(await h.get()).toMatchObject({ status: 'ok', source: 'app_token' })
  })

  it('wipes a shop whose mints have been refused for 90 days, with its marker', async () => {
    const h = primaryHarness()
    await install(h)
    h.appTokens!.onMint(failure(h.clock, 'terminal', { code: 'invalid_client' }))
    await h.get()
    expect(h.alarm.at).toBe(h.clock.now() + QUARANTINE_GC)
    h.clock.advance(QUARANTINE_GC)
    await h.core.alarm()
    expect(h.store.record).toBeUndefined()
    expect(h.marker()).toBeUndefined()
  })

  it('wipes a quarantine chain mode left behind after 90 days', async () => {
    const h = primaryHarness()
    await h.seed({
      needsReauth: { since: h.clock.now() - QUARANTINE_GC, reason: 'refresh_rejected', credFp: 'cred-fp-1' },
    })
    await h.core.alarm()
    expect(h.store.record).toBeUndefined()
  })

  it("invalidateAndRefresh('') is a failed token that matches nothing: ignored, the cache kept", async () => {
    const h = primaryHarness()
    await install(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    await h.get()
    expect(await h.core.invalidateAndRefresh({ shop: SHOP, failedAccessToken: '' })).toEqual({
      status: 'ignored_stale',
    })
    expect(h.appTokens!.calls).toHaveLength(1)
  })

  it('recognises an untagged write-back of an app token minted many renewals ago', async () => {
    const h = primaryHarness()
    await install(h)
    h.appTokens!.onMint(minted(h.clock, 'app-0'))
    await h.get()
    for (let i = 1; i <= 10; i++) {
      h.appTokens!.onMint(minted(h.clock, `app-${i}`))
      await h.core.invalidateAndRefresh({ shop: SHOP })
    }
    expect(await h.core.putSession({ shop: SHOP, session: { shop: SHOP, accessToken: 'app-0' } })).toEqual({
      status: 'merged',
    })
    expect(h.stored().token).toBe('app-10')
  })
})

describe('fallback mode after primary mode', () => {
  it('never serves a leftover app-token cache to the library, and marks it invalid on a 401 write-back', async () => {
    const h = createHarness({ appTokens: true })
    await seedCache(h, APP_TOKEN)
    expect(await h.get()).toMatchObject({ status: 'needs_reauth', reason: 'no_refresh_token' })
    const tokenFp = await fingerprint(APP_TOKEN)
    expect(
      await h.core.putSession({ shop: SHOP, session: { shop: SHOP, accessToken: '' }, issued: { tokenFp } }),
    ).toEqual({ status: 'merged' })
    expect(h.store.record?.tokenInvalid).toBe(true)
  })
})
