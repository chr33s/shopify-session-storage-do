import { Session } from '@shopify/shopify-api'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

import { DurableObjectSessionStorage } from '../../src/index.js'
import { DAY, HOUR, MINUTE, clock, fake, newShop, useFreshFake } from './helpers.js'

useFreshFake()

function storage(): DurableObjectSessionStorage {
  return new DurableObjectSessionStorage({ namespace: env.SHOP_SESSIONS })
}

describe('DurableObjectSessionStorage against the real object', () => {
  it('stores an exchange, loads it without the refresh token, and refreshes after invalidateAccessToken', async () => {
    const shop = newShop('adapter')
    const id = `offline_${shop}`
    const pair = fake.exchange(shop)
    const exchanged = new Session({
      id,
      shop,
      state: '',
      isOnline: false,
      scope: pair.scope,
      accessToken: pair.accessToken,
      expires: new Date(clock.now() + HOUR),
      refreshToken: pair.refreshToken,
      refreshTokenExpires: new Date(clock.now() + 90 * DAY),
    })

    expect(await storage().storeSession(exchanged)).toBe(true)
    expect(exchanged.refreshToken).toBeUndefined()
    expect(exchanged.refreshTokenExpires).toBeUndefined()

    const loaded = await storage().loadSession(id)
    expect(loaded).toBeInstanceOf(Session)
    expect(loaded).toMatchObject({ id, shop, isOnline: false, accessToken: pair.accessToken, scope: pair.scope })
    expect(loaded?.expires).toBeInstanceOf(Date)
    expect(loaded?.refreshToken).toBeUndefined()

    // What the library's invalidateAccessToken stores after an Admin API 401.
    loaded!.accessToken = undefined
    expect(await storage().storeSession(loaded!)).toBe(true)
    expect(await storage().describe(shop)).toMatchObject({ tokenInvalid: true })

    const refreshed = await storage().loadSession(id)
    expect(refreshed?.accessToken).toBe(fake.lastPair(shop).accessToken)
    expect(fake.callsFor(shop)).toEqual([{ shop, grant: 'refresh', presented: pair.refreshToken, status: 200 }])
  })

  it('serves app code through loadOfflineSession and reportUnauthorized, then deletes the shop', async () => {
    const shop = newShop('adapter-app')
    const pair = fake.exchange(shop)
    const sessions = storage()
    await sessions.storeSession(
      new Session({
        id: `offline_${shop}`,
        shop,
        state: '',
        isOnline: false,
        scope: pair.scope,
        accessToken: pair.accessToken,
        expires: new Date(clock.now() + 30 * MINUTE),
        refreshToken: pair.refreshToken,
        refreshTokenExpires: new Date(clock.now() + 90 * DAY),
      }),
    )

    const first = await sessions.loadOfflineSession(shop)
    expect(first).toMatchObject({ status: 'ok', session: { accessToken: pair.accessToken } })
    expect(fake.calls).toEqual([])
    // A job that needs 40 minutes gets a token that lasts them.
    const longer = await sessions.loadOfflineSession(shop, { minValidityMs: 40 * MINUTE })
    const second = fake.lastPair(shop)
    expect(longer).toMatchObject({ status: 'ok', session: { accessToken: second.accessToken } })
    expect(fake.callsFor(shop, 'refresh')).toHaveLength(1)

    // A background 401 on the token makes the next load refresh again.
    if (longer.status !== 'ok') throw new Error('unreachable')
    await sessions.reportUnauthorized(longer.session)
    const after = await sessions.loadOfflineSession(shop)
    expect(after).toMatchObject({ status: 'ok', session: { accessToken: fake.lastPair(shop).accessToken } })
    expect(fake.callsFor(shop, 'refresh').map((call) => call.presented)).toEqual([
      pair.refreshToken,
      second.refreshToken,
    ])

    expect(await sessions.deleteShop(shop, { uninstalledAt: new Date(clock.now()) })).toEqual({ status: 'deleted' })
    expect(await sessions.loadOfflineSession(shop)).toEqual({ status: 'none' })
    expect(await sessions.loadSession(`offline_${shop}`)).toBeUndefined()
  })
})
