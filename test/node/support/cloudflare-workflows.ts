// Node stand-in for the `cloudflare:workflows` built-in, aliased in vitest.config.ts. Only what src/workflow.ts uses.

export class NonRetryableError extends Error {
  constructor(message: string, name = 'NonRetryableError') {
    super(message)
    this.name = name
  }
}
