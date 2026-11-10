# Design: `@optizio/shopify-session-storage-do`

A Shopify `SessionStorage` for Cloudflare Workers that keeps each shop's offline
session in its own Durable Object. The Durable Object is the only place that
refreshes or upgrades the shop's token, and it survives the token exchanges the
Shopify library makes on its own, so Shopify's rotation rules hold per shop.

Status: v3 (2026-10-22), after two adversarial review rounds. v2 added an
acquisition gate, tombstones, a destroy liveness check, secret rotation and
sweeps; round two showed the gate and the liveness check misbehave and the rest
overlap or can be deferred safely. v3 is the minimal design that still covers
every stranding, chain-loss, leak and library-flow failure found. Amended after
the code review of the first implementation, and for 0.2.0 by rollovers
(§6.9, §7.2); both lists are at the end.

## 1. Goals and non-goals

Goals
- Drop-in `sessionStorage` for `@shopify/shopify-app-react-router` 3.x. The
  library is used unchanged.
- Strong consistency per shop; one token call at a time per shop.
- The refresh token never leaves the Durable Object.
- An alarm keeps refresh tokens alive long before their 90-day expiry.
- Legacy non-expiring tokens are upgraded automatically (alarm-driven, behind
  a per-environment switch), lazily imported on first use or by a backfill.
- Credentials are never destroyed because of one response: terminal results
  quarantine them.
- Tokens are encrypted at rest (AES-256-GCM, rotatable keyring). An unreadable
  record degrades to a token exchange, not an outage.
- A registry of installed shops (KV markers) for fleet listing.
- Optionally, an application-only token for app callers while the chain can't
  produce one (§6.10).

Non-goals (v1)
- Online sessions (`storeSession` of one throws; `loadSession` of an online id
  returns `undefined`). Merchant custom apps.
- Caching in the Worker isolate.
- Two client secrets at once, census/repin sweeps, a backfill circuit
  breaker. Deferred: nothing in the data model has to change to add them. The
  Durable Object always uses `SHOPIFY_API_SECRET`; a planned secret rotation
  is a deploy followed by a rollover pass (§7.2), and accepting webhooks and
  session tokens signed with either secret during the overlap is the app's.
- Authenticating RPC callers. Every Worker in the account that binds the
  namespace is trusted; encryption protects storage, backups and Data Studio.

## 2. Facts the design rests on

Library (react-router adapter 3.0.x, shopify-api 15)
- Only `loadSession` and `storeSession` are called by the library.
- `authenticate.admin` exchanges (per call, uncoordinated; loaders that run in
  parallel each exchange) when the loaded session is missing, has no access
  token, or `!isActive(undefined, 5 min)`.
- Background flows refresh only if the session has a `refreshToken` and expires
  within 5 min; otherwise they use it as is.
- `invalidateAccessToken` stores the request-start session object with
  `accessToken = undefined` after an Admin API 401.
- A session without an access token makes Admin queries throw (500 → Shopify
  retries webhooks); non-querying handlers still succeed.
- `Session` can't cross RPC; plain objects and `Date` can.

Shopify
- Access token 1 h; refresh token 90 days, renewed on every refresh. Read
  lifetimes from responses.
- The presented refresh token stays usable until the newer one is presented
  (≤ 30 days after first use, ≤ its expiry); retrying it returns the same pair.
- Any exchange retires every other refresh token for the shop; a DO refresh that
  succeeds was therefore processed before any exchange it overlaps with.
- Terminal: refresh `401 invalid_grant` ("This request requires an active
  refresh_token", for a retired or unknown token; `401 invalid_request` is
  also accepted); migration `400 invalid_subject_token` /
  `invalid_requested_token_type`. A wrong client secret answers `400
  invalid_request`, an unknown client id `400 application_cannot_be_found`,
  so a `401` never means configuration. Transient: network, timeout, `5xx`,
  `429`, challenge pages. Shop state: `402`, `423`, `404`. Other `4xx`/`3xx`:
  configuration.
- Migration invalidates the legacy token at once; the identical request within
  7 days returns the same pair. Responses may omit `scope`.
- From 2027-01-01 legacy tokens get `403` on the Admin API (no 401, so the
  library never invalidates them).
- A refresh leaves the previous access token valid until it expires.
- Secret rotation (planned): both secrets stay active until the old one is
  revoked; a refresh sent with the new secret pins the shop's token to it;
  webhooks are signed with the oldest unrevoked secret. The Dev Dashboard's
  rotation refresh token re-pins legacy tokens only and needs the current
  token. Revoking a secret kills the access tokens pinned to it, but refresh
  tokens issued under it still refresh with the new secret, so every chain
  recovers on its next refresh. Replaying a presented refresh token with the
  other secret returns the same pair, still pinned to the secret it was first
  sent with. Shopify publishes no rate limit or pacing for the token endpoint.
- Application-only tokens ([docs][app-only]): `client_credentials` with a JWT
  `client_assertion` (ES256 or RS256; `iss` = `sub` = client id, `aud` the
  shop's token URL, `exp` ≤ 300 s after `iat`, each `jti` accepted once per
  app), form-encoded, no client secret. Public-distribution apps only, on
  stores that installed them. The token lasts ≤ 1 h, has no refresh token,
  carries every granted scope (write scopes imply their read scopes), and a
  second mint with the same key within the minute returns the same token; each
  key gets its own. A replayed assertion answers `401 invalid_client`, as does
  an unregistered or revoked key. Revoking the secret doesn't affect it;
  revoking its public key (at most two are active) ends it at once, as does an
  uninstall. Token exchange and refresh accept only the client secret. No
  documented error codes or rate limit.

Checked against a dev store on 2026-11-10 with `scripts/rehearsal` (its README
lists each check). Not checked: the exchange retiring other refresh tokens,
the 30-day and 7-day windows, webhook signing, the 2027 `403`, the rotation
refresh token, the two-key limit and rate limits.

[app-only]: https://shopify.dev/docs/apps/build/authentication-authorization/application-only-access-tokens

Cloudflare
- `fetch()` (and, conservatively, `crypto.subtle`) awaits let other events
  interleave; storage awaits don't.
- A replaced instance's next storage access throws, so it can't write.
- Alarms: one per object, at-least-once, dead after ~6 failed retries.
- Old compat dates: `deleteAll()` keeps the alarm; RPC errors lose fields.
- First access fixes location. Unsafe RPC names: `name`, `id`, `fetch`.

## 3. Package shape

Repo/package `@optizio/shopify-session-storage-do`, MIT, ESM, pnpm,
TypeScript 5.9, Vitest 4, style: single quotes, no semicolons, width 120.

Entry points
- `.` — `DurableObjectSessionStorage`, `migrateLegacySessions`,
  `rolloverShops`, `validateKeyring`, types. **No `cloudflare:workers` import.**
- `./durable-object` — `createShopSessionsDurableObject`.
- `./workflow` — `createRotateSecretsWorkflow` (§7.3), `rotationKeys`, types.

Peer `@shopify/shopify-api` `^15.0.0`. No runtime dependencies.

Source
- `src/shop.ts` canonical shop domains.
- `src/crypto.ts` keyring, seal/open, fingerprints, credential fingerprint.
- `src/token-client.ts` Shopify OAuth calls and classification.
- `src/app-token.ts` client assertions for the application-only grant.
- `src/core/record.ts` record type, pure merge rules, schedule, backoff.
- `src/core/shop-sessions.ts` orchestrator (injected storage/alarm/clock/KV/
  token client/crypto; Node-testable).
- `src/durable-object.ts` DurableObject shell.
- `src/adapter.ts`, `src/backfill.ts`, `src/rollover.ts`, `src/types.ts`
  (shared contracts).
- `src/rotation.ts` the rotation flows (§7.3; the step and failure type are
  injected, so Node-testable); `src/workflow.ts` its Workflow shell.

## 4. Public API

### 4.1 Adapter

```ts
new DurableObjectSessionStorage({ namespace, locationHint = 'enam', allowMyshopifyIo = false })
loadSession(id) / storeSession(session) / deleteSession(id) / deleteSessions(ids) / findSessionsByShop(shop)
loadOfflineSession(shop, { minValidityMs? }): Promise<
  | { status: 'ok', session, source?: 'app_token' } | { status: 'none' }
  | { status: 'needs_reauth', since: Date, reason }
  | { status: 'unavailable', reason: 'token_endpoint' | 'unreadable' | 'legacy_unusable' | 'import_failed', retryAfterMs? }>
reportUnauthorized(session): Promise<void>        // background 401 on an issued session
deleteShop(shop, { uninstalledAt?: Date }): Promise<{ status: 'deleted' | 'kept_newer_install' }>
rollover(shop, { obtainedBefore: Date }): Promise<RolloverResult>   // §6.9
describe(shop): Promise<ShopSessionStatus>        // no secrets
```

`loadSession` mapping of the object's answer:
- `ok` → `Session { id, shop, state: '', isOnline: false, scope, accessToken, expires? }`
  (no `expires` for a legacy token). **Never `refreshToken`/`refreshTokenExpires`.**
- `none`, `needs_reauth` → `undefined` (admin exchanges; background sees none).
- `tokenless` (token endpoint unavailable and no usable token; unreadable
  record; legacy token unusable; legacy KV unreadable during the lazy import)
  → `Session` **without `accessToken`**: admin exchanges; background queries
  500 and Shopify retries; other handlers succeed.

Every session the adapter returns carries a non-enumerable tag under
`Symbol.for('@optizio/shopify-session-storage-do')` = `{ tokenFp }`. It is not
persisted by anything (`toPropertyArray` ignores symbols). `storeSession` and
`reportUnauthorized` send it, so the object can tell a session it issued (written
back by app code or by `invalidateAccessToken`) from a new library exchange.

`storeSession` forwards a plain object, then deletes `refreshToken` and
`refreshTokenExpires` from the caller's `Session` so nothing else holds them.

RPC infrastructure errors: `.retryable` → retry once with a fresh stub.

### 4.2 Durable Object

```ts
createShopSessionsDurableObject<Env>({
  registry(env): { kv: KVNamespace, prefix?: string }   // required; prefix 'shop-session:'
  apiKey?(env), apiSecretKey?(env)                     // default env.SHOPIFY_API_KEY / SHOPIFY_API_SECRET; empty → throw
  encryptionKeys?(env)                                 // default env.SHOPIFY_SESSION_ENCRYPTION_KEYS
  legacyKv?(env): KVNamespace | undefined              // app gates per env, e.g. SHOP_SESSIONS_LEGACY_IMPORT === 'on'
  migrateLegacy?(env): boolean                         // default false; read when the alarm runs
  appTokenKey?(env): { kid, alg: 'ES256' | 'RS256', privateKey: PEM | JWK } | undefined   // §6.10
  legacyCutoff?: number                                // default Date.UTC(2027, 0, 1)
  allowMyshopifyIo?: boolean
  report?(error, context): void
  fetch?, now?                                         // tests
}): ShopSessionsDurableObjectClass   // new (ctx, env) => ShopSessionsDurableObject, which extends DurableObject
```

RPC (all take `shop`; it must be canonical and equal `ctx.id.name` when set):
`getSession({ shop, minValidityMs?, caller })`, `putSession({ shop, session, issued? })`,
`reportUnauthorized({ shop, tokenFp })`, `destroy({ shop, uninstalledAt? })`,
`importLegacy({ shop })`, `rollover({ shop, obtainedBefore })`,
`describe({ shop })`. All expected outcomes are
returned as `{ status, … }`; only infrastructure and configuration errors throw.
A configuration error throws on every call; RPC calls report it once per
instance, the alarm under its stored hourly throttle (§6.5), and neither
repeats a report the other made on the same instance within the hour.

## 5. State

Storage keys: `record`, and `alarm-error` (`{ count, reportedAt? }`, the alarm
handler's consecutive failures, present only while it fails). Critical sections
are `read record → decide → put` with no non-storage await inside. Crypto and
fetches happen before the read. An in-memory `version` counter is bumped (after
the write) on every token replacement and every destroy; work that spans a
non-storage await captures it first and discards its result if it moved. Since
every bumping write stores only values this instance sealed or opened, a record
replaced since a read is readable. Registry markers and alarms written after a
non-storage await (KV, crypto, a token call) are checked against the record
again in a critical section: no re-arm if the record is gone or `version` moved
(the writer that moved it scheduled its own), and a marker just written for a
record that is gone is deleted again.

```ts
type ShopRecord = {
  v: 1
  shop: string
  scope?: string
  token?: Sealed; tokenFp?: string        // access token or legacy token
  expires?: number                         // absent with no refresh = legacy
  refresh?: Sealed; refreshFp?: string
  refreshExpires?: number
  source?: 'exchange' | 'refresh' | 'migrate' | 'import' | 'legacy_exchange'
  pairObtainedAt: number
  chainOriginExpires?: number              // expires of the exchange/import that started this chain
  alternates?: { refresh: Sealed; fp: string; expires?: number }[]   // ≤ 5 losing exchange refresh tokens, newest first
  tokenInvalid?: boolean
  needsReauth?: { since: number; reason: 'refresh_rejected' | 'legacy_rejected' | 'no_refresh_token'; credFp: string }
  attemptSince?: number                    // send time of the earliest token call whose outcome isn't stored
  failures?: { count: number; kind: 'transient' | 'shop_unavailable' | 'configuration'; code: string
               since: number; retryAt: number; ambiguousSince?: number; credFp: string; reported?: string }
  fallback?: { token: Sealed; tokenFp: string; expires: number; scope?: string; kid: string; obtainedAt: number }   // §6.10
  mintRejected?: { kid: string; since: number; first?: number; count?: number; retryAt?: number }                     // §6.10
  appTokenFps?: string[]                                                                                              // §6.10
}
type Sealed = { kid: string; iv: Uint8Array; ct: Uint8Array }   // AAD `${shop}|${field}`
```

Crypto
- `SHOPIFY_SESSION_ENCRYPTION_KEYS`: comma-separated strict base64, each 32
  bytes, distinct; first is current. Malformed → throw on every call.
  `validateKeyring(str)` exported for deploy checks. Keys non-extractable,
  memoized.
- `kid` = hex of the first 8 bytes of HMAC-SHA256(key, 'shop-session-kid').
- Token fingerprints: base64url of the first 16 bytes of SHA-256(token),
  unkeyed (tokens carry 128 random bits). Stable across key rotation.
- `credFp` = first 16 bytes of SHA-256(`${apiKey}:${apiSecretKey}`).
- A write seals only the fields it introduces; existing `Sealed` values are
  copied by value (each carries its own kid).
- Unreadable record (kid not in keyring, or GCM fails): `getSession` answers
  `tokenless`/`unavailable(unreadable)`; sealed fields are kept; the alarm skips
  token work and re-arms in 6 h; reported once per instance.

## 6. Algorithms

Constants: `LIBRARY_WINDOW` 5 min; `HARD_FLOOR` 6 min; `SOFT_REFRESH` 15 min;
`minValidityMs` clamped to [6 min, 40 min]; `CALLER_WAIT` 3 s; token call
timeout 10 s; `KEEPALIVE_AGE` 30 d; `KEEPALIVE_REMAINING` 30 d; legacy
migration delay 5 min; quarantine GC 90 d.
`delay(count, kind)`: transient interactive `min(2 min, 10 s·2^(count-1))`
(or `Retry-After`, ≤ 10 min); alarm `1 m, 5 m, 30 m, 2 h, 6 h`;
configuration/shop_unavailable 6 h, daily after 7 days. Backoff is ignored when
the current `credFp` differs from `failures.credFp` (credentials were fixed).

### 6.1 Token calls

One in-memory `inflight` promise per object. `refresh()` / `migrate()`:
1. If a call is in flight, await it, re-read, and return (the caller re-checks).
2. Read the record, capture `version`, decrypt the token to present plus the
   alternates. If `version` moved during decryption, start over (once).
3. Critical section (no `version` bump): re-read; if the record is gone or
   `version` moved, skip the call. Otherwise pull the alarm in to now + 1 min
   and set `attemptSince = now` unless one is set (an earlier lost call's is
   older; keep it). If the outcome is never stored (the instance is replaced),
   readers and the alarm know Shopify may have processed the call. A replaced
   instance's write fails here, so it never sends (output-gate fence).
4. Call Shopify (10 s timeout) under `ctx.waitUntil`. If the primary refresh is
   terminal and alternates exist, present them newest first. Combined result:
   success if any succeeds (that pair becomes current); transient if any was
   transient/ambiguous; terminal only if all were terminal.
5. Seal outcome tokens, compute fingerprints.
6. Critical section: re-read; if the record is gone or `version` moved, discard.
   Otherwise apply (§6.4) and bump `version` if tokens changed. Applying
   clears `attemptSince` when step 3 set it and no attempt was ambiguous; one
   left by an earlier lost call stays until a success (which replaces the
   record).

### 6.2 `getSession({ shop, minValidityMs, caller })`

`caller` is `'library'` (from `loadSession`) or `'app'` (`loadOfflineSession`).
1. No record: `legacyKv` configured → `importLegacy`, re-read. Still none →
   `none`. If the import threw (KV down): report once per instance and, unless
   a record appeared meanwhile, answer `tokenless` (`import_failed`) — admin
   requests exchange, background work retries. The `importLegacy` RPC itself
   still throws, so the backfill counts `error`.
2. Unreadable → `tokenless` (reason `unreadable`).
3. `needsReauth`: if the current `credFp` differs from `needsReauth.credFp`,
   retry the quarantined chain once (caller waits ≤ `CALLER_WAIT`); success →
   continue. Otherwise `needs_reauth`.
4. Legacy token (no `expires`, no `refresh`): if a call (a migration) is in
   flight in this instance, join it (≤ `CALLER_WAIT`) and re-read. Usable =
   `!tokenInvalid && !attemptSince && !failures?.ambiguousSince && now <
   legacyCutoff` → `ok` with the legacy token; else `tokenless` (reason
   `legacy_unusable`). Never starts a migration inline.
5. Expiring, no `refresh` (exchange returned none, or rule 6): serve while
   `expires - now > minValidity`, else `needs_reauth` (`no_refresh_token`).
6. Expiring with `refresh`:
   - `tokenInvalid` or remaining < max(`minValidityMs`, `HARD_FLOOR`): refresh
     unless in cooldown; the caller waits ≤ `CALLER_WAIT`. Success → `ok`.
     Else → the current token if `now < expires - 30 s` and not
     `tokenInvalid`, otherwise `tokenless` (`token_endpoint`, `retryAfterMs`).
   - remaining < `SOFT_REFRESH`: start a refresh in the background (unless in
     cooldown or in flight); answer with the current token.
7. `ok`.
Cooldown = `failures.retryAt > now` and the `credFp` matches. Joining an
in-flight call is always allowed. After every answer, ensure an alarm is set
(self-heal; in a critical section, and not if the record is gone or `version`
moved since the read).

### 6.3 `putSession({ shop, session, issued? })`

Incoming fingerprints and seals are computed before the critical section.
1. Online → throw.
2. `issued` present (a session this object handed out):
   - no access token → `tokenInvalid` if `issued.tokenFp === record.tokenFp`,
     else `ignored_stale`;
   - access token → merge `scope` if `issued.tokenFp === record.tokenFp`, else
     `ignored_stale`. Never replaces tokens.
3. Not issued (created by the library — an exchange):
   - no access token → `ignored_stale` (nothing to store).
   - access token whose fingerprint equals the stored `tokenFp` (any kind,
     legacy included): an untagged copy of an issued session, since an
     exchange always mints a new token → duplicate → merge scope only; never
     clears `tokenInvalid`, `failures` or `pairObtainedAt`.
   - access + refresh token:
     - `refreshFp` equals the stored or an alternate's → duplicate → merge
       scope.
     - Accept outright when: no record, legacy, `needsReauth`, unreadable,
       no stored refresh token (an exchange record without one is displaced,
       keeping its alternates), `source` ∈ {`migrate`, `legacy_exchange`}, or
       `source` ∈ {`refresh`, `import`} and `incoming.expires >=
       chainOriginExpires`.
     - `source === 'exchange'`: the later `expires` becomes current, the other
       refresh token goes to `alternates` (dedupe by fp, cap 5, newest first;
       over the cap the oldest by `expires` is dropped and reported).
     - Otherwise (an older exchange arriving late) → file it as an alternate.
     - Accepting: replace tokens, `source: 'exchange'`, `pairObtainedAt = now`,
       `chainOriginExpires = incoming.expires`; clear `tokenInvalid`,
       `needsReauth`, `failures`; keep alternates only when the displaced pair
       was itself an exchange (else clear).
   - access token, no refresh, no expires → an exchange with the flag off
     (legacy). After `legacyCutoff` → `ignored_stale` and report. Otherwise
     accept only over none / legacy / `needsReauth` / unreadable;
     `source: 'legacy_exchange'`, `pairObtainedAt = now`; report once.
   - access token + expires, no refresh → accept if `incoming.expires >
     record.expires` (or no record); drop the stored refresh token and
     alternates (that exchange retired them); report.
After an accept: set the alarm; write the registry marker if the record was
created (then re-check, §5).

Settling: the critical section decides from the record it reads. Only a
displace needs something computed before it: a copy of the current refresh
token sealed as an alternate (from the probe, or the incoming copy this
instance sealed when it made that token current). If neither matches the
current `refreshFp`, start over; after 5 attempts file the incoming refresh
token as an alternate instead (never throw). Unreadability comes from the
probe while `version` is unchanged; a record replaced since is readable (§5).

### 6.4 Applying a token outcome

- success: a `2xx` JSON with a non-empty `access_token`. `expires = now +
  expires_in` (finite > 0, else now + 30 min and report). For a refresh, the
  base is the earliest of `attemptSince` and `failures.ambiguousSince` when
  set (the replay may have returned the pair first issued then). A migration
  always dates from now: Shopify extends a replayed migration's access token.
  `refreshExpires = now + refresh_token_expires_in` (else now + 60 d). Missing
  `refresh_token` → keep the presented one, report, set `failures` so the alarm
  retries soon (its `ambiguousSince` counts `attemptSince` too). Missing
  `scope` → keep. `source` = refresh/migrate; `pairObtainedAt = now`; migrate
  also sets `chainOriginExpires` (from the now-based expiry). Clear
  `alternates`, `tokenInvalid`, `needsReauth`, `failures`, `attemptSince`.
  After a migration, delete the legacy KV keys (retried by the alarm while
  they remain).
- terminal (all presented tokens terminal): `needsReauth` with `credFp`; sealed
  fields **kept** (never served or presented, except the credFp retry); report
  a refresh terminal on an expiring pair (an anomaly — uninstall deletes the
  record first); migration terminals are logged only and delete the legacy KV
  keys (the record keeps the sealed token for the credFp retry).
- transient: keep everything; `failures` (count, `retryAt`, kind, code);
  ambiguous (timeout, fetch exception, `5xx`, unparseable `2xx`) sets
  `ambiguousSince` to the send time of the first ambiguous attempt.
- shop_unavailable, configuration: keep everything, long backoff.
Reporting: when `failures.kind:code` changes (stored in `failures.reported`),
on terminal anomalies, on unreadable (once per instance). Reports and logs carry
only kind, status, OAuth `error`, `x-request-id` and missing field names —
never bodies, tokens or request data. Every report is also a structured
`console.error` line.

### 6.5 Alarm

Never throws: the catch-all (the shell's, for configuration errors that keep
the core from being built, and the core's) counts consecutive failed runs in
`alarm-error`, re-arms with `1 m, 5 m, 30 m, 2 h, 6 h` by that count and reports
at most hourly by its `reportedAt`; both survive evictions, which happen
between most alarms. A successful run deletes it. Not re-armed if a destroy
landed during the run; if re-arming throws, rethrow. Schedule from the record,
never sooner than now + 1 min:
- `needsReauth` → `since + 90 d` (wipe like destroy).
- unreadable → now + 6 h.
- legacy → if `migrateLegacy`, `attemptSince` or `ambiguousSince` (finishing
  a migration Shopify may have processed is recovery, not a new migration):
  `max(failures.retryAt, pairObtainedAt + 5 min)`; else now + 1 d (re-check
  the switch).
- expiring → `failures.retryAt` if failing; else `attemptSince` if set (replay
  a call whose outcome was lost; an alarm joins one still in flight); else the
  earlier of `pairObtainedAt + KEEPALIVE_AGE`, `refreshExpires -
  KEEPALIVE_REMAINING`.
Handler: re-read; migrate / refresh / wipe; delete leftover legacy KV keys
unless the record is a live legacy token (a quarantined one counts as
non-legacy); write the registry marker; reschedule (re-checked, §5).

### 6.6 `importLegacy({ shop })`

Single flight (`importing` promise). Capture `version`; read
`legacyKv.get('offline_<shop>', 'json')`; critical section: re-read.
- Record exists → unless it is a live legacy token (legacy, not quarantined),
  delete the legacy KV keys; `already_present`.
- `version` moved → `none` (a destroy or exchange happened).
- KV absent → `none`. Unparseable or shop mismatch → delete keys, `invalid`.
- Store: legacy token → legacy record (`source: 'import'`, `pairObtainedAt =
  now`); expiring pair → `source: 'import'`, `chainOriginExpires = expires`;
  no access token but a live refresh token → expiring record with
  `tokenInvalid`; nothing usable → delete keys, `none`.
- Set the alarm, write the registry marker (re-checked, §5). Delete the KV
  keys unless the record is legacy (then they go after migration, or at once
  if the migration is rejected).
Remaining `offline_*` keys = shops not yet imported or on a live legacy token.

### 6.7 `destroy({ shop, uninstalledAt })`

1. Read. If `uninstalledAt`, `source !== 'import'` and `pairObtainedAt >
   uninstalledAt + 60 s` → `kept_newer_install`. A pair obtained from Shopify
   after the uninstall can only come from a reinstall (refreshes and
   migrations of revoked tokens fail); an import copies a token of unknown
   age, so it proves nothing.
2. Delete the legacy KV keys.
3. Critical section: re-read; re-check step 1 (a reinstall may have landed) —
   if kept, answer `kept_newer_install` (the marker was never touched).
   Otherwise `deleteAll()`, `deleteAlarm()` (explicit), bump `version`.
4. Delete the registry marker, only now, so a marker written by a creation
   racing the destroy can't outlive the record (that writer deletes it again
   on its re-check) → `deleted`. If this delete throws, the record is gone and
   a retried destroy finishes the cleanup.

### 6.8 Registry

`<prefix><shop>` in the registry KV, value `''`, metadata `{ since }`. Put when
a record is created and at the end of every alarm run (idempotent), each put
followed by the §5 re-check; deleted by destroy and the quarantine GC after
the record is gone. No state, no secrets.

### 6.9 `rollover({ shop, obtainedBefore })`

Replaces the shop's credentials now and waits for Shopify's answer. Loop, at
most 3 token calls started or joined:
- No record → `none`. Unreadable → `skipped(unreadable)`.
- Quarantined: under the current `credFp`, or nothing to call with →
  `needs_reauth { since, reason }`; under other credentials, retry the chain
  (as §6.2 does).
- `isCurrentPair`: not legacy, not quarantined, `source !== 'import'`,
  `pairObtainedAt >= obtainedBefore` → `current`. An import's
  `pairObtainedAt` is the import time, not Shopify's, so it never counts.
- No refresh token → `skipped(no_refresh_token)`. Legacy with the switch off
  and nothing outstanding → `skipped(migration_off)`: the switch gates
  migrations however they start.
- Otherwise `runTokenCall(intent, 'alarm', quarantined)`, ignoring backoff
  (an operator asked; failures still back off on the alarm schedule, so the
  alarm retries them). `success` → `rolled { source }`; `terminal` →
  `rejected { reason }`; `failed` → `failed { kind, code, retryAt }` from the
  stored failures; `joined`, `discarded`, `skipped` → look again (a pair
  obtained by someone else meanwhile answers `current`). After 3 rounds →
  `failed(transient, busy)`.

A success rewrites every field under the current key and drops the alternates,
so a rollover also reseals.

### 6.10 App-token fallback

With `appTokenKey` set, `getSession` with `caller: 'app'` answers with an
application-only token when the chain's answer would be `needs_reauth` (any
reason, including after a failed credFp retry) or `tokenless(token_endpoint)`.
`unreadable`, `legacy_unusable`, `import_failed` and `none` keep their answers;
`caller: 'library'` never gets one, so `authenticate.admin` exchanges and heals
the chain.

A shop without a record never gets one: after the import and backfill, a
missing record means uninstalled or never installed, and minting would create
records and markers for arbitrary domains.

- Serve `record.fallback`, read when serving (a 401 report may just have
  dropped it), while `expires - now` exceeds `min(minValidity, lifetime / 2)`,
  so a token shorter-lived than the caller asks for is still served; otherwise
  mint. A fallback minted under another
  signing `kid` (possibly revoked) or sealed under a dropped key counts as
  absent.
- Mint in its own single flight (`minting`), not `inflight`: it presents no
  refresh token, so rotation rules don't order it, and chain callers, the
  alarm and rollovers never join it. §6.1 steps 1 and 6 only: no
  `attemptSince`, no alarm, nothing about the chain changes. The mint carries
  the `version` the chain answered under and is discarded if it moved (before
  or after the call); every caller waiting on it, joined or not, then asks the
  chain again, and mints once more if the new answer still calls for it (at
  most two mints per request). The starter is answered from the mint itself.
  One `CALLER_WAIT` budget, started by a request's first wait for a token
  call, covers every wait in it; a mint the budget doesn't cover still
  finishes for the next caller.
- Store `{ ...record, fallback }` without bumping `version`, and add its
  fingerprint to `appTokenFps` (newest 48), which chain replacements carry
  over. Every write that
  replaces the chain's tokens builds a new record and so drops it; quarantine
  and failures keep it. `reportUnauthorized` with its `tokenFp`, and an
  issued write-back of it without a token (the library's 401 handling), drop
  it and hold minting for a minute; an issued write-back with a token, or an
  untagged copy of any token in `appTokenFps`, is a duplicate and is never
  stored as the chain. Destroy and the quarantine GC delete it.
  `expires` dates from the send (Shopify may return the token issued earlier
  that minute).
- Assertions are signed per attempt with `iat` 5 s back for clock skew.
  Classification by status only: `5xx`, `429`, `408`, network, timeout,
  challenge → transient; `402`, `404`, `423` → shop unavailable; other `4xx` → terminal
  (a bad assertion, a revoked key and an uninstalled shop look alike); redirect,
  bad shop, a signing failure → configuration.
- Failures answer as the chain would. Transient and shop unavailable hold
  minting in memory for `max(1 min, Retry-After)`, reported once per
  `kind:code` change and logged otherwise; so is a mint that never left (a
  key that can't sign, a bad shop). Terminal and configuration answers from
  Shopify store `mintRejected` and are reported (only logged if the chain
  changed meanwhile, discarding it): no mint under that `kid` before
  `retryAt`, 10 min after the first rejection and 4× longer for each repeat,
  up to a day, unless the chain is replaced (which drops the field) or a
  deploy changes the `kid`. A record without `retryAt` holds a day.
- A malformed `appTokenKey`, or one whose callback throws, turns the fallback
  off and is reported at most hourly per isolate; it never fails the chain's
  calls.
- `describe` shows `fallback: { kid, expires }` and `mintRejected`; the
  sealing key is in `kids`.

The private key alone gets tokens for every installed store; the chain has no
equivalent. It is opt-in, a Worker secret, and revoked in the Dev Dashboard on
a leak.

## 7. Fleet jobs

### 7.1 Backfill

`migrateLegacySessions({ kv, namespace, locationHint?, cursorKey?, maxShops?,
budgetMs?, concurrency? })`: lists `offline_*` from a persisted cursor (`limit =
maxShops - attempted`, budget checked between pages), calls `importLegacy`,
saves the cursor; a full pass clears it. Unroutable keys → `invalid`, deleted.
`done` only when a pass that started without a cursor saw zero `offline_` keys.
Returns `{ attempted, outcomes, done }`; reports once when a run is ≥ 80 %
`invalid`/`error` with ≥ 10 attempts (the statuses that mean a session could
not be imported; `none` is an ordinary answer). With migration off, live
legacy shops stay listed (`already_present`), so `done` waits for migration;
a rejected migration releases its keys at once.

### 7.2 Rollover sweep

`rolloverShops({ kv, namespace, registryPrefix?, locationHint?, requestKey?,
stateKey?, maxShops = 500, budgetMs = 4 min, concurrency = 8 })`, run from the
scheduled handler. Driven by a request an operator writes to the registry KV
(`shop-sessions:rollover`, JSON): `{ obtainedBefore: ISO | ms, stopAfter?,
concurrency? (1–50), halted? }`. No request → `idle` (one KV read). Invalid
(not an object, `obtainedBefore` unparseable or more than a minute ahead,
bad numbers) → report, `invalid_request`.

Pass state (`shop-sessions:rollover-state`): `{ obtainedBefore, startedAt,
attempted, outcomes, unrolled ≤ 1000, cursor?, completedAt? }`. A request
whose `obtainedBefore` differs from the state's, or whose pass completed,
starts a new pass. `halted` set → `halted`; `attempted >= stopAfter` →
`paused`.

A run lists registry markers from the cursor in pages of at most 100
(limited by `maxShops` and `stopAfter`), calls `rollover` per shop with the
pass's `obtainedBefore`, and advances the cursor only after a whole page
(state written at most every 2 s between pages; the final write retries once,
since KV refuses a second write to a key within a second). A page left
unfinished is redone next run: shops already done answer `current`. Stops:
- `failed(configuration)` ≥ 50 % of a run's ≥ 10 attempts → halt (0.2.0
  halted on the first one, and a closed store answers `403`);
- `failed(transient)` + `rejected` + thrown ≥ 50 % of a run's ≥ 10 attempts →
  halt, counted apart from configuration failures; `shop_unavailable` doesn't
  count;
- `http_429` → stop the run (`throttled`), resume next run;
- budget (between pages), `maxShops` → `running`; `stopAfter` → `paused`.

Halting reports and rewrites the request with `halted: <reason>`; writing the
request again without it resumes. A finished pass (`done`) deletes the request
and keeps the state with `completedAt`. `unrolled` holds each shop's latest
non-`rolled`/`current` answer with its code.

Uses: staged migration (§8); planned secret rotation (deploy the new secret,
sweep, revoke once nothing is unrolled); leaked storage or refresh tokens (two
passes: Shopify keeps a presented refresh token usable until its replacement
is presented, so the second pass retires the leaked ones); keyring rotation
(one pass reseals); after an emergency revoke (old refresh tokens survive the
revoke, §2, so a pass brings every live shop back).

### 7.3 Rotation workflow

`createRotateSecretsWorkflow({ registry, namespace, legacyKv?, locationHint?,
allowMyshopifyIo?, report? })` returns a `WorkflowEntrypoint` class; the flows
are `runRotation(params, step, deps)` in `src/rotation.ts`, with `step` and
`fatal` (`NonRetryableError`) injected. Params: `{ kind: 'keyring' |
'api-secret', canaryShop, stages? }`. Full design: `spec.secret-rotation.md`.

- Operators put secrets; the Workflow holds none, and no step output or event
  carries one. Each deploy is checked against a `before` snapshot of the
  canary's `describe().keyring.kids` / `credentials.credFp`: unchanged retries
  (propagation) then fails; any other unexpected shape fails at once.
- Lock `shop-sessions:rotation:<kind>:lock` in the registry KV (the instance
  id): one rotation per kind. A failed instance keeps it.
- Passes call `rolloverShops` directly, one bounded run per step, under
  `shop-sessions:rotation:<kind>:request` / `:state`, never the cron's keys.
  `running` → next run; `throttled` → sleep 5 min; `halted` → wait for
  `resume-<label>`, rewrite the request; `idle`/`invalid_request` → fail; at
  most 500 runs per pass.
- Keyring: `keyring-deployed` → live kids must be `[new, ...before]` →
  canary rolls and is sealed only under the new kid → sleep 90 days → census
  of every registry shop (`describe`, 200 per step) for kids other than the
  new one → roll those in `ok`/`failing` (50 per step); the rest, and any that
  didn't answer `rolled`/`current`, are stragglers (≤ 1000 listed plus the
  total) → keyring unchanged since → `approve-drop` → `keyring-dropped` → no
  dropped kid live, new kid live, canary not `unreadable`.
- API secret: stages strictly increasing positive integers (default
  `[10, 200]`, checked before the lock), then a full pass →
  `api-secret-deployed` → `credFp` changed → canary rolls (a configuration
  failure is fatal) → sleep 10 min → one cutoff for every stage →
  `approve-after-<n>` after each stage → stragglers: the final pass's
  `unrolled` minus `none`, counted per shop (not from `outcomes`, which count
  redone pages twice), and any `offline_*` key in `legacyKv` → if any,
  `ack-stragglers` → `api-secret-revoked` → canary rolls and is `ok`.
- Event waits time out after 7–30 days; a timeout fails the instance.
- `keyringRetention` (default `90 days`) shortens the keyring wait for staging
  rehearsals only. Both flows ran on a deployed staging Worker against a dev
  store (`scripts/staging`, spec "Verified").

## 8. App integration

- `wrangler.toml`: `SHOP_SESSIONS` binding at the top level and in every
  `[env.*]`; `[[migrations]] new_sqlite_classes = ["ShopSessions"]` under the
  next free tag; `[secrets] required = ["SHOPIFY_API_SECRET",
  "SHOPIFY_SESSION_ENCRYPTION_KEYS"]` at the top level and per env;
  `SHOP_SESSIONS_LEGACY_IMPORT` / `SHOP_SESSIONS_MIGRATE` vars and the
  `triggers` only in env blocks.
- Worker entry:
  ```ts
  export const ShopSessions = createShopSessionsDurableObject<Env>({ registry: env => ({ kv: env.SESSION }), legacyKv, migrateLegacy, report })
  ```
  optionally wrapped in `Sentry.instrumentDurableObjectWithSentry` with
  `enableRpcTracePropagation: true`. `scheduled` runs `rolloverShops`, and
  `migrateLegacySessions` while import is on.
- `shopify.server.ts`: `new DurableObjectSessionStorage({ namespace:
  env.SHOP_SESSIONS })`; `future.expiringOfflineAccessTokens: true`.
- Uninstall: verify the webhook HMAC without loading the session
  (`triggeredAt` from `X-Shopify-Triggered-At`), `deleteShop(shop, {
  uninstalledAt })`, and the app's own uninstall cleanup only on `deleted`.
  `shop/redact` leaves sessions alone (a leftover record quarantines itself at
  its next keepalive and is GC'd after 90 days).
- Rollout: put the keyring secret (escrowed) per env → deploy with import on,
  migration off → `describe` a test shop → backfill imports every shop → turn
  migration on → rollover pass in stages (`stopAfter` 1, 10, hundreds, all)
  → backfill until `done` → confirm no `offline_*` keys → remove the backfill
  and `legacyKv`; keep the trigger and `rolloverShops` in `scheduled`.
- Token readers (README adoption checklist): every raw token read →
  `loadOfflineSession` at the moment of use (clean up only on `none`);
  background 401 → `reportUnauthorized`; nothing persists access tokens;
  scope-update webhooks write through `shopify.sessionStorage`; fleet jobs list
  registry markers plus remaining `offline_*` until done; scripts that read KV
  directly go through an authenticated operator route. Switches on only in the
  deploy that ships all of it.

## 9. Testing

- Node: crypto, token client (every class, missing fields, HTML 5xx,
  `Retry-After`, redirects, host check, timeout, no secrets in reports),
  merge rules (each branch, issued vs library, alternates, chainOriginExpires),
  outcomes, schedules, cooldown, cutoff, quarantine + credFp retry,
  unreadable, version discards, import races (destroy, exchange, quarantine
  GC), destroy races (imports, marker writes, the alarm tail), lost outcomes
  (`attemptSince`), concurrent exchanges, alarm error state across instances,
  adapter mapping and tag/stripping, backfill, rollover (each answer,
  joining a call in flight, an exchange during the call, reseal) and the
  sweep (stages, cursor, budget, breaker, configuration halt, 429, resume,
  new passes, the final state write), the app-token fallback (each trigger
  and non-trigger, both callers, reuse and renewal, joins and discards,
  clearing, backoff and the terminal hold), the assertion signer (both
  algorithms and key forms, bad keys) and grant classification. The core
  harness fails a test that makes an unscripted token call or leaves a
  scripted one unused.
- Workers: additionally, the alarm backoff across evictions with a broken
  keyring, and a record sealed under a decrypt-only (older) key.
- Workers (`@cloudflare/vitest-plugin`, compat 2024-09-23 and current): fake
  Shopify with rotation rules; concurrent loads → one refresh; two exchanges in
  both arrival orders then a refresh → chain survives; alarm keepalive and
  migration; eviction mid-refresh; destroy during a fetch; import race; destroy
  clears the alarm at the old compat date; two rollover passes retire a
  presented refresh token; a sweep over real objects (expiring and legacy);
  the fallback against a fake that verifies assertions (secret revocation,
  renewal, a 401 report, an uninstalled shop, a revoked key); Sentry wrapper
  type test.

## Changes after code review

1. An imported record never counts as a reinstall: `destroy` ignores
   `pairObtainedAt` when `source` is `import` (§6.7).
2. A rejected legacy migration deletes the legacy KV keys; the alarm and
   `importLegacy` treat a quarantined legacy record as non-legacy, so remaining
   `offline_*` keys are unimported or live legacy shops and the backfill can
   reach `done` (§6.4–§6.7).
3. Markers and alarms written after a non-storage await are re-checked against
   the record; destroy and the quarantine GC delete the marker after the record
   (§5, §6.5, §6.7, §6.8).
4. A refresh-bearing exchange replaces a record without a refresh token instead
   of being filed under it (§6.3).
5. `putSession` decides inside the critical section and only starts over when a
   displace lacks a sealed copy of the current refresh token; after 5 attempts
   it files the incoming refresh token as an alternate. The alternates cap drops
   the oldest by `expires` and reports it (§6.3).
6. `attemptSince`: a durable pre-call marker (also the output-gate fence) that
   readers, the alarm and the refresh expiry base treat like `ambiguousSince`;
   a legacy reader joins a migration in flight; `describe` shows
   `attemptPending` (§5, §6.1, §6.2, §6.4, §6.5).
7. A migration success dates `expires` from now (Shopify extends a replayed
   migration's access token); the pessimistic base is for refreshes only (§6.4).
8. A failed lazy import answers `tokenless` (`import_failed`) instead of
   throwing from `getSession` (§4.1, §6.2).
9. The backfill's failure signal counts `invalid` and `error` only (§7).
10. The alarm's error backoff and report throttle live in storage
    (`alarm-error`), so evictions don't reset them; configuration errors are
    reported once per instance by RPC and under that throttle by the alarm (§4.2,
    §5, §6.5).
11. An untagged copy of the stored token (equal `tokenFp`, any kind) is a
    duplicate: scope merges, nothing else changes (§6.3).

## Changes in 0.2.0

1. `rollover({ shop, obtainedBefore })` on the object and the adapter (§6.9),
   and the `rolloverShops` sweep driven by a KV request, with stages, a
   cursor, a circuit breaker and a pass record (§7.2). The migration rollout
   uses it instead of waiting up to a day for each shop's alarm (§8).

## Changes in 0.2.1

1. The rollover sweep no longer halts a pass on its first configuration
   failure (§7.2). A staged migration in production halted on a closed
   store, which Shopify answers with a `403`, and every resume redid the same
   page and halted on it again. Configuration failures now halt only when they are
   half of a run of 10 or more, counted apart from rejections, so closed and
   uninstalled shops don't add up to a halt.

## Changes in 0.3.0 (unreleased)

1. Optional app-token fallback (§6.10): with `appTokenKey`, `loadOfflineSession`
   answers with an application-only token, `source: 'app_token'`, while the
   shop's chain can't produce one. The record gains `fallback`,
   `mintRejected` and `appTokenFps`; nothing else in stored data changes, and without the option
   behavior is unchanged.
2. `describe` reports the object's live configuration: `keyring.kids` (current
   first) and `credentials.credFp`. The optional rotation Workflow (§7.3,
   `./workflow`) checks deploys against them.
3. A refresh `401 invalid_grant` is terminal (§2), as `401 invalid_request` was.
