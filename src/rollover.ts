import { callShop } from './adapter.js'
import { canonicalShop } from './shop.js'
import { DEFAULT_LOCATION_HINT, DEFAULT_REGISTRY_PREFIX } from './types.js'
import type { KVNamespaceLike, RolloverResult, ShopSessionsNamespace } from './types.js'

export type RolloverShopsOptions = {
  /** The registry KV namespace (the Durable Object's `registry`). The request and the pass state are kept here too. */
  kv: KVNamespaceLike
  namespace: ShopSessionsNamespace
  /** Must match the Durable Object's registry prefix. */
  registryPrefix?: string
  /** Must match the adapter's. */
  locationHint?: string
  requestKey?: string
  stateKey?: string
  /** Shops attempted per run (default 500). */
  maxShops?: number
  /** Wall-clock budget per run, checked between list pages (default 4 min, under a 5-minute trigger). */
  budgetMs?: number
  /** Concurrent rollovers (default 8). A request's `concurrency` overrides it. */
  concurrency?: number
  /** Must match the Durable Object's setting. */
  allowMyshopifyIo?: boolean
  now?: () => number
  /** Receives a non-secret error when a request is invalid or the sweep halts a pass. */
  report?: (error: Error) => void
}

/** What an operator writes under `requestKey` (JSON) to start, stage or resume a pass. */
export type RolloverRequest = {
  /** ISO 8601 time or ms epoch, not in the future: credentials obtained before it are replaced. */
  obtainedBefore: string | number
  /** Pause the pass once it has attempted this many shops (staged rollouts). */
  stopAfter?: number
  /** Concurrent rollovers, 1 to 50. */
  concurrency?: number
  /** Written by the sweep when it halts the pass. Write the request again without it to resume. */
  halted?: string
}

/** A shop the pass did not roll, and why. No secrets. */
export type UnrolledShop = { shop: string; status: string; code?: string }

export type RolloverPass = {
  obtainedBefore: number
  startedAt: number
  /** Shops attempted, counting a shop again when a stopped run's page is redone. */
  attempted: number
  outcomes: Record<string, number>
  /** The latest answer of each shop that didn't roll (at most 1000). */
  unrolled: UnrolledShop[]
  completedAt?: number
  /** Between runs: where the listing resumes. */
  cursor?: string
}

export type RolloverShopsResult = {
  /**
   * `idle`: no request. `running`: this run's share is done, more to come. `paused`: `stopAfter` reached.
   * `throttled`: Shopify answered 429, the next run resumes. `halted`: a configuration failure or too many failures
   * stopped the pass. `done`: every listed shop was attempted and the request was deleted.
   */
  status: 'idle' | 'invalid_request' | 'running' | 'paused' | 'throttled' | 'halted' | 'done'
  /** This run. */
  attempted: number
  outcomes: Record<string, number>
  /** The pass so far, when there is one. */
  pass?: Omit<RolloverPass, 'cursor'>
}

export const DEFAULT_ROLLOVER_REQUEST_KEY = 'shop-sessions:rollover'
export const DEFAULT_ROLLOVER_STATE_KEY = 'shop-sessions:rollover-state'

const NAME = 'rolloverShops'
const PAGE_SIZE = 100
const MAX_CONCURRENCY = 50
const MAX_UNROLLED = 1000
/** Clock skew allowed between the operator's clock and the Worker's. */
const FUTURE_SLACK = 60_000
/** KV accepts about one write per second to a key. */
const STATE_WRITE_INTERVAL = 2_000
const KV_SAME_KEY_GAP = 1_100
const BREAKER_MIN_ATTEMPTS = 10
const BREAKER_RATIO = 0.5

type Stop = 'throttled' | 'halted'

/**
 * Rolls over every shop in the registry whose credentials were obtained before the request's `obtainedBefore`, a
 * bounded slice per run (meant for a cron trigger). The pass state survives between runs, so a pass resumes where the
 * last run stopped; shops already rolled answer `current`, which makes redoing a page harmless.
 */
export async function rolloverShops(options: RolloverShopsOptions): Promise<RolloverShopsResult> {
  const { kv, namespace } = options
  if (!kv || !namespace) throw new TypeError(`${NAME}: options.kv and options.namespace are required`)
  const prefix = options.registryPrefix ?? DEFAULT_REGISTRY_PREFIX
  const locationHint = options.locationHint ?? DEFAULT_LOCATION_HINT
  const requestKey = options.requestKey ?? DEFAULT_ROLLOVER_REQUEST_KEY
  const stateKey = options.stateKey ?? DEFAULT_ROLLOVER_STATE_KEY
  const maxShops = positiveInteger(options.maxShops, 500, 'maxShops')
  const budgetMs = options.budgetMs ?? 240_000
  if (typeof budgetMs !== 'number' || !(budgetMs >= 0)) {
    throw new TypeError(`${NAME}: budgetMs must be a non-negative number`)
  }
  const now = options.now ?? Date.now
  const shopOptions = { allowMyshopifyIo: options.allowMyshopifyIo === true }
  const report = (message: string) => {
    const error = new Error(`${NAME}: ${message}`)
    if (options.report) options.report(error)
    else console.error(error.message)
  }

  const start = now()
  const outcomes: Record<string, number> = {}
  const idle = (status: RolloverShopsResult['status'], pass?: RolloverPass): RolloverShopsResult => ({
    status,
    attempted: 0,
    outcomes,
    ...(pass && { pass: summary(pass) }),
  })

  let raw: unknown
  try {
    raw = await kv.get(requestKey, 'json')
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    raw = undefined
  }
  if (raw === null) return idle('idle')
  const request = parseRequest(raw, start)
  if (typeof request === 'string') {
    report(`invalid request under ${requestKey}: ${request}`)
    return idle('invalid_request')
  }
  const concurrency = request.concurrency ?? positiveInteger(options.concurrency, 8, 'concurrency')

  const stored = await loadPass(kv, stateKey)
  // A finished pass, or one for another time, is history: this request starts a new one.
  const sameRun = stored?.obtainedBefore === request.obtainedBefore && stored.completedAt === undefined
  let pass: RolloverPass = sameRun
    ? stored
    : { obtainedBefore: request.obtainedBefore, startedAt: start, attempted: 0, outcomes: {}, unrolled: [] }
  if (request.halted !== undefined) return idle('halted', pass)
  if (request.stopAfter !== undefined && pass.attempted >= request.stopAfter) return idle('paused', pass)

  let lastSave = -Infinity
  /** Between pages at most every STATE_WRITE_INTERVAL; `final` must land, so it retries once. */
  const savePass = async (final: boolean) => {
    if (!final && now() - lastSave < STATE_WRITE_INTERVAL) return
    const value = JSON.stringify(pass)
    try {
      await kv.put(stateKey, value)
    } catch (error) {
      // A missed save between pages only means redoing a page; KV refuses a second write to a key within a second.
      if (!final) return
      await new Promise((resolve) => setTimeout(resolve, KV_SAME_KEY_GAP))
      await kv.put(stateKey, value).catch(() => {
        throw error
      })
    }
    lastSave = now()
  }

  let attempted = 0
  let failures = 0
  let stop: Stop | undefined
  let haltReason: string | undefined
  const halt = (reason: string) => {
    if (stop === 'halted') return
    stop = 'halted'
    haltReason = reason
  }

  const tally = (shop: string, status: string, code?: string) => {
    attempted++
    outcomes[status] = (outcomes[status] ?? 0) + 1
    pass.attempted++
    pass.outcomes[status] = (pass.outcomes[status] ?? 0) + 1
    const unrolled = pass.unrolled.filter((entry) => entry.shop !== shop)
    if (status !== 'rolled' && status !== 'current') {
      unrolled.push(code === undefined ? { shop, status } : { shop, status, code })
      if (unrolled.length > MAX_UNROLLED) unrolled.shift()
    }
    pass.unrolled = unrolled
  }

  let configurationFailures = 0
  let lastConfiguration = ''

  // Counted apart from `failures`, so closed shops and uninstalled ones don't add up to a halt.
  const checkBreaker = () => {
    if (attempted < BREAKER_MIN_ATTEMPTS) return
    if (configurationFailures >= BREAKER_RATIO * attempted) {
      halt(
        `${configurationFailures} of ${attempted} shops failed with a configuration error in this run (${lastConfiguration})`,
      )
    } else if (failures >= BREAKER_RATIO * attempted) {
      halt(`${failures} of ${attempted} shops failed or were rejected in this run`)
    }
  }

  const rollShop = async (name: string): Promise<void> => {
    const shop = name.slice(prefix.length)
    if (canonicalShop(shop, shopOptions) !== shop) {
      tally(shop, 'invalid')
      return
    }
    let result: RolloverResult
    try {
      result = await callShop(namespace, shop, locationHint, (stub) =>
        stub.rollover({ shop, obtainedBefore: pass.obtainedBefore }),
      )
    } catch (error) {
      tally(shop, 'error', error instanceof Error ? error.name : typeof error)
      failures++
      checkBreaker()
      return
    }
    tally(shop, result.status, codeOf(result))
    if (result.status === 'failed') {
      // A wrong client id or secret fails every shop, while Shopify answers a single closed shop's call with a 403:
      // only a run where most shops fail this way says the credentials are wrong.
      if (result.kind === 'configuration') {
        configurationFailures++
        lastConfiguration = `last: ${result.code} for ${shop}`
      } else if (result.code === 'http_429') stop ??= 'throttled'
      // A frozen or closed shop is an ordinary answer, not a sign that the sweep is doing harm.
      if (result.kind === 'transient') failures++
    } else if (result.status === 'rejected') {
      failures++
    }
    checkBreaker()
  }

  let status: RolloverShopsResult['status'] = 'running'
  let pages = 0
  for (;;) {
    const room = Math.min(
      PAGE_SIZE,
      maxShops - attempted,
      request.stopAfter === undefined ? Infinity : request.stopAfter - pass.attempted,
    )
    if (room <= 0) {
      if (attempted < maxShops) status = 'paused'
      break
    }
    if (pages > 0 && now() - start >= budgetMs) break
    const page = await kv.list({ prefix, limit: room, ...(pass.cursor !== undefined && { cursor: pass.cursor }) })
    pages++
    const names = page.keys.map((key) => key.name)
    const finished = await forEachUntil(names, concurrency, rollShop, () => stop !== undefined)

    // A page left unfinished is redone from its start next run.
    if (!finished) break
    if (page.list_complete) {
      status = 'done'
      break
    }
    if (!page.cursor) throw new Error(`${NAME}: KV list returned no cursor for an incomplete listing`)
    pass.cursor = page.cursor
    await savePass(false)
  }

  if (stop) status = stop
  if (status === 'done') {
    const { cursor: _cursor, ...rest } = pass
    pass = { ...rest, completedAt: now() }
  }
  await savePass(true)

  if (status === 'done') {
    await kv.delete(requestKey)
  } else if (status === 'halted') {
    report(`halted the pass for ${new Date(pass.obtainedBefore).toISOString()}: ${haltReason}`)
    // The request is the operator's switch: marking it halted keeps later runs from carrying on.
    await kv.put(requestKey, JSON.stringify({ ...(raw as object), halted: haltReason }))
  }
  return { status, attempted, outcomes, pass: summary(pass) }
}

function codeOf(result: RolloverResult): string | undefined {
  switch (result.status) {
    case 'failed':
      return result.code
    case 'rejected':
    case 'needs_reauth':
    case 'skipped':
      return result.reason
    default:
      return undefined
  }
}

function summary(pass: RolloverPass): Omit<RolloverPass, 'cursor'> {
  const { cursor: _cursor, ...rest } = pass
  return rest
}

type ParsedRequest = { obtainedBefore: number; stopAfter?: number; concurrency?: number; halted?: string }

/** The request, or why it is invalid. */
function parseRequest(raw: unknown, now: number): ParsedRequest | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'not a JSON object'
  const { obtainedBefore, stopAfter, concurrency, halted } = raw as Record<string, unknown>
  const at =
    typeof obtainedBefore === 'number'
      ? obtainedBefore
      : typeof obtainedBefore === 'string'
        ? Date.parse(obtainedBefore)
        : NaN
  if (!Number.isFinite(at) || at <= 0) return 'obtainedBefore must be an ISO time or a ms epoch'
  if (at > now + FUTURE_SLACK) return 'obtainedBefore is in the future'
  const parsed: ParsedRequest = { obtainedBefore: at }
  if (stopAfter !== undefined) {
    if (!Number.isInteger(stopAfter) || (stopAfter as number) < 0) return 'stopAfter must be a non-negative integer'
    parsed.stopAfter = stopAfter as number
  }
  if (concurrency !== undefined) {
    if (!Number.isInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > MAX_CONCURRENCY) {
      return `concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`
    }
    parsed.concurrency = concurrency as number
  }
  if (halted !== undefined) parsed.halted = String(halted)
  return parsed
}

async function loadPass(kv: KVNamespaceLike, key: string): Promise<RolloverPass | undefined> {
  let stored: unknown
  try {
    stored = await kv.get(key, 'json')
  } catch {
    // Unreadable state: a new pass only repeats rollovers, which answer `current` for shops already done.
    return undefined
  }
  if (typeof stored !== 'object' || stored === null) return undefined
  const s = stored as Partial<RolloverPass>
  if (typeof s.obtainedBefore !== 'number' || typeof s.startedAt !== 'number' || typeof s.attempted !== 'number') {
    return undefined
  }
  return {
    obtainedBefore: s.obtainedBefore,
    startedAt: s.startedAt,
    attempted: s.attempted,
    outcomes: typeof s.outcomes === 'object' && s.outcomes !== null ? s.outcomes : {},
    unrolled: Array.isArray(s.unrolled) ? s.unrolled : [],
    ...(typeof s.completedAt === 'number' && { completedAt: s.completedAt }),
    ...(typeof s.cursor === 'string' && s.cursor !== '' && { cursor: s.cursor }),
  }
}

/** Runs `run` over `items` with `limit` in flight; stops starting new ones once `stopped()`. True if all ran. */
async function forEachUntil<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
  stopped: () => boolean,
): Promise<boolean> {
  let next = 0
  const worker = async () => {
    while (next < items.length && !stopped()) {
      const item = items[next++] as T
      await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return next >= items.length && !stopped()
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${NAME}: ${name} must be a positive integer`)
  return value
}
