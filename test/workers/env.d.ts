import type { Env as TestEnv } from './entry.js'

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {}
  }
}
