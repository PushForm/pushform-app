// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CommonAttrs } from '@pushform/model';
import type { TagId } from '@pushform/core';
import { NativeRecordCodec } from './record';
import type { NativeField } from './record';
import { encodeNativeAttributes, decodeNativeAttributes } from './attributes';
import type { AttributeExtensions } from './attributes';

export interface CommonAttrsExtensions {
  fields: Uint8Array[];
  attributes: AttributeExtensions;
}
const codec = new NativeRecordCodec({
  tagId: { id: 1, kind: 'uint32', required: true },
  hidden: { id: 2, kind: 'bool', required: true },
  locked: { id: 3, kind: 'bool', required: true },
  castShadows: { id: 4, kind: 'bool', required: true },
  receiveShadows: { id: 5, kind: 'bool', required: true },
  attributes: { id: 6, kind: 'bytes', required: true },
} satisfies Record<Exclude<keyof CommonAttrs, 'nativePropertyUnknownFields'>, NativeField>);

export function encodeNativeCommonAttrs(value: CommonAttrs, extensions?: CommonAttrsExtensions): Uint8Array {
  return codec.encode({ fields: {
    tagId: value.tagId, hidden: value.hidden, locked: value.locked, castShadows: value.castShadows,
    receiveShadows: value.receiveShadows, attributes: encodeNativeAttributes(value.attributes, extensions?.attributes),
  }, unknownFields: extensions?.fields ?? [] });
}

export function decodeNativeCommonAttrs(bytes: Uint8Array): { value: CommonAttrs; extensions: CommonAttrsExtensions } {
  const decoded = codec.decode(bytes), f = decoded.fields, attributes = decodeNativeAttributes(f.attributes as Uint8Array);
  return { value: { tagId: f.tagId as TagId, hidden: f.hidden as boolean, locked: f.locked as boolean,
    castShadows: f.castShadows as boolean, receiveShadows: f.receiveShadows as boolean, attributes: attributes.value },
  extensions: { fields: decoded.unknownFields, attributes: attributes.extensions } };
}
