import { describe, expect, it } from 'vitest'
import { fingerprint } from '../../../src/fingerprint.js'
import {
  APP_CACHE_SERVE_GRACE,
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
    // Four transient failures (initial + 3 retries).
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
    h.appTokens!.onMint(failure(h.clock, 'terminal', { code: 'invalid_client', status: 401 }))
    expect(await h.get()).toMatchObject({ status: 'needs_reauth', reason: 'app_token_rejected' })
    expect(h.appTokens!.calls).toHaveLength(1)
  })

  it('invalidateAndRefresh remints when the failed token still matches', async () => {
    const h = primaryHarness()
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
