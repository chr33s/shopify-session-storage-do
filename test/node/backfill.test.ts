import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_BACKFILL_CURSOR_KEY, migrateLegacySessions } from '../../src/backfill.js'
import type { MigrateLegacySessionsOptions } from '../../src/backfill.js'
import { DEFAULT_LOCATION_HINT } from '../../src/types.js'
import type { ImportLegacyResult } from '../../src/types.js'

const CURSOR_KEY = DEFAULT_BACKFILL_CURSOR_KEY

const shopName = (i: number) => `shop-${String(i).padStart(3, '0')}.myshopify.com`
const keyOf = (shop: string) => `offline_${shop}`
const shops = (n: number) => Array.from({ length: n }, (_, i) => shopName(i))

type ListCall = { prefix?: string; cursor?: string; limit?: number }

/** KV with name-ordered listing and position cursors (stable across deletes, like Cloudflare's). */
function fakeKv(initial: Record<string, string> = {}, options: { pageSize?: number; onList?: () => void } = {}) {
  const store = new Map(Object.entries(initial))
  const lists: ListCall[] = []
  const puts: { key: string; value: string }[] = []
  const deletes: string[] = []
  const kv = {
    async get(key: string, _type: 'json') {
      const value = store.get(key)
      return value === undefined ? null : JSON.parse(value)
    },
    async put(key: string, value: string) {
      puts.push({ key, value })
      store.set(key, value)
    },
    async delete(key: string) {
      deletes.push(key)
      store.delete(key)
    },
    async list(opts: ListCall = {}) {
      lists.push({ ...opts })
      options.onList?.()
      const limit = Math.min(opts.limit ?? 1000, options.pageSize ?? 1000)
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
  return { kv, store, lists, puts, deletes }
}

function legacyKv(shopList: string[], extra: Record<string, string> = {}, options?: Parameters<typeof fakeKv>[1]) {
  return fakeKv({ ...Object.fromEntries(shopList.map((shop) => [keyOf(shop), '[]'])), ...extra }, options)
}

type ImportHandler = (shop: string, attempt: number) => ImportLegacyResult | Promise<ImportLegacyResult>

/** Durable Objects whose importLegacy answers via `handler` (default: import and delete the KV key). */
function fakeNamespace(store: Map<string, string>, handler?: ImportHandler) {
  const imports: string[] = []
  const gets: { name: string; options: unknown }[] = []
  const attempts = new Map<string, number>()
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get(id: never, options?: { locationHint?: string }) {
      const { name } = id as { name: string }
      gets.push({ name, options })
      return {
        async importLegacy(input: { shop: string }) {
          expect(input.shop).toBe(name)
          imports.push(input.shop)
          const attempt = (attempts.get(input.shop) ?? 0) + 1
          attempts.set(input.shop, attempt)
          if (handler) return handler(input.shop, attempt)
          store.delete(keyOf(input.shop))
          return { status: 'imported' }
        },
      }
    },
  }
  return { namespace, imports, gets }
}

function run(
  kv: ReturnType<typeof fakeKv>['kv'],
  namespace: MigrateLegacySessionsOptions['namespace'],
  options: Partial<MigrateLegacySessionsOptions> = {},
) {
  return migrateLegacySessions({ kv, namespace, report: () => {}, ...options })
}

const counts = (partial: Record<string, number>) => ({
  imported: 0,
  already_present: 0,
  none: 0,
  invalid: 0,
  error: 0,
  ...partial,
})

describe('migrateLegacySessions', () => {
  it('imports every listed shop and finishes the pass', async () => {
    const { kv, store, lists } = legacyKv(shops(5))
    const { namespace, imports, gets } = fakeNamespace(store)
    const result = await run(kv, namespace)

    expect(result).toEqual({ attempted: 5, outcomes: counts({ imported: 5 }), done: false })
    expect(imports.sort()).toEqual(shops(5))
    expect(gets.every((get) => (get.options as { locationHint: string }).locationHint === DEFAULT_LOCATION_HINT)).toBe(
      true,
    )
    expect(lists).toEqual([{ prefix: 'offline_', limit: 200 }])
    expect(store.has(CURSOR_KEY)).toBe(false)
  })

  it('is done after a fresh pass sees no offline_ keys', async () => {
    const { kv, store } = legacyKv(shops(3), { 'shop-session:a.myshopify.com': '' })
    const { namespace } = fakeNamespace(store)
    expect((await run(kv, namespace)).done).toBe(false)
    const second = await run(kv, namespace)
    expect(second).toEqual({ attempted: 0, outcomes: counts({}), done: true })
  })

  it('is never done while shops stay listed (migration off keeps legacy keys)', async () => {
    const { kv, store } = legacyKv(shops(3))
    const { namespace } = fakeNamespace(store, () => ({ status: 'already_present' }))
    for (let i = 0; i < 3; i++) {
      const result = await run(kv, namespace)
      expect(result).toEqual({ attempted: 3, outcomes: counts({ already_present: 3 }), done: false })
    }
  })

  it('uses the given location hint', async () => {
    const { kv, store } = legacyKv(shops(1))
    const { namespace, gets } = fakeNamespace(store)
    await run(kv, namespace, { locationHint: 'weur' })
    expect(gets).toEqual([{ name: shopName(0), options: { locationHint: 'weur' } }])
  })

  describe('cursor', () => {
    it('persists the cursor between runs and clears it at the end of the pass', async () => {
      const { kv, store, lists } = legacyKv(shops(5))
      const { namespace, imports } = fakeNamespace(store, () => ({ status: 'already_present' }))

      const first = await run(kv, namespace, { maxShops: 3 })
      expect(first).toMatchObject({ attempted: 3, done: false })
      const saved = JSON.parse(store.get(CURSOR_KEY)!)
      expect(saved).toEqual({ cursor: expect.any(String), startedFresh: true, sawKeys: true })

      const second = await run(kv, namespace, { maxShops: 3 })
      expect(second).toEqual({ attempted: 2, outcomes: counts({ already_present: 2 }), done: false })
      expect(lists[1]).toEqual({ prefix: 'offline_', limit: 3, cursor: saved.cursor })
      expect(store.has(CURSOR_KEY)).toBe(false)
      expect(imports).toEqual(shops(5))

      // A new pass starts from the beginning.
      const third = await run(kv, namespace, { maxShops: 3 })
      expect(third.attempted).toBe(3)
      expect(lists[2]).toEqual({ prefix: 'offline_', limit: 3 })
    })

    it('uses a custom cursor key', async () => {
      const { kv, store } = legacyKv(shops(3))
      const { namespace } = fakeNamespace(store, () => ({ status: 'already_present' }))
      await run(kv, namespace, { maxShops: 2, cursorKey: 'my-cursor' })
      expect(store.has('my-cursor')).toBe(true)
      expect(store.has(CURSOR_KEY)).toBe(false)
    })

    it('is done when a pass spanning runs started fresh and saw no keys', async () => {
      // KV may return empty pages before the listing completes.
      const { kv, store } = fakeKv({}, {})
      const { namespace } = fakeNamespace(store)
      store.set(CURSOR_KEY, JSON.stringify({ cursor: 'b2ZmbGluZV8=', startedFresh: true, sawKeys: false }))
      expect(await run(kv, namespace)).toEqual({ attempted: 0, outcomes: counts({}), done: true })
    })

    it('is not done when a pass spanning runs saw keys in an earlier run', async () => {
      const { kv, store } = fakeKv()
      const { namespace } = fakeNamespace(store)
      store.set(CURSOR_KEY, JSON.stringify({ cursor: 'b2ZmbGluZV8=', startedFresh: true, sawKeys: true }))
      expect((await run(kv, namespace)).done).toBe(false)
      expect(store.has(CURSOR_KEY)).toBe(false)
    })

    it.each([
      ['started mid-keyspace', { cursor: 'b2ZmbGluZV8=', startedFresh: false, sawKeys: false }],
      ['has no flags', { cursor: 'b2ZmbGluZV8=' }],
      ['has malformed flags', { cursor: 'b2ZmbGluZV8=', startedFresh: 'yes', sawKeys: 0 }],
    ])('never reports done for a pass that %s', async (_name, state) => {
      const { kv, store } = fakeKv()
      const { namespace } = fakeNamespace(store)
      store.set(CURSOR_KEY, JSON.stringify(state))
      expect((await run(kv, namespace)).done).toBe(false)
      // The next pass starts fresh and can finish.
      expect((await run(kv, namespace)).done).toBe(true)
    })

    it.each([
      ['garbage JSON', 'not json'],
      ['no cursor', JSON.stringify({ startedFresh: false, sawKeys: true })],
      ['an empty cursor', JSON.stringify({ cursor: '', startedFresh: false, sawKeys: true })],
      ['a non-object', JSON.stringify(42)],
    ])('starts a fresh pass when the stored state has %s', async (_name, value) => {
      const { kv, store, lists } = fakeKv()
      const { namespace } = fakeNamespace(store)
      store.set(CURSOR_KEY, value)
      expect((await run(kv, namespace)).done).toBe(true)
      expect(lists[0]).toEqual({ prefix: 'offline_', limit: 200 })
    })

    it('throws when an incomplete listing has no cursor', async () => {
      const { kv, store } = legacyKv(shops(1))
      const { namespace } = fakeNamespace(store, () => ({ status: 'already_present' }))
      kv.list = async () => ({ keys: [{ name: keyOf(shopName(0)) }], list_complete: false })
      await expect(run(kv, namespace)).rejects.toThrow(/no cursor/)
    })
  })

  describe('limits', () => {
    it('attempts at most maxShops, shrinking the list limit as it goes', async () => {
      const { kv, store, lists } = legacyKv(shops(10), {}, { pageSize: 3 })
      const { namespace, imports } = fakeNamespace(store, () => ({ status: 'already_present' }))
      const result = await run(kv, namespace, { maxShops: 7 })
      expect(result).toMatchObject({ attempted: 7, done: false })
      expect(imports).toEqual(shops(7))
      expect(lists.map((list) => list.limit)).toEqual([7, 4, 1])
      expect(JSON.parse(store.get(CURSOR_KEY)!)).toMatchObject({ startedFresh: true, sawKeys: true })
    })

    it('caps the list limit at 1000', async () => {
      const { kv, store, lists } = legacyKv(shops(2))
      const { namespace } = fakeNamespace(store)
      await run(kv, namespace, { maxShops: 5000 })
      expect(lists[0]!.limit).toBe(1000)
    })

    it('checks the budget between pages, always running the first', async () => {
      let clock = 0
      const { kv, store, lists } = legacyKv(shops(10), {}, { pageSize: 2, onList: () => (clock += 100_000) })
      const { namespace } = fakeNamespace(store, () => ({ status: 'already_present' }))
      const result = await run(kv, namespace, { budgetMs: 250_000, now: () => clock })
      // Pages end at 100 s, 200 s and 300 s; the check after the third stops the run.
      expect(lists).toHaveLength(3)
      expect(result).toMatchObject({ attempted: 6, done: false })
      expect(store.has(CURSOR_KEY)).toBe(true)

      const tight = legacyKv(shops(10), {}, { pageSize: 2 })
      const ns = fakeNamespace(tight.store, () => ({ status: 'already_present' }))
      let t = 0
      const one = await run(tight.kv, ns.namespace, { budgetMs: 0, now: () => t++ })
      expect(tight.lists).toHaveLength(1)
      expect(one.attempted).toBe(2)
    })

    it('bounds concurrent importLegacy calls', async () => {
      let inFlight = 0
      let peak = 0
      const { kv, store } = legacyKv(shops(20))
      const { namespace, imports } = fakeNamespace(store, async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 2))
        inFlight--
        return { status: 'imported' }
      })
      await run(kv, namespace, { concurrency: 3 })
      expect(peak).toBe(3)
      expect(imports).toHaveLength(20)

      peak = 0
      const other = legacyKv(shops(9))
      const ns = fakeNamespace(other.store, async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 2))
        inFlight--
        return { status: 'imported' }
      })
      await run(other.kv, ns.namespace)
      expect(peak).toBe(4)
    })

    it.each([
      ['maxShops', { maxShops: 0 }],
      ['maxShops', { maxShops: 1.5 }],
      ['concurrency', { concurrency: 0 }],
      ['budgetMs', { budgetMs: -1 }],
      ['budgetMs', { budgetMs: Number.NaN }],
    ])('rejects an invalid %s', async (name, options) => {
      const { kv, store, lists } = legacyKv(shops(1))
      const { namespace } = fakeNamespace(store)
      await expect(run(kv, namespace, options)).rejects.toThrow(new RegExp(name))
      expect(lists).toEqual([])
    })
  })

  describe('outcomes', () => {
    it('deletes unroutable and non-canonical keys as invalid without calling an object', async () => {
      const bad = ['offline_evil.com', 'offline_', 'offline_Shop-X.myshopify.com', 'offline_dev.myshopify.io']
      const { kv, store, deletes } = legacyKv(shops(2), Object.fromEntries(bad.map((key) => [key, '[]'])))
      const { namespace, imports } = fakeNamespace(store)
      const result = await run(kv, namespace)
      expect(result.outcomes).toEqual(counts({ imported: 2, invalid: 4 }))
      expect(result.attempted).toBe(6)
      expect(imports.sort()).toEqual(shops(2))
      expect(deletes.sort()).toEqual([...bad, CURSOR_KEY].sort())
    })

    it('routes myshopify.io keys when allowed', async () => {
      const { kv, store, deletes } = fakeKv({ 'offline_dev.myshopify.io': '[]' })
      const { namespace, imports } = fakeNamespace(store, () => ({ status: 'already_present' }))
      const result = await run(kv, namespace, { allowMyshopifyIo: true })
      expect(result.outcomes).toEqual(counts({ already_present: 1 }))
      expect(imports).toEqual(['dev.myshopify.io'])
      expect(deletes).toEqual([CURSOR_KEY])
    })

    it('counts every importLegacy status', async () => {
      const statuses: ImportLegacyResult['status'][] = ['imported', 'already_present', 'none', 'invalid']
      const { kv, store } = legacyKv(shops(4))
      const { namespace } = fakeNamespace(store, (shop) => ({ status: statuses[Number(shop.slice(5, 8))]! }))
      const result = await run(kv, namespace)
      expect(result.outcomes).toEqual(counts({ imported: 1, already_present: 1, none: 1, invalid: 1 }))
    })

    it('counts a throwing object as error, keeps its key and carries on', async () => {
      const { kv, store, deletes } = legacyKv(shops(3))
      const { namespace, imports } = fakeNamespace(store, (shop) => {
        if (shop === shopName(1)) throw new Error('SHOPIFY_API_SECRET is empty')
        store.delete(keyOf(shop))
        return { status: 'imported' }
      })
      const result = await run(kv, namespace)
      expect(result).toEqual({ attempted: 3, outcomes: counts({ imported: 2, error: 1 }), done: false })
      expect(imports.sort()).toEqual(shops(3))
      expect(store.has(keyOf(shopName(1)))).toBe(true)
      expect(deletes).toEqual([CURSOR_KEY])
    })

    it('counts a failed delete of an invalid key as error', async () => {
      const { kv, store } = fakeKv({ 'offline_evil.com': '[]' })
      const { namespace } = fakeNamespace(store)
      const realDelete = kv.delete
      kv.delete = async (key: string) => {
        if (key === 'offline_evil.com') throw new Error('kv down')
        return realDelete(key)
      }
      expect((await run(kv, namespace)).outcomes).toEqual(counts({ error: 1 }))
    })

    it('retries a retryable infrastructure error once with a fresh stub', async () => {
      const { kv, store } = legacyKv(shops(2))
      const { namespace, gets } = fakeNamespace(store, (shop, attempt) => {
        if (shop === shopName(0) && attempt === 1) throw Object.assign(new Error('reset'), { retryable: true })
        if (shop === shopName(1)) throw Object.assign(new Error('busy'), { retryable: true, overloaded: true })
        return { status: 'imported' }
      })
      const result = await run(kv, namespace)
      expect(result.outcomes).toEqual(counts({ imported: 1, error: 1 }))
      expect(gets.filter((get) => get.name === shopName(0))).toHaveLength(2)
      expect(gets.filter((get) => get.name === shopName(1))).toHaveLength(1)
    })
  })

  describe('report', () => {
    it('reports once when at least 80% of ≥ 10 attempts were invalid or error', async () => {
      const bad = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`offline_bad-${i}.example.com`, '[]']))
      const { kv, store } = legacyKv(shops(3), bad)
      const report = vi.fn()
      const { namespace } = fakeNamespace(store, (shop) => {
        if (shop === shopName(0)) throw new Error('down')
        return { status: 'imported' }
      })
      const result = await run(kv, namespace, { report })
      expect(result.outcomes).toEqual(counts({ imported: 2, invalid: 7, error: 1 }))
      expect(report).toHaveBeenCalledTimes(1)
      const error = report.mock.calls[0]![0] as Error
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe('migrateLegacySessions: 8 of 10 shops were not imported (invalid or error)')
    })

    it('counts objects answering invalid toward the signal, but not none or already_present', async () => {
      const answers: ImportLegacyResult['status'][] = ['invalid', 'none', 'already_present']
      for (const [index, status] of answers.entries()) {
        const { kv, store } = legacyKv(shops(10))
        const report = vi.fn()
        // Nine shops answer `status` (deleting their keys, as the object does for invalid and none); one imports.
        const { namespace } = fakeNamespace(store, (shop) => {
          store.delete(keyOf(shop))
          return { status: shop === shopName(9) ? 'imported' : status }
        })
        const result = await run(kv, namespace, { report })
        expect(result.outcomes).toEqual(counts({ imported: 1, [status]: 9 }))
        expect(report).toHaveBeenCalledTimes(index === 0 ? 1 : 0)
      }
    })

    it('stays quiet below 80%', async () => {
      const bad = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`offline_bad-${i}.example.com`, '[]']))
      const { kv, store } = legacyKv(shops(3), bad)
      const report = vi.fn()
      const { namespace } = fakeNamespace(store)
      await run(kv, namespace, { report })
      expect(report).not.toHaveBeenCalled()
    })

    it('stays quiet under 10 attempts', async () => {
      const bad = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`offline_bad-${i}.example.com`, '[]']))
      const { kv, store } = fakeKv(bad)
      const report = vi.fn()
      const { namespace } = fakeNamespace(store)
      const result = await run(kv, namespace, { report })
      expect(result.outcomes.invalid).toBe(9)
      expect(report).not.toHaveBeenCalled()
    })

    it('falls back to console.error without a report function', async () => {
      const bad = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`offline_bad-${i}.example.com`, '[]']))
      const { kv, store } = fakeKv(bad)
      const { namespace } = fakeNamespace(store)
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      await migrateLegacySessions({ kv, namespace })
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(consoleError.mock.calls[0]![0]).toMatch(/10 of 10 shops/)
    })
  })
})
