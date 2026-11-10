import { introspectWorkflowInstance } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it, onTestFinished } from 'vitest'

import type { RotationParams } from '../../src/workflow.js'
import { installShop, newShop, useFreshFake } from './helpers.js'

useFreshFake()

/** Installs shops in the fake Shopify and lists them in the rotation's own registry. */
async function fleet(count: number): Promise<string[]> {
  const shops = Array.from({ length: count }, (_, i) => newShop(`rotation-${i}`))
  for (const shop of shops) {
    await installShop(shop)
    await env.ROTATION_REGISTRY.put(`shop-session:${shop}`, '')
  }
  return shops
}

async function clearRegistry(): Promise<void> {
  const { keys } = await env.ROTATION_REGISTRY.list()
  await Promise.all(keys.map((key) => env.ROTATION_REGISTRY.delete(key.name)))
}

describe('rotation workflow (workerd)', () => {
  it('runs an api-secret rotation end to end: staged passes, approvals, stragglers check, revoke', async () => {
    await clearRegistry()
    const shops = await fleet(3)
    const [canaryShop] = shops as [string]
    const id = `api-secret-${crypto.randomUUID()}`
    const instance = await introspectWorkflowInstance(env.ROTATE_SECRETS, id)
    onTestFinished(() => instance.dispose())
    await instance.modify(async (m) => {
      await m.disableSleeps()
      await m.disableRetryDelays()
      // One test Worker can't redeploy with another secret: stand in for the deploy check alone. (A null result
      // doesn't count as a mock.)
      await m.mockStepResult({ name: 'verify-credentials' }, 'deployed')
      for (const type of ['api-secret-deployed', 'approve-after-1', 'api-secret-revoked']) {
        await m.mockEvent({ type, payload: {} })
      }
    })

    await env.ROTATE_SECRETS.create({ id, params: { kind: 'api-secret', canaryShop, stages: [1] } })
    await instance.waitForStatus('complete')

    expect(await instance.getOutput()).toEqual({
      kind: 'api-secret',
      stragglers: { unrolled: [], notRolled: 0, unimportedLegacy: false },
    })
    const pass = (await env.ROTATION_REGISTRY.get('shop-sessions:rotation:api-secret:state', 'json')) as {
      attempted: number
      completedAt?: number
    }
    expect(pass.completedAt).toEqual(expect.any(Number))
    expect(await env.ROTATION_REGISTRY.get('shop-sessions:rotation:api-secret:lock')).toBeNull()
    // The cron's keys are untouched.
    expect(await env.ROTATION_REGISTRY.get('shop-sessions:rollover')).toBeNull()
  })

  it('fails without retrying when the canary is not a live shop, keeping the lock', async () => {
    await clearRegistry()
    const canaryShop = newShop('rotation-missing')
    const id = `keyring-${crypto.randomUUID()}`
    const instance = await introspectWorkflowInstance(env.ROTATE_SECRETS, id)
    onTestFinished(() => instance.dispose())

    await env.ROTATE_SECRETS.create({ id, params: { kind: 'keyring', canaryShop } satisfies RotationParams })
    await instance.waitForStatus('errored')

    // Workflows reports a NonRetryableError by type; the message ("canary is none") stays in the step's log.
    expect((await instance.getError()).message).toContain('NonRetryableError')
    expect(await env.ROTATION_REGISTRY.get('shop-sessions:rotation:keyring:lock', 'json')).toBe(id)
    await env.ROTATION_REGISTRY.delete('shop-sessions:rotation:keyring:lock')
  })
})
