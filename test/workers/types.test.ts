// Type-level checks, enforced by `tsc -p test/workers/tsconfig.json` (pnpm run typecheck). The runtime part only
// confirms the wrappers hand the class back.

import type { DurableObject } from 'cloudflare:workers'
import { expect, expectTypeOf, it } from 'vitest'

import { createShopSessionsDurableObject } from '../../src/durable-object.js'
import type { ShopSessionsDurableObject, ShopSessionsDurableObjectClass } from '../../src/durable-object.js'
import type { ShopSessionsRpc } from '../../src/types.js'

type AppEnv = { SENTRY_DSN: string; SESSION: KVNamespace; LEGACY?: KVNamespace; SHOP_SESSIONS_MIGRATE?: string }
type SentryOptions = { dsn?: string; enableRpcTracePropagation?: boolean }

/** The signature of `instrumentDurableObjectWithSentry` in @sentry/cloudflare 10.x, as an identity function. */
function instrumentDurableObjectWithSentry<
  E,
  T extends DurableObject<E>,
  C extends new (state: DurableObjectState, env: E) => T,
>(optionsCallback: (env: E) => SentryOptions, DurableObjectClass: C): C {
  void optionsCallback
  return DurableObjectClass
}

/** Any wrapper generic over a Durable Object constructor, with `DurableObject`'s default env (`Cloudflare.Env`). */
function wrapDurableObject<E>() {
  return <T extends new (ctx: DurableObjectState, env: E) => DurableObject>(_options: unknown, cls: T): T => cls
}

const ShopSessionsClass = createShopSessionsDurableObject<AppEnv>({
  registry: (env) => ({ kv: env.SESSION }),
  legacyKv: (env) => env.LEGACY,
  migrateLegacy: (env) => env.SHOP_SESSIONS_MIGRATE === 'on',
  report: (error, context) => void [error.message, context.op],
})

it('passes through Sentry-style Durable Object wrappers with its type intact', () => {
  const Instrumented = instrumentDurableObjectWithSentry(
    (env: AppEnv) => ({ dsn: env.SENTRY_DSN, enableRpcTracePropagation: true }),
    ShopSessionsClass,
  )
  expectTypeOf(Instrumented).toEqualTypeOf<ShopSessionsDurableObjectClass<AppEnv>>()
  expect(Instrumented).toBe(ShopSessionsClass)

  // Apps on `wrangler types` use `Cloudflare.Env` as their Env.
  const WorkerEnvClass = createShopSessionsDurableObject<Cloudflare.Env>({ registry: (env) => ({ kv: env.REGISTRY }) })
  const Wrapped = wrapDurableObject<Cloudflare.Env>()({}, WorkerEnvClass)
  expectTypeOf(Wrapped).toEqualTypeOf<ShopSessionsDurableObjectClass<Cloudflare.Env>>()

  expectTypeOf<ShopSessionsDurableObject<AppEnv>>().toExtend<DurableObject<AppEnv>>()
  expectTypeOf<ShopSessionsDurableObject<AppEnv>>().toExtend<ShopSessionsRpc>()
  expectTypeOf<InstanceType<typeof ShopSessionsClass>['alarm']>().toEqualTypeOf<() => Promise<void>>()
  // The stub of a namespace bound to the class exposes the RPC methods.
  expectTypeOf<DurableObjectStub<ShopSessionsDurableObject<AppEnv>>['getSession']>().toBeFunction()

  class NotADurableObject {
    constructor(_ctx: DurableObjectState, _env: AppEnv) {}
  }
  // @ts-expect-error Sentry's wrapper only takes Durable Object classes.
  instrumentDurableObjectWithSentry((env: AppEnv) => ({ dsn: env.SENTRY_DSN }), NotADurableObject)
})

it('requires a registry', () => {
  // @ts-expect-error `registry` is required.
  expect(() => createShopSessionsDurableObject<AppEnv>({})).toThrow(/registry/)
})
