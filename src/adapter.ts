import { Session } from '@shopify/shopify-api'
import type { SessionParams as ShopifySessionParams } from '@shopify/shopify-api'

import { canonicalShop, offlineId, shopFromOfflineId } from './shop.js'
import type { ShopOptions } from './shop.js'
import { DEFAULT_LOCATION_HINT, ISSUED } from './types.js'
import type {
  DestroyInput,
  DestroyResult,
  GetSessionInput,
  InvalidateAndRefreshResult,
  IssuedTag,
  NeedsReauthReason,
  PutSessionInput,
  RolloverResult,
  SessionParams,
  ShopSessionStatus,
  ShopSessionsNamespace,
  ShopSessionsRpc,
  TokenlessReason,
} from './types.js'

export type DurableObjectSessionStorageOptions = {
  /** The `ShopSessions` Durable Object namespace binding. */
  namespace: ShopSessionsNamespace
  /** Placement of every shop's object. The first access fixes it, so use the same value at every call site. */
  locationHint?: string
  /** Accept `*.myshopify.io` shops. Must match the Durable Object's setting. */
  allowMyshopifyIo?: boolean
}

export type LoadOfflineSessionOptions = {
  /** How long the returned access token must stay valid. The Durable Object clamps it to [6 min, 40 min]. */
  minValidityMs?: number
}

export type OfflineSessionResult =
  /** `source: 'app_token'`: an application-only token, served while the shop's own chain can't produce one. */
  | { status: 'ok'; session: Session; source?: 'app_token' }
  | { status: 'none' }
  | { status: 'needs_reauth'; since: Date; reason: NeedsReauthReason }
  | { status: 'unavailable'; reason: TokenlessReason; retryAfterMs?: number }

export type DeleteShopOptions = {
  /** When the uninstall happened. A pair obtained after it (a reinstall) is kept. */
  uninstalledAt?: Date
}

export type DeleteShopResult = DestroyResult

export type RolloverOptions = {
  /** Credentials obtained from Shopify at or after this are current and left alone. */
  obtainedBefore: Date
}

const NAME = 'DurableObjectSessionStorage'

/** A stub for the shop's object. Always fresh: a stub broken by an infrastructure error must not be reused. */
export function shopStub(namespace: ShopSessionsNamespace, shop: string, locationHint: string): ShopSessionsRpc {
  return namespace.get(namespace.idFromName(shop) as never, { locationHint }) as ShopSessionsRpc
}

/** Cloudflare marks transient infrastructure errors `retryable`; `overloaded` ones must not be retried. */
export function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { retryable, overloaded } = error as { retryable?: unknown; overloaded?: unknown }
  return retryable === true && overloaded !== true
}

/** Calls the shop's object, retrying once with a fresh stub after a retryable infrastructure error. */
export async function callShop<T>(
  namespace: ShopSessionsNamespace,
  shop: string,
  locationHint: string,
  call: (stub: ShopSessionsRpc) => Promise<T>,
): Promise<T> {
  try {
    return await call(shopStub(namespace, shop, locationHint))
  } catch (error) {
    if (!isRetryable(error)) throw error
    return await call(shopStub(namespace, shop, locationHint))
  }
}

/**
 * Shopify `SessionStorage` backed by one Durable Object per shop. Offline sessions only. Implements the
 * interface structurally, so the Shopify app library keeps this class's type (and its extra methods) on
 * `shopify.sessionStorage`.
 */
export class DurableObjectSessionStorage {
  private readonly namespace: ShopSessionsNamespace
  private readonly locationHint: string
  private readonly shopOptions: ShopOptions

  constructor(options: DurableObjectSessionStorageOptions) {
    if (!options?.namespace) throw new TypeError(`${NAME}: options.namespace is required`)
    this.namespace = options.namespace
    this.locationHint = options.locationHint ?? DEFAULT_LOCATION_HINT
    this.shopOptions = { allowMyshopifyIo: options.allowMyshopifyIo === true }
  }

  async storeSession(session: Session): Promise<boolean> {
    if (session.isOnline) throw new Error(`${NAME}: online sessions are not supported`)
    const shop = canonicalShop(session.shop, this.shopOptions)
    if (!shop || shopFromOfflineId(session.id, this.shopOptions) !== shop) {
      throw new Error(`${NAME}: storeSession needs an offline session with a valid shop and id offline_<shop>`)
    }
    const input: PutSessionInput = { shop, session: toSessionParams(shop, session) }
    const issued = readIssued(session)
    if (issued) input.issued = issued
    try {
      await this.call(shop, (stub) => stub.putSession(input))
    } finally {
      // The Durable Object is the only holder of refresh tokens, even when this write failed.
      delete session.refreshToken
      delete session.refreshTokenExpires
    }
    return true
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const shop = shopFromOfflineId(id, this.shopOptions)
    if (!shop) return undefined
    const result = await this.call(shop, (stub) => stub.getSession({ shop, caller: 'library' }))
    switch (result.status) {
      case 'ok':
        return issueSession(shop, result.session, result.tokenFp)
      case 'none':
      case 'needs_reauth':
        return undefined
      case 'tokenless':
        // No access token, so the library exchanges in admin requests; background Admin queries fail and get retried.
        return issueSession(shop, { scope: result.scope, expires: result.expires }, '')
      default:
        throw unexpectedStatus(result)
    }
  }

  async deleteSession(id: string): Promise<boolean> {
    const shop = shopFromOfflineId(id, this.shopOptions)
    if (shop) await this.destroy(shop)
    return true
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    const shops = new Set<string>()
    for (const id of ids) {
      const shop = shopFromOfflineId(id, this.shopOptions)
      if (shop) shops.add(shop)
    }
    await Promise.all([...shops].map((shop) => this.destroy(shop)))
    return true
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const canonical = canonicalShop(shop, this.shopOptions)
    if (!canonical) return []
    const session = await this.loadSession(offlineId(canonical))
    return session?.accessToken ? [session] : []
  }

  /** The shop's offline session for app code (jobs, queues), with the reason when there is none. */
  async loadOfflineSession(shop: string, options: LoadOfflineSessionOptions = {}): Promise<OfflineSessionResult> {
    const canonical = this.requireShop(shop, 'loadOfflineSession')
    const input: GetSessionInput = { shop: canonical, caller: 'app' }
    if (options.minValidityMs !== undefined) {
      if (typeof options.minValidityMs !== 'number' || !Number.isFinite(options.minValidityMs)) {
        throw new TypeError(`${NAME}: loadOfflineSession minValidityMs must be a finite number`)
      }
      input.minValidityMs = options.minValidityMs
    }
    const result = await this.call(canonical, (stub) => stub.getSession(input))
    switch (result.status) {
      case 'ok': {
        const ok: Extract<OfflineSessionResult, { status: 'ok' }> = {
          status: 'ok',
          session: issueSession(canonical, result.session, result.tokenFp),
        }
        if (result.source === 'app_token') ok.source = 'app_token'
        return ok
      }
      case 'none':
        return { status: 'none' }
      case 'needs_reauth':
        return { status: 'needs_reauth', since: new Date(result.since), reason: result.reason }
      case 'tokenless': {
        const unavailable: Extract<OfflineSessionResult, { status: 'unavailable' }> = {
          status: 'unavailable',
          reason: result.reason,
        }
        if (isFiniteNumber(result.retryAfterMs)) unavailable.retryAfterMs = result.retryAfterMs
        return unavailable
      }
      default:
        throw unexpectedStatus(result)
    }
  }

  /** Tells the shop's object that Shopify answered 401 to the access token of a session this storage issued. */
  async reportUnauthorized(session: Session): Promise<void> {
    const issued = readIssued(session)
    if (!issued?.tokenFp) {
      throw new Error(`${NAME}: reportUnauthorized needs a session with an access token loaded from this storage`)
    }
    const shop = this.requireShop(session.shop, 'reportUnauthorized')
    await this.call(shop, (stub) => stub.reportUnauthorized({ shop, tokenFp: issued.tokenFp }))
  }

  /**
   * App-token primary mode (DESIGN.md §6.11): after an Admin API `401`, evict the cached token if it still matches and
   * mint a replacement to replay the request with.
   */
  async invalidateAndRefresh(
    shop: string,
    failedAccessToken?: string,
  ): Promise<
    | { status: 'refreshed'; session: Session }
    | { status: 'ignored_stale' }
    | { status: 'failed'; kind: string; code: string }
  > {
    const canonical = this.requireShop(shop, 'invalidateAndRefresh')
    const result: InvalidateAndRefreshResult = await this.call(canonical, (stub) =>
      stub.invalidateAndRefresh({
        shop: canonical,
        ...(failedAccessToken !== undefined ? { failedAccessToken } : {}),
      }),
    )
    if (result.status === 'refreshed') {
      return { status: 'refreshed', session: issueSession(canonical, result.session, result.tokenFp) }
    }
    return result
  }

  /** Deletes the shop's session, unless a pair obtained after `uninstalledAt` shows the shop reinstalled. */
  async deleteShop(shop: string, options: DeleteShopOptions = {}): Promise<DeleteShopResult> {
    const canonical = this.requireShop(shop, 'deleteShop')
    let uninstalledAt: number | undefined
    if (options.uninstalledAt !== undefined) {
      uninstalledAt = toMs(options.uninstalledAt)
      if (uninstalledAt === undefined) throw new TypeError(`${NAME}: deleteShop uninstalledAt must be a valid Date`)
    }
    const { status } = await this.destroy(canonical, uninstalledAt)
    return { status }
  }

  /**
   * Replaces the shop's credentials now (refresh, or migrate a legacy token when migration is on) unless they were
   * obtained at or after `obtainedBefore`, and waits for Shopify's answer. Fleets go through `rolloverShops`.
   */
  async rollover(shop: string, options: RolloverOptions): Promise<RolloverResult> {
    const canonical = this.requireShop(shop, 'rollover')
    const obtainedBefore = toMs(options?.obtainedBefore)
    if (!(options?.obtainedBefore instanceof Date) || obtainedBefore === undefined) {
      throw new TypeError(`${NAME}: rollover obtainedBefore must be a valid Date`)
    }
    return await this.call(canonical, (stub) => stub.rollover({ shop: canonical, obtainedBefore }))
  }

  /** A non-secret view of the shop's record. */
  async describe(shop: string): Promise<ShopSessionStatus> {
    const canonical = this.requireShop(shop, 'describe')
    return await this.call(canonical, (stub) => stub.describe({ shop: canonical }))
  }

  private destroy(shop: string, uninstalledAt?: number): Promise<DestroyResult> {
    const input: DestroyInput = { shop }
    if (uninstalledAt !== undefined) input.uninstalledAt = uninstalledAt
    return this.call(shop, (stub) => stub.destroy(input))
  }

  private requireShop(shop: string, method: string): string {
    const canonical = canonicalShop(shop, this.shopOptions)
    if (!canonical) throw new Error(`${NAME}: ${method} needs a valid shop domain`)
    return canonical
  }

  private call<T>(shop: string, call: (stub: ShopSessionsRpc) => Promise<T>): Promise<T> {
    return callShop(this.namespace, shop, this.locationHint, call)
  }
}

/**
 * Builds the library's Session and tags it with the fingerprint of the token it carries, so a write-back
 * (app code, or the library's invalidateAccessToken) is told apart from a new exchange. Tokenless sessions
 * get an empty fingerprint: still recognised as issued, but matching no stored token.
 */
function issueSession(
  shop: string,
  fields: { scope?: string; accessToken?: string; expires?: number },
  tokenFp: string,
): Session {
  const params: ShopifySessionParams = { id: offlineId(shop), shop, state: '', isOnline: false }
  if (fields.scope !== undefined) params.scope = fields.scope
  if (fields.accessToken) params.accessToken = fields.accessToken
  if (isFiniteNumber(fields.expires)) params.expires = new Date(fields.expires)
  const session = new Session(params)
  const tag: IssuedTag = { tokenFp }
  Object.defineProperty(session, ISSUED, { value: tag, enumerable: false, configurable: true })
  return session
}

function readIssued(session: object): IssuedTag | undefined {
  const tag = (session as Record<symbol, unknown>)[ISSUED]
  if (typeof tag !== 'object' || tag === null) return undefined
  const { tokenFp } = tag as { tokenFp?: unknown }
  return typeof tokenFp === 'string' ? { tokenFp } : undefined
}

/** A structured-clone-safe copy: Session instances can't cross RPC. */
function toSessionParams(shop: string, session: Session): SessionParams {
  const params: SessionParams = { shop, isOnline: false }
  if (session.scope) params.scope = String(session.scope)
  if (session.accessToken) params.accessToken = session.accessToken
  const expires = toMs(session.expires)
  if (expires !== undefined) params.expires = expires
  if (session.refreshToken) params.refreshToken = session.refreshToken
  const refreshTokenExpires = toMs(session.refreshTokenExpires)
  if (refreshTokenExpires !== undefined) params.refreshTokenExpires = refreshTokenExpires
  return params
}

function toMs(value: unknown): number | undefined {
  const ms = value instanceof Date ? value.getTime() : value
  return isFiniteNumber(ms) ? ms : undefined
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function unexpectedStatus(result: unknown): Error {
  const status = (result as { status?: unknown } | null)?.status
  return new Error(`${NAME}: unexpected getSession status ${typeof status === 'string' ? status : typeof status}`)
}
