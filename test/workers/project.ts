import { fileURLToPath } from 'node:url'

import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

/** The oldest compatibility date the package supports (README: Requirements). */
export const OLDEST_COMPATIBILITY_DATE = '2024-09-23'

// A fresh keyring per run, so no key ever lives in the repo. Two keys: the second exercises the decrypt-only path.
function randomKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
}
const ENCRYPTION_KEYS = `${randomKey()},${randomKey()}`

/** One Workers project over test/workers/wrangler.jsonc, optionally at another compatibility date. */
export function workersProject(name: string, compatibilityDate?: string) {
  return defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          ...(compatibilityDate ? { compatibilityDate } : {}),
          bindings: {
            SHOPIFY_API_SECRET: 'test-api-secret',
            SHOPIFY_SESSION_ENCRYPTION_KEYS: ENCRYPTION_KEYS,
            TEST_COMPATIBILITY_DATE: compatibilityDate ?? OLDEST_COMPATIBILITY_DATE,
          },
        },
      }),
    ],
    test: {
      name,
      include: ['**/*.test.ts'],
      // Real timers and workerd I/O; a hung token call should fail the test, not stall the run.
      testTimeout: 20_000,
    },
  })
}
