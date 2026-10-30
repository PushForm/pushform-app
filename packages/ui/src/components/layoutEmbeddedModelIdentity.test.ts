// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Id } from '@pushform/core';
import { createDocument } from '@pushform/model';
import { applySketchUpImport, readSketchUp } from '@pushform/io';
import { layoutEmbeddedModelIdentity } from './layoutEmbeddedModelIdentity';

function converted() {
  const doc = createDocument();
  doc.transact('Imported vertices', state => {
    const sketch = state.definitions.get(state.rootDefinitionId)!.entities.sketch;
    sketch.vertices.set(100 as Id, { id: 100 as Id, p: [0, 0, 0] });
    sketch.vertices.set(101 as Id, { id: 101 as Id, p: [1, 0, 0] });
  });
  return doc;
}

it('retains embedded identity across fresh conversions and map insertion order', async () => {
  const first = converted(), second = converted(), source = new Uint8Array([1, 2, 3]);
  expect(first.state.meta.guid).not.toBe(second.state.meta.guid);
  second.transact('Reorder without changing identity', state => {
    const sketch = state.definitions.get(state.rootDefinitionId)!.entities.sketch;
    const vertex = sketch.vertices.get(100 as Id)!;
    sketch.vertices.delete(100 as Id); sketch.vertices.set(100 as Id, vertex);
  });
  expect(await layoutEmbeddedModelIdentity(first.state, source)).toBe(await layoutEmbeddedModelIdentity(second.state, source));
});

it('invalidates generated identity if an importer reuses vertex IDs for different geometry or source bytes change', async () => {
  const doc = converted(), source = new Uint8Array([1, 2, 3]);
  const before = await layoutEmbeddedModelIdentity(doc.state, source);
  expect(await layoutEmbeddedModelIdentity(doc.state, new Uint8Array([1, 2, 4]))).not.toBe(before);
  doc.transact('Changed importer allocation', state => {
    const sketch = state.definitions.get(state.rootDefinitionId)!.entities.sketch;
    sketch.vertices.get(100 as Id)!.p = [1, 0, 0];
    sketch.vertices.get(101 as Id)!.p = [0, 0, 0];
  });
  expect(await layoutEmbeddedModelIdentity(doc.state, source)).not.toBe(before);
});

it('produces the same identity after independently parsing and converting a real embedded SketchUp model', async () => {
  const bytes = readFileSync('packages/testing/assets/sketchup/import-basics.skp');
  const identities: string[] = [];
  for (let run = 0; run < 2; run++) {
    const scene = await readSketchUp(bytes), doc = createDocument();
    doc.transact('Convert preserved source', state => applySketchUpImport(state, scene));
    identities.push(await layoutEmbeddedModelIdentity(doc.state, bytes));
  }
  expect(identities[0]).toBe(identities[1]);
});
