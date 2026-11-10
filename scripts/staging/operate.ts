#!/usr/bin/env node
// Operator client for the staging Worker (scripts/staging/README.md). Secrets come from .env and
// .rehearsal/staging.json (gitignored, mode 0600) and are piped to wrangler, never written elsewhere or printed.
//
//   pnpm staging <command> [args]

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

type Staging = { url?: string; operatorToken: string; encryptionKeys: string }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const STATE = join(ROOT, '.rehearsal', 'staging.json')
const CONFIG = 'scripts/staging/wrangler.jsonc'
if (existsSync(join(ROOT, '.env'))) loadEnvFile(join(ROOT, '.env'))

const USAGE = `usage: pnpm staging <command>
  init                         create the operator token and keyring (once)
  secrets                      push SHOPIFY_API_KEY/SECRET[/_PREVIOUS], keyring and token with wrangler secret bulk
  url <https://…workers.dev>   remember the deployed URL
  install-url <shop>           print the authorize URL for a shop
  install '<callback url>'     finish an install from the URL the browser landed on
  describe <shop>
  start <keyring|api-secret> <canaryShop> [stages, e.g. 1]
  status <id>
  event <id> <type>
  unlock <keyring|api-secret>
  keyring-add                  put a new key in front of the staging keyring (new,old) and push it
  keyring-drop                 keep only the current staging key and push it`

const { positionals } = parseArgs({ allowPositionals: true, options: {} })
const [command, ...rest] = positionals

switch (command) {
  case 'init':
    init()
    break
  case 'secrets':
    secrets()
    break
  case 'url':
    save({ ...load(), url: arg(0, 'url').replace(/\/+$/, '') })
    break
  case 'install-url':
    print(await call('GET', `/install-url?shop=${encodeURIComponent(arg(0, 'shop'))}`))
    break
  case 'install':
    print(await call('POST', '/install', { callbackUrl: arg(0, 'callback url') }))
    break
  case 'describe':
    print(await call('GET', `/describe?shop=${encodeURIComponent(arg(0, 'shop'))}`))
    break
  case 'start': {
    const stages = rest[2] ? rest[2].split(',').map(Number) : undefined
    print(await call('POST', '/rotations', { kind: arg(0, 'kind'), canaryShop: arg(1, 'canaryShop'), stages }))
    break
  }
  case 'status':
    print(await call('GET', `/rotations/${encodeURIComponent(arg(0, 'id'))}`))
    break
  case 'event':
    print(await call('POST', `/rotations/${encodeURIComponent(arg(0, 'id'))}/events`, { type: arg(1, 'type') }))
    break
  case 'keyring-add': {
    const staging = load()
    save({ ...staging, encryptionKeys: `${randomBytes(32).toString('base64')},${staging.encryptionKeys}` })
    secrets()
    break
  }
  case 'keyring-drop': {
    const staging = load()
    const [current] = staging.encryptionKeys.split(',')
    save({ ...staging, encryptionKeys: current ?? die('empty staging keyring') })
    secrets()
    break
  }
  case 'unlock':
    print(await call('DELETE', `/locks/${encodeURIComponent(arg(0, 'kind'))}`))
    break
  default:
    die(USAGE)
}

function init(): void {
  if (existsSync(STATE)) die(`${STATE} exists: keep it (it holds the staging keyring)`)
  save({ operatorToken: randomBytes(32).toString('base64url'), encryptionKeys: randomBytes(32).toString('base64') })
  console.log(`wrote ${STATE}`)
}

/** Pipes the Worker's secrets to `wrangler secret bulk` on stdin: one deploy, no file on disk. */
function secrets(): void {
  const staging = load()
  const values: Record<string, string> = {
    SHOPIFY_API_KEY: env('SHOPIFY_API_KEY'),
    SHOPIFY_API_SECRET: env('SHOPIFY_API_SECRET'),
    SHOPIFY_SESSION_ENCRYPTION_KEYS: staging.encryptionKeys,
    OPERATOR_TOKEN: staging.operatorToken,
  }
  const previous = process.env.SHOPIFY_API_SECRET_PREVIOUS?.trim()
  if (previous) values.SHOPIFY_API_SECRET_PREVIOUS = previous
  const result = spawnSync('pnpm', ['exec', 'wrangler', 'secret', 'bulk', '-c', CONFIG], {
    cwd: ROOT,
    input: JSON.stringify(values),
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  if (result.status !== 0) die('wrangler secret bulk failed')
  console.log(`pushed: ${Object.keys(values).join(', ')}`)
}

async function call(method: string, path: string, payload?: unknown): Promise<unknown> {
  const staging = load()
  if (!staging.url) die('run: pnpm staging url <deployed URL>')
  const res = await fetch(`${staging.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${staging.operatorToken}`, 'content-type': 'application/json' },
    ...(payload !== undefined && { body: JSON.stringify(payload) }),
  })
  const value: unknown = await res.json().catch(() => ({ status: res.status }))
  if (!res.ok) die(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(value)}`)
  return value
}

function load(): Staging {
  if (!existsSync(STATE)) die('run: pnpm staging init')
  return JSON.parse(readFileSync(STATE, 'utf8')) as Staging
}

function save(value: Staging): void {
  mkdirSync(dirname(STATE), { recursive: true, mode: 0o700 })
  writeFileSync(STATE, JSON.stringify(value, null, 2), { mode: 0o600 })
  chmodSync(STATE, 0o600)
}

function arg(index: number, name: string): string {
  return rest[index] ?? die(`missing ${name}\n${USAGE}`)
}

function env(name: string): string {
  return process.env[name]?.trim() || die(`${name} is not set (.env)`)
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

function die(message: string): never {
  console.error(message)
  process.exit(1)
}
