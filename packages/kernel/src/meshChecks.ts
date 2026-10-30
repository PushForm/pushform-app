// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Pure topology checks for closed triangle meshes, shared by tests and the io package. */
import type { MeshData } from '@pushform/core';
import { meshSignedVolume } from '@pushform/core';

/** Vertex count after welding exactly coincident positions. */
export function meshWeldedVertexCount(mesh: MeshData): number {
  const seen = new Set<string>();
  for (let i = 0; i < mesh.verts.length; i += 3) seen.add(`${mesh.verts[i]},${mesh.verts[i + 1]},${mesh.verts[i + 2]}`);
  return seen.size;
}

/** V - E + F over the triangle mesh; 2 for a sphere-like solid, 0 for a torus (genus 1). */
export function meshEulerCharacteristic(mesh: MeshData): number {
  const edges = new Set<string>();
  const t = mesh.tris;
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = t[i + k]!, b = t[i + ((k + 1) % 3)]!;
      edges.add(a < b ? `${a}:${b}` : `${b}:${a}`);
    }
  }
  return mesh.verts.length / 3 - edges.size + t.length / 3;
}

/**
 * Returns a list of problems (empty when the mesh is a closed, consistently oriented solid):
 * indices in range, no degenerate triangles, every directed edge used exactly once and matched by
 * its reverse, positive signed volume.
 */
export function meshTopologyProblems(mesh: MeshData): string[] {
  const problems: string[] = [];
  const n = mesh.verts.length / 3, t = mesh.tris;
  if (t.length === 0) problems.push('mesh has no triangles');
  if (t.length % 3 !== 0) problems.push('tris length is not a multiple of 3');
  if (mesh.faceId.length !== t.length / 3) problems.push('faceId length does not match triangle count');
  const directed = new Map<string, number>();
  for (let i = 0; i + 2 < t.length; i += 3) {
    const a = t[i]!, b = t[i + 1]!, c = t[i + 2]!;
    if (a >= n || b >= n || c >= n) problems.push(`triangle ${i / 3} references a vertex out of range`);
    if (a === b || b === c || a === c) problems.push(`triangle ${i / 3} is degenerate`);
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const key = `${p}>${q}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of directed) {
    const [p, q] = key.split('>');
    if (count !== 1) problems.push(`edge ${key} used ${count} times in the same direction`);
    if (!directed.has(`${q}>${p}`)) problems.push(`edge ${key} has no opposite-direction twin`);
  }
  if (problems.length === 0 && meshSignedVolume(mesh) <= 0) problems.push('signed volume is not positive');
  return problems.slice(0, 20);
}
