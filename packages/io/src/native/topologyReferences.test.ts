// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { meshBox } from '@pushform/core';
import { bodyFromMesh, createDocument } from '@pushform/model';
import { decodeModelSessionJson, modelSessionJson } from '../modelSession';
import { encodeNativeModelFile, decodeNativeModelFile } from './modelFile';
import { openNativeDocumentIndex } from './documentRoot';

it('persists topology envelopes without plugin code and requires a reader that maintains their semantics', async () => {
  const doc = createDocument();
  doc.transact('Solid with opaque attachments', draft => {
    const body = bodyFromMesh(draft, meshBox([0, 0, 0], [.6, .3, .018]), { container: draft.definitions.get(draft.rootDefinitionId)!.entities });
    draft.pluginData = new Map([['io.example.parts', { dataVersion: 99, entries: new Map([['part', { target: { kind: 'body', id: body.id }, payload: new Uint8Array([255, 0, 128]), references: [
      { target: { kind: 'body', id: body.id }, element: { kind: 'face', faceId: 1, bodyVersion: body.version } },
      { target: { kind: 'bodyOccurrence', id: body.id, path: [] }, element: { kind: 'edge', edgeKey: [...body.edges.keys()][0]!, bodyVersion: body.version }, unresolved: true },
    ] }]]) }]]);
  });
  const bytes = await encodeNativeModelFile(doc.state);
  const source = { size: bytes.length, read: async (offset: number, length: number) => bytes.subarray(offset, offset + length) };
  await expect(openNativeDocumentIndex(source, new Set([1, 2, 3]), () => true)).rejects.toThrow(/capability: 4/);
  expect((await decodeNativeModelFile(source)).state.pluginData).toEqual(doc.state.pluginData);
  expect(decodeModelSessionJson(modelSessionJson(doc.state)).pluginData).toEqual(doc.state.pluginData);
});
