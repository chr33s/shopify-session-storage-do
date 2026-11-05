import { abortAllDurableObjects, evictDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import {
  HOUR,
  MINUTE,
  clock,
  exchangeSession,
  fake,
  inspect,
  installShop,
  marker,
  newShop,
  settle,
  stubFor,
  useFreshFake,
  waitFor,
} from './helpers.js'
import type { Stub } from './helpers.js'

useFreshFake()

async function accessToken(stub: Stub, shop: string): Promise<string | undefined> {
  const result = await stub.getSession({ shop, caller: 'app' })
  return result.status === 'ok' ? result.session.accessToken : undefined
}

describe('refresh single flight', () => {
  it('makes one refresh for concurrent loads from separate stubs', async () => {
    const shop = newShop('concurrent')
    await installShop(shop, 2 * MINUTE)
    fake.delayMs = 150

    const results = await Promise.all(
      Array.from({ length: 6 }, () => stubFor(shop).getSession({ shop, caller: 'library' })),
    )

    expect(fake.callsFor(shop, 'refresh')).toHaveLength(1)
    const refreshed = fake.lastPair(shop)
    for (const result of results) {
      expect(result).toMatchObject({ status: 'ok', session: { shop, accessToken: refreshed.accessToken } })
    }
  })
})

describe('exchange races', () => {
  // Shopify processed exchange `first` and then `second`, which retired `first`'s refresh token. The library computed
  // `first`'s expiry later, so by expiry `first` looks newer and becomes current: only the alternate keeps the chain.
  for (const order of ['first, second', 'second, first'] as const) {
    it(`keeps the live chain when the exchanges arrive ${order}`, async () => {
      const shop = newShop('exchanges')
      const stub = stubFor(shop)
      const first = fake.exchange(shop)
      const second = fake.exchange(shop)
      expect(fake.isLive(first.refreshToken)).toBe(false)
      const sessions = {
        first: exchangeSession(shop, first, 2 * MINUTE + 10_000),
        second: exchangeSession(shop, second, 2 * MINUTE),
      }
      for (const name of order.split(', ') as ('first' | 'second')[]) {
        expect((await stub.putSession({ shop, session: sessions[name] })).status).toMatch(/stored|merged/)
      }
      expect(await stub.describe({ shop })).toMatchObject({ source: 'exchange', alternates: 1 })

      // Two minutes left is under the hard floor: this load refreshes.
      const token = await accessToken(stub, shop)

      expect(fake.callsFor(shop, 'refresh').map((call) => [call.presented, call.status])).toEqual([
        [first.refreshToken, 401],
        [second.refreshToken, 200],
      ])
      const refreshed = fake.lastPair(shop)
      expect(token).toBe(refreshed.accessToken)
      const status = await stub.describe({ shop })
      expect(status).toMatchObject({ state: 'ok', source: 'refresh' })
      expect(status.alternates ?? 0).toBe(0)
      expect(status.needsReauth).toBeUndefined()

      // The chain keeps rotating from the alternate's descendant.
      clock.advance(HOUR)
      const next = await accessToken(stub, shop)
      expect(fake.callsFor(shop, 'refresh').at(-1)).toMatchObject({ presented: refreshed.refreshToken, status: 200 })
      expect(next).toBe(fake.lastPair(shop).accessToken)
    })
  }
})

describe('instance loss during a refresh', () => {
  it('keeps the record consistent when the object is evicted during a background refresh', async () => {
    const shop = newShop('evicted')
    // Ten minutes left: served as is, refreshed in the background.
    const { stub, pair } = await installShop(shop, 10 * MINUTE)
    const hold = fake.hold(shop)

    expect(await accessToken(stub, shop)).toBe(pair.accessToken)
    await hold.waitReached()
    const issued = fake.lastPair(shop)
    expect(issued).not.toEqual(pair)

    // Eviction drains outstanding work (with a timeout), so let Shopify's answer arrive while it is under way.
    const eviction = evictDurableObject(stub)
    await new Promise((resolve) => setTimeout(resolve, 50))
    hold.release()
    await eviction

    // Whether the old instance stored the pair or not, the next one serves it without minting another.
    await waitFor(async () => (await accessToken(stubFor(shop), shop)) === issued.accessToken, 'the issued pair')
    expect(await stubFor(shop).describe({ shop })).toMatchObject({ state: 'ok', source: 'refresh' })
    expect(fake.pairsFor(shop)).toEqual([pair, issued])
    for (const call of fake.callsFor(shop)) expect(call).toMatchObject({ presented: pair.refreshToken, status: 200 })
    expect(fake.isLive(issued.refreshToken)).toBe(true)
  })

  it('recovers after an abort while a caller waits on the refresh', async () => {
    const shop = newShop('aborted')
    const { stub, pair } = await installShop(shop, 2 * MINUTE)
    const hold = fake.hold(shop)

    // Handled from the start: the abort rejects it before the test gets back to it.
    const waiting = stub.getSession({ shop, caller: 'library' }).catch((error: unknown) => error)
    await hold.waitReached()
    const issued = fake.lastPair(shop)
    await abortAllDurableObjects()
    expect(await waiting).toBeInstanceOf(Error)
    hold.release()

    expect(await accessToken(stubFor(shop), shop)).toBe(issued.accessToken)
    expect(fake.callsFor(shop, 'refresh').map((call) => call.presented)).toEqual([pair.refreshToken, pair.refreshToken])
    expect(fake.isLive(issued.refreshToken)).toBe(true)
  })
})

describe('destroy during a refresh', () => {
  it('does not resurrect the record when the refresh lands after the delete', async () => {
    const shop = newShop('destroyed')
    const { stub, pair } = await installShop(shop, 10 * MINUTE)
    const hold = fake.hold(shop)

    expect(await accessToken(stub, shop)).toBe(pair.accessToken)
    await hold.waitReached()
    expect(await stub.destroy({ shop })).toEqual({ status: 'deleted' })
    hold.release()
    await settle(stub)

    expect(await inspect(stub)).toEqual({ keys: [], alarm: null })
    expect(await stub.describe({ shop })).toMatchObject({ exists: false, state: 'none' })
    expect(await marker(shop)).toMatchObject({ value: null })
    await waitFor(async () => fake.callsFor(shop).length === 1, 'the refresh call')
  })
})
