// The per-shop orchestrator behind the Durable Object (DESIGN.md §5, §6). All
// I/O is injected, so it runs under Node in tests.
//
// Critical sections (`critical`) are read record → decide → put with only
// storage awaits inside. Crypto, token calls and KV happen before or after.
// `version` moves on every token replacement and every delete; work spanning a
// non-storage await captures it first and discards its result if it moved.
// Registry markers and alarms written after a non-storage await are checked
// against the record again in a critical section.

import { fingerprint } from '../fingerprint.js'
import { canonicalShop } from '../shop.js'
import { LEGACY_OFFLINE_PREFIX, LEGACY_SHOP_LIST_PREFIX, ShopSessionError } from '../types.js'
import type {
  AlarmErrors,
  AppTokenClient,
  FallbackToken,
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
  PutSessionInput,
  PutSessionResult,
  ReportContext,
  ReportUnauthorizedInput,
  ReportUnauthorizedResult,
  RolloverInput,
  RolloverResult,
  Sealed,
  SealedField,
  SessionParams,
  ShopRecord,
  ShopSessionStatus,
  ShopSessionsRpc,
  TokenCallResult,
} from '../types.js'
import {
  CALLER_WAIT,
  DEFAULT_EXPIRES_IN,
  DEFAULT_REFRESH_EXPIRES_IN,
  HOUR,
  MINT_BACKOFF,
  MINT_MAX_ATTEMPTS,
  MINT_RETRY_BACKOFF_MS,
  MIN_ALARM_DELAY,
  QUARANTINE_GC,
  SECOND,
  acceptsLegacyExchange,
  acceptsNoRefreshExchange,
  alarmAction,
  alarmErrorDelay,
  appCacheFresh,
  appCacheServable,
  attemptOutstanding,
  cacheQuarantineSince,
  clampMinValidity,
  decideExchange,
  decideGet,
  describeRecord,
  exchangeRecord,
  failureRecord,
  fallbackApplies,
  fallbackFresh,
  isAppToken,
  isAppTokenCache,
  mintRejected,
  finiteNumber,
  holdsLegacyCopy,
  importedRecord,
  isCurrentPair,
  isLegacy,
  keptNewerInstall,
  mergeAlternates,
  missingRefreshFailure,
  nextAlarmAt,
  nonEmpty,
  parseLegacySession,
  planImport,
  primaryRenewAfter,
  rejectedMint,
  rejectionAfterExchange,
  strip,
  successRecord,
  terminalRecord,
  tokenIntent,
  validSeconds,
  withAlternate,
  without,
  withAppTokenFp,
} from './record.js'
import type { Alternate, DelayMode, FailureInput, IncomingPair, LegacyParse, TokenIntent } from './record.js'

export type ShopSessionsOptions = {
  /** How long a request waits for a token call before answering without it (default CALLER_WAIT). */
  callerWaitMs?: number
}

/** `version` is the one the record was read under. */
type View = { record?: ShopRecord; token?: string; unreadable: boolean; version: number }

type CallStatus = 'success' | 'terminal' | 'failed' | 'discarded' | 'skipped' | 'unreadable' | 'joined'

type Attempt = { result: TokenCallResult; alternate?: { fp: string; plain: string } }

type Probe = { unreadable: boolean; displaced?: Alternate }

type PutKind = 'exchange' | 'legacy' | 'no_refresh'

type PutOutcome = { result: PutSessionResult; created?: ShopRecord; dropped?: number }

/** `record` is absent for `none` and `import_failed`. */
type ChainAnswer = { answer: GetSessionResult; record?: ShopRecord; version: number }

/** The request's CALLER_WAIT deadline, set by its first wait; later waits draw on what is left. */
type Budget = { until?: number }

type MintFailure = { kind: TokenCallOutcomeFailure; code: string }
type TokenCallOutcomeFailure = 'terminal' | 'transient' | 'shop_unavailable' | 'configuration'

/** `answer`: the stored app token, or after a transient primary-mode failure the still-valid cache. */
type MintResult = { status: CallStatus; answer?: GetSessionResult; failure?: MintFailure }

/** Most mints one request starts or joins: one for the chain it was answered from, one if that chain changed. */
const MAX_MINTS_PER_REQUEST = 2

const MAX_SETTLE_ATTEMPTS = 5
/** Token calls a rollover starts or joins before it gives up on a record that keeps changing. */
const MAX_ROLLOVER_ROUNDS = 3
const IGNORED = { status: 'ignored_stale' } as const
const MERGED: PutSessionResult = { status: 'merged' }
const NOT_INSTALLED: InvalidateAndRefreshResult = { status: 'failed', kind: 'terminal', code: 'not_installed' }

function noop(): void {}

export class ShopSessions implements ShopSessionsRpc {
  private readonly deps: CoreDeps
  private readonly callerWaitMs: number
  private version = 0
  private inflight: Promise<CallStatus> | undefined
  private importing: Promise<ImportLegacyResult> | undefined
  private lock: Promise<unknown> = Promise.resolve()
  private readonly reportedOnce = new Set<string>()
  /** The alarm error state last read or written, for when storage is what failed. */
  private alarmErrors: AlarmErrors | undefined
  /** The alternate-sealed copy of the refresh token this instance last made current from an exchange. */
  private lastExchanged: Alternate | undefined
  /**
   * Separate from `inflight`: a mint presents no refresh token, so Shopify's rotation rules don't serialise it with
   * refreshes, and chain callers never wait on it.
   */
  private minting: Promise<MintResult | 'joined'> | undefined
  /** No mint before this (ms epoch) after a transient failure. In memory: a lost hold costs one mint. */
  private mintBackoffUntil = 0
  /** `kind:code` of the last transient mint failure reported, so a repeat is only logged. */
  private mintReported: string | undefined
  /** Cleared by a success; what a held primary-mode `invalidateAndRefresh` reports. */
  private mintFailure: MintFailure | undefined

  constructor(deps: CoreDeps, options: ShopSessionsOptions = {}) {
    this.deps = deps
    this.callerWaitMs = options.callerWaitMs ?? CALLER_WAIT
  }

  // -------------------------------------------------------------------------
  // getSession (§6.2, §6.11)

  async getSession(input: GetSessionInput): Promise<GetSessionResult> {
    this.assertShop(input.shop)
    const minValidity = clampMinValidity(input.minValidityMs)
    const budget: Budget = {}
    const appTokens = this.deps.appTokens
    if (this.isPrimary() && appTokens) return this.primarySession(appTokens, minValidity, budget)

    const chain = await this.chainSession(minValidity, budget)
    // Never for the library: a session from loadSession would stop authenticate.admin from exchanging, and that
    // exchange is what heals the chain.
    if (input.caller !== 'app' || !appTokens || !fallbackApplies(chain.answer)) return chain.answer
    return this.fallbackSession(appTokens, minValidity, budget, chain)
  }

  private isPrimary(): boolean {
    return this.deps.appTokenMode === 'primary' && this.deps.appTokens !== undefined
  }

  private async chainSession(minValidity: number, budget: Budget): Promise<ChainAnswer> {
    let view = await this.load()
    if (!view.record && this.deps.legacyKv) {
      const imported = await this.importLegacy({ shop: this.deps.shop }).then(
        () => true,
        (error: unknown) => {
          this.reportOnce('import', 'error', errorName(error), 'Legacy session import failed')
          return false
        },
      )
      view = await this.load()
      // Without the legacy copy a new install can't be told from a shop not imported yet. Answering tokenless lets
      // admin requests exchange and background work retry, where an error would fail them all.
      if (!view.record && !imported) {
        return { answer: { status: 'tokenless', reason: 'import_failed' }, version: view.version }
      }
    }

    let attempted = false
    for (;;) {
      const { record, token, unreadable } = view
      if (!record) return { answer: { status: 'none' }, version: view.version }
      const decision = decideGet(record, {
        now: this.deps.now(),
        minValidity,
        credFp: this.deps.credFp,
        legacyCutoff: this.deps.legacyCutoff,
        unreadable,
        hasToken: token !== undefined,
        inflight: this.inflight !== undefined,
        attempted,
      })

      if (decision.kind === 'call') {
        attempted = true
        await this.waitBounded(this.runTokenCall(decision.intent, 'interactive', decision.quarantined), budget)
        view = await this.load()
        continue
      }

      let answer: GetSessionResult
      if (decision.kind === 'serve' && token !== undefined) {
        if (decision.background) this.runTokenCall('refresh', 'interactive', false).catch(noop)
        answer = {
          status: 'ok',
          session: strip({
            shop: this.deps.shop,
            scope: record.scope,
            accessToken: token,
            expires: isLegacy(record) ? undefined : record.expires,
          }),
          tokenFp: record.tokenFp ?? (await fingerprint(token)),
        }
      } else if (decision.kind === 'needs_reauth') {
        answer = { status: 'needs_reauth', since: decision.since, reason: decision.reason }
      } else {
        answer = strip({
          status: 'tokenless',
          reason: decision.kind === 'tokenless' ? decision.reason : 'token_endpoint',
          scope: record.scope,
          expires: record.expires,
          retryAfterMs: decision.kind === 'tokenless' ? decision.retryAfterMs : undefined,
        })
      }
      await this.ensureAlarm(view)
      return { answer, record, version: view.version }
    }
  }

  // -------------------------------------------------------------------------
  // putSession (§6.3, §6.11)

  async putSession(input: PutSessionInput): Promise<PutSessionResult> {
    this.assertShop(input.shop)
    const session = input.session
    if (session.isOnline) throw new TypeError('Online sessions are not supported')
    if (canonicalShop(session.shop, { allowMyshopifyIo: true }) !== this.deps.shop) {
      throw new TypeError('Session shop does not match this object')
    }
    if (this.isPrimary()) return this.putPrimary(input)
    if (input.issued) return this.putIssued(input.issued.tokenFp, session)

    const accessToken = nonEmpty(session.accessToken)
    if (!accessToken) return IGNORED
    const refreshToken = nonEmpty(session.refreshToken)
    const expires = finiteNumber(session.expires)
    const now = this.deps.now()

    if (!refreshToken && expires === undefined) {
      if (now >= this.deps.legacyCutoff) {
        this.reportOnce('put', 'legacy_exchange', 'after_cutoff', 'Non-expiring token exchange after the cutoff')
        return IGNORED
      }
      return this.putLibrary('legacy', { scope: session.scope, ...(await this.sealToken(accessToken)) })
    }

    const pair: IncomingPair = {
      scope: session.scope,
      ...(await this.sealToken(accessToken)),
      // Without an expiry the pair's age is unknown; treat it as due for a refresh.
      expires: expires ?? now,
    }
    if (!refreshToken) return this.putLibrary('no_refresh', pair)

    const refreshFp = await fingerprint(refreshToken)
    pair.refresh = await this.seal(refreshToken, 'refresh')
    pair.refreshFp = refreshFp
    pair.refreshExpires = finiteNumber(session.refreshTokenExpires) ?? now + DEFAULT_REFRESH_EXPIRES_IN
    const asAlternate: Alternate = {
      refresh: await this.seal(refreshToken, 'alternate'),
      fp: refreshFp,
      expires: pair.expires,
    }
    return this.putLibrary('exchange', pair, asAlternate)
  }

  private putIssued(tokenFp: string, session: SessionParams): Promise<PutSessionResult> {
    return this.critical(async () => {
      const record = await this.deps.store.get()
      if (record && isAppToken(record, tokenFp)) {
        // An app token written back: never stored as the chain. Without its token (invalidateAccessToken after a 401)
        // the current one is dropped, as reportUnauthorized does; one cached by primary mode is marked invalid.
        if (!nonEmpty(session.accessToken)) {
          if (record.tokenFp === tokenFp) {
            if (!record.tokenInvalid) await this.deps.store.put({ ...record, tokenInvalid: true })
          } else {
            await this.dropFallback(record, tokenFp)
          }
        }
        return MERGED
      }
      if (!record || record.tokenFp !== tokenFp) return IGNORED
      if (!nonEmpty(session.accessToken)) {
        // invalidateAccessToken after an Admin API 401 on a token this object issued.
        if (!record.tokenInvalid) await this.deps.store.put({ ...record, tokenInvalid: true })
        return MERGED
      }
      await this.mergeScope(record, session.scope)
      return MERGED
    })
  }

  private async putLibrary(kind: PutKind, pair: IncomingPair, asAlternate?: Alternate): Promise<PutSessionResult> {
    const incoming = { refreshFp: pair.refreshFp ?? '', expires: pair.expires ?? -Infinity }
    for (let attempt = 1; ; attempt++) {
      const version = this.version
      const pre = await this.deps.store.get()
      const wantDisplaced =
        kind === 'exchange' &&
        decideExchange(pre, incoming, false) === 'displace' &&
        pre?.refreshFp !== undefined &&
        this.lastExchanged?.fp !== pre.refreshFp
      const probe = await this.probe(pre, wantDisplaced)
      const last = attempt >= MAX_SETTLE_ATTEMPTS

      const outcome = await this.critical(async (): Promise<PutOutcome | null> => {
        const record = await this.deps.store.get()
        // The probe describes the record it read. A record replaced since then was written by this instance, which
        // stores only values it sealed or opened, so it is readable.
        const unreadable = this.version === version && probe.unreadable
        const now = this.deps.now()
        const file = async (target: ShopRecord, alternate: Alternate): Promise<PutOutcome> => {
          const filed = withAlternate(target, alternate)
          await this.deps.store.put(filed.record)
          return { result: MERGED, dropped: filed.dropped }
        }

        if (record && record.tokenFp === pair.tokenFp) {
          // An untagged copy of the stored token (an exchange always mints a new one): nothing to replace.
          await this.mergeScope(record, pair.scope)
          return { result: MERGED }
        }
        // An untagged copy of an app token: it must never become the chain, or the library would be served it.
        if (isAppToken(record, pair.tokenFp)) return { result: MERGED }

        let next: ShopRecord
        let dropped = 0
        if (kind === 'exchange') {
          const decision = decideExchange(record, incoming, unreadable)
          if (decision === 'duplicate' && record) {
            await this.mergeScope(record, pair.scope)
            return { result: MERGED }
          }
          if (decision === 'duplicate_alternate') return { result: MERGED }
          if (decision === 'file' && record && asAlternate) return file(record, asAlternate)
          if (decision === 'displace') {
            // Filing the current refresh token as an alternate takes a copy sealed for that field.
            const displaced = [probe.displaced, this.lastExchanged].find(
              (alternate) => alternate !== undefined && alternate.fp === record?.refreshFp,
            )
            if (record?.refresh && !displaced) {
              if (!last) return null
              // Out of attempts: keep the incoming refresh token as an alternate rather than lose it.
              if (asAlternate) return file(record, asAlternate)
            }
            const merged = mergeAlternates(displaced ? [displaced] : [], record?.alternates, pair.refreshFp)
            next = exchangeRecord(this.deps.shop, record, pair, now, merged.alternates)
            dropped = merged.dropped
          } else {
            next = exchangeRecord(this.deps.shop, record, pair, now)
          }
        } else if (kind === 'legacy') {
          if (!acceptsLegacyExchange(record, unreadable)) {
            this.reportOnce('put', 'legacy_exchange', 'ignored', 'Non-expiring token exchange over an expiring record')
            return { result: IGNORED }
          }
          next = exchangeRecord(this.deps.shop, record, pair, now)
          this.reportOnce('put', 'legacy_exchange', 'accepted', 'Stored a non-expiring token from a library exchange')
        } else {
          if (!acceptsNoRefreshExchange(record, incoming.expires, unreadable)) return { result: IGNORED }
          // That exchange retired every other refresh token for the shop.
          next = exchangeRecord(this.deps.shop, record, pair, now)
          this.reportOnce('put', 'exchange', 'missing_refresh_token', 'Library exchange returned no refresh token')
        }

        await this.deps.store.put(next)
        this.version++
        if (kind === 'exchange') this.lastExchanged = asAlternate
        await this.scheduleAlarm(next, false)
        return { result: { status: 'stored' }, created: record ? undefined : next, dropped }
      })

      if (!outcome) continue
      if (outcome.dropped) {
        this.emit('Dropped alternate refresh tokens over the cap', {
          shop: this.deps.shop,
          op: 'put',
          kind: 'alternates',
          code: 'cap_exceeded',
          count: outcome.dropped,
        })
      }
      if (outcome.created) {
        await this.writeMarker(outcome.created.pairObtainedAt).catch((error) => this.logError('put', error))
      }
      return outcome.result
    }
  }

  /** What the critical section needs to know about `record` that takes crypto to find out. */
  private async probe(record: ShopRecord | undefined, wantDisplaced: boolean): Promise<Probe> {
    if (!record || isLegacy(record) || record.needsReauth) return { unreadable: false }
    const token = record.token ? await this.open(record.token, 'token') : null
    const refresh = record.refresh ? await this.open(record.refresh, 'refresh') : null
    if (token === undefined || refresh === undefined) {
      this.reportUnreadable()
      return { unreadable: true }
    }
    if (!wantDisplaced || refresh === null || record.refreshFp === undefined) return { unreadable: false }
    const displaced = strip({
      refresh: await this.seal(refresh, 'alternate'),
      fp: record.refreshFp,
      expires: record.expires,
    })
    return { unreadable: false, displaced }
  }

  // -------------------------------------------------------------------------
  // reportUnauthorized

  async reportUnauthorized(input: ReportUnauthorizedInput): Promise<ReportUnauthorizedResult> {
    this.assertShop(input.shop)
    return this.critical(async () => {
      const record = await this.deps.store.get()
      if (this.isPrimary() && isAppTokenCache(record) && record.tokenFp === input.tokenFp) {
        // Force the next load to remint; keep the ciphertext so a racing remint can still verify the failed token.
        await this.deps.store.put({ ...record, renewAfter: 0, tokenInvalid: true })
        return { status: 'marked' }
      }
      if (record?.fallback && record.fallback.tokenFp === input.tokenFp) {
        // A revoked signing key or an uninstall: drop it; an app caller remints after the backoff.
        await this.dropFallback(record, input.tokenFp)
        return { status: 'marked' }
      }
      if (!record || !record.tokenFp || record.tokenFp !== input.tokenFp) return { status: 'ignored_stale' }
      if (!record.tokenInvalid) await this.deps.store.put({ ...record, tokenInvalid: true })
      return { status: 'marked' }
    })
  }

  /**
   * Evict a cached application-only token after an Admin API 401 and mint a replacement (§6.11).
   * With `failedAccessToken`, remints only if it still matches the cache (another request may have reminted).
   */
  async invalidateAndRefresh(input: InvalidateAndRefreshInput): Promise<InvalidateAndRefreshResult> {
    this.assertShop(input.shop)
    const appTokens = this.deps.appTokens
    if (!this.isPrimary() || !appTokens) {
      throw new TypeError('invalidateAndRefresh requires app-token primary mode')
    }

    // Any string counts as given, '' included: it matches no cached token, so the 401 is taken as stale.
    const failed = typeof input.failedAccessToken === 'string' ? input.failedAccessToken : undefined
    // Fingerprinted before the critical section, which holds only storage awaits.
    const failedFp = failed === undefined ? undefined : await fingerprint(failed)
    const marked = await this.critical(async (): Promise<'none' | 'stale' | 'marked'> => {
      const record = await this.deps.store.get()
      if (!record) return 'none'
      if (failedFp !== undefined && record.tokenFp !== failedFp) return 'stale'
      if (isAppTokenCache(record) && !(record.tokenInvalid && record.renewAfter === 0)) {
        await this.deps.store.put({ ...record, renewAfter: 0, tokenInvalid: true })
      }
      return 'marked'
    })
    // Uninstalled or never installed: minting would create a record for it.
    if (marked === 'none') return NOT_INSTALLED
    if (marked === 'stale') return IGNORED

    // getSession's holds: a rejection under this key, and the transient backoff.
    const record = await this.deps.store.get()
    const now = this.deps.now()
    if (!record) return NOT_INSTALLED
    if (mintRejected(record, appTokens.kid, now)) {
      const last = this.mintFailure
      const terminal = last && (last.kind === 'terminal' || last.kind === 'configuration')
      return {
        status: 'failed',
        kind: terminal ? last.kind : 'terminal',
        code: terminal ? last.code : 'app_token_rejected',
      }
    }
    if (this.mintBackoffUntil > now) {
      return {
        status: 'failed',
        kind: this.mintFailure?.kind ?? 'transient',
        code: this.mintFailure?.code ?? 'backoff',
      }
    }

    const minted = await this.runPrimaryMint(appTokens)
    if (minted.status === 'success' && minted.answer?.status === 'ok') return refreshed(minted.answer)
    if (minted.failure) return { status: 'failed', ...minted.failure }
    // Discarded (the record changed under the mint): answer from what is cached now.
    const after = await this.deps.store.get()
    if (!after) return NOT_INSTALLED
    const served = await this.servedPrimary(appTokens, after)
    if (served?.status === 'ok') return refreshed(served)
    return { status: 'failed', kind: 'transient', code: 'discarded' }
  }

  // -------------------------------------------------------------------------
  // App-token primary cache (DESIGN.md §6.11)

  /**
   * Read-through cache for application-only tokens. Legacy refresh-token rows (no `signingKid`) are ignored and
   * overwritten by a fresh mint — no manual migration. A shop without a record is not minted for (§6.10).
   */
  private async primarySession(
    appTokens: AppTokenClient,
    minValidity: number,
    budget: Budget,
  ): Promise<GetSessionResult> {
    for (let mints = 0; ; mints++) {
      let record = await this.deps.store.get()
      if (!record && mints === 0 && this.deps.legacyKv) {
        const imported = await this.importLegacy({ shop: this.deps.shop }).then(
          () => true,
          (error: unknown) => {
            this.reportOnce('import', 'error', errorName(error), 'Legacy session import failed')
            return false
          },
        )
        record = await this.deps.store.get()
        // As in chainSession: without the legacy copy an installed shop can't be told from an uninstalled one.
        if (!record && !imported) return { status: 'tokenless', reason: 'import_failed' }
      }
      // Uninstalled or never installed: minting would create records and markers for arbitrary domains.
      if (!record) return { status: 'none' }

      const cached = await this.servedPrimary(appTokens, record, minValidity)
      if (cached) return cached

      const now = this.deps.now()
      if (mintRejected(record, appTokens.kid, now)) {
        // A token cached before the rejection may still work: Shopify answers 401 if it doesn't.
        return (await this.serveStalePrimary(record)) ?? rejectedPrimary(record, now)
      }
      const backoff = this.mintBackoffUntil - now
      if (backoff > 0 || mints >= MAX_MINTS_PER_REQUEST) {
        return (await this.serveStalePrimary(record)) ?? tokenlessPrimary(backoff > 0 ? backoff : undefined)
      }

      const minted = await this.waitBounded(this.runPrimaryMint(appTokens), budget)
      // Out of budget: the mint finishes for the next caller.
      if (minted === undefined) return (await this.serveStalePrimary(record)) ?? tokenlessPrimary()
      if (minted.answer) return minted.answer
      if (minted.status === 'terminal') {
        const rejected = await this.deps.store.get()
        if (!rejected) return { status: 'none' }
        return (await this.serveStalePrimary(rejected)) ?? rejectedPrimary(rejected, this.deps.now())
      }
      if (minted.status === 'failed') {
        const retryAfterMs = this.mintBackoffUntil - this.deps.now()
        return tokenlessPrimary(retryAfterMs > 0 ? retryAfterMs : undefined)
      }
      // Discarded: the record changed under the mint (a destroy, an exchange). Look again.
    }
  }

  /** Only inside the renew window and kid policy, covering `minValidity`. */
  private async servedPrimary(
    appTokens: AppTokenClient,
    record: ShopRecord,
    minValidity?: number,
  ): Promise<GetSessionResult | undefined> {
    if (
      !isAppTokenCache(record) ||
      !appCacheFresh(record, {
        now: this.deps.now(),
        signingKid: appTokens.kid,
        strictSigningKid: this.deps.strictSigningKid === true,
        minValidity,
      })
    ) {
      return undefined
    }
    const token = await this.open(record.token, 'token')
    if (token === undefined) {
      this.reportUnreadable()
      return undefined
    }
    if (record.token.kid !== this.deps.keyring.currentKid) {
      // Lazy re-encryption, off the request path: a failure here must not fail an answer already in hand.
      this.deps.waitUntil(this.resealPrimary(record, token).catch((error) => this.logError('reseal', error)))
    }
    return this.primaryAnswer(record, token)
  }

  /** Still-valid cached token when a remint fails inside the pre-expiry window. */
  private async serveStalePrimary(record: ShopRecord): Promise<GetSessionResult | undefined> {
    if (!appCacheServable(record, this.deps.now())) return undefined
    const token = await this.open(record.token!, 'token')
    return token === undefined ? undefined : this.primaryAnswer(record, token)
  }

  private primaryAnswer(record: ShopRecord, token: string): GetSessionResult {
    return {
      status: 'ok',
      session: strip({
        shop: this.deps.shop,
        scope: record.scope,
        accessToken: token,
        expires: record.expires,
      }),
      tokenFp: record.tokenFp ?? '',
      source: 'app_token',
    }
  }

  private async resealPrimary(record: ShopRecord & { tokenFp: string }, plain: string): Promise<void> {
    const token = await this.seal(plain, 'token')
    await this.critical(async () => {
      const current = await this.deps.store.get()
      if (!isAppTokenCache(current) || current.tokenFp !== record.tokenFp) return
      if (current.token.kid === this.deps.keyring.currentKid) return
      await this.deps.store.put({ ...current, token })
    })
  }

  /**
   * Library writes only mark the shop installed (and drop any refresh-token chain); the next `getSession` mints. A
   * tokenless issued write-back (a 401) on the cached token clears its window.
   */
  private async putPrimary(input: PutSessionInput): Promise<PutSessionResult> {
    const session = input.session
    const issued = input.issued
    if (issued) {
      return this.critical(async () => {
        const record = await this.deps.store.get()
        if (!record) return IGNORED
        if (record.tokenFp !== issued.tokenFp) {
          // An older app token written back (a late 401 on a replaced token): the cached one is not affected.
          return isAppToken(record, issued.tokenFp) ? MERGED : IGNORED
        }
        if (!nonEmpty(session.accessToken)) {
          if (isAppTokenCache(record) && !(record.tokenInvalid && record.renewAfter === 0)) {
            await this.deps.store.put({ ...record, renewAfter: 0, tokenInvalid: true })
          }
          return MERGED
        }
        await this.mergeScope(record, session.scope)
        return MERGED
      })
    }

    const accessToken = nonEmpty(session.accessToken)
    if (!accessToken) return IGNORED

    const accessFp = await fingerprint(accessToken)
    const now = this.deps.now()
    type Outcome = { result: PutSessionResult; created?: ShopRecord; legacyCopy?: boolean }
    const outcome = await this.critical(async (): Promise<Outcome> => {
      const existing = await this.deps.store.get()
      // An untagged copy of the cached app token: only its scope can be new.
      if (isAppTokenCache(existing) && existing.tokenFp === accessFp) {
        await this.mergeScope(existing, session.scope)
        return { result: MERGED }
      }
      // An untagged copy of an older app token: never replaces the cache.
      if (isAppToken(existing, accessFp)) return { result: MERGED }
      // An install / reinstall, or authenticate.admin exchanging because loadSession found no token: drop the
      // refresh-token vault and let the next load mint. A rejection stands, shortened: the exchange runs on every
      // admin request while the mint is refused, and must not turn each one into another refused mint.
      const next: ShopRecord = strip({
        v: 1 as const,
        shop: this.deps.shop,
        scope: nonEmpty(session.scope) ?? existing?.scope,
        pairObtainedAt: now,
        source: 'exchange' as const,
        mintRejected: rejectionAfterExchange(existing?.mintRejected, now),
        appTokenFps: existing?.appTokenFps,
      })
      await this.deps.store.put(next)
      this.version++
      await this.scheduleCacheAlarm(next).catch(noop)
      return {
        result: { status: 'stored' },
        created: existing ? undefined : next,
        legacyCopy: existing !== undefined && holdsLegacyCopy(existing),
      }
    })
    if (outcome.created) {
      await this.writeMarker(outcome.created.pairObtainedAt).catch((error) => this.logError('put', error))
    }
    // The legacy row this replaced kept its KV copy for a migration that will never run now.
    if (outcome.legacyCopy) await this.deleteLegacyKeys().catch((error) => this.logError('put', error))
    return outcome.result
  }

  /** Unlike the fallback's, a joiner gets the outcome: the token is the shop's. */
  private runPrimaryMint(appTokens: AppTokenClient): Promise<MintResult> {
    const current = this.minting
    if (current) return current.then((result): MintResult => (result === 'joined' ? { status: 'joined' } : result))
    return this.single(
      () => this.minting,
      (call) => (this.minting = call),
      'mint',
      () => this.mintPrimary(appTokens),
    ) as Promise<MintResult>
  }

  /**
   * Retries 5xx / network / timeout (new assertion / `jti` each attempt); a 4xx, a challenge or a `Retry-After` ends
   * the attempts. A destroy or an exchange since `version` was captured discards the result.
   */
  private async mintPrimary(appTokens: AppTokenClient): Promise<MintResult> {
    const version = this.version
    let result: TokenCallResult | undefined
    for (let attempt = 0; attempt < MINT_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delayMs = MINT_RETRY_BACKOFF_MS[attempt - 1] ?? MINT_RETRY_BACKOFF_MS[MINT_RETRY_BACKOFF_MS.length - 1]!
        await this.sleep(delayMs)
      }
      const sentAt = this.deps.now()
      try {
        result = await appTokens.mint(this.deps.shop)
      } catch {
        result = { outcome: 'transient', sentAt, ambiguous: true, code: 'exception' }
      }
      if (!retriesMint(result)) break
    }
    if (!result) return { status: 'failed' }
    if (result.outcome !== 'success') return this.mintFailed(appTokens, version, result, true)

    this.reportMissingExpiresIn(result)
    const token = await this.seal(result.accessToken, 'token')
    const tokenFp = await fingerprint(result.accessToken)
    const lifetime = validSeconds(result.expiresIn) ? result.expiresIn * SECOND : DEFAULT_EXPIRES_IN
    const obtainedAt = result.sentAt
    const expires = obtainedAt + lifetime
    const renewAfter = primaryRenewAfter(obtainedAt, expires)
    const committed = await this.critical(
      async (): Promise<{ answer: GetSessionResult; previous: ShopRecord } | undefined> => {
        const previous = await this.deps.store.get()
        // A destroy (the uninstall) or an exchange landed during the mint: don't bring the record back or overwrite.
        if (!previous || this.version !== version) return undefined
        const next: ShopRecord = strip({
          v: 1 as const,
          shop: this.deps.shop,
          scope: nonEmpty(result.scope) ?? previous.scope,
          token,
          tokenFp,
          expires,
          renewAfter,
          signingKid: appTokens.kid,
          pairObtainedAt: obtainedAt,
          source: 'app_token' as const,
          appTokenFps: withAppTokenFp(previous.appTokenFps, tokenFp),
        })
        await this.deps.store.put(next)
        this.version++
        await this.deps.alarm.delete().catch(noop)
        return { answer: this.primaryAnswer(next, result.accessToken), previous }
      },
    )
    if (!committed) return { status: 'discarded' }
    this.mintSucceeded()
    const { previous } = committed
    // The record (and its marker) predates the mint; only the first cache after an install or a legacy row re-puts the
    // marker, in case that write was lost. Remints don't: one KV write per renewal per shop adds up.
    if (!isAppTokenCache(previous)) {
      await this.writeMarker(obtainedAt).catch((error) => this.logError('mint', error))
    }
    // The legacy row it replaced kept its KV copy for a migration that will never run now.
    if (holdsLegacyCopy(previous)) await this.deleteLegacyKeys().catch((error) => this.logError('mint', error))
    this.log('Serving an application-only token', { shop: this.deps.shop, op: 'mint', kind: 'success', code: 'minted' })
    return { status: 'success', answer: committed.answer }
  }

  /**
   * Either mode. A transient failure is held in memory for MINT_BACKOFF. A rejection (a 4xx, or a configuration error
   * Shopify answered) is stored on the existing record with a growing hold; no stub is created, as it would outlive a
   * destroy. A mint never sent (NOT_SENT) says nothing about the shop: held in memory only.
   */
  private async mintFailed(
    appTokens: AppTokenClient,
    version: number,
    result: Exclude<TokenCallResult, { outcome: 'success' }>,
    primary: boolean,
  ): Promise<MintResult> {
    const failure: MintFailure = { kind: result.outcome, code: result.code }
    if (primary) this.mintFailure = failure
    const rejected = (result.outcome === 'terminal' || result.outcome === 'configuration') && !NOT_SENT.has(result.code)
    // Fallback mode reports a rejection as terminal whatever Shopify called it: either way the chain stays the answer.
    const kind = !primary && rejected ? 'terminal' : result.outcome
    const context = this.resultContext('mint', kind, result.code, result)

    if (!rejected) {
      this.mintBackoffUntil = this.deps.now() + Math.max(MINT_BACKOFF, result.retryAfterMs ?? 0)
      const key = `${kind}:${result.code}`
      if (this.mintReported !== key) this.emit('Shopify app token request failed', context)
      else this.log('Shopify app token request failed', context)
      this.mintReported = key
      if (!primary) return { status: 'failed', failure }
      const stale = await this.deps.store.get()
      const served = stale ? await this.serveStalePrimary(stale) : undefined
      return strip({ status: 'failed' as const, answer: served, failure })
    }

    const stored = await this.critical(async (): Promise<boolean> => {
      const record = await this.deps.store.get()
      if (!record || this.version !== version) return false
      const next = { ...record, mintRejected: rejectedMint(record.mintRejected, appTokens.kid, this.deps.now()) }
      await this.deps.store.put(next)
      if (primary) await this.scheduleCacheAlarm(next).catch(noop)
      return true
    })
    // Discarded with the record it was for: a new record's own mint reports if it is refused too.
    if (!stored) {
      this.log('Shopify app token request failed', context)
      return { status: 'discarded' }
    }
    this.emit('Shopify app token request failed', context)
    return { status: 'terminal', failure }
  }

  private mintSucceeded(): void {
    this.mintReported = undefined
    this.mintFailure = undefined
    this.mintBackoffUntil = 0
  }

  private reportMissingExpiresIn(result: Extract<TokenCallResult, { outcome: 'success' }>): void {
    if (validSeconds(result.expiresIn)) return
    this.emit('Shopify app token response missing expires_in', {
      shop: this.deps.shop,
      op: 'mint',
      kind: 'success',
      code: 'missing_fields',
      requestId: result.requestId,
    })
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms)
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // -------------------------------------------------------------------------
  // App-token fallback (DESIGN.md §6.10)

  /**
   * The stored app token, or a new one, in place of the chain's answer. If the chain changes meanwhile (an exchange, a
   * refresh, a destroy), its new answer wins, or stands in for it in turn.
   */
  private async fallbackSession(
    appTokens: AppTokenClient,
    minValidity: number,
    budget: Budget,
    first: ChainAnswer,
  ): Promise<GetSessionResult> {
    let chain = first
    for (let mints = 0; ; mints++) {
      // Read now, not taken from the chain's answer: a 401 report may have dropped the token since.
      const record = await this.deps.store.get()
      if (!record) return chain.answer
      const stored = await this.servedFallback(appTokens, record, minValidity)
      if (stored) return stored
      if (mints >= MAX_MINTS_PER_REQUEST || !this.mayMint(appTokens, record)) return chain.answer

      const minted = await this.waitBounded(this.runMint(appTokens, chain.version), budget)
      if (minted !== 'joined' && minted?.answer) return minted.answer
      if (this.version !== chain.version) {
        chain = await this.chainSession(minValidity, budget)
        if (!fallbackApplies(chain.answer)) return chain.answer
      } else if (minted === undefined) {
        // Out of budget: the mint finishes for the next caller.
        return chain.answer
      }
    }
  }

  private async servedFallback(
    appTokens: AppTokenClient,
    record: ShopRecord,
    minValidity: number,
  ): Promise<GetSessionResult | undefined> {
    const fallback = record.fallback
    // A token minted with another key goes: that key may be revoked, which ends its tokens.
    if (!fallback || fallback.kid !== appTokens.kid) return undefined
    if (!fallbackFresh(fallback, this.deps.now(), minValidity)) return undefined
    // Sealed under a key since dropped from the keyring: mint a new one.
    const token = await this.open(fallback.token, 'fallback')
    return token === undefined ? undefined : this.fallbackAnswer(record, fallback, token)
  }

  private fallbackAnswer(record: ShopRecord, fallback: FallbackToken, token: string): GetSessionResult {
    return {
      status: 'ok',
      session: strip({
        shop: this.deps.shop,
        scope: fallback.scope ?? record.scope,
        accessToken: token,
        expires: fallback.expires,
      }),
      tokenFp: fallback.tokenFp,
      source: 'app_token',
    }
  }

  private mayMint(appTokens: AppTokenClient, record: ShopRecord): boolean {
    const now = this.deps.now()
    return this.mintBackoffUntil <= now && !mintRejected(record, appTokens.kid, now)
  }

  /** Drops the current app token after a 401, and backs off: a new one may well be refused the same way. */
  private async dropFallback(record: ShopRecord, tokenFp: string): Promise<void> {
    if (record.fallback?.tokenFp !== tokenFp) return
    await this.deps.store.put(without(record, 'fallback'))
    this.mintBackoffUntil = this.deps.now() + MINT_BACKOFF
  }

  private runMint(appTokens: AppTokenClient, version: number): Promise<MintResult | 'joined'> {
    return this.single(
      () => this.minting,
      (call) => (this.minting = call),
      'mint',
      () => this.mint(appTokens, version),
    )
  }

  /**
   * §6.1 steps 1 and 6 only: no `attemptSince` and no alarm, since a lost mint leaves the chain nothing to recover.
   * `version` is the chain's: one replaced or destroyed since needs no app token.
   */
  private async mint(appTokens: AppTokenClient, version: number): Promise<MintResult> {
    if (this.version !== version) return { status: 'discarded' }

    const sentAt = this.deps.now()
    let result: TokenCallResult
    try {
      result = await appTokens.mint(this.deps.shop)
    } catch {
      result = { outcome: 'transient', sentAt, ambiguous: true, code: 'exception' }
    }

    // A rejection is stored, so an evicted instance doesn't ask (and report) again; a new chain or a new key lifts it.
    if (result.outcome !== 'success') return this.mintFailed(appTokens, version, result, false)

    this.reportMissingExpiresIn(result)
    const token = await this.seal(result.accessToken, 'fallback')
    const tokenFp = await fingerprint(result.accessToken)
    const answer = await this.critical(async (): Promise<GetSessionResult | undefined> => {
      const record = await this.deps.store.get()
      // An exchange, a refresh or a destroy landed meanwhile: the chain no longer needs this token.
      if (!record || this.version !== version) return undefined
      const lifetime = validSeconds(result.expiresIn) ? result.expiresIn * SECOND : DEFAULT_EXPIRES_IN
      // Dated from the send: Shopify may return the token it issued earlier that minute, with its original expiry.
      const obtainedAt = result.sentAt
      const fallback: FallbackToken = strip({
        token,
        tokenFp,
        expires: obtainedAt + lifetime,
        scope: nonEmpty(result.scope),
        kid: appTokens.kid,
        obtainedAt,
      })
      const next = {
        ...without(record, 'mintRejected'),
        fallback,
        appTokenFps: withAppTokenFp(record.appTokenFps, tokenFp),
      }
      await this.deps.store.put(next)
      return this.fallbackAnswer(next, fallback, result.accessToken)
    })
    if (!answer) return { status: 'discarded' }
    this.mintSucceeded()
    this.log('Serving an application-only token', { shop: this.deps.shop, op: 'mint', kind: 'success', code: 'minted' })
    return { status: 'success', answer }
  }

  // -------------------------------------------------------------------------
  // Token calls (§6.1, §6.4)

  /** Starts a token call, or joins the one in flight (the caller re-reads either way). */
  private runTokenCall(intent: TokenIntent, mode: DelayMode, quarantined: boolean): Promise<CallStatus> {
    return this.single(
      () => this.inflight,
      (call) => (this.inflight = call),
      intent,
      () => this.tokenCall(intent, mode, quarantined),
    )
  }

  /** Starts `run` under `ctx.waitUntil` as the flight `get`/`set` hold, or joins the one already there (`joined`). */
  private single<T>(
    get: () => Promise<T | 'joined'> | undefined,
    set: (call: Promise<T | 'joined'> | undefined) => void,
    op: string,
    run: () => Promise<T>,
  ): Promise<T | 'joined'> {
    const current = get()
    if (current) return current.then((): 'joined' => 'joined')
    const call: Promise<T | 'joined'> = run().finally(() => {
      if (get() === call) set(undefined)
    })
    set(call)
    this.deps.waitUntil(call.catch((error) => this.logError(op, error)))
    return call
  }

  private async tokenCall(intent: TokenIntent, mode: DelayMode, quarantined: boolean): Promise<CallStatus> {
    const store = this.deps.store

    type Prepared = {
      version: number
      primary: string
      alternates: { fp: string; plain: string }[]
      known: Set<string>
    }
    let prepared: Prepared | undefined
    for (let attempt = 0; attempt < 2 && !prepared; attempt++) {
      const version = this.version
      const record = await store.get()
      if (!record || (record.needsReauth !== undefined) !== quarantined || tokenIntent(record) !== intent) {
        return 'skipped'
      }
      const sealed = intent === 'refresh' ? record.refresh : record.token
      const primary = sealed && (await this.open(sealed, intent === 'refresh' ? 'refresh' : 'token'))
      if (primary === undefined) {
        this.reportUnreadable()
        return 'unreadable'
      }
      const alternates: { fp: string; plain: string }[] = []
      if (intent === 'refresh') {
        for (const alternate of record.alternates ?? []) {
          const plain = await this.open(alternate.refresh, 'alternate')
          if (plain !== undefined) alternates.push({ fp: alternate.fp, plain })
        }
      }
      if (this.version === version) {
        const known = new Set((record.alternates ?? []).map((alternate) => alternate.fp))
        prepared = { version, primary, alternates, known }
      }
    }
    if (!prepared) return 'skipped'
    const { version } = prepared

    // Recorded before the call is sent, so if its outcome is never stored (the instance is replaced meanwhile),
    // readers and the alarm know Shopify may have processed it. A replaced instance's write fails here: it never sends.
    const ownMarker = await this.critical(async (): Promise<boolean | null> => {
      const record = await store.get()
      if (!record || this.version !== version) return null
      const now = this.deps.now()
      // If this instance is lost before the outcome is stored, the alarm replays the call; applying the outcome
      // reschedules it.
      const alarmAt = await this.deps.alarm.get()
      if (alarmAt === null || alarmAt > now + MIN_ALARM_DELAY) await this.deps.alarm.set(now + MIN_ALARM_DELAY)
      // One left by an earlier lost call is older; keep it.
      if (record.attemptSince !== undefined) return false
      await store.put({ ...record, attemptSince: now })
      return true
    })
    if (ownMarker === null) return 'skipped'

    const attempts: Attempt[] = [{ result: await this.callShopify(intent, prepared.primary) }]
    if (intent === 'refresh' && attempts[0]?.result.outcome === 'terminal') {
      // Exchange pairs that lost a race may hold the live chain.
      for (const alternate of prepared.alternates) {
        const result = await this.callShopify('refresh', alternate.plain)
        attempts.push({ result, alternate })
        if (result.outcome === 'success') break
      }
    }

    const won = attempts.find((attempt) => attempt.result.outcome === 'success')
    if (won && won.result.outcome === 'success') {
      return this.applySuccess(intent, mode, version, won.result, won.alternate, ownMarker)
    }
    return this.applyFailures(intent, mode, version, attempts, prepared.known, ownMarker)
  }

  private async callShopify(intent: TokenIntent, token: string): Promise<TokenCallResult> {
    const sentAt = this.deps.now()
    try {
      const { shop, tokens } = this.deps
      return await (intent === 'refresh' ? tokens.refresh(shop, token) : tokens.migrate(shop, token))
    } catch {
      // The token client classifies its own failures; anything thrown is treated as possibly processed.
      return { outcome: 'transient', sentAt, ambiguous: true, code: 'exception' }
    }
  }

  private async applySuccess(
    intent: TokenIntent,
    mode: DelayMode,
    version: number,
    result: Extract<TokenCallResult, { outcome: 'success' }>,
    alternate: { fp: string; plain: string } | undefined,
    ownMarker: boolean,
  ): Promise<CallStatus> {
    const refreshToken = nonEmpty(result.refreshToken)
    // Field names only; `scope` is legitimately absent from some responses.
    const missing: string[] = []
    if (!validSeconds(result.expiresIn)) missing.push('expires_in')
    if (!refreshToken) missing.push('refresh_token')
    else if (!validSeconds(result.refreshTokenExpiresIn)) missing.push('refresh_token_expires_in')
    if (missing.length > 0) {
      this.emit(`Shopify token response missing ${missing.join(', ')}`, {
        shop: this.deps.shop,
        op: intent,
        kind: 'success',
        code: 'missing_fields',
        requestId: result.requestId,
      })
    }

    if (intent === 'migrate' && !refreshToken) {
      // The legacy token is already retired and there is no refresh token to keep; retrying the identical
      // migration returns the same pair, so treat it as an ambiguous attempt rather than strand the shop.
      const attempts: Attempt[] = [
        { result: { outcome: 'transient', sentAt: result.sentAt, ambiguous: true, code: 'missing_refresh_token' } },
      ]
      return this.applyFailures(intent, mode, version, attempts, new Set(), ownMarker)
    }

    const token = await this.seal(result.accessToken, 'token')
    const tokenFp = await fingerprint(result.accessToken)
    let fresh: { refresh: Sealed; refreshFp: string } | undefined
    if (refreshToken) {
      fresh = { refresh: await this.seal(refreshToken, 'refresh'), refreshFp: await fingerprint(refreshToken) }
    } else if (alternate) {
      fresh = { refresh: await this.seal(alternate.plain, 'refresh'), refreshFp: alternate.fp }
    }

    const applied = await this.critical(async (): Promise<boolean> => {
      const record = await this.deps.store.get()
      if (!record || this.version !== version) return false
      const now = this.deps.now()
      // Without a new refresh token the presented one stays current (same version, so same token).
      const refresh =
        fresh ??
        (record.refresh && record.refreshFp ? { refresh: record.refresh, refreshFp: record.refreshFp } : undefined)
      if (!refresh) return false
      let next = successRecord(
        record,
        {
          intent,
          token,
          tokenFp,
          expiresIn: result.expiresIn,
          scope: result.scope,
          refresh: refresh.refresh,
          refreshFp: refresh.refreshFp,
          refreshExpiresIn: result.refreshTokenExpiresIn,
          keptRefreshExpires: !refreshToken && !alternate ? record.refreshExpires : undefined,
        },
        now,
      )
      if (!refreshToken) {
        next = missingRefreshFailure(next, record.failures, result.sentAt, now, this.deps.credFp, record.attemptSince)
      }
      await this.deps.store.put(next)
      this.version++
      await this.scheduleAlarm(next, false)
      return true
    })
    if (!applied) return 'discarded'
    if (intent === 'migrate') await this.deleteLegacyKeys().catch((error) => this.logError('migrate', error))
    return 'success'
  }

  private async applyFailures(
    intent: TokenIntent,
    mode: DelayMode,
    version: number,
    attempts: Attempt[],
    known: Set<string>,
    ownMarker: boolean,
  ): Promise<CallStatus> {
    const nonTerminal = attempts.filter((attempt) => attempt.result.outcome !== 'terminal')
    const firstAmbiguous = attempts.find((a) => a.result.outcome !== 'success' && a.result.ambiguous)
    const primary = attempts[0]?.result

    const status = await this.critical(async (): Promise<CallStatus> => {
      const stored = await this.deps.store.get()
      if (!stored || this.version !== version) return 'discarded'
      const now = this.deps.now()
      // This call's marker goes with its outcome, unless Shopify may have processed one of its attempts. One left by
      // an earlier lost call stays until a success.
      const record = ownMarker && !firstAmbiguous ? without(stored, 'attemptSince') : stored
      const untried = (record.alternates ?? []).some((alternate) => !known.has(alternate.fp))

      let failure: FailureInput | undefined
      let source: TokenCallResult | undefined
      if (nonTerminal.length > 0) {
        // Success needs one live chain; anything short of all-terminal leaves the chain unproven dead.
        const chosen =
          nonTerminal.find(
            (a) => a.result.outcome === 'transient' || (a.result.outcome !== 'success' && a.result.ambiguous),
          ) ?? nonTerminal[0]
        source = chosen?.result
        if (source && source.outcome !== 'success') {
          failure = {
            kind: source.outcome === 'terminal' || source.ambiguous ? 'transient' : source.outcome,
            code: source.code,
            ambiguousSince: firstAmbiguous?.result.sentAt,
            retryAfterMs: source.retryAfterMs,
          }
        }
      } else if (intent === 'refresh' && untried) {
        // Alternates filed while the call was out have not been presented yet.
        failure = { kind: 'transient', code: 'untried_alternates' }
        source = primary
      }

      if (failure) {
        const { record: next, report } = failureRecord(record, failure, now, mode, this.deps.credFp)
        await this.deps.store.put(next)
        await this.scheduleAlarm(next, false)
        const context = this.resultContext(intent, failure.kind, failure.code, source, next.failures?.count)
        if (report) this.emit('Shopify token call failed', context)
        else this.log('Shopify token call failed', context)
        return 'failed'
      }

      const next = terminalRecord(record, intent, now, this.deps.credFp)
      await this.deps.store.put(next)
      await this.scheduleAlarm(next, false)
      const context = this.resultContext(
        intent,
        'terminal',
        primary && primary.outcome !== 'success' ? primary.code : 'terminal',
        primary,
      )
      // An uninstall deletes the record first, so a rejected refresh chain is unexpected; a rejected legacy
      // token is an ordinary migration outcome.
      if (intent === 'refresh') this.emit('Shopify rejected every refresh token', context)
      else this.log('Shopify rejected the legacy token', context)
      return 'terminal'
    })
    // A rejected legacy token's KV copy is useless, and would keep the backfill from finishing.
    if (status === 'terminal' && intent === 'migrate') {
      await this.deleteLegacyKeys().catch((error) => this.logError('migrate', error))
    }
    return status
  }

  private resultContext(
    op: string,
    kind: string,
    code: string,
    result: TokenCallResult | undefined,
    count?: number,
  ): ReportContext {
    const status = result && result.outcome !== 'success' ? result.status : undefined
    return strip({ shop: this.deps.shop, op, kind, code, status, requestId: result?.requestId, count })
  }

  // -------------------------------------------------------------------------
  // alarm (§6.5)

  /** Never throws unless it cannot re-arm itself. */
  async alarm(): Promise<void> {
    try {
      await this.runAlarm()
      // A successful run ends the error episode.
      if ((await this.deps.alarm.readErrors()) !== undefined) await this.deps.alarm.writeErrors(undefined)
      this.alarmErrors = undefined
    } catch (error) {
      await this.alarmFailed(error)
    }
  }

  /** Re-arms with the error backoff and reports at most hourly. */
  private async alarmFailed(error: unknown): Promise<void> {
    const now = this.deps.now()
    // Kept in storage: the object is usually evicted between alarms, which would reset a count kept in memory.
    const previous = await this.deps.alarm.readErrors().catch(() => this.alarmErrors)
    const lastReport = previous?.reportedAt
    const report = lastReport === undefined || now - lastReport >= HOUR
    const errors: AlarmErrors = strip({ count: (previous?.count ?? 0) + 1, reportedAt: report ? now : lastReport })
    this.alarmErrors = errors
    const context: ReportContext = {
      shop: this.deps.shop,
      op: 'alarm',
      kind: 'error',
      code: errorName(error),
      count: errors.count,
    }
    if (report) this.emit('Alarm run failed', context)
    else this.log('Alarm run failed', context)
    await this.critical(async () => {
      // A destroy that landed during the run leaves nothing to re-arm. If storage is what failed, re-arm anyway.
      const exists = await this.deps.store.get().then(
        (record) => record !== undefined,
        () => true,
      )
      if (!exists) return
      await this.deps.alarm.writeErrors(errors).catch((writeError: unknown) => {
        this.log('Alarm error state not saved', { ...context, code: errorName(writeError) })
      })
      await this.deps.alarm.set(now + alarmErrorDelay(errors.count))
    })
  }

  private async runAlarm(): Promise<void> {
    const view = await this.load()
    const record = view.record
    if (!record) return
    // Application-only primary caches have no refresh chain; the next loadSession remints. What they keep is the
    // quarantine GC: a shop whose mints are refused (or left quarantined by chain mode) for 90 days is wiped.
    const primary = this.isPrimary()
    if (primary || record.source === 'app_token') {
      const since = cacheQuarantineSince(record, primary)
      if (since !== undefined && this.deps.now() >= since + QUARANTINE_GC) {
        if (await this.wipeQuarantined((current) => cacheQuarantineSince(current, primary) === since)) return
      }
      if (!holdsLegacyCopy(record)) await this.deleteLegacyKeys()
      await this.putMarker(record.pairObtainedAt)
      // The KV awaits let a destroy in: a marker for a record that is gone is taken back.
      const gone = await this.critical(async () => {
        const current = await this.deps.store.get()
        if (!current) return true
        await this.scheduleCacheAlarm(current)
        return false
      })
      if (gone) await this.deleteMarker()
      return
    }
    const action = alarmAction(record, this.scheduleOptions(view.unreadable))
    if (action === 'wipe' && record.needsReauth) {
      const since = record.needsReauth.since
      if (await this.wipeQuarantined((current) => current.needsReauth?.since === since)) return
    } else if (action === 'migrate' || action === 'refresh') {
      await this.runTokenCall(action, 'alarm', false)
    }

    const after = await this.load()
    if (!after.record) return
    if (!holdsLegacyCopy(after.record)) await this.deleteLegacyKeys()
    await this.putMarker(after.record.pairObtainedAt)
    // The KV awaits let a destroy or a token replacement in: re-arm from the record as it is now.
    const gone = await this.critical(async () => {
      const record = await this.deps.store.get()
      if (!record) return true
      // A token replacement since `after` was read set its own alarm.
      if (this.version === after.version) await this.scheduleAlarm(record, after.unreadable)
      return false
    })
    if (gone) await this.deleteMarker()
  }

  /** The 90-day quarantine GC: like destroy, but only if `expired` still holds for the record (the same quarantine). */
  private async wipeQuarantined(expired: (record: ShopRecord) => boolean): Promise<boolean> {
    // The marker too, while the record still exists: if a delete fails the wipe aborts and the alarm retries it.
    await Promise.all([this.deleteLegacyKeys(), this.deleteMarker()])
    const wiped = await this.critical(async () => {
      const record = await this.deps.store.get()
      if (!record || !expired(record)) return false
      await this.deps.store.deleteAll()
      await this.deps.alarm.delete()
      this.version++
      return true
    })
    // Again afterwards, for a marker a racing creation wrote in between (see writeMarker).
    if (wiped) await this.deleteMarker().catch((error) => this.logError('alarm', error))
    return wiped
  }

  // -------------------------------------------------------------------------
  // importLegacy (§6.6)

  async importLegacy(input: ImportLegacyInput): Promise<ImportLegacyResult> {
    this.assertShop(input.shop)
    if (!this.importing) {
      const run: Promise<ImportLegacyResult> = this.runImport().finally(() => {
        if (this.importing === run) this.importing = undefined
      })
      this.importing = run
    }
    return this.importing
  }

  private async runImport(): Promise<ImportLegacyResult> {
    const kv = this.deps.legacyKv
    if (!kv) return { status: 'none' }
    const shop = this.deps.shop
    const version = this.version

    let parsed: LegacyParse
    try {
      parsed = parseLegacySession(await kv.get(LEGACY_OFFLINE_PREFIX + shop, 'json'), shop)
    } catch (error) {
      // KV's json reader throws SyntaxError on a value that isn't JSON.
      if (!(error instanceof SyntaxError)) throw error
      parsed = { kind: 'invalid', code: 'not_json' }
    }

    const plan = parsed.kind === 'session' ? planImport(parsed.session, this.deps.now()) : undefined
    const sealed: { token?: Sealed; tokenFp?: string; refresh?: Sealed; refreshFp?: string } = {}
    if (parsed.kind === 'session' && plan && plan.kind !== 'unusable') {
      const { accessToken, refreshToken } = parsed.session
      if (accessToken && (plan.kind === 'legacy' || plan.token))
        Object.assign(sealed, await this.sealToken(accessToken))
      if (refreshToken && plan.kind === 'expiring' && plan.refresh) {
        sealed.refresh = await this.seal(refreshToken, 'refresh')
        sealed.refreshFp = await fingerprint(refreshToken)
      }
    }

    const outcome = await this.critical(
      async (): Promise<{ result: ImportLegacyResult; deleteKeys: boolean; created?: ShopRecord }> => {
        const record = await this.deps.store.get()
        if (record) return { result: { status: 'already_present' }, deleteKeys: !holdsLegacyCopy(record) }
        // A destroy or an exchange happened while KV was read.
        if (this.version !== version) return { result: { status: 'none' }, deleteKeys: false }
        if (parsed.kind === 'absent') return { result: { status: 'none' }, deleteKeys: false }
        if (parsed.kind === 'invalid') return { result: { status: 'invalid' }, deleteKeys: true }
        if (!plan || plan.kind === 'unusable') return { result: { status: 'none' }, deleteKeys: true }
        const next = importedRecord(shop, plan, parsed.session, sealed, this.deps.now())
        await this.deps.store.put(next)
        this.version++
        await this.scheduleAlarm(next, false)
        // A legacy record keeps its KV copy until the migration retires the token.
        return { result: { status: 'imported' }, deleteKeys: plan.kind !== 'legacy', created: next }
      },
    )

    if (parsed.kind === 'invalid') {
      this.log('Legacy session unreadable', { shop, op: 'import', kind: 'invalid', code: parsed.code })
    }
    if (outcome.created) {
      await this.writeMarker(outcome.created.pairObtainedAt).catch((error) => this.logError('import', error))
    }
    if (outcome.deleteKeys) await this.deleteLegacyKeys().catch((error) => this.logError('import', error))
    return outcome.result
  }

  // -------------------------------------------------------------------------
  // destroy (§6.7)

  async destroy(input: DestroyInput): Promise<DestroyResult> {
    this.assertShop(input.shop)
    const { uninstalledAt } = input
    if (keptNewerInstall(await this.deps.store.get(), uninstalledAt)) return { status: 'kept_newer_install' }

    // KV first: a leftover legacy copy would be imported again after the record is gone, and a marker whose delete
    // failed after the record was gone would never be retried.
    await Promise.all([this.deleteLegacyKeys(), this.deleteMarker()])

    const deleted = await this.critical(async (): Promise<boolean> => {
      const record = await this.deps.store.get()
      // A reinstall may have landed while KV was cleaned up.
      if (record && keptNewerInstall(record, uninstalledAt)) return false
      await this.deps.store.deleteAll()
      await this.deps.alarm.delete()
      this.version++
      return true
    })
    if (!deleted) {
      const record = await this.deps.store.get()
      if (record) await this.writeMarker(record.pairObtainedAt)
      return { status: 'kept_newer_install' }
    }
    // Again once the record is gone, so a marker written by a creation racing this can't outlive it.
    await this.deleteMarker().catch((error) => this.logError('destroy', error))
    return { status: 'deleted' }
  }

  // -------------------------------------------------------------------------
  // rollover (§6.9)

  /** Replaces the shop's credentials now unless they were obtained at or after `obtainedBefore`. Waits for the call. */
  async rollover(input: RolloverInput): Promise<RolloverResult> {
    this.assertShop(input.shop)
    const { obtainedBefore } = input
    if (typeof obtainedBefore !== 'number' || !Number.isFinite(obtainedBefore)) {
      throw new TypeError('rollover: obtainedBefore must be a finite number')
    }
    const appTokens = this.deps.appTokens
    if (this.isPrimary() && appTokens) return this.rolloverPrimary(appTokens, obtainedBefore)
    for (let round = 0; ; round++) {
      const view = await this.load()
      const record = view.record
      if (!record) return { status: 'none' }
      if (view.unreadable) return { status: 'skipped', reason: 'unreadable' }
      const quarantine = record.needsReauth
      const intent = tokenIntent(record)
      if (quarantine) {
        // A rejection is definite: only changed credentials make the chain worth another try (§6.2).
        if (!intent || quarantine.credFp === this.deps.credFp) {
          return { status: 'needs_reauth', since: quarantine.since, reason: quarantine.reason }
        }
      } else if (isCurrentPair(record, obtainedBefore)) {
        return { status: 'current' }
      } else if (intent === 'migrate' && !this.deps.migrateLegacy() && !attemptOutstanding(record)) {
        // The switch gates migrations however they are started; finishing one Shopify may have processed doesn't count.
        return { status: 'skipped', reason: 'migration_off' }
      }
      if (!intent) return { status: 'skipped', reason: 'no_refresh_token' }
      if (round >= MAX_ROLLOVER_ROUNDS) {
        return { status: 'failed', kind: 'transient', code: 'busy', retryAt: this.deps.now() + MIN_ALARM_DELAY }
      }

      // Backoff is ignored: an operator asked. Failures still back off on the alarm schedule, so the alarm retries.
      const status = await this.runTokenCall(intent, 'alarm', quarantine !== undefined)
      if (status === 'success') return { status: 'rolled', source: intent }
      if (status === 'unreadable') return { status: 'skipped', reason: 'unreadable' }
      if (status === 'terminal' || status === 'failed') {
        const after = await this.deps.store.get()
        if (status === 'terminal' && after?.needsReauth) return { status: 'rejected', reason: after.needsReauth.reason }
        const failures = after?.failures
        if (status === 'failed' && failures) {
          return { status: 'failed', kind: failures.kind, code: failures.code, retryAt: failures.retryAt }
        }
      }
      // Joined another call, or the record changed under this one (an exchange, a destroy): look again.
    }
  }

  /**
   * Primary mode has no chain to roll: a cache minted before `obtainedBefore`, sealed under an older keyring entry,
   * signed with another key (or none at all) is replaced by a new mint.
   */
  private async rolloverPrimary(appTokens: AppTokenClient, obtainedBefore: number): Promise<RolloverResult> {
    for (let round = 0; ; round++) {
      const record = await this.deps.store.get()
      if (!record) return { status: 'none' }
      if (
        isAppTokenCache(record) &&
        !record.tokenInvalid &&
        record.signingKid === appTokens.kid &&
        record.token.kid === this.deps.keyring.currentKid &&
        record.pairObtainedAt >= obtainedBefore
      ) {
        return { status: 'current' }
      }
      // A rejection under this key is definite until the day-long recheck; a new key lifts it.
      if (mintRejected(record, appTokens.kid, this.deps.now())) {
        return { status: 'needs_reauth', since: record.mintRejected!.since, reason: 'app_token_rejected' }
      }
      if (round >= MAX_ROLLOVER_ROUNDS) {
        return { status: 'failed', kind: 'transient', code: 'busy', retryAt: this.deps.now() + MIN_ALARM_DELAY }
      }

      // The transient backoff is ignored: an operator asked.
      const minted = await this.runPrimaryMint(appTokens)
      if (minted.status === 'success') return { status: 'rolled', source: 'app_token' }
      if (minted.status === 'terminal') return { status: 'rejected', reason: 'app_token_rejected' }
      const failure = minted.failure
      if (minted.status === 'failed' && failure && failure.kind !== 'terminal') {
        return {
          status: 'failed',
          kind: failure.kind,
          code: failure.code,
          retryAt: Math.max(this.mintBackoffUntil, this.deps.now() + MIN_ALARM_DELAY),
        }
      }
      // Joined a mint that was discarded, or the record changed under this one: look again.
    }
  }

  // -------------------------------------------------------------------------
  // describe

  async describe(input: DescribeInput): Promise<ShopSessionStatus> {
    this.assertShop(input.shop)
    const view = await this.load()
    const nextAlarm = view.record ? await this.deps.alarm.get() : null
    return {
      ...describeRecord(this.deps.shop, view.record, nextAlarm, view.unreadable),
      keyring: { kids: [...this.deps.keyring.kids] },
      credentials: { credFp: this.deps.credFp },
    }
  }

  // -------------------------------------------------------------------------
  // Helpers

  private assertShop(shop: string): void {
    if (shop !== this.deps.shop) throw new TypeError('Shop does not match this object')
  }

  /** Serialises read → decide → put sections. The platform already does; this keeps the core honest under Node. */
  private critical<T>(section: () => Promise<T>): Promise<T> {
    const run = this.lock.then(section, section)
    this.lock = run.then(noop, noop)
    return run
  }

  /** The record with its current token opened, re-read if a token replacement raced the decryption. */
  private async load(): Promise<View> {
    for (let attempt = 0; ; attempt++) {
      const version = this.version
      const record = await this.deps.store.get()
      if (!record) return { unreadable: false, version }
      const token = record.token ? await this.open(record.token, 'token') : undefined
      const refreshReadable = record.refresh ? (await this.open(record.refresh, 'refresh')) !== undefined : true
      if (this.version !== version && attempt < 2) continue
      const unreadable = (record.token !== undefined && token === undefined) || !refreshReadable
      if (unreadable) this.reportUnreadable()
      return { record, token: unreadable ? undefined : token, unreadable, version }
    }
  }

  private aad(field: SealedField): string {
    return `${this.deps.shop}|${field}`
  }

  private seal(plaintext: string, field: SealedField): Promise<Sealed> {
    return this.deps.keyring.seal(plaintext, this.aad(field))
  }

  private open(sealed: Sealed, field: SealedField): Promise<string | undefined> {
    return this.deps.keyring.open(sealed, this.aad(field))
  }

  private async sealToken(accessToken: string): Promise<{ token: Sealed; tokenFp: string }> {
    return { token: await this.seal(accessToken, 'token'), tokenFp: await fingerprint(accessToken) }
  }

  private async mergeScope(record: ShopRecord, scope: string | undefined): Promise<void> {
    if (scope !== undefined && scope !== record.scope) await this.deps.store.put({ ...record, scope })
  }

  /** Waits for a token call, but no longer than the request's budget allows. `undefined` on timeout or error. */
  private async waitBounded<T>(call: Promise<T>, budget: Budget): Promise<T | undefined> {
    const until = (budget.until ??= Date.now() + this.callerWaitMs)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), Math.max(0, until - Date.now()))
    })
    try {
      return await Promise.race([call.catch(() => undefined), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private scheduleOptions(unreadable: boolean) {
    return {
      now: this.deps.now(),
      credFp: this.deps.credFp,
      migrateLegacy: this.deps.migrateLegacy(),
      unreadable,
    }
  }

  private async scheduleAlarm(record: ShopRecord, unreadable: boolean): Promise<void> {
    const at = nextAlarmAt(record, this.scheduleOptions(unreadable))
    if (at === null) await this.deps.alarm.delete()
    else await this.deps.alarm.set(at)
  }

  /** A record outside the chain wakes only for its quarantine GC (see cacheQuarantineSince). */
  private async scheduleCacheAlarm(record: ShopRecord): Promise<void> {
    const since = cacheQuarantineSince(record, this.isPrimary())
    if (since === undefined) await this.deps.alarm.delete()
    else await this.deps.alarm.set(Math.max(since + QUARANTINE_GC, this.deps.now() + MIN_ALARM_DELAY))
  }

  /** Self-heal: every answered record has an alarm unless its schedule is empty. */
  private ensureAlarm(view: View): Promise<void> {
    return this.critical(async () => {
      if ((await this.deps.alarm.get()) !== null) return
      // Not after a destroy or a token replacement since the read: they set (or cleared) the alarm themselves.
      const record = await this.deps.store.get()
      if (!record || this.version !== view.version) return
      const at = nextAlarmAt(record, this.scheduleOptions(view.unreadable))
      if (at !== null) await this.deps.alarm.set(at)
    })
  }

  private markerKey(): string {
    return this.deps.registry.prefix + this.deps.shop
  }

  private putMarker(since: number): Promise<void> {
    return this.deps.registry.kv.put(this.markerKey(), '', { metadata: { since } })
  }

  private deleteMarker(): Promise<void> {
    return this.deps.registry.kv.delete(this.markerKey())
  }

  /** Puts the marker of a record just created, then takes it back if a destroy removed the record meanwhile. */
  private async writeMarker(since: number): Promise<void> {
    await this.putMarker(since)
    if (await this.critical(async () => (await this.deps.store.get()) === undefined)) await this.deleteMarker()
  }

  private async deleteLegacyKeys(): Promise<void> {
    const kv = this.deps.legacyKv
    if (!kv) return
    await Promise.all([
      kv.delete(LEGACY_OFFLINE_PREFIX + this.deps.shop),
      kv.delete(LEGACY_SHOP_LIST_PREFIX + this.deps.shop),
    ])
  }

  private reportUnreadable(): void {
    this.reportOnce('unreadable', 'unreadable', 'open_failed', 'Stored session cannot be decrypted with the keyring')
  }

  private reportOnce(op: string, kind: string, code: string, message: string): void {
    const key = `${op}|${kind}|${code}`
    if (this.reportedOnce.has(key)) return
    this.reportedOnce.add(key)
    this.emit(message, { shop: this.deps.shop, op, kind, code })
  }

  private logError(op: string, error: unknown): void {
    this.emit('Unexpected error', { shop: this.deps.shop, op, kind: 'error', code: errorName(error) })
  }

  /** Report and log. Contexts are built from non-secret fields only. */
  private emit(message: string, context: ReportContext): void {
    this.log(message, context)
    try {
      this.deps.report(new ShopSessionError(message, context))
    } catch {
      // A failing reporter must not break session handling.
    }
  }

  private log(message: string, context: ReportContext): void {
    console.error(JSON.stringify({ source: '@optizio/shopify-session-storage-do', message, ...context }))
  }
}

/** Primary mode retries only failures a retry within seconds can fix: 5xx, network, timeout (DESIGN.md §6.11). */
function retriesMint(result: TokenCallResult): boolean {
  if (result.outcome !== 'transient' || result.code === 'challenge' || result.retryAfterMs !== undefined) return false
  return result.status === undefined || result.status >= 500
}

/** Mints Shopify never saw: they say nothing about the shop, so no rejection is stored for them. */
const NOT_SENT = new Set(['sign_failed', 'invalid_shop'])

function rejectedPrimary(record: ShopRecord, now: number): GetSessionResult {
  return { status: 'needs_reauth', since: record.mintRejected?.since ?? now, reason: 'app_token_rejected' }
}

function tokenlessPrimary(retryAfterMs?: number): GetSessionResult {
  return strip({ status: 'tokenless' as const, reason: 'token_endpoint' as const, retryAfterMs })
}

function refreshed(answer: GetSessionResult): InvalidateAndRefreshResult {
  if (answer.status !== 'ok') throw new TypeError('refreshed: not an ok answer')
  return { status: 'refreshed', session: answer.session, tokenFp: answer.tokenFp }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
