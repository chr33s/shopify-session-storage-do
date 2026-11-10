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

export type SealedField = 'token' | 'refresh' | 'alternate' | 'fallback'

export type TokenSource = 'exchange' | 'refresh' | 'migrate' | 'import' | 'legacy_exchange' | 'app_token'

export type NeedsReauthReason = 'refresh_rejected' | 'legacy_rejected' | 'no_refresh_token' | 'app_token_rejected'

export type FailureKind = 'transient' | 'shop_unavailable' | 'configuration'

/**
 * How application-only tokens are used when `appTokenKey` is configured.
 * - `fallback` (default): mint only for `caller: 'app'` while the refresh-token chain can't produce a token (§6.10).
 * - `primary`: the object is an app-token cache; `loadSession` mints via `client_credentials` and ignores stored
 *   refresh tokens (DESIGN.md §6.11).
 */
export type AppTokenMode = 'fallback' | 'primary'

export type ShopRecord = {
  v: 1
  shop: string
  scope?: string
  /** Access token, or the legacy non-expiring token. */
  token?: Sealed
  tokenFp?: string
  /** ms epoch. Absent together with `refresh` means `token` is a legacy token. */
  expires?: number
  /**
   * ms epoch, primary app-token cache only: renew window start, jittered 180–480 s before `expires` so fleet renewals
   * spread out.
   */
  renewAfter?: number
  /** `kid` of the key that minted the primary app token; with `strictSigningKid`, a mismatch remints at once. */
  signingKid?: string
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
  /**
   * An app token minted while the chain can't produce one (DESIGN.md §6.10). Never changes the chain; every write
   * that replaces the chain's tokens drops it.
   */
  fallback?: FallbackToken
  /**
   * Shopify rejected a mint for this chain under this key: no mint until the key or chain changes (chain replacements
   * drop it) or `retryAt` passes. Repeats hold longer, up to a day; `first` dates the episode. Records predating
   * `retryAt` hold a day.
   */
  mintRejected?: { kid: string; since: number; first?: number; count?: number; retryAt?: number }
  /**
   * App tokens minted for this shop, newest first (at most 48). Kept across chain replacements so an old app token
   * written back is never taken for an exchange.
   */
  appTokenFps?: string[]
}

export type FallbackToken = {
  token: Sealed
  tokenFp: string
  /** ms epoch. */
  expires: number
  scope?: string
  /** `kid` of the signing key whose assertion minted it. */
  kid: string
  /** ms epoch the mint was sent; with `expires`, the token's lifetime. */
  obtainedAt: number
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
  | {
      status: 'ok'
      session: { shop: string; scope?: string; accessToken: string; expires?: number }
      tokenFp: string
      /** An application-only fallback token (caller 'app' only). */
      source?: 'app_token'
    }
  | { status: 'none' }
  | { status: 'needs_reauth'; since: number; reason: NeedsReauthReason }
  | { status: 'tokenless'; reason: TokenlessReason; scope?: string; expires?: number; retryAfterMs?: number }

export type PutSessionInput = { shop: string; session: SessionParams; issued?: IssuedTag }
export type PutSessionResult = { status: 'stored' | 'merged' | 'ignored_stale' }

export type ReportUnauthorizedInput = { shop: string; tokenFp: string }
export type ReportUnauthorizedResult = { status: 'marked' | 'ignored_stale' }

/**
 * After an Admin API 401, evict the cached app token and mint a replacement (DESIGN.md §6.11). With
 * `failedAccessToken`, remints only if it still matches the cache (another request may have refreshed it).
 */
export type InvalidateAndRefreshInput = { shop: string; failedAccessToken?: string }
export type InvalidateAndRefreshResult =
  | {
      status: 'refreshed'
      session: { shop: string; scope?: string; accessToken: string; expires?: number }
      tokenFp: string
    }
  | { status: 'ignored_stale' }
  | { status: 'failed'; kind: FailureKind | 'terminal' | 'configuration'; code: string }

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
  | { status: 'rolled'; source: 'refresh' | 'migrate' | 'app_token' }
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
  /** The stored application-only fallback token, if any (it may have expired). */
  fallback?: { kid: string; expires: number }
  /** A mint Shopify rejected under this signing key; none is tried before `retryAt` unless the key or the chain changes. */
  mintRejected?: { kid: string; since: number; retryAt: number }
  /** Primary app-token cache: when the renew window opens (ms epoch). */
  renewAfter?: number
  /** Primary app-token cache: `kid` that minted the stored token. */
  signingKid?: string
  nextAlarmAt?: number | null
  /** The live keyring's kids, current first: what the object seals and opens with now. Not secret. */
  keyring: { kids: string[] }
  /** The live credential fingerprint (apiKey + apiSecretKey, DESIGN.md §5). Not secret. */
  credentials: { credFp: string }
}

/** Methods every ShopSessions Durable Object exposes over RPC. */
export interface ShopSessionsRpc {
  getSession(input: GetSessionInput): Promise<GetSessionResult>
  putSession(input: PutSessionInput): Promise<PutSessionResult>
  reportUnauthorized(input: ReportUnauthorizedInput): Promise<ReportUnauthorizedResult>
  /** App-token primary mode (§6.11): evict a 401'd cache entry and mint again. */
  invalidateAndRefresh(input: InvalidateAndRefreshInput): Promise<InvalidateAndRefreshResult>
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

/** Private key whose public JWK is registered on the app (Dev Dashboard); signs application-only grant assertions. */
export type AppTokenKey = {
  /** The `kid` of the registered public JWK. */
  kid: string
  /** PKCS#8 PEM, or a private JWK. */
  privateKey: string | JsonWebKey
  alg: 'ES256' | 'RS256'
}

/** Mints application-only access tokens (client credentials grant with a signed client assertion). */
export interface AppTokenClient {
  readonly kid: string
  mint(shop: string): Promise<TokenCallResult>
}

export interface Keyring {
  readonly currentKid: string
  /** Current first. */
  readonly kids: readonly string[]
  seal(plaintext: string, aad: string): Promise<Sealed>
  /** `undefined` when the kid isn't in the keyring or authentication fails. */
  open(sealed: Sealed, aad: string): Promise<string | undefined>
}

export type ReportContext = {
  shop: string
  /** e.g. 'refresh', 'migrate', 'mint', 'import', 'alarm', 'unreadable', 'put', 'config' */
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
  /** Absent when no app token key is configured. */
  appTokens?: AppTokenClient
  /** Defaults to `fallback`. `primary` requires `appTokens` (DESIGN.md §6.11). */
  appTokenMode?: AppTokenMode
  /**
   * Primary mode: a cached token from another `signingKid` is a miss, so rolling the JWK remints at once. Otherwise
   * the old kid serves until `renewAfter`.
   */
  strictSigningKid?: boolean
  keyring: Keyring
  /** Fingerprint of apiKey + apiSecretKey (see crypto.credentialFingerprint). */
  credFp: string
  registry: { kv: KVNamespaceLike; prefix: string }
  legacyKv?: KVNamespaceLike
  migrateLegacy: () => boolean
  legacyCutoff: number
  now: () => number
  /** For primary-mode mint retries. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>
  /** ctx.waitUntil */
  waitUntil: (promise: Promise<unknown>) => void
  report: (error: ShopSessionError) => void
}
