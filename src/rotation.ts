// Keyring and client-secret rotation (spec.secret-rotation.md). Operators put the secrets; this verifies each deploy
// against a pre-deploy snapshot and waits for approval before every irreversible step. No step output or event
// carries a secret. Platform-free: `./workflow` supplies the step and the fatal error type.

import { DurableObjectSessionStorage } from './adapter.js'
import { rolloverShops } from './rollover.js'
import type { RolloverPass, RolloverShopsResult } from './rollover.js'
import { DEFAULT_REGISTRY_PREFIX } from './types.js'
import type { KVNamespaceLike, RolloverResult, ShopSessionStatus, ShopSessionsNamespace } from './types.js'

export type RotationKind = 'keyring' | 'api-secret'

export type RotationParams = {
  kind: RotationKind
  /** A live, non-legacy shop (`describe` answers `state: 'ok'`) used to verify each deploy. */
  canaryShop: string
  /** api-secret only: `stopAfter` for each staged pass, strictly increasing (default [10, 200]); a full pass follows. */
  stages?: number[]
}

/** A shop a rotation could not bring onto the new key or secret. No secrets. */
export type RotationStraggler = { shop: string; state: string; status?: string }

export type KeyringRotationResult = {
  kind: 'keyring'
  newKid: string
  /** The kids the operator removed: every kid live before the rotation. */
  dropKids: string[]
  /** Shops still on a dropped key when the drop was approved (listed up to 1000). */
  stragglers: { total: number; listed: RotationStraggler[] }
}

export type ApiSecretRotationResult = {
  kind: 'api-secret'
  stragglers: {
    /** Each shop the final pass left on the old secret, with its latest answer (at most 1000). */
    unrolled: RolloverPass['unrolled']
    /** Exact count of registry shops on pre-cutoff credentials or undescribable (shops with no record excluded). */
    notRolled: number
    /** `offline_*` sessions remain in the legacy KV: shops outside the registry, on legacy tokens. */
    unimportedLegacy: boolean
  }
}

export type RotationResult = KeyringRotationResult | ApiSecretRotationResult

/** A step's retry policy, in the Workflows shape. */
export type RotationStepConfig = {
  retries?: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' }
  timeout?: string | number
}

/** The parts of a Workflows `step` the rotation uses. Outputs are plain JSON. */
export type RotationStep = {
  do<T>(name: string, config: RotationStepConfig, callback: () => Promise<T>): Promise<T>
  sleep(name: string, duration: string): Promise<void>
  waitForEvent(name: string, options: { type: string; timeout: string }): Promise<unknown>
}

export type RotationDeps = {
  /** The Workflow instance id: it holds the lock. */
  instanceId: string
  /** The registry KV (the Durable Object's `registry`). The lock, request and pass state are kept here too. */
  kv: KVNamespaceLike
  namespace: ShopSessionsNamespace
  /** Must match the Durable Object's registry prefix. */
  registryPrefix?: string
  /** Must match the adapter's. */
  locationHint?: string
  /** Must match the Durable Object's setting. */
  allowMyshopifyIo?: boolean
  /** The legacy KVSessionStorage namespace, if the app still has one: `offline_*` keys there block a quiet revoke. */
  legacyKv?: KVNamespaceLike
  /** The error that fails the instance at once, without retries (`NonRetryableError` in workerd). */
  fatal: (message: string) => Error
  /** Receives a non-secret error when a pass halts or a request is invalid. */
  report?: (error: Error) => void
  /**
   * How long old keys are kept before the census (default '90 days': keepalive reseals live shops within 30,
   * quarantines are wiped within 90). Shorten only for a staging rehearsal.
   */
  keyringRetention?: string
}

const LEGACY_PREFIX = 'offline_'
const RETRY: RotationStepConfig = { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' } }
const DEFAULT_STAGES = [10, 200]
/** Keeps (MAX_STAGES + 1) passes × MAX_RUNS near 3,000 steps, under the Workflows 10,000-step instance limit. */
const MAX_STAGES = 5
const MAX_LISTED = 1000
/** At ~500 shops per run, a pass covers about 250k shops before giving up. */
const MAX_RUNS = 500
const CENSUS_PAGE = 200
const RESEAL_BATCH = 50
const CONCURRENCY = 8
/** KV is last-writer-wins and takes ~60 s to propagate: after this, racing rotations read back the one winning write. */
const LOCK_SETTLE = '2 minutes'

/** KV keys a rotation of `kind` owns. The cron's rollover keys are never touched. */
export function rotationKeys(kind: RotationKind): { lock: string; requestKey: string; stateKey: string } {
  return {
    lock: `shop-sessions:rotation:${kind}:lock`,
    requestKey: `shop-sessions:rotation:${kind}:request`,
    stateKey: `shop-sessions:rotation:${kind}:state`,
  }
}

/** spec.secret-rotation.md, "Keyring flow" and "API-secret flow". */
export async function runRotation(
  params: RotationParams,
  step: RotationStep,
  deps: RotationDeps,
): Promise<RotationResult> {
  const { fatal } = deps
  if (params?.kind !== 'keyring' && params?.kind !== 'api-secret') {
    throw fatal(`rotation: kind must be 'keyring' or 'api-secret'`)
  }
  if (typeof params.canaryShop !== 'string' || params.canaryShop === '') {
    throw fatal('rotation: canaryShop is required')
  }
  const stages = params.kind === 'api-secret' ? validStages(params.stages, fatal) : []
  const rotation = new Rotation(params, step, deps)
  return params.kind === 'keyring'
    ? rotation.run(() => rotation.keyring())
    : rotation.run(() => rotation.apiSecret(stages))
}

function validStages(stages: number[] | undefined, fatal: RotationDeps['fatal']): number[] {
  const list = stages ?? DEFAULT_STAGES
  const ok =
    Array.isArray(list) &&
    list.every((n, i) => Number.isInteger(n) && n > 0 && (i === 0 || n > (list[i - 1] as number)))
  if (!ok) throw fatal('rotation: stages must be strictly increasing positive integers')
  if (list.length > MAX_STAGES) throw fatal(`rotation: at most ${MAX_STAGES} stages (the full pass is added)`)
  return list
}

type Before = { kids: string[]; credFp: string }

class Rotation {
  private readonly storage: DurableObjectSessionStorage
  private readonly keys: ReturnType<typeof rotationKeys>
  private readonly prefix: string
  private before: Before = { kids: [], credFp: '' }

  constructor(
    private readonly params: RotationParams,
    private readonly step: RotationStep,
    private readonly deps: RotationDeps,
  ) {
    this.storage = new DurableObjectSessionStorage({
      namespace: deps.namespace,
      ...(deps.locationHint !== undefined && { locationHint: deps.locationHint }),
      ...(deps.allowMyshopifyIo !== undefined && { allowMyshopifyIo: deps.allowMyshopifyIo }),
    })
    this.keys = rotationKeys(params.kind)
    this.prefix = deps.registryPrefix ?? DEFAULT_REGISTRY_PREFIX
  }

  /**
   * A failed flow leaves the lock: delete it by hand after investigating. KV has no compare-and-set, so the lock is
   * read back after LOCK_SETTLE; the loser of a race fails before touching anything.
   */
  async run<T extends RotationResult>(flow: () => Promise<T>): Promise<T> {
    const { kv, instanceId, fatal } = this.deps
    const { lock } = this.keys
    await this.step.do('lock', RETRY, async () => {
      const holder = await kv.get(lock, 'json')
      if (holder !== null && holder !== instanceId) throw fatal(`rotation ${String(holder)} holds ${lock}`)
      await kv.put(lock, JSON.stringify(instanceId))
    })
    await this.step.sleep('lock-settle', LOCK_SETTLE)
    await this.step.do('lock-verify', RETRY, async () => {
      const holder = await kv.get(lock, 'json')
      if (holder !== instanceId) throw fatal(`rotation ${String(holder)} took ${lock} at the same time`)
    })
    this.before = await this.step.do('before', RETRY, async () => {
      const s = await this.describe(this.params.canaryShop)
      if (s.state !== 'ok') throw fatal(`canary is ${s.state}: pick a live, non-legacy shop`)
      return { kids: s.keyring.kids, credFp: s.credentials.credFp }
    })
    const result = await flow()
    await this.step.do('unlock', RETRY, async () => {
      // Never another rotation's lock (one an operator cleared and reused by hand).
      if ((await kv.get(lock, 'json')) === instanceId) await kv.delete(lock)
    })
    return result
  }

  // ── Keyring ──────────────────────────────────────────────────────────────

  async keyring(): Promise<KeyringRotationResult> {
    const { fatal } = this.deps
    const canary = this.params.canaryShop
    const dropKids = this.before.kids
    await this.step.waitForEvent('keyring-deployed', { type: 'keyring-deployed', timeout: '7 days' })

    const newKid = await this.step.do('verify-keyring', RETRY, async () => {
      const kids = (await this.describe(canary)).keyring.kids
      // May still be propagating: retryable.
      if (same(kids, dropKids)) throw new Error('keyring unchanged since the snapshot')
      const [first] = kids
      if (first === undefined || dropKids.includes(first) || !same(kids.slice(1), dropKids)) {
        throw fatal(`expected [new, ${dropKids.join(', ')}], live is [${kids.join(', ')}]: put new,old as one value`)
      }
      return first
    })

    await this.step.do('verify-canary', RETRY, async () => {
      await this.rollCanary()
      const s = await this.describe(canary)
      const kids = s.kids ?? []
      if (s.state !== 'ok' || kids.length === 0 || kids.some((k) => k !== newKid)) {
        throw fatal(`canary not resealed: state ${s.state}, kids [${kids.join(', ')}]`)
      }
    })

    await this.step.sleep('retain-old-keys', this.deps.keyringRetention ?? '90 days')

    const hits = await this.census('census', (s) => (s.kids ?? []).some((k) => k !== newKid))
    const stragglers = await this.reseal(hits)

    await this.step.do('verify-keyring-unchanged', RETRY, async () => {
      const kids = (await this.describe(canary)).keyring.kids
      if (!same(kids, [newKid, ...dropKids])) {
        throw fatal(`keyring changed since the rotation began: [${kids.join(', ')}]; the drop list is stale`)
      }
    })

    await this.step.waitForEvent('approve-drop', { type: 'approve-drop', timeout: '30 days' })
    await this.step.waitForEvent('keyring-dropped', { type: 'keyring-dropped', timeout: '7 days' })
    await this.step.do('verify-drop', RETRY, async () => {
      const s = await this.describe(canary)
      if (!s.keyring.kids.includes(newKid) || s.keyring.kids.some((k) => dropKids.includes(k))) {
        throw new Error(`live kids [${s.keyring.kids.join(', ')}]`)
      }
      if (s.state === 'unreadable') throw fatal('canary unreadable after the drop: put the key back')
    })
    return { kind: 'keyring', newKid, dropKids, stragglers }
  }

  // ── Shopify client secret ────────────────────────────────────────────────

  async apiSecret(stages: number[]): Promise<ApiSecretRotationResult> {
    const { fatal, legacyKv } = this.deps
    const canary = this.params.canaryShop
    const oldCredFp = this.before.credFp
    await this.step.waitForEvent('api-secret-deployed', { type: 'api-secret-deployed', timeout: '7 days' })

    await this.step.do('verify-credentials', RETRY, async () => {
      const live = (await this.describe(canary)).credentials.credFp
      // Still propagating, or the secret went to another environment: retryable.
      if (live === oldCredFp) throw new Error('credentials unchanged since the snapshot')
    })
    await this.step.do('verify-canary', RETRY, () => this.rollCanary())

    // Interrupted refreshes replay with the new secret but return pairs pinned to the old one; settling before the
    // cutoff makes the pass roll them again.
    await this.step.sleep('settle', '10 minutes')
    const cutoff = await this.step.do('pin-cutoff', RETRY, async () => Date.now())
    for (const n of stages) {
      await this.runPass(`stage-${n}`, cutoff, n)
      await this.step.waitForEvent(`approve-after-${n}`, { type: `approve-after-${n}`, timeout: '7 days' })
    }
    const pass = await this.runPass('stage-all', cutoff)

    // `pass.unrolled` is capped at 1000; the census counts them all.
    const notRolled = (await this.census('stragglers', (s) => !rolledSince(s, cutoff))).length
    const stragglers = await this.step.do('stragglers', RETRY, async () => {
      const unrolled = pass.unrolled.filter((shop) => shop.status !== 'none')
      const legacy = legacyKv ? await legacyKv.list({ prefix: LEGACY_PREFIX, limit: 1 }) : undefined
      return {
        unrolled,
        notRolled,
        unimportedLegacy: (legacy?.keys.length ?? 0) > 0,
      }
    })
    // Revoking kills those shops' access tokens; expiring-token shops recover on their next refresh, legacy ones don't.
    if (stragglers.notRolled > 0 || stragglers.unimportedLegacy) {
      await this.step.waitForEvent('ack-stragglers', { type: 'ack-stragglers', timeout: '14 days' })
    }

    await this.step.waitForEvent('api-secret-revoked', { type: 'api-secret-revoked', timeout: '30 days' })
    await this.step.do('verify-after-revoke', RETRY, async () => {
      await this.rollCanary()
      const s = await this.describe(canary)
      if (s.state !== 'ok') throw fatal(`canary ${s.state} after the revoke`)
    })
    return { kind: 'api-secret', stragglers }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private describe(shop: string): Promise<ShopSessionStatus> {
    return this.storage.describe(shop)
  }

  /** Throws a retryable error on a transient failure, a fatal one on anything a retry can't fix. */
  private async rollCanary(): Promise<void> {
    const r = await this.storage.rollover(this.params.canaryShop, { obtainedBefore: new Date() })
    if (r.status === 'rolled' || r.status === 'current') return
    if (r.status === 'failed' && r.kind === 'transient') throw new Error(`canary: transient ${r.code}`)
    const detail = r.status === 'failed' ? ` (${r.kind} ${r.code})` : ''
    throw this.deps.fatal(`canary answered ${r.status}${detail}: check the secret, or pick a live, non-legacy shop`)
  }

  /** One rollover pass under this kind's own keys, one bounded `rolloverShops` run per step. */
  private async runPass(label: string, obtainedBefore: number, stopAfter?: number): Promise<RolloverPassSummary> {
    const { kv, fatal } = this.deps
    const { requestKey, stateKey } = this.keys
    const request = JSON.stringify({ obtainedBefore, ...(stopAfter !== undefined && { stopAfter }) })
    await this.step.do(`${label}:request`, RETRY, () => kv.put(requestKey, request))

    for (let i = 0; i < MAX_RUNS; i++) {
      const r: RolloverShopsResult = await this.step.do(`${label}:run-${i}`, RETRY, () =>
        rolloverShops({
          kv,
          namespace: this.deps.namespace,
          requestKey,
          stateKey,
          registryPrefix: this.prefix,
          ...(this.deps.locationHint !== undefined && { locationHint: this.deps.locationHint }),
          ...(this.deps.allowMyshopifyIo !== undefined && { allowMyshopifyIo: this.deps.allowMyshopifyIo }),
          ...(this.deps.report && { report: this.deps.report }),
        }),
      )
      switch (r.status) {
        case 'done':
        case 'paused':
          if (!r.pass) throw fatal(`${label}: rolloverShops answered ${r.status} without a pass`)
          return r.pass
        case 'running':
          break
        case 'throttled':
          await this.step.sleep(`${label}:backoff-${i}`, '5 minutes')
          break
        case 'halted':
          // The circuit breaker tripped (the run's output and report() say why). Fix the cause, then resume.
          await this.step.waitForEvent(`${label}:resume-${i}`, { type: `resume-${label}`, timeout: '7 days' })
          await this.step.do(`${label}:rewrite-${i}`, RETRY, () => kv.put(requestKey, request))
          break
        default:
          // idle or invalid_request: this rotation's own request is gone or malformed.
          throw fatal(`${label}: rolloverShops answered ${r.status}`)
      }
    }
    throw fatal(`${label}: not done after ${MAX_RUNS} runs`)
  }

  /**
   * Describes every registry shop (no Shopify calls). An undescribable shop is a hit with state `error` so one shop
   * can't fail the rotation; a page where every describe fails is retried.
   */
  private async census(label: string, match: (s: ShopSessionStatus) => boolean): Promise<RotationStraggler[]> {
    const hits: RotationStraggler[] = []
    let cursor: string | undefined
    for (let page = 0; ; page++) {
      const from = cursor
      const r = await this.step.do(`${label}:page-${page}`, RETRY, async () => {
        const list = await this.deps.kv.list({
          prefix: this.prefix,
          limit: CENSUS_PAGE,
          ...(from !== undefined && { cursor: from }),
        })
        const shops = list.keys.map((k) => k.name.slice(this.prefix.length))
        const statuses = await mapLimit(shops, CONCURRENCY, (shop) =>
          this.describe(shop).catch((): RotationStraggler => ({ shop, state: 'error' })),
        )
        const failed = statuses.filter(isError)
        if (shops.length > 0 && failed.length === shops.length) throw new Error(`${label}: every describe failed`)
        return {
          hits: [
            ...statuses
              .filter((s): s is ShopSessionStatus => !isError(s) && match(s))
              .map((s) => ({
                shop: s.shop,
                state: s.state,
              })),
            ...failed,
          ],
          ...(!list.list_complete && list.cursor !== undefined && { next: list.cursor }),
        }
      })
      hits.push(...r.hits)
      if (r.next === undefined) return hits
      cursor = r.next
    }
  }

  /** Rolls the live hits; non-live and failed ones are stragglers. */
  private async reseal(hits: RotationStraggler[]): Promise<KeyringRotationResult['stragglers']> {
    const isLive = (h: RotationStraggler) => h.state === 'ok' || h.state === 'failing'
    const left = hits.filter((h) => !isLive(h))
    const live = hits.filter(isLive)
    if (live.length === 0) return { total: left.length, listed: left.slice(0, MAX_LISTED) }
    // Pinned in its own step so a retried batch sees shops it already rolled as `current` (each refresh burns a token).
    const at = await this.step.do('reseal:pin', RETRY, async () => Date.now())
    for (let i = 0; i < live.length; i += RESEAL_BATCH) {
      const batch = live.slice(i, i + RESEAL_BATCH)
      const failed = await this.step.do(`reseal:batch-${i / RESEAL_BATCH}`, RETRY, async () => {
        const results = await mapLimit(batch, CONCURRENCY, (h) =>
          this.storage.rollover(h.shop, { obtainedBefore: new Date(at) }).then(
            (r: RolloverResult) => r.status as string,
            () => 'error',
          ),
        )
        return batch
          .map((h, j) => ({ ...h, status: results[j] as string }))
          .filter((h) => h.status !== 'rolled' && h.status !== 'current')
      })
      left.push(...failed)
    }
    return { total: left.length, listed: left.slice(0, MAX_LISTED) }
  }
}

type RolloverPassSummary = NonNullable<RolloverShopsResult['pass']>

function isError(s: ShopSessionStatus | RotationStraggler): s is RotationStraggler {
  return s.state === 'error' && !('keyring' in s)
}

/**
 * The shop holds credentials Shopify issued at or after `cutoff` (as `isCurrentPair` decides inside the object), or
 * none at all. An imported pair's time is the import's, so it never counts.
 */
function rolledSince(s: ShopSessionStatus, cutoff: number): boolean {
  if (!s.exists) return true
  return (
    (s.state === 'ok' || s.state === 'failing') &&
    s.source !== 'import' &&
    (s.kids?.length ?? 0) > 0 &&
    (s.pairObtainedAt ?? -Infinity) >= cutoff
  )
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
