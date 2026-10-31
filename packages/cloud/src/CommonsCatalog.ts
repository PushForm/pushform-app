// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';

/** Public catalog metadata only. Original model files are published separately. */
const text = z.string().trim().min(1).max(1000);
export const catalogUrlSchema = z.string().url().max(2048).refine((value) => {
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
  imageUrl: catalogUrlSchema.nullable(),
  source: z.object({ name: text, url: catalogUrlSchema }).strict().nullable(),
  licenses: z.array(z.object({
    name: text, url: catalogUrlSchema,
    commercialUse: z.enum(['allowed', 'restricted', 'unknown']),
    conditions: z.array(text).max(50),
  }).strict()).min(1).max(50),
  credits: z.array(z.object({ name: text, url: catalogUrlSchema.nullable(), text: z.string().max(4000) }).strict()).min(1).max(100),
}).strict();

export const catalogSchema = z.object({ version: z.literal(1), models: z.array(catalogModelSchema).max(1000) }).strict()
  .superRefine((catalog, context) => {
    const ids = new Set<string>();
    for (const model of catalog.models) {
      if (ids.has(model.id)) context.addIssue({ code: 'custom', message: 'Duplicate model identifier.' });
      ids.add(model.id);
    }
  });
export type CatalogModel = z.infer<typeof catalogModelSchema>;

/** Decode the same public shape for HTTP snapshots and database RPC responses. */
export function parseCommonsCatalog(value: unknown): CatalogModel[] {
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success) throw new Error('Catalog metadata is invalid.');
  return parsed.data.models;
}
