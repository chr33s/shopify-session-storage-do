// Shared contracts between the adapter (Worker side), the Durable Object shell
// and the core. See DESIGN.md for the behaviour behind each type.

/** Symbol under which the adapter tags every Session it hands out. Not persisted by anything. */
export const ISSUED = Symbol.for('@optizio/shopify-session-storage-do')

/** Default placement for every shop's object. Must be the same at every call site. */
export const DEFAULT_LOCATION_HINT = 'enam'

/** Default prefix of the registry markers in the registry KV namespace. */
export const DEFAULT_REGISTRY_PREFIX = 'shop-session:'

/** Prefix of legacy KVSessionStorage keys (`offline_<shop>`). */
export const LEGACY_OFFLINE_PREFIX = 'offline_'
/** Legacy KVSessionStorage per-shop id list key prefix (`shop:<shop>`). */
export const LEGACY_SHOP_LIST_PREFIX = 'shop:'

// ---------------------------------------------------------------------------
// Record

/** AES-256-GCM ciphertext with the id of the key that sealed it. AAD is `${shop}|${field}`. */
export type Sealed = { kid: string; iv: Uint8Array; ct: Uint8Array }

export type SealedField = 'token' | 'refresh' | 'alternate'

export type TokenSource = 'exchange' | 'refresh' | 'migrate' | 'import' | 'legacy_exchange'

export type NeedsReauthReason = 'refresh_rejected' | 'legacy_rejected' | 'no_refresh_token'

export type FailureKind = 'transient' | 'shop_unavailable' | 'configuration'

export type ShopRecord = {
  v: 1
  shop: string
  scope?: string
  /** Access token, or the legacy non-expiring token. */
  token?: Sealed
  tokenFp?: string
  /** ms epoch. Absent together with `refresh` means `token` is a legacy token. */
  expires?: number
  refresh?: Sealed
  refreshFp?: string
  /** ms epoch. */
  refreshExpires?: number
  source?: TokenSource
  /** When the current token (pair) was obtained or imported. */
  pairObtainedAt: number
  /** `expires` of the exchange or import that started the current refresh chain. */
  chainOriginExpires?: number
  /**
   * Refresh tokens of exchange pairs that lost to the current one; newest first, at most 5. `expires` is that
   * exchange's access-token expiry, which decides what the cap drops.
   */
  alternates?: { refresh: Sealed; fp: string; expires?: number }[]
  /** A 401 was reported for the current access token. */
  tokenInvalid?: boolean
  /** Quarantine: sealed fields are kept but never served. */
  needsReauth?: { since: number; reason: NeedsReauthReason; credFp: string }
  /** Send time of the earliest token call whose outcome isn't stored. Written before the call is sent. */
  attemptSince?: number
  failures?: {
    count: number
    kind: FailureKind
    code: string
    since: number
    retryAt: number
    /** Send time of the first ambiguous attempt in this failure episode. */
    ambiguousSince?: number
    credFp: string
    /** `${kind}:${code}` last reported, so each transition is reported once. */
    reported?: string
  }
}

// ---------------------------------------------------------------------------
// RPC contract (plain, structured-clone-safe values only)

/** A session as it crosses RPC. Dates are ms epochs. */
export type SessionParams = {
  shop: string
  isOnline?: boolean
  scope?: string
  accessToken?: string
  expires?: number
  refreshToken?: string
  refreshTokenExpires?: number
}

/** Attached by the adapter to sessions it hands out (under `ISSUED`). */
export type IssuedTag = { tokenFp: string }

export type GetSessionInput = {
  shop: string
  minValidityMs?: number
  /** 'library' = loadSession (the Shopify library); 'app' = loadOfflineSession. */
  caller: 'library' | 'app'
}

export type TokenlessReason = 'token_endpoint' | 'unreadable' | 'legacy_unusable' | 'import_failed'

export type GetSessionResult =
  | { status: 'ok'; session: { shop: string; scope?: string; accessToken: string; expires?: number }; tokenFp: string }
  | { status: 'none' }
  | { status: 'needs_reauth'; since: number; reason: NeedsReauthReason }
  | { status: 'tokenless'; reason: TokenlessReason; scope?: string; expires?: number; retryAfterMs?: number }

export type PutSessionInput = { shop: string; session: SessionParams; issued?: IssuedTag }
export type PutSessionResult = { status: 'stored' | 'merged' | 'ignored_stale' }

export type ReportUnauthorizedInput = { shop: string; tokenFp: string }
export type ReportUnauthorizedResult = { status: 'marked' | 'ignored_stale' }

export type DestroyInput = { shop: string; uninstalledAt?: number }
export type DestroyResult = { status: 'deleted' | 'kept_newer_install' }

export type ImportLegacyInput = { shop: string }
export type ImportLegacyResult = { status: 'imported' | 'already_present' | 'none' | 'invalid' }

export type RolloverInput = {
  shop: string
  /** ms epoch. A pair obtained from Shopify at or after it is current and is left alone. */
  obtainedBefore: number
}

export type RolloverSkipReason = 'migration_off' | 'unreadable' | 'no_refresh_token'

export type RolloverResult =
  | { status: 'rolled'; source: 'refresh' | 'migrate' }
  | { status: 'current' }
  | { status: 'none' }
  /** Shopify rejected the shop's credentials just now; the record is quarantined. */
  | { status: 'rejected'; reason: NeedsReauthReason }
  /** Quarantined earlier under the same credentials, so not retried. */
  | { status: 'needs_reauth'; since: number; reason: NeedsReauthReason }
  | { status: 'failed'; kind: FailureKind; code: string; retryAt: number }
  | { status: 'skipped'; reason: RolloverSkipReason }

export type DescribeInput = { shop: string }

/** Non-secret view of a shop's record. */
export type ShopSessionStatus = {
  shop: string
  exists: boolean
  state: 'none' | 'ok' | 'legacy' | 'needs_reauth' | 'unreadable' | 'failing'
  source?: TokenSource
  scope?: string
  accessTokenExpiresAt?: number
  refreshTokenExpiresAt?: number
  pairObtainedAt?: number
  tokenInvalid?: boolean
  /** A token call was sent and its outcome isn't stored yet (in flight, or lost with an instance). */
  attemptPending?: boolean
  alternates?: number
  kids?: string[]
  needsReauth?: { since: number; reason: NeedsReauthReason }
  failures?: { count: number; kind: FailureKind; code: string; since: number; retryAt: number; ambiguous: boolean }
  nextAlarmAt?: number | null
}

/** Methods every ShopSessions Durable Object exposes over RPC. */
export interface ShopSessionsRpc {
  getSession(input: GetSessionInput): Promise<GetSessionResult>
  putSession(input: PutSessionInput): Promise<PutSessionResult>
  reportUnauthorized(input: ReportUnauthorizedInput): Promise<ReportUnauthorizedResult>
  destroy(input: DestroyInput): Promise<DestroyResult>
  importLegacy(input: ImportLegacyInput): Promise<ImportLegacyResult>
  rollover(input: RolloverInput): Promise<RolloverResult>
  describe(input: DescribeInput): Promise<ShopSessionStatus>
}

// ---------------------------------------------------------------------------
// Structural Cloudflare types (the adapter entry must not depend on workers types)

/** The parts of a DurableObjectNamespace the adapter and backfill use. */
export type ShopSessionsNamespace = {
  idFromName(name: string): unknown
  get(id: never, options?: { locationHint?: string }): unknown
}

/** The parts of a KVNamespace the package uses. */
export type KVNamespaceLike = {
  get(key: string, type: 'json'): Promise<unknown>
  put(key: string, value: string, options?: { metadata?: unknown; expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(options?: {
    prefix?: string
    cursor?: string
    limit?: number
  }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>
}

// ---------------------------------------------------------------------------
// Core dependencies (injected; the Durable Object shell provides real ones)

export interface RecordStore {
  get(): Promise<ShopRecord | undefined>
  put(record: ShopRecord): Promise<void>
  /** Delete all storage, then the alarm. */
  deleteAll(): Promise<void>
}

/** The alarm handler's consecutive failures and when one was last reported. */
export type AlarmErrors = { count: number; reportedAt?: number }

export interface AlarmControl {
  get(): Promise<number | null>
  set(at: number): Promise<void>
  delete(): Promise<void>
  /** Error state of the alarm handler, kept in storage so an eviction between alarms doesn't reset it. */
  readErrors(): Promise<AlarmErrors | undefined>
  /** `undefined` clears it. */
  writeErrors(errors: AlarmErrors | undefined): Promise<void>
}

export type TokenCallOutcome = 'success' | 'terminal' | 'transient' | 'shop_unavailable' | 'configuration'

export type TokenCallResult =
  | {
      outcome: 'success'
      /** ms epoch when the request was sent. */
      sentAt: number
      accessToken: string
      /** Seconds, as Shopify sends it. */
      expiresIn?: number
      refreshToken?: string
      /** Seconds, as Shopify sends it. */
      refreshTokenExpiresIn?: number
      scope?: string
      /** Names of expected fields that were missing or invalid. */
      missing: string[]
      requestId?: string
    }
  | {
      outcome: Exclude<TokenCallOutcome, 'success'>
      sentAt: number
      /** Shopify could have processed the request (timeout, fetch exception, 5xx, unparseable 2xx). */
      ambiguous: boolean
      status?: number
      /** OAuth `error` code, or a fixed internal code such as 'timeout', 'network', 'http_502', 'redirect'. */
      code: string
      requestId?: string
      retryAfterMs?: number
    }

export interface TokenClient {
  refresh(shop: string, refreshToken: string): Promise<TokenCallResult>
  migrate(shop: string, legacyToken: string): Promise<TokenCallResult>
}

export interface Keyring {
  readonly currentKid: string
  seal(plaintext: string, aad: string): Promise<Sealed>
  /** `undefined` when the kid isn't in the keyring or authentication fails. */
  open(sealed: Sealed, aad: string): Promise<string | undefined>
}

export type ReportContext = {
  shop: string
  /** e.g. 'refresh', 'migrate', 'import', 'alarm', 'unreadable', 'put', 'config' */
  op: string
  kind: string
  code: string
  status?: number
  requestId?: string
  count?: number
}

/** A non-secret error passed to `report`. */
export class ShopSessionError extends Error {
  readonly context: ReportContext
  constructor(message: string, context: ReportContext) {
    super(message)
    this.name = 'ShopSessionError'
    this.context = context
  }
}

export type CoreDeps = {
  shop: string
  store: RecordStore
  alarm: AlarmControl
  tokens: TokenClient
  keyring: Keyring
  /** Fingerprint of apiKey + apiSecretKey (see crypto.credentialFingerprint). */
  credFp: string
  registry: { kv: KVNamespaceLike; prefix: string }
  legacyKv?: KVNamespaceLike
  migrateLegacy: () => boolean
  legacyCutoff: number
  now: () => number
  /** ctx.waitUntil */
  waitUntil: (promise: Promise<unknown>) => void
  report: (error: ShopSessionError) => void
}
