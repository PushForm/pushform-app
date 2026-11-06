// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db.types';
import { catalogModelSchema, type CatalogModel } from './CommonsCatalog';
import { CommonsUnavailableError, readCommonsCatalog } from './CommonsClient';
import { commonsSearchMatcher } from './CommonsSearch';

export interface CommonsBrowseFilters { query: string; category: string; license: string; commercial: boolean }
export interface CommonsBrowseCursor { id: string; publishedAt: string; asOf: string }
export interface CommonsBrowsePage { models: CatalogModel[]; next: CommonsBrowseCursor | null; total: number; categories: string[]; licenses: string[] }
export type CommonsBrowseLoader = (filters: CommonsBrowseFilters, cursor: CommonsBrowseCursor | null, signal: AbortSignal) => Promise<CommonsBrowsePage>;
export type CommonsModelsLoader = (ids: string[], signal: AbortSignal) => Promise<CatalogModel[]>;
const pageSchema = z.object({ version: z.literal(1), models: z.array(catalogModelSchema).max(48),
  nextCursor: z.object({ id: z.string(), publishedAt: z.iso.datetime({ offset: true }) }).nullable(),
  asOf: z.iso.datetime({ offset: true }), total: z.number().int().nonnegative(), categories: z.array(z.string()), licenses: z.array(z.string()),
});
export function filterCommonsModels(models: CatalogModel[], filters: CommonsBrowseFilters): CatalogModel[] {
  const matches = commonsSearchMatcher(filters.query);
  return models.filter(model => (!filters.category || model.category === filters.category)
    && (!filters.license || model.licenses.some(license => license.name === filters.license))
    && (!filters.commercial || model.licenses.every(license => license.commercialUse === 'allowed'))
    && matches([model.title, model.description, model.creator, model.category, ...model.tags, model.source?.name ?? '', ...model.credits.map(credit => credit.name), ...model.licenses.map(license => license.name)].join(' · ')))
    .sort((a,b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
}
export function createCommonsBrowseLoader(client: Pick<SupabaseClient<Database>, 'rpc'>): CommonsBrowseLoader {
  return async (filters, cursor, signal) => {
    const result = await client.rpc('commons_browse', { p_query: filters.query.trim().slice(0, 200), p_category: filters.category, p_license: filters.license, p_commercial: filters.commercial, p_limit: 24,
      ...(cursor ? { p_after_id: cursor.id, p_after_published_at: cursor.publishedAt, p_as_of: cursor.asOf } : {}),
    }).abortSignal(AbortSignal.any([signal, AbortSignal.timeout(15000)]));
    signal.throwIfAborted();
    if (result.error?.message === 'commons_unavailable') throw new CommonsUnavailableError();
    // Older deployments still provide the complete catalog until their browse endpoint arrives.
    if (result.error && ['PGRST202', '42883'].includes(result.error.code)) {
      const all = await readCommonsCatalog(client, signal), models = filterCommonsModels(all, filters);
      return { models, next: null, total: models.length, categories: [...new Set(all.map(model => model.category))].sort(), licenses: [...new Set(all.flatMap(model => model.licenses.map(license => license.name)))].sort() };
    }
    if (result.error) throw new Error('Could not load Commons results. Try again.');
    const page = pageSchema.parse(result.data);
    if (cursor && page.asOf !== cursor.asOf) throw new Error('Commons results changed. Refresh the search.');
    const ids = new Set<string>();
    let previous = cursor;
    for (const model of page.models) {
      if (ids.has(model.id) || (previous && (Date.parse(model.publishedAt) > Date.parse(previous.publishedAt) || (model.publishedAt === previous.publishedAt && model.id <= previous.id)))) throw new Error('Commons results are out of order.');
      ids.add(model.id); previous = { id: model.id, publishedAt: model.publishedAt, asOf: page.asOf };
    }
    if (page.nextCursor && (!page.models.length || page.nextCursor.id !== page.models.at(-1)?.id || page.nextCursor.publishedAt !== page.models.at(-1)?.publishedAt)) throw new Error('Commons results did not advance.');
    return { models: page.models, next: page.nextCursor ? { ...page.nextCursor, asOf: page.asOf } : null, total: page.total, categories: page.categories, licenses: page.licenses };
  };
}
export function createCommonsModelsLoader(client: Pick<SupabaseClient<Database>, 'rpc'>): CommonsModelsLoader {
  return async (ids, signal) => {
    if (!ids.length) return [];
    const result = await client.rpc('commons_catalog_models', { p_ids: [...new Set(ids)].slice(0, 100) }).abortSignal(AbortSignal.any([signal, AbortSignal.timeout(15000)]));
    signal.throwIfAborted();
    if (result.error?.message === 'commons_unavailable') throw new CommonsUnavailableError();
    if (result.error && ['PGRST202', '42883'].includes(result.error.code)) return (await readCommonsCatalog(client, signal)).filter(model => ids.includes(model.id));
    if (result.error) throw new Error('Could not load featured models.');
    return catalogModelSchema.array().max(100).parse(result.data);
  };
}
