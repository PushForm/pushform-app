// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Mat4, MeshData, Vec3 } from '@pushform/core';
import { Plane, Vector3 } from 'three';
import type { Material, Object3D } from 'three';
import type { RenderSectionCut } from '../types';

/**
 * Where a cut crosses a body: the segments in which the plane `dot(normal, p) + d = 0` meets the mesh's
 * triangles after `transform`, made relative to `origin`, as `[x1, y1, z1, x2, y2, z2, …]`. Triangles lying in the
 * plane contribute nothing.
 */
export function sectionSegments(mesh: MeshData, transform: Mat4, normal: Vec3, d: number, origin: Vec3): Float32Array {
  const { verts, tris } = mesh;
  const n = verts.length / 3;
  const world = new Float64Array(verts.length);
  const dist = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = verts[i * 3]!, y = verts[i * 3 + 1]!, z = verts[i * 3 + 2]!;
    const wx = transform[0]! * x + transform[4]! * y + transform[8]! * z + transform[12]!;
    const wy = transform[1]! * x + transform[5]! * y + transform[9]! * z + transform[13]!;
    const wz = transform[2]! * x + transform[6]! * y + transform[10]! * z + transform[14]!;
    world[i * 3] = wx; world[i * 3 + 1] = wy; world[i * 3 + 2] = wz;
    dist[i] = normal[0] * wx + normal[1] * wy + normal[2] * wz + d;
  }
  const out: number[] = [];
  const crossing = (a: number, b: number): void => {
    const t = dist[a]! / (dist[a]! - dist[b]!);
    for (let k = 0; k < 3; k++) out.push(world[a * 3 + k]! + (world[b * 3 + k]! - world[a * 3 + k]!) * t - origin[k]!);
  };
  for (let t = 0; t < tris.length; t += 3) {
    const v = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
    const s = v.map((i) => dist[i]!);
    // A vertex exactly on the plane counts as positive, so an edge in the plane is drawn once by its neighbours.
    const pos = s.map((x) => x >= 0);
    if (pos[0] === pos[1] && pos[1] === pos[2]) continue;
    const before = out.length;
    for (let e = 0; e < 3; e++) {
      const a = v[e]!, b = v[(e + 1) % 3]!;
      if (pos[e] !== pos[(e + 1) % 3]) crossing(a, b);
    }
    if (out.length - before !== 6) out.length = before;
  }
  return new Float32Array(out);
}

/** A cut as a three.js clipping plane in render coordinates (relative to `origin`): three keeps `dot(n, x) + c >= 0`. */
export function clipPlaneOf(cut: Pick<RenderSectionCut, 'normal' | 'd'>, origin: Vec3): Plane {
  const n = cut.normal;
  return new Plane(new Vector3(n[0], n[1], n[2]), cut.d + n[0] * origin[0] + n[1] * origin[1] + n[2] * origin[2]);
}

const noop = (): void => undefined;

/**
 * Clip every mesh and line under `object` by `planes`. Body and sketch materials are shared, so the planes
 * are set on each material just before the object draws and cleared right after; an empty list removes the hooks.
 */
export function setObjectClipping(object: Object3D, planes: readonly Plane[]): void {
  const list = [...planes];
  object.traverse((o) => {
    if (!('material' in o)) return;
    if (!list.length) {
      o.onBeforeRender = noop;
      o.onAfterRender = noop;
      return;
    }
    o.onBeforeRender = (_r, _s, _c, _g, material: Material) => { material.clippingPlanes = list; };
    o.onAfterRender = (_r, _s, _c, _g, material: Material) => { material.clippingPlanes = null; };
  });
}
