// The secret-rotation Workflow (spec.secret-rotation.md). Like `./durable-object`, this entry imports `cloudflare:`
// modules; the flow itself is in rotation.ts.

import { WorkflowEntrypoint } from 'cloudflare:workers'
import type { WorkflowEvent, WorkflowSleepDuration, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'

import { runRotation } from './rotation.js'
import type { RotationParams, RotationResult, RotationStep, RotationStepConfig } from './rotation.js'
import type { KVNamespaceLike, ShopSessionsNamespace } from './types.js'

export { rotationKeys } from './rotation.js'
export type {
  ApiSecretRotationResult,
  KeyringRotationResult,
  RotationKind,
  RotationParams,
  RotationResult,
  RotationStraggler,
} from './rotation.js'

export type RotateSecretsWorkflowOptions<Env> = {
  /** The registry KV, as given to the Durable Object. The lock, request and pass state are kept there too. */
  registry: (env: Env) => { kv: KVNamespaceLike; prefix?: string }
  /** The `ShopSessions` Durable Object namespace binding. */
  namespace: (env: Env) => ShopSessionsNamespace
  /** The legacy KVSessionStorage namespace, if the app has one: leftover `offline_*` keys hold up a secret revoke. */
  legacyKv?: (env: Env) => KVNamespaceLike | undefined
  /** Must match the adapter's. */
  locationHint?: string
  /** Must match the Durable Object's setting. */
  allowMyshopifyIo?: boolean
  /** Receives a non-secret error when a rollover pass halts or its request is invalid. */
  report?: (error: Error, env: Env) => void
  /** Keyring retention before the census (default '90 days'). Shorter only for a rehearsal on a staging Worker. */
  keyringRetention?: (env: Env) => string | undefined
}

export type RotateSecretsWorkflowClass<Env> = new (
  ctx: ExecutionContext,
  env: Env,
) => WorkflowEntrypoint<Env, RotationParams> & {
  run(event: Readonly<WorkflowEvent<RotationParams>>, step: WorkflowStep): Promise<RotationResult>
}

/**
 * The Workflow class to export from the Worker and bind under `[[workflows]]` (one name per environment). Start an
 * instance with `env.ROTATE_SECRETS.create({ params: { kind, canaryShop } })` and advance it with `sendEvent`.
 */
export function createRotateSecretsWorkflow<Env>(
  options: RotateSecretsWorkflowOptions<Env>,
): RotateSecretsWorkflowClass<Env> {
  return class RotateSecrets extends WorkflowEntrypoint<Env, RotationParams> {
    override async run(event: Readonly<WorkflowEvent<RotationParams>>, step: WorkflowStep): Promise<RotationResult> {
      const env = this.env
      const registry = options.registry(env)
      const legacyKv = options.legacyKv?.(env)
      const report = options.report
      const retention = options.keyringRetention?.(env)
      return runRotation(event.payload, adapt(step), {
        instanceId: event.instanceId,
        kv: registry.kv,
        namespace: options.namespace(env),
        ...(registry.prefix !== undefined && { registryPrefix: registry.prefix }),
        ...(options.locationHint !== undefined && { locationHint: options.locationHint }),
        ...(options.allowMyshopifyIo !== undefined && { allowMyshopifyIo: options.allowMyshopifyIo }),
        ...(legacyKv && { legacyKv }),
        ...(report && { report: (error: Error) => report(error, env) }),
        ...(retention !== undefined && { keyringRetention: retention }),
        fatal: (message) => new NonRetryableError(message),
      })
    }
  }
}

/** The platform step behind the core's structural one. Outputs are plain JSON, which Rpc serialises. */
function adapt(step: WorkflowStep): RotationStep {
  return {
    do: <T>(name: string, config: RotationStepConfig, callback: () => Promise<T>) =>
      step.do(name, config as WorkflowStepConfig, callback as () => Promise<never>) as Promise<T>,
    sleep: (name, duration) => step.sleep(name, duration as WorkflowSleepDuration),
    waitForEvent: (name, options) =>
      step.waitForEvent(name, { type: options.type, timeout: options.timeout as WorkflowSleepDuration }),
  }
}
