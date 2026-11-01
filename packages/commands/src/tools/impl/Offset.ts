// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, PlaneBasis, Vec2, Vec3 } from '@pushform/core';
import { basisToLocal, basisToWorld, MERGE_TOL, planeBasis, planeProject } from '@pushform/core';
import type { InferenceOptions, PickHit } from '@pushform/inference';
import { offsetPolygonFull, offsetPolyline, pointInPolygon } from '@pushform/geom';
import type { PolygonsWithHoles } from '@pushform/geom';
import type { UndoEntry } from '@pushform/model';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { pointerField } from '../entry';
import { HOVER_COLOR, hostOfTool, PREVIEW_COLOR } from '../toolUtil';
import {
  orderSketchEdgeChain,
  planeThroughPoints,
  resolveFaceTargetWorld,
  signedDistanceToPolygon,
  type FaceTarget,
  type FaceTargetInfo,
  type OffsetParams,
} from '../../commands/offset';
import { contextFrame } from '../../commands/context';
import { faceTargetKey, faceTargetOfHit, fmtLength, rootOf, selectionSketchEdgeIds, stateOf } from './constructionUtil';

interface FaceTargetState {
  readonly kind: 'face';
  readonly key: string;
  readonly info: FaceTargetInfo;
}
interface EdgeTargetState {
  readonly kind: 'edges';
  readonly key: string;
  readonly edgeIds: Id[];
  readonly basis: PlaneBasis;
  /** Chain in (u, v). */
  readonly uv: Vec2[];
  readonly world: Vec3[];
  readonly closed: boolean;
}
type Target = FaceTargetState | EdgeTargetState;

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'hover'; readonly target: Target }
  | { readonly kind: 'dragging'; readonly target: Target; distance: number };

interface LastCommit {
  params: OffsetParams;
  entry: UndoEntry | null;
}

const IDLE: State = { kind: 'idle' };

/**
 * Offset (F). Hover a face (highlight) → click → move the cursor for the distance (inward when
 * the cursor is inside the face, outward when outside) or type it → click. Double-click another
 * face repeats the last distance. With ≥ 2 connected coplanar sketch edges preselected the tool
 * offsets that chain instead. Alt toggles "allow overlaps" (raw rings, no self-intersection cleanup).
 */
export class OffsetTool implements Tool {
  readonly id = 'offset';
  readonly title = 'Offset';
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['length'];

  private ctx: ToolContext | null = null;
  private state: State = IDLE;
  private lastDistance: number | null = null;
  private lastCommit: LastCommit | null = null;
  private overlaps = false;
  private lastError: string | null = null;

  /** Signed distance of the current drag, or null. */
  get dragDistance(): number | null {
    return this.state.kind === 'dragging' ? this.state.distance : null;
  }
  get allowOverlap(): boolean {
    return this.overlaps;
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.state = IDLE;
    this.lastCommit = null;
    this.lastError = null;
    // preselected sketch edges → offset the chain
    const edgeIds = selectionSketchEdgeIds(hostOfTool(ctx));
    if (edgeIds.length >= 2) {
      const target = this.edgeTarget(edgeIds);
      if (target) this.state = { kind: 'hover', target };
    }
  }
  deactivate(): void {
    this.state = IDLE;
    this.lastCommit = null;
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    const s = this.state;
    if (s.kind === 'dragging' || (s.kind === 'hover' && s.target.kind === 'edges')) {
      const n = s.target.kind === 'face' ? s.target.info.plane.n : s.target.basis.n;
      const o = s.target.kind === 'face' ? s.target.info.basis.origin : s.target.basis.origin;
      return { plane: { n, d: -(n[0] * o[0] + n[1] * o[1] + n[2] * o[2]) }, pickOnly: true };
    }
    return { kinds: ['face', 'sketchFace'], pickOnly: true };
  }

  onPointerMove(e: ToolPointerEvent): void {
    const s = this.state;
    if (s.kind === 'dragging') {
      s.distance = this.distanceFor(e, s.target);
      this.ctx?.requestRender();
      this.ctx?.statusChanged();
      return;
    }
    if (s.kind === 'hover' && s.target.kind === 'edges') return;
    this.hover(e.inference?.hit ?? null);
  }

  onClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.ctx) return;
    const s = this.state;
    if (s.kind === 'dragging') {
      this.commit(this.distanceFor(e, s.target));
      return;
    }
    if (s.kind === 'hover' && s.target.kind === 'edges') {
      this.state = { kind: 'dragging', target: s.target, distance: 0 };
      this.ctx.statusChanged();
      return;
    }
    const target = this.faceTarget(faceTargetOfHit(stateOf(this.ctx), e.inference?.hit ?? null));
    if (!target) return;
    this.lastCommit = null;
    this.lastError = null;
    this.state = { kind: 'dragging', target, distance: 0 };
    this.ctx.statusChanged();
    this.ctx.requestRender();
  }

  onDoubleClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.ctx || this.lastDistance === null) return;
    if (this.state.kind === 'dragging') this.state = IDLE;
    const target = this.faceTarget(faceTargetOfHit(stateOf(this.ctx), e.inference?.hit ?? null));
    if (!target) return;
    this.state = { kind: 'hover', target };
    this.commit(this.lastDistance);
  }

  onKeyDown(e: ToolKeyEvent): boolean {
    if (e.key !== 'Alt' || e.repeat) return false;
    this.overlaps = !this.overlaps;
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
    return true;
  }

  onVcb(v: VcbValue): void {
    if (v.kind !== 'length' || !this.ctx) return;
    const s = this.state;
    if (s.kind === 'dragging') {
      const sign = s.distance < 0 ? -1 : s.distance > 0 ? 1 : -1;
      this.commit(v.raw < 0 ? -sign * Math.abs(v.meters) : sign * Math.abs(v.meters));
      return;
    }
    const last = this.lastCommit;
    if (!last) return;
    // re-edit the last offset (undo + re-apply) while it is still the top undo entry
    const host = hostOfTool(this.ctx);
    if (!last.entry || host.undoStack.peek() !== last.entry) return;
    const sign = last.params.distance < 0 ? -1 : 1;
    const distance = v.raw < 0 ? -sign * Math.abs(v.meters) : sign * Math.abs(v.meters);
    host.undo();
    this.execute({ ...last.params, distance });
  }

  onCancel(): void {
    this.state = IDLE;
    this.lastCommit = null;
    this.lastError = null;
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  overlay(): readonly OverlayPrimitive[] {
    const s = this.state;
    if (s.kind === 'idle') return [];
    const out: OverlayPrimitive[] = [];
    if (s.target.kind === 'face') {
      const loops = s.target.info.loops;
      loops.forEach((loop, i) => {
        if (i === 0) out.push({ kind: 'polygon', points: loop, holes: loops.slice(1), color: HOVER_COLOR, opacity: 0.2 });
        out.push({ kind: 'polyline', points: loop, color: HOVER_COLOR, closed: true, width: 1.5 });
      });
    } else {
      out.push({ kind: 'polyline', points: s.target.world, color: HOVER_COLOR, closed: s.target.closed, width: 2 });
    }
    if (s.kind === 'dragging' && Math.abs(s.distance) > MERGE_TOL) {
      for (const ring of this.previewRings(s.target, s.distance)) {
        out.push({ kind: 'polyline', points: ring.points, color: PREVIEW_COLOR, closed: ring.closed, width: 1.5 });
      }
    }
    return out;
  }

  status(): ToolStatus {
    const s = this.state;
    const hint = this.overlaps ? ' [Overlaps allowed]' : '';
    if (s.kind === 'dragging') {
      return { instructor: `Click or type the offset distance (negative = inward).${hint}`, vcbLabel: 'Distance', vcbValue: fmtLength(this.ctx, s.distance), fields: [pointerField('Distance', 'length', fmtLength(this.ctx, s.distance))] };
    }
    const instructor = this.lastError
      ? `Offset failed: ${this.lastError}`
      : s.kind === 'hover' && s.target.kind === 'edges'
        ? `Click to start offsetting the selected edges.${hint}`
        : `Select a face to offset (or preselect connected edges). Double-click repeats the last distance.${hint}`;
    const last = this.lastCommit?.params.distance ?? this.lastDistance;
    return { instructor, vcbLabel: 'Distance', vcbValue: last === null ? undefined : fmtLength(this.ctx, last) };
  }

  // --- internals ------------------------------------------------------------------------------

  private hover(hit: PickHit | null): void {
    if (!this.ctx) return;
    const target = this.faceTarget(faceTargetOfHit(stateOf(this.ctx), hit));
    const prev = this.state.kind === 'hover' ? this.state.target.key : null;
    this.state = target ? { kind: 'hover', target } : IDLE;
    if ((target?.key ?? null) !== prev) this.ctx.requestRender();
  }

  private faceTarget(target: FaceTarget | null): FaceTargetState | null {
    if (!target || !this.ctx) return null;
    try {
      return { kind: 'face', key: faceTargetKey(target), info: resolveFaceTargetWorld(stateOf(this.ctx), target) };
    } catch {
      return null;
    }
  }

  private edgeTarget(edgeIds: Id[]): EdgeTargetState | null {
    if (!this.ctx) return null;
    try {
      const host = hostOfTool(this.ctx);
      const frame = contextFrame(host.doc.state, host.context.path);
      const chain = orderSketchEdgeChain(rootOf(this.ctx).sketch, edgeIds);
      const points = chain.points.map((p) => frame.toWorld(p));
      const plane = planeThroughPoints(points);
      if (!plane) return null;
      const basis = planeBasis(points[0]!, plane.n);
      const uv = points.map((p): Vec2 => {
        const l = basisToLocal(basis, p);
        return [l[0], l[1]];
      });
      return { kind: 'edges', key: `edges/${edgeIds.join(',')}`, edgeIds, basis, uv, world: points, closed: chain.closed };
    } catch {
      return null;
    }
  }

  /** Signed distance for the cursor: negative inside the face polygon, positive outside; for a chain, by side. */
  private distanceFor(e: ToolPointerEvent, target: Target): number {
    const p = e.inference?.point;
    if (!p) return 0;
    if (target.kind === 'face') {
      const q = planeProject(target.info.plane, p);
      const l = basisToLocal(target.info.basis, q);
      const uv: Vec2 = [l[0], l[1]];
      return signedDistanceToPolygon(uv, target.info.polygon, pointInPolygon(uv, target.info.polygon));
    }
    const l = basisToLocal(target.basis, p);
    const uv: Vec2 = [l[0], l[1]];
    if (target.closed) {
      const poly: PolygonsWithHoles = [target.uv.map((v) => [v[0], v[1]])];
      return signedDistanceToPolygon(uv, poly, pointInPolygon(uv, poly));
    }
    // open chain: distance to the chain, positive on the right of travel at the closest segment
    let best = Infinity, side = 1;
    for (let i = 0; i + 1 < target.uv.length; i++) {
      const a = target.uv[i]!, b = target.uv[i + 1]!;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((uv[0] - a[0]) * dx + (uv[1] - a[1]) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(a[0] + dx * t - uv[0], a[1] + dy * t - uv[1]);
      if (d < best) {
        best = d;
        side = dx * (uv[1] - a[1]) - dy * (uv[0] - a[0]) < 0 ? 1 : -1;
      }
    }
    return Number.isFinite(best) ? best * side : 0;
  }

  private previewRings(target: Target, distance: number): { points: Vec3[]; closed: boolean }[] {
    try {
      if (target.kind === 'face') {
        const r = offsetPolygonFull(target.info.polygon, distance, { arcs: target.info.arcs, cleanup: !this.overlaps });
        const out: { points: Vec3[]; closed: boolean }[] = [];
        for (const poly of r.polygons) for (const ring of poly) out.push({ points: ring.map((p) => basisToWorld(target.info.basis, p[0] ?? 0, p[1] ?? 0)), closed: true });
        return out;
      }
      if (target.closed) {
        const r = offsetPolygonFull([target.uv.map((v) => [v[0], v[1]])], distance, { cleanup: !this.overlaps });
        const out: { points: Vec3[]; closed: boolean }[] = [];
        for (const poly of r.polygons) for (const ring of poly) out.push({ points: ring.map((p) => basisToWorld(target.basis, p[0] ?? 0, p[1] ?? 0)), closed: true });
        return out;
      }
      return [{ points: offsetPolyline(target.uv, distance).map((p) => basisToWorld(target.basis, p[0], p[1])), closed: false }];
    } catch {
      return [];
    }
  }

  private commit(distance: number): void {
    const s = this.state;
    if (s.kind === 'idle' || !this.ctx) return;
    if (!Number.isFinite(distance) || Math.abs(distance) <= MERGE_TOL) {
      this.state = IDLE;
      this.ctx.statusChanged();
      this.ctx.requestRender();
      return;
    }
    const params: OffsetParams =
      s.target.kind === 'face'
        ? { faceRef: s.target.info.target, distance, allowOverlap: this.overlaps }
        : { edgeIds: s.target.edgeIds as number[], distance, allowOverlap: this.overlaps };
    this.state = IDLE;
    this.execute(params);
  }

  private execute(params: OffsetParams): void {
    if (!this.ctx) return;
    const host = hostOfTool(this.ctx);
    this.lastError = null;
    try {
      this.ctx.commands.execute('sketch.offset', params);
      this.lastDistance = params.distance;
      this.lastCommit = { params, entry: host.undoStack.peek() };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastCommit = null;
    }
    this.ctx.statusChanged();
    this.ctx.requestRender();
  }
}
