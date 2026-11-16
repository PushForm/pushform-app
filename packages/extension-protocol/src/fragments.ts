// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { documentHandleSchema } from './document.ts';
import { assetKeySchema, assetRevisionSchema } from './assets.ts';
import { isPackagePath } from './manifest.ts';
import { modelQuerySchema, type ModelBounds, type ModelRef } from './model.ts';
import { metadataListSchema, metadataReadSchema, metadataApplySchema } from './metadata.ts';

export const FRAGMENT_LIMITS = { handles: 2, bytes: 64 * 1024 * 1024, sessionBytes: 128 * 1024 * 1024, lifetimeMs: 5 * 60_000 } as const;
export const fragmentHandleSchema = z.string().regex(/^fragment_[a-f0-9]{32}$/);
// eslint-disable-next-line no-control-regex
const name = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const id = z.number().int().nonnegative();
const point = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const fragmentAxesSchema = z.tuple([point, point, point]);
export const fragmentCaptureSchema = z.strictObject({ document: documentHandleSchema.optional(), expectedRevision: id, name,
  ref: z.strictObject({ kind: z.enum(['body', 'instance']), id, path: z.array(id).max(64) }) });
export const fragmentTokenSchema = z.strictObject({ fragment: fragmentHandleSchema });
export const fragmentFileSchema = z.strictObject({ transfer: z.string().regex(/^read_[a-f0-9]{32}$/), name });
export const fragmentAssetSchema = z.strictObject({ key: assetKeySchema, expectedRevision: assetRevisionSchema, name });
export const fragmentPackageSchema = z.strictObject({ path: z.string().max(500).refine(isPackagePath).refine(path => path.endsWith('.pf')), name });
export const fragmentQuerySchema = z.strictObject({ fragment: fragmentHandleSchema, query: modelQuerySchema.partial() });
export const fragmentMetadataListSchema = z.strictObject({ fragment: fragmentHandleSchema, query: metadataListSchema.omit({ document: true }) });
export const fragmentMetadataReadSchema = z.strictObject({ fragment: fragmentHandleSchema, query: metadataReadSchema.omit({ document: true }) });
const edits = z.strictObject(metadataApplySchema.shape).omit({ document: true, inspectorBinding: true, expectedRevision: true })
  .refine(input => input.replaceRecord || input.upserts.length > 0 || input.deletes.length > 0, 'Provide metadata edits or an explicit record replacement.');
export const fragmentDeriveSchema = fragmentTokenSchema.extend({ expectedRevision: id, name: name.optional(), metadata: edits });
export const fragmentProjectSchema = fragmentTokenSchema.extend({ axes: fragmentAxesSchema });
export const fragmentFitSchema = fragmentTokenSchema.extend({ expectedRevision: id, name: name.optional(), axes: fragmentAxesSchema,
  size: point, pose: z.array(z.number().finite()).length(16).optional(), anchor: point.optional(),
  planes: z.array(z.strictObject({ normal: point, offset: z.number().finite(), side: z.enum(['positive', 'negative']), displacement: point })).max(32).default([]) });
export const fragmentSaveSchema = fragmentTokenSchema.extend({ key: assetKeySchema, expectedRevision: assetRevisionSchema.nullable() });
export const fragmentExportSchema = fragmentTokenSchema.extend({ purpose: z.string().trim().min(1).max(200), suggestedName: z.string().min(1).max(200) });
/** A session-owned immutable snapshot. Geometry queries and this extension's metadata never expose native bytes. */
export interface FragmentDescription { fragment: string; name: string; revision: number; root: ModelRef; bounds: ModelBounds; byteLength: number; expiresAt: number }
export interface FragmentProjection { axes: [[number, number, number], [number, number, number], [number, number, number]]; min: [number, number, number]; max: [number, number, number]; size: [number, number, number] }
export interface FragmentFitResult { description: FragmentDescription; projection: FragmentProjection }
