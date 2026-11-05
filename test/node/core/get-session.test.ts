import { describe, expect, it } from 'vitest'
import { fingerprint } from '../../../src/fingerprint.js'
import { CRED_FP, CUTOFF, DAY, HOUR, MIN, SHOP, createHarness, failure, settle, success } from './fakes.js'
import type { GetSessionResult } from '../../../src/types.js'

function token(result: GetSessionResult): string | undefined {
  return result.status === 'ok' ? result.session.accessToken : undefined
}

describe('getSession: no record', () => {
  it('answers none without legacy KV and sets no alarm', async () => {
    const h = createHarness()
    expect(await h.get()).toEqual({ status: 'none' })
    expect(h.alarm.at).toBeNull()
    expect(h.tokens.calls).toEqual([])
  })

  it('tries a legacy import first, then answers none when KV has nothing', async () => {
    const h = createHarness({ legacy: true })
    expect(await h.get()).toEqual({ status: 'none' })
    expect(h.legacyKv?.ops).toEqual([{ op: 'get', key: `offline_${SHOP}` }])
  })

  it('serves an imported legacy token on first use, without migrating inline', async () => {
    const h = createHarness({ legacy: true, migrateLegacy: true })
    h.legacyKv?.setJson(`offline_${SHOP}`, [
      ['id', `offline_${SHOP}`],
      ['shop', SHOP],
      ['state', ''],
      ['isOnline', false],
      ['scope', 'read_products'],
      ['accessToken', 'legacy-kv'],
    ])
    const result = await h.get()
    expect(result).toEqual({
      status: 'ok',
      session: { shop: SHOP, scope: 'read_products', accessToken: 'legacy-kv' },
      tokenFp: await fingerprint('legacy-kv'),
    })
    expect(h.tokens.calls).toEqual([])
    expect(h.alarm.at).toBe(h.clock.now() + 5 * MIN)
  })

  it('answers tokenless (import_failed) when the legacy KV read fails, reporting once', async () => {
    const h = createHarness({ legacy: true })
    for (let i = 0; i < 2; i++) {
      h.legacyKv!.failNext = { op: 'get', error: new Error('KV GET failed: 503') }
      expect(await h.get()).toEqual({ status: 'tokenless', reason: 'import_failed' })
    }
    expect(h.reports.map((r) => r.context)).toEqual([{ shop: SHOP, op: 'import', kind: 'error', code: 'Error' }])
    expect(h.store.record).toBeUndefined()
    // Once KV answers again, the shop is imported as usual.
    h.legacyKv!.setJson(`offline_${SHOP}`, [['accessToken', 'legacy-kv']])
    expect(await h.get()).toMatchObject({ status: 'ok', session: { accessToken: 'legacy-kv' } })
  })

  it('serves a record that appeared while the failed import ran', async () => {
    const h = createHarness({ legacy: true })
    h.legacyKv!.get = async () => {
      await h.core.putSession({
        shop: SHOP,
        session: { shop: SHOP, accessToken: 'x-access', refreshToken: 'x-refresh', expires: h.clock.now() + HOUR },
      })
      throw new Error('KV GET failed: 503')
    }
    expect(await h.get()).toMatchObject({ status: 'ok', session: { accessToken: 'x-access' } })
  })
})

describe('getSession: unreadable record', () => {
  it('answers tokenless, keeps the record, reports once, and re-checks in 6 h', async () => {
    const h = createHarness()
    const seeded = await h.seed({ scope: 'read_orders' })
    h.keyring.unknownKids.add('kid-a')
    const first = await h.get()
    expect(first).toEqual({ status: 'tokenless', reason: 'unreadable', scope: 'read_orders', expires: seeded.expires })
    await h.get()
    expect(h.reports.filter((r) => r.context.op === 'unreadable')).toHaveLength(1)
    expect(h.store.record).toEqual(seeded)
    expect(h.alarm.at).toBe(h.clock.now() + 6 * HOUR)
    expect(h.tokens.calls).toEqual([])
  })

  it('counts an unreadable refresh token as unreadable even when the access token opens', async () => {
    const h = createHarness()
    await h.seed()
    const record = h.store.record!
    record.refresh = { ...record.refresh!, kid: 'kid-old' }
    h.keyring.unknownKids.add('kid-old')
    expect(await h.get()).toMatchObject({ status: 'tokenless', reason: 'unreadable' })
  })
})

describe('getSession: quarantine', () => {
  it('answers needs_reauth without calling Shopify when the credentials are unchanged', async () => {
    const h = createHarness()
    await h.seed({ needsReauth: { since: h.clock.now() - DAY, reason: 'refresh_rejected', credFp: CRED_FP } })
    expect(await h.get()).toEqual({ status: 'needs_reauth', since: h.clock.now() - DAY, reason: 'refresh_rejected' })
    expect(h.tokens.calls).toEqual([])
  })

  it('retries the quarantined chain once after the credentials changed, and serves on success', async () => {
    const h = createHarness()
    await h.seed({
      expires: h.clock.now() - HOUR,
      needsReauth: { since: h.clock.now() - DAY, reason: 'refresh_rejected', credFp: 'old-cred' },
    })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2', refresh: 'refresh-2' }))
    const result = await h.get()
    expect(token(result)).toBe('access-2')
    expect(h.tokens.calls).toEqual([{ kind: 'refresh', shop: SHOP, token: 'refresh-1' }])
    expect(h.store.record?.needsReauth).toBeUndefined()
  })

  it('stays quarantined, now under the new credentials, when the retry is rejected too', async () => {
    const h = createHarness()
    const since = h.clock.now() - DAY
    await h.seed({ needsReauth: { since, reason: 'refresh_rejected', credFp: 'old-cred' } })
    h.tokens.onRefresh(failure(h.clock, 'terminal'))
    expect(await h.get()).toEqual({ status: 'needs_reauth', since, reason: 'refresh_rejected' })
    expect(h.store.record?.needsReauth).toEqual({ since, reason: 'refresh_rejected', credFp: CRED_FP })
    expect(await h.get()).toMatchObject({ status: 'needs_reauth' })
    expect(h.tokens.calls).toHaveLength(1)
  })

  it('retries a rejected legacy token with a migration', async () => {
    const h = createHarness()
    await h.seedLegacy({ needsReauth: { since: h.clock.now(), reason: 'legacy_rejected', credFp: 'old-cred' } })
    h.tokens.onMigrate(success(h.clock, { access: 'access-m', refresh: 'refresh-m' }))
    expect(token(await h.get())).toBe('access-m')
    expect(h.tokens.calls).toEqual([{ kind: 'migrate', shop: SHOP, token: 'legacy-1' }])
    expect(h.store.record?.source).toBe('migrate')
  })
})

describe('getSession: legacy token', () => {
  it('serves it without expires and never migrates inline', async () => {
    const h = createHarness({ migrateLegacy: true })
    await h.seedLegacy({ scope: 's' })
    expect(await h.get()).toEqual({
      status: 'ok',
      session: { shop: SHOP, scope: 's', accessToken: 'legacy-1' },
      tokenFp: await fingerprint('legacy-1'),
    })
    expect(h.tokens.calls).toEqual([])
  })

  it('stops serving it at the cutoff, after a 401 and after an ambiguous migration', async () => {
    const h = createHarness()
    await h.seedLegacy()
    h.clock.t = CUTOFF
    expect(await h.get()).toEqual({ status: 'tokenless', reason: 'legacy_unusable' })

    const invalid = createHarness()
    await invalid.seedLegacy({ tokenInvalid: true })
    expect(await invalid.get()).toMatchObject({ status: 'tokenless', reason: 'legacy_unusable' })

    const ambiguous = createHarness()
    await ambiguous.seedLegacy({
      failures: {
        count: 1,
        kind: 'transient',
        code: 'timeout',
        since: 0,
        retryAt: ambiguous.clock.now() + MIN,
        ambiguousSince: ambiguous.clock.now() - MIN,
        credFp: CRED_FP,
      },
    })
    expect(await ambiguous.get()).toMatchObject({ status: 'tokenless', reason: 'legacy_unusable' })
  })
})

describe('getSession: legacy token with a migration outstanding', () => {
  it('joins a migration in flight and serves its result', async () => {
    const h = createHarness({ migrateLegacy: true, callerWaitMs: 2_000 })
    await h.seedLegacy({ pairObtainedAt: h.clock.now() - HOUR })
    const d = h.tokens.deferMigrate()
    const alarm = h.core.alarm()
    await h.tokens.waitForCalls(1)
    const waiting = h.get()
    await settle()
    d.resolve(success(h.clock, { access: 'access-m', refresh: 'refresh-m' }))
    expect(token(await waiting)).toBe('access-m')
    await alarm
    expect(h.tokens.calls).toHaveLength(1)
  })

  it('answers tokenless, not the legacy token, when the migration outlasts the wait', async () => {
    const h = createHarness({ migrateLegacy: true, callerWaitMs: 20 })
    await h.seedLegacy({ pairObtainedAt: h.clock.now() - HOUR })
    const d = h.tokens.deferMigrate()
    const alarm = h.core.alarm()
    await h.tokens.waitForCalls(1)
    expect(await h.get()).toEqual({ status: 'tokenless', reason: 'legacy_unusable' })
    d.resolve(success(h.clock, { access: 'access-m', refresh: 'refresh-m' }))
    await alarm
    expect(token(await h.get())).toBe('access-m')
  })

  it('stops serving it after a migration whose outcome was lost, until the replay lands', async () => {
    const h = createHarness({ migrateLegacy: true })
    await h.seedLegacy({ attemptSince: h.clock.now() - 2 * MIN })
    expect(await h.get()).toEqual({ status: 'tokenless', reason: 'legacy_unusable' })
    expect(h.tokens.calls).toEqual([])
  })
})

describe('getSession: expiring token without a refresh token', () => {
  it('serves while above the requested validity, then answers needs_reauth', async () => {
    const h = createHarness()
    await h.seed({ refresh: null, expires: h.clock.now() + 20 * MIN })
    expect(token(await h.get())).toBe('access-1')
    expect(await h.get(30 * MIN)).toEqual({ status: 'needs_reauth', since: h.clock.now(), reason: 'no_refresh_token' })
    h.clock.advance(HOUR)
    expect(await h.get()).toEqual({
      status: 'needs_reauth',
      since: h.clock.now() - 40 * MIN,
      reason: 'no_refresh_token',
    })
    expect(h.tokens.calls).toEqual([])
  })
})

describe('getSession: expiring token with a refresh token', () => {
  it('serves a healthy token and self-heals the keepalive alarm', async () => {
    const h = createHarness()
    await h.seed({ scope: 's' })
    const result = await h.get()
    expect(result).toEqual({
      status: 'ok',
      session: { shop: SHOP, scope: 's', accessToken: 'access-1', expires: h.clock.now() + HOUR },
      tokenFp: await fingerprint('access-1'),
    })
    expect(h.alarm.at).toBe(h.clock.now() + 30 * DAY)
    h.alarm.at = h.clock.now() + 5 * DAY
    await h.get()
    expect(h.alarm.at).toBe(h.clock.now() + 5 * DAY)
  })

  it('refreshes inline below the floor and serves the new token', async () => {
    const h = createHarness()
    await h.seed({ expires: h.clock.now() + 5 * MIN })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2', refresh: 'refresh-2' }))
    const result = await h.get()
    expect(result).toMatchObject({ status: 'ok', session: { accessToken: 'access-2', expires: h.clock.now() + HOUR } })
    expect(result.status === 'ok' && result.tokenFp).toBe(await fingerprint('access-2'))
    expect(h.stored().refresh).toBe('refresh-2')
  })

  it('honours a larger minValidityMs', async () => {
    const h = createHarness()
    await h.seed({ expires: h.clock.now() + 15 * MIN })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2' }))
    expect(token(await h.get(20 * MIN, 'app'))).toBe('access-2')
  })

  it('falls back to the current token when the refresh fails and it has more than 30 s left', async () => {
    const h = createHarness()
    await h.seed({ expires: h.clock.now() + 2 * MIN })
    h.tokens.onRefresh(failure(h.clock, 'transient'))
    expect(token(await h.get())).toBe('access-1')
    expect(h.store.record?.failures).toMatchObject({ count: 1, kind: 'transient', code: 'http_503' })
  })

  it('answers tokenless with retryAfterMs when the refresh fails and the token is nearly gone', async () => {
    const h = createHarness()
    await h.seed({ expires: h.clock.now() + 20_000, scope: 's' })
    h.tokens.onRefresh(failure(h.clock, 'transient'))
    expect(await h.get()).toEqual({
      status: 'tokenless',
      reason: 'token_endpoint',
      scope: 's',
      expires: h.clock.now() + 20_000,
      retryAfterMs: 10_000,
    })
  })

  it('never serves a token reported invalid', async () => {
    const h = createHarness()
    await h.seed({ tokenInvalid: true })
    h.tokens.onRefresh(failure(h.clock, 'transient'))
    expect(await h.get()).toMatchObject({ status: 'tokenless', reason: 'token_endpoint' })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2' }))
    h.clock.advance(MIN)
    expect(token(await h.get())).toBe('access-2')
    expect(h.store.record?.tokenInvalid).toBeUndefined()
  })

  it('refreshes an imported record that has no access token', async () => {
    const h = createHarness()
    await h.seed({ token: null, tokenInvalid: true, source: 'import', expires: h.clock.now() - HOUR })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2' }))
    expect(token(await h.get())).toBe('access-2')
  })

  it('answers needs_reauth when the refresh is rejected', async () => {
    const h = createHarness()
    await h.seed({ expires: h.clock.now() + MIN })
    h.tokens.onRefresh(failure(h.clock, 'terminal'))
    expect(await h.get()).toEqual({ status: 'needs_reauth', since: h.clock.now(), reason: 'refresh_rejected' })
  })
})

describe('getSession: background soft refresh', () => {
  it('answers with the current token and refreshes under waitUntil', async () => {
    const h = createHarness()
    await h.seed({ expires: h.clock.now() + 10 * MIN })
    const d = h.tokens.deferRefresh()
    expect(token(await h.get())).toBe('access-1')
    expect(h.waits).toHaveLength(1)
    await h.tokens.waitForCalls(1)
    // A second caller in the window neither waits nor starts another call.
    expect(token(await h.get())).toBe('access-1')
    expect(h.tokens.calls).toHaveLength(1)
    d.resolve(success(h.clock, { access: 'access-2', refresh: 'refresh-2' }))
    await h.drain()
    expect(h.stored()).toMatchObject({ token: 'access-2', refresh: 'refresh-2' })
    expect(token(await h.get())).toBe('access-2')
  })

  it('does not start one in cooldown', async () => {
    const h = createHarness()
    await h.seed({
      expires: h.clock.now() + 10 * MIN,
      failures: { count: 1, kind: 'transient', code: 'x', since: 0, retryAt: h.clock.now() + MIN, credFp: CRED_FP },
    })
    expect(token(await h.get())).toBe('access-1')
    expect(h.tokens.calls).toEqual([])
  })
})

describe('getSession: cooldown', () => {
  const failures = (retryAt: number, credFp = CRED_FP) => ({
    count: 2,
    kind: 'transient' as const,
    code: 'http_503',
    since: 0,
    retryAt,
    credFp,
  })

  it('blocks request-initiated calls and answers with retryAfterMs', async () => {
    const h = createHarness()
    await h.seed({ expires: h.clock.now() + 10_000, failures: failures(h.clock.now() + 90_000) })
    expect(await h.get()).toMatchObject({ status: 'tokenless', reason: 'token_endpoint', retryAfterMs: 90_000 })
    await h.seed({ expires: h.clock.now() + 3 * MIN, failures: failures(h.clock.now() + 90_000) })
    expect(token(await h.get())).toBe('access-1')
    expect(h.tokens.calls).toEqual([])
  })

  it('is ignored when the credentials changed', async () => {
    const h = createHarness()
    await h.seed({ expires: h.clock.now() + 10_000, failures: failures(h.clock.now() + HOUR, 'old-cred') })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2' }))
    expect(token(await h.get())).toBe('access-2')
  })

  it('still lets a caller join a call already in flight', async () => {
    const h = createHarness({ callerWaitMs: 2_000 })
    await h.seed({ expires: h.clock.now() + 10 * MIN })
    const d = h.tokens.deferRefresh()
    await h.get() // starts the background refresh
    // The record now shows a cooldown (e.g. from another failure), but the in-flight call may be joined.
    h.store.record!.failures = failures(h.clock.now() + HOUR)
    h.store.record!.expires = h.clock.now() + MIN
    const waiting = h.get()
    await settle()
    d.resolve(success(h.clock, { access: 'access-2' }))
    expect(token(await waiting)).toBe('access-2')
    expect(h.tokens.calls).toHaveLength(1)
  })
})

describe('getSession: caller wait', () => {
  it('answers with the current token when the call outlasts the wait, and lands it later', async () => {
    const h = createHarness({ callerWaitMs: 20 })
    await h.seed({ expires: h.clock.now() + 2 * MIN })
    const d = h.tokens.deferRefresh()
    expect(token(await h.get())).toBe('access-1')
    d.resolve(success(h.clock, { access: 'access-2' }))
    await h.drain()
    expect(h.stored().token).toBe('access-2')
  })

  it('answers tokenless with a short retry when nothing usable is left', async () => {
    const h = createHarness({ callerWaitMs: 20 })
    await h.seed({ expires: h.clock.now() - MIN })
    const d = h.tokens.deferRefresh()
    expect(await h.get()).toMatchObject({ status: 'tokenless', reason: 'token_endpoint', retryAfterMs: 1_000 })
    d.resolve(failure(h.clock, 'transient'))
    await h.drain()
  })
})

describe('getSession: single flight', () => {
  it('makes one refresh for many concurrent callers', async () => {
    const h = createHarness({ callerWaitMs: 2_000 })
    await h.seed({ expires: h.clock.now() + MIN })
    const d = h.tokens.deferRefresh()
    const callers = Array.from({ length: 10 }, () => h.get())
    await h.tokens.waitForCalls(1)
    await settle()
    d.resolve(success(h.clock, { access: 'access-2', refresh: 'refresh-2' }))
    const results = await Promise.all(callers)
    expect(results.map(token)).toEqual(Array(10).fill('access-2'))
    expect(h.tokens.calls).toHaveLength(1)
    expect(h.store.puts.filter((r) => r.source === 'refresh')).toHaveLength(1)
  })

  it('keeps tokens out of reports and logs', async () => {
    const h = createHarness()
    await h.seed({ expires: h.clock.now() + MIN })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2', refresh: null, expiresIn: null }))
    await h.get()
    h.clock.advance(2 * MIN)
    h.tokens.onRefresh(failure(h.clock, 'terminal'))
    h.store.record!.expires = h.clock.now()
    await h.get()
    expect(h.reports.length).toBeGreaterThan(0)
    const everything = JSON.stringify(h.reports.map((r) => [r.message, r.context])) + h.logs.join('\n')
    for (const secret of ['access-1', 'access-2', 'refresh-1', 'refresh-2']) expect(everything).not.toContain(secret)
  })
})
