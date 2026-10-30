// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DefId } from '@pushform/core';
import { NativeRecordCodec } from './record';
import { NativeChunkError } from './chunks';
import type { NativeChunk, NativeChunkOptions } from './chunks';
import { encodeNativeCatalogEntry, decodeNativeCatalogEntry } from './catalog';
import type { NativeCatalogEntry } from './catalog';
import { encodeNativeDefinition, decodeNativeDefinition } from './definition';
import type { NativeDefinitionRecord, DefinitionExtensions } from './definition';
import { encodeNativeInstance, decodeNativeInstance } from './instance';
import type { NativeInstanceRecord, InstanceExtensions } from './instance';
import { encodeNativeCommonProperty, decodeNativeCommonProperty } from './commonProperty';
import type { NativeCommonProperty } from './commonProperty';
import { encodeNativeRecordChunks, decodeNativeRecordChunks } from './recordStream';
import { encodeNativeSketchReference, decodeNativeSketchReference } from './sketch';
import type { NativeSketchReference } from './sketch';
import { encodeNativeBodyReference, decodeNativeBodyReference } from './body';
import type { NativeBodyReference } from './body';
import { encodeNativeGuide, decodeNativeGuide, encodeNativeImagePlacement, decodeNativeImagePlacement, encodeNativeSectionPlane, decodeNativeSectionPlane } from './placements';
import type { NativePlacement, NativeGuide, NativeImagePlacement, NativeSectionPlane } from './placements';
import { encodeNativeText, decodeNativeText } from './text';
import type { NativeText } from './text';
import { encodeNativeDimension, decodeNativeDimension } from './dimension';
import type { NativeDimensionRecord, DimensionExtensions } from './dimension';

interface Extras { required?: boolean; envelopeUnknown?: Uint8Array[] }
export type NativeModelRecord = Exclude<NativeCatalogEntry, { kind: 'unknown' }>
  | (Extras & { kind: 'definition'; value: NativeDefinitionRecord; extensions?: DefinitionExtensions })
  | (Extras & { kind: 'commonProperty'; value: NativeCommonProperty })
  | (Extras & { kind: 'instance'; ownerDefinitionId: DefId; value: NativeInstanceRecord; extensions?: InstanceExtensions })
  | (Extras & { kind: 'sketch'; ownerDefinitionId: DefId; value: NativeSketchReference })
  | (Extras & { kind: 'body'; ownerDefinitionId: DefId; value: NativeBodyReference })
  | (Extras & { kind: 'guide'; ownerDefinitionId: DefId; value: NativePlacement<NativeGuide> })
  | (Extras & { kind: 'imagePlacement'; ownerDefinitionId: DefId; value: NativePlacement<NativeImagePlacement> })
  | (Extras & { kind: 'sectionPlane'; ownerDefinitionId: DefId; value: NativePlacement<NativeSectionPlane> })
  | (Extras & { kind: 'text'; ownerDefinitionId: DefId; value: NativePlacement<NativeText> })
  | (Extras & { kind: 'dimension'; ownerDefinitionId: DefId; value: NativeDimensionRecord; extensions?: DimensionExtensions })
  | { kind: 'unknown'; wireKind: number; schemaMajor: number; required: false; ownerDefinitionId?: DefId; payload: Uint8Array; envelopeUnknown?: Uint8Array[] };
const codec = new NativeRecordCodec({ kind: { id: 1, kind: 'uint32', required: true }, schemaMajor: { id: 2, kind: 'uint32', required: true },
  required: { id: 3, kind: 'bool', required: true }, payload: { id: 4, kind: 'bytes', required: true }, ownerDefinitionId: { id: 5, kind: 'uint32', required: false } });
function envelope(kind: number, schemaMajor: number, required: boolean, payload: Uint8Array, unknownFields: Uint8Array[], ownerDefinitionId?: DefId): Uint8Array {
  if (!Number.isInteger(kind) || kind < 1 || !Number.isInteger(schemaMajor) || schemaMajor < 1) throw new NativeChunkError('Invalid native model record kind/schema');
  if (schemaMajor === 1 && kind <= 16 && (ownerDefinitionId !== undefined) !== (kind >= 9)) throw new NativeChunkError('Invalid native model record owner');
  return codec.encode({ fields: { kind, schemaMajor, required, payload, ...(ownerDefinitionId === undefined ? {} : { ownerDefinitionId }) }, unknownFields });
}

export function encodeNativeModelRecord(record: NativeModelRecord): Uint8Array {
  const required = record.required ?? true, unknown = record.envelopeUnknown ?? [];
  switch (record.kind) {
    case 'definition': return envelope(7, 1, required, encodeNativeDefinition(record.value, record.extensions), unknown);
    case 'commonProperty': return envelope(8, 1, required, encodeNativeCommonProperty(record.value), unknown);
    case 'instance': return envelope(9, 1, required, encodeNativeInstance(record.value, record.extensions), unknown, record.ownerDefinitionId);
    case 'sketch': return envelope(10, 1, required, encodeNativeSketchReference(record.value), unknown, record.ownerDefinitionId);
    case 'body': return envelope(11, 1, required, encodeNativeBodyReference(record.value), unknown, record.ownerDefinitionId);
    case 'guide': return envelope(12, 1, required, encodeNativeGuide(record.value), unknown, record.ownerDefinitionId);
    case 'imagePlacement': return envelope(13, 1, required, encodeNativeImagePlacement(record.value), unknown, record.ownerDefinitionId);
    case 'sectionPlane': return envelope(14, 1, required, encodeNativeSectionPlane(record.value), unknown, record.ownerDefinitionId);
    case 'text': return envelope(15, 1, required, encodeNativeText(record.value), unknown, record.ownerDefinitionId);
    case 'dimension': return envelope(16, 1, required, encodeNativeDimension(record.value, record.extensions), unknown, record.ownerDefinitionId);
    case 'unknown':
      if (record.schemaMajor === 1 && record.wireKind <= 16) throw new NativeChunkError('Known native record cannot be opaque');
      return envelope(record.wireKind, record.schemaMajor, false, record.payload, unknown, record.ownerDefinitionId);
    default: {
      const bytes = encodeNativeCatalogEntry(record), checked = codec.decode(bytes);
      if (Object.hasOwn(checked.fields, 'ownerDefinitionId')) throw new NativeChunkError('Unexpected native catalog owner');
      return bytes;
    }
  }
}

/** Wrap an already encoded property pool entry without decoding/rebuilding its attribute graph. */
export function encodeNativePropertyModelRecord(payload: Uint8Array, extras: Extras = {}): Uint8Array {
  return envelope(8, 1, extras.required ?? true, payload, extras.envelopeUnknown ?? []);
}

export function decodeNativeModelRecord(bytes: Uint8Array): NativeModelRecord {
  const decoded = codec.decode(bytes), f = decoded.fields;
  const kind = f.kind as number, schemaMajor = f.schemaMajor as number, required = f.required as boolean, payload = f.payload as Uint8Array;
  const hasOwner = Object.hasOwn(f, 'ownerDefinitionId'), ownerDefinitionId = f.ownerDefinitionId as DefId;
  if (!kind || !schemaMajor) throw new NativeChunkError('Invalid native model record kind/schema');
  const extras = { required, envelopeUnknown: decoded.unknownFields };
  if (schemaMajor === 1 && kind <= 16) {
    if (hasOwner !== (kind >= 9)) throw new NativeChunkError('Invalid native model record owner');
    if (kind <= 6) return decodeNativeCatalogEntry(bytes) as Exclude<NativeCatalogEntry, { kind: 'unknown' }>;
    if (kind === 7) return { kind: 'definition', ...decodeNativeDefinition(payload), ...extras };
    if (kind === 8) return { kind: 'commonProperty', value: decodeNativeCommonProperty(payload), ...extras };
    if (kind === 10) return { kind: 'sketch', ownerDefinitionId, value: decodeNativeSketchReference(payload), ...extras };
    if (kind === 11) return { kind: 'body', ownerDefinitionId, value: decodeNativeBodyReference(payload), ...extras };
    if (kind === 12) return { kind: 'guide', ownerDefinitionId, value: decodeNativeGuide(payload), ...extras };
    if (kind === 13) return { kind: 'imagePlacement', ownerDefinitionId, value: decodeNativeImagePlacement(payload), ...extras };
    if (kind === 14) return { kind: 'sectionPlane', ownerDefinitionId, value: decodeNativeSectionPlane(payload), ...extras };
    if (kind === 15) return { kind: 'text', ownerDefinitionId, value: decodeNativeText(payload), ...extras };
    if (kind === 16) return { kind: 'dimension', ownerDefinitionId, ...decodeNativeDimension(payload), ...extras };
    return { kind: 'instance', ownerDefinitionId, ...decodeNativeInstance(payload), ...extras };
  }
  if (required) throw new NativeChunkError(`Unsupported required native model record: ${kind}/${schemaMajor}`);
  return { kind: 'unknown', wireKind: kind, schemaMajor, required: false, payload, envelopeUnknown: decoded.unknownFields, ...(hasOwner ? { ownerDefinitionId } : {}) };
}

export function encodeNativeModelChunks(records: Iterable<NativeModelRecord> | AsyncIterable<NativeModelRecord>, options: NativeChunkOptions = {}): AsyncGenerator<NativeChunk> {
  async function* encoded() { for await (const record of records) yield encodeNativeModelRecord(record); }
  return encodeNativeRecordChunks(encoded(), options);
}
export async function* decodeNativeModelChunks(chunks: Iterable<NativeChunk> | AsyncIterable<NativeChunk>, signal?: AbortSignal): AsyncGenerator<NativeModelRecord> {
  for await (const bytes of decodeNativeRecordChunks(chunks, signal)) yield decodeNativeModelRecord(bytes);
}
