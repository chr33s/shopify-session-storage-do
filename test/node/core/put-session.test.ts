import { describe, expect, it } from 'vitest'
import { fingerprint } from '../../../src/fingerprint.js'
import { CRED_FP, CUTOFF, DAY, HOUR, MIN, SHOP, createHarness, success } from './fakes.js'
import type { Harness } from './fakes.js'
import type { SessionParams } from '../../../src/types.js'

function exchange(h: Harness, n: number | string, extra: Partial<SessionParams> = {}): SessionParams {
  return {
    shop: SHOP,
    isOnline: false,
    scope: 'read_products',
    accessToken: `x-access-${n}`,
    refreshToken: `x-refresh-${n}`,
    expires: h.clock.now() + HOUR,
    refreshTokenExpires: h.clock.now() + 90 * DAY,
    ...extra,
  }
}

const put = (h: Harness, session: SessionParams, issued?: string) =>
  h.core.putSession({ shop: SHOP, session, ...(issued === undefined ? {} : { issued: { tokenFp: issued } }) })

describe('putSession: validation', () => {
  it('throws on online sessions and on another shop', async () => {
    const h = createHarness()
    await expect(put(h, { ...exchange(h, 1), isOnline: true })).rejects.toThrow(TypeError)
    await expect(put(h, { ...exchange(h, 1), shop: 'other.myshopify.com' })).rejects.toThrow(TypeError)
    await expect(h.core.putSession({ shop: 'other.myshopify.com', session: exchange(h, 1) })).rejects.toThrow(TypeError)
  })

  it('accepts the library spelling of the shop', async () => {
    const h = createHarness()
    expect(await put(h, { ...exchange(h, 1), shop: 'Example.myshopify.com/' })).toEqual({ status: 'stored' })
  })

  it('ignores a library session without an access token', async () => {
    const h = createHarness()
    expect(await put(h, { shop: SHOP, refreshToken: 'r', expires: h.clock.now() })).toEqual({ status: 'ignored_stale' })
    expect(h.store.record).toBeUndefined()
  })
})

describe('putSession: issued sessions', () => {
  it('marks the token invalid when its own session comes back without one (invalidateAccessToken)', async () => {
    const h = createHarness()
    const seeded = await h.seed()
    expect(await put(h, { shop: SHOP, scope: 'x', expires: seeded.expires }, seeded.tokenFp)).toEqual({
      status: 'merged',
    })
    expect(h.store.record).toEqual({ ...seeded, tokenInvalid: true })
  })

  it('ignores a stale issued session', async () => {
    const h = createHarness()
    const seeded = await h.seed()
    const stale = await fingerprint('access-0')
    expect(await put(h, { shop: SHOP }, stale)).toEqual({ status: 'ignored_stale' })
    expect(await put(h, { shop: SHOP, accessToken: 'access-0', scope: 'new' }, stale)).toEqual({
      status: 'ignored_stale',
    })
    expect(h.store.record).toEqual(seeded)
  })

  it('merges scope from its own session but never replaces tokens', async () => {
    const h = createHarness()
    const seeded = await h.seed({ scope: 'read_products' })
    const session = { ...exchange(h, 9), scope: 'read_products,write_discounts' }
    expect(await put(h, session, seeded.tokenFp)).toEqual({ status: 'merged' })
    expect(h.store.record).toEqual({ ...seeded, scope: 'read_products,write_discounts' })
    expect(h.keyring.seals).toEqual([])
    expect(h.alarm.sets).toEqual([])
  })

  it('keeps the stored scope when its own session comes back without one', async () => {
    const h = createHarness()
    const seeded = await h.seed({ scope: 'read_products' })
    expect(await put(h, { shop: SHOP, accessToken: 'access-1' }, seeded.tokenFp)).toEqual({ status: 'merged' })
    expect(h.store.record).toEqual(seeded)
  })
})

describe('putSession: an untagged copy of the stored token', () => {
  // App code that copies a loaded session (new Session({ ...loaded })) loses the non-enumerable tag.
  const failures = (h: Harness) => ({
    count: 1,
    kind: 'transient' as const,
    code: 'timeout',
    since: h.clock.now() - MIN,
    retryAt: h.clock.now() + MIN,
    ambiguousSince: h.clock.now() - MIN,
    credFp: CRED_FP,
  })

  it('is a duplicate of a legacy token: scope merges, a 401 and an ambiguous migration are kept', async () => {
    const h = createHarness()
    const seeded = await h.seedLegacy({
      tokenInvalid: true,
      failures: failures(h),
      pairObtainedAt: h.clock.now() - DAY,
    })
    expect(await put(h, { shop: SHOP, isOnline: false, accessToken: 'legacy-1', scope: 'more' })).toEqual({
      status: 'merged',
    })
    expect(h.store.record).toEqual({ ...seeded, scope: 'more' })
    expect(await h.get()).toEqual({ status: 'tokenless', reason: 'legacy_unusable', scope: 'more' })
  })

  it('is a duplicate of an expiring token, with or without the refresh token and whatever its expiry', async () => {
    const h = createHarness()
    const seeded = await h.seed({ tokenInvalid: true, failures: failures(h), pairObtainedAt: h.clock.now() - DAY })
    const copies: SessionParams[] = [
      { shop: SHOP, accessToken: 'access-1', expires: seeded.expires! + HOUR },
      { shop: SHOP, accessToken: 'access-1', refreshToken: 'refresh-1', expires: seeded.expires },
    ]
    for (const copy of copies) expect(await put(h, copy)).toEqual({ status: 'merged' })
    expect(h.store.record).toEqual(seeded)
    expect(h.alarm.sets).toEqual([])
  })
})

describe('putSession: library exchange with a refresh token', () => {
  it('creates the record, writes the registry marker and sets the keepalive alarm', async () => {
    const h = createHarness()
    expect(await put(h, exchange(h, 1))).toEqual({ status: 'stored' })
    const record = h.store.record!
    expect(record).toMatchObject({
      v: 1,
      shop: SHOP,
      scope: 'read_products',
      tokenFp: await fingerprint('x-access-1'),
      refreshFp: await fingerprint('x-refresh-1'),
      expires: h.clock.now() + HOUR,
      refreshExpires: h.clock.now() + 90 * DAY,
      source: 'exchange',
      pairObtainedAt: h.clock.now(),
      chainOriginExpires: h.clock.now() + HOUR,
    })
    expect(h.keyring.peek(record.token)).toEqual({ aad: `${SHOP}|token`, plaintext: 'x-access-1' })
    expect(h.keyring.peek(record.refresh)).toEqual({ aad: `${SHOP}|refresh`, plaintext: 'x-refresh-1' })
    expect(h.marker()).toEqual({ value: '', metadata: { since: h.clock.now() } })
    expect(h.alarm.at).toBe(h.clock.now() + 30 * DAY)
  })

  it('treats a re-store of the stored pair as a duplicate and merges its scope', async () => {
    const h = createHarness()
    await put(h, exchange(h, 1))
    const before = h.store.record!
    h.clock.advance(MIN)
    expect(await put(h, { ...exchange(h, 1), scope: 'more', expires: before.expires! + MIN })).toEqual({
      status: 'merged',
    })
    expect(h.store.record).toEqual({ ...before, scope: 'more' })
  })

  it('treats a re-store of an alternate as a duplicate', async () => {
    const h = createHarness()
    await h.seed({ alternates: ['x-refresh-1'] })
    const before = h.store.record!
    expect(await put(h, { ...exchange(h, 1), scope: 'other' })).toEqual({ status: 'merged' })
    expect(h.store.record).toEqual(before)
  })

  it('accepts outright over legacy, quarantine, migrate and legacy_exchange records', async () => {
    for (const seed of [
      (h: Harness) => h.seedLegacy(),
      (h: Harness) => h.seedLegacy({ source: 'legacy_exchange' }),
      (h: Harness) => h.seed({ source: 'migrate', expires: h.clock.now() + 2 * HOUR }),
      (h: Harness) =>
        h.seed({
          expires: h.clock.now() + 2 * HOUR,
          alternates: ['old-alt'],
          tokenInvalid: true,
          needsReauth: { since: 1, reason: 'refresh_rejected', credFp: CRED_FP },
          failures: { count: 1, kind: 'transient', code: 'x', since: 1, retryAt: 2, credFp: CRED_FP },
        }),
    ]) {
      const h = createHarness()
      await seed(h)
      expect(await put(h, exchange(h, 1))).toEqual({ status: 'stored' })
      const record = h.store.record!
      expect(h.stored().token).toBe('x-access-1')
      expect(record.source).toBe('exchange')
      for (const field of ['alternates', 'tokenInvalid', 'needsReauth', 'failures'] as const) {
        expect(record).not.toHaveProperty(field)
      }
      // The record existed, so no new marker.
      expect(h.marker()).toBeUndefined()
    }
  })

  it('replaces a record whose refresh token alone is unreadable, filing nothing it cannot decrypt', async () => {
    const h = createHarness()
    await h.seed({ source: 'exchange', expires: h.clock.now() + 30 * MIN })
    h.store.record!.refresh = { ...h.store.record!.refresh!, kid: 'kid-old' }
    h.keyring.unknownKids.add('kid-old')
    expect(await put(h, exchange(h, 1))).toEqual({ status: 'stored' })
    expect(h.stored()).toMatchObject({ token: 'x-access-1', refresh: 'x-refresh-1' })
    expect(h.store.record?.alternates).toBeUndefined()
  })

  it('replaces an unreadable record without decrypting it', async () => {
    const h = createHarness()
    await h.seed({ source: 'exchange', expires: h.clock.now() + 2 * HOUR, alternates: ['a1'] })
    h.keyring.unknownKids.add('kid-a')
    h.keyring.currentKid = 'kid-b'
    expect(await put(h, exchange(h, 1))).toEqual({ status: 'stored' })
    expect(h.stored().token).toBe('x-access-1')
    expect(h.store.record?.alternates).toBeUndefined()
    expect(h.store.record?.token?.kid).toBe('kid-b')
  })

  for (const source of ['refresh', 'import'] as const) {
    it(`accepts over a ${source} chain an exchange at least as new as the chain's origin`, async () => {
      const h = createHarness()
      await h.seed({ source, chainOriginExpires: h.clock.now() + HOUR, expires: h.clock.now() + 3 * HOUR })
      expect(await put(h, exchange(h, 1))).toEqual({ status: 'stored' })
      expect(h.stored().refresh).toBe('x-refresh-1')
      expect(h.store.record?.chainOriginExpires).toBe(h.clock.now() + HOUR)
    })

    it(`files an older exchange arriving late over a ${source} chain as an alternate`, async () => {
      const h = createHarness()
      const seeded = await h.seed({ source, chainOriginExpires: h.clock.now() + 2 * HOUR })
      expect(await put(h, exchange(h, 1))).toEqual({ status: 'merged' })
      const { alternates, ...rest } = h.store.record!
      expect(rest).toEqual(seeded)
      expect(alternates).toHaveLength(1)
      expect(h.keyring.peek(alternates![0]!.refresh)).toEqual({ aad: `${SHOP}|alternate`, plaintext: 'x-refresh-1' })
      expect(alternates![0]!.fp).toBe(await fingerprint('x-refresh-1'))
      expect(h.alarm.sets).toEqual([])
    })
  }

  it('keeps the later of two racing exchanges current, in either arrival order', async () => {
    const ends = []
    for (const order of [
      [1, 2],
      [2, 1],
    ]) {
      const h = createHarness()
      const sessions = {
        1: exchange(h, 1, { expires: h.clock.now() + HOUR }),
        2: exchange(h, 2, { expires: h.clock.now() + HOUR + 1_000 }),
      }
      for (const n of order) await put(h, sessions[n as 1 | 2])
      const s = h.stored()
      ends.push({ token: s.token, refresh: s.refresh, alternates: s.alternates })
      expect(h.store.record?.chainOriginExpires).toBe(h.clock.now() + HOUR + 1_000)
      expect(h.keyring.peek(h.store.record?.alternates?.[0]?.refresh)?.aad).toBe(`${SHOP}|alternate`)
    }
    expect(ends[0]).toEqual({ token: 'x-access-2', refresh: 'x-refresh-2', alternates: ['x-refresh-1'] })
    expect(ends[1]).toEqual(ends[0])
  })

  it('keeps existing alternates when an exchange displaces an exchange, newest first, capped at 5', async () => {
    const h = createHarness()
    await h.seed({ alternates: ['a1', 'a2', 'a3', 'a4', 'a5'] })
    await put(h, exchange(h, 1, { expires: h.clock.now() + 2 * HOUR }))
    expect(h.stored().alternates).toEqual(['refresh-1', 'a1', 'a2', 'a3', 'a4'])
    // An older one arriving late is filed at the front too, and a re-store of it changes nothing.
    await put(h, exchange(h, 0, { expires: h.clock.now() + HOUR - 1 }))
    expect(h.stored().alternates).toEqual(['x-refresh-0', 'refresh-1', 'a1', 'a2', 'a3'])
    expect(await put(h, exchange(h, 0, { expires: h.clock.now() + HOUR - 1 }))).toEqual({ status: 'merged' })
    expect(h.stored().alternates).toEqual(['x-refresh-0', 'refresh-1', 'a1', 'a2', 'a3'])
  })

  it('copies existing sealed values instead of re-sealing them', async () => {
    const h = createHarness()
    const seeded = await h.seed({ alternates: ['a1'], source: 'refresh', chainOriginExpires: h.clock.now() + 2 * HOUR })
    await put(h, exchange(h, 1))
    expect(h.store.record?.token).toEqual(seeded.token)
    expect(h.store.record?.refresh).toEqual(seeded.refresh)
    expect(h.store.record?.alternates?.[1]).toEqual(seeded.alternates?.[0])
  })

  it('settles many concurrent exchanges without throwing, keeping the newest by expiry', async () => {
    const h = createHarness()
    await h.seed({ expires: h.clock.now() + 10 * MIN })
    // Crypto awaits may let other events in.
    h.keyring.delay = () => new Promise((resolve) => setTimeout(resolve, 0))
    const n = 8
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        put(h, exchange(h, i, { expires: h.clock.now() + HOUR + i * 1_000 })).then(
          (result) => result.status,
          (error: Error) => `threw: ${error.message}`,
        ),
      ),
    )
    expect(results.filter((result) => result.startsWith('threw'))).toEqual([])
    // Nine refresh tokens: the newest is current, the next five are alternates, the cap drops the oldest three.
    expect(h.stored().refresh).toBe(`x-refresh-${n - 1}`)
    expect(new Set(h.stored().alternates)).toEqual(new Set([2, 3, 4, 5, 6].map((i) => `x-refresh-${i}`)))
    const capped = h.reports.filter((r) => r.context.code === 'cap_exceeded')
    expect(capped.reduce((sum, r) => sum + (r.context.count ?? 0), 0)).toBe(3)
    expect(capped[0]?.context).toMatchObject({ op: 'put', kind: 'alternates' })
  })

  it('files the incoming refresh token as an alternate when the current one keeps changing', async () => {
    const h = createHarness()
    await h.seed({ expires: h.clock.now() + 10 * MIN })
    // Every time this put decrypts the current refresh token, a refresh replaces it.
    const realOpen = h.keyring.open.bind(h.keyring)
    let n = 0
    h.keyring.open = async (sealed, aad) => {
      const plain = await realOpen(sealed, aad)
      if (aad.endsWith('|refresh')) {
        const rotated = `rotated-${++n}`
        h.store.record = {
          ...h.store.record!,
          refresh: await h.sealed(rotated, 'refresh'),
          refreshFp: await fingerprint(rotated),
        }
      }
      return plain
    }
    expect(await put(h, exchange(h, 1))).toEqual({ status: 'merged' })
    expect(n).toBe(5)
    expect(h.stored()).toMatchObject({ refresh: 'rotated-5', alternates: ['x-refresh-1'] })
  })

  it('treats an exchange without an expiry as due for a refresh', async () => {
    const h = createHarness()
    await put(h, exchange(h, 1, { expires: undefined }))
    expect(h.store.record?.expires).toBe(h.clock.now())
  })
})

describe('putSession: non-expiring library exchange (flag off)', () => {
  const legacyExchange = (token = 'x-legacy'): SessionParams => ({ shop: SHOP, scope: 's', accessToken: token })

  it('stores it over nothing as legacy_exchange and reports once', async () => {
    const h = createHarness()
    expect(await put(h, legacyExchange())).toEqual({ status: 'stored' })
    expect(h.store.record).toMatchObject({ source: 'legacy_exchange', pairObtainedAt: h.clock.now(), scope: 's' })
    expect(h.store.record).not.toHaveProperty('expires')
    expect(h.store.record).not.toHaveProperty('chainOriginExpires')
    expect(h.marker()).toBeDefined()
    await put(h, legacyExchange('x-legacy-2'))
    expect(h.reports.filter((r) => r.context.kind === 'legacy_exchange')).toHaveLength(1)
  })

  it('replaces legacy, quarantined and unreadable records', async () => {
    const legacyHarness = createHarness()
    await legacyHarness.seedLegacy({ tokenInvalid: true })
    expect(await put(legacyHarness, legacyExchange())).toEqual({ status: 'stored' })
    expect(legacyHarness.store.record?.tokenInvalid).toBeUndefined()

    const quarantined = createHarness()
    await quarantined.seed({ needsReauth: { since: 1, reason: 'refresh_rejected', credFp: CRED_FP } })
    expect(await put(quarantined, legacyExchange())).toEqual({ status: 'stored' })
    expect(quarantined.store.record).not.toHaveProperty('refresh')
    expect(quarantined.store.record).not.toHaveProperty('needsReauth')

    const unreadable = createHarness()
    await unreadable.seed()
    unreadable.keyring.unknownKids.add('kid-a')
    expect(await put(unreadable, legacyExchange())).toEqual({ status: 'stored' })
  })

  it('never replaces a readable expiring record', async () => {
    const h = createHarness()
    const seeded = await h.seed()
    expect(await put(h, legacyExchange())).toEqual({ status: 'ignored_stale' })
    expect(h.store.record).toEqual(seeded)
    expect(h.reports.map((r) => r.context.code)).toContain('ignored')
  })

  it('is ignored and reported after the cutoff', async () => {
    const h = createHarness()
    h.clock.t = CUTOFF
    expect(await put(h, legacyExchange())).toEqual({ status: 'ignored_stale' })
    expect(h.store.record).toBeUndefined()
    expect(h.reports.map((r) => r.context.code)).toEqual(['after_cutoff'])
  })
})

describe('putSession: expiring library exchange without a refresh token (rule 6)', () => {
  it('accepts a newer one and drops the stored refresh token and alternates', async () => {
    const h = createHarness()
    await h.seed({ alternates: ['a1'] })
    const session = exchange(h, 1, {
      refreshToken: undefined,
      refreshTokenExpires: undefined,
      expires: h.clock.now() + 2 * HOUR,
    })
    expect(await put(h, session)).toEqual({ status: 'stored' })
    const record = h.store.record!
    expect(h.stored().token).toBe('x-access-1')
    for (const field of ['refresh', 'refreshFp', 'refreshExpires', 'alternates'] as const) {
      expect(record).not.toHaveProperty(field)
    }
    expect(record.source).toBe('exchange')
    expect(h.reports.map((r) => r.context.code)).toContain('missing_refresh_token')
    expect(h.alarm.deletes).toBeGreaterThan(0)
  })

  it('ignores one that is not newer', async () => {
    const h = createHarness()
    const seeded = await h.seed()
    const older = { shop: SHOP, accessToken: 'x-access-0', expires: seeded.expires! - MIN }
    expect(await put(h, older)).toEqual({ status: 'ignored_stale' })
    expect(h.store.record).toEqual(seeded)
  })

  it('creates a record when there is none', async () => {
    const h = createHarness()
    expect(await put(h, { shop: SHOP, accessToken: 'x', expires: h.clock.now() + HOUR })).toEqual({ status: 'stored' })
    expect(h.marker()).toBeDefined()
  })

  it('gives way to a later exchange that has a refresh token, whatever their expiries', async () => {
    const h = createHarness()
    const t = h.clock.now()
    // Two parallel loaders exchange; the response without refresh_token is stored first.
    expect(await put(h, { shop: SHOP, accessToken: 'xa-2', expires: t + HOUR + 1_000 })).toEqual({ status: 'stored' })
    expect(await put(h, exchange(h, 1, { expires: t + HOUR }))).toEqual({ status: 'stored' })
    expect(h.stored()).toMatchObject({ token: 'x-access-1', refresh: 'x-refresh-1' })
    expect(h.alarm.at).toBe(t + 30 * DAY)
    // Near expiry the object refreshes with it instead of answering needs_reauth.
    h.clock.advance(HOUR - 5 * MIN)
    h.tokens.onRefresh(success(h.clock, { access: 'access-3' }))
    expect(await h.get()).toMatchObject({ status: 'ok', session: { accessToken: 'access-3' } })
    expect(h.tokens.calls.map((call) => call.token)).toEqual(['x-refresh-1'])
  })

  it('keeps the alternates of a record without a refresh token that it replaces', async () => {
    const h = createHarness()
    await h.seed({ refresh: null, expires: h.clock.now() + 2 * HOUR, alternates: ['filed-earlier'] })
    expect(await put(h, exchange(h, 1))).toEqual({ status: 'stored' })
    expect(h.stored()).toMatchObject({ refresh: 'x-refresh-1', alternates: ['filed-earlier'] })
  })
})

describe('putSession: a throwing report function', () => {
  it('does not break storing a flag-off exchange or answering for an unreadable record', async () => {
    const h = createHarness()
    h.deps.report = () => {
      throw new Error('sentry down')
    }
    expect(await put(h, { shop: SHOP, accessToken: 'x-legacy' })).toEqual({ status: 'stored' })
    h.keyring.unknownKids.add('kid-a')
    expect(await h.get()).toMatchObject({ status: 'tokenless', reason: 'unreadable' })
  })
})

describe('reportUnauthorized', () => {
  it('marks the current token invalid only when the fingerprint matches', async () => {
    const h = createHarness()
    expect(await h.core.reportUnauthorized({ shop: SHOP, tokenFp: 'x' })).toEqual({ status: 'ignored_stale' })
    const seeded = await h.seed()
    expect(await h.core.reportUnauthorized({ shop: SHOP, tokenFp: await fingerprint('access-0') })).toEqual({
      status: 'ignored_stale',
    })
    expect(h.store.record?.tokenInvalid).toBeUndefined()
    expect(await h.core.reportUnauthorized({ shop: SHOP, tokenFp: seeded.tokenFp! })).toEqual({ status: 'marked' })
    expect(h.store.record?.tokenInvalid).toBe(true)
    expect(await h.core.reportUnauthorized({ shop: SHOP, tokenFp: seeded.tokenFp! })).toEqual({ status: 'marked' })
  })

  it('rejects another shop', async () => {
    const h = createHarness()
    await expect(h.core.reportUnauthorized({ shop: 'other.myshopify.com', tokenFp: 'x' })).rejects.toThrow(TypeError)
  })
})
