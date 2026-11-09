// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Every InlineBackend runs on the Rust kernel's WebAssembly module (see the setup file).
const kernelSetup = ['packages/kernel/src/test/rustKernelSetup.ts'];
// Until the web build makes Rust its default, PF_KERNEL=rust also moves solid validation onto it.
const rust = process.env.PF_KERNEL === 'rust';
const rustResolve = rust ? { alias: { '@pushform/kernel/rust-wasm': fileURLToPath(new URL('packages/kernel/src/rustWasm.ts', import.meta.url)) } } : {};
const rustDefine = rust ? { __PF_RUST_KERNEL__: 'true' } : {};

export default defineConfig({
  resolve: rustResolve,
  define: rustDefine,
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
