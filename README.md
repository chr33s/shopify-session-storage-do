# @optizio/shopify-session-storage-do

Shopify session storage for Cloudflare Workers that keeps each shop's offline
session in its own Durable Object. The object is the only thing that refreshes
or upgrades the shop's token, it absorbs the token exchanges the Shopify library
makes on its own, and it never hands the refresh token out, so Shopify's
rotation rules hold per shop. It is a drop-in `sessionStorage` for
`@shopify/shopify-app-react-router` 3.x; the library is used unchanged.

**Shared as is.** Optizio's Shopify apps run this code in production. We develop
it in a private repository and share it here for anyone it helps; see
[Status](#status).

## Why

- **Strong consistency, one token call at a time.** Every isolate talks to the
  same object for a shop, and concurrent loads share one refresh. KV is
  eventually consistent, so an isolate can read a refresh token that a refresh
  elsewhere already retired.
- **The refresh token never leaves the object.** The library and app code only
  ever get access tokens, so nothing can refresh behind the object's back and
  no refresh token reaches app code, logs or the library.
- **The library's exchanges don't break the chain.** Admin requests still do
  uncoordinated token exchanges, and each one retires the shop's other refresh
  tokens. The object keeps the pair with the later expiry and files the losing
  refresh tokens (up to 5) as alternates to try if the current one is rejected.
- **Alarms keep idle shops alive.** Refresh tokens last 90 days and renew on
  use. An alarm refreshes 30 days after a pair was obtained or 30 days before
  its refresh token expires, whichever comes first, so a shop nobody opens
  doesn't fall into reauth.
- **Legacy tokens are upgraded.** Non-expiring tokens are imported from the old
  KV storage on first use or by a backfill, and the alarm migrates them to
  expiring pairs behind a per-environment switch. From 2027-01-01 Shopify
  answers legacy tokens with 403.
- **Rollovers on demand.** An operator request makes every shop refresh (or
  migrate) now, in stages, behind a circuit breaker: for the legacy migration,
  a client-secret rotation, a keyring rotation or leaked tokens.
- **One bad response never destroys credentials.** Terminal answers quarantine
  the tokens (kept, never served) instead of deleting them; a quarantine is
  retried when credentials change and wiped after 90 days.
- **Encrypted at rest.** AES-256-GCM under a rotatable keyring, each value bound
  to its shop and field. A record that can't be decrypted degrades to a token
  exchange, not an outage.
- **A registry of installed shops.** Durable Object namespaces can't be listed,
  so each object keeps a marker in KV for fleet jobs.

## Security model

- **Every Worker that can bind the namespace is trusted.** RPC calls to the
  object aren't authenticated: any Worker in the Cloudflare account with a
  binding to it can load any shop's access token. Bind it only from the app's
  own Workers.
- **Encryption protects storage, not callers.** Tokens are sealed before they
  reach Durable Object storage, so someone who can read storage (Data Studio,
  point-in-time recovery, a debug route that dumps it) but can't run code with
  the keyring sees no tokens. Code that holds the keyring can read every token.
- **The refresh token never leaves the object**, and access tokens go only to
  callers of the adapter.
- **Nothing secret is logged or reported:** no tokens, refresh tokens, client
  secret, response bodies or request data.
- **The app token key, if you configure one, reaches every shop.** Whoever
  holds it can get a token for every store that installed the app, with no
  refresh token needed. Leaving `appTokenKey` unset keeps it out of the
  picture; see [App-token fallback](#app-token-fallback).

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Installation

```bash
pnpm add @optizio/shopify-session-storage-do
```

That installs 0.2.1, the last version on npm, whose source is the `src` folder
here.

Requirements:

- **`@shopify/shopify-app-react-router` 3.x with
  `future.expiringOfflineAccessTokens: true`.** Mandatory. Without the flag the
  library exchanges for non-expiring tokens, which the object accepts only when
  it holds nothing better, reports, and stops serving after 2027-01-01. With
  the flag off, a legacy token the object has stopped serving (after a 401 or
  a migration whose answer was lost) can only be replaced by a _different_
  token, so if Shopify answers a flag-off exchange with the same one, the
  admin keeps exchanging. Turn the flag on before adopting the package.
- **`@shopify/shopify-api` ^15** (peer dependency).
- **Workers with `nodejs_compat`.** Old compatibility dates work: the object
  deletes its alarm explicitly and returns expected outcomes as values rather
  than errors, so it doesn't rely on newer runtime behaviour. It is tested at
  `2024-09-23` and a current date (RPC needs `2024-04-03` or later).

There are no runtime dependencies. The package has three entry points. `.`
(the storage adapter, the backfill, `validateKeyring` and types) never imports
`cloudflare:workers`, so `shopify.server.ts` and Node tests can load it.
`./durable-object` holds the Durable Object, and `./workflow` holds the optional
[rotation Workflow](#rotating-secrets-with-a-workflow); only the Worker entry
imports them.

## Usage

### `wrangler.toml`

`durable_objects`, `vars` and `secrets` are not inherited by `[env.*]` blocks,
so the binding and the required secrets go at the top level (local dev) and in
every environment. `migrations` and `triggers` are inherited, which is why the
trigger lives only in env blocks. Keeping the switches out of the top
level also means local dev never imports or migrates.

```toml
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "SHOP_SESSIONS"
class_name = "ShopSessions"

[[migrations]]
tag = "v1" # the next free tag if the Worker already has migrations
new_sqlite_classes = ["ShopSessions"]

[secrets]
required = ["SHOPIFY_API_SECRET", "SHOPIFY_SESSION_ENCRYPTION_KEYS"]

# Repeat everything below for [env.preview].
[[env.production.durable_objects.bindings]]
name = "SHOP_SESSIONS"
class_name = "ShopSessions"

[env.production.secrets]
required = ["SHOPIFY_API_SECRET", "SHOPIFY_SESSION_ENCRYPTION_KEYS"]

[env.production.vars]
SHOP_SESSIONS_LEGACY_IMPORT = "on" # only while migrating from KVSessionStorage
SHOP_SESSIONS_MIGRATE = "off"

[env.production.triggers]
crons = ["*/5 * * * *"] # rollover requests (keep it), and the legacy backfill until it reports done
```

The `class_name` and the migration tag are permanent (renaming needs
`renamed_classes`). `ShopSessions` is your export, so the package can't rename
it under you.

`SESSION` is the KV namespace the app's `KVSessionStorage` used; the registry markers
and rollover requests live there too. **Not migrating from
`KVSessionStorage`?** Bind any KV namespace and leave out both vars,
`legacyKv`, `migrateLegacy` and the backfill. Keep the trigger and
`rolloverShops`.

### Worker entry

```ts
import { migrateLegacySessions, rolloverShops } from '@optizio/shopify-session-storage-do'
import { createShopSessionsDurableObject } from '@optizio/shopify-session-storage-do/durable-object'

export const ShopSessions = createShopSessionsDurableObject<Env>({
  registry: (env) => ({ kv: env.SESSION }),
  legacyKv: (env) => (env.SHOP_SESSIONS_LEGACY_IMPORT === 'on' ? env.SESSION : undefined),
  migrateLegacy: (env) => env.SHOP_SESSIONS_MIGRATE === 'on',
  // Optional: every report is also logged with console.error.
  report: (error, context) => reportError(error, context),
})

export default {
  fetch: handleRequest,
  async scheduled(_controller, env) {
    await Promise.all([
      // Idle (one KV read) unless an operator wrote a request; see Rolling over credentials.
      rolloverShops({ kv: env.SESSION, namespace: env.SHOP_SESSIONS }).then((result) => {
        if (result.status !== 'idle') console.log(JSON.stringify({ rollover: result }))
      }),
      env.SHOP_SESSIONS_LEGACY_IMPORT === 'on' &&
        migrateLegacySessions({ kv: env.SESSION, namespace: env.SHOP_SESSIONS }).then((result) => {
          console.log(JSON.stringify({ backfill: result }))
        }),
    ])
  },
} satisfies ExportedHandler<Env>
```

With Sentry, wrap the class and the handler:

```ts
import * as Sentry from '@sentry/cloudflare'

export const ShopSessions = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({ dsn: env.SENTRY_DSN, enableRpcTracePropagation: true }),
  createShopSessionsDurableObject<Env>({
    // ...the options above
    report: (error) => Sentry.captureException(error),
  }),
)

export default Sentry.withSentry((env: Env) => ({ dsn: env.SENTRY_DSN }), {
  // ...the handlers above
} satisfies ExportedHandler<Env>)
```

**`enableRpcTracePropagation` belongs on the object's side.** It is what makes
Sentry capture errors thrown by RPC methods. Don't set it in the Worker's
`withSentry` options: there it adds an argument to every RPC call on every
binding. Use `rpcTracePropagationBindings: ['SHOP_SESSIONS']` if you want
linked traces. Node tests that import the Worker entry need
`cloudflare:workers` stubbed and `instrumentDurableObjectWithSentry` in their
Sentry mock.

### `shopify.server.ts`

```ts
import { DurableObjectSessionStorage } from '@optizio/shopify-session-storage-do'

const shopify = shopifyApp({
  // ...
  sessionStorage: new DurableObjectSessionStorage({ namespace: env.SHOP_SESSIONS }),
  future: { expiringOfflineAccessTokens: true },
})
```

`shopify.sessionStorage` keeps the adapter's type, so the extra methods below
are available on it.

### Uninstall

```ts
// Verify the HMAC without loading the session (your own helper), so cleanup never
// depends on token state. triggeredAt comes from X-Shopify-Triggered-At.
const { topic, shop, triggeredAt } = await verifyWebhookWithoutSession(request)
if (topic === 'APP_UNINSTALLED') {
  const { status } = await shopify.sessionStorage.deleteShop(shop, { uninstalledAt: triggeredAt })
  if (status === 'deleted') await markAppUninstalled(shop)
  return new Response()
}
```

`deleteShop` wipes the record, its alarm, the registry marker and any legacy KV
keys. **Run the app's own uninstall side effects only on `deleted`.**
`kept_newer_install` means the object holds a pair obtained from Shopify more
than 60 s after `uninstalledAt`, which only a reinstall can produce, so a late
webhook must not undo it. A legacy session imported after the uninstall
doesn't count: it is deleted. Without `uninstalledAt` it always deletes. `shop/redact`
should leave sessions alone; a leftover record quarantines itself at its next
keepalive and is wiped after 90 days.

### Background code

Jobs, queues and alarms that call the Admin API with a raw token should load it
at the moment of use and never persist it:

```ts
const result = await shopify.sessionStorage.loadOfflineSession(shop, { minValidityMs: 20 * 60_000 })
switch (result.status) {
  case 'ok': {
    const response = await adminGraphql(shop, result.session.accessToken!, query)
    if (response.status === 401) await shopify.sessionStorage.reportUnauthorized(result.session)
    break
  }
  case 'none': // not installed: the only answer that justifies cleaning up
    await forgetShop(shop)
    break
  case 'needs_reauth': // installed, but only the merchant opening the app fixes it
  case 'unavailable': // token endpoint down, unreadable record, unusable legacy token, or legacy KV down
    await retryLater(shop, result.status === 'unavailable' ? result.retryAfterMs : undefined)
}
```

With the [app-token fallback](#app-token-fallback) on, `ok` can also carry
`source: 'app_token'`: an application-only token, served while the shop's own
chain can't produce one. It is used the same way, including
`reportUnauthorized` on a 401.

- **`minValidityMs`** is how long the token must stay valid; the object clamps
  it to 6–40 minutes (default 6) and refreshes first when needed, making the
  caller wait at most 3 s. Reload between batches for longer jobs.
- **`reportUnauthorized(session)`** tells the object that Shopify answered 401
  to a token it issued; the next load refreshes. It throws for a session that
  didn't come from this storage. `authenticate.admin` doesn't need it: its
  401 handling already writes the session back through `storeSession`.
- **Write back the session object you loaded, not a copy.** Each issued session
  carries a non-enumerable tag under
  `Symbol.for('@optizio/shopify-session-storage-do')` holding the token's
  fingerprint. It lets the object tell a write-back (a scope update, a 401) from
  a new exchange, and nothing persists it.

### App-token fallback

Optional. When the shop's refresh-token chain can't produce a token (Shopify
rejected it, an emergency secret revocation, the token endpoint down with no
token left), `loadOfflineSession` answers with an
[application-only access token][app-only] instead, so webhooks and jobs keep
running until the merchant opens the app again. It is minted with a JWT signed
by your own key, not the client secret, so a revoked secret doesn't stop it.

- Only `loadOfflineSession` gets it. `loadSession` (the library) still sees
  `needs_reauth` or `tokenless`, so `authenticate.admin` exchanges and heals
  the chain. A webhook handler's `admin` client comes from `loadSession`, so
  it doesn't fall back; handlers that should keep working load the token with
  `loadOfflineSession` instead.
- It never replaces or resets the chain, even when app code writes it (or an
  earlier one) back through `storeSession`. It is stored next to the chain,
  sealed like every token, and reused until it has less than `minValidityMs`
  left (a token that never lived that long: for the first half of its life).
  The next exchange or refresh drops it, as do a 401 (`reportUnauthorized`, or
  the library's own write-back, after which minting waits a minute), a new
  signing key, and delete.
- One mint at a time per shop. Mints never hold up refreshes, and a load
  still waits at most 3 s for token calls in all. A failed mint answers as the
  chain would: after a transient failure the object waits a minute (or
  `Retry-After`); after a rejection (a bad or revoked key, an uninstalled
  shop) it stops for 10 minutes, then longer while it repeats (up to a day),
  or until the key or the chain changes.
- Never for a shop without a record: nothing is minted for unknown domains.
- Shopify allows it for apps with public distribution on stores that
  installed them.

Setup:

```sh
# An ES256 key pair (RS256 with 2048–8192 bits works too).
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out app-token-key.pem
# The public JWK to add in the Dev Dashboard (Settings > Credentials > Public keys).
node -e "const k=require('crypto').createPublicKey(require('fs').readFileSync('app-token-key.pem')).export({format:'jwk'});console.log(JSON.stringify({...k,kid:'app-key-1',alg:'ES256',use:'sig'}))"
wrangler secret put SHOPIFY_APP_TOKEN_KEY < app-token-key.pem   # per env; escrow it like the keyring
```

```ts
export const ShopSessions = createShopSessionsDurableObject<Env>({
  registry: (env) => ({ kv: env.SESSION }),
  appTokenKey: (env) =>
    env.SHOPIFY_APP_TOKEN_KEY ? { kid: 'app-key-1', alg: 'ES256', privateKey: env.SHOPIFY_APP_TOKEN_KEY } : undefined,
})
```

A malformed key, or an `appTokenKey(env)` that throws, is reported
(`app_token_key`, at most hourly per isolate) and turns the fallback off; the
chain carries on. To rotate the key, add the new public JWK (Shopify allows two), deploy
the new `kid`, wait an hour for tokens minted under the old one to expire, then
revoke the old key. If the private key leaks, revoke it in the Dev Dashboard:
that ends every token minted with it.

### App-token primary mode

To replace offline refresh tokens entirely with [application-only access
tokens][app-only], set `appTokenMode: 'primary'` alongside `appTokenKey`. Each
shop's Durable Object becomes a read-through cache with a 3–8 minute pre-expiry
renew window (`renewAfter`), single-flight minting, and transient retries. The
client secret is optional in this mode. Legacy refresh-token rows are ignored
and overwritten on the next `loadSession`.

```ts
export const ShopSessions = createShopSessionsDurableObject<Env>({
  registry: (env) => ({ kv: env.SESSION }),
  appTokenMode: 'primary',
  appTokenKey: (env) => ({ kid: 'app-key-1', alg: 'ES256', privateKey: env.SHOPIFY_APP_TOKEN_KEY }),
  // apiSecretKey optional here (still useful for webhook HMAC / online tokens in the app).
})
```

After an Admin API `401`, call `sessionStorage.invalidateAndRefresh(shop, tokenUsed)`
once and replay the request on `refreshed` or `ignored_stale` (another request
already replaced the token); on `failed`, don't replay. A shop with no record
(uninstalled, never installed) is never minted for: `loadOfflineSession`
answers `none`. `rollover` remints the cache, so the rotation Workflow works
in this mode too. Set `strictSigningKid: true` to remint immediately
when you deploy a new signing `kid`. See DESIGN.md §6.11.

[app-only]: https://shopify.dev/docs/apps/build/authentication-authorization/application-only-access-tokens

### What the library sees

| Object's answer        | `loadSession` returns                                                    | Admin requests | Webhooks, `unauthenticated.admin`                                              |
| ---------------------- | ------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------ |
| `ok`                   | Session with `accessToken`, `scope`, `expires` (none for a legacy token) | use it         | use it                                                                         |
| `none`, `needs_reauth` | `undefined`                                                              | token exchange | no session                                                                     |
| `tokenless`            | Session without `accessToken`                                            | token exchange | Admin queries throw (500, Shopify retries the webhook); other handlers succeed |

The object refreshes before serving a token with less than 6 minutes left,
more than the library's 5-minute window, so the library doesn't exchange while
the object can supply a fresh token.
`tokenless` covers a token endpoint that is down with no usable token left, a
record that can't be decrypted, a legacy token that is no longer usable (or
may have been retired by a migration whose answer is unknown), and a legacy KV
read that failed while importing a shop with no record (`import_failed`).

**The refresh token is never returned.** The library's background flows refresh
only when the session has a refresh token; without one they use it as is, which
leaves the object as the only refresher. `storeSession` forwards the session as
a plain object, then deletes `refreshToken` and `refreshTokenExpires` from the
caller's `Session`, even if the write failed. Shopify's `EXPIRING_OFFLINE_TOKEN`
app security check asks for the flag and for storage that persists expiry and
refresh metadata; this storage persists both, encrypted, in the Durable Object.
(How the check's automated scan treats custom adapters isn't documented.)

## Configuration reference

### `createShopSessionsDurableObject<Env>(options)`

Returns a class (`new (ctx, env)`, extending `DurableObject`) to export from
the Worker entry. Every option that takes `env` is read from the host Worker's
bindings, since a Durable Object receives nothing else.

| Option                   | Default                               | Notes                                                                                                                                 |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `registry(env)`          | required                              | `{ kv, prefix? }`: KV namespace for registry markers; `prefix` defaults to `'shop-session:'`                                          |
| `apiKey(env)`            | `env.SHOPIFY_API_KEY`                 | throws when empty                                                                                                                     |
| `apiSecretKey(env)`      | `env.SHOPIFY_API_SECRET`              | throws when empty (optional when `appTokenMode` is `primary`)                                                                         |
| `encryptionKeys(env)`    | `env.SHOPIFY_SESSION_ENCRYPTION_KEYS` | malformed: every call throws                                                                                                          |
| `legacyKv(env)`          | none                                  | KV holding `offline_<shop>` sessions from `KVSessionStorage`; `undefined` turns import off                                            |
| `migrateLegacy(env)`     | `false`                               | upgrade legacy tokens; read each time an alarm runs                                                                                   |
| `legacyCutoff`           | `Date.UTC(2027, 0, 1)`                | from then on legacy tokens aren't served and legacy exchanges are ignored                                                             |
| `appTokenKey(env)`       | none                                  | `{ kid, alg: 'ES256' \| 'RS256', privateKey }` (PKCS#8 PEM or private JWK); see [App-token fallback](#app-token-fallback)             |
| `appTokenMode`           | `'fallback'`                          | `'primary'` makes offline sessions an app-token cache; requires `appTokenKey` (see [App-token primary mode](#app-token-primary-mode)) |
| `strictSigningKid`       | `false`                               | primary mode: remint when the cached `signingKid` differs from the configured key                                                     |
| `allowMyshopifyIo`       | `false`                               | accept `*.myshopify.io`; must match the adapter and backfill                                                                          |
| `report(error, context)` | none                                  | receives a `ShopSessionError`; the log line is written either way                                                                     |
| `fetch`, `now`           | globals                               | for tests                                                                                                                             |

The object's RPC methods (`getSession`, `putSession`, `reportUnauthorized`,
`invalidateAndRefresh`, `destroy`, `importLegacy`, `describe`) take a canonical
`shop` that must match the object's name. Go through the adapter rather than
calling them directly.

### `new DurableObjectSessionStorage(options)`

| Option             | Default  | Notes                                                                                                   |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `namespace`        | required | the `SHOP_SESSIONS` binding                                                                             |
| `locationHint`     | `'enam'` | eastern North America; the first access fixes an object's location, so use one value at every call site |
| `allowMyshopifyIo` | `false`  | must match the Durable Object                                                                           |

| Method                                           | Does                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `loadSession(id)`, `storeSession(session)`       | the library's interface (offline ids `offline_<shop>` only)                                                             |
| `loadOfflineSession(shop, { minValidityMs? })`   | `ok` (`source?: 'app_token'`) / `none` / `needs_reauth` (`since`, `reason`) / `unavailable` (`reason`, `retryAfterMs?`) |
| `invalidateAndRefresh(shop, failedAccessToken?)` | primary mode: `refreshed` / `ignored_stale` / `failed`; remint after an Admin API 401                                   |
| `reportUnauthorized(session)`                    | background 401 on an issued session                                                                                     |
| `deleteShop(shop, { uninstalledAt? })`           | `deleted` or `kept_newer_install`                                                                                       |
| `rollover(shop, { obtainedBefore })`             | replace the shop's credentials now, see [Rolling over](#rolling-over-credentials)                                       |
| `describe(shop)`                                 | non-secret status, see [Debugging](#debugging-with-describe)                                                            |
| `deleteSession(id)`, `deleteSessions(ids)`       | delete without the reinstall guard                                                                                      |
| `findSessionsByShop(shop)`                       | `[session]` when it has an access token, else `[]`                                                                      |

RPC infrastructure errors marked retryable are retried once with a fresh stub.

### `migrateLegacySessions(options)`

| Option             | Default                           | Notes                                                                                |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------------ |
| `kv`               | required                          | KV holding the legacy sessions; the cursor is stored there too                       |
| `namespace`        | required                          | the `SHOP_SESSIONS` binding                                                          |
| `locationHint`     | `'enam'`                          | must match the adapter                                                               |
| `cursorKey`        | `'shop-sessions:backfill-cursor'` |                                                                                      |
| `maxShops`         | `200`                             | shops attempted per run                                                              |
| `budgetMs`         | `300000`                          | wall-clock budget, checked between list pages                                        |
| `concurrency`      | `4`                               | concurrent imports                                                                   |
| `allowMyshopifyIo` | `false`                           | must match, or `*.myshopify.io` keys are deleted as unroutable                       |
| `report(error)`    | `console.error`                   | called when at least 80 % of a run of 10 or more shops failed (`invalid` or `error`) |

Returns `{ attempted, outcomes, done }`. `outcomes` counts `imported`,
`already_present`, `none`, `invalid` (unparseable or unroutable keys, deleted)
and `error`. `done` is true only when a pass that started at the beginning of
the keyspace found no `offline_` keys.

### `rolloverShops(options)`

| Option             | Default                          | Notes                                                                    |
| ------------------ | -------------------------------- | ------------------------------------------------------------------------ |
| `kv`               | required                         | the registry KV; the request and the pass state are stored there too     |
| `namespace`        | required                         | the `SHOP_SESSIONS` binding                                              |
| `registryPrefix`   | `'shop-session:'`                | must match the Durable Object's `registry` prefix                        |
| `locationHint`     | `'enam'`                         | must match the adapter                                                   |
| `requestKey`       | `'shop-sessions:rollover'`       | where an operator writes the request                                     |
| `stateKey`         | `'shop-sessions:rollover-state'` | the pass so far, kept after it finishes                                  |
| `maxShops`         | `500`                            | shops attempted per run; keep it within the plan's subrequest limit      |
| `budgetMs`         | `240000`                         | wall-clock budget, checked between list pages; keep it under the trigger |
| `concurrency`      | `8`                              | concurrent rollovers; the request's `concurrency` overrides it           |
| `allowMyshopifyIo` | `false`                          | must match the Durable Object                                            |
| `report(error)`    | `console.error`                  | called for an invalid request and when the sweep halts a pass            |

Returns `{ status, attempted, outcomes, pass? }`. `status` is `idle`,
`invalid_request`, `running`, `paused`, `throttled`, `halted` or `done`;
`attempted` and `outcomes` are this run's, `pass` the pass so far.

### Environment

| Name                              | Kind   |                                                                  |
| --------------------------------- | ------ | ---------------------------------------------------------------- |
| `SHOPIFY_API_KEY`                 | var    | the app's client id                                              |
| `SHOPIFY_API_SECRET`              | secret | the app's client secret                                          |
| `SHOPIFY_SESSION_ENCRYPTION_KEYS` | secret | comma-separated base64 keys of 32 bytes, distinct, current first |
| `SHOPIFY_APP_TOKEN_KEY`           | secret | optional; any name, read by your `appTokenKey(env)`              |

## Operations

### Encryption keys

Generate a key with `openssl rand -base64 32`. **Escrow it in a password
manager before `wrangler secret put`**: Cloudflare secrets are write-only, and
without the key every record is unreadable until each merchant opens the app.
Set it per environment:

```bash
pnpm exec wrangler secret put SHOPIFY_SESSION_ENCRYPTION_KEYS --env production
```

`validateKeyring(value)` returns `{ ok: true, count }` or `{ ok: false, error }`
for deploy checks; its errors name entries by position and never contain key
material.

### Rotating keys

1. Generate and escrow a new key.
2. Put `new,old` in **one** secret update. Each `wrangler secret put` deploys at
   once, which is why the keyring is a single secret.
3. New writes seal under the new key; existing values keep their key id and
   stay readable. Records are resealed as tokens are rewritten: live shops at
   least every 30 days through the keepalive, quarantines are wiped within 90.
   Legacy shops and shops that keep failing to refresh (a frozen store, say)
   keep the old key until they succeed. A [rollover](#rolling-over-credentials)
   pass reseals every live shop at once.
4. **Keep old keys for at least 90 days.** `describe(shop).kids` lists the keys
   a record still uses; describe the shops in the registry before removing
   one.

The [rotation Workflow](#rotating-secrets-with-a-workflow) runs these steps,
including the 90-day wait and the check before the drop.

A record sealed under a removed key is not deleted: it answers `tokenless` to
the library (the next admin request exchanges and replaces it) and
`unavailable('unreadable')` to background code. Putting the key back fixes it.

### Migrating legacy sessions

1. Put the keyring secret (escrowed) in each environment.
2. Deploy with `SHOP_SESSIONS_LEGACY_IMPORT = "on"` and
   `SHOP_SESSIONS_MIGRATE = "off"`. Shops are imported on first use and by the
   backfill; legacy tokens keep being served.
3. `describe` a test shop: `exists: true`, `state` `legacy` or `ok`, `kids`
   holding the current key.
4. Let the backfill import every shop: each run's `outcomes` turn to
   `already_present` once every remaining key belongs to an imported legacy
   shop.
5. Turn `SHOP_SESSIONS_MIGRATE` on and migrate in stages with a
   [rollover](#rolling-over-credentials) pass: `stopAfter` 1, then 10, then a
   few hundred, then without it. Between stages check the pass state
   (`outcomes`, `unrolled`) and that the app still loads. A migrated shop's
   `offline_` and `shop:` keys are deleted. Without a pass, each legacy shop
   still migrates at its next alarm, within a day.
6. Let the backfill run until it reports `done: true`. With migration off,
   legacy shops stay listed, so `done` waits for step 5.
7. Confirm no keys are left:
   `pnpm exec wrangler kv key list --binding SESSION --prefix offline_ --env production --remote`.
8. Remove the backfill from `scheduled`, the `legacyKv` option and both vars.
   Keep the trigger for rollovers.

Remaining `offline_*` keys are shops not yet imported or still on a live
legacy token (a rejected migration deletes them). Turn the switches on only in the deploy that also moves every raw KV
token reader to this storage, since imports delete the keys those readers use.

### Rolling over credentials

A rollover replaces each shop's credentials now instead of waiting for its
alarm: a refresh for an expiring pair, a migration for a legacy token (only
with `SHOP_SESSIONS_MIGRATE` on). Every field is resealed under the current
key, and the alarm's backoff is ignored because an operator asked. Pairs
obtained from Shopify at or after the request's `obtainedBefore` are current
and left alone, so a pass can stop and resume anywhere, and running it again
only retries the shops that didn't roll.

Start a pass by writing a request; the next scheduled run picks it up (the
trigger's interval is the wait):

```bash
pnpm exec wrangler kv key put --binding SESSION --env production --remote \
  shop-sessions:rollover '{"obtainedBefore":"2026-10-27T10:00:00Z","stopAfter":10}'
pnpm exec wrangler kv key get --binding SESSION --env production --remote shop-sessions:rollover-state
```

| Request field    | Meaning                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `obtainedBefore` | ISO time or ms epoch, not in the future: credentials obtained before it are replaced      |
| `stopAfter`      | pause once the pass has attempted this many shops; raise it to carry on                   |
| `concurrency`    | 1 to 50 concurrent rollovers                                                              |
| `halted`         | written by the sweep when it halts the pass; write the request again without it to resume |

Each run attempts up to `maxShops` shops and saves its place. The sweep
**halts the pass** when half of a run of 10 or more shops failed with a
configuration error (a wrong client id or secret fails every shop), or when
half of such a run failed, was rejected or threw; the two are counted
separately. A single configuration failure, such as the `403` Shopify gives a
closed store, only lands in `unrolled`. It **stops the run** on a `429` and
carries on next run. Frozen, locked and missing shops (`402`, `423`, `404`)
don't count toward halting at all. When every listed shop has been attempted the request is deleted; the state key keeps the
pass: counts by outcome (`rolled`, `current`, `none`, `rejected`,
`needs_reauth`, `failed`, `skipped`, `invalid`, `error`) and `unrolled`, the
latest answer of each shop that didn't roll. Shops that failed are retried by
their alarm; write the request again to sweep them sooner.

When to run one:

- **Migrating legacy tokens:** in stages, see
  [Migrating legacy sessions](#migrating-legacy-sessions).
- **Planned client-secret rotation**, while Shopify keeps both secrets active:
  deploy the new secret, then sweep. Shopify pins each shop's token to the new
  secret when it refreshes. Revoke the old secret only once `unrolled` is
  empty. The app must accept webhooks signed with either secret meanwhile
  (Shopify signs with the oldest unrevoked one), which the package doesn't
  cover. The [rotation Workflow](#rotating-secrets-with-a-workflow) runs this
  with stages and approvals.
- **Leaked storage or refresh tokens:** two passes, the second with an
  `obtainedBefore` after the first finished. Shopify keeps a presented refresh
  token usable until its replacement is presented, so only the second pass
  retires the leaked ones. Leaked access tokens live out their hour.
- **After rotating the keyring:** one pass reseals every live shop.
- **After an emergency revoke:** refresh tokens issued under the old secret
  still refresh with the new one (rehearsed on a dev store), so a pass brings
  background work back for every shop at once instead of waiting for each
  shop's alarm.

`rollover(shop, { obtainedBefore })` on the storage does the same for one shop
and returns its answer.

### Rotating secrets with a Workflow

`createRotateSecretsWorkflow` (from `./workflow`) runs the two rotations above
(the keyring and the Shopify client secret) as one durable, gated
[Cloudflare Workflow](https://developers.cloudflare.com/workflows/). Operators
still put the secrets. The Workflow checks each deploy against a snapshot it
took before, runs the rollover passes under its own KV keys, and waits for an
explicit event before every irreversible step. It holds no secret, and no step
output or event carries one. The design is in `spec.secret-rotation.md`.

```ts
// Worker entry
import { createRotateSecretsWorkflow } from '@optizio/shopify-session-storage-do/workflow'

export const RotateSecrets = createRotateSecretsWorkflow<Env>({
  registry: (env) => ({ kv: env.SESSION }), // the Durable Object's registry
  namespace: (env) => env.SHOP_SESSIONS,
  legacyKv: (env) => env.SESSION, // while legacy `offline_*` sessions may remain; leave out otherwise
})
```

```toml
# Workflow names are global per account, and bindings aren't inherited: one per environment.
[env.production]
workflows = [{ name = "rotate-secrets-production", binding = "ROTATE_SECRETS", class_name = "RotateSecrets" }]
```

It needs Workers Paid. On the Free plan, a Workflow step gets 10 ms of CPU and an
instance 1,024 steps, and a rollover run needs more. At most 5 stages are
allowed, which keeps a rotation near 3,000 of the 10,000 steps an instance gets.

Start a rotation with `env.ROTATE_SECRETS.create({ params: { kind, canaryShop } })`,
and send each event from an authenticated operator route with
`(await env.ROTATE_SECRETS.get(id)).sendEvent({ type, payload: {} })`. The
canary must be a live, non-legacy shop (`describe` answers `state: 'ok'`).
`wrangler workflows instances describe` shows each step's output, including the
stragglers.

**Keyring** (`kind: 'keyring'`):

1. Generate and escrow the key, put `new,old` in one `wrangler secret put`,
   then send `keyring-deployed`. The Workflow checks that the live kids are
   exactly the new one followed by the old ones, and that the canary reseals.
2. After 90 days it describes every registry shop, rolls the live ones still on
   an old key, and lists the rest (legacy, quarantined, unreadable). Then it
   checks that the keyring hasn't changed since and waits for `approve-drop`.
3. Put the keyring without the old keys, then send `keyring-dropped`. The
   Workflow checks the drop and finishes with
   `{ newKid, dropKids, stragglers }`.

**Client secret** (`kind: 'api-secret'`, optional `stages`, default `[10, 200]`):

1. Before anything else, deploy the app so that it accepts webhooks and session
   tokens signed with either secret (`SHOPIFY_API_SECRET_PREVIOUS`). Shopify
   signs webhooks with the oldest unrevoked secret; the package doesn't
   verify them.
2. Generate the new secret in the Dev Dashboard, then run **one**
   `wrangler secret bulk` with `SHOPIFY_API_SECRET=new` and
   `SHOPIFY_API_SECRET_PREVIOUS=old`. Two `secret put` commands would deploy
   twice. Send `api-secret-deployed`. The Workflow checks that the live
   credentials changed and that the canary refreshes with them.
3. It waits 10 minutes, so that refreshes cut off by the deploy replay first,
   then runs a rollover pass per stage. After each stage `n` it waits for
   `approve-after-n`, then runs a full pass. A halted pass waits for
   `resume-stage-n` (or `resume-stage-all`).
4. If shops didn't roll, or legacy `offline_*` sessions remain, it waits for
   `ack-stragglers`. Revoking kills those shops' access tokens. Expiring-token
   shops recover on their next refresh, because refresh tokens survive the
   revoke; legacy shops don't.
5. Revoke the old secret in the Dev Dashboard and send `api-secret-revoked`.
   The Workflow checks that the canary still refreshes. Then remove
   `SHOPIFY_API_SECRET_PREVIOUS`.

Each wait has a timeout (7 to 30 days), and a timed-out or failed instance
stops. `keyringRetention: (env) => '2 minutes'` shortens the keyring flow's
90-day wait, for a rehearsal on a staging Worker only (`scripts/staging`). One rotation per kind runs at a time, under
`shop-sessions:rotation:<kind>:lock` in the registry KV. A failed instance
keeps its lock, so delete the lock by hand after investigating.

### Listing shops

Each object writes `<prefix><shop>` (value `''`, metadata `{ since }`) to the
registry KV when its record is created and after every alarm run; `deleteShop`
and the 90-day quarantine wipe remove it. List with
`kv.list({ prefix: 'shop-session:' })`, plus the remaining `offline_*` keys
until the backfill is done. A marker means the object holds a record, not that
its token works; KV listings are eventually consistent.

### Debugging with `describe`

`describe(shop)` returns the record without secrets: `exists`, `state` (`none`,
`ok`, `legacy`, `needs_reauth`, `unreadable`, `failing`), `source`, `scope`,
token and refresh-token expiry, `pairObtainedAt`, `tokenInvalid`,
`attemptPending` (a token call was sent and its outcome isn't stored yet), the
number of alternates, `kids`, `needsReauth`, `failures` (count, kind, code,
since, retryAt, ambiguous) and `nextAlarmAt`. It also reports the object's live
configuration: `keyring.kids` (the deployed keyring's kids, current first) and
`credentials.credFp` (a truncated SHA-256 of the API key and secret). Neither is
secret. Both show what a deploy changed, which the rotation Workflow checks.
Expose `describe` only through an authenticated operator route.

### Quarantine and failures

**`needs_reauth`** means Shopify rejected every refresh token the object holds
(`refresh_rejected`), rejected the legacy token during migration
(`legacy_rejected`), or an exchange gave no refresh token and the access token
ran out (`no_refresh_token`). The sealed tokens are kept but never served. A
token exchange, i.e. the merchant opening the app, replaces them. **Fixing
`SHOPIFY_API_KEY` or `SHOPIFY_API_SECRET` triggers an automatic retry**: the
object fingerprints the credentials, retries the quarantined chain once when
they change, and ignores any backoff. A quarantine is wiped after 90 days.

**`failing`** records keep everything and back off. Transient errors (network,
timeouts, `5xx`, `429`) wait 10 seconds to 2 minutes between request-driven
retries (longer if Shopify sends `Retry-After`) and 1 minute to 6 hours between
alarm retries. Shop states (`402`, `423`, `404`) and configuration errors
(other `4xx`/`3xx`) retry every 6 hours, then daily after 7 days.

### Logs and reports

Every report is a structured `console.error` line
(`source: '@optizio/shopify-session-storage-do'`, message, shop, op, kind, code,
HTTP status, `x-request-id`, count) and a call to `report`. Reported: each new
failure kind and code, a refresh rejected on an expiring pair, an unreadable
record (once per instance), an exchange without a refresh token, a
non-expiring token stored because the flag is off, a token response with
missing fields (by name), alternates dropped over the cap, a failed legacy
import (once per instance), configuration errors (once per instance for
requests) and alarm errors (at most hourly per shop, kept in storage across
evictions).
Migration rejections are logged but not reported: they are expected for shops
whose uninstall webhook failed. **Tokens, refresh tokens, the client secret,
response bodies and request data are never logged or reported.**

## Adoption checklist

When migrating from `KVSessionStorage`, turn the switches on only in the deploy
that ships the whole list: imports delete the KV keys that raw token readers
use.

- [ ] `future.expiringOfflineAccessTokens: true`.
- [ ] Bind `SHOP_SESSIONS` and require the keyring secret at the top level and
      in every environment, with the next free migration tag.
- [ ] Every raw token read (jobs, queues, alarms, support tools) calls
      `loadOfflineSession` at the moment of use. Clean up only on `none`; back
      off otherwise.
- [ ] Nothing persists an access token (job rows, queue messages): pass the
      shop and load the token when the work runs.
- [ ] Background 401s call `reportUnauthorized`.
- [ ] With `appTokenKey`: the public JWK is registered in the Dev Dashboard for
      the `kid` deployed, and the private key is a secret, escrowed.
- [ ] Webhooks that write sessions, such as `APP_SCOPES_UPDATE`, call
      `shopify.sessionStorage.storeSession`, not a new `KVSessionStorage`
      (which would write the token back to KV in plaintext).
- [ ] Install checks and fleet jobs read registry markers (plus the remaining
      `offline_*` keys until the backfill is done), not `offline_<shop>`.
- [ ] Scripts that read `offline_*` over the KV REST API go through an
      authenticated operator route instead.
- [ ] Uninstall verifies the webhook without loading the session, calls
      `deleteShop(shop, { uninstalledAt })`, and runs the app's own cleanups
      only on `deleted`.

## Limits and deferred work

- **Online sessions are unsupported.** `storeSession` of one throws and
  `loadSession` of an online id returns `undefined`.
- **Merchant custom apps are out of scope.** They are exempt from expiring
  tokens, and the object stops serving non-expiring tokens after
  `legacyCutoff`.
- **One client secret at a time.** The object always uses
  `SHOPIFY_API_SECRET`; a planned rotation is a deploy followed by a
  [rollover](#rolling-over-credentials). Accepting webhooks and session tokens
  signed with either secret during the overlap is up to the app. Shops whose
  rollover is rejected keep background work running on the
  [app-token fallback](#app-token-fallback), if configured.
- **Some fleet sweeps are deferred:** re-counting or re-placing every object,
  and a circuit breaker for the backfill. None needs a change to stored data.
- **No caching in the isolate.** Every load is an RPC to the shop's object.

## Testing

```bash
pnpm install
pnpm test           # Node suite; `pnpm test run` for a single pass
pnpm test:workers   # workerd suite (@cloudflare/vitest-plugin), old and current compat dates
pnpm test:all       # every suite, once
pnpm typecheck
```

The workerd suite runs the Durable Object against a fake Shopify that applies
its rotation rules: concurrent loads, racing exchanges, alarms, eviction
mid-refresh and destroy races. CI also builds the package and checks that the
main entry never reaches `cloudflare:workers`.

## Status

We don't offer support, and we don't take issues or pull requests. This copy
is updated by hand, so it can lag behind the code we run. Fork it freely: the
license lets you. To report a vulnerability, follow [SECURITY.md](SECURITY.md).

If you change a fork:

- **[DESIGN.md](DESIGN.md) is the specification the code follows.** It is
  formatted by hand; Prettier skips it. [CHANGELOG.md](CHANGELOG.md) lists what
  changed in each release.
- **Stored data must stay readable.** Existing records depend on the record
  version (`v: 1`), the encryption's associated data (`${shop}|${field}`), the
  key-id label (`shop-session-kid`), the fingerprint prefixes
  (`shop-session-token|`, `shop-session-cred|`) and the KV key formats
  (`shop-session:`, `shop-sessions:*`, `offline_`, `shop:`). Changing any of them
  needs a path that still reads the old form.
- **Never log or report** a token, refresh token, the client secret, a response
  body or request data.

## License

MIT © Optizio
