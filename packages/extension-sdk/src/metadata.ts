// SPDX-License-Identifier: MIT
// Copyright 2026 PushForm contributors
export type MetadataSchema =
  | { type: 'null' | 'boolean' }
  | { type: 'string'; enum?: string[]; maxLength?: number }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number }
  | { type: 'array'; items: MetadataSchema; maxItems?: number }
  | { type: 'object'; properties?: Record<string, MetadataSchema>; required?: string[]; additionalProperties?: boolean | MetadataSchema };

export type MetadataTarget = { kind: 'document' } | { kind: 'material' | 'definition' | 'body' | 'group' | 'instance'; id: number } | { kind: 'bodyOccurrence'; id: number; path: number[] };
export type MetadataElement = { kind: 'face'; faceId: number; bodyVersion: number } | { kind: 'edge'; edgeKey: string; bodyVersion: number };
export interface MetadataEntryInfo { id: string; target: MetadataTarget; references: { element?: MetadataElement | undefined; entryId?: string | undefined; target: MetadataTarget; unresolved?: boolean }[]; needsReview: boolean }
export interface MetadataListResult { revision: number; dataVersion: number | null; supportedDataVersion: number; writable: boolean; entries: MetadataEntryInfo[]; next: number | null }
export interface MetadataReadResult { revision: number; dataVersion: number | null; entries: (MetadataEntryInfo & { value: unknown })[]; missing: string[] }
export interface MetadataApplyResult { revision: number; dataVersion: number; changed: string[] }
export interface MetadataApplyInput {
 inspectorBinding?: string | undefined;
 document?: string | undefined;
 expectedRevision: number;
 expectedDataVersion: number | null;
 replaceRecord?: boolean | undefined;
 upgradeCompatible?: boolean | undefined;
 upserts?: { id: string; target: MetadataTarget; value: unknown; references?: { element?: MetadataElement | undefined; entryId?: string | undefined; target: MetadataTarget }[] | undefined }[] | undefined;
 deletes?: string[] | undefined;
}

export type MetadataBatchTarget = MetadataTarget
 | { kind: 'material' | 'definition' | 'body' | 'group' | 'instance'; created: string }
 | { kind: 'bodyOccurrence'; created: string; path?: number[] | undefined };
export interface ModelMetadataBatchInput {
 expectedDataVersion: number | null;
 upgradeCompatible?: boolean | undefined;
 upserts?: { id: string; target: MetadataBatchTarget; value: unknown; references?: { element?: MetadataElement | undefined; entryId?: string | undefined; target: MetadataBatchTarget }[] | undefined }[] | undefined;
 deletes?: string[] | undefined;
}
