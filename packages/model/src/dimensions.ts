// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { formatLength, m4identity, m4mul, m4transformDir, m4transformPoint, MERGE_TOL, v3add, v3dist, v3len, v3normalize, v3scale, v3sub } from '@pushform/core';
import type { FaceLocalId, Id, MMat4, Mat4, UnitSettings, Vec3 } from '@pushform/core';
import type { Body, Curve } from './entities/body';
import type { EntityContainer } from './entities/definition';
import type { DocumentState } from './entities/document';
import type { Dimension, DimensionAnchor, DimensionCurveAnchor, DimensionStyle } from './entities/misc';

/** Where a dimension's measured points are now, in its container's coordinates. */
export interface ResolvedDimension {
  readonly start: Vec3;
  readonly end: Vec3;
  readonly normal: Vec3;
  /** The measured value in meters: length, radius or diameter. */
  readonly value: number;
  /** Radial and diameter dimensions: the arc's center. */
  readonly center: Vec3 | null;
}

/** Container and accumulated matrix reached by walking `path` (instance ids) down from `from`; null when a step is gone. */
function descend(state: DocumentState, from: EntityContainer, path: readonly Id[]): { container: EntityContainer; matrix: MMat4 } | null {
  let container = from;
  let matrix: MMat4 = m4identity();
  for (const id of path) {
    const inst = container.instances.get(id);
    const def = inst && state.definitions.get(inst.definitionId);
    if (!inst || !def) return null;
    matrix = m4mul(matrix, inst.transform as Mat4);
    container = def.entities;
  }
  return { container, matrix };
}

/** Face ids of a body whose boundary passes through `point` (within the merge tolerance): the vertex's identity. */
export function bodyVertexFaces(body: Body, point: Vec3): FaceLocalId[] {
  const out: FaceLocalId[] = [];
  for (const face of body.faces.values()) {
    if (face.loops.some((loop) => loop.some((p) => v3dist(p, point) <= MERGE_TOL))) out.push(face.id);
  }
  return out.sort((a, b) => a - b);
}

/** The one boundary point all of `faceIds` share, or null when they share none or several. */
export function bodyVertexAt(body: Body, faceIds: readonly FaceLocalId[]): Vec3 | null {
  const faces = faceIds.map((id) => body.faces.get(id));
  if (faces.length === 0 || faces.some((f) => !f)) return null;
  const [first, ...rest] = faces as NonNullable<(typeof faces)[number]>[];
  let found: Vec3 | null = null;
  for (const loop of first!.loops) {
    for (const p of loop) {
      if (!rest.every((f) => f.loops.some((l) => l.some((q) => v3dist(p, q) <= MERGE_TOL)))) continue;
      if (found && v3dist(found, p) > MERGE_TOL) return null;
      found = p;
    }
  }
  return found;
}

/** An anchored point in the dimension container's coordinates, or null when what it names no longer exists. */
export function resolveDimensionAnchor(state: DocumentState, container: EntityContainer, anchor: DimensionAnchor): Vec3 | null {
  const at = descend(state, container, anchor.path);
  if (!at) return null;
  let local: Vec3 | null = null;
  if (anchor.kind === 'sketchVertex') local = at.container.sketch.vertices.get(anchor.id)?.p ?? null;
  else {
    const body = at.container.bodies.get(anchor.bodyId);
    local = body ? bodyVertexAt(body, anchor.faceIds) : null;
  }
  return local && m4transformPoint(at.matrix, local);
}

/** An anchored arc or circle in the dimension container's coordinates, or null when it no longer exists. */
export function resolveDimensionCurve(state: DocumentState, container: EntityContainer, anchor: DimensionCurveAnchor): { center: Vec3; normal: Vec3; radius: number } | null {
  const at = descend(state, container, anchor.path);
  if (!at) return null;
  const curves: ReadonlyMap<number, Curve> | undefined = anchor.bodyId === null ? at.container.sketch.curves : at.container.bodies.get(anchor.bodyId)?.curves;
  const curve = curves?.get(anchor.curveId);
  if (!curve || (curve.kind !== 'arc' && curve.kind !== 'circle')) return null;
  const axis = m4transformDir(at.matrix, [curve.radius, 0, 0]);
  return { center: m4transformPoint(at.matrix, curve.center), normal: v3normalize(m4transformDir(at.matrix, curve.normal)), radius: v3len(axis) };
}

/**
 * A dimension's measured points as its attachments place them now; an end whose attachment is gone keeps its
 * stored point. A radial or diameter dimension keeps the direction from the center to its stored point on the arc.
 */
export function resolveDimension(state: DocumentState, container: EntityContainer, dim: Dimension): ResolvedDimension {
  if (dim.kind !== 'linear') {
    const curve = dim.curve ? resolveDimensionCurve(state, container, dim.curve) : null;
    const center = curve?.center ?? (dim.kind === 'radial' ? dim.start : v3scale(v3add(dim.start, dim.end), 0.5));
    const stored = dim.kind === 'radial' ? dim.end : dim.start;
    const toward = v3sub(stored, dim.kind === 'radial' ? dim.start : v3scale(v3add(dim.start, dim.end), 0.5));
    const dir = v3len(toward) > MERGE_TOL ? v3normalize(toward) : ([1, 0, 0] as Vec3);
    const radius = curve?.radius ?? v3len(toward);
    const onArc = v3add(center, v3scale(dir, radius));
    return dim.kind === 'radial'
      ? { start: center, end: onArc, normal: curve?.normal ?? dim.normal, value: radius, center }
      : { start: onArc, end: v3sub(center, v3scale(dir, radius)), normal: curve?.normal ?? dim.normal, value: 2 * radius, center };
  }
  const [a, b] = dim.anchors ?? [null, null];
  const start = (a && resolveDimensionAnchor(state, container, a)) ?? dim.start;
  const end = (b && resolveDimensionAnchor(state, container, b)) ?? dim.end;
  return { start, end, normal: dim.normal, value: v3dist(start, end), center: null };
}

/** What a dimension draws, in its container's coordinates. */
export interface DimensionDrawing {
  readonly lines: ReadonlyArray<readonly [Vec3, Vec3]>;
  /** Arrowhead tips with the unit direction back along their line. */
  readonly arrows: ReadonlyArray<{ readonly tip: Vec3; readonly back: Vec3 }>;
  readonly textAt: Vec3;
}

/**
 * Linear: extension lines from the measured points to the dimension line, which is the measured segment moved by the
 * offset, with arrowheads at both ends and the text at its middle. Radial: the radius from the center to the arc with an
 * arrowhead on the arc, and a leader continuing by the offset to the text. Diameter: the diameter with arrowheads at
 * both ends, and a leader from its start by the offset to the text.
 */
export function dimensionDrawing(dim: Dimension, at: ResolvedDimension): DimensionDrawing {
  const dir = (from: Vec3, to: Vec3): Vec3 => (v3dist(from, to) > MERGE_TOL ? v3normalize(v3sub(to, from)) : [1, 0, 0]);
  const hasOffset = v3len(dim.offset) > MERGE_TOL;
  const { start: a, end: b } = at;
  if (dim.kind === 'linear') {
    const a2 = v3add(a, dim.offset), b2 = v3add(b, dim.offset);
    return {
      lines: [...(hasOffset ? [[a, a2] as const, [b, b2] as const] : []), [a2, b2]],
      arrows: [{ tip: a2, back: dir(a2, b2) }, { tip: b2, back: dir(b2, a2) }],
      textAt: v3scale(v3add(a2, b2), 0.5),
    };
  }
  const leaderFrom = dim.kind === 'radial' ? b : a, leaderTo = v3add(leaderFrom, dim.offset);
  const lines: (readonly [Vec3, Vec3])[] = [[a, b], ...(hasOffset ? [[leaderFrom, leaderTo] as const] : [])];
  const arrows = dim.kind === 'radial' ? [{ tip: b, back: dir(b, a) }] : [{ tip: a, back: dir(a, b) }, { tip: b, back: dir(b, a) }];
  return { lines, arrows, textAt: hasOffset ? leaderTo : v3scale(v3add(a, b), 0.5) };
}

/**
 * The text a dimension shows: its measured value in the model's units, with "R" before a radius and "DIA"
 * before a diameter, or its custom text with `<>` replaced by that value.
 */
export function dimensionText(dim: Dimension, value: number, units: UnitSettings): string {
  const measured = `${dim.kind === 'radial' ? 'R ' : dim.kind === 'diametric' ? 'DIA ' : ''}${formatLength(value, units)}`;
  return dim.text === null || dim.text === '' ? measured : dim.text.replaceAll('<>', measured);
}

/** Defaults for new dimensions: 10 pt text facing the screen, closed arrows. */
export const DEFAULT_DIMENSION_STYLE: DimensionStyle = { fontSizePt: 10, arrow: 'closed', align: 'screen' };

/** The model's settings for new dimensions (Model Info › Dimensions). */
export function dimensionStyleOf(state: Pick<DocumentState, 'meta'>): DimensionStyle {
  return { ...DEFAULT_DIMENSION_STYLE, ...state.meta.dimensions };
}

/**
 * A radial dimension as a diameter, or the reverse: the same arc or circle, measured through the stored point
 * on it, with the leader and attachment kept. `at` is where the dimension is now (`resolveDimension`).
 */
export function switchDimensionType(dim: Dimension, at: ResolvedDimension, to: 'radial' | 'diametric'): Pick<Dimension, 'kind' | 'start' | 'end'> {
  if (dim.kind === 'linear' || dim.kind === to || !at.center) return { kind: dim.kind, start: dim.start, end: dim.end };
  // Radial: center to the point on the arc. Diameter: that point to the opposite one.
  const onArc = dim.kind === 'radial' ? at.end : at.start;
  return to === 'radial'
    ? { kind: 'radial', start: at.center, end: onArc }
    : { kind: 'diametric', start: onArc, end: v3sub(v3scale(at.center, 2), onArc) };
}
