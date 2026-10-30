// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { basisToWorld, box3Empty, box3Expand, box3IsEmpty, m4invert, m4transformPoint, meshBounds, planeBasis, v3normalize } from '@pushform/core';
import type { Box3, Id, Mat4, MMat4, Vec3 } from '@pushform/core';
import { contextMatrix, definitionAt, walkInstances } from './context';
import { imageEntityCorners } from './imageEntities';
import type { ComponentDefinition, DocumentState, EntityContainer, SectionPlane } from './entities';

/**
 * Which side of a section plane its cut keeps: the stored normal points toward the part of the model that
 * stays; the section plane arrows point toward the kept side.
 */
export const KEEP_ALONG_NORMAL = 1;
/** Margin around the content a section plane's rectangle frames, as a fraction of its larger side. */
export const SECTION_PLANE_MARGIN = 0.25;
/** Side of the rectangle of a section plane whose container has no content, in meters. */
export const EMPTY_SECTION_SIZE = 1;

function expandContainer(b: { min: [number, number, number]; max: [number, number, number] }, container: EntityContainer, matrix: Mat4 | MMat4): void {
  for (const body of container.bodies.values()) {
    const local = meshBounds(body.mesh);
    if (box3IsEmpty(local)) continue;
    for (let i = 0; i < 8; i++) {
      box3Expand(b, m4transformPoint(matrix, [i & 1 ? local.max[0] : local.min[0], i & 2 ? local.max[1] : local.min[1], i & 4 ? local.max[2] : local.min[2]]));
    }
  }
  for (const v of container.sketch.vertices.values()) box3Expand(b, m4transformPoint(matrix, v.p));
  for (const image of container.images.values()) for (const p of imageEntityCorners(image)) box3Expand(b, m4transformPoint(matrix, p));
}

/**
 * World-space bounds of what the container at `path` holds (its bodies and sketch, and those of the groups and
 * components inside it), or null when it is empty or the path is stale.
 */
export function contentWorldBounds(state: DocumentState, path: readonly Id[]): Box3 | null {
  let def: ComponentDefinition;
  let matrix: MMat4;
  try {
    def = definitionAt(state, path);
    matrix = contextMatrix(state, path);
  } catch {
    return null;
  }
  const b = box3Empty();
  expandContainer(b, def.entities, matrix);
  for (const v of walkInstances(state, path)) expandContainer(b, v.definition.entities, v.matrix);
  return box3IsEmpty(b) ? null : b;
}

/** A section plane's plane in world coordinates under `matrix`: unit normal toward the kept side, and `d`. */
export function worldSectionPlane(plane: SectionPlane['plane'], matrix: Mat4 | MMat4): { normal: Vec3; d: number } {
  const n = plane.n;
  const point = m4transformPoint(matrix, [-n[0] * plane.d, -n[1] * plane.d, -n[2] * plane.d]);
  // Normals transform by the inverse transpose.
  const inv = m4invert(matrix);
  const nw = inv ? v3normalize([inv[0]! * n[0] + inv[1]! * n[1] + inv[2]! * n[2], inv[4]! * n[0] + inv[5]! * n[1] + inv[6]! * n[2], inv[8]! * n[0] + inv[9]! * n[1] + inv[10]! * n[2]]) : n;
  const normal: Vec3 = [nw[0] * KEEP_ALONG_NORMAL, nw[1] * KEEP_ALONG_NORMAL, nw[2] * KEEP_ALONG_NORMAL];
  return { normal, d: -(normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2]) };
}

/** The rectangle a section plane draws: the container's content projected onto the plane, with a margin. */
export function sectionPlaneCorners(normal: Vec3, d: number, bounds: Box3 | null): [Vec3, Vec3, Vec3, Vec3] {
  const center: Vec3 = bounds ? [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2] : [0, 0, 0];
  const off = normal[0] * center[0] + normal[1] * center[1] + normal[2] * center[2] + d;
  const basis = planeBasis([center[0] - normal[0] * off, center[1] - normal[1] * off, center[2] - normal[2] * off], normal);
  let u0 = -EMPTY_SECTION_SIZE / 2, u1 = EMPTY_SECTION_SIZE / 2, v0 = u0, v1 = u1;
  if (bounds) {
    u0 = v0 = Infinity; u1 = v1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p: Vec3 = [i & 1 ? bounds.max[0] : bounds.min[0], i & 2 ? bounds.max[1] : bounds.min[1], i & 4 ? bounds.max[2] : bounds.min[2]];
      const r: Vec3 = [p[0] - basis.origin[0], p[1] - basis.origin[1], p[2] - basis.origin[2]];
      const u = r[0] * basis.u[0] + r[1] * basis.u[1] + r[2] * basis.u[2], v = r[0] * basis.v[0] + r[1] * basis.v[1] + r[2] * basis.v[2];
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const m = Math.max(u1 - u0, v1 - v0, EMPTY_SECTION_SIZE / 10) * SECTION_PLANE_MARGIN;
    u0 -= m; u1 += m; v0 -= m; v1 += m;
  }
  return [basisToWorld(basis, u0, v0), basisToWorld(basis, u1, v0), basisToWorld(basis, u1, v1), basisToWorld(basis, u0, v1)];
}

/** The world plane and rectangle of section plane `sp` held by the container at `path` placed at `matrix`. */
export function sectionPlaneInWorld(state: DocumentState, path: readonly Id[], sp: SectionPlane, matrix: Mat4 | MMat4): { normal: Vec3; d: number; corners: [Vec3, Vec3, Vec3, Vec3] } {
  const { normal, d } = worldSectionPlane(sp.plane, matrix);
  return { normal, d, corners: sectionPlaneCorners(normal, d, contentWorldBounds(state, path)) };
}
