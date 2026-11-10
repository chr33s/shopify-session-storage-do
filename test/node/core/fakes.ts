// Test doubles for the core's injected dependencies.

import { expect, onTestFinished, vi } from 'vitest'
import { fingerprint } from '../../../src/fingerprint.js'
import { ShopSessions } from '../../../src/core/shop-sessions.js'
import type { ShopSessionsOptions } from '../../../src/core/shop-sessions.js'
import type {
  AlarmControl,
  AlarmErrors,
  AppTokenClient,
  CoreDeps,
  Keyring,
  KVNamespaceLike,
  RecordStore,
  Sealed,
  ShopRecord,
  ShopSessionError,
  TokenCallResult,
  TokenClient,
} from '../../../src/types.js'

export const SHOP = 'example.myshopify.com'
export const CRED_FP = 'cred-fp-1'
export const T0 = Date.UTC(2026, 9, 1, 12)
export const CUTOFF = Date.UTC(2027, 0, 1)
export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR

export type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets pending microtasks and zero-delay timers run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

export class Clock {
  t: number
  constructor(t = T0) {
    this.t = t
  }
  now = (): number => this.t
  advance(ms: number): void {
    this.t += ms
  }
}

/** The alarm and its stored error state. Like storage, it outlives a core: build another on the same deps. */
export class FakeAlarm implements AlarmControl {
  at: number | null = null
  sets: number[] = []
  deletes = 0
  errors: AlarmErrors | undefined
  async get(): Promise<number | null> {
    return this.at
  }
  async set(at: number): Promise<void> {
    this.at = at
    this.sets.push(at)
  }
  async delete(): Promise<void> {
    this.at = null
    this.deletes++
  }
  async readErrors(): Promise<AlarmErrors | undefined> {
    return this.errors === undefined ? undefined : structuredClone(this.errors)
  }
  async writeErrors(errors: AlarmErrors | undefined): Promise<void> {
    this.errors = errors === undefined ? undefined : structuredClone(errors)
  }
}

/** Structured clones on the way in and out, like real storage, so callers can't share objects with it. */
export class FakeStore implements RecordStore {
  record: ShopRecord | undefined
  puts: ShopRecord[] = []
  gets = 0
  deleteAlls = 0
  /** Optional hook awaited at the start of every get (to inject delays). */
  beforeGet: (() => Promise<void>) | undefined
  failPut: Error | undefined
  constructor(private readonly alarm: FakeAlarm) {}
  async get(): Promise<ShopRecord | undefined> {
    this.gets++
    if (this.beforeGet) await this.beforeGet()
    return this.record === undefined ? undefined : structuredClone(this.record)
  }
  async put(record: ShopRecord): Promise<void> {
    if (this.failPut) throw this.failPut
    this.record = structuredClone(record)
    this.puts.push(structuredClone(record))
  }
  async deleteAll(): Promise<void> {
    this.deleteAlls++
    this.record = undefined
    this.alarm.errors = undefined
    this.alarm.at = null
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Reversible "encryption": the ciphertext is the JSON of { aad, plaintext } with
 * every byte inverted, so it never equals the token text. `open` checks kid and
 * AAD like AES-GCM would.
 */
export class FakeKeyring implements Keyring {
  currentKid = 'kid-a'
  get kids(): string[] {
    return [this.currentKid]
  }
  unknownKids = new Set<string>()
  seals: { kid: string; aad: string }[] = []
  opens: { kid: string; aad: string }[] = []
  /** Optional hook awaited inside seal/open (crypto awaits may interleave in the platform). */
  delay: (() => Promise<void>) | undefined
  private counter = 0

  async seal(plaintext: string, aad: string): Promise<Sealed> {
    // As crypto.ts does: sealing anything but a string is a bug, not a value.
    if (typeof plaintext !== 'string' || typeof aad !== 'string') throw new TypeError('seal needs string inputs')
    if (this.delay) await this.delay()
    this.seals.push({ kid: this.currentKid, aad })
    const iv = new Uint8Array(12)
    iv[0] = ++this.counter
    const bytes = encoder.encode(JSON.stringify({ aad, plaintext }))
    return { kid: this.currentKid, iv, ct: bytes.map((b) => 255 - b) }
  }

  async open(sealed: Sealed, aad: string): Promise<string | undefined> {
    if (this.delay) await this.delay()
    this.opens.push({ kid: sealed.kid, aad })
    if (this.unknownKids.has(sealed.kid)) return undefined
    try {
      const parsed = JSON.parse(decoder.decode(sealed.ct.map((b) => 255 - b))) as { aad: string; plaintext: string }
      return parsed.aad === aad ? parsed.plaintext : undefined
    } catch {
      return undefined
    }
  }

  /** Test-side helper: what a sealed value holds, regardless of kid. */
  peek(sealed: Sealed | undefined): { aad: string; plaintext: string } | undefined {
    if (!sealed) return undefined
    return JSON.parse(decoder.decode(sealed.ct.map((b) => 255 - b))) as { aad: string; plaintext: string }
  }
}

type KvEntry = { value: string; metadata?: unknown }

export class FakeKV implements KVNamespaceLike {
  data = new Map<string, KvEntry>()
  ops: { op: 'get' | 'put' | 'delete' | 'list'; key?: string }[] = []
  failNext: { op: 'get' | 'put' | 'delete'; error: Error } | undefined
  /** Optional hook awaited after get has read the value (the response is in flight while other events run). */
  holdGet: (() => Promise<void>) | undefined

  private maybeFail(op: 'get' | 'put' | 'delete'): void {
    if (this.failNext?.op === op) {
      const { error } = this.failNext
      this.failNext = undefined
      throw error
    }
  }

  async get(key: string, _type: 'json'): Promise<unknown> {
    this.ops.push({ op: 'get', key })
    this.maybeFail('get')
    const entry = this.data.get(key)
    if (this.holdGet) await this.holdGet()
    // Like KV: the json reader throws SyntaxError on a non-JSON value.
    return entry === undefined ? null : JSON.parse(entry.value)
  }

  async put(key: string, value: string, options?: { metadata?: unknown }): Promise<void> {
    this.ops.push({ op: 'put', key })
    this.maybeFail('put')
    this.data.set(key, { value, metadata: options?.metadata })
  }

  async delete(key: string): Promise<void> {
    this.ops.push({ op: 'delete', key })
    this.maybeFail('delete')
    this.data.delete(key)
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
    this.ops.push({ op: 'list' })
    const keys = [...this.data.keys()].filter((k) => k.startsWith(options.prefix ?? '')).sort()
    const start = options.cursor ? Number(options.cursor) : 0
    const limit = options.limit ?? 1000
    const page = keys.slice(start, start + limit)
    const end = start + page.length
    const complete = end >= keys.length
    return {
      keys: page.map((name) => ({ name })),
      list_complete: complete,
      ...(complete ? {} : { cursor: String(end) }),
    }
  }

  setJson(key: string, value: unknown): void {
    this.data.set(key, { value: JSON.stringify(value) })
  }
}

type Scripted = TokenCallResult | Deferred<TokenCallResult> | Error

/**
 * Scripted Shopify token endpoint. An unscripted call is recorded in `unexpected` and throws (which the core treats
 * as an ambiguous failure); the harness fails the test if any happened or if scripted results were left over.
 */
export class FakeTokens implements TokenClient {
  calls: { kind: 'refresh' | 'migrate'; shop: string; token: string }[] = []
  unexpected: { kind: 'refresh' | 'migrate'; token: string }[] = []
  private queues = { refresh: [] as Scripted[], migrate: [] as Scripted[] }
  private waiters: { count: number; resolve: () => void }[] = []

  constructor(private readonly clock: Clock) {}

  /** Queue results for refresh calls, consumed in order. */
  onRefresh(...results: Scripted[]): this {
    this.queues.refresh.push(...results)
    return this
  }

  onMigrate(...results: Scripted[]): this {
    this.queues.migrate.push(...results)
    return this
  }

  /** Queue a refresh whose answer the test releases later. */
  deferRefresh(): Deferred<TokenCallResult> {
    const d = deferred<TokenCallResult>()
    this.queues.refresh.push(d)
    return d
  }

  deferMigrate(): Deferred<TokenCallResult> {
    const d = deferred<TokenCallResult>()
    this.queues.migrate.push(d)
    return d
  }

  /** Resolves once `count` calls have been made in total. */
  waitForCalls(count: number): Promise<void> {
    if (this.calls.length >= count) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push({ count, resolve }))
  }

  refresh(shop: string, refreshToken: string): Promise<TokenCallResult> {
    return this.take('refresh', shop, refreshToken)
  }

  migrate(shop: string, legacyToken: string): Promise<TokenCallResult> {
    return this.take('migrate', shop, legacyToken)
  }

  pending(kind: 'refresh' | 'migrate'): number {
    return this.queues[kind].length
  }

  private async take(kind: 'refresh' | 'migrate', shop: string, token: string): Promise<TokenCallResult> {
    this.calls.push({ kind, shop, token })
    for (const waiter of [...this.waiters]) {
      if (this.calls.length >= waiter.count) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
    const next = this.queues[kind].shift()
    if (next === undefined) {
      this.unexpected.push({ kind, token })
      throw new Error(`unexpected ${kind} call`)
    }
    if (next instanceof Error) throw next
    if ('promise' in next) return next.promise
    return next
  }
}

/** Scripted application-only token grant. Unscripted mints are recorded and throw, like FakeTokens. */
export class FakeAppTokens implements AppTokenClient {
  kid = 'sig-kid-1'
  calls: string[] = []
  unexpected = 0
  private queue: Scripted[] = []

  onMint(...results: Scripted[]): this {
    this.queue.push(...results)
    return this
  }

  deferMint(): Deferred<TokenCallResult> {
    const d = deferred<TokenCallResult>()
    this.queue.push(d)
    return d
  }

  pending(): number {
    return this.queue.length
  }

  async mint(shop: string): Promise<TokenCallResult> {
    this.calls.push(shop)
    const next = this.queue.shift()
    if (next === undefined) {
      this.unexpected++
      throw new Error('unexpected mint call')
    }
    if (next instanceof Error) throw next
    if ('promise' in next) return next.promise
    return next
  }
}

// ---------------------------------------------------------------------------
// Result builders

/** A successful application-only token grant (no refresh token). */
export function minted(clock: Clock, access: string, fields: { expiresIn?: number | null; scope?: string } = {}) {
  const result: TokenCallResult = {
    outcome: 'success',
    sentAt: clock.now(),
    accessToken: access,
    missing: [],
    requestId: 'req-mint',
  }
  if (fields.expiresIn !== null) result.expiresIn = fields.expiresIn ?? 3599
  if (fields.scope !== undefined) result.scope = fields.scope
  return result
}

export function success(
  clock: Clock,
  fields: {
    access: string
    refresh?: string | null
    expiresIn?: number | null
    refreshExpiresIn?: number | null
    scope?: string | null
    sentAt?: number
  },
): TokenCallResult {
  const result: TokenCallResult = {
    outcome: 'success',
    sentAt: fields.sentAt ?? clock.now(),
    accessToken: fields.access,
    missing: [],
    requestId: 'req-ok',
  }
  if (fields.refresh !== null) result.refreshToken = fields.refresh ?? `${fields.access}-refresh`
  if (fields.expiresIn !== null) result.expiresIn = fields.expiresIn ?? 3600
  if (fields.refreshExpiresIn !== null) result.refreshTokenExpiresIn = fields.refreshExpiresIn ?? 90 * 86400
  if (fields.scope !== null) result.scope = fields.scope ?? 'read_products'
  return result
}

export function failure(
  clock: Clock,
  outcome: 'terminal' | 'transient' | 'shop_unavailable' | 'configuration',
  fields: { code?: string; status?: number; ambiguous?: boolean; retryAfterMs?: number; sentAt?: number } = {},
): TokenCallResult {
  const defaults = {
    terminal: { code: 'invalid_request', status: 401 },
    transient: { code: 'http_503', status: 503 },
    shop_unavailable: { code: 'http_402', status: 402 },
    configuration: { code: 'invalid_client', status: 400 },
  }[outcome]
  const result: TokenCallResult = {
    outcome,
    sentAt: fields.sentAt ?? clock.now(),
    ambiguous: fields.ambiguous ?? false,
    code: fields.code ?? defaults.code,
    status: fields.status ?? defaults.status,
    requestId: 'req-fail',
  }
  if (fields.retryAfterMs !== undefined) result.retryAfterMs = fields.retryAfterMs
  return result
}

// ---------------------------------------------------------------------------
// Harness

export type HarnessOptions = {
  /** Configure the application-only token fallback. */
  appTokens?: boolean
  legacy?: boolean
  migrateLegacy?: boolean
  callerWaitMs?: number
  credFp?: string
}

export type Seed = {
  token?: string | null
  refresh?: string | null
  expires?: number | null
  refreshExpires?: number | null
  alternates?: string[]
  scope?: string
  source?: ShopRecord['source']
  pairObtainedAt?: number
  chainOriginExpires?: number
  tokenInvalid?: boolean
  needsReauth?: ShopRecord['needsReauth']
  attemptSince?: number
  failures?: ShopRecord['failures']
}

export function createHarness(options: HarnessOptions = {}) {
  const clock = new Clock()
  const alarm = new FakeAlarm()
  const store = new FakeStore(alarm)
  const keyring = new FakeKeyring()
  const tokens = new FakeTokens(clock)
  const appTokens = options.appTokens ? new FakeAppTokens() : undefined
  const registry = new FakeKV()
  const legacyKv = options.legacy ? new FakeKV() : undefined
  const reports: ShopSessionError[] = []
  const waits: Promise<unknown>[] = []
  const flags = { migrateLegacy: options.migrateLegacy ?? false }
  const logs: string[] = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  })

  const deps: CoreDeps = {
    shop: SHOP,
    store,
    alarm,
    tokens,
    appTokens,
    keyring,
    credFp: options.credFp ?? CRED_FP,
    registry: { kv: registry, prefix: 'shop-session:' },
    legacyKv,
    migrateLegacy: () => flags.migrateLegacy,
    legacyCutoff: CUTOFF,
    now: clock.now,
    waitUntil: (promise) => {
      waits.push(promise)
    },
    report: (error) => {
      reports.push(error)
    },
  }
  const coreOptions: ShopSessionsOptions = { callerWaitMs: options.callerWaitMs ?? 200 }
  const core = new ShopSessions(deps, coreOptions)

  // Every token call a test causes must be scripted, and every scripted one made.
  onTestFinished(() => {
    expect(tokens.unexpected, 'unscripted token calls').toEqual([])
    expect(
      { refresh: tokens.pending('refresh'), migrate: tokens.pending('migrate') },
      'unused scripted results',
    ).toEqual({
      refresh: 0,
      migrate: 0,
    })
    expect({ unexpected: appTokens?.unexpected ?? 0, unused: appTokens?.pending() ?? 0 }, 'app token mints').toEqual({
      unexpected: 0,
      unused: 0,
    })
  })

  const aad = (field: string) => `${SHOP}|${field}`

  async function sealed(plaintext: string, field: 'token' | 'refresh' | 'alternate'): Promise<Sealed> {
    const value = await keyring.seal(plaintext, aad(field))
    keyring.seals.pop()
    return value
  }

  /** Writes a record directly, sealing the given plaintexts the way the core would. */
  async function seed(s: Seed = {}): Promise<ShopRecord> {
    const record: ShopRecord = { v: 1, shop: SHOP, pairObtainedAt: s.pairObtainedAt ?? clock.now() }
    const token = s.token === undefined ? 'access-1' : s.token
    const refresh = s.refresh === undefined ? 'refresh-1' : s.refresh
    if (token !== null) {
      record.token = await sealed(token, 'token')
      record.tokenFp = await fingerprint(token)
    }
    if (s.expires !== null) {
      const expires = s.expires ?? clock.now() + HOUR
      if (s.expires !== undefined || refresh !== null) record.expires = expires
    }
    if (refresh !== null) {
      record.refresh = await sealed(refresh, 'refresh')
      record.refreshFp = await fingerprint(refresh)
      if (s.refreshExpires !== null) record.refreshExpires = s.refreshExpires ?? clock.now() + 90 * DAY
    }
    if (s.alternates?.length) {
      record.alternates = []
      for (const alt of s.alternates)
        record.alternates.push({ refresh: await sealed(alt, 'alternate'), fp: await fingerprint(alt) })
    }
    if (s.scope !== undefined) record.scope = s.scope
    record.source = s.source ?? (refresh === null && record.expires === undefined ? 'import' : 'exchange')
    if (s.chainOriginExpires !== undefined) record.chainOriginExpires = s.chainOriginExpires
    else if (record.source === 'exchange' || record.source === 'import') {
      if (record.expires !== undefined) record.chainOriginExpires = record.expires
    }
    if (s.tokenInvalid) record.tokenInvalid = true
    if (s.needsReauth) record.needsReauth = s.needsReauth
    if (s.attemptSince !== undefined) record.attemptSince = s.attemptSince
    if (s.failures) record.failures = s.failures
    store.record = structuredClone(record)
    return record
  }

  /** A legacy record (non-expiring token). */
  function seedLegacy(s: Omit<Seed, 'refresh' | 'expires'> = {}): Promise<ShopRecord> {
    return seed({ token: 'legacy-1', ...s, refresh: null, expires: null, source: s.source ?? 'import' })
  }

  /** Waits for every waitUntil promise registered so far (and any registered while waiting). */
  async function drain(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const pending = waits.splice(0)
      if (pending.length === 0) {
        await settle(2)
        if (waits.length === 0) return
        continue
      }
      await Promise.allSettled(pending)
    }
  }

  /** Plaintext of the current stored token / refresh token / alternates / fallback token. */
  function stored() {
    const r = store.record
    return {
      token: keyring.peek(r?.token)?.plaintext,
      fallback: keyring.peek(r?.fallback?.token)?.plaintext,
      refresh: keyring.peek(r?.refresh)?.plaintext,
      alternates: (r?.alternates ?? []).map((a) => keyring.peek(a.refresh)?.plaintext),
      record: r,
    }
  }

  return {
    clock,
    alarm,
    store,
    keyring,
    tokens,
    appTokens,
    registry,
    legacyKv,
    reports,
    logs,
    waits,
    flags,
    deps,
    core,
    seed,
    seedLegacy,
    sealed,
    drain,
    stored,
    get: (minValidityMs?: number, caller: 'library' | 'app' = 'library') =>
      core.getSession({ shop: SHOP, caller, ...(minValidityMs === undefined ? {} : { minValidityMs }) }),
    marker: () => registry.data.get(`shop-session:${SHOP}`),
  }
}

export type Harness = ReturnType<typeof createHarness>
