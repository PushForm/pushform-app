// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'packages/{core,geom,kernel,model,layout,inference,commands,io,mcp,cloud,testing,requests-core,extension-protocol,extensions}/**/*.test.ts',
            'workers/*/src/**/*.test.ts',
            'scripts/*.test.mjs',
          ],
          // Local Supabase stack suites run separately with `pnpm test:stack` (vitest.stack.config.ts).
          exclude: ['**/node_modules/**', '**/*.stack.test.ts'],
        },
      },
      {
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['packages/{render,ui,requests-ui}/**/*.test.{ts,tsx}', 'apps/web/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
