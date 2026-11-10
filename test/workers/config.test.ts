import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

import { createKeyring } from '../../src/crypto.js'
import type { ShopSessionsDurableObject } from '../../src/durable-object.js'
import { credentialFingerprint, fingerprint } from '../../src/fingerprint.js'
import type { ShopRecord } from '../../src/types.js'
import { DAY, HOUR, MINUTE, clock, fake, installShop, newShop, stubFor, useFreshFake } from './helpers.js'
import type { Stub } from './helpers.js'

useFreshFake()

function everyRpc(stub: Stub, shop: string): [string, () => Promise<unknown>][] {
  return [
    ['getSession', () => stub.getSession({ shop, caller: 'library' })],
    ['putSession', () => stub.putSession({ shop, session: { shop, accessToken: 'shpat_x', expires: Date.now() } })],
    ['reportUnauthorized', () => stub.reportUnauthorized({ shop, tokenFp: 'fp' })],
    ['destroy', () => stub.destroy({ shop })],
    ['importLegacy', () => stub.importLegacy({ shop })],
    ['describe', () => stub.describe({ shop })],
  ]
}

async function rejection(call: () => Promise<unknown>): Promise<Error> {
  const outcome = await call().then(
    () => undefined,
    (error: unknown) => error,
  )
  if (!(outcome instanceof Error)) throw new Error('expected the call to throw')
  return outcome
}

describe('configuration', () => {
  it('fails closed on every call with a malformed keyring, without echoing it', async () => {
    const shop = newShop('broken-keyring')
    const stub = stubFor(shop, env.BROKEN_KEYRING)
    for (const [name, call] of everyRpc(stub, shop)) {
      const error = await rejection(call)
      expect(error.message, name).toMatch(/SHOPIFY_SESSION_ENCRYPTION_KEYS entry 1/)
      expect(error.message, name).not.toContain('bm90IGEga2V5')
    }
    expect(await runInDurableObject(stub, (_: ShopSessionsDurableObject, state) => state.storage.list())).toEqual(
      new Map(),
    )
  })

  it('fails closed on every call without the API secret', async () => {
    const shop = newShop('no-credentials')
    const stub = stubFor(shop, env.NO_CREDENTIALS)
    for (const [name, call] of everyRpc(stub, shop)) {
      expect((await rejection(call)).message, name).toMatch(/SHOPIFY_API_SECRET\) is missing or empty/)
    }
  })

  it('re-arms the alarm instead of throwing when the configuration is broken', async () => {
    const shop = newShop('broken-alarm')
    const stub = stubFor(shop, env.BROKEN_KEYRING)
    await runInDurableObject(stub, async (_: ShopSessionsDurableObject, state) => {
      await state.storage.put('record', { v: 1, shop, pairObtainedAt: Date.now() })
      await state.storage.setAlarm(Date.now() + MINUTE)
    })

    expect(await runDurableObjectAlarm(stub)).toBe(true)

    const alarm = await runInDurableObject(stub, (_: ShopSessionsDurableObject, state) => state.storage.getAlarm())
    expect(alarm).toBeGreaterThan(Date.now() + MINUTE / 2)
    expect(fake.calls).toEqual([])
  })

  it('keeps backing off across evictions while the configuration stays broken', async () => {
    const shop = newShop('broken-evicted')
    const stub = stubFor(shop, env.BROKEN_KEYRING)
    await runInDurableObject(stub, async (_: ShopSessionsDurableObject, state) => {
      await state.storage.put('record', { v: 1, shop, pairObtainedAt: clock.now() })
      await state.storage.setAlarm(Date.now() + MINUTE)
    })
    const delays: number[] = []
    for (let run = 0; run < 3; run++) {
      // Idle objects are evicted between alarms; the backoff must not start over.
      await evictDurableObject(stub)
      expect(await runDurableObjectAlarm(stub)).toBe(true)
      const at = await runInDurableObject(stub, (_: ShopSessionsDurableObject, state) => state.storage.getAlarm())
      delays.push(Math.round(((at ?? 0) - clock.now()) / MINUTE))
    }
    expect(delays).toEqual([1, 5, 30])
    const errors = await runInDurableObject(stub, (_: ShopSessionsDurableObject, state) =>
      state.storage.get('alarm-error'),
    )
    expect(errors).toMatchObject({ count: 3 })
  })
})

describe('encryption keys', () => {
  it('reads a record sealed under an earlier key, which the keyring holds for decryption only', async () => {
    const shop = newShop('older-key')
    const [current, older] = env.SHOPIFY_SESSION_ENCRYPTION_KEYS.split(',')
    const sealer = await createKeyring(`${older},${current}`)
    const now = clock.now()
    const record: ShopRecord = {
      v: 1,
      shop,
      token: await sealer.seal('shpat_older', `${shop}|token`),
      tokenFp: await fingerprint('shpat_older'),
      expires: now + HOUR,
      refresh: await sealer.seal('shprt_older', `${shop}|refresh`),
      refreshFp: await fingerprint('shprt_older'),
      refreshExpires: now + 90 * DAY,
      source: 'exchange',
      pairObtainedAt: now,
      chainOriginExpires: now + HOUR,
    }
    const stub = stubFor(shop)
    await runInDurableObject(stub, (_: ShopSessionsDurableObject, state) => state.storage.put('record', record))
    expect(await stub.getSession({ shop, caller: 'app' })).toMatchObject({
      status: 'ok',
      session: { accessToken: 'shpat_older' },
    })
    expect(await stub.describe({ shop })).toMatchObject({ state: 'ok', kids: [sealer.currentKid] })
  })

  it('describe reports the live keyring and credentials, which a rotation checks a deploy against', async () => {
    const live = await createKeyring(env.SHOPIFY_SESSION_ENCRYPTION_KEYS)
    const shop = newShop('live-config')
    const status = await stubFor(shop).describe({ shop })
    expect(status.exists).toBe(false)
    expect(status.keyring).toEqual({ kids: [...live.kids] })
    expect(status.keyring.kids).toHaveLength(2)
    expect(status.credentials.credFp).toBe(await credentialFingerprint(env.SHOPIFY_API_KEY, env.SHOPIFY_API_SECRET))
  })
})

describe('shop checks', () => {
  it('rejects a shop that is not in canonical form', async () => {
    const shop = newShop('canonical')
    const stub = stubFor(shop)
    for (const input of [shop.toUpperCase(), ` ${shop}`, `${shop}/`, 'example.com']) {
      const error = await rejection(() => stub.getSession({ shop: input, caller: 'library' }))
      expect(error.message).toMatch(/canonical shop domain/)
    }
  })

  it('rejects a shop other than the one the object is named after', async () => {
    const shop = newShop('named')
    const other = newShop('other')
    const { stub } = await installShop(shop)

    for (const [name, call] of everyRpc(stub, other)) {
      expect((await rejection(call)).message, name).toMatch(/does not match this object/)
    }
    expect(await stub.describe({ shop })).toMatchObject({ exists: true, shop })
  })

  it('rejects another shop even as the first call to a fresh object', async () => {
    const shop = newShop('fresh')
    const error = await rejection(() => stubFor(shop).describe({ shop: newShop('intruder') }))
    expect(error.message).toMatch(/does not match this object/)
  })
})
