import { callShop } from './adapter.js'
import { offlineId, shopFromOfflineId } from './shop.js'
import { DEFAULT_LOCATION_HINT, LEGACY_OFFLINE_PREFIX } from './types.js'
import type { KVNamespaceLike, ShopSessionsNamespace } from './types.js'

export type MigrateLegacySessionsOptions = {
  /** The KV namespace holding the legacy `offline_<shop>` sessions. The cursor is kept here too. */
  kv: KVNamespaceLike
  namespace: ShopSessionsNamespace
  /** Must match the adapter's. */
  locationHint?: string
  cursorKey?: string
  /** Shops attempted per run (default 200). */
  maxShops?: number
  /** Wall-clock budget per run, checked between list pages (default 5 min). */
  budgetMs?: number
  /** Concurrent importLegacy calls (default 4). */
  concurrency?: number
  /** Must match the Durable Object's setting, or its `*.myshopify.io` keys are deleted as unroutable. */
  allowMyshopifyIo?: boolean
  now?: () => number
  /** Receives a non-secret error when most of a run's shops could not be imported (invalid or error). */
  report?: (error: Error) => void
}

export type MigrateLegacySessionsResult = {
  attempted: number
  /** importLegacy statuses, plus `invalid` for unroutable keys and `error` for calls that threw. */
  outcomes: Record<string, number>
  /** A pass that began at the start of the keyspace found no `offline_` keys left. */
  done: boolean
}

export const DEFAULT_BACKFILL_CURSOR_KEY = 'shop-sessions:backfill-cursor'

const KV_LIST_LIMIT = 1000
const REPORT_MIN_ATTEMPTS = 10
const REPORT_RATIO = 0.8

/** Persisted between runs while a pass is unfinished. */
type PassState = { cursor?: string; startedFresh: boolean; sawKeys: boolean }

/**
 * Imports legacy KV sessions into their shops' Durable Objects, a bounded slice per run (meant for a cron
 * trigger). Each import deletes the shop's KV keys unless the shop is still on a live legacy token, so the
 * remaining `offline_` keys are the work left.
 */
export async function migrateLegacySessions(
  options: MigrateLegacySessionsOptions,
): Promise<MigrateLegacySessionsResult> {
  const { kv, namespace } = options
  if (!kv || !namespace) throw new TypeError('migrateLegacySessions: options.kv and options.namespace are required')
  const locationHint = options.locationHint ?? DEFAULT_LOCATION_HINT
  const cursorKey = options.cursorKey ?? DEFAULT_BACKFILL_CURSOR_KEY
  const maxShops = positiveInteger(options.maxShops, 200, 'maxShops')
  const concurrency = positiveInteger(options.concurrency, 4, 'concurrency')
  const budgetMs = options.budgetMs ?? 300_000
  if (typeof budgetMs !== 'number' || !(budgetMs >= 0)) {
    throw new TypeError('migrateLegacySessions: budgetMs must be a non-negative number')
  }
  const now = options.now ?? Date.now
  const shopOptions = { allowMyshopifyIo: options.allowMyshopifyIo === true }

  const start = now()
  const outcomes: Record<string, number> = { imported: 0, already_present: 0, none: 0, invalid: 0, error: 0 }
  const count = (outcome: string) => {
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  }

  const migrateKey = async (name: string): Promise<void> => {
    try {
      const shop = shopFromOfflineId(name, shopOptions)
      // Objects read `offline_<canonical shop>` only, so nothing could ever import a non-canonical key either.
      if (!shop || offlineId(shop) !== name) {
        await kv.delete(name)
        count('invalid')
        return
      }
      const { status } = await callShop(namespace, shop, locationHint, (stub) => stub.importLegacy({ shop }))
      count(status)
    } catch {
      count('error')
    }
  }

  let state = await loadPassState(kv, cursorKey)
  let attempted = 0
  let pages = 0
  let done = false
  while (attempted < maxShops) {
    if (pages > 0 && now() - start >= budgetMs) break
    const page = await kv.list({
      prefix: LEGACY_OFFLINE_PREFIX,
      limit: Math.min(KV_LIST_LIMIT, maxShops - attempted),
      ...(state.cursor !== undefined && { cursor: state.cursor }),
    })
    pages++
    const names = page.keys.map((key) => key.name)
    if (names.length > 0) state = { ...state, sawKeys: true }
    await forEachLimited(names, concurrency, migrateKey)
    attempted += names.length

    if (page.list_complete) {
      // Shops still on a legacy token stay listed, so with migration off this waits for migration.
      done = state.startedFresh && !state.sawKeys
      await kv.delete(cursorKey)
      break
    }
    if (!page.cursor) throw new Error('migrateLegacySessions: KV list returned no cursor for an incomplete listing')
    state = { ...state, cursor: page.cursor }
    await kv.put(cursorKey, JSON.stringify(state))
  }

  // The statuses that mean a shop's session could not be imported; `none` (nothing usable) is an ordinary answer.
  const failed = (outcomes['invalid'] ?? 0) + (outcomes['error'] ?? 0)
  if (attempted >= REPORT_MIN_ATTEMPTS && failed >= REPORT_RATIO * attempted) {
    const error = new Error(
      `migrateLegacySessions: ${failed} of ${attempted} shops were not imported (invalid or error)`,
    )
    if (options.report) options.report(error)
    else console.error(error.message)
  }

  return { attempted, outcomes, done }
}

async function loadPassState(kv: KVNamespaceLike, key: string): Promise<PassState> {
  let stored: unknown
  try {
    stored = await kv.get(key, 'json')
  } catch {
    // Unreadable cursor: starting a fresh pass only repeats idempotent imports.
    stored = undefined
  }
  if (typeof stored === 'object' && stored !== null) {
    const { cursor, startedFresh, sawKeys } = stored as Record<string, unknown>
    if (typeof cursor === 'string' && cursor !== '') {
      // Unless the state proves this pass began at the start and saw nothing, it can't vouch for an empty keyspace.
      return { cursor, startedFresh: startedFresh === true, sawKeys: sawKeys !== false }
    }
  }
  return { startedFresh: true, sawKeys: false }
}

async function forEachLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T
      await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1)
    throw new TypeError(`migrateLegacySessions: ${name} must be a positive integer`)
  return value
}
