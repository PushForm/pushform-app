// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import type * as Supabase from '@supabase/supabase-js';

// The real SDK client, with its construction options recorded (auth review T1-1).
const created = vi.hoisted(() => [] as { url: string; key: string; options: { auth?: Record<string, unknown> } }[]);
vi.mock('@supabase/supabase-js', async importOriginal => {
  const actual = await importOriginal<typeof Supabase>();
  return { ...actual, createClient: (url: string, key: string, options: { auth?: Record<string, unknown> }) => {
    created.push({ url, key, options });
    return actual.createClient(url, key, options as never);
  } };
});
const { createBrowserCloudSession, createBrowserRpc } = await import('./browser');

const config = { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test' };
function stubBrowser(href: string) {
  const url = new URL(href);
  const replaceState = vi.fn();
  return { browser: { location: { href, origin: url.origin }, history: { state: { tab: 1 }, replaceState } } as unknown as Pick<Window, 'location' | 'history'>, replaceState };
}
afterEach(() => { created.length = 0; });

it.each([
  ['a PKCE code', 'https://app.example/auth/callback?code=secret-code&sb_flow_id=flow'],
  ['an email token hash', 'https://app.example/auth/callback?token_hash=secret-hash&type=email'],
  ['a failed link', 'https://app.example/auth/callback?error=denied&error_description=private'],
])('scrubs %s from the address bar before anything else runs, keeping the history state', (_, href) => {
  const { browser, replaceState } = stubBrowser(href);
  const session = createBrowserCloudSession(config, browser);
  expect(replaceState).toHaveBeenCalledExactlyOnceWith({ tab: 1 }, '', '/');
  session.dispose();
});

it('leaves other addresses alone and never lets the SDK read sessions from the URL', () => {
  const { browser, replaceState } = stubBrowser('https://app.example/?code=not-a-callback#access_token=ignored');
  const session = createBrowserCloudSession(config, browser);
  expect(replaceState).not.toHaveBeenCalled();
  expect(created).toHaveLength(1);
  expect(created[0]!.options.auth).toMatchObject({ flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
    storageKey: 'pushform:auth:example.supabase.co' });
  session.dispose();
});

it('gives the admin console the same scrub and client options', () => {
  const { browser, replaceState } = stubBrowser('https://oregon.example/auth/callback?code=secret-code');
  const { session } = createBrowserRpc(config, browser);
  expect(replaceState).toHaveBeenCalledExactlyOnceWith({ tab: 1 }, '', '/');
  expect(created[0]!.options.auth).toMatchObject({ detectSessionInUrl: false, flowType: 'pkce' });
  session.dispose();
});
