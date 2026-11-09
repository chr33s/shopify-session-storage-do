import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ASSERTION_LIFETIME_S, ASSERTION_SKEW_S, AppTokenKeyError, createAssertionSigner } from '../../src/app-token.js'
import type { AssertionSigner } from '../../src/app-token.js'
import { createAppTokenClient } from '../../src/token-client.js'
import type { AppTokenKey, TokenCallResult } from '../../src/types.js'

const SHOP = 'test-shop.myshopify.com'
const API_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const KID = 'app-key-2026-11'
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)
const TOKEN_URL = `https://${SHOP}/admin/oauth/access_token`
const APP_TOKEN = 'shpat_fake-app-token'

type KeyPair = { pem: string; jwk: JsonWebKey; publicKey: CryptoKey }

const decoder = new TextDecoder()

async function keyPair(alg: AppTokenKey['alg'], modulusLength = 2048): Promise<KeyPair> {
  const params =
    alg === 'ES256'
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : { name: 'RSASSA-PKCS1-v1_5', modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
  const pair = (await crypto.subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const body = btoa(String.fromCharCode(...pkcs8)).replace(/(.{64})/g, '$1\n')
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    jwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicKey: pair.publicKey,
  }
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function decode(jwt: string) {
  const [header, claims, signature] = jwt.split('.')
  return {
    header: JSON.parse(decoder.decode(fromBase64url(header!))) as Record<string, unknown>,
    claims: JSON.parse(decoder.decode(fromBase64url(claims!))) as Record<string, unknown>,
    input: `${header}.${claims}`,
    signature: fromBase64url(signature!),
  }
}

async function verifies(jwt: string, alg: AppTokenKey['alg'], publicKey: CryptoKey): Promise<boolean> {
  const { input, signature } = decode(jwt)
  const params = alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' }
  return crypto.subtle.verify(params, publicKey, signature, new TextEncoder().encode(input))
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

let es256: KeyPair
let rs256: KeyPair

beforeAll(async () => {
  ;[es256, rs256] = await Promise.all([keyPair('ES256'), keyPair('RS256')])
})

describe('createAssertionSigner', () => {
  it.each([
    ['ES256', 'pem'],
    ['ES256', 'jwk'],
    ['RS256', 'pem'],
    ['RS256', 'jwk'],
  ] as const)('signs a verifiable %s assertion from a %s key', async (alg, form) => {
    const pair = alg === 'ES256' ? es256 : rs256
    const signer = await createAssertionSigner(API_KEY, { kid: KID, alg, privateKey: pair[form] })
    const jwt = await signer.sign(SHOP, NOW + 999)
    const { header, claims } = decode(jwt)
    expect(header).toEqual({ alg, kid: KID, typ: 'JWT' })
    expect(claims).toEqual({
      iss: API_KEY,
      sub: API_KEY,
      aud: TOKEN_URL,
      iat: NOW / 1000 - ASSERTION_SKEW_S,
      exp: NOW / 1000 - ASSERTION_SKEW_S + ASSERTION_LIFETIME_S,
      jti: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(await verifies(jwt, alg, pair.publicKey)).toBe(true)
    expect(signer.kid).toBe(KID)
  })

  it('uses a new jti for every assertion', async () => {
    const signer = await createAssertionSigner(API_KEY, { kid: KID, alg: 'ES256', privateKey: es256.pem })
    const jtis = new Set<unknown>()
    for (let i = 0; i < 5; i++) jtis.add(decode(await signer.sign(SHOP, NOW)).claims['jti'])
    expect(jtis.size).toBe(5)
  })

  it('accepts a private JWK carrying the public JWK usage fields', async () => {
    const jwk = { ...es256.jwk, use: 'sig', alg: 'ES256', key_ops: ['verify'] }
    const signer = await createAssertionSigner(API_KEY, { kid: KID, alg: 'ES256', privateKey: jwk })
    expect(await verifies(await signer.sign(SHOP, NOW), 'ES256', es256.publicKey)).toBe(true)
  })

  it.each([
    ['no kid', () => ({ kid: '', alg: 'ES256', privateKey: es256.pem }), /kid/],
    ['an unknown alg', () => ({ kid: KID, alg: 'HS256', privateKey: es256.pem }), /ES256 or RS256/],
    [
      'a PKCS#1 PEM',
      () => ({ kid: KID, alg: 'RS256', privateKey: rs256.pem.replace(/PRIVATE KEY/g, 'RSA PRIVATE KEY') }),
      /PKCS#8/,
    ],
    ['an RSA key for ES256', () => ({ kid: KID, alg: 'ES256', privateKey: rs256.pem }), /not a valid ES256/],
    ['an EC key for RS256', () => ({ kid: KID, alg: 'RS256', privateKey: es256.pem }), /not a valid RS256/],
    ['a public JWK', () => ({ kid: KID, alg: 'ES256', privateKey: { ...es256.jwk, d: undefined } }), /no d/],
    ['a JWK of the wrong kty', () => ({ kid: KID, alg: 'ES256', privateKey: rs256.jwk }), /kty EC/],
    ['a JWK with another alg', () => ({ kid: KID, alg: 'ES256', privateKey: { ...es256.jwk, alg: 'ES384' } }), /alg/],
  ] as const)('rejects %s without echoing key material', async (_, key, message) => {
    const error = await rejection(createAssertionSigner(API_KEY, key() as unknown as AppTokenKey))
    expect(error).toBeInstanceOf(AppTokenKeyError)
    expect((error as Error).message).toMatch(message)
    const serialized = `${(error as Error).message}\n${(error as Error).stack ?? ''}`
    expect(serialized).not.toContain(es256.jwk.d)
    expect(serialized).not.toContain(rs256.jwk.d)
    expect(serialized).not.toContain(rs256.pem.split('\n')[1])
  })

  it('rejects an RSA key under 2048 bits', async () => {
    const small = await keyPair('RS256', 1024)
    const error = await rejection(createAssertionSigner(API_KEY, { kid: KID, alg: 'RS256', privateKey: small.pem }))
    expect(error).toBeInstanceOf(AppTokenKeyError)
    expect((error as Error).message).toMatch(/RSA-1024/)
  })

  it('rejects an empty client id', async () => {
    const error = await rejection(createAssertionSigner('', { kid: KID, alg: 'ES256', privateKey: es256.pem }))
    expect(error).toBeInstanceOf(AppTokenKeyError)
  })
})

describe('createAppTokenClient', () => {
  type Call = { url: string; init: RequestInit }

  async function mint(respond: Response | (() => Response | Promise<Response>), signer?: AssertionSigner) {
    const calls: Call[] = []
    const fetch = vi.fn(async (input: string, init: RequestInit) => {
      calls.push({ url: String(input), init })
      return typeof respond === 'function' ? respond() : respond
    })
    const client = createAppTokenClient({
      apiKey: API_KEY,
      signer: signer ?? (await createAssertionSigner(API_KEY, { kid: KID, alg: 'ES256', privateKey: es256.pem })),
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => NOW,
    })
    return { client, result: await client.mint(SHOP), calls }
  }

  function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  }

  function failed(result: TokenCallResult) {
    if (result.outcome === 'success') throw new Error('expected a failure result')
    return result
  }

  it('posts a form-encoded client credentials grant with a signed assertion and no secret', async () => {
    const { client, result, calls } = await mint(
      json({ access_token: APP_TOKEN, expires_in: 3599, scope: 'read_products' }),
    )
    expect(client.kid).toBe(KID)
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call!.url).toBe(TOKEN_URL)
    expect(call!.init.method).toBe('POST')
    expect(call!.init.redirect).toBe('manual')
    expect(call!.init.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    })
    const form = new URLSearchParams(String(call!.init.body))
    expect(
      String(call!.init.body)
        .split('&')
        .map((pair) => pair.split('=')[0])
        .sort(),
    ).toEqual(['client_assertion', 'client_assertion_type', 'client_id', 'grant_type'])
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(form.get('client_id')).toBe(API_KEY)
    expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
    expect(await verifies(form.get('client_assertion')!, 'ES256', es256.publicKey)).toBe(true)
    // No refresh token is expected from this grant, so none is reported missing.
    expect(result).toEqual({
      outcome: 'success',
      sentAt: NOW,
      accessToken: APP_TOKEN,
      expiresIn: 3599,
      scope: 'read_products',
      missing: [],
    })
  })

  it('signs a new assertion for every call', async () => {
    const responses = [
      json({ access_token: APP_TOKEN, expires_in: 3600 }),
      json({ access_token: APP_TOKEN, expires_in: 3600 }),
    ]
    const { client, calls } = await mint(() => responses.shift()!)
    await client.mint(SHOP)
    const assertions = calls.map((call) => new URLSearchParams(String(call.init.body)).get('client_assertion'))
    expect(new Set(assertions).size).toBe(2)
  })

  it.each([
    [401, 'invalid_client'],
    [400, 'invalid_request'],
    [403, 'unauthorized_client'],
    [400, undefined],
  ])('classifies a %s (%s) as terminal by status alone', async (status, error) => {
    const { result } = await mint(json(error === undefined ? {} : { error, error_description: 'x' }, status))
    expect(failed(result)).toMatchObject({
      outcome: 'terminal',
      status,
      code: error ?? `http_${status}`,
      ambiguous: false,
    })
  })

  it.each([
    [429, 'transient', 'http_429'],
    [503, 'transient', 'http_503'],
    [402, 'shop_unavailable', 'http_402'],
    [404, 'shop_unavailable', 'http_404'],
    [423, 'shop_unavailable', 'http_423'],
  ])('classifies a %s as %s', async (status, outcome, code) => {
    const { result } = await mint(json({ error: 'x' }, status, { 'retry-after': '30' }))
    expect(failed(result)).toMatchObject({ outcome, code, status })
  })

  it('classifies a 408 as transient, not a rejection', async () => {
    const { result } = await mint(json({}, 408))
    expect(failed(result)).toMatchObject({ outcome: 'transient', code: 'http_408', status: 408 })
  })

  it('honours Retry-After on a 429', async () => {
    const { result } = await mint(json({}, 429, { 'retry-after': '120' }))
    expect(failed(result).retryAfterMs).toBe(120_000)
  })

  it('treats a challenge page as transient', async () => {
    const { result } = await mint(
      new Response('<html></html>', { status: 403, headers: { 'content-type': 'text/html' } }),
    )
    expect(failed(result)).toMatchObject({ outcome: 'transient', code: 'challenge' })
  })

  it('answers configuration without sending when signing fails', async () => {
    const signer: AssertionSigner = { kid: KID, sign: () => Promise.reject(new Error('boom')) }
    const { result, calls } = await mint(json({}), signer)
    expect(calls).toHaveLength(0)
    expect(result).toEqual({ outcome: 'configuration', sentAt: NOW, ambiguous: false, code: 'sign_failed' })
  })

  it('refuses a shop that is not canonical without sending', async () => {
    const signer = await createAssertionSigner(API_KEY, { kid: KID, alg: 'ES256', privateKey: es256.pem })
    const fetch = vi.fn()
    const client = createAppTokenClient({ apiKey: API_KEY, signer, fetch: fetch as unknown as typeof globalThis.fetch })
    expect(await client.mint('evil.example.com')).toMatchObject({ outcome: 'configuration', code: 'invalid_shop' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('throws at creation without an apiKey or a signer', () => {
    expect(() => createAppTokenClient({ apiKey: '', signer: { kid: KID, sign: async () => '' } })).toThrow(/apiKey/)
    expect(() => createAppTokenClient({ apiKey: API_KEY, signer: undefined as unknown as AssertionSigner })).toThrow(
      /signer/,
    )
  })
})
