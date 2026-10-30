// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { meshBox } from '@pushform/core';
import { bodyFromMesh, createDocument } from '@pushform/model';
import type { Body } from '@pushform/model';
import { modelContentIdentity } from './modelIdentity';
import { encodeNativeModelFile, decodeNativeModelFile } from './modelFile';
it('matches across native save/open and ignores derived caches and map insertion order', async () => {
  const doc = createDocument();
  doc.transact('boxes', d => {
    const container = d.definitions.get(d.rootDefinitionId)!.entities;
    bodyFromMesh(d, meshBox([0, 0, 0], [1, 2, 3]), { container });
    bodyFromMesh(d, meshBox([4, 0, 0], [5, 2, 3]), { container });
  });
  const original = modelContentIdentity(doc.state), bytes = await encodeNativeModelFile(doc.state);
  const opened = await decodeNativeModelFile({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) });
  expect(modelContentIdentity(opened.state)).toBe(original);
  doc.transact('derived-only', d => {
    const def = d.definitions.get(d.rootDefinitionId)!;
    def.bounds = { min: [-100, -100, -100], max: [100, 100, 100] };
    def.entities.sketch.vertexHash.set('unused derived cell', []);
    def.entities.bodies = new Map([...def.entities.bodies].reverse());
    d.meta.nextId += 100;
  });
  expect(modelContentIdentity(doc.state)).toBe(original);
  doc.transact('entity order', d => { d.definitions.get(d.rootDefinitionId)!.entities.order.reverse(); });
  expect(modelContentIdentity(doc.state)).not.toBe(original);
});
it('returns to the saved identity after undo despite monotonic allocated IDs', () => {
  const doc = createDocument(), saved = modelContentIdentity(doc.state);
  const tx = doc.transact('box', d => { bodyFromMesh(d, meshBox([0, 0, 0], [1, 2, 3]), { container: d.definitions.get(d.rootDefinitionId)!.entities }); });
  const changed = modelContentIdentity(doc.state), nextId = doc.state.meta.nextId;
  expect(changed).not.toBe(saved);
  doc.applyPatches(tx.inversePatches, tx.patches, 'undo', 'box');
  expect(doc.state.meta.nextId).toBe(nextId); expect(modelContentIdentity(doc.state)).toBe(saved);
  doc.applyPatches(tx.patches, tx.inversePatches, 'redo', 'box'); expect(modelContentIdentity(doc.state)).toBe(changed);
});
it('preserves field presence, exact floating point content, custom property names and ordering', () => {
  const doc = createDocument();
  doc.transact('body', d => { bodyFromMesh(d, meshBox([0, 0, 0], [1, 2, 3]), { container: d.definitions.get(d.rootDefinitionId)!.entities }); });
  const states = new Set([modelContentIdentity(doc.state)]);
  for (const edit of [
    () => doc.transact('custom', d => { const body = d.definitions.get(d.rootDefinitionId)!.entities.bodies.values().next().value as unknown as Body; body.attributes = { custom: { bounds: 'preserved' } }; }),
    () => doc.transact('minus zero', d => { d.definitions.get(d.rootDefinitionId)!.axes.origin = [-0, 0, 0]; }),
    () => doc.transact('optional', d => { d.meta.dimensions = undefined; }),
    () => doc.transact('units', d => { d.meta.units.lengthPrecision += 1; }),
    () => doc.transact('unicode', d => { d.definitions.get(d.rootDefinitionId)!.name = 'a\ud800b'; }),
  ]) { const tx = edit(); const identity = modelContentIdentity(doc.state); expect(states.has(identity), tx.label).toBe(false); states.add(identity); }
  expect(modelContentIdentity(doc.state)).toMatch(/^pf-model-v1-sha256:[a-f0-9]{64}$/);
});
