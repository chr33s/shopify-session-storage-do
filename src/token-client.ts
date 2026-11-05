import { canonicalShop } from './shop.js'
import type { TokenCallResult, TokenClient } from './types.js'

export type TokenClientOptions = {
  apiKey: string
  apiSecretKey: string
  /** Defaults to the global `fetch`, looked up on every call. */
  fetch?: typeof fetch
  now?: () => number
  /** Covers sending the request and reading the whole response. */
  timeoutMs?: number
  allowMyshopifyIo?: boolean
}

type Grant = 'refresh' | 'migrate'
type SuccessResult = Extract<TokenCallResult, { outcome: 'success' }>
type FailureResult = Exclude<TokenCallResult, { outcome: 'success' }>
type FailureDetails = { ambiguous?: boolean; status?: number; requestId?: string; retryAfterMs?: number }
type JsonObject = Record<string, unknown>
type FetchLike = (input: string, init: RequestInit) => Promise<Response>

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RETRY_AFTER_MS = 10 * 60_000
const TOKEN_PATH = '/admin/oauth/access_token'
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const OFFLINE_ACCESS_TOKEN = 'urn:shopify:params:oauth:token-type:offline-access-token'
const MIGRATE_TERMINAL_ERRORS = new Set(['invalid_subject_token', 'invalid_requested_token_type'])
const SHOP_UNAVAILABLE_STATUSES = new Set([402, 404, 423])
// Only short machine codes make it into results; anything else could be free text from the body.
const OAUTH_ERROR = /^[a-z_]{1,64}$/
const REQUEST_ID = /^[\w.:-]{1,128}$/
const NUMERIC = /^\s*\d+(?:\.\d+)?\s*$/

/** Shopify OAuth calls for one app, classified per DESIGN §2 and §6.4. Never throws once created. */
export function createTokenClient(options: TokenClientOptions): TokenClient {
  const { apiKey, apiSecretKey, allowMyshopifyIo = false } = options
  if (!isPresent(apiKey) || !isPresent(apiSecretKey)) {
    throw new Error('createTokenClient: apiKey and apiSecretKey must be non-empty strings')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('createTokenClient: timeoutMs must be a positive finite number')
  }
  const now = options.now ?? Date.now
  // Called as a plain function: Workers' fetch throws "Illegal invocation" when `this` is some other object.
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init))

  async function call(grant: Grant, shop: string, credential: string): Promise<TokenCallResult> {
    const url = tokenUrl(shop, allowMyshopifyIo)
    if (url === undefined) return failure('configuration', now(), 'invalid_shop')
    // Presenting an empty token would come back terminal and quarantine a healthy chain.
    if (!isPresent(credential)) return failure('configuration', now(), 'missing_token')

    const body = JSON.stringify(
      grant === 'refresh'
        ? { client_id: apiKey, client_secret: apiSecretKey, grant_type: 'refresh_token', refresh_token: credential }
        : {
            client_id: apiKey,
            client_secret: apiSecretKey,
            grant_type: TOKEN_EXCHANGE_GRANT,
            subject_token: credential,
            subject_token_type: OFFLINE_ACCESS_TOKEN,
            requested_token_type: OFFLINE_ACCESS_TOKEN,
            expiring: '1',
          },
    )

    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // Raced as well as wired to the signal, so a fetch or body stream that ignores the abort can't hang the caller.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(new Error('timeout'))
      }, timeoutMs)
    })

    const sentAt = now()
    try {
      const response = await Promise.race([
        doFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body,
          redirect: 'manual',
          signal: controller.signal,
        }),
        deadline,
      ])
      const status = response.status
      const requestId = readRequestId(response.headers)

      if ((response.type as string) === 'opaqueredirect' || (status >= 300 && status < 400)) {
        discardBody(response)
        return failure('configuration', sentAt, 'redirect', { status, requestId })
      }

      let text: string
      try {
        text = await Promise.race([response.text(), deadline])
      } catch {
        // Without the body the OAuth error is unknown: retry soon instead of quarantining or backing off for hours.
        return failure('transient', sentAt, timedOut ? 'timeout' : 'network', {
          ambiguous: isSuccess(status) || status >= 500,
          status,
          requestId,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), now()),
        })
      }
      return classify(grant, response, text, sentAt, requestId, now())
    } catch {
      return failure('transient', sentAt, timedOut ? 'timeout' : 'network', { ambiguous: true })
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    refresh: (shop, refreshToken) => call('refresh', shop, refreshToken),
    migrate: (shop, legacyToken) => call('migrate', shop, legacyToken),
  }
}

function classify(
  grant: Grant,
  response: Response,
  text: string,
  sentAt: number,
  requestId: string | undefined,
  receivedAt: number,
): TokenCallResult {
  const { status, headers } = response
  const json = parseObject(text)

  if (isSuccess(status)) {
    return (
      parseSuccess(json, sentAt, requestId) ??
      failure('transient', sentAt, 'invalid_response', { ambiguous: true, status, requestId })
    )
  }

  const transient = { status, requestId, retryAfterMs: parseRetryAfter(headers.get('retry-after'), receivedAt) }
  // A Cloudflare challenge never reached Shopify: not ambiguous, and no verdict on the credentials.
  if (headers.has('cf-mitigated') || ((status === 403 || status === 429) && looksLikeHtml(headers, text))) {
    return failure('transient', sentAt, 'challenge', transient)
  }

  const error = typeof json?.['error'] === 'string' ? json['error'] : undefined
  if (
    error !== undefined &&
    ((grant === 'refresh' && status === 401 && error === 'invalid_request') ||
      (grant === 'migrate' && status === 400 && MIGRATE_TERMINAL_ERRORS.has(error)))
  ) {
    return failure('terminal', sentAt, error, { status, requestId })
  }
  if (status === 429) return failure('transient', sentAt, 'http_429', transient)
  if (status >= 500 && status < 600) {
    return failure('transient', sentAt, `http_${status}`, { ...transient, ambiguous: true })
  }
  if (SHOP_UNAVAILABLE_STATUSES.has(status)) {
    return failure('shop_unavailable', sentAt, `http_${status}`, { status, requestId })
  }
  const code = error !== undefined && OAUTH_ERROR.test(error) ? error : `http_${status}`
  return failure('configuration', sentAt, code, { status, requestId })
}

function parseSuccess(json: JsonObject | undefined, sentAt: number, requestId: string | undefined) {
  if (json === undefined) return undefined
  const accessToken = json['access_token']
  if (typeof accessToken !== 'string' || accessToken === '') return undefined

  const result: SuccessResult = { outcome: 'success', sentAt, accessToken, missing: [] }
  const expiresIn = positiveNumber(json['expires_in'])
  if (expiresIn !== undefined) result.expiresIn = expiresIn
  else result.missing.push('expires_in')

  const refreshToken = json['refresh_token']
  if (typeof refreshToken === 'string' && refreshToken !== '') result.refreshToken = refreshToken
  else result.missing.push('refresh_token')

  const refreshTokenExpiresIn = positiveNumber(json['refresh_token_expires_in'])
  if (refreshTokenExpiresIn !== undefined) result.refreshTokenExpiresIn = refreshTokenExpiresIn
  else result.missing.push('refresh_token_expires_in')

  const scope = json['scope']
  if (typeof scope === 'string') result.scope = scope
  else result.missing.push('scope')

  if (requestId !== undefined) result.requestId = requestId
  return result
}

function failure(
  outcome: FailureResult['outcome'],
  sentAt: number,
  code: string,
  details: FailureDetails = {},
): FailureResult {
  const result: FailureResult = { outcome, sentAt, ambiguous: details.ambiguous ?? false, code }
  if (details.status !== undefined) result.status = details.status
  if (details.requestId !== undefined) result.requestId = details.requestId
  if (details.retryAfterMs !== undefined) result.retryAfterMs = details.retryAfterMs
  return result
}

function tokenUrl(shop: string, allowMyshopifyIo: boolean): string | undefined {
  if (typeof shop !== 'string' || canonicalShop(shop, { allowMyshopifyIo }) !== shop) return undefined
  let url: URL
  try {
    url = new URL(TOKEN_PATH, `https://${shop}`)
  } catch {
    return undefined
  }
  // The body carries the client secret, so it may only ever go to the shop's own host.
  const exact =
    url.protocol === 'https:' &&
    url.hostname === shop &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === TOKEN_PATH
  return exact ? url.href : undefined
}

function parseObject(text: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined
  } catch {
    return undefined
  }
}

function positiveNumber(value: unknown): number | undefined {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' && NUMERIC.test(value) ? Number(value) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Delta-seconds or an HTTP date, clamped to [0, 10 min]. */
function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  let ms: number
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000
  } else if (/[a-z]/i.test(trimmed)) {
    // Requiring letters keeps Date.parse from reading bare numbers like '1.5' as dates.
    const at = Date.parse(trimmed)
    if (!Number.isFinite(at)) return undefined
    ms = at - now
  } else {
    return undefined
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS)
}

function looksLikeHtml(headers: Headers, text: string): boolean {
  return /html/i.test(headers.get('content-type') ?? '') || /^\s*</.test(text)
}

function readRequestId(headers: Headers): string | undefined {
  const value = headers.get('x-request-id')?.trim()
  return value !== undefined && REQUEST_ID.test(value) ? value : undefined
}

function discardBody(response: Response): void {
  try {
    response.body?.cancel().catch(() => {})
  } catch {
    // Already consumed or locked; nothing to release.
  }
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300
}

function isPresent(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}
