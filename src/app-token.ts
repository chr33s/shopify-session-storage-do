// Client assertions for the application-only token grant (DESIGN.md §6.10). WebCrypto only, for workerd and Node.

import { base64Bytes } from './crypto.js'
import { base64url } from './fingerprint.js'
import type { AppTokenKey } from './types.js'

/** Shopify accepts at most 300 s; a minute leaves room for clock skew without a long replay window. */
export const ASSERTION_LIFETIME_S = 60
/** `iat` is set this far back, so a clock slightly ahead of Shopify's doesn't date an assertion in its future. */
export const ASSERTION_SKEW_S = 5
const MIN_RSA_BITS = 2048
const MAX_RSA_BITS = 8192
const PEM = /^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END PRIVATE KEY-----$/

const encoder = new TextEncoder()

/** A malformed app token key. Messages never contain key material. */
export class AppTokenKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppTokenKeyError'
  }
}

export type AssertionSigner = {
  readonly kid: string
  /** A fresh assertion (new `jti`) for one token request to `shop`. */
  sign(shop: string, nowMs: number): Promise<string>
}

/** Imports the key (non-extractable, sign only) and checks it fits `alg`. Rejects with AppTokenKeyError. */
export async function createAssertionSigner(clientId: string, key: AppTokenKey): Promise<AssertionSigner> {
  if (typeof key !== 'object' || key === null) throw new AppTokenKeyError('The app token key must be an object')
  const { kid, alg, privateKey } = key
  if (typeof kid !== 'string' || kid.trim() === '') throw new AppTokenKeyError('The app token key needs a kid')
  if (alg !== 'ES256' && alg !== 'RS256') throw new AppTokenKeyError('The app token key alg must be ES256 or RS256')
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw new AppTokenKeyError('The app token key needs the app API key as client id')
  }

  const algorithm: EcKeyImportParams | RsaHashedImportParams =
    alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
  let cryptoKey: CryptoKey
  try {
    cryptoKey =
      typeof privateKey === 'string'
        ? await crypto.subtle.importKey('pkcs8', pemBytes(privateKey), algorithm, false, ['sign'])
        : await crypto.subtle.importKey('jwk', privateJwk(privateKey, alg), algorithm, false, ['sign'])
  } catch (error) {
    if (error instanceof AppTokenKeyError) throw error
    throw new AppTokenKeyError(`The app token key is not a valid ${alg} private key (PKCS#8 PEM or private JWK)`)
  }
  if (alg === 'RS256') {
    const bits = (cryptoKey.algorithm as RsaHashedKeyAlgorithm).modulusLength
    if (!(bits >= MIN_RSA_BITS && bits <= MAX_RSA_BITS)) {
      throw new AppTokenKeyError(
        `The app token key is RSA-${bits}; Shopify accepts ${MIN_RSA_BITS}–${MAX_RSA_BITS} bits`,
      )
    }
  }

  const header = encodeJson({ alg, kid, typ: 'JWT' })
  const signParams: AlgorithmIdentifier | EcdsaParams =
    alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' }

  return Object.freeze({
    kid,
    async sign(shop: string, nowMs: number): Promise<string> {
      const iat = Math.floor(nowMs / 1000) - ASSERTION_SKEW_S
      const claims = encodeJson({
        iss: clientId,
        sub: clientId,
        aud: `https://${shop}/admin/oauth/access_token`,
        iat,
        exp: iat + ASSERTION_LIFETIME_S,
        // Shopify accepts each jti once per app across all stores.
        jti: crypto.randomUUID(),
      })
      const input = `${header}.${claims}`
      // ECDSA signatures come back as r‖s, which is the JWS encoding.
      const signature = await crypto.subtle.sign(signParams, cryptoKey, encoder.encode(input))
      return `${input}.${base64url(new Uint8Array(signature))}`
    },
  })
}

function pemBytes(pem: string): ArrayBuffer {
  const match = PEM.exec(pem.trim())
  if (!match?.[1]) {
    throw new AppTokenKeyError('The app token key PEM must be PKCS#8 (-----BEGIN PRIVATE KEY-----)')
  }
  const bytes = base64Bytes(match[1].replace(/\s+/g, ''))
  if (!bytes) throw new AppTokenKeyError('The app token key PEM is not valid base64')
  return bytes.buffer
}

function privateJwk(jwk: JsonWebKey, alg: AppTokenKey['alg']): JsonWebKey {
  if (typeof jwk !== 'object' || jwk === null) throw new AppTokenKeyError('The app token key JWK must be an object')
  if (typeof jwk.d !== 'string') throw new AppTokenKeyError('The app token key JWK is not a private key (no d)')
  const kty = alg === 'ES256' ? 'EC' : 'RSA'
  if (jwk.kty !== kty) throw new AppTokenKeyError(`The app token key JWK must have kty ${kty} for ${alg}`)
  if (jwk.alg !== undefined && jwk.alg !== alg) {
    throw new AppTokenKeyError(`The app token key JWK alg does not match ${alg}`)
  }
  // Usage fields copied from the public JWK (`use: "sig"`, `key_ops: ["verify"]`) make a signing import fail.
  const { key_ops: _keyOps, use: _use, ext: _ext, ...rest } = jwk
  return rest
}

function encodeJson(value: object): string {
  return base64url(encoder.encode(JSON.stringify(value)))
}
