// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { catalogSchema, catalogUrlSchema as link, createCommonsClient, readCommonsCatalog, type BrowserCloudConfig, type CatalogModel } from '@pushform/cloud';
export { catalogSchema, type CatalogModel } from '@pushform/cloud';

export interface CatalogFilters { query: string; category: string; license: string; commercial: boolean }
export type CatalogLoader = (signal: AbortSignal) => Promise<CatalogModel[]>;

export function filterModels(models: CatalogModel[], filters: CatalogFilters): CatalogModel[] {
  const words = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((model) => {
    if (filters.category && model.category !== filters.category) return false;
    if (filters.license && !model.licenses.some((license) => license.name === filters.license)) return false;
    if (filters.commercial && !model.licenses.every((license) => license.commercialUse === 'allowed')) return false;
    const searchable = [model.title, model.description, model.creator, model.category, ...model.tags,
      model.source?.name ?? '', ...model.credits.map((credit) => credit.name), ...model.licenses.map((license) => license.name)]
      .join(' ').toLocaleLowerCase();
    return words.every((word) => searchable.includes(word));
  }).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id));
}

/** Missing configuration is distinct from a working but empty catalog. */
export function createCatalogLoader(endpoint: string | undefined, fetcher: typeof fetch = fetch): CatalogLoader | null {
  if (!endpoint?.trim()) return null;
  return async (signal) => {
    const url = link.safeParse(endpoint.trim());
    if (!url.success) throw new Error('Invalid catalog endpoint.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(abort, 15000);
    try {
      const response = await fetcher(url.data, {
        signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Catalog request failed.');
      const body = await response.text();
      if (new TextEncoder().encode(body).byteLength > 2 * 1024 * 1024) throw new Error('Catalog response is too large.');
      const parsed = catalogSchema.safeParse(JSON.parse(body));
      if (!parsed.success) throw new Error('Catalog metadata is invalid.');
      return parsed.data.models;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  };
}

/** An explicit snapshot endpoint takes precedence; otherwise use the public database catalog RPC. */
export function configuredCatalogLoader(env: Record<string, string | undefined>): CatalogLoader | null {
  if (env.VITE_COMMONS_CATALOG_URL?.trim()) return createCatalogLoader(env.VITE_COMMONS_CATALOG_URL);
  const config: BrowserCloudConfig = { url: env.VITE_SUPABASE_URL ?? '',
    publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || '' };
  if (!config.url && !config.publishableKey) return null;
  try {
    const client = createCommonsClient(config);
    return async (signal) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) controller.abort();
      const timeout = setTimeout(abort, 15000);
      try { return await readCommonsCatalog(client, controller.signal); }
      finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
    };
  } catch {
    return async () => { throw new Error('Invalid catalog configuration.'); };
  }
}
