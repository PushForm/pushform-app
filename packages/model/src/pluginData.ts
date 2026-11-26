// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { TopologyElement } from './body/TopologyReferences';

/** Document-owned plugin records. Payloads stay opaque until their owner explicitly reads them. */
export const PLUGIN_DATA_LIMITS = { entry: 256 * 1024, record: 4 * 1024 * 1024, document: 32 * 1024 * 1024, depth: 32 } as const;
export type PluginTarget = { kind: 'document' } | { kind: 'material' | 'definition' | 'body' | 'group' | 'instance'; id: number }
  | { kind: 'bodyOccurrence'; id: number; path: number[] };
export interface PluginEntry {
  target: PluginTarget;
  /** An ambiguous model edit retained this attachment for explicit resolution. */
  needsReview?: boolean;
  references: { element?: TopologyElement | undefined; entryId?: string | undefined; target: PluginTarget; unresolved?: boolean }[];
  payload: Uint8Array;
}
export interface PluginDataRecord { dataVersion: number; entries: Map<string, PluginEntry> }
export type PluginData = Map<string, PluginDataRecord>;
export class PluginDataError extends Error {
  constructor(readonly code: 'validation.failed' | 'limit.exceeded' | 'version.unsupported', message: string) { super(message); }
}
const fail = (code: PluginDataError['code'], message: string): never => { throw new PluginDataError(code, message); };
const text = new TextEncoder();
const validId = (id: number): boolean => Number.isInteger(id) && id > 0 && id <= 0xffff_ffff;
export function validatePluginTarget(target: PluginTarget): void {
  if (!target || typeof target !== 'object') fail('validation.failed', 'Invalid metadata target');
  const allowed = target.kind === 'document' ? ['kind'] : target.kind === 'bodyOccurrence' ? ['kind', 'id', 'path'] : ['kind', 'id'];
  if (Object.keys(target).some(key => !allowed.includes(key))) fail('validation.failed', 'Unknown metadata target field');
  if (target.kind === 'document') return;
  if (!['material', 'definition', 'body', 'group', 'instance', 'bodyOccurrence'].includes(target.kind) || !validId(target.id)) fail('validation.failed', 'Invalid metadata target');
  if (target.kind === 'bodyOccurrence' && (!Array.isArray(target.path) || target.path.length > 32 || !target.path.every(validId))) fail('validation.failed', 'Invalid occurrence path');
}
/** Accept only plain finite JSON, with bounded depth and no cycles or silently omitted values. */
export function encodePluginValue(value: unknown): Uint8Array {
  const active = new Set<object>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > PLUGIN_DATA_LIMITS.depth) fail('limit.exceeded', 'Metadata nesting is too deep');
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || !v || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) return fail('validation.failed', 'Metadata must be plain JSON');
    if (active.has(v)) fail('validation.failed', 'Metadata cannot contain cycles');
    active.add(v);
    if (Array.isArray(v)) {
      if (Reflect.ownKeys(v).length !== v.length + 1) fail('validation.failed', 'Metadata arrays cannot have extra properties or holes');
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !('value' in d)) fail('validation.failed', 'Metadata arrays cannot have accessors');
        visit(d!.value, depth + 1);
      }
    }
    else for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== 'string') fail('validation.failed', 'Metadata keys must be strings');
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) fail('validation.failed', 'Metadata cannot contain accessors or hidden properties');
      visit(descriptor.value, depth + 1);
    }
    active.delete(v);
  };
  visit(value, 0);
  const bytes = text.encode(JSON.stringify(value));
  if (bytes.length > PLUGIN_DATA_LIMITS.entry) fail('limit.exceeded', 'Metadata entry is too large');
  return bytes;
}
export function readPluginValue(record: PluginDataRecord, entryId: string, supportedVersion: number): unknown {
  if (record.dataVersion > supportedVersion) fail('version.unsupported', 'A newer plugin version owns this data');
  const entry = record.entries.get(entryId);
  return entry ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.payload)) as unknown : undefined;
}
/** Envelope validation never parses a plugin's payload or runs plugin code. */
export function validatePluginData(data: PluginData): void {
  let total = 0;
  if (!(data instanceof Map)) fail('validation.failed', 'Invalid plugin data index');
  for (const [owner, record] of data) {
    if (typeof owner !== 'string' || !record || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(owner) || !Number.isSafeInteger(record.dataVersion) || record.dataVersion < 1 || !(record.entries instanceof Map)) fail('validation.failed', 'Invalid plugin record');
    let size = text.encode(owner).length + 16;
    for (const [id, entry] of record.entries) {
      if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(id) || !(entry.payload instanceof Uint8Array) || !Array.isArray(entry.references) || entry.needsReview !== undefined && typeof entry.needsReview !== 'boolean') fail('validation.failed', 'Invalid metadata entry');
      validatePluginTarget(entry.target);
      for (const ref of entry.references) {
        if (!ref || !ref.target) fail('validation.failed', 'Invalid metadata reference');
        if (ref.element !== undefined) {
          const element = ref.element;
          if (!element || (ref.target.kind !== 'body' && ref.target.kind !== 'bodyOccurrence') || !Number.isSafeInteger(element.bodyVersion) || element.bodyVersion < 0 ||
            (element.kind === 'face' ? !Number.isInteger(element.faceId) || element.faceId < 0 || element.faceId > 0xffff_ffff || Object.keys(element).some(key => !['kind', 'faceId', 'bodyVersion'].includes(key))
              : element.kind !== 'edge' || typeof element.edgeKey !== 'string' || !/^\d+:\d+:\d+$/.test(element.edgeKey) || element.edgeKey.length > 100 || Object.keys(element).some(key => !['kind', 'edgeKey', 'bodyVersion'].includes(key)))) fail('validation.failed', 'Invalid topology reference');
        }
        if (!ref || ref.entryId !== undefined && (typeof ref.entryId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(ref.entryId)) || ref.unresolved !== undefined && typeof ref.unresolved !== 'boolean') fail('validation.failed', 'Invalid metadata reference');
        validatePluginTarget(ref.target);
      }
      const bytes = text.encode(JSON.stringify({ id, target: entry.target, references: entry.references, needsReview: entry.needsReview })).length + entry.payload.length;
      if (bytes > PLUGIN_DATA_LIMITS.entry) fail('limit.exceeded', 'Metadata entry is too large');
      size += bytes;
    }
    if (size > PLUGIN_DATA_LIMITS.record) fail('limit.exceeded', 'Plugin record is too large');
    total += size;
  }
  if (total > PLUGIN_DATA_LIMITS.document) fail('limit.exceeded', 'Document metadata is too large');
}
/** Prepare an owned copy before entering a transaction. The host supplies the trusted schema validator. */
export function preparePluginEntry(target: PluginTarget, value: unknown, references: PluginEntry['references'], validate: (value: unknown) => boolean): PluginEntry {
  const payload = encodePluginValue(value);
  const plain: unknown = JSON.parse(new TextDecoder().decode(payload));
  if (!validate(plain)) fail('validation.failed', 'Metadata does not match the plugin schema');
  const entry = { target: structuredClone(target), references: structuredClone(references), payload };
  validatePluginData(new Map([['validation', { dataVersion: 1, entries: new Map([['entry', entry]]) }]]));
  return entry;
}
