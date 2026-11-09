// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
/** Native model snapshots remain opaque to guest byte reads. */
export const NATIVE_FRAGMENT_MIME='application/vnd.pushform.model-fragment';
export const ASSET_LIMITS = { chunkBytes: 256 * 1024, blobBytes: 64 * 1024 * 1024, extensionBytes: 512 * 1024 * 1024,
  accountBytes: 2 * 1024 * 1024 * 1024, extensionCount: 500, accountCount: 2000, uploads: 4, stagingBytes: 128 * 1024 * 1024, lifetimeMs: 5 * 60 * 1000 } as const;
// Names stay data; the host creates every physical storage path.
// eslint-disable-next-line no-control-regex
export const assetKeySchema = z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value) && new TextDecoder().decode(new TextEncoder().encode(value)) === value, 'Use a valid Unicode asset name without control characters.');
export const assetRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const assetDescriptionSchema = z.object({ key: assetKeySchema, version: z.number().int().min(1).max(1000000),
  contentType: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/),
  byteLength: z.number().int().nonnegative().max(ASSET_LIMITS.blobBytes), sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type AssetDescription = z.infer<typeof assetDescriptionSchema>;
export interface AssetDescriptor extends AssetDescription { revision: number; updatedAt: string }
export interface AssetPage { entries: AssetDescriptor[]; next: string | null }
export interface AssetReadResult { asset: AssetDescriptor; bytes: Uint8Array; next: number | null }
export interface AssetStageResult { upload: string; received: number; complete: boolean }
export const assetListSchema = z.object({ after: assetKeySchema.nullable().default(null), limit: z.number().int().min(1).max(100).default(100) }).strict();
export const assetReadSchema = z.object({ key: assetKeySchema, expectedRevision: assetRevisionSchema, offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(ASSET_LIMITS.chunkBytes).default(ASSET_LIMITS.chunkBytes) }).strict();
export const assetStageSchema = z.object({ upload: z.string().regex(/^asset_[0-9a-f]{32}$/).optional(), description: assetDescriptionSchema.optional(),
  expectedRevision: assetRevisionSchema.nullable().optional(), offset: z.number().int().nonnegative().default(0),
  bytes: z.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength <= ASSET_LIMITS.chunkBytes, 'Send a bounded Uint8Array asset chunk.'),
}).strict();
export const assetUploadSchema = z.object({ upload: z.string().regex(/^asset_[0-9a-f]{32}$/) }).strict();
export const assetRemoveSchema = z.object({ key: assetKeySchema, expectedRevision: assetRevisionSchema }).strict();
