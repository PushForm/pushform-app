// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Cloud configuration checks shared by the browser client and the release scripts. No imports,
// so `scripts/*.mjs` can load this file directly under Node's type stripping.

export interface BrowserCloudConfig { url: string; publishableKey: string }

/** The `role` claim of a JWT-shaped string, or null when it is not one. */
function jwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const role = (JSON.parse(atob(payload)) as { role?: unknown }).role;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

/** Reject server credentials before they can be put in any browser request. */
export function validateBrowserCloudConfig(config: BrowserCloudConfig): BrowserCloudConfig {
  const url = new URL(config.url.trim()), key = config.publishableKey.trim();
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password ||
      url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Invalid cloud project URL.');
  const isPublic = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key) || jwtRole(key) === 'anon';
  if (!isPublic) throw new Error('Cloud configuration requires a public publishable or anon key.');
  return { url: url.origin, publishableKey: key };
}

/**
 * The cloud configuration a release build bakes in, from its `VITE_SUPABASE_*` variables: the URL and
 * the publishable key, else the legacy anon key. Throws, naming what is wrong, when either is missing or invalid.
 */
export function releaseCloudConfig(env: Record<string, string | undefined>): BrowserCloudConfig {
  const url = env.VITE_SUPABASE_URL?.trim() ?? '';
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() || env.VITE_SUPABASE_ANON_KEY?.trim() || '';
  if (!url) throw new Error('VITE_SUPABASE_URL is not set.');
  if (!publishableKey) throw new Error('Neither VITE_SUPABASE_PUBLISHABLE_KEY nor VITE_SUPABASE_ANON_KEY is set.');
  try {
    new URL(url);
  } catch {
    throw new Error('VITE_SUPABASE_URL is not a URL.');
  }
  return validateBrowserCloudConfig({ url, publishableKey });
}

/**
 * Server credentials found in shipped text: Supabase secret keys (`sb_secret_…`) and JWTs whose role is
 * `service_role`. Each finding is described without the credential itself, so it can be logged.
 */
export function serverCredentialsIn(text: string): string[] {
  const found: string[] = [];
  const secrets = text.match(/sb_secret_[A-Za-z0-9_-]+/g)?.length ?? 0;
  if (secrets) found.push(`${secrets} Supabase secret key${secrets === 1 ? '' : 's'} (sb_secret_…)`);
  let serviceRole = 0;
  for (const token of text.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? []) if (jwtRole(token) === 'service_role') serviceRole++;
  if (/"role"\s*:\s*"service_role"/.test(text)) serviceRole++;
  if (serviceRole) found.push(`${serviceRole} service-role credential${serviceRole === 1 ? '' : 's'}`);
  return found;
}
