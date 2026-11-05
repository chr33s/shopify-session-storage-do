import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

import { rolloverShops } from '../../src/rollover.js'
import type { KVNamespaceLike } from '../../src/types.js'
import { MINUTE, clock, fake, installShop, newShop, putLegacy, stubFor, useFreshFake } from './helpers.js'

useFreshFake()

/**
 * The registry the sweep lists, holding only this test's shops: the objects' own markers go to the shared REGISTRY,
 * where other tests' shops would be swept too.
 */
function registryOf(shops: string[]): KVNamespaceLike & { values: Map<string, string> } {
  const values = new Map(shops.map((shop) => [`shop-session:${shop}`, '']))
  return {
    values,
    async get(key) {
      const value = values.get(key)
      return value === undefined ? null : JSON.parse(value)
    },
    async put(key, value) {
      values.set(key, value)
    },
    async delete(key) {
      values.delete(key)
    },
    async list(options = {}) {
      const keys = [...values.keys()].filter((key) => key.startsWith(options.prefix ?? '')).sort()
      return { keys: keys.map((name) => ({ name })), list_complete: true }
    },
  }
}

describe('rollover', () => {
  it('retires a leaked refresh token in two passes', async () => {
    const shop = newShop('leak')
    const { stub, pair } = await installShop(shop)

    clock.advance(MINUTE)
    expect(await stub.rollover({ shop, obtainedBefore: clock.now() })).toEqual({ status: 'rolled', source: 'refresh' })
    // Shopify keeps a presented refresh token usable until its replacement is presented.
    expect(fake.isLive(pair.refreshToken)).toBe(true)
    const first = fake.lastPair(shop)

    clock.advance(MINUTE)
    // The clock runs in real time, so the pass's cut is captured once.
    const secondPass = clock.now()
    expect(await stub.rollover({ shop, obtainedBefore: secondPass })).toEqual({ status: 'rolled', source: 'refresh' })
    expect(fake.isLive(pair.refreshToken)).toBe(false)
    expect(fake.isLive(first.refreshToken)).toBe(true)
    expect(fake.callsFor(shop, 'refresh').map((call) => call.presented)).toEqual([
      pair.refreshToken,
      first.refreshToken,
    ])

    // Asked again in the same pass, the pair is current.
    expect(await stub.rollover({ shop, obtainedBefore: secondPass })).toEqual({ status: 'current' })
    expect(fake.callsFor(shop, 'refresh')).toHaveLength(2)
  })

  it('sweeps a fleet of expiring and legacy shops through the real objects', async () => {
    const expiring = [newShop('fleet'), newShop('fleet')]
    for (const shop of expiring) await installShop(shop)
    const legacy = newShop('fleet-legacy')
    const legacyToken = fake.legacyToken(legacy)
    await putLegacy(legacy, { scope: 'read_products', accessToken: legacyToken })
    expect(await stubFor(legacy).importLegacy({ shop: legacy })).toEqual({ status: 'imported' })

    clock.advance(MINUTE)
    const registry = registryOf([...expiring, legacy])
    registry.values.set('shop-sessions:rollover', JSON.stringify({ obtainedBefore: clock.now() }))
    const result = await rolloverShops({ kv: registry, namespace: env.SHOP_SESSIONS, now: () => clock.now() })

    expect(result).toMatchObject({ status: 'done', attempted: 3, outcomes: { rolled: 3 } })
    expect(fake.callsFor(legacy)).toEqual([{ shop: legacy, grant: 'migrate', presented: legacyToken, status: 200 }])
    for (const shop of [...expiring, legacy]) {
      expect(await stubFor(shop).describe({ shop })).toMatchObject({ state: 'ok' })
    }
    expect(registry.values.has('shop-sessions:rollover')).toBe(false)
  })
})
