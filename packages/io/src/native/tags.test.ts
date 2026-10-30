// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import type { TagId, TagFolderId } from '@pushform/core';
import type { Tag, TagFolder } from '@pushform/model';
import { describe, expect, it } from 'vitest';
import { decodeNativeTag, decodeNativeTagFolder, encodeNativeTag, encodeNativeTagFolder, validateNativeTagHierarchy } from './tags';
const root = protobuf.loadSync(fileURLToPath(new URL('./tags.proto', import.meta.url))).resolveAll();
const tag = (): Tag => ({ id: 1 as TagId, name: 'Walls', visible: false, color: [0.1, 0.2, 0.3], dashes: null, folderId: null });
describe('native tags and folders', () => {
  it('preserves null versus empty dash settings and folder references with schema interoperability', () => {
    const schema = root.lookupType('pushform.native.Tag');
    for (const dashes of [null, '', 'dash']) {
      const value = { ...tag(), dashes, folderId: 2 as TagFolderId }, bytes = encodeNativeTag(value);
      expect(decodeNativeTag(bytes).value).toEqual(value);
      expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
    }
    const value: TagFolder = { id: 2 as TagFolderId, name: 'Structure', visible: false, parentId: null };
    expect(decodeNativeTagFolder(encodeNativeTagFolder(value)).value).toEqual(value);
  });
  it('preserves nested unknown fields when a known property changes', () => {
    const future = protobuf.Root.fromJSON(root.toJSON()); future.lookupType('pushform.native.Rgb').add(new protobuf.Field('extra', 90, 'bytes')); future.resolveAll();
    const schema = future.lookupType('pushform.native.Tag');
    const wire = schema.decode(encodeNativeTag(tag())) as unknown as { color: { extra: Uint8Array } }; wire.color.extra = new Uint8Array([7, 8]);
    const bytes = schema.encode(wire).finish(), decoded = decodeNativeTag(bytes); bytes.fill(0); decoded.value.visible = true;
    const result = schema.decode(encodeNativeTag(decoded.value, decoded.extensions)) as unknown as { visible: boolean; color: { extra: Uint8Array } };
    expect(result.visible).toBe(true); expect(Array.from(result.color.extra)).toEqual([7, 8]);
  });
  it('rejects missing folder links and cycles without recursive traversal', () => {
    const id = 2 as TagFolderId, folders = new Map<TagFolderId, TagFolder>([[id, { id, name: '', visible: true, parentId: null }]]);
    const tags = new Map([[1 as TagId, { ...tag(), folderId: id }]]);
    expect(() => validateNativeTagHierarchy(tags, folders)).not.toThrow();
    folders.get(id)!.parentId = id; expect(() => validateNativeTagHierarchy(tags, folders)).toThrow();
    folders.clear(); expect(() => validateNativeTagHierarchy(tags, folders)).toThrow();
  });
});
