import { describe, expect, it } from 'vitest'
import {
  ALARM_BACKOFF,
  DEFAULT_EXPIRES_IN,
  DEFAULT_REFRESH_EXPIRES_IN,
  HARD_FLOOR,
  KEEPALIVE_AGE,
  MAX_MIN_VALIDITY,
  QUARANTINE_GC,
  alarmAction,
  alarmErrorDelay,
  clampMinValidity,
  decideExchange,
  decideGet,
  delay,
  describeRecord,
  dueAt,
  failureRecord,
  importedRecord,
  holdsLegacyCopy,
  isLegacy,
  keptNewerInstall,
  mergeAlternates,
  missingRefreshFailure,
  nextAlarmAt,
  parseLegacySession,
  planImport,
  successRecord,
  terminalRecord,
  tokenIntent,
} from '../../../src/core/record.js'
import type { GetContext, ScheduleOptions } from '../../../src/core/record.js'
import type { Sealed, ShopRecord } from '../../../src/types.js'

const SHOP = 'example.myshopify.com'
const NOW = Date.UTC(2026, 9, 1, 12)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const sealed = (kid = 'kid-a'): Sealed => ({ kid, iv: new Uint8Array(12), ct: new Uint8Array([1]) })
const alt = (fp: string, kid = 'kid-a') => ({ refresh: sealed(kid), fp })

function expiring(extra: Partial<ShopRecord> = {}): ShopRecord {
  return {
    v: 1,
    shop: SHOP,
    token: sealed(),
    tokenFp: 'tfp',
    expires: NOW + HOUR,
    refresh: sealed(),
    refreshFp: 'rfp',
    refreshExpires: NOW + 90 * DAY,
    source: 'exchange',
    pairObtainedAt: NOW,
    chainOriginExpires: NOW + HOUR,
    ...extra,
  }
}

function legacy(extra: Partial<ShopRecord> = {}): ShopRecord {
  return { v: 1, shop: SHOP, token: sealed(), tokenFp: 'lfp', source: 'import', pairObtainedAt: NOW, ...extra }
}

const failures = (extra: Partial<NonNullable<ShopRecord['failures']>> = {}): NonNullable<ShopRecord['failures']> => ({
  count: 1,
  kind: 'transient',
  code: 'http_503',
  since: NOW - MIN,
  retryAt: NOW + 10 * MIN,
  credFp: 'cred',
  ...extra,
})

describe('clampMinValidity', () => {
  it('defaults to the hard floor and clamps to [6 min, 40 min]', () => {
    expect(clampMinValidity(undefined)).toBe(HARD_FLOOR)
    expect(clampMinValidity(NaN)).toBe(HARD_FLOOR)
    expect(clampMinValidity(0)).toBe(6 * MIN)
    expect(clampMinValidity(10 * MIN)).toBe(10 * MIN)
    expect(clampMinValidity(2 * HOUR)).toBe(MAX_MIN_VALIDITY)
  })
})

describe('delay', () => {
  it('backs off transient interactive calls from 10 s to 2 min', () => {
    expect([1, 2, 3, 4, 5, 6, 30].map((n) => delay(n, 'transient', 'interactive'))).toEqual([
      10_000, 20_000, 40_000, 80_000, 120_000, 120_000, 120_000,
    ])
  })

  it('honours Retry-After up to 10 min on interactive calls', () => {
    expect(delay(1, 'transient', 'interactive', { retryAfterMs: 90_000 })).toBe(90_000)
    expect(delay(1, 'transient', 'interactive', { retryAfterMs: HOUR })).toBe(10 * MIN)
  })

  it('steps the alarm through 1 m, 5 m, 30 m, 2 h, 6 h', () => {
    expect([1, 2, 3, 4, 5, 6, 99].map((n) => delay(n, 'transient', 'alarm'))).toEqual([
      ...ALARM_BACKOFF,
      6 * HOUR,
      6 * HOUR,
    ])
    expect(delay(1, 'transient', 'alarm', { retryAfterMs: 3 * MIN })).toBe(3 * MIN)
  })

  it('waits 6 h on configuration and shop problems, daily after 7 days', () => {
    for (const kind of ['configuration', 'shop_unavailable'] as const) {
      for (const mode of ['interactive', 'alarm'] as const) {
        expect(delay(1, kind, mode)).toBe(6 * HOUR)
        expect(delay(9, kind, mode, { episodeMs: 6 * DAY })).toBe(6 * HOUR)
        expect(delay(9, kind, mode, { episodeMs: 7 * DAY })).toBe(DAY)
      }
    }
  })

  it('alarm error backoff starts at a minute', () => {
    expect(alarmErrorDelay(0)).toBe(MIN)
    expect(alarmErrorDelay(1)).toBe(MIN)
    expect(alarmErrorDelay(3)).toBe(30 * MIN)
    expect(alarmErrorDelay(50)).toBe(6 * HOUR)
  })
})

describe('classification', () => {
  it('tells legacy from expiring records and picks the token call', () => {
    expect(isLegacy(legacy())).toBe(true)
    expect(tokenIntent(legacy())).toBe('migrate')
    expect(tokenIntent(legacy({ token: undefined }))).toBeUndefined()
    expect(isLegacy(expiring())).toBe(false)
    expect(tokenIntent(expiring())).toBe('refresh')
    expect(tokenIntent(expiring({ refresh: undefined, refreshFp: undefined }))).toBeUndefined()
  })
})

describe('decideGet', () => {
  const ctx = (extra: Partial<GetContext> = {}): GetContext => ({
    now: NOW,
    minValidity: HARD_FLOOR,
    credFp: 'cred',
    legacyCutoff: Date.UTC(2027, 0, 1),
    unreadable: false,
    hasToken: true,
    inflight: false,
    attempted: false,
    ...extra,
  })

  it('serves a healthy token without a refresh', () => {
    expect(decideGet(expiring(), ctx())).toEqual({ kind: 'serve', background: false })
  })

  it('serves and refreshes in the background inside the soft window', () => {
    expect(decideGet(expiring({ expires: NOW + 10 * MIN }), ctx())).toEqual({ kind: 'serve', background: true })
    expect(decideGet(expiring({ expires: NOW + 10 * MIN }), ctx({ inflight: true }))).toEqual({
      kind: 'serve',
      background: false,
    })
  })

  it('calls when under the requested validity, and falls back after trying', () => {
    const record = expiring({ expires: NOW + 5 * MIN })
    expect(decideGet(record, ctx())).toEqual({ kind: 'call', intent: 'refresh', quarantined: false })
    expect(decideGet(record, ctx({ attempted: true }))).toEqual({ kind: 'serve', background: false })
    expect(decideGet(expiring({ expires: NOW + 20 * SECOND() }), ctx({ attempted: true }))).toMatchObject({
      kind: 'tokenless',
      reason: 'token_endpoint',
    })
  })

  it('respects cooldown but always lets a caller join an in-flight call', () => {
    const record = expiring({ expires: NOW + MIN, failures: failures() })
    expect(decideGet(record, ctx())).toEqual({ kind: 'serve', background: false })
    expect(decideGet(record, ctx({ inflight: true }))).toEqual({ kind: 'call', intent: 'refresh', quarantined: false })
    expect(decideGet(expiring({ expires: NOW + 10 * SECOND(), failures: failures() }), ctx())).toEqual({
      kind: 'tokenless',
      reason: 'token_endpoint',
      retryAfterMs: 10 * MIN,
    })
  })

  it('ignores backoff from other credentials', () => {
    const record = expiring({ expires: NOW + MIN, failures: failures({ credFp: 'old' }) })
    expect(decideGet(record, ctx())).toEqual({ kind: 'call', intent: 'refresh', quarantined: false })
  })

  it('treats tokenInvalid as needing a refresh and never serves it', () => {
    const record = expiring({ tokenInvalid: true })
    expect(decideGet(record, ctx())).toMatchObject({ kind: 'call' })
    expect(decideGet(record, ctx({ attempted: true }))).toMatchObject({ kind: 'tokenless', reason: 'token_endpoint' })
  })

  it('answers unreadable first', () => {
    expect(
      decideGet(
        expiring({ needsReauth: { since: 1, reason: 'refresh_rejected', credFp: 'x' } }),
        ctx({ unreadable: true }),
      ),
    ).toEqual({
      kind: 'tokenless',
      reason: 'unreadable',
    })
  })

  it('retries a quarantine once when the credentials changed', () => {
    const needsReauth = { since: NOW - DAY, reason: 'refresh_rejected' as const, credFp: 'old' }
    expect(decideGet(expiring({ needsReauth }), ctx())).toEqual({ kind: 'call', intent: 'refresh', quarantined: true })
    expect(decideGet(expiring({ needsReauth }), ctx({ attempted: true }))).toEqual({
      kind: 'needs_reauth',
      since: NOW - DAY,
      reason: 'refresh_rejected',
    })
    expect(decideGet(expiring({ needsReauth: { ...needsReauth, credFp: 'cred' } }), ctx())).toMatchObject({
      kind: 'needs_reauth',
    })
    expect(decideGet(legacy({ needsReauth: { ...needsReauth, reason: 'legacy_rejected' } }), ctx())).toEqual({
      kind: 'call',
      intent: 'migrate',
      quarantined: true,
    })
  })

  it('serves legacy tokens until the cutoff unless invalid or ambiguously migrated', () => {
    expect(decideGet(legacy(), ctx())).toEqual({ kind: 'serve', background: false })
    expect(decideGet(legacy(), ctx({ now: Date.UTC(2027, 0, 1) }))).toEqual({
      kind: 'tokenless',
      reason: 'legacy_unusable',
    })
    expect(decideGet(legacy({ tokenInvalid: true }), ctx())).toMatchObject({ reason: 'legacy_unusable' })
    expect(decideGet(legacy({ failures: failures({ ambiguousSince: NOW - MIN }) }), ctx())).toMatchObject({
      reason: 'legacy_unusable',
    })
    expect(decideGet(legacy({ failures: failures() }), ctx())).toEqual({ kind: 'serve', background: false })
  })

  it('serves an expiring token without a refresh token until the validity floor', () => {
    const record = expiring({ refresh: undefined, refreshFp: undefined, expires: NOW + 7 * MIN })
    expect(decideGet(record, ctx())).toEqual({ kind: 'serve', background: false })
    expect(decideGet(record, ctx({ minValidity: 10 * MIN }))).toEqual({
      kind: 'needs_reauth',
      since: NOW,
      reason: 'no_refresh_token',
    })
  })
})

function SECOND(): number {
  return 1_000
}

describe('decideGet: outstanding token calls on a legacy token', () => {
  const ctx = (extra: Partial<GetContext> = {}): GetContext => ({
    now: NOW,
    minValidity: HARD_FLOOR,
    credFp: 'cred',
    legacyCutoff: Date.UTC(2027, 0, 1),
    unreadable: false,
    hasToken: true,
    inflight: false,
    attempted: false,
    ...extra,
  })

  it('stops serving it while a migration whose outcome is unknown is outstanding', () => {
    expect(decideGet(legacy({ attemptSince: NOW - MIN }), ctx())).toEqual({
      kind: 'tokenless',
      reason: 'legacy_unusable',
    })
  })

  it('joins a migration in flight once, then answers from the record', () => {
    expect(decideGet(legacy(), ctx({ inflight: true }))).toEqual({
      kind: 'call',
      intent: 'migrate',
      quarantined: false,
    })
    expect(decideGet(legacy({ attemptSince: NOW }), ctx({ inflight: true, attempted: true }))).toMatchObject({
      reason: 'legacy_unusable',
    })
    // Not sent yet (no marker): the token is still live.
    expect(decideGet(legacy(), ctx({ inflight: true, attempted: true }))).toEqual({ kind: 'serve', background: false })
  })
})

describe('schedule', () => {
  const o = (extra: Partial<ScheduleOptions> = {}): ScheduleOptions => ({
    now: NOW,
    credFp: 'cred',
    migrateLegacy: false,
    unreadable: false,
    ...extra,
  })

  it('wipes quarantine after 90 days', () => {
    const record = expiring({ needsReauth: { since: NOW - DAY, reason: 'refresh_rejected', credFp: 'cred' } })
    expect(nextAlarmAt(record, o())).toBe(NOW - DAY + QUARANTINE_GC)
    expect(alarmAction(record, o())).toBe('none')
    expect(alarmAction(record, o({ now: NOW - DAY + QUARANTINE_GC }))).toBe('wipe')
  })

  it('re-checks unreadable records in 6 h without token work', () => {
    expect(nextAlarmAt(expiring({ failures: failures({ retryAt: NOW }) }), o({ unreadable: true }))).toBe(
      NOW + 6 * HOUR,
    )
    expect(alarmAction(expiring({ pairObtainedAt: NOW - 40 * DAY }), o({ unreadable: true }))).toBe('none')
  })

  it('migrates legacy records only with the switch on, unless finishing an ambiguous migration', () => {
    const record = legacy({ pairObtainedAt: NOW - HOUR })
    expect(nextAlarmAt(record, o())).toBe(NOW + DAY)
    expect(alarmAction(record, o())).toBe('none')
    expect(nextAlarmAt(record, o({ migrateLegacy: true }))).toBe(NOW + MIN)
    expect(alarmAction(record, o({ migrateLegacy: true }))).toBe('migrate')
    const fresh = legacy({ pairObtainedAt: NOW })
    expect(dueAt(fresh, o({ migrateLegacy: true }))).toBe(NOW + 5 * MIN)
    expect(alarmAction(fresh, o({ migrateLegacy: true }))).toBe('none')
    const ambiguous = legacy({
      pairObtainedAt: NOW - HOUR,
      failures: failures({ ambiguousSince: NOW - HOUR, retryAt: NOW - 1 }),
    })
    expect(alarmAction(ambiguous, o())).toBe('migrate')
    const backingOff = legacy({ pairObtainedAt: NOW - HOUR, failures: failures({ retryAt: NOW + 2 * HOUR }) })
    expect(nextAlarmAt(backingOff, o({ migrateLegacy: true }))).toBe(NOW + 2 * HOUR)
    expect(nextAlarmAt(backingOff, o({ migrateLegacy: true, credFp: 'new' }))).toBe(NOW + MIN)
    expect(alarmAction(backingOff, o({ migrateLegacy: true, credFp: 'new' }))).toBe('migrate')
  })

  it('replays a call whose outcome was never stored promptly, ignoring the switch', () => {
    const lost = legacy({ pairObtainedAt: NOW - DAY, attemptSince: NOW - 10 * MIN })
    expect(nextAlarmAt(lost, o())).toBe(NOW + MIN)
    expect(alarmAction(lost, o())).toBe('migrate')
    // ...within its backoff.
    const backingOff = legacy({ ...lost, failures: failures({ retryAt: NOW + HOUR }) })
    expect(nextAlarmAt(backingOff, o())).toBe(NOW + HOUR)
    expect(alarmAction(backingOff, o())).toBe('none')
    const refresh = expiring({ attemptSince: NOW - 10 * MIN })
    expect(nextAlarmAt(refresh, o())).toBe(NOW + MIN)
    expect(alarmAction(refresh, o())).toBe('refresh')
  })

  it('keeps expiring chains alive', () => {
    expect(nextAlarmAt(expiring(), o())).toBe(NOW + KEEPALIVE_AGE)
    expect(nextAlarmAt(expiring({ refreshExpires: NOW + 40 * DAY }), o())).toBe(NOW + 10 * DAY)
    expect(nextAlarmAt(expiring({ refreshExpires: NOW + 10 * DAY }), o())).toBe(NOW + MIN)
    expect(alarmAction(expiring({ refreshExpires: NOW + 10 * DAY }), o())).toBe('refresh')
    expect(alarmAction(expiring({ pairObtainedAt: NOW - 30 * DAY }), o())).toBe('refresh')
    expect(alarmAction(expiring(), o())).toBe('none')
  })

  it('lets a failure backoff decide the retry, even past a keepalive', () => {
    const record = expiring({ pairObtainedAt: NOW - 40 * DAY, failures: failures({ retryAt: NOW + 2 * HOUR }) })
    expect(nextAlarmAt(record, o())).toBe(NOW + 2 * HOUR)
    expect(alarmAction(record, o())).toBe('none')
    expect(alarmAction(record, o({ credFp: 'fixed' }))).toBe('refresh')
    expect(nextAlarmAt(expiring({ failures: failures({ retryAt: NOW + 10_000 }) }), o())).toBe(NOW + MIN)
  })

  it('has nothing to schedule for an expiring token without a refresh token', () => {
    expect(nextAlarmAt(expiring({ refresh: undefined, refreshFp: undefined }), o())).toBeNull()
  })
})

describe('decideExchange', () => {
  const incoming = (expires: number, refreshFp = 'new') => ({ refreshFp, expires })

  it('accepts over nothing, legacy, quarantine, unreadable, migrate and legacy_exchange', () => {
    expect(decideExchange(undefined, incoming(NOW), false)).toBe('accept')
    expect(decideExchange(legacy(), incoming(NOW), false)).toBe('accept')
    const q = { since: NOW, reason: 'refresh_rejected' as const, credFp: 'c' }
    expect(decideExchange(expiring({ needsReauth: q }), incoming(NOW - DAY), false)).toBe('accept')
    expect(decideExchange(expiring(), incoming(NOW - DAY), true)).toBe('accept')
    expect(decideExchange(expiring({ source: 'migrate' }), incoming(NOW - DAY), false)).toBe('accept')
    expect(decideExchange(legacy({ source: 'legacy_exchange' }), incoming(NOW - DAY), false)).toBe('accept')
  })

  it('detects duplicates of the stored pair and of alternates', () => {
    expect(decideExchange(expiring(), incoming(NOW + 2 * HOUR, 'rfp'), false)).toBe('duplicate')
    expect(decideExchange(expiring({ alternates: [alt('a1')] }), incoming(NOW + 2 * HOUR, 'a1'), false)).toBe(
      'duplicate_alternate',
    )
  })

  it('accepts over a refresh or import chain only from an exchange at least as new as its origin', () => {
    for (const source of ['refresh', 'import'] as const) {
      const record = expiring({ source, chainOriginExpires: NOW + HOUR })
      expect(decideExchange(record, incoming(NOW + HOUR), false)).toBe('accept')
      expect(decideExchange(record, incoming(NOW + HOUR - 1), false)).toBe('file')
    }
  })

  it("replaces a record without a refresh token, keeping an exchange record's alternates", () => {
    const ruleSix = expiring({ refresh: undefined, refreshFp: undefined, expires: NOW + 2 * HOUR })
    expect(decideExchange(ruleSix, incoming(NOW), false)).toBe('displace')
    const importedAccessOnly = expiring({
      source: 'import',
      refresh: undefined,
      refreshFp: undefined,
      chainOriginExpires: NOW + 2 * HOUR,
    })
    expect(decideExchange(importedAccessOnly, incoming(NOW), false)).toBe('accept')
  })

  it('makes the later of two exchanges current and files the other', () => {
    const record = expiring({ source: 'exchange', expires: NOW + HOUR })
    expect(decideExchange(record, incoming(NOW + HOUR + 1000), false)).toBe('displace')
    expect(decideExchange(record, incoming(NOW + HOUR), false)).toBe('file')
    expect(decideExchange(record, incoming(NOW), false)).toBe('file')
  })
})

describe('mergeAlternates', () => {
  it('orders newest first, dedupes by fingerprint, skips the current token and caps at 5', () => {
    const merged = mergeAlternates(
      [alt('n')],
      [alt('a'), alt('n'), alt('cur'), alt('b'), alt('c'), alt('d'), alt('e')],
      'cur',
    )
    expect(merged.alternates?.map((a) => a.fp)).toEqual(['n', 'a', 'b', 'c', 'd'])
    expect(merged.dropped).toBe(1)
    expect(mergeAlternates([], undefined, 'x')).toEqual({ alternates: undefined, dropped: 0 })
  })

  it('drops the oldest exchanges by expiry over the cap, keeping the order of the rest', () => {
    const dated = (fp: string, expires?: number) => ({ ...alt(fp), ...(expires === undefined ? {} : { expires }) })
    const merged = mergeAlternates(
      [dated('new', NOW + 10)],
      [
        dated('e5', NOW + 5),
        dated('e1', NOW + 1),
        dated('e9', NOW + 9),
        dated('old'),
        dated('e7', NOW + 7),
        dated('e3', NOW + 3),
      ],
      undefined,
    )
    expect(merged.alternates?.map((a) => a.fp)).toEqual(['new', 'e5', 'e9', 'e7', 'e3'])
    expect(merged.dropped).toBe(2)
  })
})

describe('outcome records', () => {
  it('builds a refreshed record from a full response', () => {
    const prev = expiring({
      scope: 'a',
      alternates: [alt('x')],
      tokenInvalid: true,
      failures: failures(),
      chainOriginExpires: 123,
    })
    const next = successRecord(
      prev,
      {
        intent: 'refresh',
        token: sealed('k2'),
        tokenFp: 't2',
        expiresIn: 3600,
        scope: 'b',
        refresh: sealed('k2'),
        refreshFp: 'r2',
        refreshExpiresIn: 86400,
      },
      NOW,
    )
    expect(next).toMatchObject({
      expires: NOW + HOUR,
      refreshExpires: NOW + DAY,
      scope: 'b',
      source: 'refresh',
      pairObtainedAt: NOW,
      chainOriginExpires: 123,
      tokenFp: 't2',
      refreshFp: 'r2',
    })
    expect(next).not.toHaveProperty('alternates')
    expect(next).not.toHaveProperty('tokenInvalid')
    expect(next).not.toHaveProperty('failures')
    expect(next).not.toHaveProperty('needsReauth')
  })

  it('defaults missing lifetimes, keeps scope, and dates a refresh (not a migration) from the earliest attempt', () => {
    const prev = expiring({ scope: 'keep', failures: failures({ ambiguousSince: NOW - 20 * MIN }) })
    const next = successRecord(
      prev,
      { intent: 'migrate', token: sealed(), tokenFp: 't', refresh: sealed(), refreshFp: 'r', scope: '' },
      NOW,
    )
    // Shopify extends a replayed migration's access token.
    expect(next.expires).toBe(NOW + DEFAULT_EXPIRES_IN)
    expect(next.refreshExpires).toBe(NOW + DEFAULT_REFRESH_EXPIRES_IN)
    expect(next.scope).toBe('keep')
    expect(next.source).toBe('migrate')
    expect(next.chainOriginExpires).toBe(next.expires)
    const withLifetime = successRecord(
      prev,
      {
        intent: 'refresh',
        token: sealed(),
        tokenFp: 't',
        expiresIn: 3600,
        refresh: sealed(),
        refreshFp: 'r',
        keptRefreshExpires: 42,
      },
      NOW,
    )
    expect(withLifetime.expires).toBe(NOW - 20 * MIN + HOUR)
    expect(withLifetime.refreshExpires).toBe(42)
    // A call whose outcome was lost counts as an attempt too, whichever is earlier.
    const refresh = {
      intent: 'refresh' as const,
      token: sealed(),
      tokenFp: 't',
      expiresIn: 3600,
      refresh: sealed(),
      refreshFp: 'r',
    }
    expect(successRecord(expiring({ attemptSince: NOW - 30 * MIN }), refresh, NOW).expires).toBe(NOW + 30 * MIN)
    expect(successRecord({ ...prev, attemptSince: NOW - 5 * MIN }, refresh, NOW).expires).toBe(NOW + 40 * MIN)
    expect(
      successRecord(expiring({ attemptSince: NOW - 30 * MIN }), { ...refresh, intent: 'migrate' }, NOW),
    ).not.toHaveProperty('attemptSince')
  })

  it('counts failures per episode, reports kind:code transitions, and keeps ambiguousSince', () => {
    const first = failureRecord(
      expiring(),
      { kind: 'transient', code: 'timeout', ambiguousSince: NOW - 5 },
      NOW,
      'interactive',
      'cred',
    )
    expect(first.report).toBe(true)
    expect(first.record.failures).toEqual({
      count: 1,
      kind: 'transient',
      code: 'timeout',
      since: NOW,
      retryAt: NOW + 10_000,
      ambiguousSince: NOW - 5,
      credFp: 'cred',
      reported: 'transient:timeout',
    })
    const second = failureRecord(
      first.record,
      { kind: 'transient', code: 'timeout', ambiguousSince: NOW + 50 },
      NOW + 100,
      'alarm',
      'cred',
    )
    expect(second.report).toBe(false)
    expect(second.record.failures).toMatchObject({
      count: 2,
      since: NOW,
      retryAt: NOW + 100 + 5 * MIN,
      ambiguousSince: NOW - 5,
    })
    const third = failureRecord(
      second.record,
      { kind: 'configuration', code: 'invalid_client' },
      NOW + 200,
      'alarm',
      'cred',
    )
    expect(third.report).toBe(true)
    expect(third.record.failures).toMatchObject({ count: 3, retryAt: NOW + 200 + 6 * HOUR })
    const fixed = failureRecord(
      third.record,
      { kind: 'transient', code: 'http_503' },
      NOW + 300,
      'interactive',
      'cred-2',
    )
    expect(fixed.record.failures).toMatchObject({
      count: 1,
      since: NOW + 300,
      credFp: 'cred-2',
      ambiguousSince: NOW - 5,
    })
  })

  it('dates the missing-refresh-token retry from an earlier lost call too', () => {
    const next = missingRefreshFailure(expiring(), undefined, NOW - 7, NOW, 'cred', NOW - 20 * MIN)
    expect(next.failures?.ambiguousSince).toBe(NOW - 20 * MIN)
    expect(missingRefreshFailure(expiring(), undefined, NOW - 7, NOW, 'cred', NOW).failures?.ambiguousSince).toBe(
      NOW - 7,
    )
  })

  it('builds the missing-refresh-token retry', () => {
    const next = missingRefreshFailure(expiring(), undefined, NOW - 7, NOW, 'cred')
    expect(next.failures).toEqual({
      count: 1,
      kind: 'transient',
      code: 'missing_refresh_token',
      since: NOW,
      retryAt: NOW + MIN,
      ambiguousSince: NOW - 7,
      credFp: 'cred',
      reported: 'transient:missing_refresh_token',
    })
    const again = missingRefreshFailure(expiring(), next.failures, NOW + 10, NOW + 20, 'cred')
    expect(again.failures).toMatchObject({ count: 2, since: NOW, retryAt: NOW + 20 + 5 * MIN, ambiguousSince: NOW - 7 })
  })

  it('quarantines with the current credentials, keeping sealed fields and the first since', () => {
    const prev = expiring({ alternates: [alt('a')], failures: failures() })
    const next = terminalRecord(prev, 'refresh', NOW, 'cred')
    expect(next.needsReauth).toEqual({ since: NOW, reason: 'refresh_rejected', credFp: 'cred' })
    expect(next.token).toBe(prev.token)
    expect(next.refresh).toBe(prev.refresh)
    expect(next.alternates).toBe(prev.alternates)
    expect(next).not.toHaveProperty('failures')
    const again = terminalRecord(next, 'refresh', NOW + DAY, 'cred-2')
    expect(again.needsReauth).toEqual({ since: NOW, reason: 'refresh_rejected', credFp: 'cred-2' })
    expect(terminalRecord(legacy(), 'migrate', NOW, 'c').needsReauth?.reason).toBe('legacy_rejected')
  })
})

describe('legacy sessions', () => {
  it('parses property arrays with any key case', () => {
    const parsed = parseLegacySession(
      [
        ['id', 'offline_example.myshopify.com'],
        ['SHOP', 'Example.myshopify.com'],
        ['state', ''],
        ['isOnline', false],
        ['scope', 'read_products'],
        ['ACCESSTOKEN', 'tok'],
        ['expires', 1000],
        ['refreshToken', 'ref'],
        ['refreshtokenexpires', '2000'],
        ['ignored', null],
      ],
      SHOP,
    )
    expect(parsed).toEqual({
      kind: 'session',
      session: {
        accessToken: 'tok',
        expires: 1000,
        refreshToken: 'ref',
        refreshTokenExpires: 2000,
        scope: 'read_products',
      },
    })
  })

  it('rejects values it cannot trust', () => {
    expect(parseLegacySession(null, SHOP)).toEqual({ kind: 'absent' })
    expect(parseLegacySession({ accessToken: 'x' }, SHOP)).toEqual({ kind: 'invalid', code: 'not_array' })
    expect(parseLegacySession([['accessToken']], SHOP)).toEqual({ kind: 'invalid', code: 'bad_entry' })
    expect(parseLegacySession([[1, 'x']], SHOP)).toEqual({ kind: 'invalid', code: 'bad_entry' })
    expect(parseLegacySession([['shop', 'other.myshopify.com']], SHOP)).toEqual({
      kind: 'invalid',
      code: 'shop_mismatch',
    })
    expect(parseLegacySession([['isOnline', 'TRUE']], SHOP)).toEqual({ kind: 'invalid', code: 'online' })
    expect(parseLegacySession([['accessToken', 5]], SHOP)).toEqual({ kind: 'invalid', code: 'bad_token' })
    expect(parseLegacySession([['expires', 'soon']], SHOP)).toEqual({ kind: 'invalid', code: 'bad_expires' })
  })

  it('plans each kind of import', () => {
    expect(planImport({ accessToken: 'a' }, NOW)).toEqual({ kind: 'legacy' })
    expect(planImport({ accessToken: 'a', expires: NOW + HOUR, refreshToken: 'r' }, NOW)).toEqual({
      kind: 'expiring',
      token: true,
      refresh: true,
      expires: NOW + HOUR,
    })
    expect(planImport({ refreshToken: 'r', expires: NOW - HOUR, refreshTokenExpires: NOW + DAY }, NOW)).toEqual({
      kind: 'expiring',
      token: false,
      refresh: true,
      expires: NOW - HOUR,
    })
    // An access token with a refresh token but no expiry is an expiring pair due for a refresh, not a legacy token.
    expect(planImport({ accessToken: 'a', refreshToken: 'r', refreshTokenExpires: NOW + DAY }, NOW)).toEqual({
      kind: 'expiring',
      token: true,
      refresh: true,
      expires: NOW,
    })
    expect(planImport({ refreshToken: 'r', refreshTokenExpires: NOW - 1 }, NOW)).toEqual({ kind: 'unusable' })
    expect(planImport({ accessToken: 'a', expires: NOW - 1 }, NOW)).toEqual({ kind: 'unusable' })
    expect(planImport({}, NOW)).toEqual({ kind: 'unusable' })
  })

  it('builds imported records', () => {
    const s = sealed()
    expect(
      importedRecord(SHOP, { kind: 'legacy' }, { accessToken: 'a', scope: 'x' }, { token: s, tokenFp: 'f' }, NOW),
    ).toEqual({
      v: 1,
      shop: SHOP,
      scope: 'x',
      token: s,
      tokenFp: 'f',
      source: 'import',
      pairObtainedAt: NOW,
    })
    const blank = importedRecord(
      SHOP,
      { kind: 'expiring', token: false, refresh: true, expires: NOW - HOUR },
      { refreshToken: 'r' },
      { refresh: s, refreshFp: 'rf' },
      NOW,
    )
    expect(blank).toEqual({
      v: 1,
      shop: SHOP,
      expires: NOW - HOUR,
      refresh: s,
      refreshFp: 'rf',
      refreshExpires: NOW + DEFAULT_REFRESH_EXPIRES_IN,
      source: 'import',
      pairObtainedAt: NOW,
      chainOriginExpires: NOW - HOUR,
      tokenInvalid: true,
    })
  })
})

describe('describeRecord', () => {
  it('reports state without secrets', () => {
    expect(describeRecord(SHOP, undefined, null, false)).toEqual({
      shop: SHOP,
      exists: false,
      state: 'none',
      nextAlarmAt: null,
    })
    const status = describeRecord(
      SHOP,
      expiring({ alternates: [alt('a', 'kid-b')], failures: failures({ ambiguousSince: 1 }), scope: 's' }),
      NOW + DAY,
      false,
    )
    expect(status).toEqual({
      shop: SHOP,
      exists: true,
      state: 'failing',
      source: 'exchange',
      scope: 's',
      accessTokenExpiresAt: NOW + HOUR,
      refreshTokenExpiresAt: NOW + 90 * DAY,
      pairObtainedAt: NOW,
      alternates: 1,
      kids: ['kid-a', 'kid-b'],
      failures: {
        count: 1,
        kind: 'transient',
        code: 'http_503',
        since: NOW - MIN,
        retryAt: NOW + 10 * MIN,
        ambiguous: true,
      },
      nextAlarmAt: NOW + DAY,
    })
    expect(JSON.stringify(status)).not.toContain('credFp')
    expect(describeRecord(SHOP, legacy(), null, false).state).toBe('legacy')
    expect(describeRecord(SHOP, expiring(), null, true).state).toBe('unreadable')
    expect(
      describeRecord(
        SHOP,
        expiring({ needsReauth: { since: 1, reason: 'refresh_rejected', credFp: 'c' } }),
        null,
        false,
      ),
    ).toMatchObject({ state: 'needs_reauth', needsReauth: { since: 1, reason: 'refresh_rejected' } })
    expect(describeRecord(SHOP, expiring(), null, false).state).toBe('ok')
  })

  it('shows an outstanding token call as a boolean, never its time', () => {
    expect(describeRecord(SHOP, legacy({ attemptSince: 12345 }), null, false)).toMatchObject({
      state: 'legacy',
      attemptPending: true,
    })
    expect(JSON.stringify(describeRecord(SHOP, legacy({ attemptSince: 12345 }), null, false))).not.toContain('12345')
    expect(describeRecord(SHOP, legacy(), null, false)).not.toHaveProperty('attemptPending')
  })
})

describe('keptNewerInstall', () => {
  it('keeps only pairs obtained more than 60 s after the uninstall', () => {
    expect(keptNewerInstall(expiring({ pairObtainedAt: NOW }), undefined)).toBe(false)
    expect(keptNewerInstall(undefined, NOW)).toBe(false)
    expect(keptNewerInstall(expiring({ pairObtainedAt: NOW + 60_000 }), NOW)).toBe(false)
    expect(keptNewerInstall(expiring({ pairObtainedAt: NOW + 60_001 }), NOW)).toBe(true)
  })

  it('never counts an import as a reinstall', () => {
    expect(keptNewerInstall(legacy({ pairObtainedAt: NOW + DAY }), NOW)).toBe(false)
    expect(keptNewerInstall(expiring({ source: 'import', pairObtainedAt: NOW + DAY }), NOW)).toBe(false)
    for (const source of ['exchange', 'legacy_exchange', 'refresh', 'migrate'] as const) {
      expect(keptNewerInstall(expiring({ source, pairObtainedAt: NOW + DAY }), NOW)).toBe(true)
    }
  })
})

describe('holdsLegacyCopy', () => {
  it('is true only for a live legacy token', () => {
    expect(holdsLegacyCopy(legacy())).toBe(true)
    expect(holdsLegacyCopy(legacy({ needsReauth: { since: NOW, reason: 'legacy_rejected', credFp: 'c' } }))).toBe(false)
    expect(holdsLegacyCopy(expiring())).toBe(false)
  })
})
