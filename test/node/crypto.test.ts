import { describe, expect, it } from 'vitest'
import { createKeyring, KeyringError, parseKeyring, validateKeyring } from '../../src/crypto.js'
import type { Sealed } from '../../src/types.js'

// Keys are generated at runtime: a secrets scanner runs in CI.

const AAD = 'example.myshopify.com|token'

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function newKey(length = 32): string {
  return toBase64(randomBytes(length))
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function expectedKid(base64: string): Promise<string> {
  const raw = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('shop-session-kid')))
  return hex(mac.subarray(0, 8))
}

function parseError(input: unknown): KeyringError {
  try {
    parseKeyring(input as string)
  } catch (error) {
    expect(error).toBeInstanceOf(KeyringError)
    return error as KeyringError
  }
  throw new Error('expected parseKeyring to throw')
}

/** Fails if any 8-character run of a key string shows up in the message. */
function expectNoKeyMaterial(message: string, ...keys: string[]): void {
  const leaked: string[] = []
  for (const key of keys) {
    for (let i = 0; i + 8 <= key.length; i++) {
      const window = key.slice(i, i + 8)
      if (message.includes(window)) leaked.push(window)
    }
  }
  expect(leaked).toEqual([])
}

function flip(bytes: Uint8Array, index: number): Uint8Array {
  const copy = new Uint8Array(bytes)
  copy[index] = (copy[index] ?? 0) ^ 0x01
  return copy
}

describe('parseKeyring', () => {
  it('decodes keys in order, trimming whitespace around commas', () => {
    const a = randomBytes(32)
    const b = randomBytes(32)
    const keys = parseKeyring(`  ${toBase64(a)} ,\t${toBase64(b)}\n`)
    expect(keys).toEqual([a, b])
  })

  it('accepts a single key', () => {
    expect(parseKeyring(newKey())).toHaveLength(1)
  })

  it('rejects an empty or blank input', () => {
    expect(parseError('').message).toMatch(/SHOPIFY_SESSION_ENCRYPTION_KEYS is empty/)
    expect(parseError('  \n ').message).toMatch(/is empty/)
  })

  it('rejects a missing or non-string input', () => {
    expect(parseError(undefined).message).toMatch(/is not set/)
    expect(parseError(null).message).toMatch(/is not set/)
    expect(parseError(42).message).toMatch(/must be a string/)
    expect(parseError([newKey()]).message).toMatch(/must be a string/)
  })

  it('rejects empty entries from stray commas', () => {
    const a = newKey()
    for (const input of [`${a},`, `,${a}`, `${a},,${newKey()}`, ' , ']) {
      const error = parseError(input)
      expect(error.message).toMatch(/entry \d is empty/)
      expectNoKeyMaterial(error.message, a)
    }
    expect(parseError(`${a}, ,${newKey()}`).message).toMatch(/entry 2 is empty/)
  })

  it.each([16, 31, 33, 64])('rejects a %i-byte key and names the entry', (length) => {
    const good = newKey()
    const bad = newKey(length)
    const error = parseError(`${good},${bad}`)
    expect(error.message).toContain(`entry 2 is ${length} bytes, not 32`)
    expect(error.message).toContain('openssl rand -base64 32')
    expectNoKeyMaterial(error.message, good, bad)
  })

  it('rejects characters outside the standard alphabet', () => {
    // 0xfb 0xff 0xbf encodes to '+/+/', so the url-safe variant differs.
    const bytes = randomBytes(32)
    bytes.set([0xfb, 0xff, 0xbf])
    const standard = toBase64(bytes)
    expect(standard.startsWith('+/+/')).toBe(true)
    expect(parseKeyring(standard)).toHaveLength(1)

    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_')
    const bang = `!${standard.slice(1)}`
    const accented = `é${standard.slice(1)}`
    for (const bad of [urlSafe, bang, accented]) {
      const error = parseError(bad)
      expect(error.message).toContain('entry 1 is not valid base64')
      expectNoKeyMaterial(error.message, bad, standard)
    }
  })

  it('rejects whitespace inside a key', () => {
    const key = newKey()
    for (const space of [' ', '\t', '\n', '\r\n']) {
      const bad = `${key.slice(0, 20)}${space}${key.slice(20)}`
      const error = parseError(bad)
      expect(error.message).toContain('entry 1 is not valid base64')
      expectNoKeyMaterial(error.message, key)
    }
  })

  it('rejects missing or extra padding', () => {
    const key = newKey()
    expect(key.endsWith('=')).toBe(true)
    for (const bad of [key.replace(/=+$/, ''), `${key}=`, `${key}==`]) {
      const error = parseError(bad)
      expect(error.message).toContain('entry 1 is not valid base64')
      expectNoKeyMaterial(error.message, key)
    }
  })

  it('rejects a non-canonical encoding (non-zero trailing bits)', () => {
    const key = newKey()
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    // For 32 bytes the last data character carries 4 bits plus 2 padding bits that must be zero.
    const last = key.length - 2
    const value = alphabet.indexOf(key.charAt(last))
    const bad = `${key.slice(0, last)}${alphabet.charAt(value | 1)}=`
    expect(atob(bad)).toBe(atob(key))
    const error = parseError(bad)
    expect(error.message).toContain('not valid base64')
    expectNoKeyMaterial(error.message, key)
  })

  it('rejects duplicate keys and names both entries', () => {
    const a = newKey()
    const b = newKey()
    const error = parseError(`${a}, ${b} ,${a}`)
    expect(error.message).toContain('entry 3 repeats entry 1')
    expectNoKeyMaterial(error.message, a, b)
  })

  it('throws KeyringError with a stable name', () => {
    const error = parseError('nope')
    expect(error.name).toBe('KeyringError')
    expect(error).toBeInstanceOf(Error)
  })
})

describe('validateKeyring', () => {
  it('reports the key count', () => {
    expect(validateKeyring(newKey())).toEqual({ ok: true, count: 1 })
    expect(validateKeyring(`${newKey()}, ${newKey()}, ${newKey()}`)).toEqual({ ok: true, count: 3 })
  })

  it('returns errors instead of throwing, without key material', () => {
    const a = newKey()
    const short = newKey(16)
    const result = validateKeyring(`${a},${short}`)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('entry 2 is 16 bytes')
    expectNoKeyMaterial(result.error, a, short)

    expect(validateKeyring(undefined)).toEqual({ ok: false, error: expect.stringContaining('is not set') })
    expect(validateKeyring({})).toEqual({ ok: false, error: expect.stringContaining('must be a string') })
    expect(validateKeyring('')).toEqual({ ok: false, error: expect.stringContaining('is empty') })
  })

  it('is synchronous', () => {
    expect(validateKeyring(newKey())).not.toBeInstanceOf(Promise)
  })
})

describe('createKeyring', () => {
  it('round-trips plaintexts', async () => {
    const keyring = await createKeyring(newKey())
    for (const plaintext of ['access-token-value', '', 'tökén ✓ 🔑', '﻿leading-bom', 'x'.repeat(4096)]) {
      const sealed = await keyring.seal(plaintext, AAD)
      expect(await keyring.open(sealed, AAD)).toBe(plaintext)
    }
  })

  it('seals with the current kid, a 12-byte IV and a 16-byte tag', async () => {
    const keyring = await createKeyring(newKey())
    const plaintext = 'plaintext-marker'
    const sealed = await keyring.seal(plaintext, AAD)
    expect(sealed.kid).toBe(keyring.currentKid)
    expect(sealed.iv).toBeInstanceOf(Uint8Array)
    expect(sealed.iv).toHaveLength(12)
    expect(sealed.ct).toBeInstanceOf(Uint8Array)
    expect(sealed.ct).toHaveLength(plaintext.length + 16)
    expect(new TextDecoder().decode(sealed.ct)).not.toContain(plaintext)
  })

  it('opens values that went through structured clone or sit in a larger buffer', async () => {
    const keyring = await createKeyring(newKey())
    const sealed = await keyring.seal('access-token-value', AAD)
    expect(await keyring.open(structuredClone(sealed), AAD)).toBe('access-token-value')

    const backing = new Uint8Array(sealed.ct.length + 10)
    backing.set(sealed.ct, 5)
    const view = backing.subarray(5, 5 + sealed.ct.length)
    expect(await keyring.open({ ...sealed, ct: view }, AAD)).toBe('access-token-value')
  })

  it('binds the ciphertext to its shop and field', async () => {
    const keyring = await createKeyring(newKey())
    const sealed = await keyring.seal('access-token-value', AAD)
    expect(await keyring.open(sealed, 'other.myshopify.com|token')).toBeUndefined()
    expect(await keyring.open(sealed, 'example.myshopify.com|refresh')).toBeUndefined()
    expect(await keyring.open(sealed, '')).toBeUndefined()
    expect(await keyring.open(sealed, AAD)).toBe('access-token-value')
  })

  it('rejects tampered ciphertexts, tags and IVs', async () => {
    const keyring = await createKeyring(newKey())
    const sealed = await keyring.seal('access-token-value', AAD)
    expect(await keyring.open({ ...sealed, ct: flip(sealed.ct, 0) }, AAD)).toBeUndefined()
    expect(await keyring.open({ ...sealed, ct: flip(sealed.ct, sealed.ct.length - 1) }, AAD)).toBeUndefined()
    expect(await keyring.open({ ...sealed, iv: flip(sealed.iv, 0) }, AAD)).toBeUndefined()
    expect(await keyring.open({ ...sealed, ct: sealed.ct.subarray(1) }, AAD)).toBeUndefined()
  })

  it('returns undefined for a kid that is not in the keyring', async () => {
    const a = await createKeyring(newKey())
    const b = await createKeyring(newKey())
    const sealed = await a.seal('access-token-value', AAD)
    expect(await b.open(sealed, AAD)).toBeUndefined()
    expect(await a.open({ ...sealed, kid: 'ffffffffffffffff' }, AAD)).toBeUndefined()
  })

  it('returns undefined when the kid names a different key in the keyring', async () => {
    const a = newKey()
    const b = newKey()
    const keyring = await createKeyring(`${b},${a}`)
    const sealedUnderA = await (await createKeyring(a)).seal('access-token-value', AAD)
    expect(await keyring.open({ ...sealedUnderA, kid: keyring.currentKid }, AAD)).toBeUndefined()
  })

  it('returns undefined for malformed sealed values instead of throwing', async () => {
    const keyring = await createKeyring(newKey())
    const sealed = await keyring.seal('access-token-value', AAD)
    const malformed: unknown[] = [
      null,
      undefined,
      'sealed',
      42,
      {},
      { ...sealed, kid: 42 },
      { ...sealed, iv: sealed.iv.subarray(0, 11) },
      { ...sealed, iv: new Uint8Array(16) },
      { ...sealed, iv: Array.from(sealed.iv) },
      { ...sealed, iv: sealed.iv.buffer },
      { ...sealed, iv: new Uint16Array(12) },
      { ...sealed, ct: sealed.ct.subarray(0, 15) },
      { ...sealed, ct: Array.from(sealed.ct) },
      { ...sealed, ct: undefined },
    ]
    for (const value of malformed) {
      expect(await keyring.open(value as Sealed, AAD)).toBeUndefined()
    }
    expect(await keyring.open(sealed, undefined as unknown as string)).toBeUndefined()
  })

  it('refuses to seal a non-string', async () => {
    const keyring = await createKeyring(newKey())
    await expect(keyring.seal(undefined as unknown as string, AAD)).rejects.toThrow(TypeError)
    await expect(keyring.seal('value', undefined as unknown as string)).rejects.toThrow(TypeError)
  })

  it('uses a fresh IV for every seal', async () => {
    const keyring = await createKeyring(newKey())
    const sealed = await Promise.all(Array.from({ length: 256 }, () => keyring.seal('same-plaintext', AAD)))
    expect(new Set(sealed.map((value) => hex(value.iv))).size).toBe(256)
    expect(new Set(sealed.map((value) => hex(value.ct))).size).toBe(256)
  })

  it('derives the kid from HMAC-SHA256(key, "shop-session-kid")', async () => {
    const key = newKey()
    const keyring = await createKeyring(key)
    expect(keyring.currentKid).toMatch(/^[0-9a-f]{16}$/)
    expect(keyring.currentKid).toBe(await expectedKid(key))
  })

  it('keeps the kid stable per key and distinct across keys', async () => {
    const a = newKey()
    const b = newKey()
    const first = await createKeyring(a)
    const again = await createKeyring(` ${a}\n`)
    expect(again).not.toBe(first)
    expect(again.currentKid).toBe(first.currentKid)
    expect((await createKeyring(b)).currentKid).not.toBe(first.currentKid)
  })

  it('supports rotation: old values open under the new keyring, new values use the new kid', async () => {
    const a = newKey()
    const b = newKey()
    const old = await createKeyring(a)
    const rotated = await createKeyring(`${b},${a}`)
    const onlyNew = await createKeyring(b)

    const legacy = await old.seal('old-value', AAD)
    expect(await rotated.open(legacy, AAD)).toBe('old-value')
    expect(await onlyNew.open(legacy, AAD)).toBeUndefined()

    expect(rotated.currentKid).toBe(onlyNew.currentKid)
    expect(rotated.currentKid).not.toBe(old.currentKid)
    const fresh = await rotated.seal('new-value', AAD)
    expect(fresh.kid).toBe(onlyNew.currentKid)
    expect(await onlyNew.open(fresh, AAD)).toBe('new-value')
    expect(await old.open(fresh, AAD)).toBeUndefined()
  })

  it('memoizes by input and freezes the shared instance', async () => {
    const key = newKey()
    const first = createKeyring(key)
    expect(createKeyring(key)).toBe(first)
    const keyring = await first
    expect(Object.isFrozen(keyring)).toBe(true)
    expect(() => {
      ;(keyring as { currentKid: string }).currentKid = 'other'
    }).toThrow(TypeError)
  })

  it('keeps working after the cache evicts an entry', async () => {
    const key = newKey()
    const keyring = await createKeyring(key)
    const sealed = await keyring.seal('access-token-value', AAD)
    for (let i = 0; i < 10; i++) await createKeyring(newKey())
    const later = await createKeyring(key)
    expect(later.currentKid).toBe(keyring.currentKid)
    expect(await later.open(sealed, AAD)).toBe('access-token-value')
  })

  it('rejects a malformed keyring on every call', async () => {
    const short = newKey(16)
    for (let i = 0; i < 2; i++) {
      const error = await createKeyring(short).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(KeyringError)
      expectNoKeyMaterial((error as Error).message, short)
    }
    await expect(createKeyring(undefined as unknown as string)).rejects.toThrow(/is not set/)
  })
})
