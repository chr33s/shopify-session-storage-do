import { describe, expect, it } from 'vitest'
import { fingerprint } from '../../../src/fingerprint.js'
import { CRED_FP, DAY, HOUR, MIN, SHOP, createHarness, deferred, settle, success } from './fakes.js'
import type { Harness } from './fakes.js'

const OFFLINE = `offline_${SHOP}`
const LIST = `shop:${SHOP}`

function legacyValue(fields: [string, unknown][]): [string, unknown][] {
  return [['id', OFFLINE], ['shop', SHOP], ['state', ''], ['isOnline', false], ...fields]
}

function putLegacy(h: Harness, fields: [string, unknown][]) {
  h.legacyKv!.setJson(OFFLINE, legacyValue(fields))
  h.legacyKv!.setJson(LIST, [OFFLINE, OFFLINE])
}

const importLegacy = (h: Harness) => h.core.importLegacy({ shop: SHOP })

/** Everything a deleted shop must not leave behind. */
function leftovers(h: Harness) {
  return {
    record: h.store.record !== undefined,
    legacyKeys: [...(h.legacyKv?.data.keys() ?? [])],
    marker: h.marker() !== undefined,
    alarm: h.alarm.at,
  }
}

const NOTHING_LEFT = { record: false, legacyKeys: [], marker: false, alarm: null }

describe('importLegacy', () => {
  it('answers none without legacy KV', async () => {
    const h = createHarness()
    expect(await importLegacy(h)).toEqual({ status: 'none' })
  })

  it('imports a legacy token and keeps the KV copy until migration', async () => {
    const h = createHarness({ legacy: true })
    putLegacy(h, [
      ['scope', 'read_products'],
      ['accessToken', 'legacy-kv'],
    ])
    expect(await importLegacy(h)).toEqual({ status: 'imported' })
    const record = h.store.record!
    expect(record).toEqual({
      v: 1,
      shop: SHOP,
      scope: 'read_products',
      token: record.token,
      tokenFp: await fingerprint('legacy-kv'),
      source: 'import',
      pairObtainedAt: h.clock.now(),
    })
    expect(h.keyring.peek(record.token)).toEqual({ aad: `${SHOP}|token`, plaintext: 'legacy-kv' })
    expect(h.legacyKv!.data.has(OFFLINE)).toBe(true)
    expect(h.marker()).toEqual({ value: '', metadata: { since: h.clock.now() } })
    expect(h.alarm.at).toBe(h.clock.now() + DAY)
  })

  it('imports an expiring pair and deletes both KV keys', async () => {
    const h = createHarness({ legacy: true })
    const expires = h.clock.now() + 20 * MIN
    putLegacy(h, [
      ['accesstoken', 'kv-access'],
      ['EXPIRES', expires],
      ['refreshToken', 'kv-refresh'],
      ['refreshTokenExpires', h.clock.now() + 80 * DAY],
    ])
    expect(await importLegacy(h)).toEqual({ status: 'imported' })
    expect(h.store.record).toMatchObject({
      expires,
      refreshExpires: h.clock.now() + 80 * DAY,
      source: 'import',
      chainOriginExpires: expires,
      refreshFp: await fingerprint('kv-refresh'),
    })
    expect(h.stored()).toMatchObject({ token: 'kv-access', refresh: 'kv-refresh' })
    expect(h.legacyKv!.data.size).toBe(0)
    expect(h.alarm.at).toBe(h.clock.now() + 30 * DAY)
  })

  it('imports a blanked session with a live refresh token as tokenInvalid, and refreshes it on use', async () => {
    const h = createHarness({ legacy: true })
    putLegacy(h, [
      ['expires', h.clock.now() - HOUR],
      ['refreshToken', 'kv-refresh'],
      ['refreshTokenExpires', h.clock.now() + 10 * DAY],
    ])
    expect(await importLegacy(h)).toEqual({ status: 'imported' })
    expect(h.store.record).toMatchObject({ tokenInvalid: true })
    expect(h.store.record).not.toHaveProperty('token')
    h.tokens.onRefresh(success(h.clock, { access: 'access-2' }))
    expect(await h.get()).toMatchObject({ status: 'ok', session: { accessToken: 'access-2' } })
    expect(h.tokens.calls).toEqual([{ kind: 'refresh', shop: SHOP, token: 'kv-refresh' }])
  })

  it('answers none and deletes the keys when nothing is usable', async () => {
    const h = createHarness({ legacy: true })
    putLegacy(h, [
      ['accessToken', 'kv-access'],
      ['expires', h.clock.now() - HOUR],
    ])
    expect(await importLegacy(h)).toEqual({ status: 'none' })
    expect(h.store.record).toBeUndefined()
    expect(h.legacyKv!.data.size).toBe(0)
  })

  it('answers invalid and deletes the keys for unparseable values and shop mismatches', async () => {
    for (const write of [
      (h: Harness) => h.legacyKv!.data.set(OFFLINE, { value: '{not json' }),
      (h: Harness) => h.legacyKv!.setJson(OFFLINE, { accessToken: 'x' }),
      (h: Harness) =>
        h.legacyKv!.setJson(OFFLINE, [
          ['shop', 'other.myshopify.com'],
          ['accessToken', 'x'],
        ]),
    ]) {
      const h = createHarness({ legacy: true })
      write(h)
      h.legacyKv!.setJson(LIST, [OFFLINE])
      expect(await importLegacy(h)).toEqual({ status: 'invalid' })
      expect(h.store.record).toBeUndefined()
      expect(h.legacyKv!.data.size).toBe(0)
      expect(JSON.stringify(h.logs)).not.toContain('"x"')
    }
  })

  it('answers none when KV has no session', async () => {
    const h = createHarness({ legacy: true })
    expect(await importLegacy(h)).toEqual({ status: 'none' })
    expect(h.legacyKv!.ops.filter((op) => op.op === 'delete')).toEqual([])
  })

  it('throws on KV infrastructure errors', async () => {
    const h = createHarness({ legacy: true })
    h.legacyKv!.failNext = { op: 'get', error: new Error('kv down') }
    await expect(importLegacy(h)).rejects.toThrow('kv down')
  })

  it('runs concurrent imports as one', async () => {
    const h = createHarness({ legacy: true })
    putLegacy(h, [['accessToken', 'legacy-kv']])
    const results = await Promise.all([importLegacy(h), importLegacy(h), h.get()])
    expect(results[0]).toEqual({ status: 'imported' })
    expect(results[1]).toEqual({ status: 'imported' })
    expect(results[2]).toMatchObject({ status: 'ok', session: { accessToken: 'legacy-kv' } })
    expect(h.legacyKv!.ops.filter((op) => op.op === 'get')).toHaveLength(1)
    expect(h.store.puts).toHaveLength(1)
    // A later call is a new run.
    expect(await importLegacy(h)).toEqual({ status: 'already_present' })
  })

  it('answers already_present, keeping the KV copy of a legacy record and deleting it otherwise', async () => {
    const legacy = createHarness({ legacy: true })
    await legacy.seedLegacy()
    putLegacy(legacy, [['accessToken', 'legacy-1']])
    expect(await importLegacy(legacy)).toEqual({ status: 'already_present' })
    expect(legacy.legacyKv!.data.size).toBe(2)

    const expiring = createHarness({ legacy: true })
    const seeded = await expiring.seed()
    putLegacy(expiring, [['accessToken', 'legacy-1']])
    expect(await importLegacy(expiring)).toEqual({ status: 'already_present' })
    expect(expiring.legacyKv!.data.size).toBe(0)
    expect(expiring.store.record).toEqual(seeded)
  })

  it('answers none when a destroy lands during the KV read', async () => {
    const h = createHarness({ legacy: true })
    putLegacy(h, [['accessToken', 'legacy-kv']])
    const gate = deferred<void>()
    h.legacyKv!.holdGet = () => gate.promise
    const pending = importLegacy(h)
    await settle()
    h.legacyKv!.holdGet = undefined
    expect(await h.core.destroy({ shop: SHOP })).toEqual({ status: 'deleted' })
    gate.resolve()
    expect(await pending).toEqual({ status: 'none' })
    expect(h.store.record).toBeUndefined()
  })

  it('answers none when the quarantine GC lands during the KV read', async () => {
    const h = createHarness({ legacy: true })
    await h.seedLegacy({ needsReauth: { since: h.clock.now() - 90 * DAY, reason: 'legacy_rejected', credFp: CRED_FP } })
    putLegacy(h, [['accessToken', 'legacy-1']])
    const gate = deferred<void>()
    h.legacyKv!.holdGet = () => gate.promise
    const pending = importLegacy(h)
    await settle()
    h.legacyKv!.holdGet = undefined
    h.alarm.at = h.clock.now()
    await h.core.alarm()
    expect(h.store.record).toBeUndefined()
    // The wipe moved `version`, so the value read before it is not imported again.
    gate.resolve()
    expect(await pending).toEqual({ status: 'none' })
    expect(leftovers(h)).toEqual(NOTHING_LEFT)
  })

  it('answers already_present for a rejected legacy token and deletes its KV copy', async () => {
    const h = createHarness({ legacy: true })
    const seeded = await h.seedLegacy({
      needsReauth: { since: h.clock.now(), reason: 'legacy_rejected', credFp: CRED_FP },
    })
    putLegacy(h, [['accessToken', 'legacy-1']])
    expect(await importLegacy(h)).toEqual({ status: 'already_present' })
    expect(h.legacyKv!.data.size).toBe(0)
    // The record keeps the sealed token for a retry after a credential fix.
    expect(h.store.record).toEqual(seeded)
  })

  it('imports a session with a refresh token but no expiry as an expiring pair due for a refresh', async () => {
    const h = createHarness({ legacy: true })
    putLegacy(h, [
      ['accessToken', 'kv-access'],
      ['refreshToken', 'kv-refresh'],
      ['refreshTokenExpires', h.clock.now() + 10 * DAY],
    ])
    expect(await importLegacy(h)).toEqual({ status: 'imported' })
    expect(h.stored()).toMatchObject({ token: 'kv-access', refresh: 'kv-refresh' })
    expect(h.store.record).toMatchObject({ expires: h.clock.now(), source: 'import' })
    expect(h.legacyKv!.data.size).toBe(0)
  })

  it('answers already_present when an exchange lands during the KV read', async () => {
    const h = createHarness({ legacy: true })
    putLegacy(h, [['accessToken', 'legacy-kv']])
    const gate = deferred<void>()
    h.legacyKv!.holdGet = () => gate.promise
    const pending = importLegacy(h)
    await settle()
    await h.core.putSession({
      shop: SHOP,
      session: { shop: SHOP, accessToken: 'x-access', refreshToken: 'x-refresh', expires: h.clock.now() + HOUR },
    })
    gate.resolve()
    expect(await pending).toEqual({ status: 'already_present' })
    expect(h.stored().token).toBe('x-access')
    expect(h.legacyKv!.data.size).toBe(0)
  })
})

describe('destroy', () => {
  it('deletes the record, alarm, marker and legacy keys', async () => {
    const h = createHarness({ legacy: true })
    await h.core.putSession({
      shop: SHOP,
      session: { shop: SHOP, accessToken: 'x', refreshToken: 'y', expires: h.clock.now() + HOUR },
    })
    h.legacyKv!.setJson(OFFLINE, [])
    h.legacyKv!.setJson(LIST, [])
    expect(h.marker()).toBeDefined()
    expect(await h.core.destroy({ shop: SHOP, uninstalledAt: h.clock.now() })).toEqual({ status: 'deleted' })
    expect(h.store.record).toBeUndefined()
    expect(h.alarm.at).toBeNull()
    expect(h.alarm.deletes).toBe(1)
    expect(h.marker()).toBeUndefined()
    expect(h.legacyKv!.data.size).toBe(0)
  })

  it('keeps a pair obtained more than 60 s after the uninstall', async () => {
    const h = createHarness()
    const seeded = await h.seed()
    await h.registry.put(`shop-session:${SHOP}`, '', { metadata: { since: 1 } })
    expect(await h.core.destroy({ shop: SHOP, uninstalledAt: h.clock.now() - 61_000 })).toEqual({
      status: 'kept_newer_install',
    })
    expect(h.store.record).toEqual(seeded)
    expect(h.marker()).toBeDefined()
    expect(await h.core.destroy({ shop: SHOP, uninstalledAt: h.clock.now() - 60_000 })).toEqual({ status: 'deleted' })
  })

  it('keeps a reinstall that lands between the KV deletes and the critical section', async () => {
    const h = createHarness({ legacy: true })
    const uninstalledAt = h.clock.now()
    await h.seed({ pairObtainedAt: uninstalledAt - DAY })
    await h.registry.put(`shop-session:${SHOP}`, '', { metadata: { since: 1 } })
    const realDelete = h.legacyKv!.delete.bind(h.legacyKv!)
    let raced = false
    h.legacyKv!.delete = async (key: string) => {
      await realDelete(key)
      if (raced) return
      raced = true
      h.clock.advance(5 * MIN)
      await h.core.putSession({
        shop: SHOP,
        session: { shop: SHOP, accessToken: 'reinstall', refreshToken: 'reinstall-r', expires: h.clock.now() + HOUR },
      })
    }
    expect(await h.core.destroy({ shop: SHOP, uninstalledAt })).toEqual({ status: 'kept_newer_install' })
    expect(h.stored().token).toBe('reinstall')
    // The marker goes with the KV keys up front (so a failed delete can be retried while the record exists), and
    // is written back for the record that was kept.
    expect(h.marker()).toEqual({ value: '', metadata: { since: h.store.record?.pairObtainedAt } })
    expect(h.store.deleteAlls).toBe(0)
  })

  describe('after an import that followed the uninstall', () => {
    it('deletes a legacy token imported by the backfill (an import proves no reinstall)', async () => {
      const h = createHarness({ legacy: true })
      putLegacy(h, [['accessToken', 'legacy-kv']])
      const uninstalledAt = h.clock.now()
      h.clock.advance(5 * MIN)
      expect(await importLegacy(h)).toEqual({ status: 'imported' })
      h.clock.advance(5 * MIN)
      expect(await h.core.destroy({ shop: SHOP, uninstalledAt })).toEqual({ status: 'deleted' })
      expect(leftovers(h)).toEqual(NOTHING_LEFT)
    })

    it('deletes an expiring pair imported by a straggling load', async () => {
      const h = createHarness({ legacy: true })
      const uninstalledAt = h.clock.now()
      putLegacy(h, [
        ['accessToken', 'kv-access'],
        ['expires', uninstalledAt + 40 * MIN],
        ['refreshToken', 'kv-refresh'],
        ['refreshTokenExpires', uninstalledAt + 80 * DAY],
      ])
      h.clock.advance(3 * MIN)
      expect(await h.get()).toMatchObject({ status: 'ok' })
      h.clock.advance(5 * MIN)
      expect(await h.core.destroy({ shop: SHOP, uninstalledAt })).toEqual({ status: 'deleted' })
      expect(leftovers(h)).toEqual(NOTHING_LEFT)
    })

    it('still keeps a reinstall exchanged after the import', async () => {
      const h = createHarness({ legacy: true })
      putLegacy(h, [['accessToken', 'legacy-kv']])
      const uninstalledAt = h.clock.now()
      h.clock.advance(5 * MIN)
      await importLegacy(h)
      h.clock.advance(2 * MIN)
      await h.core.putSession({
        shop: SHOP,
        session: { shop: SHOP, accessToken: 'new', refreshToken: 'new-r', expires: h.clock.now() + HOUR },
      })
      h.clock.advance(3 * MIN)
      expect(await h.core.destroy({ shop: SHOP, uninstalledAt })).toEqual({ status: 'kept_newer_install' })
      expect(h.stored().token).toBe('new')
      expect(h.marker()).toBeDefined()
    })

    it('deletes an import that read KV before the destroy and lands between its KV deletes and its critical section', async () => {
      const h = createHarness({ legacy: true })
      const uninstalledAt = h.clock.now()
      putLegacy(h, [['accessToken', 'legacy-kv']])
      h.clock.advance(90_000)
      // A late webhook's lazy import has read the KV copy; the uninstall webhook starts meanwhile.
      const read = deferred<void>()
      h.legacyKv!.holdGet = () => read.promise
      const importing = importLegacy(h)
      await settle()
      h.legacyKv!.holdGet = undefined
      const realDelete = h.legacyKv!.delete.bind(h.legacyKv!)
      let raced = false
      h.legacyKv!.delete = async (key: string) => {
        await realDelete(key)
        if (raced) return
        raced = true
        read.resolve()
        expect(await importing).toEqual({ status: 'imported' })
      }
      expect(await h.core.destroy({ shop: SHOP, uninstalledAt })).toEqual({ status: 'deleted' })
      expect(leftovers(h)).toEqual(NOTHING_LEFT)
    })
  })

  it('leaves no marker when it lands while a putSession writes the marker of the record it created', async () => {
    const h = createHarness()
    const realPut = h.registry.put.bind(h.registry)
    let raced = false
    h.registry.put = async (key: string, value: string, options?: { metadata?: unknown }) => {
      if (!raced) {
        raced = true
        // deleteShop without uninstalledAt runs while the marker write is in flight, which then lands.
        expect(await h.core.destroy({ shop: SHOP })).toEqual({ status: 'deleted' })
      }
      await realPut(key, value, options)
    }
    expect(
      await h.core.putSession({
        shop: SHOP,
        session: { shop: SHOP, accessToken: 'x', refreshToken: 'y', expires: h.clock.now() + HOUR },
      }),
    ).toEqual({ status: 'stored' })
    expect(leftovers(h)).toEqual({ ...NOTHING_LEFT, legacyKeys: [] })
  })

  it('cleans up even without a record', async () => {
    const h = createHarness({ legacy: true })
    h.legacyKv!.setJson(OFFLINE, [['accessToken', 'stale']])
    h.alarm.at = h.clock.now() + DAY
    expect(await h.core.destroy({ shop: SHOP })).toEqual({ status: 'deleted' })
    expect(h.legacyKv!.data.size).toBe(0)
    expect(h.alarm.at).toBeNull()
  })

  it('throws, keeping the record, when the legacy keys cannot be deleted', async () => {
    const h = createHarness({ legacy: true })
    const seeded = await h.seed()
    h.legacyKv!.failNext = { op: 'delete', error: new Error('kv down') }
    await expect(h.core.destroy({ shop: SHOP })).rejects.toThrow('kv down')
    expect(h.store.record).toEqual(seeded)
  })
})

describe('describe', () => {
  it('describes a missing, healthy, failing and unreadable record without secrets', async () => {
    const h = createHarness()
    expect(await h.core.describe({ shop: SHOP })).toEqual({
      shop: SHOP,
      exists: false,
      state: 'none',
      nextAlarmAt: null,
    })
    await h.seed({ scope: 's', alternates: ['alt-1'] })
    h.alarm.at = h.clock.now() + DAY
    const status = await h.core.describe({ shop: SHOP })
    expect(status).toMatchObject({
      exists: true,
      state: 'ok',
      scope: 's',
      alternates: 1,
      kids: ['kid-a'],
      nextAlarmAt: h.clock.now() + DAY,
    })
    h.store.record!.failures = {
      count: 2,
      kind: 'transient',
      code: 'timeout',
      since: 1,
      retryAt: 2,
      ambiguousSince: 1,
      credFp: CRED_FP,
    }
    expect((await h.core.describe({ shop: SHOP })).failures).toEqual({
      count: 2,
      kind: 'transient',
      code: 'timeout',
      since: 1,
      retryAt: 2,
      ambiguous: true,
    })
    h.keyring.unknownKids.add('kid-a')
    const unreadable = await h.core.describe({ shop: SHOP })
    expect(unreadable.state).toBe('unreadable')
    const text = JSON.stringify([status, unreadable])
    for (const secret of ['access-1', 'refresh-1', 'alt-1', CRED_FP]) expect(text).not.toContain(secret)
  })

  it('rejects another shop', async () => {
    const h = createHarness()
    await expect(h.core.describe({ shop: 'other.myshopify.com' })).rejects.toThrow(TypeError)
    await expect(h.core.destroy({ shop: 'other.myshopify.com' })).rejects.toThrow(TypeError)
    await expect(h.core.importLegacy({ shop: 'other.myshopify.com' })).rejects.toThrow(TypeError)
    await expect(h.core.getSession({ shop: 'other.myshopify.com', caller: 'app' })).rejects.toThrow(TypeError)
  })
})
