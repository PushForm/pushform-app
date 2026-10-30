// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { m4translation, meshBox, type DefId, type Id, type ImageId, type Mat4, type Ray, type Vec2, type Vec3 } from '@pushform/core';
import { allocId, bodyFromMesh, createDocument, createEntityContainer, newImageEntity, type DocumentDraft, type EntityContainer, type Draft } from '@pushform/model';
import { InferenceEngineImpl } from './InferenceEngineImpl';
import { insideParallelogram } from './PickService';
import type { InferenceInput } from './types';

// Placed pictures are picked and selected like surfaces.
const PX = 0.01;
const down = (x: number, y: number, z = 100): Ray => ({ origin: [x, y, z], dir: [0, 0, -1] });
const input = (ray: Ray): InferenceInput => ({ ray, screen: [0, 0], pixelSizeAt: () => PX, project: (p: Vec3): Vec2 => [p[0], p[1]] });

function fixture() {
  const doc = createDocument();
  let picture = 0 as Id, high = 0 as Id, inGroup = 0 as Id, hidden = 0 as Id, inst = 0 as Id, box = 0 as Id;
  doc.transact('fixture', (d: DocumentDraft) => {
    const root = d.definitions.get(d.rootDefinitionId)!.entities;
    const place = (container: EntityContainer, at: Vec3, w: number, h: number, extra: { hidden?: boolean } = {}): Id => {
      const id = allocId<Id>(d);
      container.images.set(id, { ...newImageEntity(id, 7 as ImageId, m4translation(at) as unknown as Mat4, w, h, d.defaultTagId), ...extra });
      container.order.push(id);
      return id;
    };
    picture = place(root as unknown as EntityContainer, [0, 0, 0], 4, 2);
    high = place(root as unknown as EntityContainer, [10, 0, 5], 1, 1);
    hidden = place(root as unknown as EntityContainer, [20, 0, 0], 1, 1, { hidden: true });
    // A box standing on part of the first picture hides it from above.
    box = bodyFromMesh(d, meshBox([3, 1, 0], [3.5, 1.5, 1]), { container: root as unknown as Draft<EntityContainer> }).id;
    const def = allocId<DefId>(d);
    d.definitions.set(def, { ...d.definitions.get(d.rootDefinitionId)!, id: def, name: 'G', isGroup: true, entities: createEntityContainer(), bounds: null } as never);
    inGroup = place(d.definitions.get(def)!.entities as unknown as EntityContainer, [0, 0, 0], 1, 1);
    inst = allocId<Id>(d);
    root.instances.set(inst, { id: inst, definitionId: def, transform: m4translation([30, 0, 0]) as unknown as Mat4, name: '', materialId: null, tagId: d.defaultTagId,
      hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {} } as never);
    root.order.push(inst);
  });
  const engine = new InferenceEngineImpl({ clock: () => 0 });
  engine.setState(doc.state);
  return { engine, picture, high, inGroup, hidden, inst, box };
}

describe('picking placed pictures', () => {
  it('picks a picture under the cursor and nothing beside it', () => {
    const { engine, picture, high, hidden } = fixture();
    expect(engine.pick(input(down(1, 1)))?.ref).toEqual({ kind: 'image', path: [], id: picture });
    expect(engine.pick(input(down(1, 1)))?.point).toEqual([1, 1, 0]);
    expect(engine.pick(input(down(5, 3)))).toBeNull();
    expect(engine.pick(input(down(10.5, 0.5)))?.ref).toEqual({ kind: 'image', path: [], id: high });
    // Hidden pictures are not picked.
    expect(engine.pick(input(down(20.5, 0.5)))).toBeNull();
    expect(hidden).toBeGreaterThan(0);
  });

  it('is hidden by a solid in front of it, and from inside a group resolves to the group', () => {
    const { engine, box, inGroup, inst } = fixture();
    expect(engine.pick(input(down(3.2, 1.2)))?.ref).toMatchObject({ kind: 'face', id: box });
    const fromRoot = engine.pick(input(down(30.5, 0.5)))!;
    expect(fromRoot.ref).toEqual({ kind: 'image', path: [inst], id: inGroup });
    expect(fromRoot.selectable).toEqual({ kind: 'instance', path: [], id: inst });
    expect(engine.pick(input(down(30.5, 0.5)), { context: [inst] })!.selectable).toEqual({ kind: 'image', path: [inst], id: inGroup });
  });

  it('is selected by a window around it, and by a crossing box touching it', () => {
    const { engine, picture } = fixture();
    engine.pick(input(down(0, 0)));
    const whole = { min: [-0.5, -0.5] as Vec2, max: [4.5, 2.5] as Vec2 };
    expect(engine.pickBox({ ...whole, mode: 'window' })).toContainEqual({ kind: 'image', path: [], id: picture });
    const part = { min: [-0.5, -0.5] as Vec2, max: [1, 1] as Vec2 };
    expect(engine.pickBox({ ...part, mode: 'window' })).not.toContainEqual({ kind: 'image', path: [], id: picture });
    expect(engine.pickBox({ ...part, mode: 'crossing' })).toContainEqual({ kind: 'image', path: [], id: picture });
  });

  it('tests points against turned and sheared parallelograms', () => {
    const c: [Vec3, Vec3, Vec3, Vec3] = [[0, 0, 0], [2, 1, 0], [2.5, 3, 0], [0.5, 2, 0]];
    expect(insideParallelogram([1.25, 1.5, 0], c)).toBe(true);
    expect(insideParallelogram([2, 0, 0], c)).toBe(false);
    expect(insideParallelogram([0.5, 2, 0], c)).toBe(true);
  });
});
