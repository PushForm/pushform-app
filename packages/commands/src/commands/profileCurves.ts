// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { COPLANAR_TOL, MERGE_TOL, PushFormError, v3add, v3dist, v3dot, v3scale, v3sub, type CurveId, type FaceLocalId, type SurfaceId, type Vec3 } from '@pushform/core';
import { allocId, type Body, type DocumentDraft, type EdgeKey } from '@pushform/model';

/** Preserve authored curved rims, including exact closed edge groups for an affine-deformed circle. */
export function attachProfileCurves(draft: DocumentDraft, body: Body, profile: { points: Vec3[]; normal: Vec3; offset: Vec3 }): void {
  const edges = [...body.edges.values()];
  const rings = [profile.points, profile.points.map(point => v3add(point, profile.offset))];
  let first: CurveId | null = null;
  const candidates = new Set<FaceLocalId>();
  for (const ring of rings) {
    const refs: EdgeKey[] = [];
    for (const [index, a] of ring.entries()) {
      const b = ring[(index + 1) % ring.length]!;
      const edge = edges.find(edge => {
        const start = edge.polyline[0]!, end = edge.polyline.at(-1)!;
        return v3dist(start, a) <= MERGE_TOL && v3dist(end, b) <= MERGE_TOL || v3dist(start, b) <= MERGE_TOL && v3dist(end, a) <= MERGE_TOL;
      });
      if (!edge || refs.includes(edge.key)) throw new PushFormError('kernel.invalidMesh', 'The curved rim cannot be linked to the resulting solid.');
      refs.push(edge.key); candidates.add(edge.faceA); candidates.add(edge.faceB);
    }
    const center = v3scale(ring.reduce((sum, point) => v3add(sum, point), [0,0,0] as Vec3), 1 / ring.length);
    const radius = v3dist(center, ring[0]!), circular = ring.every(point => Math.abs(v3dist(center, point) - radius) <= COPLANAR_TOL);
    const id = allocId<CurveId>(draft);
    body.curves.set(id, { id, kind: circular ? 'circle' : 'freehand', center, normal: [...profile.normal], radius: circular ? radius : 0,
      startAngle: 0, endAngle: 2 * Math.PI, segments: ring.length, edgeRefs: refs });
    for (const key of refs) body.edges.get(key)!.curveId = id;
    first ??= id;
  }
  const onPlane = (points: readonly Vec3[], anchor: Vec3) => points.every(point => Math.abs(v3dot(v3sub(point, anchor), profile.normal)) <= COPLANAR_TOL);
  const faceIds = [...body.faces.values()].filter(face => candidates.has(face.id) && !onPlane(face.loops.flat(), rings[0]![0]!) && !onPlane(face.loops.flat(), rings[1]![0]!)).map(face => face.id);
  if (faceIds.length) { const id = allocId<SurfaceId>(draft); body.surfaces.set(id, { id, faceIds, curveId: first }); }
}
