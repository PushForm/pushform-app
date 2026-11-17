// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL } from '@pushform/core';
import type { MeshData } from '@pushform/core';
import type { RenderBodyEdge } from '../types';
import { cornerAngle } from './cornerAngle';

/** Average only faces connected by smooth edges at each corner. Caps and hard seams stay separate. */
export function applySmoothEdgeNormals(
  mesh: MeshData,
  world: Float64Array,
  normals: Float32Array,
  edges: readonly RenderBodyEdge[],
): void {
  const inv = 1 / LENGTH_TOL;
  const pointKey = (x: number, y: number, z: number) =>
    `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
  const joined = new Map<string, Map<number, number>>();
  const find = (parents: Map<number, number>, face: number): number => {
    let root = face;
    while (parents.get(root) !== root) root = parents.get(root)!;
    while (parents.get(face) !== root) {
      const next = parents.get(face)!;
      parents.set(face, root);
      face = next;
    }
    return root;
  };
  for (const edge of edges) {
    if (!edge.smooth || edge.faceA < 0 || edge.faceB < 0 || edge.faceA === edge.faceB) continue;
    for (const point of edge.points) {
      const key = pointKey(...point);
      let parents = joined.get(key);
      if (!parents) joined.set(key, (parents = new Map()));
      for (const face of [edge.faceA, edge.faceB]) if (!parents.has(face)) parents.set(face, face);
      const a = find(parents, edge.faceA),
        b = find(parents, edge.faceB);
      if (a !== b) parents.set(a, b);
    }
  }
  if (!joined.size) return;
  // Index local vertices once. Join identity does not depend on placement, scale or floating origin.
  const keys = new Array<string | null | undefined>(mesh.verts.length / 3);
  const groupOf = (vertex: number, face: number): string | undefined => {
    let key = keys[vertex];
    if (key === undefined) {
      const candidate = pointKey(
        mesh.verts[vertex * 3]!,
        mesh.verts[vertex * 3 + 1]!,
        mesh.verts[vertex * 3 + 2]!,
      );
      key = joined.has(candidate) ? candidate : null;
      keys[vertex] = key;
    }
    if (key === null) return undefined;
    const parents = joined.get(key)!;
    return parents.has(face) ? `${key}|${find(parents, face)}` : undefined;
  };
  const sums = new Map<string, [number, number, number]>();
  for (let t = 0; t < mesh.tris.length / 3; t++) {
    const indices = [mesh.tris[t * 3]!, mesh.tris[t * 3 + 1]!, mesh.tris[t * 3 + 2]!];
    const face = mesh.faceId[t]!;
    for (let corner = 0; corner < 3; corner++) {
      const vertex = indices[corner]!;
      const group = groupOf(vertex, face);
      if (group === undefined) continue;
      const a = vertex * 3,
        b = indices[(corner + 1) % 3]! * 3,
        c = indices[(corner + 2) % 3]! * 3;
      const weight = cornerAngle(
        world[a]!,
        world[a + 1]!,
        world[a + 2]!,
        world[b]!,
        world[b + 1]!,
        world[b + 2]!,
        world[c]!,
        world[c + 1]!,
        world[c + 2]!,
      );
      const offset = t * 9 + corner * 3;
      let sum = sums.get(group);
      if (!sum) sums.set(group, (sum = [0, 0, 0]));
      for (let axis = 0; axis < 3; axis++)
        sum[axis] = sum[axis]! + normals[offset + axis]! * weight;
    }
  }
  for (let corner = 0; corner < mesh.tris.length; corner++) {
    const group = groupOf(mesh.tris[corner]!, mesh.faceId[Math.floor(corner / 3)]!);
    if (group === undefined) continue;
    const sum = sums.get(group)!;
    const length = Math.hypot(...sum);
    if (length === 0) continue;
    for (let axis = 0; axis < 3; axis++) normals[corner * 3 + axis] = sum[axis]! / length;
  }
}
