import { describe, expect, it } from 'vitest'
import { alarmAction } from '../../../src/core/record.js'
import { ShopSessions } from '../../../src/core/shop-sessions.js'
import { fingerprint } from '../../../src/fingerprint.js'
import { CRED_FP, DAY, HOUR, MIN, SHOP, createHarness, failure, settle, success } from './fakes.js'
import type { Harness } from './fakes.js'

/** A record whose access token is under the floor, so getSession refreshes inline. */
async function due(h: Harness, extra: Parameters<Harness['seed']>[0] = {}) {
  return h.seed({ expires: h.clock.now() + MIN, ...extra })
}

describe('success', () => {
  it('replaces the pair and clears alternates, tokenInvalid and failures', async () => {
    const h = createHarness()
    await due(h, {
      scope: 'old',
      alternates: ['a1'],
      tokenInvalid: true,
      source: 'exchange',
      chainOriginExpires: 777,
      failures: { count: 1, kind: 'transient', code: 'x', since: 0, retryAt: 0, credFp: CRED_FP },
    })
    h.tokens.onRefresh(
      success(h.clock, { access: 'access-2', refresh: 'refresh-2', scope: 'new', refreshExpiresIn: 86400 }),
    )
    await h.get()
    const record = h.store.record!
    expect(record).toEqual({
      v: 1,
      shop: SHOP,
      scope: 'new',
      token: record.token,
      tokenFp: await fingerprint('access-2'),
      expires: h.clock.now() + HOUR,
      refresh: record.refresh,
      refreshFp: await fingerprint('refresh-2'),
      refreshExpires: h.clock.now() + DAY,
      source: 'refresh',
      pairObtainedAt: h.clock.now(),
      chainOriginExpires: 777,
    })
    expect(h.keyring.peek(record.refresh)).toEqual({ aad: `${SHOP}|refresh`, plaintext: 'refresh-2' })
    // A one-day refresh lifetime is already inside the keepalive margin.
    expect(h.alarm.at).toBe(h.clock.now() + MIN)
  })

  it('defaults a missing expires_in to 30 min and reports the field name', async () => {
    const h = createHarness()
    await due(h)
    h.tokens.onRefresh(success(h.clock, { access: 'access-2', expiresIn: null }))
    await h.get()
    expect(h.store.record?.expires).toBe(h.clock.now() + 30 * MIN)
    const report = h.reports.find((r) => r.context.code === 'missing_fields')
    expect(report?.message).toContain('expires_in')
    expect(report?.context).toEqual({
      shop: SHOP,
      op: 'refresh',
      kind: 'success',
      code: 'missing_fields',
      requestId: 'req-ok',
    })
  })

  it('defaults a missing refresh_token_expires_in to 60 days', async () => {
    const h = createHarness()
    await due(h)
    h.tokens.onRefresh(success(h.clock, { access: 'access-2', refreshExpiresIn: null }))
    await h.get()
    expect(h.store.record?.refreshExpires).toBe(h.clock.now() + 60 * DAY)
    expect(h.reports.find((r) => r.context.code === 'missing_fields')?.message).toContain('refresh_token_expires_in')
  })

  it('keeps the scope when the response has none, without reporting', async () => {
    const h = createHarness()
    await due(h, { scope: 'read_products' })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2', scope: null }))
    await h.get()
    expect(h.store.record?.scope).toBe('read_products')
    expect(h.reports).toEqual([])
  })

  it('keeps the presented refresh token when the response has none and retries it soon', async () => {
    const h = createHarness()
    // A lifetime no default produces, so keeping the known one is what the check sees.
    const seeded = await due(h, { refreshExpires: h.clock.now() + 50 * DAY })
    const sentAt = h.clock.now()
    h.tokens.onRefresh(success(h.clock, { access: 'access-2', refresh: null, refreshExpiresIn: null }))
    await h.get()
    const record = h.store.record!
    expect(h.stored()).toMatchObject({ token: 'access-2', refresh: 'refresh-1' })
    expect(record.refresh).toEqual(seeded.refresh)
    expect(record.refreshExpires).toBe(seeded.refreshExpires)
    expect(record.failures).toMatchObject({
      kind: 'transient',
      code: 'missing_refresh_token',
      retryAt: h.clock.now() + MIN,
      ambiguousSince: sentAt,
    })
    expect(h.alarm.at).toBe(h.clock.now() + MIN)
    // The alarm presents the same refresh token again; the retry returns the same pair, so its expiry
    // dates from the first send.
    h.clock.advance(MIN)
    h.tokens.onRefresh(success(h.clock, { access: 'access-2', refresh: 'refresh-2' }))
    await h.core.alarm()
    expect(h.tokens.calls.map((c) => c.token)).toEqual(['refresh-1', 'refresh-1'])
    expect(h.store.record?.failures).toBeUndefined()
    expect(h.store.record?.expires).toBe(sentAt + HOUR)
    expect(h.stored().refresh).toBe('refresh-2')
  })
})

describe('transient and ambiguous failures', () => {
  it('records the failure, keeps everything, and dates the next success from the first ambiguous send', async () => {
    const h = createHarness()
    const seeded = await due(h)
    const firstSend = h.clock.now()
    h.tokens.onRefresh(failure(h.clock, 'transient', { code: 'timeout', ambiguous: true, status: undefined }))
    await h.get()
    expect(h.store.record).toEqual({
      ...seeded,
      // Shopify may have processed it, so the marker written before the call stays.
      attemptSince: firstSend,
      failures: {
        count: 1,
        kind: 'transient',
        code: 'timeout',
        since: firstSend,
        retryAt: firstSend + 10_000,
        ambiguousSince: firstSend,
        credFp: CRED_FP,
        reported: 'transient:timeout',
      },
    })
    expect(h.alarm.at).toBe(firstSend + MIN)

    h.clock.advance(20_000)
    h.tokens.onRefresh(failure(h.clock, 'transient', { code: 'http_502', ambiguous: true }))
    await h.get()
    expect(h.store.record?.failures).toMatchObject({ count: 2, ambiguousSince: firstSend, code: 'http_502' })

    h.clock.advance(MIN)
    h.tokens.onRefresh(success(h.clock, { access: 'access-2', expiresIn: 3600 }))
    await h.get()
    expect(h.store.record?.expires).toBe(firstSend + HOUR)
    expect(h.store.record?.failures).toBeUndefined()
  })

  it('reports each kind:code transition once', async () => {
    const h = createHarness()
    await due(h)
    for (const code of ['http_503', 'http_503', 'http_429', 'http_429']) {
      h.tokens.onRefresh(failure(h.clock, 'transient', { code }))
      await h.get()
      h.clock.advance(5 * MIN)
      h.store.record!.expires = h.clock.now() + MIN
    }
    expect(h.reports.map((r) => r.context.code)).toEqual(['http_503', 'http_429'])
    expect(h.reports[1]?.context).toMatchObject({ op: 'refresh', kind: 'transient', status: 503, count: 3 })
    expect(h.logs).toHaveLength(4)
  })

  it('honours Retry-After on request-driven calls', async () => {
    const h = createHarness()
    await due(h)
    h.tokens.onRefresh(failure(h.clock, 'transient', { code: 'http_429', status: 429, retryAfterMs: 45_000 }))
    await h.get()
    expect(h.store.record?.failures?.retryAt).toBe(h.clock.now() + 45_000)
  })

  it('backs off 6 h on shop and configuration problems, keeping everything', async () => {
    for (const kind of ['shop_unavailable', 'configuration'] as const) {
      const h = createHarness()
      const seeded = await due(h)
      h.tokens.onRefresh(failure(h.clock, kind))
      await h.get()
      expect(h.store.record).toEqual({
        ...seeded,
        failures: expect.objectContaining({ kind, retryAt: h.clock.now() + 6 * HOUR }),
      })
      expect(h.alarm.at).toBe(h.clock.now() + 6 * HOUR)
    }
  })

  it('treats a throwing token client as an ambiguous transient failure', async () => {
    const h = createHarness()
    await due(h)
    h.tokens.onRefresh(new Error('boom shpat_secret'))
    await h.get()
    expect(h.store.record?.failures).toMatchObject({
      kind: 'transient',
      code: 'exception',
      ambiguousSince: h.clock.now(),
    })
    expect(JSON.stringify(h.reports.map((r) => r.context)) + h.logs.join('')).not.toContain('shpat_secret')
  })
})

describe('terminal results', () => {
  it('quarantines, keeps sealed fields, reports, and never serves the token', async () => {
    const h = createHarness()
    const seeded = await due(h, { expires: h.clock.now() + MIN })
    h.tokens.onRefresh(failure(h.clock, 'terminal'))
    expect(await h.get()).toEqual({ status: 'needs_reauth', since: h.clock.now(), reason: 'refresh_rejected' })
    expect(h.store.record).toEqual({
      ...seeded,
      needsReauth: { since: h.clock.now(), reason: 'refresh_rejected', credFp: CRED_FP },
    })
    expect(h.reports.map((r) => r.context)).toEqual([
      { shop: SHOP, op: 'refresh', kind: 'terminal', code: 'invalid_request', status: 401, requestId: 'req-fail' },
    ])
    // Even with a valid-looking token, a quarantined record is not served or refreshed.
    h.store.record!.expires = h.clock.now() + HOUR
    expect(await h.get()).toMatchObject({ status: 'needs_reauth' })
    expect(h.alarm.at).toBe(h.clock.now() + 90 * DAY)
    expect(h.tokens.calls).toHaveLength(1)
  })

  it('presents alternates newest first and promotes the one that succeeds', async () => {
    const h = createHarness()
    await due(h, { alternates: ['alt-new', 'alt-mid', 'alt-old'] })
    h.tokens.onRefresh(
      failure(h.clock, 'terminal'),
      failure(h.clock, 'terminal'),
      success(h.clock, { access: 'access-3', refresh: 'refresh-3' }),
    )
    const result = await h.get()
    expect(result).toMatchObject({ status: 'ok', session: { accessToken: 'access-3' } })
    expect(h.tokens.calls.map((c) => c.token)).toEqual(['refresh-1', 'alt-new', 'alt-mid'])
    expect(h.stored()).toMatchObject({ token: 'access-3', refresh: 'refresh-3', alternates: [] })
    expect(h.store.record?.alternates).toBeUndefined()
  })

  it('keeps the winning alternate as the refresh token when its response has none', async () => {
    const h = createHarness()
    await due(h, { alternates: ['alt-new'] })
    h.tokens.onRefresh(failure(h.clock, 'terminal'), success(h.clock, { access: 'access-3', refresh: null }))
    await h.get()
    expect(h.stored()).toMatchObject({ token: 'access-3', refresh: 'alt-new' })
    expect(h.keyring.peek(h.store.record?.refresh)?.aad).toBe(`${SHOP}|refresh`)
    expect(h.store.record?.refreshFp).toBe(await fingerprint('alt-new'))
    expect(h.store.record?.failures?.code).toBe('missing_refresh_token')
  })

  it('is transient, not terminal, when any alternate attempt is transient', async () => {
    const h = createHarness()
    const seeded = await due(h, { alternates: ['alt-1', 'alt-2'] })
    h.tokens.onRefresh(
      failure(h.clock, 'terminal'),
      failure(h.clock, 'transient', { code: 'timeout', ambiguous: true }),
      failure(h.clock, 'terminal'),
    )
    await h.get()
    expect(h.store.record?.needsReauth).toBeUndefined()
    expect(h.store.record).toEqual({
      ...seeded,
      attemptSince: h.clock.now(),
      failures: expect.objectContaining({ kind: 'transient', code: 'timeout' }),
    })
    expect(h.store.record?.failures?.ambiguousSince).toBe(h.clock.now())
  })

  it('quarantines only when every presented token is rejected, keeping the alternates', async () => {
    const h = createHarness()
    const seeded = await due(h, { alternates: ['alt-1', 'alt-2'] })
    h.tokens.onRefresh(failure(h.clock, 'terminal'), failure(h.clock, 'terminal'), failure(h.clock, 'terminal'))
    await h.get()
    expect(h.store.record?.needsReauth?.reason).toBe('refresh_rejected')
    expect(h.store.record?.alternates).toEqual(seeded.alternates)
  })

  it('skips alternates it cannot decrypt', async () => {
    const h = createHarness()
    await due(h, { alternates: ['alt-1', 'alt-2'] })
    h.store.record!.alternates![0]!.refresh.kid = 'kid-gone'
    h.keyring.unknownKids.add('kid-gone')
    h.tokens.onRefresh(failure(h.clock, 'terminal'), success(h.clock, { access: 'access-2' }))
    await h.get()
    expect(h.tokens.calls.map((c) => c.token)).toEqual(['refresh-1', 'alt-2'])
  })

  it('does not present alternates when the primary failed for another reason', async () => {
    for (const kind of ['transient', 'shop_unavailable', 'configuration'] as const) {
      const h = createHarness()
      await due(h, { alternates: ['alt-1'] })
      h.tokens.onRefresh(failure(h.clock, kind))
      await h.get()
      expect(h.tokens.calls.map((c) => c.token)).toEqual(['refresh-1'])
      expect(h.store.record?.failures?.kind).toBe(kind)
    }
  })

  it('records a transient alternate outcome over a shop_unavailable one', async () => {
    const h = createHarness()
    await due(h, { alternates: ['alt-1', 'alt-2'] })
    h.tokens.onRefresh(
      failure(h.clock, 'terminal'),
      failure(h.clock, 'shop_unavailable'),
      failure(h.clock, 'transient', { code: 'http_429', status: 429 }),
    )
    await h.get()
    expect(h.store.record?.failures).toMatchObject({ kind: 'transient', code: 'http_429' })
    expect(h.store.record?.failures?.retryAt).toBe(h.clock.now() + 10_000)
  })

  it('does not quarantine over an alternate filed while the call was out', async () => {
    const h = createHarness({ callerWaitMs: 2_000 })
    await due(h, { source: 'refresh', chainOriginExpires: h.clock.now() + 2 * HOUR })
    const d = h.tokens.deferRefresh()
    const pending = h.get()
    await h.tokens.waitForCalls(1)
    await h.core.putSession({
      shop: SHOP,
      session: { shop: SHOP, accessToken: 'late', refreshToken: 'late-refresh', expires: h.clock.now() + HOUR },
    })
    expect(h.stored().alternates).toEqual(['late-refresh'])
    d.resolve(failure(h.clock, 'terminal'))
    await pending
    expect(h.store.record?.needsReauth).toBeUndefined()
    expect(h.store.record?.failures?.code).toBe('untried_alternates')
    // The next attempt presents it.
    h.clock.advance(MIN)
    h.tokens.onRefresh(failure(h.clock, 'terminal'), success(h.clock, { access: 'access-9' }))
    await h.core.alarm()
    expect(h.tokens.calls.map((c) => c.token)).toEqual(['refresh-1', 'refresh-1', 'late-refresh'])
    expect(h.stored().token).toBe('access-9')
  })
})

describe('migration outcomes', () => {
  it('upgrades a legacy token and deletes the legacy KV keys', async () => {
    const h = createHarness({ legacy: true, migrateLegacy: true })
    await h.seedLegacy({ pairObtainedAt: h.clock.now() - HOUR, scope: 's' })
    h.legacyKv!.setJson(`offline_${SHOP}`, [['accessToken', 'legacy-1']])
    h.legacyKv!.setJson(`shop:${SHOP}`, [`offline_${SHOP}`])
    h.tokens.onMigrate(success(h.clock, { access: 'access-m', refresh: 'refresh-m', scope: null }))
    await h.core.alarm()
    expect(h.tokens.calls).toEqual([{ kind: 'migrate', shop: SHOP, token: 'legacy-1' }])
    expect(h.store.record).toMatchObject({
      source: 'migrate',
      scope: 's',
      expires: h.clock.now() + HOUR,
      chainOriginExpires: h.clock.now() + HOUR,
    })
    expect(h.stored()).toMatchObject({ token: 'access-m', refresh: 'refresh-m' })
    expect(h.legacyKv!.data.size).toBe(0)
  })

  it('deletes the legacy KV keys as soon as a migration outside the alarm succeeds', async () => {
    const h = createHarness({ legacy: true })
    await h.seedLegacy({ needsReauth: { since: h.clock.now(), reason: 'legacy_rejected', credFp: 'old-cred' } })
    h.legacyKv!.setJson(`offline_${SHOP}`, [['accessToken', 'legacy-1']])
    h.legacyKv!.setJson(`shop:${SHOP}`, [`offline_${SHOP}`])
    h.tokens.onMigrate(success(h.clock, { access: 'access-m', refresh: 'refresh-m' }))
    // The credential-fix retry runs from getSession, so no alarm tail cleans up after it.
    expect(await h.get()).toMatchObject({ status: 'ok', session: { accessToken: 'access-m' } })
    expect(h.legacyKv!.data.size).toBe(0)
  })

  it('dates a replayed migration from now: Shopify extends its access token', async () => {
    const h = createHarness({ migrateLegacy: true })
    await h.seedLegacy({ pairObtainedAt: h.clock.now() - 10 * MIN })
    h.tokens.onMigrate(failure(h.clock, 'transient', { code: 'timeout', ambiguous: true, status: undefined }))
    await h.core.alarm()
    // Hours of 5xx later, the replay returns the pair.
    h.clock.advance(2 * HOUR)
    h.tokens.onMigrate(success(h.clock, { access: 'access-m', refresh: 'refresh-m', expiresIn: 3600 }))
    await h.core.alarm()
    expect(h.store.record).toMatchObject({ expires: h.clock.now() + HOUR, chainOriginExpires: h.clock.now() + HOUR })
    // Served without another refresh.
    expect(await h.get()).toMatchObject({ status: 'ok', session: { accessToken: 'access-m' } })
  })

  it('treats a migration without a refresh token as ambiguous and stops serving the legacy token', async () => {
    const h = createHarness({ migrateLegacy: true })
    const seeded = await h.seedLegacy({ pairObtainedAt: h.clock.now() - HOUR })
    h.tokens.onMigrate(success(h.clock, { access: 'access-m', refresh: null }))
    await h.core.alarm()
    expect(h.store.record).toEqual({
      ...seeded,
      attemptSince: h.clock.now(),
      failures: expect.objectContaining({
        kind: 'transient',
        code: 'missing_refresh_token',
        ambiguousSince: h.clock.now(),
      }),
    })
    expect(await h.get()).toMatchObject({ status: 'tokenless', reason: 'legacy_unusable' })
  })

  it('quarantines a rejected legacy token, deletes its KV copy and only logs it', async () => {
    const h = createHarness({ migrateLegacy: true, legacy: true })
    await h.seedLegacy({ pairObtainedAt: h.clock.now() - HOUR })
    h.legacyKv!.setJson(`offline_${SHOP}`, [['accessToken', 'legacy-1']])
    h.legacyKv!.setJson(`shop:${SHOP}`, [`offline_${SHOP}`])
    h.tokens.onMigrate(failure(h.clock, 'terminal', { code: 'invalid_subject_token', status: 400 }))
    await h.core.alarm()
    expect(h.legacyKv!.data.size).toBe(0)
    expect(h.store.record?.needsReauth).toEqual({ since: h.clock.now(), reason: 'legacy_rejected', credFp: CRED_FP })
    expect(h.reports).toEqual([])
    expect(h.logs.some((line) => line.includes('invalid_subject_token'))).toBe(true)
    expect(await h.get()).toMatchObject({ status: 'needs_reauth', reason: 'legacy_rejected' })
  })
})

describe('the pre-call marker (attemptSince)', () => {
  const RESET = new Error('Durable Object reset because its code was updated')

  it('is written before the call is sent, without moving version', async () => {
    const h = createHarness({ callerWaitMs: 2_000 })
    const seeded = await due(h)
    const d = h.tokens.deferRefresh()
    const pending = h.get()
    await h.tokens.waitForCalls(1)
    expect(h.store.record).toEqual({ ...seeded, attemptSince: h.clock.now() })
    expect(await h.core.describe({ shop: SHOP })).toMatchObject({ attemptPending: true })
    // The call's own result still applies (the marker didn't move version) and clears it.
    d.resolve(success(h.clock, { access: 'access-2' }))
    expect(await pending).toMatchObject({ status: 'ok', session: { accessToken: 'access-2' } })
    expect(h.store.record).not.toHaveProperty('attemptSince')
  })

  it('keeps a replaced instance from sending at all: its marker write fails', async () => {
    const h = createHarness()
    await due(h)
    h.store.failPut = RESET
    expect(await h.get()).toMatchObject({ status: 'ok', session: { accessToken: 'access-1' } })
    await h.drain()
    expect(h.tokens.calls).toEqual([])
  })

  it('goes with the outcome of a call Shopify certainly did not process', async () => {
    for (const [kind, fields] of [
      ['transient', { code: 'http_429', status: 429 }],
      ['configuration', {}],
      ['terminal', {}],
    ] as const) {
      const h = createHarness()
      await due(h)
      h.tokens.onRefresh(failure(h.clock, kind, fields))
      await h.get()
      expect(h.store.record).not.toHaveProperty('attemptSince')
    }
  })

  it('stays after an ambiguous outcome, and a success clears it', async () => {
    const h = createHarness()
    await due(h)
    const sentAt = h.clock.now()
    h.tokens.onRefresh(failure(h.clock, 'transient', { code: 'timeout', ambiguous: true, status: undefined }))
    await h.get()
    expect(h.store.record?.attemptSince).toBe(sentAt)
    h.clock.advance(MIN)
    h.tokens.onRefresh(success(h.clock, { access: 'access-2' }))
    await h.get()
    expect(h.store.record).not.toHaveProperty('attemptSince')
    expect(h.store.record?.expires).toBe(sentAt + HOUR)
  })

  it('keeps one left by an earlier lost call through later definite failures', async () => {
    const h = createHarness({ migrateLegacy: false })
    const lostAt = h.clock.now() - 10 * MIN
    await h.seedLegacy({ pairObtainedAt: h.clock.now() - DAY, attemptSince: lostAt })
    h.tokens.onMigrate(failure(h.clock, 'shop_unavailable', { code: 'http_423', status: 423 }))
    // Finishing it is recovery: the alarm migrates although the switch is off.
    await h.core.alarm()
    expect(h.store.record?.attemptSince).toBe(lostAt)
    expect(await h.get()).toEqual({ status: 'tokenless', reason: 'legacy_unusable' })
    h.clock.advance(6 * HOUR)
    h.tokens.onMigrate(success(h.clock, { access: 'access-m', refresh: 'refresh-m' }))
    await h.core.alarm()
    expect(h.store.record).not.toHaveProperty('attemptSince')
    expect(h.stored().token).toBe('access-m')
  })

  it('recovers a migration whose result was lost with the instance, even with the switch off', async () => {
    const h = createHarness({ migrateLegacy: true })
    await h.seedLegacy({ pairObtainedAt: h.clock.now() - 10 * MIN })
    const d = h.tokens.deferMigrate()
    const alarm = h.core.alarm()
    await h.tokens.waitForCalls(1)
    // Shopify processes the migration (retiring the legacy token); the instance is replaced before it stores it.
    h.store.failPut = RESET
    d.resolve(success(h.clock, { access: 'access-m', refresh: 'refresh-m' }))
    await alarm
    h.store.failPut = undefined
    expect(h.stored().token).toBe('legacy-1')

    const next = new ShopSessions(h.deps, { callerWaitMs: 200 })
    expect(await next.getSession({ shop: SHOP, caller: 'library' })).toEqual({
      status: 'tokenless',
      reason: 'legacy_unusable',
    })
    h.flags.migrateLegacy = false
    h.clock.advance(MIN)
    h.tokens.onMigrate(success(h.clock, { access: 'access-m', refresh: 'refresh-m', expiresIn: 3600 }))
    await next.alarm()
    expect(await next.getSession({ shop: SHOP, caller: 'library' })).toMatchObject({
      status: 'ok',
      session: { accessToken: 'access-m', expires: h.clock.now() + HOUR },
    })
  })

  it('dates a refresh replayed after a lost result from the lost call', async () => {
    const h = createHarness()
    const lostAt = h.clock.now()
    await h.seed({ expires: lostAt + 10 * MIN })
    const d = h.tokens.deferRefresh()
    // Served as is; the background refresh is processed by Shopify but its result is lost with the instance.
    expect(await h.get()).toMatchObject({ status: 'ok', session: { accessToken: 'access-1' } })
    await h.tokens.waitForCalls(1)
    h.store.failPut = RESET
    d.resolve(success(h.clock, { access: 'access-2', refresh: 'refresh-2' }))
    await h.drain()
    h.store.failPut = undefined
    expect(h.store.record?.attemptSince).toBe(lostAt)
    // The marker write pulled the alarm in, so the call is replayed without waiting for traffic.
    expect(h.alarm.at).toBe(lostAt + MIN)
    expect(
      alarmAction(h.store.record!, { now: lostAt + MIN, credFp: CRED_FP, migrateLegacy: false, unreadable: false }),
    ).toBe('refresh')

    // Nine minutes later the next load presents refresh-1 again and gets the same pair back.
    const next = new ShopSessions(h.deps, { callerWaitMs: 200 })
    h.clock.advance(9 * MIN)
    h.tokens.onRefresh(success(h.clock, { access: 'access-2', refresh: 'refresh-2', expiresIn: 3600 }))
    expect(await next.getSession({ shop: SHOP, caller: 'library' })).toMatchObject({
      status: 'ok',
      session: { accessToken: 'access-2', expires: lostAt + HOUR },
    })
  })
})

describe('version discards', () => {
  it('discards a refresh result when an exchange is accepted during the call', async () => {
    const h = createHarness({ callerWaitMs: 2_000 })
    await due(h, { source: 'refresh', chainOriginExpires: h.clock.now() })
    const d = h.tokens.deferRefresh()
    const pending = h.get()
    await h.tokens.waitForCalls(1)
    const exchange = { shop: SHOP, accessToken: 'x-access', refreshToken: 'x-refresh', expires: h.clock.now() + HOUR }
    expect(await h.core.putSession({ shop: SHOP, session: exchange })).toEqual({ status: 'stored' })
    d.resolve(success(h.clock, { access: 'access-2', refresh: 'refresh-2' }))
    const result = await pending
    expect(result).toMatchObject({ status: 'ok', session: { accessToken: 'x-access' } })
    expect(h.stored()).toMatchObject({ token: 'x-access', refresh: 'x-refresh' })
  })

  it('discards a terminal result when an exchange is accepted during the call', async () => {
    const h = createHarness({ callerWaitMs: 2_000 })
    await due(h, { source: 'refresh', chainOriginExpires: h.clock.now() })
    const d = h.tokens.deferRefresh()
    const pending = h.get()
    await h.tokens.waitForCalls(1)
    await h.core.putSession({
      shop: SHOP,
      session: { shop: SHOP, accessToken: 'x-access', refreshToken: 'x-refresh', expires: h.clock.now() + HOUR },
    })
    d.resolve(failure(h.clock, 'terminal'))
    await pending
    expect(h.store.record?.needsReauth).toBeUndefined()
    expect(h.stored().token).toBe('x-access')
  })

  it('keeps a refresh result when only an alternate was filed during the call', async () => {
    const h = createHarness({ callerWaitMs: 2_000 })
    await due(h, { source: 'refresh', chainOriginExpires: h.clock.now() + 2 * HOUR })
    const d = h.tokens.deferRefresh()
    const pending = h.get()
    await h.tokens.waitForCalls(1)
    await h.core.putSession({
      shop: SHOP,
      session: { shop: SHOP, accessToken: 'late', refreshToken: 'late-refresh', expires: h.clock.now() + HOUR },
    })
    d.resolve(success(h.clock, { access: 'access-2', refresh: 'refresh-2' }))
    expect(await pending).toMatchObject({ status: 'ok', session: { accessToken: 'access-2' } })
  })

  it('discards a result when the shop is destroyed during the call', async () => {
    const h = createHarness({ callerWaitMs: 2_000 })
    await due(h)
    const d = h.tokens.deferRefresh()
    const pending = h.get()
    await h.tokens.waitForCalls(1)
    expect(await h.core.destroy({ shop: SHOP })).toEqual({ status: 'deleted' })
    d.resolve(success(h.clock, { access: 'access-2' }))
    expect(await pending).toEqual({ status: 'none' })
    expect(h.store.record).toBeUndefined()
    expect(h.alarm.at).toBeNull()
  })

  it('starts over when a token replacement races the decryption', async () => {
    const h = createHarness()
    await due(h, { source: 'refresh', chainOriginExpires: h.clock.now() })
    let raced = false
    h.keyring.delay = async () => {
      if (raced || h.keyring.opens.length < 2) return
      raced = true
      h.keyring.delay = undefined
      await h.core.putSession({
        shop: SHOP,
        session: { shop: SHOP, accessToken: 'x-access', refreshToken: 'x-refresh', expires: h.clock.now() + MIN },
      })
    }
    h.tokens.onRefresh(success(h.clock, { access: 'access-2' }))
    await h.get()
    expect(h.tokens.calls.map((c) => c.token)).toEqual(['x-refresh'])
    await settle()
  })
})

describe('crypto races', () => {
  it('re-probes when a token replacement lands while a putSession decrypts', async () => {
    const h = createHarness()
    await h.seed({ expires: h.clock.now() + 30 * MIN })
    h.keyring.unknownKids.add('kid-a')
    h.keyring.currentKid = 'kid-b'
    const newer = {
      shop: SHOP,
      accessToken: 'x-access-2',
      refreshToken: 'x-refresh-2',
      expires: h.clock.now() + 2 * HOUR,
    }
    const older = { shop: SHOP, accessToken: 'x-access-1', refreshToken: 'x-refresh-1', expires: h.clock.now() + HOUR }
    h.keyring.delay = async () => {
      // The first open is the older put probing the unreadable record.
      if (h.keyring.seals.length !== 3 || h.keyring.opens.length !== 0) return
      h.keyring.delay = undefined
      expect(await h.core.putSession({ shop: SHOP, session: newer })).toEqual({ status: 'stored' })
    }
    expect(await h.core.putSession({ shop: SHOP, session: older })).toEqual({ status: 'merged' })
    expect(h.stored()).toMatchObject({ token: 'x-access-2', refresh: 'x-refresh-2', alternates: ['x-refresh-1'] })
  })

  it('re-reads when a token replacement lands while getSession decrypts', async () => {
    const h = createHarness()
    await h.seed({ source: 'refresh', chainOriginExpires: h.clock.now() })
    h.keyring.delay = async () => {
      h.keyring.delay = undefined
      await h.core.putSession({
        shop: SHOP,
        session: { shop: SHOP, accessToken: 'x-access', refreshToken: 'x-refresh', expires: h.clock.now() + HOUR },
      })
    }
    expect(await h.get()).toMatchObject({ status: 'ok', session: { accessToken: 'x-access' } })
  })
})

describe('reports never carry secrets', () => {
  it('across successes, failures, quarantine and unreadable records', async () => {
    const h = createHarness({ migrateLegacy: true })
    await due(h, { alternates: ['alt-secret'] })
    // The primary is rejected and the alternate wins, with a response missing fields.
    h.tokens.onRefresh(
      failure(h.clock, 'terminal'),
      success(h.clock, { access: 'access-secret-2', refresh: null, expiresIn: null, refreshExpiresIn: null }),
    )
    await h.get()
    h.clock.advance(2 * HOUR)
    h.tokens.onRefresh(failure(h.clock, 'transient', { code: 'timeout', ambiguous: true }))
    await h.get()
    // Another exchange's refresh token is filed, then every token is rejected.
    h.store.record!.alternates = [
      { refresh: await h.sealed('alt-secret-3', 'alternate'), fp: await fingerprint('alt-secret-3') },
    ]
    h.clock.advance(HOUR)
    h.tokens.onRefresh(failure(h.clock, 'terminal'), failure(h.clock, 'terminal'))
    await h.core.alarm()
    expect(h.tokens.calls.map((c) => c.token)).toEqual([
      'refresh-1',
      'alt-secret',
      'alt-secret',
      'alt-secret',
      'alt-secret-3',
    ])
    expect(h.store.record?.needsReauth?.reason).toBe('refresh_rejected')
    h.keyring.unknownKids.add('kid-a')
    await h.get()
    await h.core.describe({ shop: SHOP })
    const everything = JSON.stringify(h.reports.map((r) => [r.message, r.context, r.name])) + h.logs.join('\n')
    expect(h.reports.length).toBeGreaterThan(2)
    for (const secret of ['access-1', 'refresh-1', 'alt-secret', 'alt-secret-3', 'access-secret-2', CRED_FP]) {
      expect(everything).not.toContain(secret)
    }
  })
})
