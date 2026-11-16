// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { modelBatchSchema, MODEL_LIMITS } from './model.ts';
import { documentHandleSchema } from './document.ts';

/** Bounded declarative schemas. No code, remote references or executable validators. */
export type MetadataSchema =
  | { type: 'null' | 'boolean' }
  | { type: 'string'; enum?: string[]; maxLength?: number }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number }
  | { type: 'array'; items: MetadataSchema; maxItems?: number }
  | { type: 'object'; properties?: Record<string, MetadataSchema>; required?: string[]; additionalProperties?: boolean | MetadataSchema };

export function isMetadataSchema(input: unknown): input is MetadataSchema {
  let nodes = 0;
  const active = new Set<object>();
  function visit(value: unknown, depth: number): boolean {
    if (++nodes > 500 || depth > 16 || !value || typeof value !== 'object' || Array.isArray(value) || active.has(value)) return false;
    active.add(value);
    const s = value as Record<string, unknown>;
    const keys: Record<string, string[]> = { null: [], boolean: [], string: ['enum', 'maxLength'], number: ['minimum', 'maximum'], integer: ['minimum', 'maximum'], array: ['items', 'maxItems'], object: ['properties', 'required', 'additionalProperties'] };
    if (typeof s.type !== 'string' || !Object.hasOwn(keys, s.type) || Object.keys(s).some(k => k !== 'type' && !keys[s.type as string]!.includes(k))) return false;
    const bounded = (n: unknown, max: number) => Number.isInteger(n) && Number(n) >= 0 && Number(n) <= max;
    let valid = true;
    if (s.type === 'string') valid = (s.maxLength === undefined || bounded(s.maxLength, 262144)) && (s.enum === undefined || Array.isArray(s.enum) && s.enum.length <= 500 && s.enum.every(v => typeof v === 'string' && v.length <= 4000));
    if (s.type === 'number' || s.type === 'integer') valid = [s.minimum, s.maximum].every(v => v === undefined || typeof v === 'number' && Number.isFinite(v)) && !(typeof s.minimum === 'number' && typeof s.maximum === 'number' && s.minimum > s.maximum);
    if (s.type === 'array') valid = (s.maxItems === undefined || bounded(s.maxItems, 10000)) && visit(s.items, depth + 1);
    if (s.type === 'object') {
      const p = s.properties ?? {};
      valid = !!p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length <= 100 && Object.entries(p).every(([k, v]) => k.length <= 100 && visit(v, depth + 1));
      valid &&= s.required === undefined || Array.isArray(s.required) && s.required.length <= 100 && new Set(s.required).size === s.required.length && s.required.every(k => typeof k === 'string' && Object.hasOwn(p, k));
      valid &&= s.additionalProperties === undefined || typeof s.additionalProperties === 'boolean' || visit(s.additionalProperties, depth + 1);
    }
    active.delete(value); return valid;
  }
  return visit(input, 0);
}
export function metadataValueMatches(schema: MetadataSchema, value: unknown): boolean {
  let nodes = 0;
  function visit(s: MetadataSchema, v: unknown, depth: number): boolean {
    if (++nodes > 100000 || depth > 32) return false;
    switch (s.type) {
      case 'null': return v === null;
      case 'boolean': return typeof v === 'boolean';
      case 'string': return typeof v === 'string' && v.length <= (s.maxLength ?? 262144) && (!s.enum || s.enum.includes(v));
      case 'integer': case 'number': return typeof v === 'number' && Number.isFinite(v) && (s.type !== 'integer' || Number.isSafeInteger(v)) && (s.minimum === undefined || v >= s.minimum) && (s.maximum === undefined || v <= s.maximum);
      case 'array': return Array.isArray(v) && v.length <= (s.maxItems ?? 10000) && v.every(child => visit(s.items, child, depth + 1));
      case 'object': {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
        const properties = s.properties ?? {};
        if (Object.keys(v).length > 1000 || s.required?.some(k => !Object.hasOwn(v, k))) return false;
        return Object.entries(v).every(([k, child]) => Object.hasOwn(properties, k) ? visit(properties[k]!, child, depth + 1) : s.additionalProperties === true || typeof s.additionalProperties === 'object' && visit(s.additionalProperties, child, depth + 1));
      }
    }
  }
  return visit(schema, value, 0);
}
export const metadataDeclarationSchema = z.strictObject({ dataVersion: z.number().int().min(1).max(0xffff_ffff), schema: z.custom<MetadataSchema>(isMetadataSchema, 'Invalid or unsupported metadata schema') });
const entityId = z.number().int().min(1).max(0xffff_ffff);
export const metadataTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('document') }),
  ...(['material', 'definition', 'body', 'group', 'instance'] as const).map(kind => z.strictObject({ kind: z.literal(kind), id: entityId })),
  z.strictObject({ kind: z.literal('bodyOccurrence'), id: entityId, path: z.array(entityId).max(32) }),
]);
export type MetadataTarget = z.infer<typeof metadataTargetSchema>;
const id = z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/);
export const metadataElementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('face'), faceId: z.number().int().min(0).max(0xffff_ffff), bodyVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ kind: z.literal('edge'), edgeKey: z.string().regex(/^\d+:\d+:\d+$/).max(100), bodyVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
]);
const reference = z.strictObject({ entryId: id.optional(), target: metadataTargetSchema, element: metadataElementSchema.optional() }).refine(ref => !ref.element || ref.target.kind === 'body' || ref.target.kind === 'bodyOccurrence', 'Topology references require a body target');
const target = { document: documentHandleSchema.optional(), expectedRevision: z.number().int().nonnegative().optional() };
export const metadataListSchema = z.strictObject({ ...target, targets: z.array(metadataTargetSchema).max(200).optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(100) });
export const metadataReadSchema = z.strictObject({ ...target, ids: z.array(id).min(1).max(100) });
export const metadataApplySchema = z.strictObject({ inspectorBinding: z.string().min(1).max(100).optional(), document: documentHandleSchema.optional(), expectedRevision: z.number().int().nonnegative(), expectedDataVersion: z.number().int().positive().nullable(), replaceRecord: z.boolean().default(false), upgradeCompatible: z.boolean().optional(), upserts: z.array(z.strictObject({ id, target: metadataTargetSchema, value: z.unknown(), references: z.array(reference).max(200).optional() })).max(200).default([]), deletes: z.array(id).max(200).default([]) }).refine(input => input.replaceRecord || input.upserts.length > 0 || input.deletes.length > 0, 'Provide at least one metadata change or explicitly replace the record');
/** Same-batch aliases apply only to typed envelopes, never arbitrary payload strings. */
export const metadataBatchTargetSchema = z.union([
  metadataTargetSchema,
  z.strictObject({ kind: z.enum(['material', 'definition', 'body', 'group', 'instance']), created: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/) }),
  z.strictObject({ kind: z.literal('bodyOccurrence'), created: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/), path: z.array(entityId).max(32).optional() }),
]);
const batchReference = z.strictObject({ entryId: id.optional(), target: metadataBatchTargetSchema, element: metadataElementSchema.optional() }).refine(ref => !ref.element || ref.target.kind === 'body' || ref.target.kind === 'bodyOccurrence', 'Topology references require a body target');
export const metadataBatchUpsertSchema = z.strictObject({ id, target: metadataBatchTargetSchema, value: z.unknown(), references: z.array(batchReference).max(200).optional() });
export const metadataEntryIdSchema = id;
export const modelMetadataBatchSchema = z.strictObject({
  expectedDataVersion: z.number().int().positive().nullable(),
  upgradeCompatible: z.boolean().optional(),
  upserts: z.array(metadataBatchUpsertSchema).max(200).default([]),
  deletes: z.array(id).max(200).default([]),
}).refine(input => input.upserts.length > 0 || input.deletes.length > 0 || input.upgradeCompatible === true, 'Provide metadata changes or an explicit compatible upgrade');
export type ModelMetadataBatchInput = z.input<typeof modelMetadataBatchSchema>;
export type MetadataBatchTarget = z.infer<typeof metadataBatchTargetSchema>;
export type MetadataApplyInput = z.input<typeof metadataApplySchema>;
export type MetadataElement = { kind: 'face'; faceId: number; bodyVersion: number } | { kind: 'edge'; edgeKey: string; bodyVersion: number };
export interface MetadataEntryInfo { id: string; target: MetadataTarget; references: { element?: MetadataElement | undefined; entryId?: string | undefined; target: MetadataTarget; unresolved?: boolean }[]; needsReview: boolean }
export interface MetadataListResult { revision: number; dataVersion: number | null; supportedDataVersion: number; writable: boolean; entries: MetadataEntryInfo[]; next: number | null }
export interface MetadataReadResult { revision: number; dataVersion: number | null; entries: (MetadataEntryInfo & { value: unknown })[]; missing: string[] }
export interface MetadataApplyResult { revision: number; dataVersion: number; changed: string[] }

/** Model operations and/or authored metadata, committed as one extension edit. */
export const modelExtensionBatchSchema = modelBatchSchema.extend({
  operations: z.array(z.object({ op: z.string() }).passthrough()).max(MODEL_LIMITS.operationsPerBatch),
  metadata: modelMetadataBatchSchema.optional(),
}).strict().refine(input => input.operations.length > 0 || !!input.metadata && ((input.metadata.upserts?.length ?? 0) > 0 || (input.metadata.deletes?.length ?? 0) > 0), 'Provide model operations or metadata changes');
