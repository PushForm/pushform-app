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

/** Opens connections to the catalog and file hosts while the bundle downloads, so the first requests skip DNS and TLS setup. */
function preconnect(env: Record<string, string>): Plugin {
  return {
    name: 'commons-preconnect',
    transformIndexHtml() {
      const origins = new Set<string>();
      for (const value of [env.VITE_SUPABASE_URL, env.VITE_COMMONS_ASSETS_URL, env.VITE_COMMONS_CATALOG_URL]) {
        try { if (value?.trim()) origins.add(new URL(value.trim()).origin); } catch { /* Invalid settings fail later, where they are checked. */ }
      }
      // Catalog and file requests omit credentials, so the connection must be opened in anonymous mode to be reused.
      return [...origins].map(origin => ({ tag: 'link', attrs: { rel: 'preconnect', href: origin, crossorigin: '' }, injectTo: 'head' as const }));
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');
  return {
    plugins: [react(), seoConfig(env), preconnect(env)],
    server: { port: 5176, strictPort: true },
    preview: { port: 4176, strictPort: true },
    build: {
      target: 'es2022',
      rollupOptions: { output: {
        // Libraries change far less often than Commons itself. Kept in their own files, they stay cached across releases.
        manualChunks(id: string) {
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          if (/\/node_modules\/(@supabase|tslib|iceberg-js)\//.test(id)) return 'supabase';
          if (/\/node_modules\/zod\//.test(id)) return 'zod';
          return undefined;
        },
      } },
    },
  };
});
