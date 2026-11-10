// The Durable Object shell (DESIGN.md §4.2). It binds the core to ctx.storage and the Worker's env, and only
// ever serves the shop it is named after. This is the one module that imports `cloudflare:workers`.

import { DurableObject } from 'cloudflare:workers'

import { AppTokenKeyError, createAssertionSigner } from './app-token.js'
import { HOUR, alarmErrorDelay } from './core/record.js'
import { ShopSessions } from './core/shop-sessions.js'
import { KeyringError, createKeyring } from './crypto.js'
import { credentialFingerprint } from './fingerprint.js'
import { canonicalShop } from './shop.js'
import { createAppTokenClient, createTokenClient } from './token-client.js'
import { DEFAULT_REGISTRY_PREFIX, ShopSessionError } from './types.js'
import type {
  AlarmControl,
  AlarmErrors,
  AppTokenKey,
  AppTokenMode,
  CoreDeps,
  DescribeInput,
  DestroyInput,
  DestroyResult,
  GetSessionInput,
  GetSessionResult,
  ImportLegacyInput,
  ImportLegacyResult,
  InvalidateAndRefreshInput,
  InvalidateAndRefreshResult,
  KVNamespaceLike,
  PutSessionInput,
  PutSessionResult,
  RecordStore,
  ReportContext,
  ReportUnauthorizedInput,
  ReportUnauthorizedResult,
  RolloverInput,
  RolloverResult,
  ShopRecord,
  ShopSessionStatus,
  ShopSessionsRpc,
  TokenCallResult,
  TokenClient,
} from './types.js'

export { ShopSessionError } from './types.js'
export type { AppTokenKey, AppTokenMode, ReportContext, ShopSessionsRpc } from './types.js'

export type ShopSessionsDurableObjectOptions<Env> = {
  /** The KV namespace for installed-shop markers. Prefix defaults to `shop-session:`. */
  registry: (env: Env) => { kv: KVNamespaceLike; prefix?: string }
  /** Defaults to `env.SHOPIFY_API_KEY`. */
  apiKey?: (env: Env) => string | undefined
  /**
   * Defaults to `env.SHOPIFY_API_SECRET`. Required for refresh-token mode and for the app-token fallback.
   * Optional when `appTokenMode` is `primary` (signing key alone mints offline tokens).
   */
  apiSecretKey?: (env: Env) => string | undefined
  /** Comma-separated base64 AES-256 keys, current first. Defaults to `env.SHOPIFY_SESSION_ENCRYPTION_KEYS`. */
  encryptionKeys?: (env: Env) => string | undefined
  /** The legacy KVSessionStorage namespace while importing is on (gate it per environment). Read on every use. */
  legacyKv?: (env: Env) => KVNamespaceLike | undefined
  /** Whether the alarm upgrades legacy tokens to expiring ones. Read every time it is needed; default false. */
  migrateLegacy?: (env: Env) => boolean
  /**
   * The private key for application-only tokens, whose public JWK is registered on the app. When set with
   * `appTokenMode: 'fallback'` (default), `loadOfflineSession` answers with an app token while the shop's
   * refresh-token chain can't produce one. With `appTokenMode: 'primary'`, every offline `loadSession` is served
   * from an ephemeral app-token cache minted via `client_credentials`. Read when the instance starts.
   */
  appTokenKey?: (env: Env) => AppTokenKey | undefined
  /**
   * How `appTokenKey` is used. Defaults to `fallback`. `primary` requires `appTokenKey` and makes the client secret
   * optional (DESIGN.md §6.11).
   */
  appTokenMode?: AppTokenMode | ((env: Env) => AppTokenMode | undefined)
  /**
   * When true in primary mode, a cached token whose `signingKid` differs from the configured key is treated as a miss
   * so rolling the JWK forces an immediate remint.
   */
  strictSigningKid?: boolean | ((env: Env) => boolean)
  /** When legacy tokens stop being served (ms epoch). Defaults to 2027-01-01T00:00:00Z. */
  legacyCutoff?: number
  /** Accept `*.myshopify.io` shops. Must match the adapter's setting. */
  allowMyshopifyIo?: boolean
  /** Receives every report; none carries a secret. Every report is also logged with `console.error`. */
  report?: (error: ShopSessionError, context: ReportContext) => void
  /** Tests: the fetch token calls go through. */
  fetch?: typeof fetch
  /** Tests: the clock, in ms. */
  now?: () => number
}

/** The RPC surface of a ShopSessions Durable Object. */
export interface ShopSessionsDurableObject<Env = unknown> extends DurableObject<Env>, ShopSessionsRpc {
  alarm(): Promise<void>
}

export type ShopSessionsDurableObjectClass<Env = unknown> = new (
  ctx: DurableObjectState,
  env: Env,
) => ShopSessionsDurableObject<Env>

const RECORD_KEY = 'record'
/** The alarm handler's error state (AlarmErrors), shared by the shell's and the core's catch-alls. */
const ALARM_ERROR_KEY = 'alarm-error'
const DEFAULT_LEGACY_CUTOFF = Date.UTC(2027, 0, 1)
/** When this isolate last reported a broken app token key (see reportAppTokenKey). */
let appTokenKeyReportedAt = -Infinity

/**
 * The Durable Object class to export from the Worker (and bind as the `ShopSessions` namespace). Wrap it with
 * `Sentry.instrumentDurableObjectWithSentry` if you like; it is an ordinary `DurableObject` subclass.
 */
export function createShopSessionsDurableObject<Env>(
  options: ShopSessionsDurableObjectOptions<Env>,
): ShopSessionsDurableObjectClass<Env> {
  if (typeof options?.registry !== 'function') {
    throw new TypeError('createShopSessionsDurableObject: options.registry(env) is required')
  }

  class ShopSessionsObject extends DurableObject<Env> implements ShopSessionsRpc {
    // A plain property rather than private methods: prototype methods are callable over RPC.
    private readonly shell: Shell<Env>

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env)
      this.shell = new Shell(ctx, env, options)
    }

    async getSession(input: GetSessionInput): Promise<GetSessionResult> {
      return (await this.shell.rpcCore(input)).getSession(input)
    }

    async putSession(input: PutSessionInput): Promise<PutSessionResult> {
      return (await this.shell.rpcCore(input)).putSession(input)
    }

    async reportUnauthorized(input: ReportUnauthorizedInput): Promise<ReportUnauthorizedResult> {
      return (await this.shell.rpcCore(input)).reportUnauthorized(input)
    }

    async invalidateAndRefresh(input: InvalidateAndRefreshInput): Promise<InvalidateAndRefreshResult> {
      return (await this.shell.rpcCore(input)).invalidateAndRefresh(input)
    }

    async destroy(input: DestroyInput): Promise<DestroyResult> {
      return (await this.shell.rpcCore(input)).destroy(input)
    }

    async importLegacy(input: ImportLegacyInput): Promise<ImportLegacyResult> {
      return (await this.shell.rpcCore(input)).importLegacy(input)
    }

    async rollover(input: RolloverInput): Promise<RolloverResult> {
      return (await this.shell.rpcCore(input)).rollover(input)
    }

    async describe(input: DescribeInput): Promise<ShopSessionStatus> {
      return (await this.shell.rpcCore(input)).describe(input)
    }

    async alarm(): Promise<void> {
      await this.shell.alarm()
    }
  }

  return ShopSessionsObject
}

/** Per-instance state behind the RPC methods. One core per instance: it holds `version` and the single flights. */
class Shell<Env> {
  private pending: { shop: string; core: Promise<ShopSessions> } | undefined
  /** When this instance last reported each configuration error code. */
  private readonly reportedAt = new Map<string, number>()

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly options: ShopSessionsDurableObjectOptions<Env>,
  ) {}

  /** The core for an RPC call. A configuration error throws on every call and is reported once per instance. */
  async rpcCore(input: { shop: string }): Promise<ShopSessions> {
    try {
      return await this.coreFor(input)
    } catch (error) {
      if (isConfigurationError(error) && !this.reportedAt.has(error.context.code)) {
        this.reportedAt.set(error.context.code, this.now())
        this.emit(error)
      }
      throw error
    }
  }

  /** The core, once `input.shop` is known to name this object. Configuration problems throw on every call. */
  coreFor(input: { shop: string }): Promise<ShopSessions> {
    const shop: unknown = typeof input === 'object' && input !== null ? input.shop : undefined
    if (typeof shop !== 'string' || canonicalShop(shop, this.shopOptions()) !== shop) {
      return Promise.reject(new TypeError('ShopSessions: input.shop must be a canonical shop domain'))
    }
    // `ctx.id.name` is the name the stub was made from, where the runtime exposes it.
    const name = this.ctx.id.name
    if ((name !== undefined && name !== shop) || (this.pending !== undefined && this.pending.shop !== shop)) {
      return Promise.reject(new TypeError('ShopSessions: input.shop does not match this object'))
    }
    if (!this.pending) {
      const pending = { shop, core: this.build(shop) }
      this.pending = pending
      // A failed build isn't kept: the next call retries it, and throws again until the config is fixed.
      pending.core.catch(() => {
        if (this.pending === pending) this.pending = undefined
      })
    }
    return this.pending.core
  }

  /** Never throws because of configuration: it re-arms with the error backoff and reports at most hourly instead. */
  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<ShopRecord>(RECORD_KEY)
    if (!record) return
    let core: ShopSessions
    try {
      core = await this.coreFor({ shop: record.shop })
    } catch (error) {
      await this.alarmCouldNotStart(record.shop, error)
      return
    }
    await core.alarm()
  }

  private async alarmCouldNotStart(shop: string, error: unknown): Promise<void> {
    const storage = this.ctx.storage
    const now = this.now()
    const report =
      error instanceof ShopSessionError
        ? error
        : new ShopSessionError('Alarm could not start', {
            shop,
            op: 'alarm',
            kind: 'configuration',
            code: errorName(error),
          })
    const code = report.context.code
    // In storage, not memory: the object is usually evicted between alarms. An RPC on this instance may have just
    // reported the same error, which counts too.
    const previous = await storage.get<AlarmErrors>(ALARM_ERROR_KEY)
    const lastReport = Math.max(previous?.reportedAt ?? -Infinity, this.reportedAt.get(code) ?? -Infinity)
    const errors: AlarmErrors = { count: (previous?.count ?? 0) + 1 }
    if (now - lastReport >= HOUR) {
      errors.reportedAt = now
      this.reportedAt.set(code, now)
      this.emit(report)
    } else {
      errors.reportedAt = lastReport
      log(report)
    }
    // The build awaited crypto: nothing to re-arm if a destroy got in meanwhile.
    if ((await storage.get(RECORD_KEY)) === undefined) return
    await storage.put(ALARM_ERROR_KEY, errors)
    await storage.setAlarm(now + alarmErrorDelay(errors.count))
  }

  private async build(shop: string): Promise<ShopSessions> {
    const { ctx, env, options } = this
    const apiKey = options.apiKey ? options.apiKey(env) : envString(env, 'SHOPIFY_API_KEY')
    const apiSecretKey = options.apiSecretKey ? options.apiSecretKey(env) : envString(env, 'SHOPIFY_API_SECRET')
    const keys = options.encryptionKeys
      ? options.encryptionKeys(env)
      : envString(env, 'SHOPIFY_SESSION_ENCRYPTION_KEYS')
    const appTokenMode = resolveAppTokenMode(options.appTokenMode, env)
    if (!present(apiKey)) this.fail(shop, 'missing_api_key', 'The app API key (SHOPIFY_API_KEY) is missing or empty')
    if (appTokenMode !== 'primary' && !present(apiSecretKey)) {
      this.fail(shop, 'missing_api_secret', 'The app API secret (SHOPIFY_API_SECRET) is missing or empty')
    }
    const registry = options.registry(env)
    if (!registry?.kv) this.fail(shop, 'missing_registry', 'options.registry(env) returned no KV namespace')

    let keyring: CoreDeps['keyring']
    try {
      keyring = await createKeyring(keys as string)
    } catch (error) {
      // Keyring messages name the bad entry by position and never contain key material.
      if (error instanceof KeyringError) this.fail(shop, 'keyring', error.message)
      throw error
    }
    const now = this.now.bind(this)
    const http = { apiKey, fetch: options.fetch, now, allowMyshopifyIo: options.allowMyshopifyIo === true }
    const tokens: TokenClient = present(apiSecretKey)
      ? createTokenClient({ ...http, apiSecretKey })
      : unavailableTokenClient()
    const credFp = present(apiSecretKey)
      ? await credentialFingerprint(apiKey, apiSecretKey)
      : await credentialFingerprint(apiKey, `app-token:${appTokenMode}`)
    let appTokens: CoreDeps['appTokens']
    try {
      const appTokenKey = options.appTokenKey?.(env)
      if (appTokenKey !== undefined) {
        appTokens = createAppTokenClient({ ...http, signer: await createAssertionSigner(apiKey, appTokenKey) })
      }
    } catch (error) {
      // Fallback mode: a broken key turns the fallback off but must not take the chain down. Primary mode fails hard.
      const reason = error instanceof AppTokenKeyError ? error.message : `appTokenKey(env) threw ${errorName(error)}`
      if (appTokenMode === 'primary') this.fail(shop, 'app_token_key', reason)
      this.reportAppTokenKey(shop, reason)
    }
    if (appTokenMode === 'primary' && !appTokens) {
      this.fail(
        shop,
        'missing_app_token_key',
        'appTokenMode is primary but appTokenKey is missing or could not be loaded',
      )
    }

    // The object is named after its shop; a record for another shop means it was addressed wrongly once already.
    const existing = await ctx.storage.get<ShopRecord>(RECORD_KEY)
    if (existing && existing.shop !== shop) {
      this.fail(shop, 'shop_mismatch', 'The stored record belongs to another shop')
    }

    const storage = ctx.storage
    const store: RecordStore = {
      get: () => storage.get<ShopRecord>(RECORD_KEY),
      put: (record) => storage.put(RECORD_KEY, record),
      async deleteAll() {
        await storage.deleteAll()
        // Before compatibility date 2026-02-24 deleteAll() leaves the alarm in place.
        await storage.deleteAlarm()
      },
    }
    const alarm: AlarmControl = {
      get: () => storage.getAlarm(),
      set: (at) => storage.setAlarm(at),
      delete: () => storage.deleteAlarm(),
      readErrors: () => storage.get<AlarmErrors>(ALARM_ERROR_KEY),
      writeErrors: async (errors) => {
        if (errors) await storage.put(ALARM_ERROR_KEY, errors)
        else await storage.delete(ALARM_ERROR_KEY)
      },
    }
    const strictSigningKid =
      typeof options.strictSigningKid === 'function'
        ? options.strictSigningKid(env) === true
        : options.strictSigningKid === true
    const deps: CoreDeps = {
      shop,
      store,
      alarm,
      tokens,
      appTokens,
      appTokenMode,
      strictSigningKid,
      keyring,
      credFp,
      registry: { kv: registry.kv, prefix: registry.prefix ?? DEFAULT_REGISTRY_PREFIX },
      // A getter, so switching the import off takes effect without a new instance.
      get legacyKv() {
        return options.legacyKv?.(env) ?? undefined
      },
      migrateLegacy: () => options.migrateLegacy?.(env) === true,
      legacyCutoff: options.legacyCutoff ?? DEFAULT_LEGACY_CUTOFF,
      now,
      waitUntil: (promise) => ctx.waitUntil(promise),
      report: (error) => this.options.report?.(error, error.context),
    }
    return new ShopSessions(deps)
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  /** Every object in the isolate builds with the same key: report it at most hourly per isolate, log it otherwise. */
  private reportAppTokenKey(shop: string, reason: string): void {
    const error = new ShopSessionError(`ShopSessions: ${reason}; the app-token fallback is off`, {
      shop,
      op: 'config',
      kind: 'configuration',
      code: 'app_token_key',
    })
    const now = this.now()
    if (now - appTokenKeyReportedAt < HOUR) return log(error)
    appTokenKeyReportedAt = now
    this.emit(error)
  }

  private shopOptions() {
    return { allowMyshopifyIo: this.options.allowMyshopifyIo === true }
  }

  /** Throws a configuration error. RPC calls report it once per instance, alarms at most hourly (see rpcCore, alarm). */
  private fail(shop: string, code: string, message: string): never {
    throw new ShopSessionError(`ShopSessions: ${message}`, { shop, op: 'config', kind: 'configuration', code })
  }

  private emit(error: ShopSessionError): void {
    log(error)
    try {
      this.options.report?.(error, error.context)
    } catch {
      // A failing reporter must not break session handling.
    }
  }
}

function log(error: ShopSessionError): void {
  console.error(
    JSON.stringify({ source: '@optizio/shopify-session-storage-do', message: error.message, ...error.context }),
  )
}

function isConfigurationError(error: unknown): error is ShopSessionError {
  return error instanceof ShopSessionError && error.context.op === 'config'
}

function envString(env: unknown, name: string): string | undefined {
  const value = typeof env === 'object' && env !== null ? (env as Record<string, unknown>)[name] : undefined
  return typeof value === 'string' ? value : undefined
}

function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function resolveAppTokenMode(
  value: AppTokenMode | ((env: never) => AppTokenMode | undefined) | undefined,
  env: unknown,
): AppTokenMode {
  const resolved = typeof value === 'function' ? value(env as never) : value
  return resolved === 'primary' ? 'primary' : 'fallback'
}

/** Used when primary mode runs without a client secret: refresh/migrate are not available. */
function unavailableTokenClient(): TokenClient {
  const unavailable = async (): Promise<TokenCallResult> => ({
    outcome: 'configuration',
    sentAt: Date.now(),
    ambiguous: false,
    code: 'missing_api_secret',
  })
  return { refresh: unavailable, migrate: unavailable }
}
