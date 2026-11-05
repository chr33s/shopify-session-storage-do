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
  CoreDeps,
  DescribeInput,
  DestroyInput,
  DestroyResult,
  GetSessionInput,
  GetSessionResult,
  ImportLegacyInput,
  ImportLegacyResult,
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
  DEFAULT_REFRESH_EXPIRES_IN,
  HOUR,
  MIN_ALARM_DELAY,
  acceptsLegacyExchange,
  acceptsNoRefreshExchange,
  alarmAction,
  alarmErrorDelay,
  attemptOutstanding,
  clampMinValidity,
  decideExchange,
  decideGet,
  describeRecord,
  exchangeRecord,
  failureRecord,
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
  strip,
  successRecord,
  terminalRecord,
  tokenIntent,
  validSeconds,
  withAlternate,
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

const MAX_SETTLE_ATTEMPTS = 5
/** Token calls a rollover starts or joins before it gives up on a record that keeps changing. */
const MAX_ROLLOVER_ROUNDS = 3
const IGNORED: PutSessionResult = { status: 'ignored_stale' }
const MERGED: PutSessionResult = { status: 'merged' }

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

  constructor(deps: CoreDeps, options: ShopSessionsOptions = {}) {
    this.deps = deps
    this.callerWaitMs = options.callerWaitMs ?? CALLER_WAIT
  }

  // -------------------------------------------------------------------------
  // getSession (§6.2)

  async getSession(input: GetSessionInput): Promise<GetSessionResult> {
    this.assertShop(input.shop)
    const minValidity = clampMinValidity(input.minValidityMs)
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
      if (!view.record && !imported) return { status: 'tokenless', reason: 'import_failed' }
    }

    let attempted = false
    for (;;) {
      const { record, token, unreadable } = view
      if (!record) return { status: 'none' }
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
        await this.waitBounded(this.runTokenCall(decision.intent, 'interactive', decision.quarantined))
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
      return answer
    }
  }

  // -------------------------------------------------------------------------
  // putSession (§6.3)

  async putSession(input: PutSessionInput): Promise<PutSessionResult> {
    this.assertShop(input.shop)
    const session = input.session
    if (session.isOnline) throw new TypeError('Online sessions are not supported')
    if (canonicalShop(session.shop, { allowMyshopifyIo: true }) !== this.deps.shop) {
      throw new TypeError('Session shop does not match this object')
    }
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
      if (!record || !record.tokenFp || record.tokenFp !== input.tokenFp) return { status: 'ignored_stale' }
      if (!record.tokenInvalid) await this.deps.store.put({ ...record, tokenInvalid: true })
      return { status: 'marked' }
    })
  }

  // -------------------------------------------------------------------------
  // Token calls (§6.1, §6.4)

  /** Starts a token call, or joins the one in flight (the caller re-reads either way). */
  private runTokenCall(intent: TokenIntent, mode: DelayMode, quarantined: boolean): Promise<CallStatus> {
    if (this.inflight) return this.inflight.then((): CallStatus => 'joined')
    const call: Promise<CallStatus> = this.tokenCall(intent, mode, quarantined).finally(() => {
      if (this.inflight === call) this.inflight = undefined
    })
    this.inflight = call
    this.deps.waitUntil(call.catch((error) => this.logError(intent, error)))
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
      const record = ownMarker && !firstAmbiguous ? withoutAttempt(stored) : stored
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
    const action = alarmAction(record, this.scheduleOptions(view.unreadable))
    if (action === 'wipe' && record.needsReauth) {
      if (await this.wipeQuarantined(record.needsReauth.since)) return
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

  /** The 90-day quarantine GC: like destroy, but only if the quarantine is still the one that expired. */
  private async wipeQuarantined(since: number): Promise<boolean> {
    // The marker too, while the record still exists: if a delete fails the wipe aborts and the alarm retries it.
    await Promise.all([this.deleteLegacyKeys(), this.deleteMarker()])
    const wiped = await this.critical(async () => {
      const record = await this.deps.store.get()
      if (!record?.needsReauth || record.needsReauth.since !== since) return false
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

  // -------------------------------------------------------------------------
  // describe

  async describe(input: DescribeInput): Promise<ShopSessionStatus> {
    this.assertShop(input.shop)
    const view = await this.load()
    const nextAlarm = view.record ? await this.deps.alarm.get() : null
    return describeRecord(this.deps.shop, view.record, nextAlarm, view.unreadable)
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

  /** Waits for a token call, but no longer than a request can afford. */
  private async waitBounded(call: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.callerWaitMs)
    })
    try {
      await Promise.race([call.then(noop, noop), timeout])
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

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function withoutAttempt(record: ShopRecord): ShopRecord {
  const { attemptSince: _attemptSince, ...rest } = record
  return rest
}
