// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { m4translation, meshBox } from '@pushform/core';
import { bodyFromMesh, createDocument } from '@pushform/model';
import { decodeModelSessionJson, modelSessionJson } from '../modelSession';
import { encodeNativeModelFile, decodeNativeModelFile } from './modelFile';
import { openNativeDocumentIndex } from './documentRoot';

it('retains body frames without plugin code and refuses readers that cannot carry them through edits', async () => {
  const doc = createDocument();
  const id = doc.transact('Reference frame', draft => {
    const body = bodyFromMesh(draft, meshBox([1, 2, 3], [2, 3, 4]), { container: draft.definitions.get(draft.rootDefinitionId)!.entities });
    body.referenceFrame = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]; return body.id;
  }).value;
  const bytes = await encodeNativeModelFile(doc.state);
  const source = { size: bytes.length, read: async (offset: number, length: number) => bytes.subarray(offset, offset + length) };
  await expect(openNativeDocumentIndex(source, new Set([1, 2]), () => true)).rejects.toThrow(/capability: 3/);
  const reopened = await decodeNativeModelFile(source);
  expect(reopened.state.definitions.get(reopened.state.rootDefinitionId)!.entities.bodies.get(id)!.referenceFrame).toEqual(m4translation([1, 2, 3]));
  const snapshot = decodeModelSessionJson(modelSessionJson(doc.state));
  expect(snapshot.definitions.get(snapshot.rootDefinitionId)!.entities.bodies.get(id)!.referenceFrame).toEqual(m4translation([1, 2, 3]));
  expect(doc.state.pluginData).toBeUndefined();
});
