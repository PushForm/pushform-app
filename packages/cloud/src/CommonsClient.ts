// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { validateBrowserCloudConfig, type BrowserCloudConfig } from './cloudConfig';
import { catalogModelSchema, catalogSchema, parseCommonsCatalog, type CatalogModel } from './CommonsCatalog';
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

const pageSchema = catalogSchema.safeExtend({
  models: z.array(catalogModelSchema).max(100),
  nextCursor: z.string().regex(/^[a-z0-9][a-z0-9-]{0,95}$/).nullable(),
  asOf: z.iso.datetime({ offset: true }),
});

/** Pages have bounded responses; the library itself has no total model limit. */
export async function readCommonsCatalog(client: Pick<SupabaseClient<Database>, 'rpc'>, signal: AbortSignal): Promise<CatalogModel[]> {
  const models: CatalogModel[] = [], seen = new Set<string>();
  let after: string | null = null, asOf: string | null = null;
  for (;;) {
    signal.throwIfAborted();
    const pageSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const result = await client.rpc('commons_catalog_page', { p_limit: 100, ...(after === null ? {} : {p_after:after}), ...(asOf === null ? {} : {p_as_of:asOf}) }).abortSignal(pageSignal);
    // Supports a rolling deployment where this client arrives before the new endpoint.
    if (!after && result.error && ['PGRST202', '42883'].includes(result.error.code)) {
      const legacy = await client.rpc('commons_catalog').abortSignal(pageSignal);
      if (legacy.error?.message === 'commons_unavailable') throw new CommonsUnavailableError();
      if (legacy.error) throw new Error('Could not load the Commons catalog.');
      return parseCommonsCatalog(legacy.data);
    }
    if (result.error?.message === 'commons_unavailable') throw new CommonsUnavailableError();
    if (result.error) throw new Error('Could not load the Commons catalog.');
    const parsed = pageSchema.safeParse(result.data);
    if (!parsed.success) throw new Error('Catalog metadata is invalid.');
    const page = parsed.data;
    if (asOf !== null && page.asOf !== asOf) throw new Error('Catalog pagination changed. Refresh the catalog.');
    for (const model of page.models) {
      if (seen.has(model.id) || (after !== null && model.id <= after)) throw new Error('Catalog pagination returned a duplicate or invalid model.');
      seen.add(model.id); models.push(model);
    }
    if (page.nextCursor === null) break;
    if (!page.models.length || page.nextCursor !== page.models.at(-1)?.id || (after !== null && page.nextCursor <= after))
      throw new Error('Catalog pagination did not advance.');
    after = page.nextCursor; asOf = page.asOf;
  }
  return models.sort((a,b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
}
