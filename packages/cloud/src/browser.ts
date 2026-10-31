// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db.types';
import { CloudAccount } from './CloudAccount';
import { CloudFiles } from './CloudFiles';
import { CloudProfiles } from './CloudProfile';
import { CloudSession, type AuthCallback } from './CloudSession';
import { CloudStaff } from './CloudStaff';
import { CloudUsage } from './CloudUsage';
import { validateBrowserCloudConfig, type BrowserCloudConfig } from './cloudConfig';

export { releaseCloudConfig, serverCredentialsIn, validateBrowserCloudConfig, type BrowserCloudConfig } from './cloudConfig';

/** Only the dedicated callback route consumes auth parameters; no user-controlled redirect target. */
export function authCallbackFromUrl(url: URL): AuthCallback | null {
  if (url.pathname !== '/auth/callback') return null;
  const hash = new URLSearchParams(url.hash.slice(1));
  if (url.searchParams.has('error') || hash.has('error') || hash.has('access_token')) return { kind: 'error' };
  const code = url.searchParams.get('code');
  if (code) {
    const flowId = url.searchParams.get('sb_flow_id');
    return { kind: 'code', code, ...(flowId ? { flowId } : {}) };
  }
  const tokenHash = url.searchParams.get('token_hash');
  if (tokenHash && url.searchParams.get('type') === 'email') return { kind: 'emailToken', tokenHash };
  return { kind: 'error' };
}

function browserClient(config: BrowserCloudConfig, browser: Pick<Window, 'location' | 'history'>): { client: SupabaseClient<Database>; callback: AuthCallback | null; redirectTo: string } {
  const checked = validateBrowserCloudConfig(config);
  const callback = authCallbackFromUrl(new URL(browser.location.href));
  if (callback) browser.history.replaceState(browser.history.state, '', '/');
  const client = createClient<Database>(checked.url, checked.publishableKey, { auth: {
    flowType: 'pkce', persistSession: true, autoRefreshToken: true,
    detectSessionInUrl: false, // Explicit one-shot exchange exposes errors and removes credentials from the address bar immediately.
    storageKey: `pushform:auth:${new URL(checked.url).host}`,
  } });
  return { client, callback, redirectTo: `${browser.location.origin}/auth/callback` };
}

/** Construct once at app boot; SDK owns persistence, refresh, locks and cross-tab auth notifications. */
export function createBrowserCloud(config: BrowserCloudConfig, browser: Pick<Window, 'location' | 'history'> = window): {
  session: CloudSession; files: CloudFiles; profiles: CloudProfiles; account: CloudAccount; usage: CloudUsage; staff: CloudStaff;
} {
  const { client, callback, redirectTo } = browserClient(config, browser);
  const session = new CloudSession(client.auth, redirectTo, callback,
    () => { files.dispose(); profiles.dispose(); account.dispose(); void client.auth.dispose().catch(() => {}); });
  const files = new CloudFiles(client, session);
  const profiles = new CloudProfiles(client, session);
  const account = new CloudAccount(client, session);
  return { session, files, profiles, account, usage: new CloudUsage(client, session), staff: new CloudStaff(client) };
}

/**
 * Session and client for an application that calls `security definer` functions only, such as the admin console
 *. Same sign-in as the product; no file library.
 */
export function createBrowserRpc(config: BrowserCloudConfig, browser: Pick<Window, 'location' | 'history'> = window): { session: CloudSession; client: SupabaseClient<Database> } {
  const { client, callback, redirectTo } = browserClient(config, browser);
  const session = new CloudSession(client.auth, redirectTo, callback, () => { void client.auth.dispose().catch(() => {}); });
  return { session, client };
}

/** Compatibility entry for consumers that only need authentication. */
export function createBrowserCloudSession(config: BrowserCloudConfig, browser: Pick<Window, 'location' | 'history'> = window): CloudSession {
  return createBrowserCloud(config, browser).session;
}
