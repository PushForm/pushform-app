// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { documentHandleSchema } from './document.ts';
import { modelBatchSchema, modelOperationSchema } from './model.ts';
import { metadataBatchUpsertSchema, metadataEntryIdSchema } from './metadata.ts';
import { materialAppearanceSchema } from './materialAssets.ts';

export const STAGED_EDIT_LIMITS = {
  operations:10000, metadataChanges:50000, chunks:1000, chunkItems:200,
  draftJsonBytes:16 * 1024 * 1024, sessionJsonBytes:32 * 1024 * 1024,
  sessionImageBytes:128 * 1024 * 1024, drafts:2, lifetimeMs:5 * 60 * 1000,
} as const;
const target = { document:documentHandleSchema.optional() };
const token = z.string().regex(/^edit_[0-9a-f]{32}$/);
const metadataHeader = z.object({ expectedDataVersion:z.number().int().positive().nullable(),replaceRecord:z.boolean().default(false), upgradeCompatible:z.boolean().optional(), inspectorBinding:z.string().min(1).max(100).optional() }).strict();
export const stagedEditBeginSchema = z.object({ ...target,expectedRevision:modelBatchSchema.shape.expectedRevision,
  label:modelBatchSchema.shape.label,container:modelBatchSchema.shape.container,metadata:metadataHeader.optional() }).strict();
const metadataChunk = z.object({ upserts:z.array(metadataBatchUpsertSchema).max(200).default([]),deletes:z.array(metadataEntryIdSchema).max(200).default([]) }).strict()
  .refine(value => value.upserts.length + value.deletes.length <= 200,'At most 200 metadata changes per chunk.');
export const stagedAppearanceSchema = z.object({ id:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/),
  source:z.string().min(1).max(100).optional(),appearance:materialAppearanceSchema.optional() }).strict()
  .refine(value => value.source !== undefined || value.appearance?.texture === null,'Provide an owned image source or an untextured appearance.');
export const stagedEditAppendSchema = z.object({ ...target,batch:token,sequence:z.number().int().min(0).max(STAGED_EDIT_LIMITS.chunks - 1),
  operations:z.array(modelOperationSchema).max(200).default([]),metadata:metadataChunk.optional(),
  appearances:z.array(stagedAppearanceSchema).max(200).default([]),
}).strict().refine(value => value.operations.length + (value.metadata?.upserts.length ?? 0) + (value.metadata?.deletes.length ?? 0) + value.appearances.length > 0,'Provide a nonempty edit chunk.');
export const stagedEditTokenSchema = z.object({ ...target,batch:token }).strict();
export const stagedEditResultSchema = stagedEditTokenSchema.extend({ offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(200).default(200) });
/** Host-only larger batch shape. Ordinary model.apply keeps its existing 200-operation schema. */
export const stagedModelBatchSchema = modelBatchSchema.extend({ operations:z.array(z.object({ op:z.string() }).passthrough()).max(STAGED_EDIT_LIMITS.operations) });
export interface StagedEditProgress { batch:string;next:number;operations:number;metadataChanges:number;appearances:number }
export type StagedEditBeginInput = z.input<typeof stagedEditBeginSchema>;
export type StagedEditAppendInput = z.input<typeof stagedEditAppendSchema>;
export interface StagedEditCommitResult { ok:true;revision:number;label:string;operations:number;created:number;metadataChanges:number }
export interface StagedEditResultPage { created:Record<string,number>;changed:string[];next:number | null }
export type StagedMetadata = { expectedDataVersion:number | null;replaceRecord:boolean;upgradeCompatible?:boolean | undefined;upserts:z.infer<typeof metadataBatchUpsertSchema>[];deletes:string[] };
