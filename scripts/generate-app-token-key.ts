#!/usr/bin/env node
// Generates an application-only token key pair (DESIGN.md §6.10): <out>/<kid>.jwk.json (public, for the Dev
// Dashboard) and <out>/<kid>.pem (PKCS#8, mode 0600, never printed).
//
//   pnpm app-token-key --kid prod-2027-01 [--alg ES256|RS256] [--bits 2048] [--out .]
//
// Needs Node ≥ 22.18 (built-in type stripping).

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

type Alg = 'ES256' | 'RS256'

const { values } = parseArgs({
  options: {
    kid: { type: 'string' },
    alg: { type: 'string', default: 'ES256' },
    bits: { type: 'string', default: '2048' },
    out: { type: 'string', default: '.' },
  },
})

const kid = values.kid?.trim() ?? ''
// The kid lands in a file name and in Shopify's key list: keep it plain.
if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid)) die('--kid is required: letters, digits, ".", "_" or "-" (e.g. prod-2027-01)')
const alg = values.alg
if (alg !== 'ES256' && alg !== 'RS256') die('--alg must be ES256 or RS256')
const bits = Number(values.bits)
if (alg === 'RS256' && !(Number.isInteger(bits) && bits >= 2048 && bits <= 8192)) {
  die('--bits must be an integer from 2048 to 8192 (Shopify accepts RSA-2048 to RSA-8192)')
}

const out = resolve(values.out)
const pemPath = join(out, `${kid}.pem`)
const jwkPath = join(out, `${kid}.jwk.json`)
for (const path of [pemPath, jwkPath]) {
  if (existsSync(path)) die(`${path} already exists: pick a new kid rather than overwrite a key`)
}

const { privateKey } =
  alg === 'ES256'
    ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : generateKeyPairSync('rsa', { modulusLength: bits, publicExponent: 0x10001 })
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicJwk = jwkFor(alg, kid)

selfTest(pem, publicJwk)

writeFileSync(pemPath, pem, { mode: 0o600, flag: 'wx' })
writeFileSync(jwkPath, `${JSON.stringify(publicJwk, null, 2)}\n`, { flag: 'wx' })

console.log(JSON.stringify(publicJwk, null, 2))
console.error(`
Public JWK (above) → ${jwkPath}
  Paste it into the Dev Dashboard: Settings > Credentials > Public keys (at most two active).
Private key → ${pemPath} (mode 0600, never printed)
  Escrow it, then: wrangler secret put SHOPIFY_APP_TOKEN_KEY < ${pemPath}
  appTokenKey: { kid: '${kid}', alg: '${alg}', privateKey: env.SHOPIFY_APP_TOKEN_KEY }
  Rehearsal .env: SHOPIFY_APP_TOKEN_KEY_FILE=${pemPath}  SHOPIFY_APP_TOKEN_KID=${kid}  SHOPIFY_APP_TOKEN_ALG=${alg}`)

/** Public members only, in the shape the Dev Dashboard takes. */
function jwkFor(alg: Alg, kid: string): Record<string, string> {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' })
  if (alg === 'ES256') {
    return { kty: 'EC', crv: 'P-256', alg, kid, x: must(jwk.x, 'x'), y: must(jwk.y, 'y') }
  }
  return { kty: 'RSA', alg, kid, n: must(jwk.n, 'n'), e: must(jwk.e, 'e') }
}

/** Proves the written PEM and the published JWK are a pair. */
function selfTest(pem: string, jwk: Record<string, string>): void {
  const data = Buffer.from(`self-test:${kid}`)
  const options = alg === 'ES256' ? { dsaEncoding: 'ieee-p1363' as const } : {}
  const signature = sign('sha256', data, { key: createPrivateKey(pem), ...options })
  const ok = verify('sha256', data, { key: createPublicKey({ key: jwk, format: 'jwk' }), ...options }, signature)
  if (!ok) die('self-test failed: the public JWK does not verify a signature from the private key')
}

function must(value: string | undefined, name: string): string {
  return value ?? die(`exported JWK has no "${name}"`)
}

function die(message: string): never {
  console.error(`generate-app-token-key: ${message}`)
  process.exit(1)
}
