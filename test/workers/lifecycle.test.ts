import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

import type { ShopSessionsDurableObject } from '../../src/durable-object.js'
import {
  DAY,
  HOUR,
  MINUTE,
  clock,
  exchangeSession,
  fake,
  inspect,
  installShop,
  legacyKeys,
  marker,
  newShop,
  putLegacy,
  stubFor,
  useFreshFake,
} from './helpers.js'
import type { Stub } from './helpers.js'

useFreshFake()

/** Moves the clock to the object's next alarm and runs it. */
async function runNextAlarm(stub: Stub, shop: string): Promise<void> {
  const { nextAlarmAt } = await stub.describe({ shop })
  if (typeof nextAlarmAt !== 'number') throw new Error('no alarm scheduled')
  clock.advance(Math.max(0, nextAlarmAt - clock.now()))
  expect(await runDurableObjectAlarm(stub)).toBe(true)
}

describe('keepalive alarm', () => {
  it('refreshes 30 days after the pair was obtained and schedules the next keepalive', async () => {
    const shop = newShop('keepalive')
    const { stub, pair } = await installShop(shop)
    const before = await stub.describe({ shop })
    expect(before.nextAlarmAt).toBe(before.pairObtainedAt! + 30 * DAY)

    await runNextAlarm(stub, shop)

    expect(fake.callsFor(shop)).toEqual([{ shop, grant: 'refresh', presented: pair.refreshToken, status: 200 }])
    const after = await stub.describe({ shop })
    expect(after).toMatchObject({ state: 'ok', source: 'refresh' })
    expect(after.pairObtainedAt).toBeGreaterThanOrEqual(before.pairObtainedAt! + 30 * DAY)
    expect(after.refreshTokenExpiresAt).toBe(after.pairObtainedAt! + 90 * DAY)
    expect(after.nextAlarmAt).toBe(after.pairObtainedAt! + 30 * DAY)
    expect(await stub.getSession({ shop, caller: 'app' })).toMatchObject({
      status: 'ok',
      session: { accessToken: fake.lastPair(shop).accessToken },
    })
  })

  it('backs off after a failed keepalive and succeeds on the retry', async () => {
    const shop = newShop('keepalive-retry')
    const { stub, pair } = await installShop(shop)
    fake.script(shop, { status: 503, json: { errors: 'unavailable' } })

    await runNextAlarm(stub, shop)
    const failing = await stub.describe({ shop })
    expect(failing).toMatchObject({ state: 'failing', failures: { count: 1, kind: 'transient', code: 'http_503' } })
    // The alarm floor (now + 1 min) is computed a moment after retryAt, so it can land a few ms later.
    expect(failing.nextAlarmAt! - failing.failures!.retryAt).toBeGreaterThanOrEqual(0)
    expect(failing.nextAlarmAt! - failing.failures!.retryAt).toBeLessThan(1_000)
    expect(failing.failures!.retryAt - failing.failures!.since).toBe(MINUTE)

    await runNextAlarm(stub, shop)
    expect(fake.callsFor(shop).map((call) => [call.presented, call.status])).toEqual([
      [pair.refreshToken, 503],
      [pair.refreshToken, 200],
    ])
    const recovered = await stub.describe({ shop })
    expect(recovered).toMatchObject({ state: 'ok', source: 'refresh' })
    expect(recovered.failures).toBeUndefined()
  })
})

describe('legacy tokens', () => {
  it('imports a legacy token on first load, serves it, then migrates it from the alarm', async () => {
    const shop = newShop('legacy')
    const legacy = fake.legacyToken(shop)
    await putLegacy(shop, { scope: 'read_products', accessToken: legacy })
    const stub = stubFor(shop)

    const loaded = await stub.getSession({ shop, caller: 'library' })
    expect(loaded).toMatchObject({ status: 'ok', session: { shop, scope: 'read_products', accessToken: legacy } })
    expect(loaded.status === 'ok' && 'expires' in loaded.session).toBe(false)
    // The KV copy stays until the token is migrated.
    expect(await legacyKeys(shop)).toEqual([`offline_${shop}`, `shop:${shop}`])
    const imported = await stub.describe({ shop })
    expect(imported).toMatchObject({ exists: true, state: 'legacy', source: 'import' })
    expect(imported.nextAlarmAt).toBe(imported.pairObtainedAt! + 5 * MINUTE)
    expect(await marker(shop)).toMatchObject({ value: '', metadata: { since: imported.pairObtainedAt } })

    await runNextAlarm(stub, shop)

    expect(fake.callsFor(shop)).toEqual([{ shop, grant: 'migrate', presented: legacy, status: 200 }])
    const migrated = fake.lastPair(shop)
    const status = await stub.describe({ shop })
    expect(status).toMatchObject({ state: 'ok', source: 'migrate' })
    expect(await legacyKeys(shop)).toEqual([])
    expect(await stub.getSession({ shop, caller: 'library' })).toMatchObject({
      status: 'ok',
      session: { accessToken: migrated.accessToken, expires: status.pairObtainedAt! + HOUR },
    })
  })

  it('finishes a migration whose response was lost by replaying the identical request', async () => {
    const shop = newShop('legacy-replay')
    const legacy = fake.legacyToken(shop)
    await putLegacy(shop, { scope: 'read_products', accessToken: legacy })
    const stub = stubFor(shop)
    expect(await stub.importLegacy({ shop })).toEqual({ status: 'imported' })

    // Shopify migrates the token (retiring it) but the answer never arrives.
    fake.script(shop, { status: 502, text: '<html>Bad gateway</html>', processed: true })
    await runNextAlarm(stub, shop)
    const issued = fake.lastPair(shop)
    expect(fake.isLive(issued.refreshToken)).toBe(true)

    // The legacy token may already be dead, so it isn't served while the outcome is unknown.
    expect(await stub.getSession({ shop, caller: 'library' })).toMatchObject({
      status: 'tokenless',
      reason: 'legacy_unusable',
    })
    expect((await stub.describe({ shop })).failures).toMatchObject({ code: 'http_502', ambiguous: true })

    await runNextAlarm(stub, shop)

    expect(fake.callsFor(shop).map((call) => [call.grant, call.presented, call.status])).toEqual([
      ['migrate', legacy, 502],
      ['migrate', legacy, 200],
    ])
    expect(fake.pairsFor(shop)).toEqual([issued])
    expect(await stub.getSession({ shop, caller: 'library' })).toMatchObject({
      status: 'ok',
      session: { accessToken: issued.accessToken },
    })
    expect(await legacyKeys(shop)).toEqual([])
  })

  it('imports an expiring legacy session from the KV binding and deletes the KV copy', async () => {
    const shop = newShop('import')
    const pair = fake.exchange(shop)
    const now = clock.now()
    await putLegacy(shop, {
      scope: pair.scope,
      accessToken: pair.accessToken,
      expires: now + HOUR,
      refreshToken: pair.refreshToken,
      refreshTokenExpires: now + 90 * DAY,
    })
    const stub = stubFor(shop)

    expect(await stub.importLegacy({ shop })).toEqual({ status: 'imported' })
    expect(await legacyKeys(shop)).toEqual([])
    expect(await stub.importLegacy({ shop })).toEqual({ status: 'already_present' })
    expect(await stub.describe({ shop })).toMatchObject({
      state: 'ok',
      source: 'import',
      accessTokenExpiresAt: now + HOUR,
    })
    expect(await stub.getSession({ shop, caller: 'library' })).toMatchObject({
      status: 'ok',
      session: { accessToken: pair.accessToken, expires: now + HOUR },
    })

    // The imported refresh token carries the chain on.
    clock.advance(HOUR)
    expect(await stub.getSession({ shop, caller: 'library' })).toMatchObject({
      status: 'ok',
      session: { accessToken: fake.lastPair(shop).accessToken },
    })
    expect(fake.callsFor(shop)).toEqual([{ shop, grant: 'refresh', presented: pair.refreshToken, status: 200 }])
  })

  it('deletes a legacy value that is not JSON', async () => {
    const shop = newShop('import-invalid')
    await env.LEGACY.put(`offline_${shop}`, '{not json')
    await env.LEGACY.put(`shop:${shop}`, JSON.stringify([`offline_${shop}`]))

    expect(await stubFor(shop).importLegacy({ shop })).toEqual({ status: 'invalid' })
    expect(await legacyKeys(shop)).toEqual([])
    expect(await stubFor(shop).getSession({ shop, caller: 'library' })).toEqual({ status: 'none' })
  })

  it('lets a library exchange win over a concurrent legacy import, in either order', async () => {
    const shop = newShop('import-race')
    await putLegacy(shop, { scope: 'read_products', accessToken: fake.legacyToken(shop) })
    const pair = fake.exchange(shop)

    const [imported, stored] = await Promise.all([
      stubFor(shop).importLegacy({ shop }),
      stubFor(shop).putSession({ shop, session: exchangeSession(shop, pair) }),
    ])
    expect(['imported', 'already_present', 'none']).toContain(imported.status)
    expect(stored).toEqual({ status: 'stored' })

    const stub = stubFor(shop)
    expect(await stub.describe({ shop })).toMatchObject({ state: 'ok', source: 'exchange' })
    expect(await stub.getSession({ shop, caller: 'library' })).toMatchObject({
      status: 'ok',
      session: { accessToken: pair.accessToken },
    })
    // The leftover KV copy goes with the next import attempt (or alarm) now the record isn't legacy.
    expect(await stub.importLegacy({ shop })).toEqual({ status: 'already_present' })
    expect(await legacyKeys(shop)).toEqual([])
  })
})

describe('destroy', () => {
  it('deletes the record, the alarm, the registry marker and leftover legacy keys', async () => {
    const shop = newShop('destroy')
    const { stub } = await installShop(shop)
    await putLegacy(shop, { accessToken: 'shpat_leftover' })
    expect((await inspect(stub)).alarm).not.toBeNull()
    expect(await marker(shop)).toMatchObject({ value: '' })

    expect(await stub.destroy({ shop })).toEqual({ status: 'deleted' })

    expect(await inspect(stub)).toEqual({ keys: [], alarm: null })
    expect(await marker(shop)).toMatchObject({ value: null })
    expect(await legacyKeys(shop)).toEqual([])
    expect(await stub.getSession({ shop, caller: 'library' })).toEqual({ status: 'none' })
    expect(fake.calls).toEqual([])
  })

  it('needs its explicit deleteAlarm() at this compatibility date', async () => {
    const alarm = await runInDurableObject(
      stubFor(newShop('platform')),
      async (_: ShopSessionsDurableObject, state) => {
        await state.storage.put('probe', 1)
        await state.storage.setAlarm(Date.now() + DAY)
        await state.storage.deleteAll()
        const left = await state.storage.getAlarm()
        await state.storage.deleteAlarm()
        return left
      },
    )
    // deleteAll() removes the alarm only from compatibility date 2026-02-24.
    if (env.TEST_COMPATIBILITY_DATE < '2026-02-24') expect(alarm).not.toBeNull()
    else expect(alarm).toBeNull()
  })
})

describe('registry marker', () => {
  it('is written on creation, restored by the alarm, kept for a reinstall and deleted by destroy', async () => {
    const shop = newShop('registry')
    const { stub } = await installShop(shop)
    const created = await stub.describe({ shop })
    expect(await marker(shop)).toMatchObject({ value: '', metadata: { since: created.pairObtainedAt } })

    await env.REGISTRY.delete(`shop-session:${shop}`)
    await runNextAlarm(stub, shop)
    const refreshed = await stub.describe({ shop })
    expect(await marker(shop)).toMatchObject({ value: '', metadata: { since: refreshed.pairObtainedAt } })

    // An uninstall from before the current pair was obtained (the shop reinstalled since) changes nothing.
    const staleUninstall = refreshed.pairObtainedAt! - 5 * MINUTE
    expect(await stub.destroy({ shop, uninstalledAt: staleUninstall })).toEqual({ status: 'kept_newer_install' })
    expect(await marker(shop)).toMatchObject({ value: '' })
    expect(await stub.describe({ shop })).toMatchObject({ exists: true })

    expect(await stub.destroy({ shop, uninstalledAt: clock.now() })).toEqual({ status: 'deleted' })
    expect(await marker(shop)).toMatchObject({ value: null })
  })
})
