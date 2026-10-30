// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CommonAttrs } from '@pushform/model';
import { NativeRecordCodec } from './record';
import { NativeChunkError, NATIVE_MAX_DECODED_BYTES } from './chunks';
import { encodeNativeCommonAttrs, decodeNativeCommonAttrs } from './commonAttrs';
import type { CommonAttrsExtensions } from './commonAttrs';

const codec = new NativeRecordCodec({ id: { id: 1, kind: 'uint32', required: true }, value: { id: 2, kind: 'bytes', required: true } });
export interface NativeCommonProperty {
  readonly id: number;
  readonly value: CommonAttrs;
  readonly extensions: CommonAttrsExtensions;
  readonly unknownFields: Uint8Array[];
}
export interface NativePropertyLimits { maxRecords?: number; maxEncodedBytes?: number }
type Envelope = Pick<NonNullable<CommonAttrs['nativePropertyUnknownFields']>, 'required' | 'envelopeUnknown'>;
const fail = (): never => { throw new NativeChunkError('Invalid native common-property catalog'); };
function id(value: number): void { if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) fail(); }
function limits(options: NativePropertyLimits): { records: number; bytes: number } {
  const records = options.maxRecords ?? 1_000_000, bytes = options.maxEncodedBytes ?? NATIVE_MAX_DECODED_BYTES;
  if (!Number.isInteger(records) || records < 0 || records > 1_000_000 || !Number.isInteger(bytes) || bytes < 0 || bytes > NATIVE_MAX_DECODED_BYTES) fail();
  return { records, bytes };
}
export function decodeNativeCommonProperty(bytes: Uint8Array): NativeCommonProperty {
  const record = codec.decode(bytes), propertyId = record.fields.id as number; id(propertyId);
  return { id: propertyId, ...decodeNativeCommonAttrs(record.fields.value as Uint8Array), unknownFields: record.unknownFields };
}
export function encodeNativeCommonProperty(record: NativeCommonProperty): Uint8Array {
  id(record.id); return codec.encode({ fields: { id: record.id, value: encodeNativeCommonAttrs(record.value, record.extensions) }, unknownFields: record.unknownFields });
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true;
}
function fingerprint(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return hash >>> 0;
}

/** Per-save pool. Stores one encoded value per distinct property, not a second decoded graph. */
export class NativeCommonPropertyWriter {
  private readonly entries: Uint8Array[] = [];
  private readonly envelopes = new Map<number, Envelope>();
  private readonly buckets = new Map<number, number[]>();
  private readonly cap: ReturnType<typeof limits>;
  private bytes = 0;
  constructor(options: NativePropertyLimits = {}, private readonly hash: (bytes: Uint8Array) => number = fingerprint) { this.cap = limits(options); }
  get size(): number { return this.entries.length; }
  get encodedBytes(): number { return this.bytes; }

  intern(value: CommonAttrs, extensions?: CommonAttrsExtensions, unknownFields?: Uint8Array[]): { id: number; added: boolean } {
    const extra = value.nativePropertyUnknownFields;
    extensions ??= { fields: extra?.fields ?? [], attributes: extra?.attributes ?? new Map() };
    unknownFields ??= extra?.unknownFields ?? [];
    // Normalize only the file-local ID. Unknown property-envelope fields participate in identity.
    const bytes = codec.encode({ fields: { id: 1, value: encodeNativeCommonAttrs(value, extensions) }, unknownFields });
    const hash = this.hash(bytes), candidates = this.buckets.get(hash);
    // The fingerprint only selects candidates. Equality always compares all encoded bytes.
    for (const index of candidates ?? []) if (equal(this.entries[index]!, bytes) && sameEnvelope(this.envelopes.get(index + 1), extra)) return { id: index + 1, added: false };
    const retainedBytes = bytes.length + (extra?.envelopeUnknown ?? []).reduce((total, field) => total + field.byteLength, 0);
    if (this.entries.length >= this.cap.records || retainedBytes > this.cap.bytes - this.bytes) return fail();
    const index = this.entries.length, assignedId = index + 1;
    // The normalized ID uses one byte; the assigned ID may need up to three.
    const extraIdBytes = assignedId < 128 ? 0 : assignedId < 16_384 ? 1 : 2;
    if (bytes.length + extraIdBytes > 1024 * 1024) return fail();
    this.entries.push(bytes); this.bytes += retainedBytes;
    if (extra?.required === false || extra?.envelopeUnknown?.length) this.envelopes.set(assignedId, {
      ...(extra.required === false ? { required: false } : {}),
      ...(extra.envelopeUnknown?.length ? { envelopeUnknown: extra.envelopeUnknown.map(bytes => bytes.slice()) } : {}),
    });
    if (candidates) candidates.push(index); else this.buckets.set(hash, [index]);
    return { id: index + 1, added: true };
  }
  envelope(propertyId: number): Envelope | undefined { return this.envelopes.get(propertyId); }
  /** Owned bytes suitable for the bounded metadata stream; internal dedup keys never escape. */
  encodeRecord(propertyId: number): Uint8Array {
    id(propertyId); const bytes = this.entries[propertyId - 1]; if (!bytes) return fail();
    const record = codec.decode(bytes);
    return codec.encode({ fields: { ...record.fields, id: propertyId }, unknownFields: record.unknownFields });
  }
}

function freeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value) || Object.isFrozen(value)) return;
  for (const key of Object.keys(value)) freeze((value as Record<string, unknown>)[key]); Object.freeze(value);
}
/** Per-open staging table. Install only after all entity references are validated. */
export class NativeCommonPropertyReader {
  private readonly entries = new Map<number, NativeCommonProperty>();
  private readonly cap: ReturnType<typeof limits>;
  private bytes = 0;
  constructor(options: NativePropertyLimits = {}) { this.cap = limits(options); }
  get size(): number { return this.entries.size; }
  get encodedBytes(): number { return this.bytes; }
  add(bytes: Uint8Array, envelope?: Envelope): void {
    const retainedBytes = bytes.length + (envelope?.envelopeUnknown ?? []).reduce((total, field) => total + field.byteLength, 0);
    if (this.entries.size >= this.cap.records || retainedBytes > this.cap.bytes - this.bytes) return fail();
    const record = decodeNativeCommonProperty(bytes);
    if (this.entries.has(record.id)) return fail();
    if (envelope && (envelope.required === false || envelope.envelopeUnknown?.length || record.unknownFields.length || record.extensions.fields.length || record.extensions.attributes.size)) {
      record.value.nativePropertyUnknownFields = {
        ...(envelope.required === false ? { required: false } : {}),
        ...(envelope.envelopeUnknown?.length ? { envelopeUnknown: envelope.envelopeUnknown } : {}),
        ...(record.unknownFields.length ? { unknownFields: record.unknownFields } : {}),
        ...(record.extensions.fields.length ? { fields: record.extensions.fields } : {}),
        ...(record.extensions.attributes.size ? { attributes: record.extensions.attributes } : {}),
      };
    }
    freeze(record.value); Object.freeze(record); this.entries.set(record.id, record); this.bytes += retainedBytes;
  }
  get(propertyId: number): NativeCommonProperty {
    const record = this.entries.get(propertyId); if (!record) return fail(); return record;
  }
}

function sameEnvelope(a: Envelope | undefined, b: Envelope | undefined): boolean {
  if ((a?.required ?? true) !== (b?.required ?? true)) return false;
  const left = a?.envelopeUnknown ?? [], right = b?.envelopeUnknown ?? [];
  return left.length === right.length && left.every((bytes, index) => equal(bytes, right[index]!));
}
