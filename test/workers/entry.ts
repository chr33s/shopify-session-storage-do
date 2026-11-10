// The Worker the integration tests run: the package's Durable Object over the fake Shopify token endpoint.

import { createShopSessionsDurableObject } from '../../src/durable-object.js'
import { createRotateSecretsWorkflow } from '../../src/workflow.js'
import type { RotationParams } from '../../src/workflow.js'
import type { ShopSessionsDurableObject } from '../../src/durable-object.js'
import { APP_KEY_ID, APP_PRIVATE_JWK, clock, fakeShopify } from './fake-shopify.js'

export type Env = {
  SHOP_SESSIONS: DurableObjectNamespace<ShopSessionsDurableObject<Env>>
  BROKEN_KEYRING: DurableObjectNamespace<ShopSessionsDurableObject<Env>>
  NO_CREDENTIALS: DurableObjectNamespace<ShopSessionsDurableObject<Env>>
  APP_TOKENS: DurableObjectNamespace<ShopSessionsDurableObject<Env>>
  REGISTRY: KVNamespace
  LEGACY: KVNamespace
  ROTATION_REGISTRY: KVNamespace
  ROTATE_SECRETS: Workflow<RotationParams>
  SHOPIFY_API_KEY: string
  SHOPIFY_API_SECRET: string
  SHOPIFY_SESSION_ENCRYPTION_KEYS: string
  /** The project's compatibility date, for tests of date-dependent platform behaviour. */
  TEST_COMPATIBILITY_DATE: string
}

const testing = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fakeShopify().fetch(input, init),
  now: () => clock.now(),
}

export const TestShopSessions = createShopSessionsDurableObject<Env>({
  registry: (env) => ({ kv: env.REGISTRY }),
  legacyKv: (env) => env.LEGACY,
  migrateLegacy: () => true,
  ...testing,
})

export const AppTokenShopSessions = createShopSessionsDurableObject<Env>({
  registry: (env) => ({ kv: env.REGISTRY }),
  appTokenKey: () => ({ kid: APP_KEY_ID, alg: 'ES256', privateKey: APP_PRIVATE_JWK }),
  ...testing,
})

export const BrokenKeyringShopSessions = createShopSessionsDurableObject<Env>({
  registry: (env) => ({ kv: env.REGISTRY }),
  encryptionKeys: () => 'bm90IGEga2V5',
  ...testing,
})

export const NoCredentialsShopSessions = createShopSessionsDurableObject<Env>({
  registry: (env) => ({ kv: env.REGISTRY }),
  apiSecretKey: () => '',
  ...testing,
})

export default {
  fetch(): Response {
    return new Response('shop-sessions test worker')
  },
} satisfies ExportedHandler<Env>

export const TestRotateSecrets = createRotateSecretsWorkflow<Env>({
  registry: (env) => ({ kv: env.ROTATION_REGISTRY }),
  namespace: (env) => env.SHOP_SESSIONS,
  // Not LEGACY: other tests leave offline_* keys there. A test that wants one writes it here.
  legacyKv: (env) => env.ROTATION_REGISTRY,
})
