import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTokenClient, type TokenClientOptions } from '../../src/token-client.js'
import type { TokenCallResult } from '../../src/types.js'

// Deliberate fakes, without the prefix plus hex of real tokens, which secret scanners flag. Their hyphens
// keep them from matching OAUTH_ERROR, as a real token's digits do, so none can pass as an OAuth error code.
const SHOP = 'test-shop.myshopify.com'
const API_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const SECRET = 'shpss_fake-api-secret'
const PRESENTED_REFRESH = 'shprt_fake-presented-refresh'
const LEGACY = 'shpat_fake-legacy-access'
const NEW_ACCESS = 'shpat_fake-new-access'
const NEW_REFRESH = 'shprt_fake-new-refresh'
const BODY_MARKER = 'body-text-must-not-leak-9f3a'
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0)
const TOKEN_URL = `https://${SHOP}/admin/oauth/access_token`

type Grant = 'refresh' | 'migrate'
type Call = { url: string; init: RequestInit }
type Responder = (call: Call) => Response | Promise<Response>

function fakeFetch(respond: Responder) {
  const calls: Call[] = []
  const fn = vi.fn(async (input: string, init: RequestInit) => {
    const call = { url: String(input), init }
    calls.push(call)
    return respond(call)
  })
  return { fetch: fn as unknown as typeof fetch, fn, calls }
}

function makeClient(respond: Responder, overrides: Partial<TokenClientOptions> = {}) {
  const fake = fakeFetch(respond)
  const tokens = createTokenClient({
    apiKey: API_KEY,
    apiSecretKey: SECRET,
    fetch: fake.fetch,
    now: () => NOW,
    ...overrides,
  })
  return { tokens, ...fake }
}

async function run(grant: Grant, respond: Responder | Response, overrides: Partial<TokenClientOptions> = {}) {
  const { tokens, calls } = makeClient(typeof respond === 'function' ? respond : () => respond, overrides)
  const result =
    grant === 'refresh' ? await tokens.refresh(SHOP, PRESENTED_REFRESH) : await tokens.migrate(SHOP, LEGACY)
  return { result, calls }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function html(status: number, headers: Record<string, string> = {}): Response {
  return new Response(`<!DOCTYPE html><html><body>${BODY_MARKER}</body></html>`, {
    status,
    headers: { 'content-type': 'text/html; charset=UTF-8', ...headers },
  })
}

function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

const FULL_SUCCESS = {
  access_token: NEW_ACCESS,
  expires_in: 3600,
  refresh_token: NEW_REFRESH,
  refresh_token_expires_in: 7_776_000,
  scope: 'read_products,write_discounts',
}

const ALWAYS_SECRET = [SECRET, PRESENTED_REFRESH, LEGACY, BODY_MARKER]

function expectNoLeak(value: unknown, extra: string[] = []) {
  const serialized = value instanceof Error ? `${value.message}\n${value.stack ?? ''}` : JSON.stringify(value)
  for (const secret of [...ALWAYS_SECRET, ...extra]) expect(serialized).not.toContain(secret)
}

function expectFailure(result: TokenCallResult) {
  if (result.outcome === 'success') throw new Error('expected a failure result')
  return result
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createTokenClient', () => {
  it.each([
    ['empty apiKey', { apiKey: '', apiSecretKey: SECRET }],
    ['empty apiSecretKey', { apiKey: API_KEY, apiSecretKey: '' }],
    ['whitespace apiSecretKey', { apiKey: API_KEY, apiSecretKey: '  ' }],
    ['missing apiKey', { apiKey: undefined, apiSecretKey: SECRET }],
    ['missing apiSecretKey', { apiKey: API_KEY, apiSecretKey: undefined }],
  ])('throws at creation with %s, without echoing the secret', (_, options) => {
    let thrown: unknown
    try {
      createTokenClient(options as unknown as TokenClientOptions)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expectNoLeak(thrown)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects timeoutMs %s', (timeoutMs) => {
    expect(() => createTokenClient({ apiKey: API_KEY, apiSecretKey: SECRET, timeoutMs })).toThrow(/timeoutMs/)
  })

  it('uses the global fetch, looked up at call time, when none is given', async () => {
    const { fn } = fakeFetch(() => json(FULL_SUCCESS))
    const tokens = createTokenClient({ apiKey: API_KEY, apiSecretKey: SECRET })
    vi.stubGlobal('fetch', fn)
    const result = await tokens.refresh(SHOP, PRESENTED_REFRESH)
    expect(result.outcome).toBe('success')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('requests', () => {
  it('refresh posts the refresh_token grant as JSON to the shop, without following redirects', async () => {
    const { calls } = await run('refresh', json(FULL_SUCCESS))
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.url).toBe(TOKEN_URL)
    expect(call?.init.method).toBe('POST')
    expect(call?.init.redirect).toBe('manual')
    expect(call?.init.signal).toBeInstanceOf(AbortSignal)
    expect(call?.init.headers).toStrictEqual({ 'Content-Type': 'application/json', Accept: 'application/json' })
    expect(typeof call?.init.body).toBe('string')
    expect(JSON.parse(call?.init.body as string)).toStrictEqual({
      client_id: API_KEY,
      client_secret: SECRET,
      grant_type: 'refresh_token',
      refresh_token: PRESENTED_REFRESH,
    })
  })

  it('migrate posts the token-exchange grant for an expiring offline token', async () => {
    const { calls } = await run('migrate', json(FULL_SUCCESS))
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.url).toBe(TOKEN_URL)
    expect(call?.init.method).toBe('POST')
    expect(call?.init.redirect).toBe('manual')
    expect(call?.init.signal).toBeInstanceOf(AbortSignal)
    expect(call?.init.headers).toStrictEqual({ 'Content-Type': 'application/json', Accept: 'application/json' })
    expect(JSON.parse(call?.init.body as string)).toStrictEqual({
      client_id: API_KEY,
      client_secret: SECRET,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: LEGACY,
      subject_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1',
    })
  })

  it('accepts underscores and hyphens in the shop name', async () => {
    const { tokens, calls } = makeClient(() => json(FULL_SUCCESS))
    const result = await tokens.refresh('my_shop-2.myshopify.com', PRESENTED_REFRESH)
    expect(result.outcome).toBe('success')
    expect(calls[0]?.url).toBe('https://my_shop-2.myshopify.com/admin/oauth/access_token')
  })

  it('calls a myshopify.io shop only when allowed', async () => {
    const allowed = makeClient(() => json(FULL_SUCCESS), { allowMyshopifyIo: true })
    expect((await allowed.tokens.migrate('dev-shop.myshopify.io', LEGACY)).outcome).toBe('success')
    expect(allowed.calls[0]?.url).toBe('https://dev-shop.myshopify.io/admin/oauth/access_token')

    const denied = makeClient(() => json(FULL_SUCCESS))
    const result = expectFailure(await denied.tokens.migrate('dev-shop.myshopify.io', LEGACY))
    expect(result.code).toBe('invalid_shop')
    expect(denied.fn).not.toHaveBeenCalled()
  })
})

describe('host safety', () => {
  const invalidShops = [
    'Test-Shop.myshopify.com',
    ' test-shop.myshopify.com',
    'test-shop.myshopify.com ',
    'test-shop.myshopify.com/',
    'test-shop.myshopify.com/admin',
    'test-shop.myshopify.com:443',
    'test-shop.myshopify.com:8443',
    'user@test-shop.myshopify.com',
    'test-shop.myshopify.com@evil.example',
    'test-shop.myshopify.com.evil.example',
    'test-shop.myshopify.com#',
    'https://test-shop.myshopify.com',
    '-shop.myshopify.com',
    'myshopify.com',
    'evil.example',
    '',
  ]

  it.each(invalidShops.flatMap((shop) => (['refresh', 'migrate'] as const).map((grant) => [grant, shop] as const)))(
    '%s to %j is a configuration error and sends nothing',
    async (grant, shop) => {
      const { tokens, fn } = makeClient(() => json(FULL_SUCCESS))
      const result =
        grant === 'refresh' ? await tokens.refresh(shop, PRESENTED_REFRESH) : await tokens.migrate(shop, LEGACY)
      expect(result).toStrictEqual({ outcome: 'configuration', sentAt: NOW, ambiguous: false, code: 'invalid_shop' })
      expect(fn).not.toHaveBeenCalled()
    },
  )

  it('rejects a non-string shop', async () => {
    const { tokens, fn } = makeClient(() => json(FULL_SUCCESS))
    const result = expectFailure(await tokens.refresh(undefined as unknown as string, PRESENTED_REFRESH))
    expect(result.code).toBe('invalid_shop')
    expect(fn).not.toHaveBeenCalled()
  })

  it.each(['', '   ', undefined])('refuses to present an empty token (%j)', async (token) => {
    const { tokens, fn } = makeClient(() => json(FULL_SUCCESS))
    const refresh = await tokens.refresh(SHOP, token as unknown as string)
    const migrate = await tokens.migrate(SHOP, token as unknown as string)
    for (const result of [refresh, migrate]) {
      expect(result).toStrictEqual({ outcome: 'configuration', sentAt: NOW, ambiguous: false, code: 'missing_token' })
    }
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('success', () => {
  it.each(['refresh', 'migrate'] as const)('%s returns every field from a full response', async (grant) => {
    const { result } = await run(
      grant,
      json(FULL_SUCCESS, 200, { 'x-request-id': 'b1946ac9-2f7a-4c0e-9d1b-7f3e2a1c5d6e' }),
    )
    expect(result).toStrictEqual({
      outcome: 'success',
      sentAt: NOW,
      accessToken: NEW_ACCESS,
      expiresIn: 3600,
      refreshToken: NEW_REFRESH,
      refreshTokenExpiresIn: 7_776_000,
      scope: 'read_products,write_discounts',
      missing: [],
      requestId: 'b1946ac9-2f7a-4c0e-9d1b-7f3e2a1c5d6e',
    })
  })

  it('treats any 2xx with an access token as success', async () => {
    const { result } = await run('refresh', json(FULL_SUCCESS, 201))
    expect(result.outcome).toBe('success')
  })

  it('reports a migration response without scope as missing it', async () => {
    const { scope: _scope, ...withoutScope } = FULL_SUCCESS
    const { result } = await run('migrate', json(withoutScope))
    expect(result).toMatchObject({ outcome: 'success', accessToken: NEW_ACCESS, missing: ['scope'] })
    expect(result).not.toHaveProperty('scope')
  })

  it('accepts lifetimes sent as numeric strings', async () => {
    const { result } = await run(
      'refresh',
      json({ ...FULL_SUCCESS, expires_in: '3600', refresh_token_expires_in: ' 7776000 ' }),
    )
    expect(result).toMatchObject({ outcome: 'success', expiresIn: 3600, refreshTokenExpiresIn: 7_776_000, missing: [] })
  })

  it.each([0, -5, '0', '-5', 'abc', '', '1e3', '12abc', '0x10', null, true, {}, []])(
    'treats lifetime %j as missing',
    async (value) => {
      const { result } = await run(
        'refresh',
        json({ ...FULL_SUCCESS, expires_in: value, refresh_token_expires_in: value }),
      )
      expect(result).toMatchObject({ outcome: 'success', missing: ['expires_in', 'refresh_token_expires_in'] })
      expect(result).not.toHaveProperty('expiresIn')
      expect(result).not.toHaveProperty('refreshTokenExpiresIn')
    },
  )

  it('lists invalid refresh_token and scope as missing', async () => {
    const { result } = await run('refresh', json({ ...FULL_SUCCESS, refresh_token: '', scope: 42 }))
    expect(result).toMatchObject({ outcome: 'success', missing: ['refresh_token', 'scope'] })
    expect(result).not.toHaveProperty('refreshToken')
    expect(result).not.toHaveProperty('scope')
  })

  it('lists every absent field, in order, when only the access token comes back', async () => {
    const { result } = await run('refresh', json({ access_token: NEW_ACCESS }))
    expect(result).toStrictEqual({
      outcome: 'success',
      sentAt: NOW,
      accessToken: NEW_ACCESS,
      missing: ['expires_in', 'refresh_token', 'refresh_token_expires_in', 'scope'],
    })
  })

  it('carries nothing else from the body', async () => {
    const { result } = await run('refresh', json({ ...FULL_SUCCESS, note: BODY_MARKER, associated_user: { id: 1 } }))
    expectNoLeak(result)
  })
})

describe('2xx without a usable access token', () => {
  it.each<[string, () => Response]>([
    ['an HTML page', () => html(200)],
    ['an empty object', () => json({})],
    ['a JSON array', () => json([FULL_SUCCESS])],
    ['JSON null', () => text('null', 200)],
    ['an empty access_token', () => json({ ...FULL_SUCCESS, access_token: '' })],
    ['a numeric access_token', () => json({ ...FULL_SUCCESS, access_token: 123 })],
    ['an empty body', () => text('', 200)],
    ['truncated JSON', () => text(`{"access_token":"${NEW_ACCESS}"`, 200)],
    ['204 No Content', () => new Response(null, { status: 204 })],
  ])('%s is transient and ambiguous', async (_, response) => {
    for (const grant of ['refresh', 'migrate'] as const) {
      const res = response()
      const { result } = await run(grant, res)
      expect(result).toStrictEqual({
        outcome: 'transient',
        sentAt: NOW,
        ambiguous: true,
        code: 'invalid_response',
        status: res.status,
      })
    }
  })
})

describe('terminal', () => {
  it('refresh: 401 invalid_request', async () => {
    const { result } = await run(
      'refresh',
      json({ error: 'invalid_request', error_description: 'This request requires an active refresh_token' }, 401, {
        'x-request-id': 'req-401',
      }),
    )
    expect(result).toStrictEqual({
      outcome: 'terminal',
      sentAt: NOW,
      ambiguous: false,
      code: 'invalid_request',
      status: 401,
      requestId: 'req-401',
    })
  })

  it.each(['invalid_subject_token', 'invalid_requested_token_type'])('migrate: 400 %s', async (error) => {
    const { result } = await run('migrate', json({ error }, 400))
    expect(result).toStrictEqual({ outcome: 'terminal', sentAt: NOW, ambiguous: false, code: error, status: 400 })
  })
})

describe('configuration', () => {
  it.each<[Grant, () => Response, string]>([
    ['refresh', () => json({ error: 'invalid_request' }, 400), 'invalid_request'],
    ['refresh', () => json({ error: 'invalid_client' }, 401), 'invalid_client'],
    ['refresh', () => json({ error: 'invalid_subject_token' }, 400), 'invalid_subject_token'],
    ['refresh', () => html(401), 'http_401'],
    ['refresh', () => json({}, 401), 'http_401'],
    ['refresh', () => json({ error: 'Invalid Client' }, 400), 'http_400'],
    ['refresh', () => json({ error: 'a'.repeat(65) }, 400), 'http_400'],
    ['refresh', () => json({ error: 42 }, 400), 'http_400'],
    ['refresh', () => json({ error: '' }, 400), 'http_400'],
    ['refresh', () => json({ errors: '[API] Invalid API key or access token' }, 403), 'http_403'],
    ['refresh', () => json({ error: 'invalid_client' }, 403), 'invalid_client'],
    ['refresh', () => text('', 405), 'http_405'],
    ['refresh', () => text('nope', 418), 'http_418'],
    ['refresh', () => json({ error: 'invalid_grant' }, 422), 'invalid_grant'],
    ['migrate', () => json({ error: 'invalid_request' }, 401), 'invalid_request'],
    ['migrate', () => json({ error: 'invalid_request' }, 400), 'invalid_request'],
    ['migrate', () => json({ error: 'invalid_subject_token' }, 403), 'invalid_subject_token'],
    ['migrate', () => json({ error: 'invalid_subject_token' }, 401), 'invalid_subject_token'],
    ['migrate', () => text('', 400), 'http_400'],
  ])('%s: %#', async (grant, response, code) => {
    const res = response()
    const { result } = await run(grant, res)
    expect(result).toStrictEqual({ outcome: 'configuration', sentAt: NOW, ambiguous: false, code, status: res.status })
  })

  it.each([301, 302, 303, 307, 308])('a %i redirect is a configuration error and is not followed', async (status) => {
    for (const grant of ['refresh', 'migrate'] as const) {
      const { result, calls } = await run(
        grant,
        text(BODY_MARKER, status, { location: 'https://evil.example/admin/oauth/access_token', 'x-request-id': 'r-3' }),
      )
      expect(result).toStrictEqual({
        outcome: 'configuration',
        sentAt: NOW,
        ambiguous: false,
        code: 'redirect',
        status,
        requestId: 'r-3',
      })
      expect(calls).toHaveLength(1)
    }
  })

  it('an opaque redirect (browser-style manual mode) is a configuration error', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, headers: new Headers(), body: null } as unknown as Response
    const { result } = await run('refresh', opaque)
    expect(result).toMatchObject({ outcome: 'configuration', code: 'redirect', ambiguous: false })
  })
})

describe('shop unavailable', () => {
  it.each([402, 404, 423])('%i', async (status) => {
    for (const grant of ['refresh', 'migrate'] as const) {
      for (const res of [json({ errors: 'Unavailable Shop' }, status), html(status)]) {
        const { result } = await run(grant, res)
        expect(result).toStrictEqual({
          outcome: 'shop_unavailable',
          sentAt: NOW,
          ambiguous: false,
          code: `http_${status}`,
          status,
        })
      }
    }
  })
})

describe('transient', () => {
  it('429 is transient and not ambiguous', async () => {
    for (const grant of ['refresh', 'migrate'] as const) {
      const { result } = await run(grant, json({ errors: 'Too many requests' }, 429))
      expect(result).toStrictEqual({
        outcome: 'transient',
        sentAt: NOW,
        ambiguous: false,
        code: 'http_429',
        status: 429,
      })
    }
  })

  it.each<[string, number | undefined]>([
    ['30', 30_000],
    [' 30 ', 30_000],
    ['0', 0],
    ['600', 600_000],
    ['601', 600_000],
    ['99999999999999999999999', 600_000],
    [new Date(NOW + 120_000).toUTCString(), 120_000],
    [new Date(NOW - 60_000).toUTCString(), 0],
    [new Date(NOW + 3_600_000).toUTCString(), 600_000],
    ['soon', undefined],
    ['1.5', undefined],
    ['-5', undefined],
    ['', undefined],
  ])('429 with Retry-After %j', async (retryAfter, expected) => {
    const { result } = await run('refresh', text('', 429, { 'retry-after': retryAfter }))
    const failure = expectFailure(result)
    expect(failure).toMatchObject({ outcome: 'transient', code: 'http_429', ambiguous: false })
    if (expected === undefined) expect(failure).not.toHaveProperty('retryAfterMs')
    else expect(failure.retryAfterMs).toBe(expected)
  })

  it('measures an HTTP-date Retry-After from when the response arrived', async () => {
    let clock = NOW
    const { result } = await run(
      'refresh',
      () => {
        clock = NOW + 30_000
        return text('', 429, { 'retry-after': new Date(NOW + 120_000).toUTCString() })
      },
      { now: () => clock },
    )
    expect(result).toMatchObject({ sentAt: NOW, retryAfterMs: 90_000 })
  })

  it.each<[number, () => Response]>([
    [500, () => json({ errors: 'Internal Server Error' }, 500)],
    [502, () => html(502)],
    [503, () => text('', 503)],
    [504, () => text('upstream timed out', 504)],
    [520, () => html(520)],
  ])('%i is transient and ambiguous', async (status, response) => {
    for (const grant of ['refresh', 'migrate'] as const) {
      const { result } = await run(grant, response())
      expect(result).toStrictEqual({
        outcome: 'transient',
        sentAt: NOW,
        ambiguous: true,
        code: `http_${status}`,
        status,
      })
    }
  })

  it('passes Retry-After through on a 503', async () => {
    const { result } = await run('refresh', text('', 503, { 'retry-after': '5' }))
    expect(result).toMatchObject({ outcome: 'transient', ambiguous: true, code: 'http_503', retryAfterMs: 5000 })
  })

  it.each<[string, () => Response]>([
    ['403 HTML', () => html(403)],
    ['403 body starting with <', () => text(`  <html>${BODY_MARKER}</html>`, 403)],
    ['403 JSON with cf-mitigated', () => json({ error: 'forbidden' }, 403, { 'cf-mitigated': 'challenge' })],
    ['429 HTML', () => html(429)],
    ['429 with cf-mitigated', () => text('', 429, { 'cf-mitigated': 'challenge' })],
    ['503 with cf-mitigated', () => html(503, { 'cf-mitigated': 'challenge' })],
    ['401 with cf-mitigated', () => json({ error: 'invalid_request' }, 401, { 'cf-mitigated': 'challenge' })],
  ])('a Cloudflare challenge (%s) is transient and not ambiguous', async (_, response) => {
    for (const grant of ['refresh', 'migrate'] as const) {
      const res = response()
      const { result } = await run(grant, res)
      expect(result).toStrictEqual({
        outcome: 'transient',
        sentAt: NOW,
        ambiguous: false,
        code: 'challenge',
        status: res.status,
      })
    }
  })

  it('keeps Retry-After on a challenge', async () => {
    const { result } = await run('refresh', html(429, { 'cf-mitigated': 'challenge', 'retry-after': '60' }))
    expect(result).toMatchObject({ code: 'challenge', retryAfterMs: 60_000 })
  })
})

describe('network failures and timeouts', () => {
  it('a rejected fetch is transient, ambiguous, network', async () => {
    const { result } = await run('refresh', () => Promise.reject(new TypeError('fetch failed')))
    expect(result).toStrictEqual({ outcome: 'transient', sentAt: NOW, ambiguous: true, code: 'network' })
  })

  it('a fetch that throws synchronously is a network failure', async () => {
    const throwing = vi.fn(() => {
      throw new TypeError('bad init')
    })
    const tokens = createTokenClient({
      apiKey: API_KEY,
      apiSecretKey: SECRET,
      fetch: throwing as unknown as typeof fetch,
      now: () => NOW,
    })
    expect(await tokens.migrate(SHOP, LEGACY)).toStrictEqual({
      outcome: 'transient',
      sentAt: NOW,
      ambiguous: true,
      code: 'network',
    })
  })

  it('times out after 10 s by default and aborts the request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let signal: AbortSignal | undefined
    const { tokens } = makeClient(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          signal = init.signal ?? undefined
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    let settled = false
    const pending = tokens.refresh(SHOP, PRESENTED_REFRESH).finally(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toStrictEqual({ outcome: 'transient', sentAt: NOW, ambiguous: true, code: 'timeout' })
    expect(signal?.aborted).toBe(true)
  })

  it('times out even when fetch ignores the abort signal', async () => {
    const { result } = await run('migrate', () => new Promise<Response>(() => {}), { timeoutMs: 20 })
    expect(result).toStrictEqual({ outcome: 'transient', sentAt: NOW, ambiguous: true, code: 'timeout' })
  })

  it('times out while reading a body that never ends', async () => {
    const stalled = () => new Response(new ReadableStream({ start() {} }), { status: 200 })
    const { result } = await run('refresh', stalled, { timeoutMs: 20 })
    expect(result).toStrictEqual({ outcome: 'transient', sentAt: NOW, ambiguous: true, code: 'timeout', status: 200 })
  })

  it.each([
    [200, true],
    [500, true],
    [401, false],
    [429, false],
  ])('a %i whose body fails to read is transient (ambiguous: %s)', async (status, ambiguous) => {
    const broken = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(`stream broke ${SECRET} ${BODY_MARKER}`))
          },
        }),
        { status },
      )
    const { result } = await run('refresh', broken)
    expect(result).toStrictEqual({ outcome: 'transient', sentAt: NOW, ambiguous, code: 'network', status })
    expectNoLeak(result)
  })

  it('clears its timer once the call completes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let signal: AbortSignal | undefined
    const { tokens } = makeClient(({ init }) => {
      signal = init.signal ?? undefined
      return json(FULL_SUCCESS)
    })
    expect((await tokens.refresh(SHOP, PRESENTED_REFRESH)).outcome).toBe('success')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(signal?.aborted).toBe(false)
  })
})

describe('metadata', () => {
  it('records sentAt just before the request, not after the response', async () => {
    let clock = 1_000
    const { tokens } = makeClient(
      () => {
        clock = 9_000
        return json({ error: 'invalid_request' }, 401)
      },
      { now: () => clock },
    )
    expect(await tokens.refresh(SHOP, PRESENTED_REFRESH)).toMatchObject({ outcome: 'terminal', sentAt: 1_000 })
  })

  it.each([
    ['has spaces in it', undefined],
    ['a'.repeat(129), undefined],
    ['<script>', undefined],
    ['  4f1c-a9-b2  ', '4f1c-a9-b2'],
    ['abc_DEF.123:x', 'abc_DEF.123:x'],
  ])('x-request-id %j', async (header, expected) => {
    const { result } = await run('refresh', json({ error: 'invalid_request' }, 401, { 'x-request-id': header }))
    if (expected === undefined) expect(result).not.toHaveProperty('requestId')
    else expect(result).toHaveProperty('requestId', expected)
  })
})

describe('no secrets in results', () => {
  const echo = `${BODY_MARKER} ${SECRET} ${PRESENTED_REFRESH} ${LEGACY} ${NEW_ACCESS} ${NEW_REFRESH}`
  const failures: [string, () => Response | Promise<Response>][] = [
    ['200 without access_token', () => json({ refresh_token: NEW_REFRESH, error_description: echo })],
    ['200 HTML', () => text(`<html>${echo}</html>`, 200)],
    ['302', () => text(echo, 302, { location: `https://evil.example/?t=${PRESENTED_REFRESH}` })],
    ['400 JSON', () => json({ error: 'invalid_subject_token', error_description: echo }, 400)],
    ['400 error is free text', () => json({ error: echo }, 400)],
    ['401 JSON', () => json({ error: 'invalid_request', error_description: echo }, 401)],
    ['401 plain', () => text(echo, 401)],
    ['402', () => text(echo, 402)],
    ['403 HTML', () => text(`<html>${echo}</html>`, 403)],
    ['404', () => json({ errors: echo }, 404)],
    ['423', () => text(echo, 423)],
    ['429', () => json({ errors: echo }, 429)],
    ['500', () => json({ errors: echo }, 500)],
    ['502 HTML', () => text(`<html>${echo}</html>`, 502)],
    ['fetch rejects with secrets in the message', () => Promise.reject(new Error(echo))],
  ]

  it.each(
    failures.flatMap(([name, response]) => (['refresh', 'migrate'] as const).map((g) => [g, name, response] as const)),
  )('%s: %s', async (grant, _, response) => {
    const { result } = await run(grant, response)
    expect(result.outcome).not.toBe('success')
    expectNoLeak(result, [NEW_ACCESS, NEW_REFRESH])
  })

  it('a success carries only the new tokens, never the presented credential or secret', async () => {
    for (const grant of ['refresh', 'migrate'] as const) {
      const { result } = await run(grant, json({ ...FULL_SUCCESS, echo }))
      expect(result.outcome).toBe('success')
      expectNoLeak(result)
    }
  })
})
