import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// Three projects: `node` for pure logic (fast, no workerd), and the Durable Object in real workerd at the oldest
// consumer's compatibility date (`workers`) and at a current one (`workers-current`).
export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            'cloudflare:workers': fileURLToPath(new URL('./test/node/support/cloudflare-workers.ts', import.meta.url)),
            'cloudflare:workflows': fileURLToPath(
              new URL('./test/node/support/cloudflare-workflows.ts', import.meta.url),
            ),
          },
        },
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/node/**/*.test.ts'],
          clearMocks: true,
          restoreMocks: true,
          unstubGlobals: true,
        },
      },
      './test/workers/vitest.config.ts',
      './test/workers/vitest.current.config.ts',
    ],
  },
})
