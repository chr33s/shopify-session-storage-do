# Shopify facts rehearsal

`verify-shopify.ts` checks the Shopify facts in DESIGN.md §2, and the open
questions in `spec.secret-rotation.md`, against a real store. It sends every
token call through this repo's built token client (`dist/`), so it also checks
that the local classifications (`terminal`, `configuration`, …) match what
Shopify actually answers.

**Use a dev store of a test app.** The last phase revokes a client secret,
which kills every token pinned to it.

## Setup

`.env` (gitignored; the script loads it itself, no `--env-file` needed):

```
SHOPIFY_API_KEY=…
SHOPIFY_API_SECRET=…        # secret A
SHOPIFY_SHOP=my-dev-store   # or my-dev-store.myshopify.com
SHOPIFY_SHOP_B=…            # optional second dev store: checks that a refresh with the new secret pins the token
SHOPIFY_SCOPES=read_products  # optional
```

For the app-token phases, also set:

```
SHOPIFY_APP_TOKEN_KEY_FILE=app-token-key.pem   # or SHOPIFY_APP_TOKEN_KEY="-----BEGIN PRIVATE KEY-----\n…"
SHOPIFY_APP_TOKEN_KID=app-key-1                # the kid registered with the public JWK
SHOPIFY_APP_TOKEN_ALG=ES256                    # optional (ES256 or RS256)
SHOPIFY_APP_TOKEN_KEY_2_FILE=app-token-key-2.pem   # optional second key: key-rotation checks
SHOPIFY_APP_TOKEN_KID_2=app-key-2
```

Generate each key pair with:

```bash
pnpm app-token-key --kid app-key-1   # writes app-key-1.pem and app-key-1.jwk.json
pnpm app-token-key --kid app-key-2
```

Register each printed JWK in the Dev Dashboard (Settings > Credentials > Public
keys). The app must be public distribution. The `.pem` files are gitignored
(`*.pem`).

Add `https://localhost/callback` to the app's allowed redirect URLs (Dev
Dashboard: new version > URLs, then release; or `[auth] redirect_urls` and
`shopify app deploy`). Shopify only allows https. Nothing has to listen there:
you copy the code from the address bar. Override it with `REHEARSAL_REDIRECT_URI`.

## Run

```bash
pnpm rehearsal baseline --dev-store
# open the printed URL, approve, copy the URL of the error page you land on, then promptly:
pnpm rehearsal baseline --dev-store --callback '<that URL>'
```

With `SHOPIFY_SHOP_B` set, the second command prints shop B's URL; repeat the
`--callback` step for it.

1. **baseline** (secret A): installs through OAuth (the two commands above),
   then:
   - migrates the legacy token: lifetimes, `scope` omitted, legacy invalidated
     at once, the identical request returns the same pair, an unknown subject
     is terminal;
   - runs the refresh-chain facts: the refresh token is renewed, the previous
     access token stays valid, a retry returns the same pair, a retired token
     is terminal;
   - checks that a wrong secret is a configuration failure.
2. In the Dev Dashboard, **generate a new secret** and keep the old one
   active. In `.env`, set `SHOPIFY_API_SECRET=<new>` and
   `SHOPIFY_API_SECRET_PREVIOUS=<old>`, then run `overlap`. It checks that the
   old secret still refreshes, replays a presented refresh token with the new
   secret (the interrupted-refresh case), and refreshes shop B with the new
   secret.
3. **Revoke the old secret** in the Dev Dashboard, then run `revoked`. It
   checks:
   - pinned access tokens die;
   - which secret the replayed pair is pinned to;
   - **Q1**: whether a refresh token issued under the revoked secret still
     refreshes with the new one;
   - whether shop B survives;
   - that the revoked secret is rejected.
4. **app-token** (any time after `baseline`; needs the app-token values
   below):
   - mints with a client assertion and no client secret; the token works,
     lasts at most 1 hour, has no refresh token, and carries every granted
     scope;
   - replays one assertion to check that a `jti` is accepted once;
   - checks whether a second mint within the minute returns the same token;
   - checks that an unregistered key is `terminal` for the local client;
   - with the second key set, checks that both keys mint.
5. **app-key-revoked** (within the hour of `app-token`): revoke the first
   public key in the Dev Dashboard first. It checks that the key's tokens end
   and it can no longer mint, while the other key's tokens and mints keep
   working.

   If an app-token key is set, `overlap` also mints a token, and `revoked`
   checks that revoking the client secret didn't end it and that minting
   still works. Run `revoked` within the hour of `overlap` for that check.

6. `report` reprints every result. Copy the NOTE rows (observed answers) into
   DESIGN.md §2.

Phases must run in order. `baseline` starts over and overwrites
`.rehearsal/shopify-facts.json`, which holds the tokens (mode 0600, never
printed: output shows fingerprints only). Delete it when you're done.

## Not covered

- An exchange retiring other refresh tokens (needs an App Bridge session
  token).
- Webhook signing during the overlap (needs a webhook endpoint).
- The 2027-01-01 legacy-token `403`.
- The Dev Dashboard's rotation refresh token.
- At most two active public keys (try adding a third in the Dev Dashboard).
- The spec's 10-minute settle, which is system behaviour: covered by
  `test/workers/refresh.test.ts` ("a refresh lost to a deploy").
