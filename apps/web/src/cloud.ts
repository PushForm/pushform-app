// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { CloudSession, createBrowserCloud } from '@pushform/cloud';
import type { RequestsConfig } from '@pushform/ui';

export function configuredCloud() {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;
  const none = { session: new CloudSession(null), files: undefined, profiles: undefined, account: undefined, usage: undefined, staff: undefined };
  if (!url || !publishableKey) return none;
  try { return createBrowserCloud({ url, publishableKey }); }
  catch { return none; }
}

/**
 * Feature request backend: `VITE_FR_BACKEND_URL` when set, otherwise the project's
 * `fr-conversation` Edge Function. Only the publishable key travels with requests. `VITE_FR_REGION`
 * pins the function to the database's region (e.g. `us-east-1`) so its database calls stay in-region.
 */
export function configuredRequests(): RequestsConfig | undefined {
  const url: string = import.meta.env.VITE_SUPABASE_URL ?? '';
  const apikey: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || '';
  const baseUrl: string = import.meta.env.VITE_FR_BACKEND_URL || (url ? `${url.replace(/\/+$/, '')}/functions/v1/fr-conversation` : '');
  if (!baseUrl || !apikey) return undefined;
  const region: string = import.meta.env.VITE_FR_REGION ?? '';
  return { baseUrl, apikey, ...(region ? { region } : {}) };
}

export const { session: cloudSession, files: cloudFiles, profiles: cloudProfiles, account: cloudAccount, usage: cloudUsage, staff: cloudStaff } = configuredCloud();
export const requestsConfig = configuredRequests();
if (import.meta.hot) import.meta.hot.dispose(() => cloudSession.dispose());
