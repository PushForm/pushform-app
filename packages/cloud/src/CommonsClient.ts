// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { validateBrowserCloudConfig, type BrowserCloudConfig } from './cloudConfig';
import { parseCommonsCatalog, type CatalogModel } from './CommonsCatalog';
import type { Database } from './db.types';

export class CommonsUnavailableError extends Error {
  constructor() { super('The Commons catalog is not available yet.'); this.name = 'CommonsUnavailableError'; }
}

/** Public reads use no persisted user session and never consume an editor auth callback. */
export function createCommonsClient(config: BrowserCloudConfig): SupabaseClient<Database> {
  const checked = validateBrowserCloudConfig(config);
  return createClient<Database>(checked.url, checked.publishableKey, { auth: {
    persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
  } });
}

export async function readCommonsCatalog(client: Pick<SupabaseClient<Database>, 'rpc'>, signal: AbortSignal): Promise<CatalogModel[]> {
  const result = await client.rpc('commons_catalog').abortSignal(signal);
  if (result.error?.message === 'commons_unavailable') throw new CommonsUnavailableError();
  if (result.error) throw new Error('Could not load the Commons catalog.');
  return parseCommonsCatalog(result.data);
}
