// Unkeyed fingerprints. Shopify tokens and client secrets carry enough entropy
// that a truncated SHA-256 reveals nothing usable, and unlike a keyed MAC it
// stays stable across encryption-key rotation.

const encoder = new TextEncoder()

async function digest16(input: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input)))
  return base64url(hash.subarray(0, 16))
}

/** Fingerprint of an access, refresh or legacy token. */
export function fingerprint(token: string): Promise<string> {
  return digest16(`shop-session-token|${token}`)
}

/** Fingerprint of the app credentials the Durable Object calls Shopify with. */
export function credentialFingerprint(apiKey: string, apiSecretKey: string): Promise<string> {
  return digest16(`shop-session-cred|${apiKey}:${apiSecretKey}`)
}

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
