// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ModelReference } from '@pushform/layout';
import { NativeChunkError } from './chunks';
import { NativeRecordCodec } from './record';
import type { NativeField, NativeFieldKind, NativeScalar } from './record';
export type LayoutReferenceExtensions = Map<'' | 'target', Uint8Array[]>;
type CloudTarget = Extract<ModelReference['target'], { kind: 'cloud' }>;
type PathTarget = Extract<ModelReference['target'], { kind: 'path' }>;
const f = (id: number, kind: NativeFieldKind, required = true): NativeField => ({ id, kind, required });
const reference = new NativeRecordCodec({ id: f(1, 'uint32'), displayName: f(2, 'string'), kind: f(3, 'uint32'), target: f(4, 'bytes') } satisfies Record<Exclude<keyof ModelReference, 'nativeUnknownFields'> | 'kind', NativeField>);
const cloud = new NativeRecordCodec({ documentId: f(1, 'string'), revisionId: f(2, 'string'), revisionNumber: f(3, 'uint53'), sha256: f(4, 'string'), pinned: f(5, 'bool') } satisfies Record<Exclude<keyof CloudTarget, 'kind' | 'nativeUnknownFields'>, NativeField>);
const path = new NativeRecordCodec({ path: f(1, 'string'), contentHash: f(2, 'string', false) } satisfies Record<Exclude<keyof PathTarget, 'kind' | 'nativeUnknownFields'>, NativeField>);
const fail = (): never => { throw new NativeChunkError('Invalid native Layout model reference'); };
function validate(value: ModelReference): void {
  if (!Number.isInteger(value.id) || value.id < 1 || value.id > 0xffffffff) fail();
  const t = value.target;
  if (t.kind === 'cloud') {
    if (!t.documentId || !t.revisionId || !Number.isSafeInteger(t.revisionNumber) || t.revisionNumber < 1 || !/^[0-9a-f]{64}$/.test(t.sha256)) fail();
  } else if (t.kind !== 'path') fail();
}
export function encodeNativeLayoutReference(value: ModelReference, extensions: LayoutReferenceExtensions = new Map()): Uint8Array {
  validate(value);
  const t = value.target;
  let fields: Record<string, NativeScalar>;
  if (t.kind === 'cloud') fields = { documentId: t.documentId, revisionId: t.revisionId, revisionNumber: t.revisionNumber, sha256: t.sha256, pinned: t.pinned };
  else { fields = { path: t.path }; if (t.contentHash !== null) fields.contentHash = t.contentHash; }
  return reference.encode({ fields: { id: value.id, displayName: value.displayName, kind: t.kind === 'cloud' ? 1 : 0,
    target: (t.kind === 'cloud' ? cloud : path).encode({ fields, unknownFields: t.nativeUnknownFields ?? extensions.get('target') ?? [] }) }, unknownFields: value.nativeUnknownFields?.unknownFields ?? extensions.get('') ?? [] });
}
export function decodeNativeLayoutReference(bytes: Uint8Array): { value: ModelReference; extensions: LayoutReferenceExtensions } {
  const r = reference.decode(bytes), kind = r.fields.kind;
  if (kind !== 0 && kind !== 1) return fail();
  const t = (kind === 1 ? cloud : path).decode(r.fields.target as Uint8Array), fields = t.fields;
  const target: ModelReference['target'] = kind === 1 ? { kind: 'cloud', documentId: fields.documentId as string, revisionId: fields.revisionId as string,
    revisionNumber: fields.revisionNumber as number, sha256: fields.sha256 as string, pinned: fields.pinned as boolean }
    : { kind: 'path', path: fields.path as string, contentHash: Object.hasOwn(fields, 'contentHash') ? fields.contentHash as string : null };
  const value: ModelReference = { id: r.fields.id as number, displayName: r.fields.displayName as string, target }; validate(value);
  const extensions: LayoutReferenceExtensions = new Map();
  if (r.unknownFields.length) extensions.set('', r.unknownFields);
  if (t.unknownFields.length) extensions.set('target', t.unknownFields);
  return { value, extensions };
}
