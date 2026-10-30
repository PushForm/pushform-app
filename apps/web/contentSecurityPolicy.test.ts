// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  allPathHeaders,
  contentSecurityPolicy,
  CSP_HEADER,
  desktopContentSecurityPolicy,
  sentryCspReportUrl,
  withCspHeader,
  withReportUri,
} from './contentSecurityPolicy';
import { FRAME_BOOTSTRAP_SHA256 } from '@pushform/extensions/frame-bootstrap';
import { PRODUCTION_SENTRY_DSN, sentryDsnFor } from './src/sentryDsn';

const directives = (policy: string): Map<string, string[]> =>
  new Map(policy.split('; ').map(directive => { const [name, ...sources] = directive.split(' '); return [name!, sources]; }));

describe('contentSecurityPolicy', () => {
  const web = directives(contentSecurityPolicy('web', {
    supabaseUrls: ['https://abc.supabase.co/'],
    backendUrls: ['https://abc.supabase.co/functions/v1/fr-conversation', undefined, 'https://jobs.example.test/fr-jobs'],
    sentryDsn: PRODUCTION_SENTRY_DSN,
  }));

  it('allows only the build\'s own Supabase project, over HTTPS and Realtime\'s WebSocket', () => {
    expect(web.get('connect-src')).toEqual(expect.arrayContaining(["'self'", 'https://abc.supabase.co', 'wss://abc.supabase.co', 'https://jobs.example.test']));
    expect(web.get('connect-src')!.filter(source => source.includes('supabase'))).toHaveLength(2);
    expect(web.get('img-src')).toContain('https://abc.supabase.co');
  });

  it('lets the kernel compile its wasm without allowing eval', () => {
    expect(web.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'", 'blob:', `'sha256-${FRAME_BOOTSTRAP_SHA256}'`]);
    expect(web.get('script-src')).not.toContain("'unsafe-eval'");
    expect(web.get('script-src')).not.toContain("'unsafe-inline'");
    expect(web.get('worker-src')).toEqual(["'self'", 'blob:']);
  });

  it('allows Google Fonts, the 3D text font CDN and the Sentry project, and reports to Sentry', () => {
    expect(web.get('style-src')).toContain('https://fonts.googleapis.com');
    expect(web.get('font-src')).toContain('https://fonts.gstatic.com');
    expect(web.get('connect-src')).toEqual(expect.arrayContaining(['https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net', 'https://o4512324800806912.ingest.us.sentry.io']));
    expect(web.get('report-uri')).toEqual(['https://o4512324800806912.ingest.us.sentry.io/api/4512324821385216/security/?sentry_key=a2f78afa4c19ca41aa65fbd037522489']);
    expect(web.get('object-src')).toEqual(["'none'"]);
    expect(web.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('gives the admin console no wasm, blob scripts, fonts or report endpoint', () => {
    const admin = directives(contentSecurityPolicy('admin', { supabaseUrls: ['http://127.0.0.1:54321'] }));
    expect(admin.get('script-src')).toEqual(["'self'"]);
    expect(admin.get('connect-src')).toEqual(["'self'", 'http://127.0.0.1:54321', 'ws://127.0.0.1:54321']);
    expect(admin.has('report-uri')).toBe(false);
  });

  it('skips missing or invalid URLs and a disabled Sentry DSN', () => {
    const policy = directives(contentSecurityPolicy('web', { supabaseUrls: ['', 'not a url'], sentryDsn: sentryDsnFor({ VITE_SENTRY_DSN: '' }, true) }));
    expect(policy.get('connect-src')).toEqual(["'self'", 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'blob:', 'data:']);
    expect(policy.has('report-uri')).toBe(false);
  });

  it('keeps the desktop webview\'s policy in tauri.conf.json up to date', () => {
    const config = JSON.parse(readFileSync(new URL('../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as { app: { security: { csp: string; devCsp: unknown } } };
    expect(config.app.security.csp).toBe(desktopContentSecurityPolicy());
    expect(config.app.security.devCsp).toBeNull();
    const desktop = directives(desktopContentSecurityPolicy());
    expect(desktop.get('connect-src')).toEqual(expect.arrayContaining(['ipc:', 'http://ipc.localhost', 'https://pnbbxhxqpdqxupnbqyvf.supabase.co', 'wss://pnbbxhxqpdqxupnbqyvf.supabase.co']));
  });
});

describe('sentryCspReportUrl', () => {
  it('turns a DSN into its security endpoint', () => {
    expect(sentryCspReportUrl('https://key@o1.ingest.us.sentry.io/42')).toBe('https://o1.ingest.us.sentry.io/api/42/security/?sentry_key=key');
    expect(sentryCspReportUrl(undefined)).toBeNull();
    expect(sentryCspReportUrl('https://o1.ingest.us.sentry.io/42')).toBeNull();
  });
});

describe('_headers', () => {
  const headers = '/*\n  X-Content-Type-Options: nosniff\n\n/assets/*\n  Cache-Control: immutable\n';

  it('adds the policy to the /* block once, replacing an earlier one', () => {
    const once = withCspHeader(headers, "default-src 'self'");
    expect(withCspHeader(once, "default-src 'none'")).toBe(withCspHeader(headers, "default-src 'none'"));
    expect(allPathHeaders(once)).toEqual([[CSP_HEADER, "default-src 'self'"], ['X-Content-Type-Options', 'nosniff']]);
  });

  it('refuses a file without a /* block', () => {
    expect(() => withCspHeader('/assets/*\n  Cache-Control: immutable\n', 'x')).toThrow(/\/\*/);
  });

  it('replaces the report endpoint for local previews', () => {
    expect(withReportUri("default-src 'self'; report-uri https://a.test/r", '/__csp-report')).toBe("default-src 'self'; report-uri /__csp-report");
  });
});
