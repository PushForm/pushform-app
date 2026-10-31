// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';

/** Public catalog metadata only. Original model files are published separately. */
const text = z.string().trim().min(1).max(1000);
const link = z.string().url().max(2048).refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && (url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
}, 'Expected an HTTPS URL (HTTP is allowed on localhost).');

export const catalogModelSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,95}$/),
  revision: text,
  title: text,
  description: z.string().max(12000),
  creator: text,
  category: text,
  tags: z.array(text).max(50),
  formats: z.array(text).min(1).max(30),
  publishedAt: z.iso.datetime({ offset: true }),
  imageUrl: link.nullable(),
  source: z.object({ name: text, url: link }).nullable(),
  licenses: z.array(z.object({
    name: text, url: link,
    commercialUse: z.enum(['allowed', 'restricted', 'unknown']),
    conditions: z.array(text).max(50),
  })).min(1).max(50),
  credits: z.array(z.object({ name: text, url: link.nullable(), text: z.string().max(4000) })).min(1).max(100),
});

export const catalogSchema = z.object({ version: z.literal(1), models: z.array(catalogModelSchema).max(1000) })
  .superRefine((catalog, context) => {
    const ids = new Set<string>();
    for (const model of catalog.models) {
      if (ids.has(model.id)) context.addIssue({ code: 'custom', message: 'Duplicate model identifier.' });
      ids.add(model.id);
    }
  });
export type CatalogModel = z.infer<typeof catalogModelSchema>;
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
