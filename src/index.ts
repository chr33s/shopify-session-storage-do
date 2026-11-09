// Worker-side entry. It must not import `cloudflare:workers` (directly or through the Durable Object or the
// core), so apps can load it anywhere; the Durable Object class lives in `./durable-object`.

export { DurableObjectSessionStorage } from './adapter.js'
export type {
  DeleteShopOptions,
  DeleteShopResult,
  DurableObjectSessionStorageOptions,
  LoadOfflineSessionOptions,
  OfflineSessionResult,
  RolloverOptions,
} from './adapter.js'

export { DEFAULT_BACKFILL_CURSOR_KEY, migrateLegacySessions } from './backfill.js'
export type { MigrateLegacySessionsOptions, MigrateLegacySessionsResult } from './backfill.js'

export { DEFAULT_ROLLOVER_REQUEST_KEY, DEFAULT_ROLLOVER_STATE_KEY, rolloverShops } from './rollover.js'
export type {
  RolloverPass,
  RolloverRequest,
  RolloverShopsOptions,
  RolloverShopsResult,
  UnrolledShop,
} from './rollover.js'

export { validateKeyring } from './crypto.js'

export { canonicalShop } from './shop.js'
export type { ShopOptions } from './shop.js'

export { DEFAULT_LOCATION_HINT, DEFAULT_REGISTRY_PREFIX, ISSUED, ShopSessionError } from './types.js'
export type {
  AppTokenKey,
  DescribeInput,
  DestroyInput,
  DestroyResult,
  FailureKind,
  GetSessionInput,
  GetSessionResult,
  ImportLegacyInput,
  ImportLegacyResult,
  IssuedTag,
  KVNamespaceLike,
  NeedsReauthReason,
  PutSessionInput,
  PutSessionResult,
  ReportContext,
  ReportUnauthorizedInput,
  ReportUnauthorizedResult,
  RolloverInput,
  RolloverResult,
  RolloverSkipReason,
  SessionParams,
  ShopSessionStatus,
  ShopSessionsNamespace,
  ShopSessionsRpc,
  TokenSource,
  TokenlessReason,
} from './types.js'
