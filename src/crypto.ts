// The keyring that seals tokens at rest: AES-256-GCM under the first key of
// SHOPIFY_SESSION_ENCRYPTION_KEYS, opened under whichever key the `kid` names.
// WebCrypto and atob/btoa only, so the same code runs in workerd and Node.

import type { Keyring, Sealed } from './types.js'

export { credentialFingerprint, fingerprint } from './fingerprint.js'

const VARIABLE = 'SHOPIFY_SESSION_ENCRYPTION_KEYS'
const GENERATE = 'generate one with: openssl rand -base64 32'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const KID_LABEL = 'shop-session-kid'
// Keyrings are per-environment constants; a handful covers tests and multi-env isolates.
const CACHE_LIMIT = 4

const encoder = new TextEncoder()
// ignoreBOM keeps a leading U+FEFF in the plaintext instead of silently stripping it.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** A malformed keyring. Messages name the entry by position and never contain key material. */
export class KeyringError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyringError'
  }
}

/**
 * Parses comma-separated strict base64 keys (standard alphabet, padded, whitespace allowed only around commas),
 * each exactly 32 bytes and all distinct. The first key is current.
 */
export function parseKeyring(input: string): Uint8Array<ArrayBuffer>[] {
  const value: unknown = input
  if (value === undefined || value === null) throw new KeyringError(`${VARIABLE} is not set; ${GENERATE}`)
  if (typeof value !== 'string') throw new KeyringError(`${VARIABLE} must be a string of comma-separated base64 keys`)
  if (value.trim() === '') throw new KeyringError(`${VARIABLE} is empty; ${GENERATE}`)

  const seen = new Map<string, number>()
  return value.split(',').map((raw, index) => {
    const entry = raw.trim()
    const position = index + 1
    if (entry === '') throw new KeyringError(`${VARIABLE} entry ${position} is empty (check for a stray comma)`)
    const bytes = decodeStrict(entry)
    if (!bytes) {
      throw new KeyringError(
        `${VARIABLE} entry ${position} is not valid base64 (standard alphabet, padded, no spaces); ${GENERATE}`,
      )
    }
    if (bytes.length !== KEY_BYTES) {
      throw new KeyringError(`${VARIABLE} entry ${position} is ${bytes.length} bytes, not ${KEY_BYTES}; ${GENERATE}`)
    }
    // Canonical encoding means equal strings iff equal bytes.
    const first = seen.get(entry)
    if (first !== undefined) {
      throw new KeyringError(`${VARIABLE} entry ${position} repeats entry ${first}; every key must be distinct`)
    }
    seen.set(entry, position)
    return bytes
  })
}

/** Synchronous keyring check for deploy scripts. */
export function validateKeyring(input: unknown): { ok: true; count: number } | { ok: false; error: string } {
  try {
    return { ok: true, count: parseKeyring(input as string).length }
  } catch (error) {
    if (error instanceof KeyringError) return { ok: false, error: error.message }
    throw error
  }
}

const cache = new Map<string, Promise<Keyring>>()

/** Imports the keyring (non-extractable keys). Memoized per input; a malformed input rejects on every call. */
export function createKeyring(input: string): Promise<Keyring> {
  const cached = cache.get(input)
  if (cached) return cached

  let keys: Uint8Array<ArrayBuffer>[]
  try {
    keys = parseKeyring(input)
  } catch (error) {
    return Promise.reject(error)
  }

  const pending = importKeyring(keys)
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(input, pending)
  pending.catch(() => {
    if (cache.get(input) === pending) cache.delete(input)
  })
  return pending
}

type Entry = { kid: string; key: CryptoKey }

async function importKeyring(keys: Uint8Array<ArrayBuffer>[]): Promise<Keyring> {
  const entries = await Promise.all(keys.map((raw, index) => importEntry(raw, index === 0)))
  const [current] = entries
  if (!current) throw new KeyringError(`${VARIABLE} is empty; ${GENERATE}`)

  const byKid = new Map<string, CryptoKey>()
  for (const { kid, key } of entries) {
    // A 64-bit collision between distinct keys is practically impossible, but would make records ambiguous.
    if (byKid.has(kid)) throw new KeyringError(`${VARIABLE} has two keys with the same kid; replace one of them`)
    byKid.set(kid, key)
  }

  const keyring: Keyring = {
    currentKid: current.kid,
    kids: entries.map((entry) => entry.kid),

    async seal(plaintext: string, aad: string): Promise<Sealed> {
      // Guards against sealing the string 'undefined' as if it were a token.
      if (typeof plaintext !== 'string' || typeof aad !== 'string') {
        throw new TypeError('seal expects a string plaintext and aad')
      }
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
        current.key,
        encoder.encode(plaintext),
      )
      return { kid: current.kid, iv, ct: new Uint8Array(ct) }
    },

    async open(sealed: Sealed, aad: string): Promise<string | undefined> {
      // Sealed values come from storage; anything wrong with one makes the record unreadable, never an exception.
      try {
        if (!isSealed(sealed) || typeof aad !== 'string') return undefined
        const key = byKid.get(sealed.kid)
        if (!key) return undefined
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: new Uint8Array(sealed.iv), additionalData: encoder.encode(aad) },
          key,
          new Uint8Array(sealed.ct),
        )
        return decoder.decode(plaintext)
      } catch {
        return undefined
      }
    },
  }
  // Shared through the cache, so no caller may swap its methods for the others.
  return Object.freeze(keyring)
}

async function importEntry(raw: Uint8Array<ArrayBuffer>, current: boolean): Promise<Entry> {
  const [key, mac] = await Promise.all([
    crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, current ? ['encrypt', 'decrypt'] : ['decrypt']),
    crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  ])
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', mac, encoder.encode(KID_LABEL)))
  return { kid: hex(digest.subarray(0, 8)), key }
}

// atob is forgiving (skips whitespace, tolerates missing padding and non-zero trailing bits); requiring the input
// to equal its own canonical re-encoding makes the decode strict.
function decodeStrict(entry: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(entry)) return undefined
  const bytes = base64Bytes(entry)
  return bytes && btoa(String.fromCharCode(...bytes)) === entry ? bytes : undefined
}

/** Forgiving standard base64 (as `atob`); `undefined` when `atob` refuses it. */
export function base64Bytes(text: string): Uint8Array<ArrayBuffer> | undefined {
  let binary: string
  try {
    binary = atob(text)
  } catch {
    return undefined
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function isSealed(value: unknown): value is Sealed {
  if (typeof value !== 'object' || value === null) return false
  const { kid, iv, ct } = value as Record<string, unknown>
  return typeof kid === 'string' && isBytes(iv) && iv.length === IV_BYTES && isBytes(ct) && ct.length >= TAG_BYTES
}

// Tag check rather than instanceof, so a Uint8Array from another realm still counts.
function isBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
