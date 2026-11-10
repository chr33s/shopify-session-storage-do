#!/usr/bin/env node
// Checks the Shopify facts the design rests on (DESIGN.md §2) and the secret-rotation spec's open questions
// against a real dev store, using this repo's own token client (dist/), so the local classifications are
// verified too.
//
//   pnpm rehearsal <phase>   # builds dist/ first, then runs this; loads .env from the repo root
//
// Runs on Node's built-in type stripping (Node ≥ 22.18). Imports the built package from dist/: src/ can't be
// loaded directly, since its imports name `.js` files that only exist after a build.
//
// Phases, in order (see scripts/rehearsal/README.md):
//   baseline  --dev-store   install (OAuth), migrate, refresh-chain facts. Secret A only.
//   overlap                 after the Dev Dashboard rotation: both secrets active.
//   revoked                 after the old secret is revoked.
//   app-token               application-only tokens (needs SHOPIFY_APP_TOKEN_KEY/KID). Any time after baseline.
//   app-key-revoked         after revoking the first public key (needs the _2 key). Within the hour.
//   report                  prints every result.
//
// Tokens are kept in .rehearsal/ (gitignored, mode 0600) and never printed: output shows fingerprints only.
// Revoking the old secret kills every token pinned to it, so run this only on a dev store of a test app.

import { createHmac, generateKeyPairSync, hash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createAssertionSigner, type AssertionSigner } from '../../dist/app-token.js'
import { canonicalShop } from '../../dist/shop.js'
import { createAppTokenClient, createTokenClient } from '../../dist/token-client.js'
import type { AppTokenClient, AppTokenKey, TokenCallResult } from '../../dist/types.js'

type Success = Extract<TokenCallResult, { outcome: 'success' }>
type Role = 'a' | 'b'
type Pair = { accessToken: string; refreshToken?: string; obtainedAt: number }
type Chain = { shop: string; pairs: Record<string, Pair>; legacy?: Pair; head?: string }
type AppToken = { accessToken: string; mintedAt: number; expiresIn: number; kid: string }
type Verdict = 'pass' | 'fail' | 'observe' | 'skip'
type Mode = 'match' | 'prefix' | 'observe'
type Result = { id: string; fact: string; expected?: string; actual?: string; verdict: Verdict; at?: string }
type State = {
  phase?: string
  /** Fingerprints (fp) of the secrets, never the secrets. */
  secretA?: string
  secretB?: string
  chains: Partial<Record<Role, Chain>>
  results: Result[]
  appToken?: { shop: string; tokens: { t1?: AppToken; t2?: AppToken } }
  preRevokeAppToken?: AppToken
  /** An authorize URL was printed; `baseline --callback` finishes the install. */
  pendingInstall?: { role: Role; shop: string; nonce: string }
}
type Json = Record<string, unknown>

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const STATE_DIR = join(ROOT, '.rehearsal')
const STATE_FILE = join(STATE_DIR, 'shopify-facts.json')
if (existsSync(join(ROOT, '.env'))) loadEnvFile(join(ROOT, '.env'))
const API_VERSION = process.env.SHOPIFY_API_VERSION ?? '2026-10'
// Shopify only allows https redirect URLs. Nothing has to listen there: the code is read from the address bar.
const REDIRECT_URI = process.env.REHEARSAL_REDIRECT_URI ?? 'https://localhost/callback'
const SCOPES = process.env.SHOPIFY_SCOPES ?? 'read_products'
const HOUR = 3600
const DAY = 86_400

const PHASES = ['baseline', 'overlap', 'revoked', 'app-token', 'app-key-revoked', 'report'] as const
const USAGE = `usage: verify-shopify.ts <${PHASES.join('|')}> [--dev-store] [--callback <redirected URL>]`
const args = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: { 'dev-store': { type: 'boolean', default: false }, callback: { type: 'string' } },
    })
  } catch (error) {
    die(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  }
})()

// ── Phases ───────────────────────────────────────────────────────────────────

async function baseline(): Promise<void> {
  if (!args.values['dev-store']) {
    die('baseline installs on SHOPIFY_SHOP and a later phase revokes a secret: pass --dev-store to confirm it is one')
  }
  const apiKey = env('SHOPIFY_API_KEY')
  const secretA = env('SHOPIFY_API_SECRET')
  const callbackUrl = args.values.callback
  let state: State
  if (callbackUrl === undefined) {
    state = load({ fresh: true })
    state.secretA = fp(secretA)
    state.phase = 'baseline'
  } else {
    state = load()
    const pending = state.pendingInstall
    if (state.phase !== 'baseline' || !pending) die('no install is pending: run baseline --dev-store first')
    if (fp(secretA) !== state.secretA) die('SHOPIFY_API_SECRET changed since baseline started')
    const installed = await install(pending.shop, apiKey, secretA, pending.nonce, callbackUrl)
    delete state.pendingInstall
    save(state)
    if (!(await baselineShop(state, pending.role, pending.shop, installed, apiKey, secretA))) return
  }

  const next = shops().find(([role]) => !state.chains[role])
  if (next) return authorize(state, apiKey, ...next)
  state.phase = 'baseline-done'
  save(state)
  console.log('\nNext: in the Dev Dashboard, generate a new client secret (keep the old one active). In .env set')
  console.log('SHOPIFY_API_SECRET=<new> and SHOPIFY_API_SECRET_PREVIOUS=<old>, then run the overlap phase.')
}

/** The install, migration and refresh-chain facts for one shop. False when a step failed and the rest can't run. */
async function baselineShop(
  state: State,
  role: Role,
  shop: string,
  installed: Pair,
  apiKey: string,
  secretA: string,
): Promise<boolean> {
  console.log(`\n== ${role}: ${shop}`)
  // Shop B's checks get their own rows, so they don't replace shop A's in the report.
  const rid = (id: string) => (role === 'a' ? id : `${id}-${role}`)
  const client = createTokenClient({ apiKey, apiSecretKey: secretA })
  const chain: Chain = (state.chains[role] = { shop, pairs: {} })
  save(state)
  let p0: Pair
  if (installed.refreshToken) {
    record(
      state,
      rid('F0'),
      `${role}: authorization-code grant`,
      'legacy (non-expiring) token',
      'expiring pair',
      'observe',
    )
    p0 = installed
  } else {
    record(state, rid('F0'), `${role}: authorization-code grant`, 'legacy token', 'legacy token', 'observe')
    chain.legacy = installed
    record(state, rid('F0b'), `${role}: legacy token works`, 'valid', await admin(shop, installed.accessToken))

    const m1 = await client.migrate(shop, installed.accessToken)
    expectSuccess(state, rid('F6'), `${role}: migration (token exchange, expiring=1)`, m1)
    if (m1.outcome !== 'success') {
      save(state)
      return false
    }
    p0 = pairOf(m1)
    lifetimes(state, role, 'migration', m1)
    record(
      state,
      rid('F6a'),
      `${role}: migration response omits scope?`,
      'may omit',
      m1.scope === undefined ? 'omitted' : 'present',
      'observe',
    )
    record(
      state,
      rid('F6b'),
      `${role}: migration invalidates the legacy token at once`,
      'invalid',
      await admin(shop, installed.accessToken),
    )

    const m2 = await client.migrate(shop, installed.accessToken)
    record(state, rid('F6c'), `${role}: identical migration returns the same pair`, 'same pair', samePair(m2, p0))

    const m3 = await client.migrate(shop, garbage('shpat_'))
    record(
      state,
      rid('F6d'),
      `${role}: unknown subject token is terminal`,
      'terminal invalid_subject_token',
      outcome(m3),
    )
  }
  chain.pairs.p0 = p0
  save(state)
  if (role !== 'a') return true // shop B only needs a chain under secret A

  const r1 = await client.refresh(shop, refreshOf(p0))
  expectSuccess(state, rid('F2'), 'refresh succeeds', r1)
  if (r1.outcome !== 'success') {
    save(state)
    return false
  }
  const p1 = (chain.pairs.p1 = pairOf(r1))
  lifetimes(state, role, 'refresh', r1)
  record(
    state,
    rid('F2a'),
    'refresh renews the refresh token',
    'new refresh token',
    p1.refreshToken !== p0.refreshToken ? 'new refresh token' : 'same',
  )
  record(
    state,
    rid('F7'),
    'a refresh leaves the previous access token valid',
    'valid',
    await admin(shop, p0.accessToken),
  )

  const r1again = await client.refresh(shop, refreshOf(p0))
  record(
    state,
    rid('F3'),
    'retrying the presented refresh token returns the same pair',
    'same pair',
    samePair(r1again, p1),
  )

  const r2 = await client.refresh(shop, refreshOf(p1))
  expectSuccess(state, rid('F3a'), 'presenting the newer refresh token succeeds', r2)
  if (r2.outcome !== 'success') {
    save(state)
    return false
  }
  chain.pairs.p2 = pairOf(r2)
  const r0late = await client.refresh(shop, refreshOf(p0))
  record(state, rid('F5'), 'a retired refresh token is terminal', 'terminal', outcome(r0late), 'prefix')

  const junk = await client.refresh(shop, garbage(''))
  record(
    state,
    rid('F5a'),
    'unknown refresh token (local classification)',
    'terminal invalid_grant',
    outcome(junk),
    'observe',
  )

  const wrong = createTokenClient({ apiKey, apiSecretKey: garbage('') })
  const bad = await wrong.refresh(shop, garbage(''))
  record(state, rid('F8'), 'wrong client secret is a configuration failure', 'configuration', bad.outcome, 'prefix')
  chain.head = 'p2'
  save(state)
  return true
}

async function overlap(): Promise<void> {
  const state = load()
  requirePhase(state, 'baseline-done')
  const apiKey = env('SHOPIFY_API_KEY')
  const secretB = env('SHOPIFY_API_SECRET')
  const secretA = env('SHOPIFY_API_SECRET_PREVIOUS')
  if (fp(secretA) !== state.secretA) die('SHOPIFY_API_SECRET_PREVIOUS is not the secret baseline ran with')
  if (fp(secretB) === state.secretA) die('SHOPIFY_API_SECRET is still the old secret: put the new one in .env')
  state.secretB = fp(secretB)
  const oldClient = createTokenClient({ apiKey, apiSecretKey: secretA })
  const newClient = createTokenClient({ apiKey, apiSecretKey: secretB })

  const a = chainOf(state, 'a')
  const head = a.pairs[a.head ?? ''] ?? die('baseline left no refresh-chain head: rerun baseline')
  const r3 = await oldClient.refresh(a.shop, refreshOf(head))
  expectSuccess(state, 'S1', 'during the overlap the old secret still refreshes', r3)
  if (r3.outcome !== 'success') return save(state)
  const p3 = (a.pairs.p3 = pairOf(r3))
  record(state, 'S1a', 'its access token works', 'valid', await admin(a.shop, p3.accessToken))

  // An interrupted refresh replayed after the deploy: the same refresh token, now sent with the new secret.
  const replay = await newClient.refresh(a.shop, refreshOf(head))
  const same = samePair(replay, p3)
  record(state, 'S2', 'replaying a presented refresh token with the new secret', 'same pair', same, 'observe')
  if (replay.outcome === 'success' && same !== 'same pair') a.pairs.p3replay = pairOf(replay)
  a.head = 'p3' // issued by a refresh sent with the old secret: the revoked phase tests whether it survives

  const b = state.chains.b
  const b0 = b?.pairs.p0
  if (b && b0) {
    const rb = await newClient.refresh(b.shop, refreshOf(b0))
    expectSuccess(state, 'S3', 'shop B: the new secret refreshes during the overlap', rb)
    if (rb.outcome === 'success') b.pairs.p1 = pairOf(rb)
  } else {
    skip(state, 'S3', 'refresh with the new secret pins the token (needs SHOPIFY_SHOP_B)')
  }
  const key = appKey('')
  if (key) {
    const minted = await (await appClient(apiKey, key)).mint(a.shop)
    expectSuccess(state, 'A10', 'mint an app token before the secret is revoked', minted)
    if (minted.outcome === 'success') state.preRevokeAppToken = tokenOf(minted, key.kid)
  } else {
    skip(state, 'A10', 'app tokens survive a secret revoke (needs SHOPIFY_APP_TOKEN_KEY)')
  }
  state.phase = 'overlap-done'
  save(state)
  console.log('\nNext: revoke the OLD secret in the Dev Dashboard, remove SHOPIFY_API_SECRET_PREVIOUS from .env')
  console.log('(or leave it: the revoked phase uses it only to confirm it is rejected), then run the revoked phase.')
  if (state.preRevokeAppToken) console.log('Run it within the hour, before the app token minted now expires.')
}

async function revoked(): Promise<void> {
  const state = load()
  requirePhase(state, 'overlap-done')
  const apiKey = env('SHOPIFY_API_KEY')
  const secretB = env('SHOPIFY_API_SECRET')
  if (fp(secretB) !== state.secretB) die('SHOPIFY_API_SECRET is not the new secret the overlap phase ran with')
  const newClient = createTokenClient({ apiKey, apiSecretKey: secretB })
  const a = chainOf(state, 'a')
  const p3 = a.pairs.p3 ?? die('overlap left no p3 pair: rerun overlap')

  record(
    state,
    'R1',
    'revoking kills access tokens pinned to the old secret',
    'invalid',
    await admin(a.shop, p3.accessToken),
  )
  const replayed = a.pairs.p3replay
  if (replayed) {
    record(
      state,
      'R2',
      'the pair the replay returned (new secret) after the revoke',
      'valid',
      await admin(a.shop, replayed.accessToken),
      'observe',
    )
  } else {
    record(
      state,
      'R2',
      'the replay returned the original pair: it stays pinned to the old secret',
      'invalid',
      await admin(a.shop, p3.accessToken),
      'observe',
    )
  }

  // Open question 1: does a refresh token issued under the revoked secret still refresh with the new one?
  const r4 = await newClient.refresh(a.shop, refreshOf(p3))
  record(
    state,
    'Q1',
    'a refresh token issued under the revoked secret refreshes with the new secret',
    'success',
    outcome(r4),
    'observe',
  )
  if (r4.outcome === 'success') {
    record(state, 'Q1a', 'the resulting access token works', 'valid', await admin(a.shop, r4.accessToken))
  }

  const b = state.chains.b
  const b1 = b?.pairs.p1
  if (b && b1) {
    record(
      state,
      'R3',
      'shop B: a token refreshed with the new secret survives the revoke',
      'valid',
      await admin(b.shop, b1.accessToken),
    )
  } else {
    skip(state, 'R3', 'refresh with the new secret pins the token (needs SHOPIFY_SHOP_B)')
  }

  const previous = optionalEnv('SHOPIFY_API_SECRET_PREVIOUS')
  if (previous && fp(previous) === state.secretA) {
    const old = createTokenClient({ apiKey, apiSecretKey: previous })
    const res = await old.refresh(a.shop, garbage(''))
    record(state, 'R4', 'the revoked secret is a configuration failure', 'configuration', res.outcome, 'prefix')
  } else {
    skip(state, 'R4', 'revoked secret rejected (keep SHOPIFY_API_SECRET_PREVIOUS set to check)')
  }
  const pre = state.preRevokeAppToken
  if (pre && fresh(pre)) {
    record(
      state,
      'A10a',
      "revoking the client secret doesn't end app tokens",
      'valid',
      await admin(a.shop, pre.accessToken),
    )
  } else if (pre) {
    skip(
      state,
      'A10a',
      'app token survives the secret revoke: it expired first (run revoked within the hour of overlap)',
    )
  }
  const key = appKey('')
  if (key) {
    const minted = await (await appClient(apiKey, key)).mint(a.shop)
    expectSuccess(state, 'A10b', 'minting needs no client secret: works after the revoke', minted)
  }
  state.phase = 'revoked-done'
  save(state)
  await report()
}

async function appTokenPhase(): Promise<void> {
  const state = load()
  const shop = state.chains.a?.shop ?? die('run baseline first: the app must be installed on SHOPIFY_SHOP')
  const apiKey = env('SHOPIFY_API_KEY')
  const key1 = appKey('') ?? die('set SHOPIFY_APP_TOKEN_KEY (or SHOPIFY_APP_TOKEN_KEY_FILE) and SHOPIFY_APP_TOKEN_KID')
  const signer1 = await signerFor(apiKey, key1)
  const client1 = createAppTokenClient({ apiKey, signer: signer1 })
  const app: NonNullable<State['appToken']> = (state.appToken = { shop, tokens: {} })

  const m1 = await client1.mint(shop)
  expectSuccess(state, 'A1', 'mint with a client assertion and no client secret', m1)
  if (m1.outcome !== 'success') return save(state)
  const t1 = (app.tokens.t1 = tokenOf(m1, key1.kid))
  record(state, 'A1a', 'the app token works on the Admin API', 'valid', await admin(shop, m1.accessToken))
  const life = m1.expiresIn
  record(
    state,
    'A2',
    'app-token lifetime',
    '≤ 1 h',
    life === undefined ? 'missing' : life <= HOUR ? '≤ 1 h' : `${(life / HOUR).toFixed(2)} h`,
  )
  if (life !== undefined)
    record(state, 'A2a', 'app-token lifetime (exact)', '', `${(life / 60).toFixed(1)} min`, 'observe')

  // Raw requests for what the client doesn't expose, and to replay one assertion (same jti).
  const assertion = await signer1.sign(shop, Date.now())
  const raw1 = await rawMint(shop, apiKey, assertion)
  record(
    state,
    'A3',
    'the mint response has no refresh token',
    'absent',
    raw1.ok ? ('refresh_token' in raw1.json ? 'present' : 'absent') : raw1.label,
  )
  record(
    state,
    'A4',
    'the app token carries every granted scope',
    await grantedScopes(shop, m1.accessToken),
    scopes(m1.scope),
  )
  const raw2 = await rawMint(shop, apiKey, assertion)
  record(state, 'A5', 'a jti is accepted once', 'rejected', raw2.ok ? 'accepted' : `rejected (${raw2.label})`, 'prefix')

  const m2 = await client1.mint(shop)
  record(
    state,
    'A6',
    'a second mint within the minute',
    'may return the same token',
    m2.outcome !== 'success' ? outcome(m2) : m2.accessToken === t1.accessToken ? 'same token' : 'new token',
    'observe',
  )

  const rogue = await signerFor(apiKey, { kid: 'rehearsal-unregistered', alg: 'ES256', privateKey: freshPem() })
  const m3 = await createAppTokenClient({ apiKey, signer: rogue }).mint(shop)
  record(
    state,
    'A7',
    'an unregistered key is terminal for the mint (local classification)',
    'terminal',
    outcome(m3),
    'prefix',
  )

  const key2 = appKey('_2')
  if (key2) {
    const mb = await (await appClient(apiKey, key2)).mint(shop)
    expectSuccess(state, 'A8', 'a second registered key mints too (two keys active)', mb)
    if (mb.outcome === 'success') {
      app.tokens.t2 = tokenOf(mb, key2.kid)
      record(
        state,
        'A8a',
        'the second key gets its own token',
        'new token',
        mb.accessToken === t1.accessToken ? 'same token' : 'new token',
        'observe',
      )
    }
    console.log(`\nNext: in the Dev Dashboard, revoke the public key "${key1.kid}" (keep "${key2.kid}"),`)
    console.log('then run app-key-revoked within the hour.')
  } else {
    skip(state, 'A8', 'key rotation (needs SHOPIFY_APP_TOKEN_KEY_2 and SHOPIFY_APP_TOKEN_KID_2)')
  }
  save(state)
}

async function appKeyRevoked(): Promise<void> {
  const state = load()
  const app = state.appToken
  const t1 = app?.tokens.t1
  const t2 = app?.tokens.t2
  if (!app || !t1 || !t2) die('run app-token first, with the second key (SHOPIFY_APP_TOKEN_KEY_2) set')
  const apiKey = env('SHOPIFY_API_KEY')
  const shared = t1.accessToken === t2.accessToken
  const mode: Mode = shared ? 'observe' : 'match'

  if (fresh(t1)) {
    record(
      state,
      'A9',
      'revoking a public key ends the tokens minted under it',
      'invalid',
      await admin(app.shop, t1.accessToken),
      mode,
    )
  } else {
    skip(state, 'A9', 'key revoke ends its tokens: the token expired first (rerun app-token, revoke, then this)')
  }
  const key1 = appKey('')
  if (key1?.kid === t1.kid) {
    const m = await (await appClient(apiKey, key1)).mint(app.shop)
    record(state, 'A9a', 'the revoked key no longer mints', 'terminal', outcome(m), 'prefix')
  } else {
    skip(state, 'A9a', 'revoked key rejected (keep SHOPIFY_APP_TOKEN_KEY set to the revoked key)')
  }
  if (fresh(t2)) {
    record(state, 'A9b', "the other key's tokens survive", 'valid', await admin(app.shop, t2.accessToken), mode)
  }
  const key2 = appKey('_2') ?? die('SHOPIFY_APP_TOKEN_KEY_2 is no longer set')
  const m2 = await (await appClient(apiKey, key2)).mint(app.shop)
  expectSuccess(state, 'A9c', 'the remaining key still mints', m2)
  save(state)
}

async function report(): Promise<void> {
  const state = load()
  const icon: Record<Verdict, string> = { pass: 'PASS', fail: 'FAIL', observe: 'NOTE', skip: 'SKIP' }
  console.log(`\n# Shopify facts rehearsal (${state.phase ?? 'not started'})\n`)
  console.log('| | id | fact | expected | actual |')
  console.log('|-|----|------|----------|--------|')
  for (const r of state.results) {
    console.log(`| ${icon[r.verdict]} | ${r.id} | ${r.fact} | ${r.expected ?? ''} | ${r.actual ?? ''} |`)
  }
  console.log('\nNot covered here (see README):')
  for (const line of NOT_COVERED) console.log(`- ${line}`)
  const failed = state.results.filter((r) => r.verdict === 'fail').length
  console.log(`\n${failed} failed. NOTE rows are answers to record in DESIGN.md §2, not pass/fail checks.`)
  if (failed) process.exitCode = 1
}

const NOT_COVERED = [
  'An exchange retires every other refresh token (needs an App Bridge session token).',
  'Webhooks are signed with the oldest unrevoked secret (needs a webhook endpoint; check in the overlap).',
  'Legacy tokens get 403 on the Admin API from 2027-01-01.',
  "The Dev Dashboard's rotation refresh token.",
  'At most two public keys are active (try adding a third in the Dev Dashboard).',
]

// ── Shopify calls ────────────────────────────────────────────────────────────

/** Prints the authorize URL and records what the callback must match. */
function authorize(state: State, apiKey: string, role: Role, shop: string): void {
  const nonce = randomBytes(16).toString('hex')
  const url = new URL(`https://${shop}/admin/oauth/authorize`)
  url.search = new URLSearchParams({
    client_id: apiKey,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state: nonce,
  }).toString()
  state.pendingInstall = { role, shop, nonce }
  save(state)
  console.log(`\n== ${role}: ${shop}`)
  console.log(`1. Open this URL and approve the install (${REDIRECT_URI} must be an allowed redirect URL):\n${url}\n`)
  console.log('2. The browser lands on an error page: copy the full URL from its address bar, and promptly run')
  console.log("   pnpm rehearsal baseline --dev-store --callback '<that URL>'")
}

/** Authorization-code exchange for the code in the URL the browser was redirected to. */
async function install(
  shop: string,
  apiKey: string,
  secret: string,
  nonce: string,
  callbackUrl: string,
): Promise<Pair> {
  const query = URL.canParse(callbackUrl) ? new URL(callbackUrl).searchParams : die('--callback is not a URL')
  const problem = callbackProblem(query, shop, nonce, secret)
  if (problem) die(`callback rejected: ${problem}`)

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: apiKey, client_secret: secret, code: query.get('code') }),
  })
  const json = await readJson(res)
  const accessToken = json.access_token
  if (!res.ok || typeof accessToken !== 'string') die(`code exchange failed: HTTP ${res.status} ${oauthError(json)}`)
  const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : undefined
  console.log(`installed: access ${fp(accessToken)}${refreshToken ? `, refresh ${fp(refreshToken)}` : ''}`)
  return { accessToken, refreshToken, obtainedAt: Date.now() }
}

function callbackProblem(query: URLSearchParams, shop: string, nonce: string, secret: string): string | undefined {
  if (query.get('state') !== nonce) return 'state mismatch'
  if (canonicalShop(query.get('shop') ?? '') !== shop) return 'shop mismatch'
  const hmac = query.get('hmac') ?? ''
  // Shopify signs the remaining parameters sorted by key, form-encoded with spaces as %20 (as @shopify/shopify-api).
  const signed = new URLSearchParams(query)
  signed.delete('hmac')
  signed.delete('signature')
  signed.sort()
  const expected = createHmac('sha256', secret).update(signed.toString().replaceAll('+', '%20')).digest('hex')
  if (hmac.length !== expected.length || !timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return 'bad hmac'
  if (!query.get('code')) return 'no code'
  return undefined
}

/** 'valid', 'invalid' (401), 'ip_restricted' or `http_<status>` for an Admin API call with this token. */
async function admin(shop: string, accessToken: string): Promise<string> {
  const { status, json } = await adminQuery(shop, accessToken, '{ shop { name } }')
  const data = json.data as { shop?: unknown } | undefined
  if (status === 200 && data?.shop) return 'valid'
  if (status === 401) return 'invalid'
  // The token authenticated (a bad one gets 401), but the app's IP allowlist blocks this machine: not a verdict.
  if (status === 403 && /IP restrictions/i.test(String(json.errors))) return 'ip_restricted'
  return `http_${status}`
}

async function adminQuery(shop: string, accessToken: string, query: string): Promise<{ status: number; json: Json }> {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': accessToken },
    body: JSON.stringify({ query }),
  })
  return { status: res.status, json: await readJson(res) }
}

/** The installation's granted scopes, normalised like `scopes()`. */
async function grantedScopes(shop: string, accessToken: string): Promise<string> {
  const { json } = await adminQuery(shop, accessToken, '{ currentAppInstallation { accessScopes { handle } } }')
  const data = json.data as { currentAppInstallation?: { accessScopes?: { handle: string }[] } } | undefined
  const handles = data?.currentAppInstallation?.accessScopes?.map((s) => s.handle)
  return handles ? scopes(handles.join(',')) : 'unavailable'
}

/** Sorted, de-duplicated, with the read scope each write scope implies (Shopify lists both for an installation). */
function scopes(value: string | undefined): string {
  if (typeof value !== 'string') return 'missing'
  const list = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const implied = list.filter((s) => s.startsWith('write_')).map((s) => s.replace('write_', 'read_'))
  return [...new Set([...list, ...implied])].sort().join(',')
}

/** The assertion grant sent by hand, as the local client sends it (form-encoded, no client secret). */
async function rawMint(shop: string, apiKey: string, assertion: string) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: apiKey,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    }).toString(),
  })
  const json = await readJson(res)
  const error = oauthError(json)
  return {
    ok: res.ok && typeof json.access_token === 'string',
    status: res.status,
    json,
    label: `http_${res.status}${error ? ` ${error}` : ''}`,
  }
}

async function readJson(res: Response): Promise<Json> {
  const value: unknown = await res.json().catch(() => undefined)
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {}
}

/** Only a short machine code: anything else could be free text from the body. */
function oauthError(json: Json): string {
  return typeof json.error === 'string' && /^[a-z_]{1,64}$/.test(json.error) ? json.error : ''
}

// ── App tokens ───────────────────────────────────────────────────────────────

/** The app token key from env: `SHOPIFY_APP_TOKEN_KEY<suffix>` (PEM, `\n` escapes allowed) or `…_FILE`. */
function appKey(suffix: '' | '_2'): AppTokenKey | undefined {
  const file = optionalEnv(`SHOPIFY_APP_TOKEN_KEY${suffix}_FILE`)
  const pem = file ? readFileSync(resolve(ROOT, file), 'utf8') : optionalEnv(`SHOPIFY_APP_TOKEN_KEY${suffix}`)
  if (!pem) return undefined
  const alg = optionalEnv(`SHOPIFY_APP_TOKEN_ALG${suffix}`) ?? 'ES256'
  if (alg !== 'ES256' && alg !== 'RS256') die(`SHOPIFY_APP_TOKEN_ALG${suffix} must be ES256 or RS256`)
  return { kid: env(`SHOPIFY_APP_TOKEN_KID${suffix}`), alg, privateKey: pem.replace(/\\n/g, '\n').trim() }
}

async function signerFor(apiKey: string, key: AppTokenKey): Promise<AssertionSigner> {
  try {
    return await createAssertionSigner(apiKey, key)
  } catch (error) {
    // AppTokenKeyError messages carry no key material.
    die(`app token key ${key.kid}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function appClient(apiKey: string, key: AppTokenKey): Promise<AppTokenClient> {
  return createAppTokenClient({ apiKey, signer: await signerFor(apiKey, key) })
}

/** A throwaway ES256 key that Shopify has never seen. */
function freshPem(): string {
  return generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
}

function tokenOf(result: Success, kid: string): AppToken {
  return { accessToken: result.accessToken, mintedAt: result.sentAt, expiresIn: result.expiresIn ?? HOUR, kid }
}

/** Still at least a minute from expiry. */
function fresh(token: AppToken): boolean {
  return Date.now() < token.mintedAt + (token.expiresIn - 60) * 1000
}

// ── Results ──────────────────────────────────────────────────────────────────

/** mode: 'match' (actual === expected), 'prefix' (actual starts with expected) or 'observe' (record only). */
function record(state: State, id: string, fact: string, expected: string, actual: string, mode: Mode = 'match'): void {
  const ok = mode === 'prefix' ? actual.startsWith(expected) : actual === expected
  const verdict: Verdict = mode === 'observe' ? 'observe' : ok ? 'pass' : 'fail'
  state.results = state.results.filter((r) => r.id !== id)
  state.results.push({ id, fact, expected, actual, verdict, at: new Date().toISOString() })
  const hint = verdict === 'fail' ? ` (expected ${expected})` : ''
  console.log(`${verdict.toUpperCase().padEnd(7)} ${id.padEnd(4)} ${fact}: ${actual}${hint}`)
  save(state)
}

function skip(state: State, id: string, fact: string): void {
  state.results = state.results.filter((r) => r.id !== id)
  state.results.push({ id, fact, verdict: 'skip' })
  console.log(`SKIP    ${id.padEnd(4)} ${fact}`)
}

function expectSuccess(state: State, id: string, fact: string, result: TokenCallResult): void {
  record(state, id, fact, 'success', outcome(result))
}

/** Expiry facts (DESIGN.md §2: access 1 h, refresh 90 days). Read from responses, so a mismatch is a note. */
function lifetimes(state: State, role: Role, call: string, result: Success): void {
  const access = result.expiresIn
  const refresh = result.refreshTokenExpiresIn
  const accessLife = access ? `${(access / HOUR).toFixed(2)} h` : 'missing'
  const refreshLife = refresh ? `${(refresh / DAY).toFixed(1)} days` : 'missing'
  record(
    state,
    role === 'a' ? `F1-${call}` : `F1-${call}-${role}`,
    `${role}: ${call} access-token lifetime`,
    '≈ 1 h',
    accessLife,
    'observe',
  )
  record(
    state,
    role === 'a' ? `F1r-${call}` : `F1r-${call}-${role}`,
    `${role}: ${call} refresh-token lifetime`,
    '≈ 90 days',
    refreshLife,
    'observe',
  )
  if (result.missing.length) {
    record(
      state,
      role === 'a' ? `F1m-${call}` : `F1m-${call}-${role}`,
      `${role}: ${call} missing fields`,
      'none',
      result.missing.join(', '),
      'observe',
    )
  }
}

function outcome(result: TokenCallResult): string {
  return result.outcome === 'success' ? 'success' : `${result.outcome} ${result.code}`
}

function samePair(result: TokenCallResult, pair: Pair): string {
  if (result.outcome !== 'success') return outcome(result)
  return result.accessToken === pair.accessToken && result.refreshToken === pair.refreshToken ? 'same pair' : 'new pair'
}

function pairOf(result: Success): Pair {
  return { accessToken: result.accessToken, refreshToken: result.refreshToken, obtainedAt: result.sentAt }
}

function refreshOf(pair: Pair): string {
  return pair.refreshToken ?? die('the pair has no refresh token')
}

// ── State, env, misc ─────────────────────────────────────────────────────────

function load({ fresh = false }: { fresh?: boolean } = {}): State {
  if (fresh || !existsSync(STATE_FILE)) return { results: [], chains: {} }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State
}

function save(state: State): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 })
  chmodSync(STATE_FILE, 0o600)
}

function requirePhase(state: State, expected: string): void {
  if (state.phase !== expected) {
    die(`run the phases in order: expected state "${expected}", found "${state.phase ?? 'none'}"`)
  }
}

function chainOf(state: State, role: Role): Chain {
  return state.chains[role] ?? die(`no chain for shop ${role}: rerun baseline`)
}

function shops(): [Role, string][] {
  const list: [Role, string][] = [['a', shopEnv('SHOPIFY_SHOP') ?? die('SHOPIFY_SHOP is not set (.env)')]]
  const b = shopEnv('SHOPIFY_SHOP_B')
  if (b) list.push(['b', b])
  return list
}

function shopEnv(name: string): string | undefined {
  const raw = optionalEnv(name)
  if (!raw) return undefined
  return canonicalShop(raw.includes('.') ? raw : `${raw}.myshopify.com`) ?? die(`${name} is not a *.myshopify.com shop`)
}

function env(name: string): string {
  return optionalEnv(name) ?? die(`${name} is not set (.env)`)
}

function optionalEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined
}

/** Short, non-reversible label for a secret or token. */
function fp(value: string): string {
  return hash('sha256', value).slice(0, 12)
}

function garbage(prefix: string): string {
  return prefix + randomBytes(16).toString('hex')
}

function die(message: string): never {
  console.error(`verify-shopify: ${message}`)
  process.exit(1)
}

// ── Main (last, so every top-level const above is initialised) ───────────────
const phases: Record<(typeof PHASES)[number], () => Promise<void>> = {
  baseline,
  overlap,
  revoked,
  'app-token': appTokenPhase,
  'app-key-revoked': appKeyRevoked,
  report,
}
const [phase, ...extra] = args.positionals
if (extra.length || !PHASES.includes(phase as (typeof PHASES)[number])) die(USAGE)
await phases[phase as (typeof PHASES)[number]]()
