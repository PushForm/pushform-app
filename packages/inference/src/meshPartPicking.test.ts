// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox, type Id, type Ray, type Vec2, type Vec3 } from '@pushform/core';
import { allocId, bodyFromMesh, createDocument } from '@pushform/model';
import type { MeshPart, MeshPartGeometry } from '@pushform/model';
import { InferenceEngineImpl } from './InferenceEngineImpl';
import type { InferenceInput } from './types';

/** A box from `min` to `max` as a mesh part: 6 source faces of two triangles, no edges. */
function boxGeometry(min: Vec3, max: Vec3): MeshPartGeometry {
  const c = (i: number): number[] => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const positions = Float64Array.from(Array.from({ length: 8 }, (_, i) => c(i)).flat());
  const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const triangles: number[] = [], triangleFace: number[] = [];
  faces.forEach((ring, f) => { triangles.push(ring[0]!, ring[1]!, ring[2]!, ring[0]!, ring[2]!, ring[3]!); triangleFace.push(f, f); });
  return { positions, triangles: Uint32Array.from(triangles), triangleFace: Uint32Array.from(triangleFace), faceCount: 6,
    faceMaterials: new Uint32Array(6), edgeOffsets: new Uint32Array(0), edgePositions: new Float64Array(0), edgeFlags: new Uint8Array(0) };
}
const down = (x: number, y: number): Ray => ({ origin: [x, y, 100], dir: [0, 0, -1] });
const input = (ray: Ray): InferenceInput => ({ ray, screen: [0, 0], pixelSizeAt: () => 0.01, project: (p: Vec3): Vec2 => [p[0], p[1]] });

function fixture() {
  const doc = createDocument();
  let part = 0 as Id, body = 0 as Id;
  doc.transact('fixture', d => {
    const e = d.definitions.get(d.rootDefinitionId)!.entities;
    part = allocId<Id>(d);
    const value: MeshPart = { tagId: d.defaultTagId, hidden: false, locked: false, castShadows: true, receiveShadows: true, attributes: {},
      id: part, name: 'Crate', source: { format: 'STEP', system: '' }, geometry: boxGeometry([0, 0, 0], [2, 2, 1]), materialId: null };
    e.meshParts.set(part, value as never); e.order.push(part);
    // A solid standing on the part's top, half covering it.
    body = bodyFromMesh(d, meshBox([0, 0, 1], [1, 2, 2]), { container: e }).id;
  });
  const engine = new InferenceEngineImpl({ clock: () => 0 });
  engine.setState(doc.state);
  return { doc, engine, part, body };
}

describe('mesh part picking', () => {
  it('picks the whole part under the pointer, with the plane of the triangle hit', () => {
    const f = fixture();
    const hit = f.engine.pick(input(down(1.5, 1.5)))!;
    expect(hit.ref).toEqual({ kind: 'meshPart', path: [], id: f.part });
    expect(hit.point[2]).toBeCloseTo(1, 9);
    expect(hit.normal).toEqual([0, 0, 1]);
  });

  it('is occluded by a body in front of it and occludes a body behind it', () => {
    const f = fixture();
    expect(f.engine.pick(input(down(0.5, 1)))?.ref).toMatchObject({ kind: 'face', id: f.body });
    const up: Ray = { origin: [1.5, 1.5, -10], dir: [0, 0, 1] };
    expect(f.engine.pick(input(up))?.ref).toMatchObject({ kind: 'meshPart', id: f.part });
  });

  it('answers tools that pick faces or bodies, and is left out when neither is wanted', () => {
    const f = fixture();
    for (const kinds of [['face'], ['body'], ['meshPart']] as const) {
      expect(f.engine.picker.candidates(input(down(1.5, 1.5)), { kinds: [...kinds] }).surface?.ref).toMatchObject({ kind: 'meshPart' });
    }
    expect(f.engine.picker.candidates(input(down(1.5, 1.5)), { kinds: ['sketchFace'] }).surface).toBeNull();
    expect(f.engine.picker.candidates(input(down(1.5, 1.5)), { ignore: [{ kind: 'meshPart', path: [], id: f.part }] }).surface).toBeNull();
  });

  it('drops a hidden part from the index', () => {
    const f = fixture();
    f.doc.transact('hide', d => { d.definitions.get(d.rootDefinitionId)!.entities.meshParts.get(f.part)!.hidden = true; });
    f.engine.setState(f.doc.state);
    expect(f.engine.pick(input(down(1.5, 1.5)))).toBeNull();
  });
});
