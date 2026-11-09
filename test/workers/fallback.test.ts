// The application-only token fallback (DESIGN.md §6.10) in workerd, against the fake's assertion grant.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

import { fingerprint } from '../../src/fingerprint.js'
import { APP_TOKEN_LIFETIME_S } from './fake-shopify.js'
import { HOUR, MINUTE, clock, exchangeSession, fake, newShop, stubFor, useFreshFake } from './helpers.js'
import type { Stub } from './helpers.js'

useFreshFake()

async function install(label: string): Promise<{ shop: string; stub: Stub }> {
  const shop = newShop(label)
  const stub = stubFor(shop, env.APP_TOKENS)
  const result = await stub.putSession({ shop, session: exchangeSession(shop, fake.exchange(shop)) })
  expect(result.status).toBe('stored')
  return { shop, stub }
}

describe('app token fallback', () => {
  it('keeps background work running after an emergency secret revocation', async () => {
    const { shop, stub } = await install('revoked')
    fake.revokeSecret()
    clock.advance(2 * HOUR)

    const app = await stub.getSession({ shop, caller: 'app' })
    const [appToken] = fake.appTokensFor(shop)
    expect(app).toMatchObject({
      status: 'ok',
      source: 'app_token',
      session: { shop, accessToken: appToken, expires: expect.any(Number) },
    })
    // The refresh with the revoked secret is refused before the fake records it; the chain keeps the failure.
    expect(fake.callsFor(shop).map((call) => [call.grant, call.status])).toEqual([['mint', 200]])
    expect(await stub.describe({ shop })).toMatchObject({
      state: 'failing',
      failures: { kind: 'configuration', code: 'invalid_client' },
    })
    // The library is never handed one, so its token exchange can heal the chain.
    expect(await stub.getSession({ shop, caller: 'library' })).toMatchObject({
      status: 'tokenless',
      reason: 'token_endpoint',
    })

    expect(await stub.getSession({ shop, caller: 'app' })).toMatchObject({ session: { accessToken: appToken } })
    expect(fake.callsFor(shop, 'mint')).toHaveLength(1)
    expect(await stub.describe({ shop })).toMatchObject({ fallback: { kid: 'test-app-key-1' } })

    // The merchant opens the app: the exchange replaces the chain and drops the fallback.
    await stub.putSession({ shop, session: exchangeSession(shop, fake.exchange(shop)) })
    expect(await stub.getSession({ shop, caller: 'app' })).toMatchObject({
      session: { accessToken: fake.lastPair(shop).accessToken },
    })
    expect(await stub.describe({ shop })).not.toHaveProperty('fallback')
  })

  it('mints a new token when the stored one runs low', async () => {
    const { shop, stub } = await install('renew')
    fake.revokeSecret()
    clock.advance(2 * HOUR)
    await stub.getSession({ shop, caller: 'app' })
    clock.advance((APP_TOKEN_LIFETIME_S - 5 * 60) * 1000)
    const renewed = await stub.getSession({ shop, caller: 'app' })
    expect(fake.appTokensFor(shop)).toHaveLength(2)
    expect(renewed).toMatchObject({ source: 'app_token', session: { accessToken: fake.appTokensFor(shop)[1] } })
  })

  it('drops a token reported unauthorized and mints again', async () => {
    const { shop, stub } = await install('unauthorized')
    fake.revokeSecret()
    clock.advance(2 * HOUR)
    await stub.getSession({ shop, caller: 'app' })
    const [first] = fake.appTokensFor(shop)
    expect(await stub.reportUnauthorized({ shop, tokenFp: await fingerprint(first!) })).toEqual({ status: 'marked' })
    // A new token may be refused the same way: minting waits a minute.
    expect(await stub.getSession({ shop, caller: 'app' })).toMatchObject({ status: 'tokenless' })
    clock.advance(MINUTE)
    expect(await stub.getSession({ shop, caller: 'app' })).toMatchObject({
      session: { accessToken: fake.appTokensFor(shop)[1] },
    })
  })

  it('stops minting for an uninstalled shop after one rejection', async () => {
    const { shop, stub } = await install('uninstalled')
    fake.uninstall(shop)
    clock.advance(2 * HOUR)
    expect(await stub.getSession({ shop, caller: 'app' })).toMatchObject({
      status: 'needs_reauth',
      reason: 'refresh_rejected',
    })
    expect(await stub.getSession({ shop, caller: 'app' })).toMatchObject({ status: 'needs_reauth' })
    expect(fake.callsFor(shop, 'mint').map((call) => call.status)).toEqual([401])
  })

  it('is refused once the signing key is revoked', async () => {
    const { shop, stub } = await install('key-revoked')
    fake.revokeSecret()
    fake.revokeKey('test-app-key-1')
    clock.advance(2 * HOUR)
    expect(await stub.getSession({ shop, caller: 'app' })).toMatchObject({ status: 'tokenless' })
    expect(fake.callsFor(shop, 'mint').map((call) => call.status)).toEqual([401])
  })
})
