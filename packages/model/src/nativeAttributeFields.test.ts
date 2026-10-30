// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { nativeAttributeScope } from './nativeAttributeFields';
import { createDocument } from './Document';
import { SketchGraph } from './sketch/SketchGraph';
import type { CommonAttrs } from './entities/common';
import type { EntityContainer } from './entities/definition';

it('resolves exact named dictionary scopes, wrappers and unsupported indexed owners', () => {
  const key = 'slash/quote"\\\n', root = `/${JSON.stringify(key)}`, leaf = `${root}/object/"value"`;
  const attributes = { [key]: { value: { nested: null }, list: [1, 2] } };
  for (const path of ['', `${root}/entry`, `${root}/object`, leaf, `${leaf}/entry`, `${leaf}/object`, `${leaf}/object/"nested"/null`, `${root}/object/"list"/list`]) {
    expect(nativeAttributeScope(attributes, path), path).toBe('present');
  }
  for (const path of [root, `${root}/object/"missing"`, `${leaf}/null`, `${leaf}/list`, `${root}/object/"list"/object`, '/"constructor"/entry', '/bad', '/"unfinished']) {
    expect(nativeAttributeScope(attributes, path), path).toBe('missing');
  }
  expect(nativeAttributeScope(attributes, `${root}/object/"list"/list/0`)).toBe('indexed');
});

it('cleans named metadata on sketch edges through direct edits and container replacement', () => {
  const doc = createDocument(), scope = '/"data"/object/"name"';
  const id = doc.transact('edge', draft => SketchGraph.for(draft).addEdge([0, 0, 0], [1, 0, 0])[0]!).value;
  doc.transact('metadata', draft => {
    const edge = draft.definitions.get(draft.rootDefinitionId)!.entities.sketch.edges.get(id)! as unknown as CommonAttrs;
    edge.attributes = { data: { name: 'before' } };
    edge.nativePropertyUnknownFields = { attributes: new Map([[scope, [new Uint8Array([0xa0, 6, 7])]]]) };
  });
  const edge = () => doc.rootDefinition.entities.sketch.edges.get(id)!;
  for (const replace of [false, true]) {
    const edit = doc.transact('remove field', draft => {
      const entities = draft.definitions.get(draft.rootDefinitionId)!.entities as unknown as EntityContainer;
      if (replace) {
        const copy = structuredClone(doc.rootDefinition.entities.sketch);
        copy.edges.get(id)!.attributes = {};
        entities.sketch = copy;
      } else delete (entities.sketch.edges.get(id)! as unknown as CommonAttrs).attributes.data!.name;
    });
    expect(edge().nativePropertyUnknownFields).toBeUndefined();
    doc.applyPatches(edit.inversePatches, edit.patches, 'undo', 'restore edge metadata');
    expect(edge().nativePropertyUnknownFields!.attributes!.has(scope)).toBe(true);
  }
});
