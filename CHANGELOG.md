# Changelog

## Unreleased

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
