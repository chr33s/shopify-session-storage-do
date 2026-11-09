import { describe, expect, it } from 'vitest'
import { fingerprint } from '../../../src/fingerprint.js'
import { MINT_REJECTED_HOLD, without } from '../../../src/core/record.js'
import { ShopSessions } from '../../../src/core/shop-sessions.js'
import { CRED_FP, DAY, HOUR, MIN, SHOP, createHarness, failure, minted, settle, success } from './fakes.js'
import type { Harness } from './fakes.js'
import type { GetSessionResult } from '../../../src/types.js'

const APP_TOKEN = 'app-token-1'
const QUARANTINE = { since: 0, reason: 'refresh_rejected' as const, credFp: CRED_FP }

function appGet(h: Harness, minValidityMs?: number): Promise<GetSessionResult> {
  return h.get(minValidityMs, 'app')
}

/** A quarantined shop: the chain answers needs_reauth under the current credentials. */
async function quarantined(h: Harness) {
  return h.seed({ needsReauth: { ...QUARANTINE, since: h.clock.now() - DAY } })
}

async function appTokenAnswer(token: string, expires: number, scope?: string): Promise<GetSessionResult> {
  return {
    status: 'ok',
    session: { shop: SHOP, accessToken: token, expires, ...(scope === undefined ? {} : { scope }) },
    tokenFp: await fingerprint(token),
    source: 'app_token',
  }
}

describe('fallback: when it is used', () => {
  it('answers an app caller with an app token while the chain is quarantined, leaving the chain alone', async () => {
    const h = createHarness({ appTokens: true })
    const seeded = await quarantined(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN, { scope: 'read_products,write_orders' }))

    expect(await appGet(h)).toEqual(
      await appTokenAnswer(APP_TOKEN, h.clock.now() + 3599_000, 'read_products,write_orders'),
    )
    expect(h.appTokens!.calls).toEqual([SHOP])
    expect(h.tokens.calls).toEqual([])
    const record = h.store.record!
    expect(without(without(record, 'fallback'), 'appTokenFps')).toEqual(seeded)
    expect(record.fallback).toEqual({
      token: expect.anything(),
      tokenFp: await fingerprint(APP_TOKEN),
      expires: h.clock.now() + 3599_000,
      scope: 'read_products,write_orders',
      kid: 'sig-kid-1',
      obtainedAt: h.clock.now(),
    })
    expect(h.keyring.peek(record.fallback!.token)).toEqual({ aad: `${SHOP}|fallback`, plaintext: APP_TOKEN })
  })

  it('never answers the library with one, so its exchange can heal the chain', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    await appGet(h)
    expect(await h.get()).toEqual({ status: 'needs_reauth', since: h.clock.now() - DAY, reason: 'refresh_rejected' })
    expect(h.appTokens!.calls).toHaveLength(1)
  })

  it('stands in after the credFp retry of a quarantined chain is rejected (emergency secret revocation)', async () => {
    const h = createHarness({ appTokens: true })
    await h.seed({ needsReauth: { ...QUARANTINE, credFp: 'old-cred' } })
    h.tokens.onRefresh(failure(h.clock, 'terminal'))
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    expect(await appGet(h)).toMatchObject({ status: 'ok', source: 'app_token', session: { accessToken: APP_TOKEN } })
    expect(h.tokens.calls.map((c) => c.kind)).toEqual(['refresh'])
    expect(h.store.record?.needsReauth?.credFp).toBe(CRED_FP)
  })

  it('stands in when the token endpoint is unavailable and no token can be served', async () => {
    const h = createHarness({ appTokens: true })
    await h.seed({ expires: h.clock.now() - MIN })
    h.tokens.onRefresh(failure(h.clock, 'transient'))
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    expect(await appGet(h)).toMatchObject({ status: 'ok', source: 'app_token' })
    // The chain's failure is recorded as usual; the alarm retries it.
    expect(h.store.record?.failures).toMatchObject({ kind: 'transient', code: 'http_503' })
  })

  it('stands in for an expired token without a refresh token', async () => {
    const h = createHarness({ appTokens: true })
    await h.seed({ refresh: null, expires: h.clock.now() - MIN })
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    expect(await appGet(h)).toMatchObject({ status: 'ok', source: 'app_token' })
  })

  it('serves the chain when it can, without minting', async () => {
    const h = createHarness({ appTokens: true })
    await h.seed()
    const answer = await appGet(h)
    expect(answer).toMatchObject({ status: 'ok', session: { accessToken: 'access-1' } })
    expect(answer).not.toHaveProperty('source')
  })

  it('does not stand in for storage faults: unreadable, unusable legacy, failed import, no record', async () => {
    const unreadable = createHarness({ appTokens: true })
    await unreadable.seed()
    unreadable.keyring.unknownKids.add('kid-a')
    expect(await appGet(unreadable)).toMatchObject({ status: 'tokenless', reason: 'unreadable' })

    const legacy = createHarness({ appTokens: true })
    await legacy.seedLegacy({ tokenInvalid: true })
    expect(await appGet(legacy)).toMatchObject({ status: 'tokenless', reason: 'legacy_unusable' })

    const importFailed = createHarness({ appTokens: true, legacy: true })
    importFailed.legacyKv!.failNext = { op: 'get', error: new Error('KV GET failed: 503') }
    expect(await appGet(importFailed)).toEqual({ status: 'tokenless', reason: 'import_failed' })

    const none = createHarness({ appTokens: true })
    expect(await appGet(none)).toEqual({ status: 'none' })
    expect(none.store.record).toBeUndefined()
  })

  it('is off without an app token client', async () => {
    const h = createHarness()
    await quarantined(h)
    expect(await appGet(h)).toMatchObject({ status: 'needs_reauth' })
  })
})

describe('fallback: reuse and expiry', () => {
  it('reuses the stored token while it is valid for minValidity, then mints again', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN, { expiresIn: 3600 }))
    await appGet(h)
    h.clock.advance(50 * MIN)
    expect(await appGet(h)).toMatchObject({ session: { accessToken: APP_TOKEN } })
    expect(h.appTokens!.calls).toHaveLength(1)

    // 10 min left: below a 20 min minValidity, and soon below the 6 min floor.
    h.appTokens!.onMint(minted(h.clock, 'app-token-2'))
    expect(await appGet(h, 20 * MIN)).toMatchObject({ session: { accessToken: 'app-token-2' } })
    h.clock.advance(5 * MIN)
    expect(await appGet(h)).toMatchObject({ session: { accessToken: 'app-token-2' } })
    expect(h.appTokens!.calls).toHaveLength(2)
  })

  it('mints again when the stored token was sealed under a key since dropped', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    await appGet(h)
    h.store.record!.fallback!.token.kid = 'kid-gone'
    h.keyring.unknownKids.add('kid-gone')
    h.appTokens!.onMint(minted(h.clock, 'app-token-2'))
    expect(await appGet(h)).toMatchObject({ session: { accessToken: 'app-token-2' } })
  })

  it('defaults a missing expires_in to 30 min and reports it', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN, { expiresIn: null }))
    expect(await appGet(h)).toMatchObject({ session: { expires: h.clock.now() + 30 * MIN } })
    expect(h.reports.map((r) => r.context)).toContainEqual({
      shop: SHOP,
      op: 'mint',
      kind: 'success',
      code: 'missing_fields',
      requestId: 'req-mint',
    })
  })

  it('dates the expiry from when the request was sent', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    const d = h.appTokens!.deferMint()
    const sentAt = h.clock.now()
    const pending = appGet(h)
    await settle()
    h.clock.advance(100)
    d.resolve({ ...minted(h.clock, APP_TOKEN), sentAt })
    expect(await pending).toMatchObject({ session: { expires: sentAt + 3599_000 } })
  })
})

describe('fallback: one call at a time', () => {
  it('lets concurrent app callers share one mint', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    const d = h.appTokens!.deferMint()
    const answers = Promise.all([appGet(h), appGet(h), appGet(h)])
    await settle()
    d.resolve(minted(h.clock, APP_TOKEN))
    for (const answer of await answers) expect(answer).toMatchObject({ source: 'app_token' })
    expect(h.appTokens!.calls).toHaveLength(1)
  })

  it('mints alongside a refresh still in flight, without waiting past the request budget', async () => {
    const h = createHarness({ appTokens: true, callerWaitMs: 100 })
    await h.seed({ expires: h.clock.now() - MIN })
    const refresh = h.tokens.deferRefresh()
    const mint = h.appTokens!.deferMint()
    const started = Date.now()
    // The chain spends the whole budget waiting; the mint starts but isn't waited for.
    expect(await appGet(h)).toMatchObject({ status: 'tokenless', reason: 'token_endpoint' })
    expect(Date.now() - started).toBeLessThan(180)
    expect(h.appTokens!.calls).toHaveLength(1)
    // The refresh is rejected and the mint succeeds.
    refresh.resolve(failure(h.clock, 'terminal'))
    mint.resolve(minted(h.clock, APP_TOKEN))
    await h.drain()
    expect(await appGet(h)).toMatchObject({ source: 'app_token', session: { accessToken: APP_TOKEN } })
  })

  it('serves the chain when the refresh in flight succeeds during the mint', async () => {
    const h = createHarness({ appTokens: true, callerWaitMs: 100 })
    await h.seed({ expires: h.clock.now() - MIN })
    const refresh = h.tokens.deferRefresh()
    const mint = h.appTokens!.deferMint()
    await appGet(h)
    refresh.resolve(success(h.clock, { access: 'access-2' }))
    await settle()
    mint.resolve(minted(h.clock, APP_TOKEN))
    await h.drain()
    expect(h.store.record?.fallback).toBeUndefined()
    expect(await appGet(h)).toMatchObject({ session: { accessToken: 'access-2' } })
  })

  it('never makes a library caller, the alarm or a rollover wait on a mint', async () => {
    const h = createHarness({ appTokens: true, callerWaitMs: 5_000 })
    await h.seed({ expires: h.clock.now() - MIN })
    h.tokens.onRefresh(failure(h.clock, 'transient'))
    const mint = h.appTokens!.deferMint()
    const app = appGet(h)
    await h.tokens.waitForCalls(1)
    await settle()
    expect(h.appTokens!.calls).toHaveLength(1)
    // In cooldown, and the mint is no chain call to join: answered at once, no token call.
    const started = Date.now()
    expect(await h.get()).toMatchObject({ status: 'tokenless', reason: 'token_endpoint' })
    // A rollover makes its own call.
    h.tokens.onRefresh(success(h.clock, { access: 'access-2' }))
    expect(await h.core.rollover({ shop: SHOP, obtainedBefore: h.clock.now() + 1 })).toEqual({
      status: 'rolled',
      source: 'refresh',
    })
    expect(Date.now() - started).toBeLessThan(1_000)
    mint.resolve(minted(h.clock, APP_TOKEN))
    // The rollover healed the chain, so the mint is discarded.
    expect(await app).toMatchObject({ status: 'ok', session: { accessToken: 'access-2' } })
    expect(h.store.record?.fallback).toBeUndefined()
  })

  it('discards a mint when the chain changed meanwhile, and serves the new chain', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    const d = h.appTokens!.deferMint()
    const pending = appGet(h)
    await settle()
    await h.core.putSession({
      shop: SHOP,
      session: { shop: SHOP, accessToken: 'x-access', refreshToken: 'x-refresh', expires: h.clock.now() + HOUR },
    })
    d.resolve(minted(h.clock, APP_TOKEN))
    expect(await pending).toMatchObject({ status: 'ok', session: { accessToken: 'x-access' } })
    expect(h.store.record?.fallback).toBeUndefined()
  })
})

describe('fallback: cleared with the chain', () => {
  it('is dropped by an exchange', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    await appGet(h)
    await h.core.putSession({
      shop: SHOP,
      session: { shop: SHOP, accessToken: 'x-access', refreshToken: 'x-refresh', expires: h.clock.now() + HOUR },
    })
    expect(h.store.record?.fallback).toBeUndefined()
    expect(await appGet(h)).toMatchObject({ session: { accessToken: 'x-access' } })
  })

  it('is dropped by a refresh success', async () => {
    const h = createHarness({ appTokens: true })
    await h.seed({ expires: h.clock.now() - MIN })
    h.tokens.onRefresh(failure(h.clock, 'transient'))
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    await appGet(h)
    h.clock.advance(5 * MIN)
    h.tokens.onRefresh(success(h.clock, { access: 'access-2' }))
    expect(await appGet(h)).toMatchObject({ session: { accessToken: 'access-2' } })
    expect(h.store.record?.fallback).toBeUndefined()
  })

  it('stays through a quarantine and a failure, which leave the chain in place', async () => {
    const h = createHarness({ appTokens: true })
    await h.seed({ expires: h.clock.now() - MIN })
    h.tokens.onRefresh(failure(h.clock, 'transient'))
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    await appGet(h)
    h.clock.advance(5 * MIN)
    h.tokens.onRefresh(failure(h.clock, 'terminal'))
    expect(await appGet(h)).toMatchObject({ source: 'app_token', session: { accessToken: APP_TOKEN } })
    expect(h.store.record?.needsReauth).toBeDefined()
    expect(h.store.record?.fallback).toBeDefined()
  })

  it('is dropped by reportUnauthorized with its fingerprint, and minted again after a minute', async () => {
    const h = createHarness({ appTokens: true })
    const seeded = await quarantined(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    await appGet(h)
    const tokenFp = await fingerprint(APP_TOKEN)
    expect(await h.core.reportUnauthorized({ shop: SHOP, tokenFp })).toEqual({ status: 'marked' })
    expect(h.store.record).toEqual({ ...seeded, appTokenFps: [tokenFp] })
    expect(await h.core.reportUnauthorized({ shop: SHOP, tokenFp })).toEqual({ status: 'ignored_stale' })
    // A new token may be refused the same way: no mint straight away.
    expect(await appGet(h)).toMatchObject({ status: 'needs_reauth' })
    h.clock.advance(MIN)
    h.appTokens!.onMint(minted(h.clock, 'app-token-2'))
    expect(await appGet(h)).toMatchObject({ session: { accessToken: 'app-token-2' } })
  })

  it('is deleted by destroy', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    await appGet(h)
    expect(await h.core.destroy({ shop: SHOP })).toEqual({ status: 'deleted' })
    expect(await appGet(h)).toEqual({ status: 'none' })
  })
})

describe('fallback: failures', () => {
  it('answers as the chain would after a transient failure, and waits a minute before minting again', async () => {
    const h = createHarness({ appTokens: true })
    const seeded = await quarantined(h)
    h.appTokens!.onMint(failure(h.clock, 'transient'))
    expect(await appGet(h)).toMatchObject({ status: 'needs_reauth' })
    expect(h.store.record).toEqual(seeded)
    h.clock.advance(59_000)
    expect(await appGet(h)).toMatchObject({ status: 'needs_reauth' })
    expect(h.appTokens!.calls).toHaveLength(1)
    h.clock.advance(1_000)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    expect(await appGet(h)).toMatchObject({ source: 'app_token' })
  })

  it('honours a longer Retry-After', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(failure(h.clock, 'transient', { code: 'http_429', status: 429, retryAfterMs: 5 * MIN }))
    await appGet(h)
    h.clock.advance(4 * MIN)
    await appGet(h)
    expect(h.appTokens!.calls).toHaveLength(1)
    h.clock.advance(MIN)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    expect(await appGet(h)).toMatchObject({ source: 'app_token' })
  })

  it('backs off after a shop_unavailable answer or a thrown error like a transient one', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(failure(h.clock, 'shop_unavailable'), new Error('boom'))
    await appGet(h)
    h.clock.advance(MIN)
    await appGet(h)
    await appGet(h)
    expect(h.appTokens!.calls).toHaveLength(2)
  })

  it('reports a repeated transient failure once, then only logs it', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(failure(h.clock, 'transient'), failure(h.clock, 'transient'))
    await appGet(h)
    h.clock.advance(MIN)
    await appGet(h)
    const reports = h.reports.filter((r) => r.context.op === 'mint')
    expect(reports.map((r) => r.context)).toEqual([
      { shop: SHOP, op: 'mint', kind: 'transient', code: 'http_503', status: 503, requestId: 'req-fail' },
    ])
    expect(h.logs.filter((line) => line.includes('app token request failed'))).toHaveLength(2)
  })

  it('stops after a terminal answer, reporting it with status and code, holding off longer while it repeats', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(failure(h.clock, 'terminal', { code: 'invalid_client', status: 401 }))
    expect(await appGet(h)).toMatchObject({ status: 'needs_reauth' })
    const first = h.clock.now()
    h.clock.advance(MINT_REJECTED_HOLD - MIN)
    expect(await appGet(h)).toMatchObject({ status: 'needs_reauth' })
    expect(h.appTokens!.calls).toHaveLength(1)
    expect(h.reports.map((r) => r.context)).toEqual([
      { shop: SHOP, op: 'mint', kind: 'terminal', code: 'invalid_client', status: 401, requestId: 'req-fail' },
    ])
    expect(await h.core.describe({ shop: SHOP })).toMatchObject({
      mintRejected: { kid: 'sig-kid-1', since: first, retryAt: first + MINT_REJECTED_HOLD },
    })
    // Refused again: the hold is 4× longer.
    h.clock.advance(MIN)
    h.appTokens!.onMint(failure(h.clock, 'terminal', { code: 'invalid_client', status: 401 }))
    await appGet(h)
    expect(h.appTokens!.calls).toHaveLength(2)
    expect(h.store.record?.mintRejected).toMatchObject({
      first,
      count: 2,
      retryAt: h.clock.now() + 4 * MINT_REJECTED_HOLD,
    })
    h.clock.advance(4 * MINT_REJECTED_HOLD)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    expect(await appGet(h)).toMatchObject({ source: 'app_token' })
    expect(h.store.record?.mintRejected).toBeUndefined()
  })

  it('holds a repeated rejection for at most a day', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    for (let i = 0; i < 8; i++) {
      h.appTokens!.onMint(failure(h.clock, 'terminal'))
      await appGet(h)
      h.clock.advance(DAY)
    }
    expect(h.appTokens!.calls).toHaveLength(8)
    expect(h.store.record?.mintRejected?.retryAt).toBe(h.store.record!.mintRejected!.since + DAY)
  })

  it('keeps the terminal stop across an eviction', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(failure(h.clock, 'terminal'))
    await appGet(h)
    const fresh = new ShopSessions(h.deps, { callerWaitMs: 200 })
    expect(await fresh.getSession({ shop: SHOP, caller: 'app' })).toMatchObject({ status: 'needs_reauth' })
    expect(h.appTokens!.calls).toHaveLength(1)
    expect(h.reports.filter((r) => r.context.op === 'mint')).toHaveLength(1)
  })

  it('treats a configuration answer from Shopify (a redirect) like a terminal one', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(failure(h.clock, 'configuration', { code: 'redirect', status: 302 }))
    await appGet(h)
    h.clock.advance(MINT_REJECTED_HOLD - MIN)
    await appGet(h)
    expect(h.appTokens!.calls).toHaveLength(1)
    expect(h.reports[0]?.context).toMatchObject({ op: 'mint', kind: 'terminal', code: 'redirect' })
  })

  it('stores no rejection for a mint that never left (a key that cannot sign): it is held in memory', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(failure(h.clock, 'configuration', { code: 'sign_failed' }))
    await appGet(h)
    expect(h.store.record?.mintRejected).toBeUndefined()
    expect(h.reports[0]?.context).toMatchObject({ op: 'mint', kind: 'configuration', code: 'sign_failed' })
    await appGet(h)
    expect(h.appTokens!.calls).toHaveLength(1)
    h.clock.advance(MIN)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    expect(await appGet(h)).toMatchObject({ source: 'app_token' })
  })

  it('lifts the terminal stop when the signing key changes (a new deploy)', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(failure(h.clock, 'terminal'))
    await appGet(h)
    h.appTokens!.kid = 'sig-kid-2'
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    const fresh = new ShopSessions(h.deps, { callerWaitMs: 200 })
    expect(await fresh.getSession({ shop: SHOP, caller: 'app' })).toMatchObject({ source: 'app_token' })
  })

  it("lifts the terminal stop when the chain's tokens are replaced", async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(failure(h.clock, 'terminal'))
    await appGet(h)
    // A reinstall's exchange, whose pair then turns out unusable.
    await h.core.putSession({
      shop: SHOP,
      session: { shop: SHOP, accessToken: 'x-access', refreshToken: 'x-refresh', expires: h.clock.now() - MIN },
    })
    h.tokens.onRefresh(failure(h.clock, 'transient'))
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    expect(await appGet(h)).toMatchObject({ source: 'app_token' })
  })
})

describe('fallback: never the chain', () => {
  it('ignores an untagged copy of the app token instead of letting it replace the chain', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    const answer = await appGet(h)
    const before = structuredClone(h.store.record)
    // e.g. a cloned Session (the tag is lost) written back through storeSession.
    const session = { shop: SHOP, accessToken: APP_TOKEN, expires: h.clock.now() + HOUR, scope: 'read_products' }
    expect(await h.core.putSession({ shop: SHOP, session })).toEqual({ status: 'merged' })
    expect(h.store.record).toEqual(before)
    expect(await h.get()).toMatchObject({ status: 'needs_reauth' })
    expect(answer).toMatchObject({ source: 'app_token' })
  })

  it("drops the app token on the library's 401 write-back, and keeps it on a plain write-back", async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    await appGet(h)
    const issued = { tokenFp: await fingerprint(APP_TOKEN) }
    const back = { shop: SHOP, accessToken: APP_TOKEN, scope: 'write_everything' }
    expect(await h.core.putSession({ shop: SHOP, session: back, issued })).toEqual({ status: 'merged' })
    expect(h.store.record?.fallback).toBeDefined()
    expect(h.store.record?.scope).toBeUndefined()
    expect(await h.core.putSession({ shop: SHOP, session: { shop: SHOP }, issued })).toEqual({ status: 'merged' })
    expect(h.store.record?.fallback).toBeUndefined()
    expect(h.store.record?.tokenInvalid).toBeUndefined()
  })

  it('does not serve a token minted with another signing key', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    await appGet(h)
    h.appTokens!.kid = 'sig-kid-2'
    h.appTokens!.onMint(minted(h.clock, 'app-token-2'))
    expect(await appGet(h)).toMatchObject({ session: { accessToken: 'app-token-2' } })
    expect(h.store.record?.fallback?.kid).toBe('sig-kid-2')
  })

  it('answers none when the shop is destroyed during the mint', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    const mint = h.appTokens!.deferMint()
    const pending = appGet(h)
    await settle()
    await h.core.destroy({ shop: SHOP })
    mint.resolve(minted(h.clock, APP_TOKEN))
    expect(await pending).toEqual({ status: 'none' })
    expect(h.store.record).toBeUndefined()
  })

  it('serves a token shorter-lived than minValidity for the first half of its life', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN, { expiresIn: 30 * 60 }))
    expect(await appGet(h, 40 * MIN)).toMatchObject({ session: { accessToken: APP_TOKEN } })
    h.clock.advance(14 * MIN)
    expect(await appGet(h, 40 * MIN)).toMatchObject({ session: { accessToken: APP_TOKEN } })
    h.clock.advance(MIN)
    h.appTokens!.onMint(minted(h.clock, 'app-token-2', { expiresIn: 30 * 60 }))
    expect(await appGet(h, 40 * MIN)).toMatchObject({ session: { accessToken: 'app-token-2' } })
    expect(h.appTokens!.calls).toHaveLength(2)
  })
})

describe('fallback: review round 2', () => {
  const exchange = (_h: Harness, expires: number, refresh?: string) => ({
    shop: SHOP,
    session: { shop: SHOP, accessToken: `x-access-${expires}`, expires, ...(refresh ? { refreshToken: refresh } : {}) },
  })

  it('never lets a copy of an earlier app token replace the chain, even after an exchange', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN, { expiresIn: 3600 }))
    await appGet(h)
    h.clock.advance(55 * MIN)
    h.appTokens!.onMint(minted(h.clock, 'app-token-2', { expiresIn: 3600 }))
    expect(await appGet(h, 10 * MIN)).toMatchObject({ session: { accessToken: 'app-token-2' } })
    const old = { shop: SHOP, accessToken: APP_TOKEN, expires: h.clock.now() + 5 * MIN }
    expect(await h.core.putSession({ shop: SHOP, session: old })).toEqual({ status: 'merged' })
    expect(h.store.record?.needsReauth).toBeDefined()

    // The merchant opens the app; a job then writes back its old copy, which expires later than the new chain token.
    await h.core.putSession(exchange(h, h.clock.now() + 2 * MIN, 'x-refresh'))
    const late = { shop: SHOP, accessToken: 'app-token-2', expires: h.clock.now() + HOUR }
    expect(await h.core.putSession({ shop: SHOP, session: late })).toEqual({ status: 'merged' })
    expect(h.stored().refresh).toBe('x-refresh')
  })

  it('re-asks the chain for a caller that joined a mint discarded by an exchange', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    const mint = h.appTokens!.deferMint()
    const answers = Promise.all([appGet(h), appGet(h)])
    await settle()
    await h.core.putSession(exchange(h, h.clock.now() + HOUR, 'x-refresh'))
    mint.resolve(minted(h.clock, APP_TOKEN))
    for (const answer of await answers) {
      expect(answer).toMatchObject({ status: 'ok', session: { accessToken: `x-access-${h.clock.now() + HOUR}` } })
    }
  })

  it('mints again for the new chain when it still needs an app token', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    const first = h.appTokens!.deferMint()
    const pending = appGet(h)
    await settle()
    // A library exchange without a refresh token, with too little left to serve.
    await h.core.putSession(exchange(h, h.clock.now() + 2 * MIN))
    h.appTokens!.onMint(minted(h.clock, 'app-token-2'))
    first.resolve(minted(h.clock, APP_TOKEN))
    expect(await pending).toMatchObject({ source: 'app_token', session: { accessToken: 'app-token-2' } })
  })

  it('only logs a rejection that was discarded with its chain', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    const mint = h.appTokens!.deferMint()
    const pending = appGet(h)
    await settle()
    await h.core.putSession(exchange(h, h.clock.now() + HOUR, 'x-refresh'))
    mint.resolve(failure(h.clock, 'terminal'))
    await pending
    expect(h.reports.filter((r) => r.context.op === 'mint')).toEqual([])
    expect(h.logs.some((line) => line.includes('app token request failed'))).toBe(true)
    expect(h.store.record?.mintRejected).toBeUndefined()
  })

  it('serves a token that lives 6 minutes or less', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN, { expiresIn: 300 }))
    expect(await appGet(h)).toMatchObject({ session: { accessToken: APP_TOKEN } })
    h.clock.advance(2 * MIN)
    expect(await appGet(h)).toMatchObject({ session: { accessToken: APP_TOKEN } })
    expect(h.appTokens!.calls).toHaveLength(1)
  })
})

describe('getSession: wait budget', () => {
  it('starts the wait at the first token call, not before a slow legacy import', async () => {
    const h = createHarness({ legacy: true, callerWaitMs: 100 })
    h.legacyKv!.setJson(`offline_${SHOP}`, [
      ['accessToken', 'old-access'],
      ['expires', h.clock.now() - MIN],
      ['refreshToken', 'old-refresh'],
    ])
    h.legacyKv!.holdGet = () => new Promise((resolve) => setTimeout(resolve, 150))
    const refresh = h.tokens.deferRefresh()
    const pending = h.get()
    await h.tokens.waitForCalls(1)
    setTimeout(() => refresh.resolve(success(h.clock, { access: 'access-2' })), 50)
    expect(await pending).toMatchObject({ status: 'ok', session: { accessToken: 'access-2' } })
  })
})

describe('fallback: describe', () => {
  it('shows the fallback kid and expiry, and its sealing key among the kids', async () => {
    const h = createHarness({ appTokens: true })
    await quarantined(h)
    h.appTokens!.onMint(minted(h.clock, APP_TOKEN))
    await appGet(h)
    h.keyring.currentKid = 'kid-b'
    await h.core.reportUnauthorized({ shop: SHOP, tokenFp: await fingerprint(APP_TOKEN) })
    h.clock.advance(MIN)
    h.appTokens!.onMint(minted(h.clock, 'app-token-2'))
    await appGet(h)
    const status = await h.core.describe({ shop: SHOP })
    expect(status.fallback).toEqual({ kid: 'sig-kid-1', expires: h.clock.now() + 3599_000 })
    expect(status.kids).toEqual(['kid-a', 'kid-b'])
    expect(JSON.stringify(status)).not.toContain('app-token')
  })
})
