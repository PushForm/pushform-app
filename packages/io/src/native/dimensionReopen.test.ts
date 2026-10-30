// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import type { DefId, Id } from '@pushform/core';
import { allocId, createDocument, createEntityContainer, resolveDimension } from '@pushform/model';
import { encodeModelSnapshot, openModelFile } from '../nativeFileClient';

it('keeps nested dimension attachments editable after native save and reopen', async () => {
  const doc = createDocument();
  const ids = doc.transact('fixture', d => {
    const root = d.definitions.get(d.rootDefinitionId)!, child = allocId<DefId>(d), instance = allocId<Id>(d), vertex = allocId<Id>(d), dimension = allocId<Id>(d);
    const entities = createEntityContainer(); entities.sketch.vertices.set(vertex, { id: vertex, p: [1, 2, 3] });
    d.definitions.set(child, { ...root, id: child, guid: crypto.randomUUID() as typeof root.guid, entities: entities as unknown as typeof root.entities });
    const common = { tagId: d.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} };
    root.entities.instances.set(instance, { ...common, id: instance, definitionId: child, name: 'Nested', materialId: null,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1] });
    root.entities.dimensions.set(dimension, { ...common, id: dimension, kind: 'linear', start: [0, 0, 0], end: [20, 2, 3],
      offset: [0, 1, 0], normal: [0, 0, 1], text: null, fontSizePt: 10, anchors: [{ kind: 'sketchVertex', path: [instance], id: vertex }, null] });
    root.entities.order.push(instance, dimension);
    return { child, instance, vertex, dimension };
  }).value;
  const opened = await openModelFile(await encodeModelSnapshot(doc.state, []));
  const restored = createDocument(); restored.replaceState(opened.state);
  const resolved = () => { const e = restored.rootDefinition.entities; return resolveDimension(restored.state, e, e.dimensions.get(ids.dimension)!); };
  expect(resolved().start).toEqual([11, 2, 3]);
  restored.transact('move attached vertex', d => { d.definitions.get(ids.child)!.entities.sketch.vertices.get(ids.vertex)!.p = [4, 2, 3]; });
  expect(resolved().start).toEqual([14, 2, 3]);
  const again = await openModelFile(await encodeModelSnapshot(restored.state, []));
  const e = again.state.definitions.get(again.state.rootDefinitionId)!.entities;
  expect(resolveDimension(again.state, e, e.dimensions.get(ids.dimension)!).start).toEqual([14, 2, 3]);

  // Intentionally retains anchors to deleted geometry and uses the stored point.
  restored.transact('delete attached instance', d => {
    const e = d.definitions.get(d.rootDefinitionId)!.entities;
    e.instances.delete(ids.instance); e.order = e.order.filter(id => id !== ids.instance);
  });
  const detached = await openModelFile(await encodeModelSnapshot(restored.state, []));
  const container = detached.state.definitions.get(detached.state.rootDefinitionId)!.entities, dim = container.dimensions.get(ids.dimension)!;
  expect(dim.anchors?.[0]).toEqual({ kind: 'sketchVertex', path: [ids.instance], id: ids.vertex });
  expect(resolveDimension(detached.state, container, dim).start).toEqual([0, 0, 0]);
});
