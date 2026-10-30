// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, MVec3, Vec3 } from '@pushform/core';
import { basisToLocal, formatAngleDeg, formatLength, v3addScaled, v3dot, v3sub } from '@pushform/core';
import type { Axis, PickHit } from '@pushform/inference';
import { computeRegions, containerAt, regionAt } from '@pushform/model';
import type { DocumentState, EntityContainer, EntityRef } from '@pushform/model';
import { contextFrame, currentContainer, samePath } from '../../commands/context';
import type { FaceTarget } from '../../commands/offset';
import type { DocumentHost } from '../../host/DocumentHost';
import type { ToolContext } from '../Tool';
import { hostOfTool } from '../toolUtil';

/**
 * Shared lookups for the construction tools (Tape, Protractor, Axes, Offset, Follow Me, Solid
 * Tools). Entities live in the container of their ref's `path`; positions returned to tools are
 * world space.
 */

export const AXIS_NORMAL: Record<Axis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
export const AXIS_COLORS: Record<Axis, string> = { x: '#d32f2f', y: '#2e7d32', z: '#1565c0' };
export const GUIDE_COLOR = '#8e24aa';
export const PATH_COLOR = '#e53935';

export function stateOf(ctx: ToolContext): DocumentState {
  return hostOfTool(ctx).doc.state;
}

/** Container of the current edit context. */
export function rootOf(ctx: ToolContext): EntityContainer {
  return currentContainer(hostOfTool(ctx));
}

function containerOfRef(state: DocumentState, ref: EntityRef): EntityContainer | null {
  try {
    return containerAt(state, ref.path);
  } catch {
    return null;
  }
}

export function fmtLength(ctx: ToolContext | null, meters: number): string {
  if (!ctx) return meters.toFixed(3);
  return formatLength(meters, hostOfTool(ctx).doc.state.meta.units);
}

export function fmtAngle(deg: number): string {
  return formatAngleDeg(deg, 1);
}

/** Straight world segment of a sketch edge or body edge (any context), or null. */
export function edgeSegment(state: DocumentState, ref: EntityRef): { a: Vec3; b: Vec3 } | null {
  const root = containerOfRef(state, ref);
  if (!root) return null;
  const frame = contextFrame(state, ref.path);
  if (ref.kind === 'sketchEdge') {
    const e = root.sketch.edges.get(ref.id);
    const a = e && root.sketch.vertices.get(e.a), b = e && root.sketch.vertices.get(e.b);
    return a && b ? { a: frame.toWorld(a.p), b: frame.toWorld(b.p) } : null;
  }
  if (ref.kind === 'edge') {
    const e = root.bodies.get(ref.id)?.edges.get(ref.edgeKey);
    const a = e?.polyline[0], b = e?.polyline[e.polyline.length - 1];
    return a && b ? { a: frame.toWorld(a), b: frame.toWorld(b) } : null;
  }
  return null;
}

/** Face target under a pick hit (sketch face, or body face narrowed to the region at the world hit point). */
export function faceTargetOfHit(state: DocumentState, hit: PickHit | null): FaceTarget | null {
  if (!hit) return null;
  const ref = hit.ref;
  const root = containerOfRef(state, ref);
  if (!root) return null;
  const path = [...ref.path] as number[];
  if (ref.kind === 'sketchFace') return root.sketch.faces.has(ref.id) ? { kind: 'sketchFace', path, id: ref.id } : null;
  if (ref.kind !== 'face') return null;
  const body = root.bodies.get(ref.id);
  const face = body?.faces.get(ref.faceId);
  if (!body || !face) return null;
  let index = ref.region ?? -1;
  if (index < 0) {
    const regions = computeRegions(body, ref.faceId);
    if (regions.length > 1) {
      const l = basisToLocal(face.basis, contextFrame(state, ref.path).toLocal(hit.point));
      index = regionAt(regions, [l[0], l[1]]);
    }
  }
  return { kind: 'face', path, id: ref.id, faceId: ref.faceId, region: index < 0 ? 0 : index };
}

export const faceTargetKey = (t: FaceTarget): string => (t.kind === 'sketchFace' ? `sketchFace/${t.id}` : `face/${t.id}/${t.faceId}/${t.region ?? 0}`);

/** Body id behind a body / face / edge / imprint-edge ref in the context `path` (root by default), or null. */
export function bodyIdOfRef(ref: EntityRef | null | undefined, path: readonly number[] = []): Id | null {
  if (!ref || !samePath(ref.path, path)) return null;
  switch (ref.kind) {
    case 'body':
    case 'face':
    case 'edge':
    case 'imprintEdge':
      return ref.id;
    default:
      return null;
  }
}

/** Selected sketch edges of the current context. */
export function selectionSketchEdgeIds(host: DocumentHost): Id[] {
  const path = host.context.path;
  const sketch = currentContainer(host).sketch;
  return host.selection.refs.filter((r) => r.kind === 'sketchEdge' && samePath(r.path, path) && sketch.edges.has(r.id)).map((r) => r.id);
}

/** Selected bodies (through body / face / edge refs) of the current context. */
export function selectionBodyIds(host: DocumentHost): Id[] {
  const path = host.context.path;
  const bodies = currentContainer(host).bodies;
  const out: Id[] = [];
  for (const r of host.selection.refs) {
    const id = bodyIdOfRef(r, path);
    if (id !== null && bodies.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Closest point to `p` on the line through `a` with unit direction `dir`. */
export function closestOnLine(p: Vec3, a: Vec3, dir: Vec3): MVec3 {
  return v3addScaled(a, dir, v3dot(v3sub(p, a), dir));
}

/** Component of `v` perpendicular to unit `n`. */
export function projectToPlane(v: Vec3, n: Vec3): MVec3 {
  return v3addScaled(v, n, -v3dot(v, n));
}
