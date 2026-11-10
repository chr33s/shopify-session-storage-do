# Changelog

## Unreleased

- Fix (app-token primary mode): an exchange no longer lifts a mint rejection,
  so a refused mint isn't retried on every admin load; a rejection holds
  10 min, 4× longer per repeat, up to a day (it was a fixed day), and a mint
  that never left (`sign_failed`) stores none; a held rejection still serves a
  valid cached token; a failed lazy legacy import answers `tokenless
(import_failed)`, not `none`; the install stub is no longer taken for a
  legacy record; the alarm wipes shops rejected or quarantined for 90 days;
  `appTokenFps` keeps 48 fingerprints; `invalidateAndRefresh` treats `''` as a
  failed token. In fallback mode, an app-token cache left by primary mode is
  never served to the library.
- Fix (rotation Workflow): the lock is read back after KV propagates, so of two
  rotations started together one fails; one shop that can't be described or
  rolled no longer fails the census or reseal; a retried reseal batch no longer
  rolls shops twice; `notRolled` is an exact count from a census.
- Removed the unused `AppTokenKeyConfig`, `EncryptionKeyEntry` and
  `DOSessionStorageConfig` types.

- Fix (app-token primary mode): a mint in flight during an uninstall's
  `destroy` no longer writes the record and marker back; a shop without a
  record is never minted for (no stub records); `minValidityMs` is honoured;
  a 401 write-back (tagged or untagged) of an older app token no longer evicts
  the current one; `invalidateAndRefresh` honours the stored rejection and the
  backoff, reports the failure's own `kind` and `code`, and fingerprints
  outside the critical section; mints are no longer retried on `429`, `408`,
  challenges or `Retry-After`; a short-lived token is no longer reminted on
  every request; `rollover` remints the cache (`source: 'app_token'`), so the
  rotation Workflow's canary and reseal work; the alarm takes back a marker for
  a record destroyed meanwhile; re-encryption runs under `waitUntil`; the
  registry marker is put on the first cache only.

- Optional secret-rotation Workflow, `createRotateSecretsWorkflow` from the new
  `./workflow` entry. It rotates the keyring or the Shopify client secret as one
  durable, gated process. Operators put the secrets; the Workflow checks each
  deploy, runs staged rollover passes under its own keys, reports stragglers,
  and waits for an explicit event before the drop or the revoke. See README
  "Rotating secrets with a Workflow".
- `describe` also reports the object's live configuration: `keyring.kids`
  (current first) and `credentials.credFp`. Neither is secret.

- Fix: a dead refresh token now quarantines the shop. Shopify answers it with
  `401 invalid_grant`, which was classified as a configuration failure (backoff,
  never quarantined, and counted toward a rollover halt); only
  `401 invalid_request` was terminal. Both are terminal now. Wrong client
  credentials answer `400`, so they stay configuration failures. Found by the
  new `scripts/rehearsal` checks against a live store.

- Optional app-token fallback. With the new `appTokenKey` option on
  `createShopSessionsDurableObject`, `loadOfflineSession` answers with an
  application-only access token (`source: 'app_token'`) while the shop's
  refresh-token chain can't produce one: after Shopify rejects it, after an
  emergency secret revocation, or while the token endpoint is down with no
  token left. The token is minted with a JWT signed by the app's own key, not
  the client secret. `loadSession` never gets one, so the library still
  exchanges and heals the chain. Records gain optional `fallback`,
  `mintRejected` and `appTokenFps` fields; without the option nothing changes.

- App-token primary mode. With `appTokenMode: 'primary'` (and `appTokenKey`),
  each shop's Durable Object is an ephemeral application-only token cache:
  `loadSession` mints via `client_credentials` + JWT assertion, renews with
  3–8 minute jitter (`renewAfter`), retries transient mint failures, and
  exposes `invalidateAndRefresh` for Admin API 401 recovery. The client secret
  is optional in this mode. Legacy refresh-token rows are ignored and
  overwritten on the next load. See DESIGN.md §6.11.

- Documentation for public use: a security model, an adoption checklist, a
  setup without Sentry, and guidance for apps that aren't migrating from
  `KVSessionStorage`.
- Test fixtures no longer have the shape of real Shopify tokens.
- 0.2.1 is the last version on npm. This repository is now shared as is.

## 0.2.1 (2026-10-26)

- The rollover sweep no longer halts a pass on its first configuration failure.
  Shopify answers a closed store's token call with `403`, which counts as a
  configuration failure, so every resume halted on the same shop again.
  Configuration failures now halt a pass only when they are half of a run of 10
  or more, counted apart from rejections.

## 0.2.0 (2026-10-26)

- `rollover(shop, { obtainedBefore })` on the storage and the Durable Object
  replaces a shop's credentials now: a refresh for an expiring pair, or a
  migration for a legacy token when migration is on. Every field is resealed
  under the current key.
- `rolloverShops` sweeps every shop from the scheduled handler when an operator
  writes a request to the registry KV. Passes can be staged with `stopAfter`,
  resume where they stopped, halt behind a circuit breaker and keep a record of
  each shop that didn't roll.
- No stored data changes.

## 0.1.1 (2026-10-23)

- No changes to the package. The first release published from CI with npm
  trusted publishing.

## 0.1.0 (2026-10-23)

- First release: `DurableObjectSessionStorage`,
  `createShopSessionsDurableObject`, `migrateLegacySessions` and
  `validateKeyring`.
