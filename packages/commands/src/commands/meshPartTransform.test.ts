// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import type { Id, Vec3 } from '@pushform/core';
import { m4translation, v3cross, v3sub } from '@pushform/core';
import { allocId, containerAt } from '@pushform/model';
import type { EntityRef, MeshPart, MeshPartGeometry } from '@pushform/model';
import { disposeKernels, setupCommands } from './transform.fixtures';
import { contextCommands } from './context';
import { clipboardCommands, modelClipboard } from './clipboard';
import { groupCommands, type ExplodeResult, type MakeResult } from './groups';
import type { TransformApplyResult } from './transform';

afterEach(() => {
  modelClipboard.set(null);
  disposeKernels();
});

/** A unit square in z = 1 (two triangles facing +z) with one two-point edge along its bottom. */
function squareGeometry(): MeshPartGeometry {
  return {
    positions: new Float64Array([0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]),
    triangles: new Uint32Array([0, 1, 2, 0, 2, 3]),
    triangleFace: new Uint32Array([0, 0]),
    faceCount: 1,
    faceMaterials: new Uint32Array([0]),
    edgeOffsets: new Uint32Array([0, 2]),
    edgePositions: new Float64Array([0, 0, 1, 1, 0, 1]),
    edgeFlags: new Uint8Array([0]),
  };
}

function setup() {
  const s = setupCommands();
  s.registry.registerAll(groupCommands);
  s.registry.registerAll(contextCommands);
  s.registry.registerAll(clipboardCommands);
  const addMeshPart = (geometry = squareGeometry()): Id => {
    let id = 0 as Id;
    s.host.doc.transact('mesh part', (draft) => {
      const entities = draft.definitions.get(draft.rootDefinitionId)!.entities;
      id = allocId<Id>(draft);
      const part: MeshPart = {
        id, name: 'Bracket', source: { format: 'STEP', system: '' }, tagId: draft.defaultTagId,
        hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {}, materialId: null, geometry,
      };
      entities.meshParts.set(id, part as never);
      entities.order.push(id);
    });
    return id;
  };
  const partRef = (id: number, path: readonly number[] = []): EntityRef => ({ kind: 'meshPart', path: path as Id[], id: id as Id });
  const part = (id: number, path: readonly number[] = []): MeshPart => containerAt(s.host.doc.state, path as Id[]).meshParts.get(id as Id)!;
  const select = (refs: EntityRef[]): void => {
    s.registry.execute('selection.set', { refs });
  };
  return { ...s, addMeshPart, partRef, part, select };
}

const triangleNormal = (g: MeshPartGeometry, t: number): Vec3 => {
  const v = (i: number): Vec3 => [g.positions[i * 3]!, g.positions[i * 3 + 1]!, g.positions[i * 3 + 2]!];
  const a = v(g.triangles[t * 3]!), b = v(g.triangles[t * 3 + 1]!), c = v(g.triangles[t * 3 + 2]!);
  return v3cross(v3sub(b, a), v3sub(c, a));
};

describe('transform.apply on mesh parts', () => {
  it('moves a part: positions and edge points translate into a new geometry object, the index arrays are shared, undo restores', async () => {
    const { host, apply, addMeshPart, partRef, part } = setup();
    const id = addMeshPart();
    const before = part(id).geometry;
    const res = await apply({ refs: [partRef(id)], matrix: m4translation([1, 2, 3]) });
    expect(res.meshPartIds).toEqual([id]);
    expect(res.refs).toEqual([partRef(id)]);
    const after = part(id).geometry;
    expect(after).not.toBe(before);
    expect(Array.from(after.positions)).toEqual([1, 2, 4, 2, 2, 4, 2, 3, 4, 1, 3, 4]);
    expect(Array.from(after.edgePositions)).toEqual([1, 2, 4, 2, 2, 4]);
    expect(after.triangles).toBe(before.triangles);
    expect(Array.from(before.positions)).toEqual([0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
    expect(host.undo()).toBe(true);
    expect(Array.from(part(id).geometry.positions)).toEqual(Array.from(before.positions));
  });

  it('copy: true leaves the source and adds a moved part with a new id', async () => {
    const { apply, addMeshPart, partRef, part, root } = setup();
    const id = addMeshPart();
    const res = await apply({ refs: [partRef(id)], matrix: m4translation([0, 5, 0]), copy: true });
    const copyId = res.refs[0]!.id;
    expect(copyId).not.toBe(id);
    expect(root().meshParts.size).toBe(2);
    expect(root().order).toContain(copyId);
    expect(part(copyId).geometry.positions[1]).toBe(5);
    expect(part(id).geometry.positions[1]).toBe(0);
  });

  it('Flip Along mirrors the part and reverses the winding so the faces keep facing outward', () => {
    const { registry, addMeshPart, partRef, part } = setup();
    const id = addMeshPart();
    expect(triangleNormal(part(id).geometry, 0)[2]).toBeGreaterThan(0);
    return (registry.execute('edit.flipAlong', { refs: [partRef(id)], axis: 'x' }) as Promise<TransformApplyResult>).then(() => {
      const g = part(id).geometry;
      expect(Array.from(g.positions)).toEqual([1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1]);
      expect(Array.from(g.triangles)).toEqual([0, 2, 1, 0, 3, 2]);
      expect(triangleNormal(g, 0)[2]).toBeGreaterThan(0);
      expect(triangleNormal(g, 1)[2]).toBeGreaterThan(0);
    });
  });
});

describe('edit.copy / edit.paste on mesh parts', () => {
  it('pastes in place a new part with a new id sharing the geometry object', () => {
    const { registry, host, addMeshPart, partRef, part, root, select } = setup();
    const id = addMeshPart();
    select([partRef(id)]);
    registry.execute('edit.copy');
    const refs = registry.execute('edit.pasteInPlace') as EntityRef[];
    expect(refs).toHaveLength(1);
    expect(refs[0]!.kind).toBe('meshPart');
    const pasted = part(refs[0]!.id);
    expect(pasted.id).not.toBe(id);
    expect(pasted.geometry).toBe(part(id).geometry);
    expect(pasted.name).toBe('Bracket');
    expect(root().order).toContain(pasted.id);
    expect(host.selection.refs).toEqual(refs);
    host.undo();
    expect(root().meshParts.size).toBe(1);
  });

  it('cut removes the part and paste at a point moves the geometry there', () => {
    const { registry, addMeshPart, partRef, part, root, select } = setup();
    const id = addMeshPart();
    select([partRef(id)]);
    registry.execute('edit.cut');
    expect(root().meshParts.size).toBe(0);
    expect(modelClipboard.current?.insertionPoint).toEqual([0, 0, 1]);
    const refs = registry.execute('edit.pasteAt', { point: [3, 0, 1] }) as EntityRef[];
    expect(refs).toHaveLength(1);
    expect(Array.from(part(refs[0]!.id).geometry.positions).slice(0, 3)).toEqual([3, 0, 1]);
  });
});

describe('group.make / group.explode with mesh parts', () => {
  it('Make Group moves the part into the definition, in its local coordinates; Explode moves it back out', () => {
    const { registry, addMeshPart, partRef, part, root, host } = setup();
    const id = addMeshPart();
    const r = registry.execute('group.make', { refs: [partRef(id)] }) as MakeResult;
    expect(root().meshParts.size).toBe(0);
    expect(root().order).not.toContain(id);
    const def = host.doc.state.definitions.get(r.definitionId as never)!;
    const inner = def.entities.meshParts.get(id)!;
    expect(inner).toBeDefined();
    expect(def.entities.order).toEqual([id]);
    expect(Array.from(inner.geometry.positions).slice(0, 3)).toEqual([0, 0, 0]);
    const inst = root().instances.get(r.instanceId as Id)!;
    expect([inst.transform[12], inst.transform[13], inst.transform[14]]).toEqual([0, 0, 1]);
    expect(part(id, [r.instanceId!]).geometry.positions[2]).toBe(0);

    const ex = registry.execute('group.explode', { refs: [{ kind: 'instance', path: [], id: r.instanceId }] }) as ExplodeResult;
    expect(ex.refs).toEqual([partRef(id)]);
    expect(root().meshParts.get(id)).toBeDefined();
    expect(Array.from(part(id).geometry.positions)).toEqual([0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  });

  it('Make Component with a body and a part takes both', () => {
    const { registry, addMeshPart, addBox, partRef, root, host } = setup();
    const id = addMeshPart();
    const box = addBox([2, 0, 0], [3, 1, 1]);
    const r = registry.execute('component.make', { refs: [partRef(id), { kind: 'body', path: [], id: box }] }) as MakeResult;
    const def = host.doc.state.definitions.get(r.definitionId as never)!;
    expect(def.entities.meshParts.size).toBe(1);
    expect(def.entities.bodies.size).toBe(1);
    expect(root().meshParts.size).toBe(0);
    expect(root().bodies.size).toBe(0);
  });
});
