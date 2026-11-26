// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { documentHandleSchema } from './document.ts';

export const MATERIAL_ASSET_LIMITS = { chunkBytes: 256 * 1024, imageBytes: 64 * 1024 * 1024, sessionBytes: 128 * 1024 * 1024, uploads: 16, lifetimeMs: 5 * 60 * 1000, imagePixels: 64 * 1024 * 1024 } as const;
const dimension = z.number().int().positive().max(32768);
export const materialAppearanceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  color: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]),
  opacity: z.number().min(0).max(1),
  texture: z.object({
    widthM: z.number().finite().positive(), heightM: z.number().finite().positive(), colorize: z.boolean(),
    colorizeType: z.enum(['shift', 'tint']).optional(), grain: z.enum(['width', 'height', 'none']).optional(),
    image: z.object({ name: z.string().min(1).max(200), mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp']),
      width: dimension, height: dimension, byteLength: z.number().int().positive().max(MATERIAL_ASSET_LIMITS.imageBytes),
    }).strict().refine(image => image.width * image.height <= MATERIAL_ASSET_LIMITS.imagePixels, 'Image pixel limit exceeded.'),
  }).strict().nullable(),
}).strict();
export type MaterialAppearance = z.infer<typeof materialAppearanceSchema>;
export const materialReadSchema = z.object({ document: documentHandleSchema.optional(), expectedRevision: z.number().int().nonnegative(),
  materialId: z.number().int().nonnegative(), offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(MATERIAL_ASSET_LIMITS.chunkBytes).default(MATERIAL_ASSET_LIMITS.chunkBytes),
}).strict();
export type MaterialReadInput = z.input<typeof materialReadSchema>;
export interface MaterialReadResult { revision: number; materialId: number; appearance: MaterialAppearance; bytes: Uint8Array; next: number | null }
const handle = z.string().regex(/^material_[0-9a-f]{32}$/);
export const materialStageSchema = z.object({ document: documentHandleSchema.optional(), expectedRevision: z.number().int().nonnegative(),
  upload: handle.optional(), appearance: materialAppearanceSchema.optional(), offset: z.number().int().nonnegative().default(0),
  bytes: z.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength <= MATERIAL_ASSET_LIMITS.chunkBytes, 'Send a bounded Uint8Array image chunk.').optional(), discard: z.boolean().default(false),
}).strict();
export type MaterialStageInput = z.input<typeof materialStageSchema>;
export interface MaterialStageResult { upload: string; received: number; complete: boolean }
