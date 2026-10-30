// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import type { ModelReference } from '@pushform/layout';
import { decodeNativeLayoutReference, encodeNativeLayoutReference } from './layoutReference';
const root = protobuf.parse(readFileSync(new URL('./layoutReference.proto', import.meta.url), 'utf8')).root;
const schema = root.lookupType('pushform.native.LayoutModelReference');
const cloud: ModelReference = { id: 42, displayName: 'House', target: { kind: 'cloud', documentId: 'document', revisionId: 'revision', revisionNumber: 0x100000001, sha256: 'a'.repeat(64), pinned: true } };
it('preserves cloud revision identity/pinning and path null versus empty hash', () => {
  const values: ModelReference[] = [cloud, { ...cloud, target: { ...cloud.target as Extract<ModelReference['target'], { kind: 'cloud' }>, pinned: false } },
    ...[null, '', 'hash'].map(contentHash => ({ id: 43, displayName: '', target: { kind: 'path' as const, path: '../models/房子.skp', contentHash } }))];
  for (const value of values) {
    const bytes = encodeNativeLayoutReference(value);
    expect(decodeNativeLayoutReference(bytes).value).toEqual(value);
    expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    const { kind, ...fields } = value.target;
    const targetSchema = root.lookupType(kind === 'cloud' ? 'pushform.native.LayoutCloudTarget' : 'pushform.native.LayoutPathTarget');
    expect(Array.from(targetSchema.encode(fields).finish())).toEqual(Array.from(schema.decode(bytes).target as Uint8Array));
  }
});
it('retains future reference and target fields while editing the reference name', () => {
  const fields = [new Uint8Array([0x98, 6, 7])], extensions = new Map<'' | 'target', Uint8Array[]>([['', fields], ['target', fields]]);
  const bytes = encodeNativeLayoutReference(cloud, extensions), decoded = decodeNativeLayoutReference(bytes); bytes.fill(0);
  decoded.value.displayName = 'Renamed';
  expect(decodeNativeLayoutReference(encodeNativeLayoutReference(decoded.value, decoded.extensions))).toEqual(decoded);
});
it('rejects unsupported targets, malformed hashes and invalid revision identities', () => {
  const record = schema.toObject(schema.decode(encodeNativeLayoutReference(cloud)));
  expect(() => decodeNativeLayoutReference(schema.encode({ ...record, kind: 2 }).finish())).toThrow();
  const target = root.lookupType('pushform.native.LayoutCloudTarget'), value = target.toObject(target.decode(record.target));
  for (const patch of [{ documentId: '' }, { revisionId: '' }, { revisionNumber: 0 }, { sha256: 'wrong' }]) {
    expect(() => decodeNativeLayoutReference(schema.encode({ ...record, target: target.encode({ ...value, ...patch }).finish() }).finish())).toThrow();
  }
});
