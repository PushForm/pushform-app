// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { gitVersion } from './buildVersion';
import { contentSecurityPolicy, contentSecurityPolicyPlugin } from './contentSecurityPolicy';
import { extensionWorkerPlugin } from './extensionRuntime';
import { sentryDsnFor } from './src/sentryDsn';
import react from '@vitejs/plugin-react';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Identity of this build, embedded as `__PF_BUILD__` (read by src/buildInfo.ts) and shown in
 * Main menu › About PushForm. Evaluated on every build, so the values never go stale.
 * `VITE_VERSION` (the desktop workflow) and `VITE_RELEASE` (CI and scripts/deploy.mjs) name the
 * version and commit; a build without them derives both from the checkout's HEAD (buildVersion.ts),
 * the commit marked `-dirty` when the working tree has uncommitted changes.
 */
function buildInfo(): { version: string; commit: string; date: string } {
  const version = process.env.VITE_VERSION || gitVersion(repoRoot) || 'unknown';
  const git = (args: string): string | null => {
    try {
      return execSync(`git ${args}`, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const head = git('rev-parse --short HEAD');
  const commit = process.env.VITE_RELEASE || (head ? `${head}${git('status --porcelain') ? '-dirty' : ''}` : 'unknown');
  return { version, commit, date: new Date().toISOString() };
}

/**
 * The cross-origin isolation headers of public/_headers on every dev and preview response (reserved for future wasm
 * threads, SharedArrayBuffer). `server.headers` misses some of Vite's own module responses, and WebKit refuses a
 * module worker whose imports arrive without them, so they are set by a middleware that runs before Vite's own.
 */
function crossOriginIsolation(): Plugin {
  const headers = (_req: unknown, res: { setHeader(name: string, value: string): void }, next: () => void): void => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  };
  return {
    name: 'pushform-cross-origin-isolation',
    configureServer: (server) => void server.middlewares.use(headers),
    configurePreviewServer: (server) => void server.middlewares.use(headers),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');
  // The policy names this build's own Supabase project and backends.
  const policy = () => contentSecurityPolicy('web', {
    supabaseUrls: [env.VITE_SUPABASE_URL ?? ''],
    backendUrls: [env.VITE_FR_BACKEND_URL, env.VITE_FR_JOBS_URL],
    // Only built bundles send the policy, and they are production bundles (import.meta.env.PROD) in every mode.
    sentryDsn: sentryDsnFor(env, true),
  });
  return {
    plugins: [react(), contentSecurityPolicyPlugin(policy), crossOriginIsolation(), extensionWorkerPlugin()],
    define: {
      __PF_BUILD__: JSON.stringify(buildInfo()),
    },
    server: { port: 5174, strictPort: true },
    worker: { format: 'es' },
    // occt-import-js (the STEP reader) is CommonJS, so the dev server converts it ahead of the worker that loads it.
    optimizeDeps: { exclude: ['manifold-3d'], include: ['occt-import-js'] },
    build: { target: 'es2022', sourcemap: 'hidden' },
    clearScreen: false,
  };
});
