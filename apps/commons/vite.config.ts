// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Public build settings the edge worker needs to write search tags (it cannot read `import.meta.env`). They are the same
 * public values the app bundle already carries; no secret belongs here. */
function seoConfig(env: Record<string, string>): Plugin {
  return {
    name: 'commons-seo-config',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'seo-config.json', source: JSON.stringify({
        siteUrl: env.VITE_COMMONS_SITE_URL ?? '',
        supabaseUrl: env.VITE_SUPABASE_URL ?? '',
        publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || '',
        catalogUrl: env.VITE_COMMONS_CATALOG_URL ?? '',
        filesUrl: env.VITE_COMMONS_ASSETS_URL ?? '',
      }) + '\n' });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');
  return {
    plugins: [react(), seoConfig(env)],
    server: { port: 5176, strictPort: true },
    preview: { port: 4176, strictPort: true },
    build: { target: 'es2022' },
  };
});
