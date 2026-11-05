import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_ROLLOVER_REQUEST_KEY, DEFAULT_ROLLOVER_STATE_KEY, rolloverShops } from '../../src/rollover.js'
import type { RolloverShopsOptions } from '../../src/rollover.js'
import { DEFAULT_LOCATION_HINT } from '../../src/types.js'
import type { RolloverResult } from '../../src/types.js'

const REQUEST = DEFAULT_ROLLOVER_REQUEST_KEY
const STATE = DEFAULT_ROLLOVER_STATE_KEY
const T0 = Date.UTC(2026, 9, 27, 9)
const CUT = T0 - 60_000

const shopName = (i: number) => `shop-${String(i).padStart(3, '0')}.myshopify.com`
const shops = (n: number) => Array.from({ length: n }, (_, i) => shopName(i))

type ListCall = { prefix?: string; cursor?: string; limit?: number }

/** KV with name-ordered listing and position cursors (stable across deletes, like Cloudflare's). */
function fakeKv(shopList: string[]) {
  const store = new Map(shopList.map((shop) => [`shop-session:${shop}`, '']))
  const lists: ListCall[] = []
  const puts: string[] = []
  const kv = {
    async get(key: string, _type: 'json') {
      const value = store.get(key)
      return value === undefined ? null : JSON.parse(value)
    },
    async put(key: string, value: string) {
      puts.push(key)
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
    async list(opts: ListCall = {}) {
      lists.push({ ...opts })
      const limit = opts.limit ?? 1000
      const after = opts.cursor ? Buffer.from(opts.cursor, 'base64').toString() : ''
      const matching = [...store.keys()].filter((key) => key.startsWith(opts.prefix ?? '') && key > after).sort()
      const page = matching.slice(0, limit)
      const complete = matching.length <= limit
      return {
        keys: page.map((name) => ({ name })),
        list_complete: complete,
        ...(!complete && { cursor: Buffer.from(page.at(-1) ?? after).toString('base64') }),
      }
    },
  }
  const request = (value: unknown) => store.set(REQUEST, JSON.stringify(value))
  const json = (key: string) => (store.has(key) ? JSON.parse(store.get(key)!) : undefined)
  return { kv, store, lists, puts, request, json }
}

type Handler = (shop: string, obtainedBefore: number) => RolloverResult | Promise<RolloverResult>

/** Durable Objects whose rollover answers via `handler` (default: rolled once, then current). */
function fakeNamespace(handler?: Handler) {
  const calls: string[] = []
  const gets: { name: string; options: unknown }[] = []
  const rolled = new Set<string>()
  let inFlight = 0
  let maxInFlight = 0
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get(id: never, options?: { locationHint?: string }) {
      const { name } = id as { name: string }
      gets.push({ name, options })
      return {
        async rollover(input: { shop: string; obtainedBefore: number }) {
          expect(input.shop).toBe(name)
          calls.push(input.shop)
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 0))
          inFlight--
          if (handler) return handler(input.shop, input.obtainedBefore)
          if (rolled.has(input.shop)) return { status: 'current' }
          rolled.add(input.shop)
          return { status: 'rolled', source: 'refresh' }
        },
      }
    },
  }
  return { namespace, calls, gets, maxInFlight: () => maxInFlight }
}

async function run(
  kv: ReturnType<typeof fakeKv>['kv'],
  namespace: RolloverShopsOptions['namespace'],
  options: Partial<RolloverShopsOptions> = {},
) {
  const reports: string[] = []
  const result = await rolloverShops({
    kv,
    namespace,
    now: () => T0,
    report: (error) => reports.push(error.message),
    ...options,
  })
  return { ...result, reports }
}

const failed = (code = 'http_503', kind: 'transient' | 'configuration' | 'shop_unavailable' = 'transient') =>
  ({ status: 'failed', kind, code, retryAt: T0 + 60_000 }) as const

describe('rolloverShops', () => {
  it('does nothing without a request', async () => {
    const { kv, lists } = fakeKv(shops(3))
    const { namespace, calls } = fakeNamespace()
    expect(await run(kv, namespace)).toEqual({ status: 'idle', attempted: 0, outcomes: {}, reports: [] })
    expect(calls).toEqual([])
    expect(lists).toEqual([])
  })

  it('rolls every registered shop, then records the pass and deletes the request', async () => {
    const { kv, request, json, store } = fakeKv(shops(5))
    request({ obtainedBefore: new Date(CUT).toISOString() })
    const { namespace, calls, gets } = fakeNamespace()

    const result = await run(kv, namespace)

    expect(result).toMatchObject({ status: 'done', attempted: 5, outcomes: { rolled: 5 } })
    expect(calls.sort()).toEqual(shops(5))
    expect(gets.every((get) => (get.options as { locationHint: string }).locationHint === DEFAULT_LOCATION_HINT)).toBe(
      true,
    )
    expect(store.has(REQUEST)).toBe(false)
    expect(json(STATE)).toEqual({
      obtainedBefore: CUT,
      startedAt: T0,
      attempted: 5,
      outcomes: { rolled: 5 },
      unrolled: [],
      completedAt: T0,
    })
    // Idle again until the next request.
    expect((await run(kv, namespace)).status).toBe('idle')
  })

  it('passes obtainedBefore to every object, taking a ms epoch as well as an ISO time', async () => {
    const { kv, request } = fakeKv(shops(2))
    request({ obtainedBefore: CUT })
    const seen: number[] = []
    const { namespace } = fakeNamespace((_shop, obtainedBefore) => {
      seen.push(obtainedBefore)
      return { status: 'current' }
    })
    await run(kv, namespace)
    expect(seen).toEqual([CUT, CUT])
  })

  it('lists the unrolled shops with why', async () => {
    const { kv, request } = fakeKv(shops(4))
    request({ obtainedBefore: CUT })
    const answers: Record<string, RolloverResult> = {
      [shopName(0)]: { status: 'rolled', source: 'migrate' },
      [shopName(1)]: { status: 'needs_reauth', since: 1, reason: 'refresh_rejected' },
      [shopName(2)]: failed('http_402', 'shop_unavailable'),
      [shopName(3)]: { status: 'skipped', reason: 'migration_off' },
    }
    const { namespace } = fakeNamespace((shop) => answers[shop]!)
    const result = await run(kv, namespace)
    expect(result.pass?.unrolled).toEqual([
      { shop: shopName(1), status: 'needs_reauth', code: 'refresh_rejected' },
      { shop: shopName(2), status: 'failed', code: 'http_402' },
      { shop: shopName(3), status: 'skipped', code: 'migration_off' },
    ])
  })

  it('pauses at stopAfter and carries on from there when it is raised', async () => {
    const { kv, request } = fakeKv(shops(12))
    request({ obtainedBefore: CUT, stopAfter: 1 })
    const { namespace, calls } = fakeNamespace()

    expect(await run(kv, namespace)).toMatchObject({ status: 'paused', attempted: 1, pass: { attempted: 1 } })
    expect(await run(kv, namespace)).toMatchObject({ status: 'paused', attempted: 0 })
    expect(calls).toEqual([shopName(0)])

    request({ obtainedBefore: CUT, stopAfter: 10 })
    expect(await run(kv, namespace)).toMatchObject({ status: 'paused', attempted: 9, pass: { attempted: 10 } })
    request({ obtainedBefore: CUT })
    expect(await run(kv, namespace)).toMatchObject({ status: 'done', attempted: 2, pass: { attempted: 12 } })
    expect(calls).toEqual(shops(12))
  })

  it('stops at maxShops per run and resumes from the saved cursor', async () => {
    const { kv, request } = fakeKv(shops(7))
    request({ obtainedBefore: CUT })
    const { namespace, calls } = fakeNamespace()
    expect(await run(kv, namespace, { maxShops: 3 })).toMatchObject({ status: 'running', attempted: 3 })
    expect(await run(kv, namespace, { maxShops: 3 })).toMatchObject({ status: 'running', attempted: 3 })
    expect(await run(kv, namespace, { maxShops: 3 })).toMatchObject({ status: 'done', attempted: 1 })
    expect(calls).toEqual(shops(7))
  })

  it('stops at the time budget between pages', async () => {
    const { kv, request } = fakeKv(shops(150))
    request({ obtainedBefore: CUT })
    const { namespace } = fakeNamespace()
    let t = T0
    const result = await run(kv, namespace, { budgetMs: 1000, now: () => (t += 600) })
    expect(result).toMatchObject({ status: 'running', attempted: 100 })
  })

  it('halts the pass when most of a run fails, and resumes only when the request is written again', async () => {
    const { kv, request, json } = fakeKv(shops(30))
    request({ obtainedBefore: CUT })
    const { namespace, calls } = fakeNamespace(() => failed())

    const first = await run(kv, namespace, { concurrency: 1 })
    expect(first).toMatchObject({ status: 'halted', attempted: 10, outcomes: { failed: 10 } })
    expect(first.reports).toEqual([expect.stringContaining('10 of 10 shops failed or were rejected')])
    expect(json(REQUEST)).toEqual({ obtainedBefore: CUT, halted: '10 of 10 shops failed or were rejected in this run' })

    expect(await run(kv, namespace, { concurrency: 1 })).toMatchObject({ status: 'halted', attempted: 0 })
    expect(calls).toHaveLength(10)

    // Written again: the halted page is redone from its start.
    request({ obtainedBefore: CUT })
    await run(kv, namespace, { concurrency: 1 })
    expect(calls.slice(10, 11)).toEqual([shopName(0)])
  })

  it('counts rejections and errors toward the breaker, but not frozen shops', async () => {
    const answers = [
      failed('http_402', 'shop_unavailable'),
      { status: 'rejected', reason: 'legacy_rejected' } as const,
      new Error('boom'),
    ]
    for (const [i, answer] of answers.entries()) {
      const { kv, request } = fakeKv(shops(12))
      request({ obtainedBefore: CUT })
      const { namespace } = fakeNamespace(() => {
        if (answer instanceof Error) throw answer
        return answer
      })
      const result = await run(kv, namespace, { concurrency: 1 })
      expect(result.status, `answer ${i}`).toBe(i === 0 ? 'done' : 'halted')
    }
  })

  it("doesn't halt on a closed shop's configuration failure", async () => {
    const { kv, request, json } = fakeKv(shops(20))
    request({ obtainedBefore: CUT })
    const { namespace } = fakeNamespace((shop) =>
      shop === shopName(2) ? failed('http_403', 'configuration') : { status: 'rolled', source: 'refresh' },
    )
    const result = await run(kv, namespace, { concurrency: 1 })
    expect(result).toMatchObject({ status: 'done', attempted: 20, outcomes: { rolled: 19, failed: 1 }, reports: [] })
    expect((json(STATE) as { unrolled: unknown }).unrolled).toEqual([
      { shop: shopName(2), status: 'failed', code: 'http_403' },
    ])
  })

  it('halts when most of a run fails with a configuration error', async () => {
    const { kv, request, json } = fakeKv(shops(30))
    request({ obtainedBefore: CUT })
    const { namespace, calls } = fakeNamespace(() => failed('invalid_client', 'configuration'))
    const result = await run(kv, namespace, { concurrency: 1 })
    const reason = `10 of 10 shops failed with a configuration error in this run (last: invalid_client for ${shopName(9)})`
    expect(result).toMatchObject({ status: 'halted', attempted: 10 })
    expect(calls).toHaveLength(10)
    expect(result.reports).toEqual([expect.stringContaining(reason)])
    expect(json(REQUEST)).toEqual({ obtainedBefore: CUT, halted: reason })
  })

  it("doesn't add configuration failures to rejections", async () => {
    const { kv, request } = fakeKv(shops(12))
    request({ obtainedBefore: CUT })
    const answers = [
      failed('http_403', 'configuration'),
      { status: 'rejected', reason: 'legacy_rejected' } as const,
      { status: 'rolled', source: 'migrate' } as const,
    ]
    const { namespace } = fakeNamespace((shop) => answers[shops(12).indexOf(shop) % 3]!)
    const result = await run(kv, namespace, { concurrency: 1 })
    expect(result).toMatchObject({ status: 'done', outcomes: { failed: 4, rejected: 4, rolled: 4 } })
  })

  it('stops the run on a 429 and redoes the page next run', async () => {
    const { kv, request, store } = fakeKv(shops(5))
    request({ obtainedBefore: CUT })
    let throttle = true
    const { namespace, calls } = fakeNamespace((shop) => {
      if (shop === shopName(1) && throttle) {
        throttle = false
        return failed('http_429')
      }
      return { status: 'rolled', source: 'refresh' }
    })
    expect(await run(kv, namespace, { concurrency: 1 })).toMatchObject({ status: 'throttled', attempted: 2 })
    expect(store.has(REQUEST)).toBe(true)
    expect(await run(kv, namespace, { concurrency: 1 })).toMatchObject({ status: 'done', attempted: 5 })
    expect(calls).toEqual([shopName(0), shopName(1), ...shops(5)])
  })

  it('starts a new pass for a new obtainedBefore, or once a pass finished', async () => {
    const { kv, request } = fakeKv(shops(3))
    const { namespace } = fakeNamespace(() => ({ status: 'current' }))
    request({ obtainedBefore: CUT, stopAfter: 2 })
    expect(await run(kv, namespace)).toMatchObject({ pass: { obtainedBefore: CUT, attempted: 2 } })
    request({ obtainedBefore: CUT + 1 })
    expect(await run(kv, namespace)).toMatchObject({ status: 'done', pass: { obtainedBefore: CUT + 1, attempted: 3 } })
    request({ obtainedBefore: CUT + 1 })
    expect(await run(kv, namespace)).toMatchObject({ status: 'done', pass: { attempted: 3 } })
  })

  it("uses the request's concurrency", async () => {
    const { kv, request } = fakeKv(shops(40))
    request({ obtainedBefore: CUT, concurrency: 20 })
    const fake = fakeNamespace()
    await run(kv, fake.namespace, { concurrency: 2 })
    expect(fake.maxInFlight()).toBe(20)
  })

  it('rejects an invalid request without touching any shop', async () => {
    for (const value of [
      [1],
      { obtainedBefore: 'yesterday' },
      { obtainedBefore: T0 + 2 * 60_000 },
      { obtainedBefore: CUT, stopAfter: -1 },
      { obtainedBefore: CUT, concurrency: 51 },
    ]) {
      const { kv, request } = fakeKv(shops(2))
      request(value)
      const { namespace, calls } = fakeNamespace()
      const result = await run(kv, namespace)
      expect(result.status, JSON.stringify(value)).toBe('invalid_request')
      expect(result.reports).toHaveLength(1)
      expect(calls).toEqual([])
    }
  })

  it('counts a marker that names no canonical shop as invalid', async () => {
    const { kv, request, store } = fakeKv(shops(1))
    store.set('shop-session:Not A Shop', '')
    request({ obtainedBefore: CUT })
    const { namespace, calls } = fakeNamespace()
    expect(await run(kv, namespace)).toMatchObject({ outcomes: { invalid: 1, rolled: 1 } })
    expect(calls).toEqual([shopName(0)])
  })
  it('retries the final state write once, since KV refuses a second write to a key within a second', async () => {
    const { kv, request, json } = fakeKv(shops(2))
    request({ obtainedBefore: CUT })
    const put = kv.put
    let refused = false
    kv.put = async (key, value) => {
      if (key === STATE && !refused) {
        refused = true
        throw new Error('KV PUT failed: 429 Too Many Requests')
      }
      return put(key, value)
    }
    const { namespace } = fakeNamespace()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const running = run(kv, namespace)
      await vi.runAllTimersAsync()
      expect(await running).toMatchObject({ status: 'done' })
    } finally {
      vi.useRealTimers()
    }
    expect(refused).toBe(true)
    expect(json(STATE)).toMatchObject({ attempted: 2, completedAt: T0 })
  })
})
