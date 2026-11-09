// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { defineConfig } from 'vitest/config';

// Every InlineBackend runs on the Rust kernel's WebAssembly module (see the setup file).
const kernelSetup = ['packages/kernel/src/test/rustKernelSetup.ts'];

export default defineConfig({
  test: {
    // Fails the run with one clear message when the kernel module is missing or out of date.
    globalSetup: ['scripts/vitest-kernel-check.mjs'],
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          env: { PUSHFORM_VERIFY_REUSED_REBUILDS: '1' },
          setupFiles: kernelSetup,
          include: [
            'packages/{core,geom,kernel,model,layout,inference,commands,io,mcp,cloud,testing,requests-core,extension-protocol,extensions,extension-sdk,extension-dev}/**/*.test.ts',
            'workers/*/src/**/*.test.ts',
            'scripts/*.test.mjs',
          ],
          // Local Supabase stack suites run separately with `pnpm test:stack` (vitest.stack.config.ts).
          exclude: ['**/node_modules/**', '**/*.stack.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          env: { PUSHFORM_VERIFY_REUSED_REBUILDS: '1' },
          setupFiles: kernelSetup,
          include: ['packages/{render,ui,requests-ui}/**/*.test.{ts,tsx}', 'apps/{web,commons}/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
