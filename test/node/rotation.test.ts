import { describe, expect, it } from 'vitest'

import { DEFAULT_ROLLOVER_REQUEST_KEY, DEFAULT_ROLLOVER_STATE_KEY } from '../../src/rollover.js'
import { rotationKeys, runRotation } from '../../src/rotation.js'
import type { RotationDeps, RotationParams, RotationStep, RotationStepConfig } from '../../src/rotation.js'
import type { RolloverResult, ShopSessionStatus } from '../../src/types.js'
import { FakeKV } from './core/fakes.js'

const CANARY = 'canary.myshopify.com'
const PREFIX = 'shop-session:'
const INSTANCE = 'rotation-1'

class Fatal extends Error {
  override name = 'NonRetryableError'
}

type Shop = { state: ShopSessionStatus['state']; kids: string[]; credFp?: string }
type Answer = (shop: string, fleet: Fleet) => RolloverResult | undefined

/** Shops behind fake Durable Objects. `live` is the deployed configuration every object reports. */
class Fleet {
  live = { kids: ['k1'], credFp: 'fp-old' }
  shops = new Map<string, Shop>()
  rollovers: string[] = []
  /** Overrides the default answer for a shop; undefined falls through to it. */
  answer: Answer | undefined

  constructor(shops: Record<string, Shop>) {
    for (const [shop, value] of Object.entries(shops)) this.shops.set(shop, { ...value })
  }

  readonly namespace = {
    idFromName: (name: string) => ({ name }),
    get: (id: never) => {
      const { name } = id as { name: string }
      return {
        describe: async ({ shop }: { shop: string }): Promise<ShopSessionStatus> => {
          expect(shop).toBe(name)
          const s = this.shops.get(shop)
          const live = { keyring: { kids: [...this.live.kids] }, credentials: { credFp: this.live.credFp } }
          if (!s) return { shop, exists: false, state: 'none', nextAlarmAt: null, ...live }
          return { shop, exists: true, state: s.state, kids: [...s.kids], nextAlarmAt: null, ...live }
        },
        rollover: async ({ shop }: { shop: string; obtainedBefore: number }): Promise<RolloverResult> => {
          expect(shop).toBe(name)
          this.rollovers.push(shop)
          const custom = this.answer?.(shop, this)
          if (custom) return custom
          const s = this.shops.get(shop)
          if (!s) return { status: 'none' }
          if (s.state === 'legacy') return { status: 'skipped', reason: 'migration_off' }
          if (s.state === 'needs_reauth') return { status: 'needs_reauth', since: 1, reason: 'refresh_rejected' }
          if (s.state === 'unreadable') return { status: 'skipped', reason: 'unreadable' }
          const current = s.kids.every((k) => k === this.live.kids[0]) && s.credFp === this.live.credFp
          Object.assign(s, { state: 'ok', kids: [this.live.kids[0]], credFp: this.live.credFp })
          return current ? { status: 'current' } : { status: 'rolled', source: 'refresh' }
        },
      }
    },
  }
}

/** A Workflows step: retries per config, fatal errors skip retries, and events/sleeps run scripted hooks. */
class FakeStep implements RotationStep {
  log: string[] = []
  attempts = new Map<string, number>()
  /** Event types the operator sends; any other wait times out. */
  sent = new Set<string>()
  hooks = new Map<string, () => void | Promise<void>>()

  async do<T>(name: string, config: RotationStepConfig, callback: () => Promise<T>): Promise<T> {
    this.log.push(`do ${name}`)
    for (let attempt = 1; ; attempt++) {
      this.attempts.set(name, attempt)
      try {
        const value = await callback()
        // Step outputs are persisted as JSON.
        return (value === undefined ? value : JSON.parse(JSON.stringify(value))) as T
      } catch (error) {
        if (error instanceof Fatal || attempt > (config.retries?.limit ?? 0)) throw error
      }
    }
  }

  async sleep(name: string, duration: string): Promise<void> {
    this.log.push(`sleep ${name} ${duration}`)
    await this.hooks.get(name)?.()
  }

  async waitForEvent(name: string, options: { type: string; timeout: string }): Promise<unknown> {
    this.log.push(`wait ${options.type}`)
    expect(name).toBeTruthy()
    if (!this.sent.has(options.type)) throw new Error(`timed out waiting for ${options.type}`)
    await this.hooks.get(options.type)?.()
    return { type: options.type, payload: {} }
  }

  send(...types: string[]): this {
    for (const type of types) this.sent.add(type)
    return this
  }

  on(name: string, hook: () => void | Promise<void>): this {
    this.hooks.set(name, hook)
    return this
  }
}

function setup(shops: Record<string, Shop>) {
  const fleet = new Fleet(shops)
  const kv = new FakeKV()
  for (const shop of fleet.shops.keys()) kv.setJson(`${PREFIX}${shop}`, '')
  const step = new FakeStep()
  const reports: Error[] = []
  const deps: RotationDeps = {
    instanceId: INSTANCE,
    kv,
    namespace: fleet.namespace,
    fatal: (message) => new Fatal(message),
    report: (error) => reports.push(error),
  }
  const run = (params: RotationParams) => runRotation(params, step, deps)
  return { fleet, kv, step, deps, reports, run }
}

const ok = (kids = ['k1'], credFp = 'fp-old'): Shop => ({ state: 'ok', kids, credFp })

describe('rotation: keyring', () => {
  function keyringFleet() {
    return setup({
      [CANARY]: ok(),
      'live.myshopify.com': ok(),
      'kept.myshopify.com': ok(),
      'legacy.myshopify.com': { state: 'legacy', kids: ['k1'] },
      'quarantined.myshopify.com': { state: 'needs_reauth', kids: ['k1'] },
    })
  }

  it('verifies the deploy, reseals the stragglers after retention, and waits for approval before the drop', async () => {
    const { fleet, kv, step, run } = keyringFleet()
    step
      .send('keyring-deployed', 'approve-drop', 'keyring-dropped')
      .on('keyring-deployed', () => void (fleet.live.kids = ['k2', 'k1']))
      // The keepalive reseals one live shop during the retention; the other is left for the census.
      .on('retain-old-keys', () => void Object.assign(fleet.shops.get('kept.myshopify.com')!, { kids: ['k2'] }))
      .on('keyring-dropped', () => void (fleet.live.kids = ['k2']))

    const result = await run({ kind: 'keyring', canaryShop: CANARY })

    expect(result).toEqual({
      kind: 'keyring',
      newKid: 'k2',
      dropKids: ['k1'],
      stragglers: {
        total: 2,
        listed: [
          { shop: 'legacy.myshopify.com', state: 'legacy' },
          { shop: 'quarantined.myshopify.com', state: 'needs_reauth' },
        ],
      },
    })
    expect(fleet.shops.get('live.myshopify.com')!.kids).toEqual(['k2'])
    expect(step.log).toEqual([
      'do lock',
      'do before',
      'wait keyring-deployed',
      'do verify-keyring',
      'do verify-canary',
      'sleep retain-old-keys 90 days',
      'do census:page-0',
      'do reseal:batch-0',
      'do verify-keyring-unchanged',
      'wait approve-drop',
      'wait keyring-dropped',
      'do verify-drop',
      'do unlock',
    ])
    expect(kv.data.has(rotationKeys('keyring').lock)).toBe(false)
  })

  it('retains the old keys for keyringRetention when one is given (staging rehearsals only)', async () => {
    const { fleet, step, deps, run } = keyringFleet()
    deps.keyringRetention = '2 minutes'
    step
      .send('keyring-deployed', 'approve-drop', 'keyring-dropped')
      .on('keyring-deployed', () => void (fleet.live.kids = ['k2', 'k1']))
      .on('keyring-dropped', () => void (fleet.live.kids = ['k2']))
    await run({ kind: 'keyring', canaryShop: CANARY })
    expect(step.log).toContain('sleep retain-old-keys 2 minutes')
  })

  it('fails when the deploy is not exactly new,old (and keeps the lock for a human)', async () => {
    const { fleet, kv, step, run } = keyringFleet()
    step.send('keyring-deployed').on('keyring-deployed', () => void (fleet.live.kids = ['k2']))
    await expect(run({ kind: 'keyring', canaryShop: CANARY })).rejects.toThrow(
      'expected [new, k1], live is [k2]: put new,old as one value',
    )
    expect(step.attempts.get('verify-keyring')).toBe(1)
    expect(kv.data.has(rotationKeys('keyring').lock)).toBe(true)
  })

  it('retries while the keyring is unchanged, then fails', async () => {
    const { step, run } = keyringFleet()
    step.send('keyring-deployed')
    await expect(run({ kind: 'keyring', canaryShop: CANARY })).rejects.toThrow('keyring unchanged')
    expect(step.attempts.get('verify-keyring')).toBe(6)
  })

  it('refuses to drop when the keyring changed during the retention', async () => {
    const { fleet, step, run } = keyringFleet()
    step
      .send('keyring-deployed', 'approve-drop', 'keyring-dropped')
      .on('keyring-deployed', () => void (fleet.live.kids = ['k2', 'k1']))
      .on('retain-old-keys', () => void (fleet.live.kids = ['k3', 'k2', 'k1']))
    await expect(run({ kind: 'keyring', canaryShop: CANARY })).rejects.toThrow('the drop list is stale')
    expect(step.log).not.toContain('wait approve-drop')
  })

  it('pages the census through the whole registry', async () => {
    const shops: Record<string, Shop> = { [CANARY]: ok() }
    for (let i = 0; i < 450; i++) shops[`s${String(i).padStart(3, '0')}.myshopify.com`] = ok()
    const { fleet, step, run } = setup(shops)
    step
      .send('keyring-deployed', 'approve-drop', 'keyring-dropped')
      .on('keyring-deployed', () => void (fleet.live.kids = ['k2', 'k1']))
      .on('keyring-dropped', () => void (fleet.live.kids = ['k2']))
    const result = await run({ kind: 'keyring', canaryShop: CANARY })
    expect(result).toMatchObject({ stragglers: { total: 0, listed: [] } })
    expect(step.log.filter((line) => line.startsWith('do census:page-'))).toHaveLength(3)
    expect(step.log.filter((line) => line.startsWith('do reseal:batch-'))).toHaveLength(9)
    expect([...fleet.shops.values()].every((s) => s.kids[0] === 'k2')).toBe(true)
  })
})

describe('rotation: api-secret', () => {
  function secretFleet(extra: Record<string, Shop> = {}) {
    const ctx = setup({
      [CANARY]: ok(),
      'a.myshopify.com': ok(),
      'b.myshopify.com': ok(),
      'c.myshopify.com': ok(),
      ...extra,
    })
    ctx.step.on('api-secret-deployed', () => void (ctx.fleet.live.credFp = 'fp-new'))
    return ctx
  }

  it('verifies the deploy, stages passes under its own keys, and waits for the revoke', async () => {
    const { fleet, kv, step, run } = secretFleet()
    // A registry marker whose object has no record (uninstalled meanwhile): `none`, not a straggler.
    kv.setJson(`${PREFIX}gone.myshopify.com`, '')
    step.send('api-secret-deployed', 'approve-after-1', 'approve-after-2', 'api-secret-revoked')

    const result = await run({ kind: 'api-secret', canaryShop: CANARY, stages: [1, 2] })

    expect(result).toEqual({ kind: 'api-secret', stragglers: { unrolled: [], notRolled: 0, unimportedLegacy: false } })
    expect([...fleet.shops.values()].every((s) => s.credFp === 'fp-new')).toBe(true)
    const waits = step.log.filter((line) => line.startsWith('wait ') || line.startsWith('sleep '))
    expect(waits).toEqual([
      'wait api-secret-deployed',
      'sleep settle 10 minutes',
      'wait approve-after-1',
      'wait approve-after-2',
      'wait api-secret-revoked',
    ])
    // The cron's rollover keys are never touched; the rotation's own ones are left with the finished pass.
    const keys = rotationKeys('api-secret')
    expect(kv.ops.some((op) => op.key === DEFAULT_ROLLOVER_REQUEST_KEY || op.key === DEFAULT_ROLLOVER_STATE_KEY)).toBe(
      false,
    )
    expect(kv.data.has(keys.requestKey)).toBe(false)
    expect(JSON.parse(kv.data.get(keys.stateKey)!.value)).toMatchObject({ completedAt: expect.any(Number) })
    expect(kv.data.has(keys.lock)).toBe(false)
  })

  it('retries while the credentials are unchanged (a secret put elsewhere), then fails', async () => {
    const { step, run } = setup({ [CANARY]: ok() })
    step.send('api-secret-deployed')
    await expect(run({ kind: 'api-secret', canaryShop: CANARY })).rejects.toThrow('credentials unchanged')
    expect(step.attempts.get('verify-credentials')).toBe(6)
  })

  it('fails at once when the canary rejects the new secret', async () => {
    const { fleet, step, run } = secretFleet()
    step.send('api-secret-deployed')
    fleet.answer = (shop) =>
      shop === CANARY ? { status: 'failed', kind: 'configuration', code: 'invalid_request', retryAt: 0 } : undefined
    await expect(run({ kind: 'api-secret', canaryShop: CANARY })).rejects.toThrow(
      'canary answered failed (configuration invalid_request)',
    )
    expect(step.attempts.get('verify-canary')).toBe(1)
  })

  it('waits for an acknowledgement when shops did not roll or legacy sessions remain', async () => {
    const { step, deps, run } = secretFleet({ 'legacy.myshopify.com': { state: 'legacy', kids: ['k1'] } })
    const legacyKv = new FakeKV()
    legacyKv.setJson('offline_unimported.myshopify.com', {})
    deps.legacyKv = legacyKv
    step.send('api-secret-deployed', 'approve-after-10', 'approve-after-200', 'ack-stragglers', 'api-secret-revoked')

    const result = await run({ kind: 'api-secret', canaryShop: CANARY })

    expect(result).toEqual({
      kind: 'api-secret',
      stragglers: {
        unrolled: [{ shop: 'legacy.myshopify.com', status: 'skipped', code: 'migration_off' }],
        notRolled: 1,
        unimportedLegacy: true,
      },
    })
    expect(step.log).toContain('wait ack-stragglers')
  })

  it('without an acknowledgement, never reaches the revoke', async () => {
    const { step, run } = secretFleet({ 'legacy.myshopify.com': { state: 'legacy', kids: ['k1'] } })
    step.send('api-secret-deployed', 'approve-after-10', 'approve-after-200', 'api-secret-revoked')
    await expect(run({ kind: 'api-secret', canaryShop: CANARY })).rejects.toThrow('ack-stragglers')
    expect(step.log).not.toContain('wait api-secret-revoked')
  })

  it('waits for a resume after the circuit breaker halts a pass, then carries on', async () => {
    const shops: Record<string, Shop> = {}
    for (let i = 0; i < 12; i++) shops[`s${String(i).padStart(2, '0')}.myshopify.com`] = ok()
    const { fleet, step, reports, run } = secretFleet(shops)
    let broken = true
    fleet.answer = (shop) =>
      broken && shop !== CANARY
        ? { status: 'failed', kind: 'configuration', code: 'invalid_request', retryAt: 0 }
        : undefined
    step
      .send('api-secret-deployed', 'resume-stage-all', 'api-secret-revoked')
      .on('resume-stage-all', () => void (broken = false))

    const result = await run({ kind: 'api-secret', canaryShop: CANARY, stages: [] })

    expect(step.log).toContain('wait resume-stage-all')
    expect(step.log).toContain('do stage-all:rewrite-0')
    expect(reports.some((error) => /halt/i.test(error.message))).toBe(true)
    expect(result.kind === 'api-secret' && result.stragglers.notRolled).toBe(0)
  })

  it('sleeps and resumes when Shopify throttles a pass', async () => {
    const { fleet, step, run } = secretFleet()
    let throttled = true
    fleet.answer = (shop) =>
      throttled && shop === 'b.myshopify.com'
        ? { status: 'failed', kind: 'transient', code: 'http_429', retryAt: 0 }
        : undefined
    step.send('api-secret-deployed', 'api-secret-revoked').on('stage-all:backoff-0', () => void (throttled = false))
    const result = await run({ kind: 'api-secret', canaryShop: CANARY, stages: [] })
    expect(step.log).toContain('sleep stage-all:backoff-0 5 minutes')
    expect(result.kind === 'api-secret' && result.stragglers.notRolled).toBe(0)
  })
})

describe('rotation: Workflows limits', () => {
  // Event types: up to 100 characters of [a-zA-Z0-9-_], not starting with '-' (Workflows events reference).
  const EVENT_TYPE = /^[a-zA-Z0-9_][a-zA-Z0-9-_]{0,99}$/

  it('waits only on event types Workflows accepts, including halted-pass resumes', async () => {
    const types = new Set<string>()
    const record = (step: FakeStep) => {
      for (const line of step.log) if (line.startsWith('wait ')) types.add(line.slice('wait '.length))
    }
    const keyring = setup({ [CANARY]: ok() })
    keyring.step
      .send('keyring-deployed', 'approve-drop', 'keyring-dropped')
      .on('keyring-deployed', () => void (keyring.fleet.live.kids = ['k2', 'k1']))
      .on('keyring-dropped', () => void (keyring.fleet.live.kids = ['k2']))
    await keyring.run({ kind: 'keyring', canaryShop: CANARY })
    record(keyring.step)

    const shops: Record<string, Shop> = { [CANARY]: ok() }
    for (let i = 0; i < 12; i++) shops[`s${String(i).padStart(2, '0')}.myshopify.com`] = ok()
    const secret = setup(shops)
    let broken = true
    secret.fleet.answer = (shop) =>
      broken && shop !== CANARY
        ? { status: 'failed', kind: 'configuration', code: 'invalid_request', retryAt: 0 }
        : undefined
    secret.step
      .send('api-secret-deployed', 'resume-stage-1000', 'approve-after-1000', 'api-secret-revoked')
      .on('api-secret-deployed', () => void (secret.fleet.live.credFp = 'fp-new'))
      .on('resume-stage-1000', () => void (broken = false))
    await secret.run({ kind: 'api-secret', canaryShop: CANARY, stages: [1000] })
    record(secret.step)

    expect([...types].sort()).toEqual([
      'api-secret-deployed',
      'api-secret-revoked',
      'approve-after-1000',
      'approve-drop',
      'keyring-deployed',
      'keyring-dropped',
      'resume-stage-1000',
    ])
    for (const type of types) expect(type).toMatch(EVENT_TYPE)
  })

  it('caps the stages, keeping a rotation well inside the 10,000-step instance limit', async () => {
    const { step, run } = setup({ [CANARY]: ok() })
    await expect(run({ kind: 'api-secret', canaryShop: CANARY, stages: [1, 2, 3, 4, 5, 6] })).rejects.toThrow(
      'at most 5 stages',
    )
    expect(step.log).toEqual([])
  })

  it('keeps every step output small: a census page and a reseal batch stay far below 1 MiB', async () => {
    const shops: Record<string, Shop> = { [CANARY]: ok() }
    for (let i = 0; i < 400; i++) shops[`${'x'.repeat(40)}-${String(i).padStart(3, '0')}.myshopify.com`] = ok()
    const { fleet, step, run } = setup(shops)
    const sizes: number[] = []
    const inner = step.do.bind(step)
    step.do = async <T>(name: string, config: RotationStepConfig, callback: () => Promise<T>) => {
      const value = await inner(name, config, callback)
      sizes.push(value === undefined ? 0 : JSON.stringify(value).length)
      return value
    }
    step
      .send('keyring-deployed', 'approve-drop', 'keyring-dropped')
      .on('keyring-deployed', () => void (fleet.live.kids = ['k2', 'k1']))
      .on('keyring-dropped', () => void (fleet.live.kids = ['k2']))
    await run({ kind: 'keyring', canaryShop: CANARY })
    expect(Math.max(...sizes)).toBeLessThan(64 * 1024)
  })
})

describe('rotation: guards', () => {
  it.each<[string, unknown]>([
    ['not increasing', [10, 10]],
    ['not positive', [0, 5]],
    ['not integers', [1.5]],
    ['not a list', '10'],
  ])('rejects stages that are %s before taking the lock', async (_, stages) => {
    const { step, run } = setup({ [CANARY]: ok() })
    await expect(run({ kind: 'api-secret', canaryShop: CANARY, stages: stages as number[] })).rejects.toThrow(
      'stages must be strictly increasing positive integers',
    )
    expect(step.log).toEqual([])
  })

  it('rejects an unknown kind or a missing canary', async () => {
    const { run } = setup({})
    await expect(run({ kind: 'other' as never, canaryShop: CANARY })).rejects.toBeInstanceOf(Fatal)
    await expect(run({ kind: 'keyring', canaryShop: '' })).rejects.toThrow('canaryShop is required')
  })

  it('refuses a canary that is not live, keeping the lock it took', async () => {
    const { kv, run } = setup({ [CANARY]: { state: 'legacy', kids: ['k1'] } })
    await expect(run({ kind: 'keyring', canaryShop: CANARY })).rejects.toThrow('canary is legacy')
    expect(JSON.parse(kv.data.get(rotationKeys('keyring').lock)!.value)).toBe(INSTANCE)
  })

  it('runs one rotation per kind: another instance holding the lock is fatal', async () => {
    const { kv, step, run } = setup({ [CANARY]: ok() })
    kv.setJson(rotationKeys('keyring').lock, 'rotation-0')
    await expect(run({ kind: 'keyring', canaryShop: CANARY })).rejects.toThrow(
      'rotation rotation-0 holds shop-sessions:rotation:keyring:lock',
    )
    expect(step.log).toEqual(['do lock'])
  })

  it('lets the same instance take its lock again when a step is replayed', async () => {
    const { fleet, kv, step, run } = setup({ [CANARY]: ok() })
    kv.setJson(rotationKeys('keyring').lock, INSTANCE)
    step
      .send('keyring-deployed', 'approve-drop', 'keyring-dropped')
      .on('keyring-deployed', () => void (fleet.live.kids = ['k2', 'k1']))
      .on('keyring-dropped', () => void (fleet.live.kids = ['k2']))
    await expect(run({ kind: 'keyring', canaryShop: CANARY })).resolves.toMatchObject({ newKid: 'k2' })
  })
})
