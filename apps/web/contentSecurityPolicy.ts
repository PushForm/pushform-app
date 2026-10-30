// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { PRODUCTION_SENTRY_DSN } from './src/sentryDsn';

/**
 * The Content-Security-Policy of the web app, the admin console and the desktop webview. Built
 * from the build's own cloud configuration, so a trial or local-stack build allows its own Supabase project and nothing
 * else. Imported by both Vite configs (build time) and by contentSecurityPolicy.test.ts, which also keeps the desktop
 * policy in apps/desktop/src-tauri/tauri.conf.json equal to `desktopContentSecurityPolicy()`.
 */
export type CspSurface = 'web' | 'admin' | 'desktop';

/** Sent as report-only until the reports of the deployed app show no violations; then switch to enforcing. */
export const CSP_HEADER = 'Content-Security-Policy-Report-Only';


/** The hosted Supabase project the released desktop app talks to. */
export const HOSTED_SUPABASE_URL = 'https://pnbbxhxqpdqxupnbqyvf.supabase.co';
/** The local Supabase stack (`pnpm db:start`), which desktop development builds may use. */
export const LOCAL_SUPABASE_URLS = ['http://127.0.0.1:54321', 'http://localhost:54321'] as const;

const origin = (url: string | undefined): string | null => {
  if (!url?.trim()) return null;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
};
/** The WebSocket origin Supabase Realtime uses for an HTTP(S) origin. */
const socket = (httpOrigin: string): string => httpOrigin.replace(/^http/, 'ws');

/** Sentry's CSP report endpoint for a DSN (`https://<key>@<host>/<project>`). */
export function sentryCspReportUrl(dsn: string | undefined): string | null {
  if (!dsn?.trim()) return null;
  try {
    const url = new URL(dsn.trim());
    const project = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!url.username || !project) return null;
    return `${url.origin}/api/${project}/security/?sentry_key=${url.username}`;
  } catch {
    return null;
  }
}

export interface CspInput {
  /** `VITE_SUPABASE_URL` values: REST, Auth, Storage, Edge Functions and Realtime. */
  readonly supabaseUrls: readonly string[];
  /** Other backends the bundle calls: `VITE_FR_BACKEND_URL`, `VITE_FR_JOBS_URL`. */
  readonly backendUrls?: readonly (string | undefined)[];
  /** The Sentry DSN the bundle reports to, if any; also receives the policy's violation reports. */
  readonly sentryDsn?: string | undefined;
}

export function contentSecurityPolicy(surface: CspSurface, input: CspInput): string {
  const supabase = [...new Set(input.supabaseUrls.map(origin).filter((o): o is string => o !== null))];
  const backends = (input.backendUrls ?? []).map(origin).filter((o): o is string => o !== null);
  const sentry = origin(input.sentryDsn);
  const report = sentryCspReportUrl(input.sentryDsn);
  const product = surface !== 'admin';
  const unique = (sources: readonly (string | false | null)[]): string => [...new Set(sources.filter(Boolean))].join(' ');
  const directives: [string, string][] = [
    ['default-src', "'self'"],
    // 'wasm-unsafe-eval' compiles the Manifold kernel. blob: lets troika-three-text's workers importScripts the
    // modules they are sent (3D text), and only scripts already running can make blob: URLs.
    ['script-src', unique(["'self'", product && "'wasm-unsafe-eval'", product && 'blob:'])],
    ['worker-src', unique(["'self'", product && 'blob:'])],
    // React and the canvas UIs set style attributes; Layout loads Google Fonts' stylesheets.
    ['style-src', unique(["'self'", "'unsafe-inline'", product && 'https://fonts.googleapis.com'])],
    ['font-src', unique(["'self'", 'data:', product && 'https://fonts.gstatic.com'])],
    // Images and textures are shown from blob: and data: URLs made from bytes the app downloaded.
    ['img-src', unique(["'self'", 'blob:', 'data:', ...supabase])],
    ['media-src', unique(["'self'", 'blob:'])],
    ['connect-src', unique([
      "'self'",
      ...supabase,
      ...supabase.map(socket),
      ...backends,
      sentry,
      // The desktop shell's IPC (Tauri 2).
      surface === 'desktop' && 'ipc:',
      surface === 'desktop' && 'http://ipc.localhost',
      // troika-three-text's Unicode font fallback for 3D text (until PF-249 bundles a font).
      product && 'https://cdn.jsdelivr.net',
      // PDF export fetches font programs to embed selectable, subset text.
      product && 'https://fonts.googleapis.com',
      product && 'https://fonts.gstatic.com',
      product && 'blob:',
      product && 'data:',
    ])],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
  ];
  if (report) directives.push(['report-uri', report]);
  return directives.map(([name, value]) => `${name} ${value}`).join('; ');
}

/** The desktop webview's policy: the hosted project and the local stack, reporting to the production Sentry project. */
export function desktopContentSecurityPolicy(): string {
  return contentSecurityPolicy('desktop', { supabaseUrls: [HOSTED_SUPABASE_URL, ...LOCAL_SUPABASE_URLS], sentryDsn: PRODUCTION_SENTRY_DSN });
}

/** `_headers` with the policy added to the `/*` block, which every Cloudflare Pages response matches. */
export function withCspHeader(headers: string, policy: string, header = CSP_HEADER): string {
  const lines = headers.split(/\r?\n/);
  const block = lines.findIndex(line => line.trim() === '/*');
  if (block < 0) throw new Error('_headers has no "/*" block for the Content-Security-Policy');
  const kept = lines.filter(line => !/^\s+Content-Security-Policy(-Report-Only)?:/i.test(line));
  const at = kept.findIndex(line => line.trim() === '/*');
  kept.splice(at + 1, 0, `  ${header}: ${policy}`);
  return kept.join('\n');
}

/** The headers of the `/*` block of a `_headers` file, which every response matches. */
export function allPathHeaders(headers: string): [string, string][] {
  const out: [string, string][] = [];
  let inBlock = false;
  for (const line of headers.split(/\r?\n/)) {
    if (!/^\s/.test(line)) { inBlock = line.trim() === '/*'; continue; }
    const m = inBlock ? /^\s+([\w-]+):\s*(.*)$/.exec(line) : null;
    if (m) out.push([m[1]!, m[2]!]);
  }
  return out;
}

/** Where `vite preview` collects violation reports, which it prints instead of sending them to Sentry. */
const PREVIEW_REPORTS = '/__csp-report';

/** The policy with its `report-uri` replaced. */
export function withReportUri(policy: string, uri: string): string {
  return [...policy.split('; ').filter(directive => !directive.startsWith('report-uri ')), `report-uri ${uri}`].join('; ');
}

/**
 * Writes the policy into the built `_headers`. `vite preview` sends that file's `/*` headers, so a local preview
 * behaves like the deployment, except that it prints violation reports in its terminal. With `PF_CSP_ENFORCE=1` it
 * sends the policy as an enforcing `Content-Security-Policy`, to try enforcement locally. The dev server sends none:
 * Vite's HMR runs inline scripts.
 */
export function contentSecurityPolicyPlugin(policy: () => string): Plugin {
  let outDir = 'dist';
  return {
    name: 'pushform-content-security-policy',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configurePreviewServer(server) {
      const enforce = process.env.PF_CSP_ENFORCE === '1';
      const headers = allPathHeaders(readFileSync(join(outDir, '_headers'), 'utf8')).map(([name, value]): [string, string] =>
        name === CSP_HEADER ? [enforce ? 'Content-Security-Policy' : name, withReportUri(value, PREVIEW_REPORTS)] : [name, value]);
      server.middlewares.use(PREVIEW_REPORTS, (req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const report = (JSON.parse(body) as { 'csp-report'?: Record<string, string> })['csp-report'] ?? {};
            server.config.logger.warn(`CSP violation: ${report['effective-directive'] ?? report['violated-directive']} blocked ${report['blocked-uri']} in ${report['source-file'] ?? report['document-uri']}:${report['line-number'] ?? '?'}:${report['column-number'] ?? '?'}`);
          } catch {
            server.config.logger.warn(`CSP report: ${body}`);
          }
          res.statusCode = 204;
          res.end();
        });
      });
      server.middlewares.use((_req, res, next) => {
        for (const [name, value] of headers) res.setHeader(name, value);
        next();
      });
    },
    writeBundle() {
      const file = join(outDir, '_headers');
      writeFileSync(file, withCspHeader(readFileSync(file, 'utf8'), policy()));
    },
  };
}
