// Node stand-in for the `cloudflare:workers` built-in, aliased in vitest.config.ts so the Durable Object shell can be
// unit-tested without workerd. Only what src/durable-object.ts and src/workflow.ts use.

export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState
  protected env: Env

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}

export class WorkflowEntrypoint<Env = unknown> {
  protected ctx: ExecutionContext
  protected env: Env

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}
