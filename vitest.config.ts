// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// PF_KERNEL=rust runs every InlineBackend on the Rust kernel's WebAssembly module (see the setup file).
const rust = process.env.PF_KERNEL === 'rust';
const kernelSetup = rust ? ['packages/kernel/src/test/rustKernelSetup.ts'] : [];
const rustResolve = rust ? { alias: { '@pushform/kernel/rust-wasm': fileURLToPath(new URL('packages/kernel/src/rustWasm.ts', import.meta.url)) } } : {};
const rustDefine = rust ? { __PF_RUST_KERNEL__: 'true' } : {};

export default defineConfig({
  resolve: rustResolve,
  define: rustDefine,
  test: {
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
