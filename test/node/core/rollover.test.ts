import { describe, expect, it } from 'vitest'
import { CRED_FP, DAY, HOUR, MIN, SHOP, createHarness, deferred, failure, success } from './fakes.js'
import type { TokenCallResult } from '../../../src/types.js'

const failing = (kind: 'transient' | 'configuration', retryAt: number) => ({
  count: 1,
  kind,
  code: kind === 'transient' ? 'http_503' : 'invalid_client',
  since: 0,
  retryAt,
  credFp: CRED_FP,
  reported: `${kind}:x`,
})

describe('rollover: expiring records', () => {
  it('refreshes a pair obtained before the cut, and keeps the chain alive from it', async () => {
    const h = createHarness()
    await h.seed({ pairObtainedAt: h.clock.now() - HOUR })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2', refresh: 'refresh-2' }))

    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toEqual({
      status: 'rolled',
      source: 'refresh',
    })
    expect(h.tokens.calls).toEqual([{ kind: 'refresh', shop: SHOP, token: 'refresh-1' }])
    expect(h.stored()).toMatchObject({ token: 'access-2', refresh: 'refresh-2' })
    expect(h.store.record).toMatchObject({ source: 'refresh', pairObtainedAt: h.clock.now() })
    expect(h.alarm.at).toBe(h.clock.now() + 30 * DAY)
  })

  it('leaves a pair obtained at or after the cut alone', async () => {
    const h = createHarness()
    await h.seed({ pairObtainedAt: h.clock.now() })
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toEqual({ status: 'current' })
    expect(h.tokens.calls).toEqual([])
  })

  it('refreshes an imported pair whatever its import time says', async () => {
    const h = createHarness()
    await h.seed({ source: 'import', pairObtainedAt: h.clock.now() })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2' }))
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() - MIN })).toMatchObject({
      status: 'rolled',
    })
  })

  it('re-seals every field under the current key', async () => {
    const h = createHarness()
    await h.seed({ pairObtainedAt: h.clock.now() - HOUR, alternates: ['alt-1'] })
    h.keyring.currentKid = 'kid-b'
    h.tokens.onRefresh(success(h.clock, { access: 'access-2' }))
    await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })
    expect(await h.core.describe({ shop: SHOP })).toMatchObject({ kids: ['kid-b'] })
  })

  it('ignores a backoff in progress: an operator asked', async () => {
    const h = createHarness()
    await h.seed({ pairObtainedAt: h.clock.now() - HOUR, failures: failing('transient', h.clock.now() + 6 * HOUR) })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2' }))
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toMatchObject({ status: 'rolled' })
    expect(h.store.record?.failures).toBeUndefined()
  })

  it('answers a failure with its kind and code, backing off on the alarm schedule', async () => {
    const h = createHarness()
    await h.seed({ pairObtainedAt: h.clock.now() - HOUR })
    h.tokens.onRefresh(failure(h.clock, 'transient', { code: 'http_429', status: 429 }))
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toEqual({
      status: 'failed',
      kind: 'transient',
      code: 'http_429',
      retryAt: h.clock.now() + MIN,
    })
    expect(h.alarm.at).toBe(h.clock.now() + MIN)
  })

  it('answers a configuration failure as such', async () => {
    const h = createHarness()
    await h.seed({ pairObtainedAt: h.clock.now() - HOUR })
    h.tokens.onRefresh(failure(h.clock, 'configuration'))
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toMatchObject({
      status: 'failed',
      kind: 'configuration',
      code: 'invalid_client',
    })
  })

  it('quarantines a chain Shopify rejects, after trying its alternates', async () => {
    const h = createHarness()
    await h.seed({ pairObtainedAt: h.clock.now() - HOUR, alternates: ['alt-1'] })
    h.tokens.onRefresh(failure(h.clock, 'terminal'), failure(h.clock, 'terminal'))
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toEqual({
      status: 'rejected',
      reason: 'refresh_rejected',
    })
    expect(h.tokens.calls.map((call) => call.token)).toEqual(['refresh-1', 'alt-1'])
    expect(h.store.record?.needsReauth).toMatchObject({ reason: 'refresh_rejected', credFp: CRED_FP })
  })

  it('skips a pair without a refresh token', async () => {
    const h = createHarness()
    await h.seed({ refresh: null, expires: h.clock.now() + HOUR, pairObtainedAt: h.clock.now() - HOUR })
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toEqual({
      status: 'skipped',
      reason: 'no_refresh_token',
    })
  })

  it('joins a refresh in flight, and counts its pair as current', async () => {
    const h = createHarness()
    await h.seed({ pairObtainedAt: h.clock.now() - HOUR, expires: h.clock.now() + 2 * MIN })
    const held = h.tokens.deferRefresh()
    const load = h.get()
    await h.tokens.waitForCalls(1)
    const rolled = h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })
    held.resolve(success(h.clock, { access: 'access-2' }))
    await load
    expect(await rolled).toEqual({ status: 'current' })
    expect(h.tokens.calls).toHaveLength(1)
  })

  it('looks again when an exchange replaces the record during its call', async () => {
    const h = createHarness()
    await h.seed({ pairObtainedAt: h.clock.now() - HOUR })
    const held = deferred<TokenCallResult>()
    h.tokens.onRefresh(held)
    const rolled = h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })
    await h.tokens.waitForCalls(1)
    const put = await h.core.putSession({
      shop: SHOP,
      session: {
        shop: SHOP,
        accessToken: 'access-x',
        // Later than the stored pair's expiry, so it becomes current.
        expires: h.clock.now() + 2 * HOUR,
        refreshToken: 'refresh-x',
        refreshTokenExpires: h.clock.now() + 90 * DAY,
      },
    })
    expect(put.status).toBe('stored')
    held.resolve(success(h.clock, { access: 'access-2' }))
    expect(await rolled).toEqual({ status: 'current' })
    expect(h.stored().token).toBe('access-x')
  })

  it('needs a finite obtainedBefore and its own shop', async () => {
    const h = createHarness()
    await expect(h.core.rollover({ shop: SHOP, obtainedBefore: Number.NaN })).rejects.toThrow(TypeError)
    await expect(h.core.rollover({ shop: 'other.myshopify.com', obtainedBefore: 0 })).rejects.toThrow(TypeError)
  })
})

describe('rollover: other records', () => {
  it('answers none without a record', async () => {
    const h = createHarness()
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toEqual({ status: 'none' })
  })

  it('skips an unreadable record', async () => {
    const h = createHarness()
    await h.seed({ pairObtainedAt: h.clock.now() - HOUR })
    h.keyring.unknownKids.add('kid-a')
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toEqual({
      status: 'skipped',
      reason: 'unreadable',
    })
  })

  it('migrates a legacy token at once with migration on, and lets its KV keys go', async () => {
    const h = createHarness({ legacy: true, migrateLegacy: true })
    await h.seedLegacy({ pairObtainedAt: h.clock.now() })
    h.legacyKv!.setJson(`offline_${SHOP}`, [['accessToken', 'legacy-1']])
    h.tokens.onMigrate(success(h.clock, { access: 'access-m' }))
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toEqual({
      status: 'rolled',
      source: 'migrate',
    })
    expect(h.store.record?.source).toBe('migrate')
    expect([...h.legacyKv!.data.keys()]).toEqual([])
  })

  it('leaves a legacy token alone with migration off', async () => {
    const h = createHarness({ migrateLegacy: false })
    await h.seedLegacy()
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toEqual({
      status: 'skipped',
      reason: 'migration_off',
    })
  })

  it('finishes a migration Shopify may have processed even with migration off', async () => {
    const h = createHarness({ migrateLegacy: false })
    await h.seedLegacy({ attemptSince: h.clock.now() - MIN })
    h.tokens.onMigrate(success(h.clock, { access: 'access-m' }))
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toMatchObject({ status: 'rolled' })
  })

  it('does not retry a quarantine under the same credentials', async () => {
    const h = createHarness()
    const since = h.clock.now() - DAY
    await h.seed({ needsReauth: { since, reason: 'refresh_rejected', credFp: CRED_FP } })
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toEqual({
      status: 'needs_reauth',
      since,
      reason: 'refresh_rejected',
    })
  })

  it('retries a quarantine once the credentials changed', async () => {
    const h = createHarness({ credFp: 'cred-fp-2' })
    await h.seed({ needsReauth: { since: h.clock.now() - DAY, reason: 'refresh_rejected', credFp: CRED_FP } })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2' }))
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() })).toMatchObject({ status: 'rolled' })
    expect(h.store.record?.needsReauth).toBeUndefined()
  })
})
