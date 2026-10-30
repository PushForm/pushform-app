// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { m4scaling, m4translation, meshBox, type DefId, type Id, type Mat4 } from '@pushform/core';
import { createDocument } from './Document';
import { bodyFromMesh } from './body/BodyBuilder';
import { createEntityContainer } from './entities';
import { entityCounts, modelStatistics } from './statistics';

/** A unit cube at the root and a Cube component with a unit cube, placed twice, the second scaled by 2. */
function fixture() {
  const doc = createDocument();
  doc.transact('fixture', d => {
    const root = d.definitions.get(d.rootDefinitionId)!;
    bodyFromMesh(d, meshBox([0, 0, 0], [1, 1, 1]), { container: root.entities });
    const def = d.meta.nextId++ as DefId;
    d.definitions.set(def, { ...root, id: def, name: 'Cube', isGroup: false, entities: createEntityContainer(), bounds: null } as never);
    bodyFromMesh(d, meshBox([0, 0, 0], [1, 1, 1]), { container: d.definitions.get(def)!.entities });
    for (const transform of [m4translation([5, 0, 0]), m4scaling([2, 2, 2])]) {
      const id = d.meta.nextId++ as Id;
      root.entities.instances.set(id, { id, definitionId: def, transform: transform as unknown as Mat4, name: '', materialId: null,
        tagId: d.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} } as never);
    }
  });
  return doc;
}

describe('modelStatistics', () => {
  it('counts every placement again and scales volume and area by it', () => {
    const doc = fixture();
    const stats = modelStatistics(doc.state);
    expect(stats).toMatchObject({ faces: 18, edges: 36, definitions: 1, instances: 2, materials: 0, tags: 0, scenes: 0 });
    // Two placements of the unit cube, one scaled to 2 × 2 × 2; the cube at the top of the model has no volume, as in SketchUp.
    expect(stats.volume).toBeCloseTo(1 + 8, 9);
    expect(stats.area).toBeCloseTo(6 + 6 + 24, 9);
    expect(stats.bounds).toEqual({ min: [0, 0, 0], max: [6, 2, 2] });
  });

  it('counts no volume for a placement whose contents are not only solids, as SketchUp does not call it a solid', () => {
    const doc = fixture();
    doc.transact('stray edge', d => {
      const cube = [...d.definitions.values()].find(def => def.name === 'Cube')!.entities.sketch;
      const a = d.meta.nextId++ as Id, b = d.meta.nextId++ as Id, edge = d.meta.nextId++ as Id;
      cube.vertices.set(a, { id: a, p: [3, 0, 0] }); cube.vertices.set(b, { id: b, p: [4, 0, 0] });
      cube.edges.set(edge, { id: edge, a, b, soft: false, smooth: false, curveId: null, tagId: d.defaultTagId, hidden: false } as never);
    });
    expect(modelStatistics(doc.state).volume).toBe(0);
  });

  it('counts no volume for a placement that holds another group or component beside its solids (PF-267)', () => {
    const doc = fixture();
    doc.transact('nest', d => {
      const cube = [...d.definitions.values()].find(def => def.name === 'Cube')!;
      const inner = d.meta.nextId++ as DefId;
      d.definitions.set(inner, { ...cube, id: inner, name: 'Inner', isGroup: true, entities: createEntityContainer(), bounds: null } as never);
      bodyFromMesh(d, meshBox([0, 0, 0], [1, 1, 1]), { container: d.definitions.get(inner)!.entities });
      const id = d.meta.nextId++ as Id;
      cube.entities.instances.set(id, { id, definitionId: inner, transform: m4translation([0, 0, 3]) as unknown as Mat4, name: '', materialId: null,
        tagId: d.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} } as never);
    });
    // The Cube placements hold the Inner group, so only the Inner placements (inside each Cube, once scaled by 2) count.
    expect(modelStatistics(doc.state).volume).toBeCloseTo(1 + 8, 9);
  });
});

describe('entityCounts', () => {
  it('counts the top level, or every placement with nested on', () => {
    const doc = fixture();
    expect(entityCounts(doc.state, false)).toMatchObject({ solids: 1, solidFaces: 6, sheetFaces: 0, edges: 12, groups: 0, componentInstances: 2,
      componentDefinitions: 1, materials: 0, tags: 0, styles: doc.state.styles.size, scenes: 0 });
    expect(entityCounts(doc.state, true)).toMatchObject({ solids: 3, solidFaces: 18, edges: 36, groups: 0, componentInstances: 2, componentDefinitions: 1 });
  });
});
