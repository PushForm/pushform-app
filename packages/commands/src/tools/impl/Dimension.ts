// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, Vec2, Vec3 } from '@pushform/core';
import { MERGE_TOL, m4invert, m4transformDir, m4transformPoint, v3add, v3cross, v3dist, v3dot, v3len, v3normalize, v3scale, v3sub } from '@pushform/core';
import type { InferenceOptions, InferenceResult } from '@pushform/inference';
import { bodyVertexFaces, containerAt, contextMatrix, dimensionDrawing, type Curve, type DimensionAnchor, type DimensionCurveAnchor, type DocumentState, type EntityRef } from '@pushform/model';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolPointerEvent, ToolStatus } from '../Tool';
import { hostOfTool, inferenceOverlay, PREVIEW_COLOR } from '../toolUtil';
import { closestOnLine, edgeSegment, fmtLength, stateOf } from './constructionUtil';

/** A measured point and what it is attached to. */
interface Picked {
  readonly p: Vec3;
  readonly anchor: DimensionAnchor | null;
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'second'; readonly a: Picked }
  | { readonly kind: 'offset'; readonly a: Picked; readonly b: Picked }
  | {
      readonly kind: 'leader';
      readonly type: 'radial' | 'diametric';
      readonly center: Vec3;
      readonly normal: Vec3;
      readonly radius: number;
      readonly curve: DimensionCurveAnchor | null;
    };

const IDLE: State = { kind: 'idle' };

/** A unit vector perpendicular to `v`. */
function perpendicular(v: Vec3): Vec3 {
  const t: Vec3 = Math.abs(v[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return v3normalize(v3cross(v, t));
}

/**
 * Dimension tool: click two points, or an edge, then move the dimension line off the measured segment and
 * click to place it. Clicking an arc places a radius dimension, a circle a diameter dimension; move the text out along
 * its leader and click. Points picked at vertices stay attached to them.
 */
export class DimensionTool implements Tool {
  readonly id = 'dimension';
  readonly title = 'Dimension';
  readonly cursor = 'crosshair';

  private ctx: ToolContext | null = null;
  private state: State = IDLE;
  private cursorInference: InferenceResult | null = null;
  private cursorScreen: Vec2 | null = null;

  hasPendingWork(): boolean {
    return this.state.kind !== 'idle';
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.state = IDLE;
  }

  deactivate(): void {
    this.state = IDLE;
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    return { anchor: this.state.kind === 'second' ? this.state.a.p : undefined };
  }

  onPointerMove(e: ToolPointerEvent): void {
    this.cursorInference = e.inference;
    this.cursorScreen = e.screen;
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  onClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || !e.inference || !this.ctx) return;
    this.cursorInference = e.inference;
    const inf = e.inference;
    const s = this.state;
    if (s.kind === 'idle') {
      this.state = this.startFrom(inf);
    } else if (s.kind === 'second') {
      const b = this.picked(inf);
      if (v3dist(s.a.p, b.p) > MERGE_TOL) this.state = { kind: 'offset', a: s.a, b };
    } else if (s.kind === 'offset') {
      const offset = this.lineOffset(s.a.p, s.b.p, inf.point);
      const along = v3normalize(v3sub(s.b.p, s.a.p));
      const normal = v3len(offset) > MERGE_TOL ? v3normalize(v3cross(along, offset)) : perpendicular(along);
      this.ctx.commands.execute('dimension.add', {
        kind: 'linear', start: [...s.a.p], end: [...s.b.p], offset: [...offset], normal: [...normal], anchors: [s.a.anchor, s.b.anchor],
      });
      this.state = IDLE;
    } else {
      const { start, end, leaderFrom } = this.arcPoints(s, inf.point);
      this.ctx.commands.execute('dimension.add', {
        kind: s.type, start: [...start], end: [...end], offset: [...v3sub(this.onPlane(s, inf.point), leaderFrom)], normal: [...s.normal],
        ...(s.curve ? { curve: { path: [...s.curve.path], bodyId: s.curve.bodyId, curveId: s.curve.curveId } } : {}),
      });
      this.state = IDLE;
    }
    this.ctx.statusChanged();
    this.ctx.requestRender();
  }

  onCancel(): void {
    this.state = IDLE;
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    const inf = this.cursorInference;
    const out: OverlayPrimitive[] = [];
    const s = this.state;
    if (inf && s.kind === 'second') {
      out.push({ kind: 'polyline', points: [s.a.p, inf.point], color: PREVIEW_COLOR, dashed: true, width: 1 });
      out.push({ kind: 'label', position: inf.point, text: fmtLength(this.ctx, v3dist(s.a.p, inf.point)), offset: [12, -12] });
    } else if (inf && s.kind === 'offset') {
      const offset = this.lineOffset(s.a.p, s.b.p, inf.point);
      out.push(...this.previewLines({ kind: 'linear', start: s.a.p, end: s.b.p, offset }));
      out.push({ kind: 'label', position: v3add(v3scale(v3add(s.a.p, s.b.p), 0.5), offset), text: fmtLength(this.ctx, v3dist(s.a.p, s.b.p)), offset: [8, 8] });
    } else if (inf && s.kind === 'leader') {
      const { start, end, leaderFrom } = this.arcPoints(s, inf.point);
      const offset = v3sub(this.onPlane(s, inf.point), leaderFrom);
      out.push(...this.previewLines({ kind: s.type, start, end, offset }));
      const prefix = s.type === 'radial' ? 'R ' : 'DIA ';
      out.push({ kind: 'label', position: v3add(leaderFrom, offset), text: prefix + fmtLength(this.ctx, s.type === 'radial' ? s.radius : 2 * s.radius), offset: [8, 8] });
    }
    if (s.kind !== 'idle' && s.kind !== 'leader') out.push({ kind: 'point', position: s.a.p, color: PREVIEW_COLOR, shape: 'square', size: 6 });
    out.push(...inferenceOverlay(inf, this.cursorScreen ?? undefined));
    return out;
  }

  status(): ToolStatus {
    const s = this.state;
    switch (s.kind) {
      case 'idle':
        return { instructor: 'Select the first point to dimension, or an edge, arc or circle.', vcbLabel: '' };
      case 'second':
        return { instructor: 'Select the second point to dimension.', vcbLabel: '' };
      case 'offset':
        return { instructor: 'Move the dimension line away from the measured points and click to place it.', vcbLabel: '' };
      default:
        return { instructor: `Move the ${s.type === 'radial' ? 'radius' : 'diameter'} text out along its leader and click to place it.`, vcbLabel: '' };
    }
  }

  // --- internals ------------------------------------------------------------------------------

  /** Start on an arc or circle (radius or diameter), on a straight edge (its two ends), or at a point. */
  private startFrom(inf: InferenceResult): State {
    const ctx = this.ctx!;
    const ref = inf.hit?.ref ?? null;
    const atPoint = inf.primary.kind === 'endpoint' || inf.primary.kind === 'midpoint' || inf.primary.kind === 'center';
    if (ref && !atPoint && (ref.kind === 'edge' || ref.kind === 'sketchEdge')) {
      const state = stateOf(ctx);
      const curve = this.curveOf(state, ref);
      if (curve) return curve;
      const seg = edgeSegment(state, ref);
      if (seg && v3dist(seg.a, seg.b) > MERGE_TOL) {
        const pick = (p: Vec3): Picked => ({ p, anchor: this.anchorAt(state, ref, p) });
        return { kind: 'offset', a: pick(seg.a), b: pick(seg.b) };
      }
    }
    return { kind: 'second', a: this.picked(inf) };
  }

  private picked(inf: InferenceResult): Picked {
    const ref = inf.primary.kind === 'endpoint' ? (inf.primary.ref ?? null) : null;
    return { p: inf.point, anchor: ref ? this.anchorAt(stateOf(this.ctx!), ref, inf.point) : null };
  }

  /** The instance path from the edit context to `ref`'s container, or null when `ref` lies outside the edit context. */
  private relativePath(ref: EntityRef): readonly Id[] | null {
    const context = hostOfTool(this.ctx!).context.path;
    if (ref.path.length < context.length || context.some((id, i) => ref.path[i] !== id)) return null;
    return ref.path.slice(context.length);
  }

  /** A sketch vertex by id, or a body corner by the faces meeting there; null for any other point. */
  private anchorAt(state: DocumentState, ref: EntityRef, world: Vec3): DimensionAnchor | null {
    const path = this.relativePath(ref);
    if (!path) return null;
    const inverse = m4invert(contextMatrix(state, ref.path));
    if (!inverse) return null;
    const local = m4transformPoint(inverse, world);
    const container = containerAt(state, ref.path);
    if (ref.kind === 'sketchVertex') return { kind: 'sketchVertex', path, id: ref.id };
    if (ref.kind === 'sketchEdge') {
      const edge = container.sketch.edges.get(ref.id);
      for (const vertexId of edge ? [edge.a, edge.b] : []) {
        const v = container.sketch.vertices.get(vertexId);
        if (v && v3dist(v.p, local) <= MERGE_TOL) return { kind: 'sketchVertex', path, id: vertexId };
      }
      return null;
    }
    if (ref.kind === 'edge') {
      const body = container.bodies.get(ref.id);
      const faceIds = body ? bodyVertexFaces(body, local) : [];
      return body && faceIds.length >= 2 ? { kind: 'bodyVertex', path, bodyId: ref.id, faceIds } : null;
    }
    return null;
  }

  /** A radius (arc) or diameter (circle) dimension starting on the curve of an edge, or null for a straight edge. */
  private curveOf(state: DocumentState, ref: EntityRef): State | null {
    const container = containerAt(state, ref.path);
    let curve: Curve | undefined;
    let bodyId: Id | null = null;
    if (ref.kind === 'sketchEdge') {
      const curveId = container.sketch.edges.get(ref.id)?.curveId;
      curve = curveId === null || curveId === undefined ? undefined : container.sketch.curves.get(curveId);
    } else if (ref.kind === 'edge') {
      const body = container.bodies.get(ref.id);
      const curveId = body?.edges.get(ref.edgeKey)?.curveId;
      curve = curveId === null || curveId === undefined ? undefined : body!.curves.get(curveId);
      bodyId = ref.id;
    }
    if (!curve || (curve.kind !== 'arc' && curve.kind !== 'circle')) return null;
    const m = contextMatrix(state, ref.path);
    const path = this.relativePath(ref);
    return {
      kind: 'leader', type: curve.kind === 'circle' ? 'diametric' : 'radial',
      center: m4transformPoint(m, curve.center), normal: v3normalize(m4transformDir(m, curve.normal)),
      radius: v3len(m4transformDir(m, [curve.radius, 0, 0])),
      curve: path ? { path, bodyId, curveId: curve.id } : null,
    };
  }

  /** The offset of the dimension line: from the measured line to the cursor, across the line. */
  private lineOffset(a: Vec3, b: Vec3, cursor: Vec3): Vec3 {
    const along = v3normalize(v3sub(b, a));
    return v3sub(cursor, closestOnLine(cursor, a, along));
  }

  /** The cursor moved onto the curve's plane. */
  private onPlane(s: Extract<State, { kind: 'leader' }>, cursor: Vec3): Vec3 {
    return v3sub(cursor, v3scale(s.normal, v3dot(v3sub(cursor, s.center), s.normal)));
  }

  /** Radius: center and the point on the arc toward the cursor. Diameter: that point and the opposite one. */
  private arcPoints(s: Extract<State, { kind: 'leader' }>, cursor: Vec3): { start: Vec3; end: Vec3; leaderFrom: Vec3 } {
    const toward = v3sub(this.onPlane(s, cursor), s.center);
    const dir = v3len(toward) > MERGE_TOL ? v3normalize(toward) : perpendicular(s.normal);
    const onArc = v3add(s.center, v3scale(dir, s.radius));
    return s.type === 'radial'
      ? { start: s.center, end: onArc, leaderFrom: onArc }
      : { start: onArc, end: v3sub(s.center, v3scale(dir, s.radius)), leaderFrom: onArc };
  }

  private previewLines(d: { kind: 'linear' | 'radial' | 'diametric'; start: Vec3; end: Vec3; offset: Vec3 }): OverlayPrimitive[] {
    const drawing = dimensionDrawing(
      { ...d, id: 0 as Id, normal: [0, 0, 1], text: null, fontSizePt: 10, tagId: 0 as never, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {} },
      { start: d.start, end: d.end, normal: [0, 0, 1], value: 0, center: null },
    );
    return drawing.lines.map(([a, b]) => ({ kind: 'polyline' as const, points: [a, b], color: PREVIEW_COLOR, width: 1 }));
  }
}
