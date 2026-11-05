// Pure rules over a shop's record: constants, backoff, schedule, merge and
// outcome builders. No I/O; the orchestrator (shop-sessions.ts) does the
// crypto, network and storage around them. See DESIGN.md §5 and §6.

import { canonicalShop } from '../shop.js'
import type {
  FailureKind,
  NeedsReauthReason,
  Sealed,
  ShopRecord,
  ShopSessionStatus,
  TokenlessReason,
} from '../types.js'

export const SECOND = 1_000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** The library exchanges or refreshes on its own inside this window. */
export const LIBRARY_WINDOW = 5 * MINUTE
export const HARD_FLOOR = 6 * MINUTE
export const SOFT_REFRESH = 15 * MINUTE
export const MAX_MIN_VALIDITY = 40 * MINUTE
export const CALLER_WAIT = 3 * SECOND
export const TOKEN_CALL_TIMEOUT = 10 * SECOND
export const KEEPALIVE_AGE = 30 * DAY
export const KEEPALIVE_REMAINING = 30 * DAY
export const LEGACY_MIGRATION_DELAY = 5 * MINUTE
export const QUARANTINE_GC = 90 * DAY
export const UNREADABLE_RECHECK = 6 * HOUR
export const LEGACY_SWITCH_RECHECK = DAY
export const MIN_ALARM_DELAY = MINUTE
/** After a failed refresh the current token is still served until this close to its expiry. */
export const SERVE_GRACE = 30 * SECOND
export const DEFAULT_EXPIRES_IN = 30 * MINUTE
export const DEFAULT_REFRESH_EXPIRES_IN = 60 * DAY
export const MAX_ALTERNATES = 5
/** A pair obtained this long after the uninstall can only come from a reinstall. */
export const REINSTALL_SLACK = 60 * SECOND
export const MAX_RETRY_AFTER = 10 * MINUTE
export const INTERACTIVE_BACKOFF_BASE = 10 * SECOND
export const INTERACTIVE_BACKOFF_MAX = 2 * MINUTE
export const ALARM_BACKOFF = [MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR] as const
export const LONG_BACKOFF = 6 * HOUR
export const LONG_BACKOFF_AFTER = 7 * DAY

export type TokenIntent = 'refresh' | 'migrate'
export type DelayMode = 'interactive' | 'alarm'
export type Alternate = { refresh: Sealed; fp: string; expires?: number }

/** Drops keys whose value is `undefined`, so stored records and answers stay tidy. */
export function strip<T extends object>(value: T): T {
  const out = { ...value }
  for (const key of Object.keys(out) as (keyof T)[]) if (out[key] === undefined) delete out[key]
  return out
}

export function clampMinValidity(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return HARD_FLOOR
  return Math.min(MAX_MIN_VALIDITY, Math.max(HARD_FLOOR, ms))
}

/** A positive, finite number of seconds, as Shopify's `expires_in` fields should be. */
export function validSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Wait before the next attempt after `count` consecutive failures. Configuration
 * and shop-state problems back off long regardless of who asked; transient ones
 * back off briefly for request-driven calls and stepwise for the alarm.
 */
export function delay(
  count: number,
  kind: FailureKind,
  mode: DelayMode,
  options: { retryAfterMs?: number; episodeMs?: number } = {},
): number {
  if (kind !== 'transient') return (options.episodeMs ?? 0) >= LONG_BACKOFF_AFTER ? DAY : LONG_BACKOFF
  const n = Math.max(1, Math.floor(count))
  const retryAfter =
    options.retryAfterMs !== undefined && Number.isFinite(options.retryAfterMs) && options.retryAfterMs >= 0
      ? Math.min(options.retryAfterMs, MAX_RETRY_AFTER)
      : undefined
  if (mode === 'alarm') {
    const step = ALARM_BACKOFF[Math.min(n, ALARM_BACKOFF.length) - 1] ?? LONG_BACKOFF
    return retryAfter === undefined ? step : Math.max(step, retryAfter)
  }
  if (retryAfter !== undefined) return retryAfter
  return Math.min(INTERACTIVE_BACKOFF_MAX, INTERACTIVE_BACKOFF_BASE * 2 ** Math.min(n - 1, 20))
}

/** Backoff for the alarm's own catch-all, by consecutive failed runs (kept in storage across instances). */
export function alarmErrorDelay(count: number): number {
  return ALARM_BACKOFF[Math.min(Math.max(1, count), ALARM_BACKOFF.length) - 1] ?? LONG_BACKOFF
}

/** A legacy (non-expiring) token: no expiry and no refresh token. */
export function isLegacy(record: ShopRecord): boolean {
  return record.expires === undefined && record.refresh === undefined
}

/** A legacy record whose token is still live keeps its KV copy until the migration retires it; a rejected one doesn't. */
export function holdsLegacyCopy(record: ShopRecord): boolean {
  return isLegacy(record) && !record.needsReauth
}

/**
 * A token call was sent and Shopify may have processed it: one whose outcome was never stored (`attemptSince`, e.g.
 * lost with a replaced instance) or one that ended ambiguously. Finishing it is recovery.
 */
export function attemptOutstanding(record: ShopRecord): boolean {
  return record.attemptSince !== undefined || record.failures?.ambiguousSince !== undefined
}

/**
 * The record holds a pair Shopify issued at or after `obtainedBefore`. An imported pair's `pairObtainedAt` is the
 * import time, not when Shopify issued it, so it never counts.
 */
export function isCurrentPair(record: ShopRecord, obtainedBefore: number): boolean {
  return (
    !isLegacy(record) && !record.needsReauth && record.source !== 'import' && record.pairObtainedAt >= obtainedBefore
  )
}

/** The token call this record can make, if any. */
export function tokenIntent(record: ShopRecord): TokenIntent | undefined {
  if (isLegacy(record)) return record.token ? 'migrate' : undefined
  return record.refresh ? 'refresh' : undefined
}

/** Backoff applies only while the credentials that failed are still the ones in use. */
export function inCooldown(record: ShopRecord, now: number, credFp: string): boolean {
  const failures = record.failures
  return failures !== undefined && failures.credFp === credFp && failures.retryAt > now
}

function effectiveRetryAt(record: ShopRecord, now: number, credFp: string): number | undefined {
  const failures = record.failures
  if (!failures) return undefined
  return failures.credFp === credFp ? failures.retryAt : now
}

export function kidsOf(record: ShopRecord): string[] {
  const kids = new Set<string>()
  if (record.token) kids.add(record.token.kid)
  if (record.refresh) kids.add(record.refresh.kid)
  for (const alternate of record.alternates ?? []) kids.add(alternate.refresh.kid)
  return [...kids]
}

// ---------------------------------------------------------------------------
// getSession (§6.2)

export type GetDecision =
  | { kind: 'serve'; background: boolean }
  | { kind: 'tokenless'; reason: TokenlessReason; retryAfterMs?: number }
  | { kind: 'needs_reauth'; since: number; reason: NeedsReauthReason }
  | { kind: 'call'; intent: TokenIntent; quarantined: boolean }

export type GetContext = {
  now: number
  /** Already clamped. */
  minValidity: number
  credFp: string
  legacyCutoff: number
  unreadable: boolean
  /** The current token opened. */
  hasToken: boolean
  /** A token call is in flight (joining one is always allowed). */
  inflight: boolean
  /** This request already started or joined a token call. */
  attempted: boolean
}

export function decideGet(record: ShopRecord, c: GetContext): GetDecision {
  if (c.unreadable) return { kind: 'tokenless', reason: 'unreadable' }
  const canCall = !c.attempted && (c.inflight || !inCooldown(record, c.now, c.credFp))

  const quarantine = record.needsReauth
  if (quarantine) {
    const intent = tokenIntent(record)
    if (intent && quarantine.credFp !== c.credFp && canCall) return { kind: 'call', intent, quarantined: true }
    return { kind: 'needs_reauth', since: quarantine.since, reason: quarantine.reason }
  }

  if (isLegacy(record)) {
    // A migration in flight may retire the token at any moment: wait for it rather than serve the token.
    if (c.inflight && !c.attempted) return { kind: 'call', intent: 'migrate', quarantined: false }
    const usable = c.hasToken && !record.tokenInvalid && !attemptOutstanding(record) && c.now < c.legacyCutoff
    return usable ? { kind: 'serve', background: false } : { kind: 'tokenless', reason: 'legacy_unusable' }
  }

  const expires = record.expires ?? -Infinity
  const remaining = expires - c.now
  const tokenUsable = c.hasToken && !record.tokenInvalid

  if (!record.refresh) {
    if (tokenUsable && remaining > c.minValidity) return { kind: 'serve', background: false }
    return { kind: 'needs_reauth', since: Math.min(c.now, record.expires ?? c.now), reason: 'no_refresh_token' }
  }

  if (!tokenUsable || remaining < c.minValidity) {
    if (canCall) return { kind: 'call', intent: 'refresh', quarantined: false }
    if (tokenUsable && c.now < expires - SERVE_GRACE) return { kind: 'serve', background: false }
    const retryAfterMs = inCooldown(record, c.now, c.credFp)
      ? (record.failures?.retryAt ?? c.now) - c.now
      : c.inflight
        ? SECOND
        : undefined
    return strip({ kind: 'tokenless', reason: 'token_endpoint', retryAfterMs }) as GetDecision
  }

  const background = remaining < SOFT_REFRESH && !c.inflight && !inCooldown(record, c.now, c.credFp)
  return { kind: 'serve', background }
}

// ---------------------------------------------------------------------------
// Alarm schedule (§6.5)

export type ScheduleOptions = { now: number; credFp: string; migrateLegacy: boolean; unreadable: boolean }

/** When the record next wants attention, before the one-minute floor; `null` for never. */
export function dueAt(record: ShopRecord, o: ScheduleOptions): number | null {
  if (record.needsReauth) return record.needsReauth.since + QUARANTINE_GC
  if (o.unreadable) return o.now + UNREADABLE_RECHECK
  const intent = tokenIntent(record)
  if (intent === 'migrate') {
    // Finishing a migration Shopify may have processed is recovery, so it ignores the switch.
    if (!o.migrateLegacy && !attemptOutstanding(record)) return o.now + LEGACY_SWITCH_RECHECK
    return Math.max(
      effectiveRetryAt(record, o.now, o.credFp) ?? -Infinity,
      record.pairObtainedAt + LEGACY_MIGRATION_DELAY,
    )
  }
  if (intent === 'refresh') {
    // A failure means an attempt was already due; its backoff decides the retry.
    const retryAt = effectiveRetryAt(record, o.now, o.credFp)
    if (retryAt !== undefined) return retryAt
    // A call whose outcome was never stored: replay it now (an alarm joins it if it is still in flight).
    if (record.attemptSince !== undefined) return record.attemptSince
    const keepalive = record.pairObtainedAt + KEEPALIVE_AGE
    return record.refreshExpires === undefined
      ? keepalive
      : Math.min(keepalive, record.refreshExpires - KEEPALIVE_REMAINING)
  }
  return null
}

export function nextAlarmAt(record: ShopRecord, o: ScheduleOptions): number | null {
  const due = dueAt(record, o)
  return due === null ? null : Math.max(due, o.now + MIN_ALARM_DELAY)
}

export type AlarmAction = 'wipe' | 'migrate' | 'refresh' | 'none'

export function alarmAction(record: ShopRecord, o: ScheduleOptions): AlarmAction {
  if (record.needsReauth) return o.now >= record.needsReauth.since + QUARANTINE_GC ? 'wipe' : 'none'
  if (o.unreadable) return 'none'
  const intent = tokenIntent(record)
  if (!intent) return 'none'
  if (intent === 'migrate' && !o.migrateLegacy && !attemptOutstanding(record)) return 'none'
  const due = dueAt(record, o)
  return due !== null && due <= o.now ? intent : 'none'
}

// ---------------------------------------------------------------------------
// describe

export function describeRecord(
  shop: string,
  record: ShopRecord | undefined,
  nextAlarm: number | null,
  unreadable: boolean,
): ShopSessionStatus {
  if (!record) return { shop, exists: false, state: 'none', nextAlarmAt: nextAlarm }
  const state: ShopSessionStatus['state'] = unreadable
    ? 'unreadable'
    : record.needsReauth
      ? 'needs_reauth'
      : record.failures
        ? 'failing'
        : isLegacy(record)
          ? 'legacy'
          : 'ok'
  const f = record.failures
  return strip({
    shop,
    exists: true,
    state,
    source: record.source,
    scope: record.scope,
    accessTokenExpiresAt: record.expires,
    refreshTokenExpiresAt: record.refreshExpires,
    pairObtainedAt: record.pairObtainedAt,
    tokenInvalid: record.tokenInvalid,
    attemptPending: record.attemptSince !== undefined ? true : undefined,
    alternates: record.alternates?.length,
    kids: kidsOf(record),
    needsReauth: record.needsReauth && { since: record.needsReauth.since, reason: record.needsReauth.reason },
    failures: f && {
      count: f.count,
      kind: f.kind,
      code: f.code,
      since: f.since,
      retryAt: f.retryAt,
      ambiguous: f.ambiguousSince !== undefined,
    },
    nextAlarmAt: nextAlarm,
  })
}

// ---------------------------------------------------------------------------
// putSession (§6.3)

/** An incoming library session, sealed and fingerprinted. */
export type IncomingPair = {
  scope?: string
  token: Sealed
  tokenFp: string
  expires?: number
  refresh?: Sealed
  refreshFp?: string
  refreshExpires?: number
}

export type MergedAlternates = { alternates: Alternate[] | undefined; dropped: number }

/**
 * Newest first, deduplicated by fingerprint, never the current refresh token, at most MAX_ALTERNATES. Over the cap
 * the oldest exchanges by `expires` go (Shopify keeps only the last one it processed alive); one without an expiry
 * counts as oldest, and later position breaks ties.
 */
export function mergeAlternates(
  head: readonly Alternate[],
  tail: readonly Alternate[] | undefined,
  currentFp: string | undefined,
): MergedAlternates {
  const seen = new Set<string>(currentFp === undefined ? [] : [currentFp])
  const all: Alternate[] = []
  for (const alternate of [...head, ...(tail ?? [])]) {
    if (seen.has(alternate.fp)) continue
    seen.add(alternate.fp)
    all.push(alternate)
  }
  if (all.length <= MAX_ALTERNATES) return { alternates: all.length > 0 ? all : undefined, dropped: 0 }
  const kept = new Set(
    all
      .map((alternate, index) => ({ expires: alternate.expires ?? -Infinity, index }))
      .sort((a, b) => b.expires - a.expires || a.index - b.index)
      .slice(0, MAX_ALTERNATES)
      .map(({ index }) => index),
  )
  return { alternates: all.filter((_, index) => kept.has(index)), dropped: all.length - MAX_ALTERNATES }
}

export type ExchangeDecision = 'accept' | 'displace' | 'file' | 'duplicate' | 'duplicate_alternate'

/**
 * Rule 3 for a library exchange that carries a refresh token. `displace` makes
 * the incoming pair current and files the stored exchange's refresh token as an
 * alternate; `file` keeps the stored pair and files the incoming one.
 */
export function decideExchange(
  record: ShopRecord | undefined,
  incoming: { refreshFp: string; expires: number },
  unreadable: boolean,
): ExchangeDecision {
  if (!record) return 'accept'
  if (record.refreshFp === incoming.refreshFp) return 'duplicate'
  if (record.alternates?.some((alternate) => alternate.fp === incoming.refreshFp)) return 'duplicate_alternate'
  if (isLegacy(record) || record.needsReauth || unreadable) return 'accept'
  // No refresh token means no chain to protect; an exchange record's alternates are kept by displacing it.
  if (!record.refresh) return record.source === 'exchange' ? 'displace' : 'accept'
  switch (record.source) {
    case 'exchange':
      return incoming.expires > (record.expires ?? -Infinity) ? 'displace' : 'file'
    case 'refresh':
    case 'import':
      // A chain descending from an exchange newer than this one survived it, so this one is older and retired.
      return incoming.expires >= (record.chainOriginExpires ?? -Infinity) ? 'accept' : 'file'
    default:
      return 'accept'
  }
}

/** Over none, legacy, quarantine or unreadable only; a refresh-capable record wins over a flag-off exchange. */
export function acceptsLegacyExchange(record: ShopRecord | undefined, unreadable: boolean): boolean {
  return !record || isLegacy(record) || record.needsReauth !== undefined || unreadable
}

/** Rule 6: an expiring exchange without a refresh token wins only by being newer. */
export function acceptsNoRefreshExchange(
  record: ShopRecord | undefined,
  expires: number,
  unreadable: boolean,
): boolean {
  return acceptsLegacyExchange(record, unreadable) || expires > (record?.expires ?? -Infinity)
}

export function exchangeRecord(
  shop: string,
  prev: ShopRecord | undefined,
  pair: IncomingPair,
  now: number,
  alternates?: Alternate[],
): ShopRecord {
  return strip({
    v: 1,
    shop,
    scope: pair.scope ?? prev?.scope,
    token: pair.token,
    tokenFp: pair.tokenFp,
    expires: pair.expires,
    refresh: pair.refresh,
    refreshFp: pair.refreshFp,
    refreshExpires: pair.refresh ? pair.refreshExpires : undefined,
    source: pair.expires === undefined ? 'legacy_exchange' : 'exchange',
    pairObtainedAt: now,
    chainOriginExpires: pair.expires,
    alternates,
  })
}

export function withAlternate(record: ShopRecord, alternate: Alternate): { record: ShopRecord; dropped: number } {
  const { alternates, dropped } = mergeAlternates([alternate], record.alternates, record.refreshFp)
  return { record: strip({ ...record, alternates }), dropped }
}

// ---------------------------------------------------------------------------
// Token outcomes (§6.4)

export type SuccessInput = {
  intent: TokenIntent
  token: Sealed
  tokenFp: string
  /** Seconds, as in the OAuth response. */
  expiresIn?: number
  scope?: string
  refresh: Sealed
  refreshFp: string
  /** Seconds, as in the OAuth response. */
  refreshExpiresIn?: number
  /** Set when the presented refresh token is kept (the response had none): its known expiry. */
  keptRefreshExpires?: number
}

export function successRecord(prev: ShopRecord, s: SuccessInput, now: number): ShopRecord {
  // A replayed refresh may return the pair first issued when an earlier attempt was sent, so its expiry dates from
  // then. Shopify extends a replayed migration's access token, so a migration dates from now.
  const base =
    s.intent === 'refresh' ? Math.min(now, prev.attemptSince ?? now, prev.failures?.ambiguousSince ?? now) : now
  const expires = base + (validSeconds(s.expiresIn) ? s.expiresIn * SECOND : DEFAULT_EXPIRES_IN)
  const refreshExpires =
    s.keptRefreshExpires ??
    now + (validSeconds(s.refreshExpiresIn) ? s.refreshExpiresIn * SECOND : DEFAULT_REFRESH_EXPIRES_IN)
  return strip({
    v: 1,
    shop: prev.shop,
    scope: nonEmpty(s.scope) ?? prev.scope,
    token: s.token,
    tokenFp: s.tokenFp,
    expires,
    refresh: s.refresh,
    refreshFp: s.refreshFp,
    refreshExpires,
    source: s.intent,
    pairObtainedAt: now,
    chainOriginExpires: s.intent === 'migrate' ? expires : prev.chainOriginExpires,
  })
}

export type FailureInput = {
  kind: FailureKind
  code: string
  /** Send time of the first ambiguous attempt in this call. */
  ambiguousSince?: number
  retryAfterMs?: number
}

/** Records a failed attempt. `report` is true when `kind:code` changed since the last report. */
export function failureRecord(
  prev: ShopRecord,
  f: FailureInput,
  now: number,
  mode: DelayMode,
  credFp: string,
): { record: ShopRecord; report: boolean } {
  const previous = prev.failures
  // Fixed credentials start a new episode, but what Shopify may have processed stays known.
  const sameEpisode = previous !== undefined && previous.credFp === credFp
  const count = sameEpisode ? previous.count + 1 : 1
  const since = sameEpisode ? previous.since : now
  const key = `${f.kind}:${f.code}`
  const failures = strip({
    count,
    kind: f.kind,
    code: f.code,
    since,
    retryAt: now + delay(count, f.kind, mode, { retryAfterMs: f.retryAfterMs, episodeMs: now - since }),
    ambiguousSince: previous?.ambiguousSince ?? f.ambiguousSince,
    credFp,
    reported: key,
  })
  return { record: { ...prev, failures }, report: previous?.reported !== key }
}

/**
 * A refresh answered without a new refresh token: the presented one is kept and
 * retried soon (it returns this same pair, issued at `sentAt` at the latest).
 * Repeats back off; the caller has already reported the missing field.
 */
export function missingRefreshFailure(
  next: ShopRecord,
  previous: ShopRecord['failures'],
  sentAt: number,
  now: number,
  credFp: string,
  /** The replaced record's `attemptSince`: an earlier lost call may have issued this pair. */
  attemptSince?: number,
): ShopRecord {
  const code = 'missing_refresh_token'
  const repeated = previous !== undefined && previous.code === code && previous.credFp === credFp
  const count = repeated ? previous.count + 1 : 1
  return {
    ...next,
    failures: {
      count,
      kind: 'transient',
      code,
      since: repeated ? previous.since : now,
      retryAt: now + delay(count, 'transient', 'alarm'),
      ambiguousSince: Math.min(previous?.ambiguousSince ?? sentAt, attemptSince ?? sentAt, sentAt),
      credFp,
      reported: `transient:${code}`,
    },
  }
}

export function terminalRecord(prev: ShopRecord, intent: TokenIntent, now: number, credFp: string): ShopRecord {
  // A terminal answer is definite, so a lost call's attemptSince has nothing left to replay; a later retry of the
  // quarantined chain writes its own.
  const { failures: _failures, attemptSince: _attemptSince, ...rest } = prev
  return {
    ...rest,
    needsReauth: {
      since: prev.needsReauth?.since ?? now,
      reason: intent === 'refresh' ? 'refresh_rejected' : 'legacy_rejected',
      credFp,
    },
  }
}

// ---------------------------------------------------------------------------
// importLegacy (§6.6)

export type LegacySession = {
  accessToken?: string
  expires?: number
  refreshToken?: string
  refreshTokenExpires?: number
  scope?: string
}

export type LegacyParse =
  { kind: 'absent' } | { kind: 'invalid'; code: string } | { kind: 'session'; session: LegacySession }

function legacyEpoch(value: unknown): number | undefined | null {
  // As Session.fromPropertyArray: falsy means absent, anything else must be a number of ms.
  if (value === undefined || value === 0 || value === '' || value === false) return undefined
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(ms) ? ms : null
}

function legacyToken(value: unknown): string | undefined | null {
  if (value === undefined || value === '') return undefined
  return typeof value === 'string' ? value : null
}

/**
 * Reads a KVSessionStorage value (`Session.toPropertyArray(true)` tuples) the way
 * the library would, keys case-insensitive. The id inside is ignored; the shop
 * inside only has to agree with the key's.
 */
export function parseLegacySession(raw: unknown, shop: string): LegacyParse {
  if (raw === null || raw === undefined) return { kind: 'absent' }
  if (!Array.isArray(raw)) return { kind: 'invalid', code: 'not_array' }
  const fields = new Map<string, unknown>()
  for (const entry of raw as unknown[]) {
    if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] !== 'string') {
      return { kind: 'invalid', code: 'bad_entry' }
    }
    const value: unknown = entry[1]
    if (value !== null && value !== undefined) fields.set(entry[0].toLowerCase(), value)
  }

  const innerShop = fields.get('shop')
  if (
    innerShop !== undefined &&
    (typeof innerShop !== 'string' || canonicalShop(innerShop, { allowMyshopifyIo: true }) !== shop)
  ) {
    return { kind: 'invalid', code: 'shop_mismatch' }
  }
  const online = fields.get('isonline')
  if (
    online === true ||
    (typeof online === 'string' && online.toLowerCase() === 'true') ||
    (typeof online === 'number' && online !== 0)
  ) {
    return { kind: 'invalid', code: 'online' }
  }

  const accessToken = legacyToken(fields.get('accesstoken'))
  const refreshToken = legacyToken(fields.get('refreshtoken'))
  if (accessToken === null || refreshToken === null) return { kind: 'invalid', code: 'bad_token' }
  const expires = legacyEpoch(fields.get('expires'))
  const refreshTokenExpires = legacyEpoch(fields.get('refreshtokenexpires'))
  if (expires === null || refreshTokenExpires === null) return { kind: 'invalid', code: 'bad_expires' }
  const scopeValue = fields.get('scope')
  const scope = scopeValue === undefined ? undefined : String(scopeValue)

  return { kind: 'session', session: strip({ accessToken, expires, refreshToken, refreshTokenExpires, scope }) }
}

export type ImportPlan =
  { kind: 'legacy' } | { kind: 'expiring'; token: boolean; refresh: boolean; expires: number } | { kind: 'unusable' }

export function planImport(s: LegacySession, now: number): ImportPlan {
  if (s.accessToken && s.expires === undefined && !s.refreshToken) return { kind: 'legacy' }
  const accessLive = s.accessToken !== undefined && s.expires !== undefined && s.expires > now
  const refreshLive =
    s.refreshToken !== undefined && (s.refreshTokenExpires === undefined || s.refreshTokenExpires > now)
  if (!accessLive && !refreshLive) return { kind: 'unusable' }
  return { kind: 'expiring', token: s.accessToken !== undefined, refresh: refreshLive, expires: s.expires ?? now }
}

export function importedRecord(
  shop: string,
  plan: Exclude<ImportPlan, { kind: 'unusable' }>,
  s: LegacySession,
  sealed: { token?: Sealed; tokenFp?: string; refresh?: Sealed; refreshFp?: string },
  now: number,
): ShopRecord {
  if (plan.kind === 'legacy') {
    return strip({
      v: 1,
      shop,
      scope: s.scope,
      token: sealed.token,
      tokenFp: sealed.tokenFp,
      source: 'import',
      pairObtainedAt: now,
    })
  }
  const withRefresh = plan.refresh && sealed.refresh !== undefined
  return strip({
    v: 1,
    shop,
    scope: s.scope,
    token: plan.token ? sealed.token : undefined,
    tokenFp: plan.token ? sealed.tokenFp : undefined,
    expires: plan.expires,
    refresh: withRefresh ? sealed.refresh : undefined,
    refreshFp: withRefresh ? sealed.refreshFp : undefined,
    refreshExpires: withRefresh ? (s.refreshTokenExpires ?? now + DEFAULT_REFRESH_EXPIRES_IN) : undefined,
    source: 'import',
    pairObtainedAt: now,
    chainOriginExpires: plan.expires,
    tokenInvalid: plan.token ? undefined : true,
  })
}

/**
 * §6.7: a pair obtained from Shopify after the uninstall can only come from a reinstall (refreshes and migrations of
 * revoked tokens fail). An import copies a token of unknown age without asking Shopify, so it proves nothing.
 */
export function keptNewerInstall(record: ShopRecord | undefined, uninstalledAt: number | undefined): boolean {
  return (
    record !== undefined &&
    uninstalledAt !== undefined &&
    record.source !== 'import' &&
    record.pairObtainedAt > uninstalledAt + REINSTALL_SLACK
  )
}
