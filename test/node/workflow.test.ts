import { describe, expect, it } from 'vitest'

import { createRotateSecretsWorkflow, rotationKeys } from '../../src/workflow.js'
import type { RotationParams } from '../../src/workflow.js'
import { FakeKV } from './core/fakes.js'
import { NonRetryableError } from './support/cloudflare-workflows.js'

type Env = {
  REGISTRY: FakeKV
  LEGACY: FakeKV
  SHOP_SESSIONS: { idFromName(name: string): unknown; get(id: never): unknown }
}

const CANARY = 'canary.myshopify.com'

function env(): Env {
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      describe: async ({ shop }: { shop: string }) => ({
        shop,
        exists: true,
        state: 'legacy',
        nextAlarmAt: null,
        keyring: { kids: ['k1'] },
        credentials: { credFp: 'fp' },
      }),
    }),
  }
  return { REGISTRY: new FakeKV(), LEGACY: new FakeKV(), SHOP_SESSIONS: namespace }
}

/** The platform step, reduced to running each callback once. */
const step = {
  do: async (_name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) =>
    (callback ?? (configOrCallback as () => Promise<unknown>))(),
  sleep: async () => {},
  waitForEvent: async () => ({}),
}

describe('createRotateSecretsWorkflow', () => {
  it('runs the rotation with the bindings it is given and fails with NonRetryableError', async () => {
    const RotateSecrets = createRotateSecretsWorkflow<Env>({
      registry: (e) => ({ kv: e.REGISTRY, prefix: 'custom:' }),
      namespace: (e) => e.SHOP_SESSIONS,
      legacyKv: (e) => e.LEGACY,
    })
    const bindings = env()
    const workflow = new RotateSecrets({} as ExecutionContext, bindings)
    const event = {
      payload: { kind: 'keyring', canaryShop: CANARY } satisfies RotationParams,
      instanceId: 'instance-1',
      timestamp: new Date(),
      workflowName: 'rotate-secrets',
    }

    const error = await workflow.run(event, step as never).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NonRetryableError)
    expect((error as Error).message).toMatch('canary is legacy')
    // The lock went to the registry KV it was given, under the instance id.
    expect(bindings.REGISTRY.data.get(rotationKeys('keyring').lock)?.value).toBe(JSON.stringify('instance-1'))
  })
})
