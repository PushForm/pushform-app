// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as CloudModule from '@pushform/cloud';

// Which configuration reaches the browser client (auth review TST-004); the client itself is the real one.
const calls = vi.hoisted(() => [] as { url: string; publishableKey: string }[]);
vi.mock('@pushform/cloud', async importOriginal => {
  const actual = await importOriginal<typeof CloudModule>();
  return { ...actual, createBrowserCloud: (config: { url: string; publishableKey: string }, browser?: Pick<Window, 'location' | 'history'>) => {
    calls.push(config);
    return actual.createBrowserCloud(config, browser);
  } };
});

const PUBLISHABLE = 'sb_publishable_web', ANON = `e30.${btoa(JSON.stringify({ role: 'anon' }))}.signature`;
async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const cloud = await import('./cloud');
  const configured = cloud.configuredCloud();
  return { cloud, configured, requests: cloud.configuredRequests() };
}
afterEach(() => {
  vi.unstubAllEnvs();
  calls.length = 0;
});

describe('web cloud configuration', () => {
  it('runs unconfigured, with no file library, when the project URL or key is missing', async () => {
    for (const env of [{ VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE }, { VITE_SUPABASE_URL: 'https://p.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: '', VITE_SUPABASE_ANON_KEY: '' }]) {
      const { configured, requests } = await load(env);
      expect(configured.session.getSnapshot().status).toBe('unavailable');
      expect(configured).toMatchObject({ files: undefined, profiles: undefined, account: undefined, usage: undefined });
      expect(requests).toBeUndefined();
      configured.session.dispose();
    }
    expect(calls).toEqual([]);
  });
  it('prefers the publishable key, falls back to the legacy anon key, and builds the full client', async () => {
    const first = await load({ VITE_SUPABASE_URL: 'https://p.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE, VITE_SUPABASE_ANON_KEY: ANON });
    expect(calls.at(-1)).toEqual({ url: 'https://p.supabase.co', publishableKey: PUBLISHABLE });
    expect(first.configured.files).toBeDefined(); expect(first.configured.usage).toBeDefined();
    first.configured.session.dispose(); first.cloud.cloudSession.dispose();
    const second = await load({ VITE_SUPABASE_URL: 'https://p.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: '', VITE_SUPABASE_ANON_KEY: ANON });
    expect(calls.at(-1)).toEqual({ url: 'https://p.supabase.co', publishableKey: ANON });
    second.configured.session.dispose(); second.cloud.cloudSession.dispose();
  });
  it('treats a server key or unsafe URL as unconfigured instead of shipping it to the client', async () => {
    for (const env of [{ VITE_SUPABASE_URL: 'https://p.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_leaked' },
      { VITE_SUPABASE_URL: 'http://p.example.com', VITE_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE }]) {
      const { configured } = await load(env);
      expect(configured.files).toBeUndefined();
      expect(configured.session.getSnapshot().status).toBe('unavailable');
      configured.session.dispose();
    }
  });
  it('derives the fr-conversation URL from the project, or takes the override, with the region when set', async () => {
    const derived = await load({ VITE_SUPABASE_URL: 'https://p.supabase.co/', VITE_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE, VITE_FR_BACKEND_URL: '', VITE_FR_REGION: '' });
    expect(derived.requests).toEqual({ baseUrl: 'https://p.supabase.co/functions/v1/fr-conversation', apikey: PUBLISHABLE });
    derived.configured.session.dispose(); derived.cloud.cloudSession.dispose();
    const overridden = await load({ VITE_SUPABASE_URL: 'https://p.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: '', VITE_SUPABASE_ANON_KEY: ANON,
      VITE_FR_BACKEND_URL: 'http://127.0.0.1:54321/functions/v1/fr-conversation', VITE_FR_REGION: 'us-east-1' });
    expect(overridden.requests).toEqual({ baseUrl: 'http://127.0.0.1:54321/functions/v1/fr-conversation', apikey: ANON, region: 'us-east-1' });
    overridden.configured.session.dispose(); overridden.cloud.cloudSession.dispose();
  });
});
