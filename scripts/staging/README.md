# Staging rotation rehearsal

A Worker that hosts this package from `src/` (the Durable Object, the rotation
Workflow, and operator routes behind a bearer token), to run one rotation
against a real store before production (`spec.secret-rotation.md`, open
question 1). It is not an app: no webhooks, no admin UI.

Use a dev store of a test app: the run rotates and revokes the client secret.

## Setup (once)

```bash
pnpm exec wrangler login
pnpm staging:kv              # copy the printed id into scripts/staging/wrangler.jsonc (SESSION)
pnpm staging init            # operator token and a staging keyring, in .rehearsal/staging.json
pnpm staging:deploy          # prints the workers.dev URL
pnpm staging url https://shop-sessions-staging.<subdomain>.workers.dev
pnpm staging secrets         # SHOPIFY_API_KEY/SECRET, keyring, token: one wrangler secret bulk
```

`secrets` reads `.env` and pipes the values to `wrangler secret bulk` on stdin,
so nothing is written to disk or printed.

## Install the canary

`https://localhost/callback` must be an allowed redirect URL (as for
`scripts/rehearsal`).

```bash
pnpm staging install-url <shop>                 # open it, approve
pnpm staging install '<the https://localhost/callback?… URL>'
pnpm staging describe <shop>                    # state: ok, with keyring and credentials
```

## Rotate the client secret

```bash
pnpm staging start api-secret <shop> 1          # one stage of 1 shop, then the full pass
```

1. In the Dev Dashboard, generate a new secret and keep the old one active. In
   `.env`, set `SHOPIFY_API_SECRET=<new>` and
   `SHOPIFY_API_SECRET_PREVIOUS=<old>`, then `pnpm staging secrets` (one deploy).
2. `pnpm staging event <id> api-secret-deployed`. Check with `pnpm staging status <id>`
   until it waits for `approve-after-1`, then send that event.
3. When it waits for `api-secret-revoked`: revoke the old secret in the Dev
   Dashboard, then send `api-secret-revoked`.
4. `status` shows `complete` with the stragglers. If it is waiting on
   `ack-stragglers`, read the output first.

A failed instance keeps its lock: `pnpm staging unlock api-secret`.

## Rotate the keyring

The staging keyring lives in `.rehearsal/staging.json`, and `wrangler.jsonc` sets
`KEYRING_RETENTION` to 2 minutes, so this needs no Dev Dashboard step.

```bash
pnpm staging start keyring <shop>
pnpm staging keyring-add                        # new,old in one secret update
pnpm staging event <id> keyring-deployed
# after the retention, when status shows it waiting:
pnpm staging event <id> approve-drop
pnpm staging keyring-drop                       # keep only the new key
pnpm staging event <id> keyring-dropped
```
