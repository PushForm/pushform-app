// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { CloudSession } from './CloudSession';

it('persists a verified session through the real SDK, restores it, and removes it on browser sign-out', async () => {
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); } };
  const user = { id: 'user-1', email: 'artist@example.com', aud: 'authenticated',
    app_metadata: {}, user_metadata: {}, created_at: '' };
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input); calls.push(url);
    const body = url.includes('/verify') ? { access_token: 'private-access', refresh_token: 'private-refresh',
      token_type: 'bearer', expires_in: 3600, user } : url.includes('/user') ? user : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const makeClient = () => createClient('https://test.supabase.co', 'sb_publishable_test', { global: { fetch: fetcher },
    auth: { storage, storageKey: 'session-test', persistSession: true, autoRefreshToken: false,
      detectSessionInUrl: false, flowType: 'pkce' } });
  const first = makeClient(), cloud = new CloudSession(first.auth, 'https://app.example/auth/callback');
  let restored: CloudSession | undefined, second: ReturnType<typeof makeClient> | undefined;
  try {
    await cloud.start(); expect(cloud.getSnapshot().status).toBe('signedOut');
    expect(await cloud.sendSignInEmail('artist@example.com')).toBe(true);
    expect(await cloud.verifyCode('123456')).toBe(true);
    expect(saved.get('session-test')).toContain('private-refresh');
    cloud.dispose(); await first.auth.dispose();
    second = makeClient(); restored = new CloudSession(second.auth); await restored.start();
    expect(restored.getSnapshot().user?.email).toBe('artist@example.com');
    expect(await restored.signOut()).toBe(true); expect(saved.has('session-test')).toBe(false);
    expect(calls.some(url => url.includes('/logout?scope=local'))).toBe(true);
  } finally { cloud.dispose(); restored?.dispose(); await first.auth.dispose(); await second?.auth.dispose(); }
});
