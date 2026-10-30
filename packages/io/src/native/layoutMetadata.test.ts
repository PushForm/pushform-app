// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { expect, it } from 'vitest';
import { createLayoutDocumentState } from '@pushform/layout';
import { decodeNativeLayoutMetadata, encodeNativeLayoutMetadata, decodeNativeLayoutLayer, encodeNativeLayoutLayer, validateNativeLayoutLayers } from './layoutMetadata';
import type { NativeLayoutMetadata, LayoutMetadataExtensions } from './layoutMetadata';
const root = protobuf.loadSync(fileURLToPath(new URL('./layoutMetadata.proto', import.meta.url))).resolveAll();
it('composes actual Layout metadata, settings and styles with schema interoperability', () => {
  const state = createLayoutDocumentState();
  const value: NativeLayoutMetadata = { meta: state.meta, settings: state.settings, defaultStyle: state.defaultStyle, activeLayerId: state.activeLayerId };
  const bytes = encodeNativeLayoutMetadata(value), schema = root.lookupType('pushform.native.LayoutMetadata');
  expect(decodeNativeLayoutMetadata(bytes).value).toEqual(value);
  expect(Array.from(schema.encode(schema.decode(bytes)).finish())).toEqual(Array.from(bytes));
  const layers = new Map([...state.layers].map(([id, layer]) => [id, decodeNativeLayoutLayer(encodeNativeLayoutLayer(layer)).value]));
  expect(layers).toEqual(state.layers); expect(() => validateNativeLayoutLayers(value, layers, state.layerOrder)).not.toThrow();
  const layerSchema = root.lookupType('pushform.native.LayoutLayer');
  for (const layer of state.layers.values()) expect(Array.from(layerSchema.encode(layer).finish())).toEqual(Array.from(encodeNativeLayoutLayer(layer)));
});
it('preserves future fields at every composed scope after a known edit', () => {
  const fields = [new Uint8Array([0x98, 6, 7])];
  const ext: LayoutMetadataExtensions = { records: new Map([['', fields], ['meta', fields]]), settings: new Map([['grid', fields]]), style: new Map([['', fields]]) };
  const bytes = encodeNativeLayoutMetadata(createLayoutDocumentState(), ext), decoded = decodeNativeLayoutMetadata(bytes); bytes.fill(0);
  decoded.value.settings.grid.show = false;
  expect(decodeNativeLayoutMetadata(encodeNativeLayoutMetadata(decoded.value, decoded.extensions)).extensions).toEqual(ext);
  const value = [...createLayoutDocumentState().layers.values()][0]!;
  expect(decodeNativeLayoutLayer(encodeNativeLayoutLayer(value, fields))).toEqual({ value, unknownFields: fields });
});
it('rejects stale allocators, missing/duplicate/mismatched layers and keeps exhausted allocator precision', () => {
  const state = createLayoutDocumentState();
  expect(() => encodeNativeLayoutMetadata({ ...state, meta: { ...state.meta, nextId: state.activeLayerId } })).toThrow();
  expect(() => validateNativeLayoutLayers(state, new Map(), [])).toThrow();
  expect(() => validateNativeLayoutLayers(state, state.layers, [...state.layerOrder, state.activeLayerId])).toThrow();
  const layers = new Map(state.layers); layers.set(state.activeLayerId, { ...layers.get(state.activeLayerId)!, id: 999 });
  expect(() => validateNativeLayoutLayers(state, layers, state.layerOrder)).toThrow();
  const value = { ...state, meta: { ...state.meta, nextId: 0x100000000 } };
  expect(decodeNativeLayoutMetadata(encodeNativeLayoutMetadata(value)).value.meta.nextId).toBe(value.meta.nextId);
});
