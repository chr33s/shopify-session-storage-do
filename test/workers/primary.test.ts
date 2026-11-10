// Application-only tokens as the primary offline session source (DESIGN.md §6.11).

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

import { exchangeSession, HOUR, MINUTE, clock, fake, newShop, stubFor, useFreshFake } from './helpers.js'
import type { Stub } from './helpers.js'

useFreshFake()

async function markInstalled(label: string): Promise<{ shop: string; stub: Stub }> {
  const shop = newShop(label)
  const stub = stubFor(shop, env.APP_TOKEN_PRIMARY)
  // The exchange registers the install with the fake (minting requires one); primary mode keeps only the marker.
  const result = await stub.putSession({ shop, session: exchangeSession(shop, fake.exchange(shop)) })
  expect(result.status).toBe('stored')
  expect(fake.callsFor(shop)).toEqual([])
  return { shop, stub }
}

describe('app-token primary mode', () => {
  it('mints for loadSession without a client secret and reuses the cache', async () => {
    const { shop, stub } = await markInstalled('primary-mint')

    const first = await stub.getSession({ shop, caller: 'library' })
    const [token] = fake.appTokensFor(shop)
    expect(first).toMatchObject({
      status: 'ok',
      source: 'app_token',
      session: { shop, accessToken: token },
    })
    expect(fake.callsFor(shop).map((call) => call.grant)).toEqual(['mint'])

    expect(await stub.getSession({ shop, caller: 'app' })).toMatchObject({
      session: { accessToken: token },
    })
    expect(fake.callsFor(shop, 'mint')).toHaveLength(1)
    expect(await stub.describe({ shop })).toMatchObject({
      source: 'app_token',
      signingKid: 'test-app-key-1',
      renewAfter: expect.any(Number),
    })
  })

  it('invalidateAndRefresh remints after a 401', async () => {
    const { shop, stub } = await markInstalled('primary-401')
    await stub.getSession({ shop, caller: 'library' })
    const [first] = fake.appTokensFor(shop)

    const refreshed = await stub.invalidateAndRefresh({ shop, failedAccessToken: first })
    expect(refreshed).toMatchObject({
      status: 'refreshed',
      session: { accessToken: fake.appTokensFor(shop)[1] },
    })
    expect(fake.callsFor(shop, 'mint')).toHaveLength(2)

    expect(await stub.invalidateAndRefresh({ shop, failedAccessToken: first })).toEqual({
      status: 'ignored_stale',
    })
  })

  it('remints once the renew window opens', async () => {
    const { shop, stub } = await markInstalled('primary-renew')
    await stub.getSession({ shop, caller: 'library' })
    expect(fake.appTokensFor(shop)).toHaveLength(1)

    // Lifetime is ~1 h; renewAfter is 3–8 minutes before expiry, so 58 minutes is always past it.
    clock.advance(58 * MINUTE)
    const renewed = await stub.getSession({ shop, caller: 'library' })
    expect(fake.appTokensFor(shop)).toHaveLength(2)
    expect(renewed).toMatchObject({
      source: 'app_token',
      session: { accessToken: fake.appTokensFor(shop)[1] },
    })
  })
})
