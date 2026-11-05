import { describe, expect, it } from 'vitest'
import { migrateLegacySessions } from '../../../src/backfill.js'
import { ShopSessions } from '../../../src/core/shop-sessions.js'
import { CRED_FP, DAY, HOUR, MIN, SHOP, createHarness, failure, settle, success } from './fakes.js'

const transient = (retryAt: number, extra: Record<string, unknown> = {}) => ({
  count: 1,
  kind: 'transient' as const,
  code: 'http_503',
  since: 0,
  retryAt,
  credFp: CRED_FP,
  reported: 'transient:http_503',
  ...extra,
})

describe('alarm: expiring records', () => {
  it('does nothing without a record', async () => {
    const h = createHarness()
    await h.core.alarm()
    expect(h.alarm.sets).toEqual([])
    expect(h.registry.ops).toEqual([])
  })

  it('reschedules a healthy chain for its keepalive and re-puts the registry marker', async () => {
    const h = createHarness()
    const seeded = await h.seed({ pairObtainedAt: h.clock.now() - DAY })
    await h.core.alarm()
    expect(h.tokens.calls).toEqual([])
    expect(h.alarm.at).toBe(seeded.pairObtainedAt + 30 * DAY)
    expect(h.marker()).toEqual({ value: '', metadata: { since: seeded.pairObtainedAt } })
  })

  it('refreshes when the pair is 30 days old', async () => {
    const h = createHarness()
    await h.seed({ pairObtainedAt: h.clock.now() - 30 * DAY, expires: h.clock.now() - 29 * DAY })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2', refresh: 'refresh-2' }))
    await h.core.alarm()
    expect(h.stored()).toMatchObject({ token: 'access-2', refresh: 'refresh-2' })
    expect(h.alarm.at).toBe(h.clock.now() + 30 * DAY)
  })

  it('refreshes when the refresh token has 30 days left', async () => {
    const h = createHarness()
    await h.seed({ refreshExpires: h.clock.now() + 30 * DAY })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2' }))
    await h.core.alarm()
    expect(h.tokens.calls).toHaveLength(1)
  })

  it('retries a failure when its backoff is due, backing off on the alarm schedule', async () => {
    const h = createHarness()
    await h.seed({ failures: transient(h.clock.now()) })
    h.tokens.onRefresh(failure(h.clock, 'transient'))
    await h.core.alarm()
    expect(h.store.record?.failures).toMatchObject({ count: 2, retryAt: h.clock.now() + 5 * MIN })
    expect(h.alarm.at).toBe(h.clock.now() + 5 * MIN)
    expect(h.reports).toEqual([])
  })

  it('waits out a backoff that is not due, even past a keepalive', async () => {
    const h = createHarness()
    await h.seed({ pairObtainedAt: h.clock.now() - 40 * DAY, failures: transient(h.clock.now() + HOUR) })
    await h.core.alarm()
    expect(h.tokens.calls).toEqual([])
    expect(h.alarm.at).toBe(h.clock.now() + HOUR)
  })

  it('ignores a backoff recorded under other credentials', async () => {
    const h = createHarness()
    await h.seed({ failures: transient(h.clock.now() + 6 * HOUR, { credFp: 'old-cred', kind: 'configuration' }) })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2' }))
    await h.core.alarm()
    expect(h.tokens.calls).toHaveLength(1)
    expect(h.store.record?.failures).toBeUndefined()
  })

  it('joins a refresh already in flight instead of starting another', async () => {
    const h = createHarness()
    await h.seed({ expires: h.clock.now() + 10 * MIN, pairObtainedAt: h.clock.now() - 31 * DAY })
    const d = h.tokens.deferRefresh()
    await h.get()
    const run = h.core.alarm()
    await settle()
    d.resolve(success(h.clock, { access: 'access-2' }))
    await run
    expect(h.tokens.calls).toHaveLength(1)
    expect(h.alarm.at).toBe(h.clock.now() + 30 * DAY)
  })

  it('deletes leftover legacy KV keys for non-legacy records', async () => {
    const h = createHarness({ legacy: true })
    await h.seed()
    h.legacyKv!.setJson(`offline_${SHOP}`, [['accessToken', 'legacy-1']])
    h.legacyKv!.setJson(`shop:${SHOP}`, [`offline_${SHOP}`])
    await h.core.alarm()
    expect(h.legacyKv!.data.size).toBe(0)
  })

  it('leaves no marker and no alarm when a destroy lands during its KV deletes', async () => {
    const h = createHarness({ legacy: true })
    await h.seed({ pairObtainedAt: h.clock.now() - DAY })
    await h.registry.put(`shop-session:${SHOP}`, '', { metadata: { since: 1 } })
    const realDelete = h.legacyKv!.delete.bind(h.legacyKv!)
    let raced = false
    h.legacyKv!.delete = async (key: string) => {
      await realDelete(key)
      if (raced) return
      raced = true
      // The alarm's KV await lets the uninstall webhook's deleteShop in.
      expect(await h.core.destroy({ shop: SHOP, uninstalledAt: h.clock.now() })).toEqual({ status: 'deleted' })
    }
    h.alarm.at = h.clock.now()
    await h.core.alarm()
    expect({ record: h.store.record, marker: h.marker(), alarm: h.alarm.at }).toEqual({
      record: undefined,
      marker: undefined,
      alarm: null,
    })
  })

  it('leaves no marker and no alarm when a destroy lands during its marker write', async () => {
    const h = createHarness()
    await h.seed()
    const realPut = h.registry.put.bind(h.registry)
    let raced = false
    h.registry.put = async (key: string, value: string, options?: { metadata?: unknown }) => {
      await realPut(key, value, options)
      if (raced) return
      raced = true
      expect(await h.core.destroy({ shop: SHOP })).toEqual({ status: 'deleted' })
    }
    await h.core.alarm()
    expect({ record: h.store.record, marker: h.marker(), alarm: h.alarm.at }).toEqual({
      record: undefined,
      marker: undefined,
      alarm: null,
    })
  })

  it('leaves the schedule to a token replacement that lands during its KV work', async () => {
    const h = createHarness()
    await h.seed({ pairObtainedAt: h.clock.now() - DAY })
    const realPut = h.registry.put.bind(h.registry)
    let raced = false
    h.registry.put = async (key: string, value: string, options?: { metadata?: unknown }) => {
      await realPut(key, value, options)
      if (raced) return
      raced = true
      h.clock.advance(MIN)
      await h.core.putSession({
        shop: SHOP,
        session: { shop: SHOP, accessToken: 'x-access', refreshToken: 'x-refresh', expires: h.clock.now() + 2 * HOUR },
      })
    }
    await h.core.alarm()
    expect(h.stored().token).toBe('x-access')
    // Set by the exchange (its keepalive), not overwritten from the record the alarm read before it.
    expect(h.alarm.at).toBe(h.clock.now() + 30 * DAY)
    expect(h.alarm.sets.at(-1)).toBe(h.clock.now() + 30 * DAY)
    expect(h.marker()).toBeDefined()
  })

  it('has nothing to schedule for an expiring token without a refresh token', async () => {
    const h = createHarness()
    await h.seed({ refresh: null, expires: h.clock.now() + HOUR })
    h.alarm.at = h.clock.now()
    await h.core.alarm()
    expect(h.alarm.at).toBeNull()
    expect(h.marker()).toBeDefined()
  })
})

describe('alarm: legacy records', () => {
  it('leaves them alone with migration off, re-checking the switch daily and keeping the KV copy', async () => {
    const h = createHarness({ legacy: true })
    await h.seedLegacy({ pairObtainedAt: h.clock.now() - DAY })
    h.legacyKv!.setJson(`offline_${SHOP}`, [['accessToken', 'legacy-1']])
    await h.core.alarm()
    expect(h.tokens.calls).toEqual([])
    expect(h.alarm.at).toBe(h.clock.now() + DAY)
    expect(h.legacyKv!.data.size).toBe(1)
  })

  it('migrates 5 minutes after import once the switch is on', async () => {
    const h = createHarness({ migrateLegacy: true })
    await h.seedLegacy({ pairObtainedAt: h.clock.now() - 2 * MIN })
    await h.core.alarm()
    expect(h.tokens.calls).toEqual([])
    expect(h.alarm.at).toBe(h.clock.now() + 3 * MIN)
    h.clock.advance(3 * MIN)
    h.tokens.onMigrate(success(h.clock, { access: 'access-m' }))
    await h.core.alarm()
    expect(h.tokens.calls).toEqual([{ kind: 'migrate', shop: SHOP, token: 'legacy-1' }])
    expect(h.store.record?.source).toBe('migrate')
  })

  it('finishes an ambiguous migration even with the switch off', async () => {
    const h = createHarness({ migrateLegacy: false })
    await h.seedLegacy({
      pairObtainedAt: h.clock.now() - DAY,
      failures: transient(h.clock.now(), { ambiguousSince: h.clock.now() - HOUR }),
    })
    h.tokens.onMigrate(success(h.clock, { access: 'access-m', expiresIn: 3600 }))
    await h.core.alarm()
    expect(h.tokens.calls).toHaveLength(1)
    // Shopify extends a replayed migration's access token, so it dates from now, not from the first attempt.
    expect(h.store.record).toMatchObject({
      source: 'migrate',
      expires: h.clock.now() + HOUR,
      chainOriginExpires: h.clock.now() + HOUR,
    })
  })

  it("lets a rejected migration's KV keys go at once, so the backfill can finish", async () => {
    const h = createHarness({ legacy: true, migrateLegacy: true })
    h.legacyKv!.setJson(`offline_${SHOP}`, [
      ['shop', SHOP],
      ['accessToken', 'legacy-kv'],
    ])
    h.legacyKv!.setJson(`shop:${SHOP}`, [`offline_${SHOP}`])
    expect(await h.core.importLegacy({ shop: SHOP })).toEqual({ status: 'imported' })
    h.clock.advance(5 * MIN)
    h.tokens.onMigrate(failure(h.clock, 'terminal', { code: 'invalid_subject_token', status: 400 }))
    await h.core.alarm()
    expect(h.store.record?.needsReauth?.reason).toBe('legacy_rejected')
    expect([...h.legacyKv!.data.keys()]).toEqual([])
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({ importLegacy: (input: { shop: string }) => h.core.importLegacy(input) }),
    }
    const run = await migrateLegacySessions({ kv: h.legacyKv!, namespace, report: () => {} })
    expect(run).toMatchObject({ attempted: 0, done: true })
  })

  it('deletes the KV keys of a rejected legacy token left by an earlier version', async () => {
    const h = createHarness({ legacy: true })
    await h.seedLegacy({ needsReauth: { since: h.clock.now() - DAY, reason: 'legacy_rejected', credFp: CRED_FP } })
    h.legacyKv!.setJson(`offline_${SHOP}`, [['accessToken', 'legacy-1']])
    h.legacyKv!.setJson(`shop:${SHOP}`, [`offline_${SHOP}`])
    await h.core.alarm()
    expect(h.legacyKv!.data.size).toBe(0)
    expect(h.store.record?.needsReauth?.reason).toBe('legacy_rejected')
  })

  it('backs off a failing migration on the alarm schedule', async () => {
    const h = createHarness({ migrateLegacy: true })
    await h.seedLegacy({ pairObtainedAt: h.clock.now() - DAY })
    h.tokens.onMigrate(failure(h.clock, 'shop_unavailable', { code: 'http_423', status: 423 }))
    await h.core.alarm()
    expect(h.store.record?.failures).toMatchObject({ kind: 'shop_unavailable', retryAt: h.clock.now() + 6 * HOUR })
    expect(h.alarm.at).toBe(h.clock.now() + 6 * HOUR)
  })
})

describe('alarm: quarantine', () => {
  it('waits 90 days from the quarantine', async () => {
    const h = createHarness()
    const since = h.clock.now() - DAY
    await h.seed({ needsReauth: { since, reason: 'refresh_rejected', credFp: CRED_FP } })
    await h.core.alarm()
    expect(h.tokens.calls).toEqual([])
    expect(h.alarm.at).toBe(since + 90 * DAY)
  })

  it('wipes the record, the marker and the legacy keys after 90 days', async () => {
    const h = createHarness({ legacy: true })
    await h.seed({ needsReauth: { since: h.clock.now() - 90 * DAY, reason: 'refresh_rejected', credFp: CRED_FP } })
    await h.registry.put(`shop-session:${SHOP}`, '', { metadata: { since: 1 } })
    h.legacyKv!.setJson(`offline_${SHOP}`, [['accessToken', 'x']])
    h.alarm.at = h.clock.now()
    await h.core.alarm()
    expect(h.store.record).toBeUndefined()
    expect(h.store.deleteAlls).toBe(1)
    expect(h.alarm.at).toBeNull()
    expect(h.alarm.deletes).toBe(1)
    expect(h.marker()).toBeUndefined()
    expect(h.legacyKv!.data.size).toBe(0)
  })

  it('aborts the wipe when the marker delete fails, so the next alarm finishes it', async () => {
    const h = createHarness()
    const since = h.clock.now() - 91 * DAY
    await h.seed({ needsReauth: { since, reason: 'refresh_rejected', credFp: CRED_FP } })
    await h.registry.put(`shop-session:${SHOP}`, '', { metadata: { since } })
    h.registry.failNext = { op: 'delete', error: new Error('KV DELETE failed: 503') }
    await h.core.alarm()
    // Nothing is deleted yet, and the catch-all re-arms.
    expect(h.store.record?.needsReauth?.since).toBe(since)
    expect(h.marker()).toBeDefined()
    expect(h.alarm.at).not.toBeNull()
    h.clock.advance(h.alarm.at! - h.clock.now())
    await h.core.alarm()
    expect(h.store.record).toBeUndefined()
    expect(h.marker()).toBeUndefined()
    expect(h.alarm.at).toBeNull()
  })

  it("drops a lost call's attemptSince, so a later retry under new credentials isn't dated by it", async () => {
    const h = createHarness()
    await h.seed({
      expires: h.clock.now() + 30 * MIN,
      attemptSince: h.clock.now() - 2 * MIN,
      pairObtainedAt: h.clock.now() - HOUR,
    })
    h.tokens.onRefresh(failure(h.clock, 'terminal'))
    await h.core.alarm()
    expect(h.store.record?.needsReauth).toBeDefined()
    expect(h.store.record?.attemptSince).toBeUndefined()
    expect((await h.core.describe({ shop: SHOP })).attemptPending).toBeFalsy()

    h.clock.advance(10 * DAY)
    const core = new ShopSessions({ ...h.deps, credFp: 'cred-fp-2' }, { callerWaitMs: 200 })
    h.tokens.onRefresh(success(h.clock, { access: 'access-2', refresh: 'refresh-2', expiresIn: 3600 }))
    expect(await core.getSession({ shop: SHOP, caller: 'library' })).toMatchObject({ status: 'ok' })
    expect(h.store.record?.expires).toBe(h.clock.now() + HOUR)
  })

  it('keeps a reinstall that lands while the KV keys are being deleted', async () => {
    const h = createHarness({ legacy: true })
    await h.seed({ needsReauth: { since: h.clock.now() - 91 * DAY, reason: 'refresh_rejected', credFp: CRED_FP } })
    const realDelete = h.legacyKv!.delete.bind(h.legacyKv!)
    let raced = false
    h.legacyKv!.delete = async (key: string) => {
      await realDelete(key)
      if (raced) return
      raced = true
      await h.core.putSession({
        shop: SHOP,
        session: { shop: SHOP, accessToken: 'x-access', refreshToken: 'x-refresh', expires: h.clock.now() + HOUR },
      })
    }
    await h.core.alarm()
    expect(h.stored().token).toBe('x-access')
    expect(h.store.deleteAlls).toBe(0)
    expect(h.marker()).toBeDefined()
    expect(h.alarm.at).toBe(h.clock.now() + 30 * DAY)
  })
})

describe('alarm: unreadable records', () => {
  it('skips token work, re-arms in 6 h and reports once per instance', async () => {
    const h = createHarness()
    await h.seed({ pairObtainedAt: h.clock.now() - 40 * DAY })
    h.keyring.unknownKids.add('kid-a')
    await h.core.alarm()
    await h.core.alarm()
    expect(h.tokens.calls).toEqual([])
    expect(h.alarm.at).toBe(h.clock.now() + 6 * HOUR)
    expect(h.reports.map((r) => r.context.op)).toEqual(['unreadable'])
    expect(h.marker()).toBeDefined()
  })
})

describe('alarm: catch-all', () => {
  it('never throws: it re-arms with an error backoff and reports at most hourly', async () => {
    const h = createHarness()
    await h.seed()
    h.store.beforeGet = async () => {
      throw new Error('storage down')
    }
    await expect(h.core.alarm()).resolves.toBeUndefined()
    expect(h.alarm.at).toBe(h.clock.now() + MIN)
    h.clock.advance(MIN)
    await h.core.alarm()
    expect(h.alarm.at).toBe(h.clock.now() + 5 * MIN)
    expect(h.reports.map((r) => r.context)).toEqual([
      { shop: SHOP, op: 'alarm', kind: 'error', code: 'Error', count: 1 },
    ])
    expect(h.logs).toHaveLength(2)
    h.clock.advance(HOUR)
    await h.core.alarm()
    expect(h.reports).toHaveLength(2)
    h.store.beforeGet = undefined
    await h.core.alarm()
    h.store.beforeGet = async () => {
      throw new Error('again')
    }
    await h.core.alarm()
    expect(h.alarm.at).toBe(h.clock.now() + MIN)
  })

  it('rethrows only when it cannot re-arm', async () => {
    const h = createHarness()
    await h.seed()
    h.store.beforeGet = async () => {
      throw new Error('storage down')
    }
    h.alarm.set = async () => {
      throw new Error('cannot set')
    }
    await expect(h.core.alarm()).rejects.toThrow('cannot set')
  })

  it('keeps the error backoff and the report throttle across instances, and clears them after a success', async () => {
    const h = createHarness()
    await h.seed()
    // A registry that keeps failing; every alarm runs on a fresh instance, as after an eviction.
    h.registry.put = async () => {
      throw new Error('kv down')
    }
    const delays: number[] = []
    for (const gap of [0, MIN, 5 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR]) {
      h.clock.advance(gap)
      await new ShopSessions(h.deps, { callerWaitMs: 200 }).alarm()
      delays.push((h.alarm.at ?? 0) - h.clock.now())
    }
    expect(delays).toEqual([MIN, 5 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR, 6 * HOUR])
    // Reported at the first failure, then at the first failure an hour or more after the last report.
    expect(h.reports.map((r) => r.context.count)).toEqual([1, 5, 6])
    expect(h.alarm.errors).toEqual({ count: 6, reportedAt: h.clock.now() })

    h.registry.put = async () => {}
    h.clock.advance(6 * HOUR)
    await new ShopSessions(h.deps, { callerWaitMs: 200 }).alarm()
    expect(h.alarm.errors).toBeUndefined()
    expect(h.alarm.at).toBe(h.store.record!.pairObtainedAt + 30 * DAY)
  })

  it('does not re-arm when a destroy landed during a failed run', async () => {
    const h = createHarness()
    await h.seed()
    h.registry.put = async () => {
      await h.core.destroy({ shop: SHOP })
      throw new Error('kv down')
    }
    await h.core.alarm()
    expect(h.store.record).toBeUndefined()
    expect(h.alarm.at).toBeNull()
    expect(h.alarm.errors).toBeUndefined()
    expect(h.reports.map((r) => r.context.op)).toEqual(['alarm'])
  })

  it('re-arms when a KV write fails after the token work', async () => {
    const h = createHarness()
    await h.seed()
    h.registry.failNext = { op: 'put', error: new Error('kv down') }
    await h.core.alarm()
    expect(h.alarm.at).toBe(h.clock.now() + MIN)
    await h.core.alarm()
    expect(h.marker()).toBeDefined()
  })
})
