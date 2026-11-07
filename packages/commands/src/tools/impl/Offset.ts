// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, PlaneBasis, Vec2, Vec3 } from '@pushform/core';
import { basisToLocal, basisToWorld, MERGE_TOL, planeBasis, planeDistance, planeProject, rayAt, rayPlane } from '@pushform/core';
import type { Plane } from '@pushform/core';
import type { InferenceOptions, PickHit } from '@pushform/inference';
import { hitInContext } from '@pushform/inference';
import { offsetPolygonFull, pointInPolygon } from '@pushform/geom';
import type { PolygonsWithHoles } from '@pushform/geom';
import type { UndoEntry } from '@pushform/model';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolSettingValue, ToolStatus } from '../Tool';
import { toggleSetting } from '../settings';
import { pointerField } from '../entry';
import { DRAG_PX, HOVER_COLOR, hostOfTool, PREVIEW_COLOR, screenDist } from '../toolUtil';
import {
  chainPlane,
  edgeChainProblem,
  orderSketchEdgeChain,
  planEdgeOffset,
  resolveFaceTargetWorld,
  signedDistanceToPolygon,
  type FaceTarget,
  type FaceTargetInfo,
  type OffsetParams,
} from '../../commands/offset';
import { contextFrame, samePath } from '../../commands/context';
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
  readonly plane: Plane;
  readonly basis: PlaneBasis;
  /** Chain in (u, v). */
  readonly uv: Vec2[];
  readonly world: Vec3[];
  readonly closed: boolean;
}
type Target = FaceTargetState | EdgeTargetState;

interface Dragging {
  readonly kind: 'dragging';
  readonly target: Target;
  /** Signed: < 0 inward (a face or closed chain), for an open chain < 0 left of travel. */
  distance: number;
  /** Screen point of the press that started the offset. */
  readonly downScreen: Vec2;
  /** The button is still down from that press (press-drag-release). */
  pressed: boolean;
  /** The pointer has travelled more than DRAG_PX since the press: it has chosen a side. */
  moved: boolean;
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'hover'; readonly target: FaceTargetState }
  | { readonly kind: 'chain'; readonly target: EdgeTargetState }
  | Dragging;

interface LastCommit {
  params: OffsetParams;
  entry: UndoEntry | null;
}

const IDLE: State = { kind: 'idle' };

/** Snaps that put the pointer's point on a vertex or an edge. */
const POINT_SNAPS: ReadonlySet<string> = new Set(['endpoint', 'midpoint', 'onEdge', 'intersection', 'center']);

/**
 * Offset (F). Hover a face of the open context, then click and click again, or press, drag and
 * release: the distance is from the pointer's point to the nearest loop, inward when it is inside
 * the face and outward when outside. A typed distance goes to the pointer's side (inward before
 * the pointer moves), a negative one the other way; typed after the offset it redoes it. Double-
 * click a face to repeat the last face offset. With two or more connected coplanar sketch edges
 * preselected the tool offsets that chain instead. Alt switches Allow overlaps (raw rings, no
 * self-intersection cleanup), which is off each time the tool is chosen.
 */
export class OffsetTool implements Tool {
  readonly id = 'offset';
  readonly title = 'Offset';
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['length'];

  private ctx: ToolContext | null = null;
  private state: State = IDLE;
  /** Signed distance of the last face offset, repeated by a double-click; null after a chain offset. */
  private lastFaceDistance: number | null = null;
  /** Unsigned distance of the last offset, shown in the field when idle. */
  private lastShown: number | null = null;
  private lastCommit: LastCommit | null = null;
  private overlaps = false;
  private lastError: string | null = null;
  /** Why the preselected edges are not used as a chain. */
  private chainProblem: string | null = null;
  /** An open chain got a typed distance before the pointer chose a side. */
  private needSide = false;

  /** Signed distance of the current offset, or null. */
  get dragDistance(): number | null {
    return this.state.kind === 'dragging' ? this.state.distance : null;
  }
  get allowOverlap(): boolean {
    return this.overlaps;
  }

  /** Only an offset under way is work in progress; hovering a face or a loaded chain is not. */
  hasPendingWork(): boolean {
    return this.state.kind === 'dragging';
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.state = IDLE;
    this.lastCommit = null;
    this.lastError = null;
    this.chainProblem = null;
    this.needSide = false;
    // a mode toggle starts off each time the tool is chosen
    this.overlaps = false;
    // preselected sketch edges → offset the chain
    const edgeIds = selectionSketchEdgeIds(hostOfTool(ctx));
    if (edgeIds.length >= 2) {
      const host = hostOfTool(ctx);
      const frame = contextFrame(host.doc.state, host.context.path);
      this.chainProblem = edgeChainProblem(rootOf(ctx).sketch, edgeIds, (p) => frame.toWorld(p));
      const target = this.chainProblem ? null : this.edgeTarget(edgeIds);
      if (target) this.state = { kind: 'chain', target };
    }
  }
  deactivate(): void {
    this.state = IDLE;
    this.lastCommit = null;
    this.ctx = null;
  }

  inferenceOptions(): InferenceOptions {
    const s = this.state;
    if (s.kind === 'dragging') {
      // snap to vertices and edges while measuring the distance
      return { plane: this.planeOf(s.target) };
    }
    if (s.kind === 'chain') return { plane: s.target.plane, pickOnly: true };
    return { kinds: ['face', 'sketchFace'], pickOnly: true };
  }

  // --- pointer --------------------------------------------------------------------------------

  onPointerMove(e: ToolPointerEvent): void {
    const s = this.state;
    if (s.kind === 'dragging') {
      if (!s.moved && screenDist(e.screen, s.downScreen) > DRAG_PX) s.moved = true;
      if (s.moved) {
        s.distance = this.distanceFor(e, s.target);
        this.needSide = false;
      }
      this.ctx?.requestRender();
      this.ctx?.statusChanged();
      return;
    }
    if (s.kind === 'chain') return;
    this.hover(e.inference?.hit ?? null);
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.ctx) return;
    // a click in the view ends the chance to redo the last offset
    this.lastCommit = null;
    const s = this.state;
    if (s.kind === 'dragging') {
      if (s.pressed) return;
      // Second click of click-move-click. One that never left the first (a double-click) makes no offset.
      if (!s.moved && screenDist(e.screen, s.downScreen) <= DRAG_PX) {
        this.endDrag(s.target);
        return;
      }
      this.commit(this.distanceFor(e, s.target));
      return;
    }
    this.lastError = null;
    this.chainProblem = null;
    // a chain is read again: an earlier offset may have split its edges
    const target: Target | null = s.kind === 'chain' ? this.edgeTarget(s.target.edgeIds) : this.faceTarget(e.inference?.hit ?? null);
    if (!target) {
      this.state = IDLE;
      this.ctx.statusChanged();
      return;
    }
    this.needSide = false;
    this.state = { kind: 'dragging', target, distance: 0, downScreen: e.screen, pressed: true, moved: false };
    this.ctx.statusChanged();
    this.ctx.requestRender();
  }

  onPointerUp(e: ToolPointerEvent): void {
    const s = this.state;
    if (e.button !== 0 || s.kind !== 'dragging' || !s.pressed) return;
    s.pressed = false;
    // released where it was pressed: click-move-click continues
    if (!s.moved && screenDist(e.screen, s.downScreen) <= DRAG_PX) return;
    this.commit(this.distanceFor(e, s.target));
  }

  onDoubleClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.ctx) return;
    if (this.state.kind === 'dragging') this.endDrag(this.state.target);
    // repeats the last face offset; after a chain offset there is nothing to repeat
    const distance = this.lastFaceDistance;
    if (distance === null) return;
    const target = this.faceTarget(e.inference?.hit ?? null);
    if (!target) return;
    if (this.state.kind === 'hover') this.state = IDLE;
    this.execute({ faceRef: target.info.target, distance, allowOverlap: this.overlaps });
  }

  // --- keys / entry ---------------------------------------------------------------------------

  onKeyDown(e: ToolKeyEvent): boolean {
    if (e.key !== 'Alt' || e.repeat) return false;
    // the same as switching Allow overlaps in the bar: just after an offset it redoes that offset
    this.onSetting('overlaps', !this.overlaps);
    if (this.lastCommit && this.state.kind !== 'dragging') this.adjustLast('overlaps');
    return true;
  }

  onVcb(v: VcbValue): void {
    if (v.kind !== 'length' || !this.ctx) return;
    const s = this.state;
    const typed = Math.abs(v.meters);
    const flip = v.raw < 0 ? -1 : 1;
    if (s.kind === 'dragging') {
      const open = s.target.kind === 'edges' && !s.target.closed;
      if (open && (!s.moved || s.distance === 0)) {
        this.needSide = true;
        this.ctx.statusChanged();
        return;
      }
      // the pointer's side; before the pointer moves, inward
      const side = s.moved && s.distance > 0 ? 1 : -1;
      this.commit(flip * side * typed);
      return;
    }
    const last = this.lastCommit;
    if (!last) return;
    // re-edit the last offset (undo + re-apply) on its side while it is still the top undo entry
    const side = last.params.distance < 0 ? -1 : 1;
    this.reapplyLast(last, { ...last.params, distance: flip * side * typed });
  }

  /** The bar switched Allow overlaps just after an offset: redo it that way, as one undo step. */
  adjustLast(id: string): boolean {
    const last = this.lastCommit;
    if (id !== 'overlaps' || !last) return false;
    return this.reapplyLast(last, { ...last.params, allowOverlap: this.overlaps });
  }

  onCancel(): void {
    this.state = IDLE;
    this.lastCommit = null;
    this.lastError = null;
    this.chainProblem = null;
    this.needSide = false;
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  // --- overlay / status -----------------------------------------------------------------------

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
    return { ...this.baseStatus(), settings: [toggleSetting('overlaps', 'Allow overlaps', this.overlaps, 'secondary')] };
  }

  onSetting(id: string, value: ToolSettingValue): void {
    if (id !== 'overlaps' || typeof value !== 'boolean') return;
    this.overlaps = value;
    this.ctx?.requestRender();
    this.ctx?.statusChanged();
  }

  private baseStatus(): ToolStatus {
    const s = this.state;
    if (s.kind === 'dragging') {
      const shown = fmtLength(this.ctx, Math.abs(s.distance));
      const fields = [pointerField('Distance', 'length', shown)];
      const open = s.target.kind === 'edges' && !s.target.closed;
      let instructor: string;
      if (open && (!s.moved || s.distance === 0)) {
        instructor = this.needSide ? 'Move the pointer to the side to offset toward, then type the distance again.' : 'Move the pointer to the side to offset toward, then click or type a distance.';
      } else if (open) {
        instructor = "Offsetting toward the pointer's side of the edges. Click, or type a distance; a negative one offsets to the other side.";
      } else {
        const outward = s.moved && s.distance > 0;
        instructor = `Offsetting ${outward ? 'outward' : 'inward'}. Click, or type a distance; a negative one offsets ${outward ? 'inward' : 'outward'}.`;
      }
      return { instructor, vcbLabel: 'Distance', vcbValue: shown, fields };
    }
    const instructor = this.lastError
      ? `Offset failed: ${this.lastError}`
      : this.chainProblem
        ? `${this.chainProblem}, so they are not offset as a chain. Select a face to offset.`
        : s.kind === 'chain'
          ? `Click to start offsetting the selected edges.`
          : `Select a face to offset (or preselect connected edges). Double-click a face to repeat the last offset.`;
    const last = this.lastCommit ? Math.abs(this.lastCommit.params.distance) : this.lastShown;
    return { instructor, vcbLabel: 'Distance', vcbValue: last === null ? undefined : fmtLength(this.ctx, last) };
  }

  // --- internals ------------------------------------------------------------------------------

  private endDrag(target: Target): void {
    this.state = target.kind === 'edges' ? { kind: 'chain', target } : { kind: 'hover', target };
    this.needSide = false;
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  private hover(hit: PickHit | null): void {
    if (!this.ctx) return;
    const target = this.faceTarget(hit);
    const prev = this.state.kind === 'hover' ? this.state.target.key : null;
    this.state = target ? { kind: 'hover', target } : IDLE;
    if ((target?.key ?? null) !== prev) this.ctx.requestRender();
  }

  /** The face under a hit, when it is offered: in the open edit context (mesh parts never are). */
  private faceTarget(hit: PickHit | null): FaceTargetState | null {
    if (!hit || !this.ctx) return null;
    if (!hitInContext(hit) || !samePath(hit.ref.path, hostOfTool(this.ctx).context.path)) return null;
    const target: FaceTarget | null = faceTargetOfHit(stateOf(this.ctx), hit);
    if (!target) return null;
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
      // the command offsets in the same plane and basis, so the pointer's side matches the sign
      const plane = chainPlane(points);
      const basis = planeBasis(points[0]!, plane.n);
      const uv = points.map((p): Vec2 => {
        const l = basisToLocal(basis, p);
        return [l[0], l[1]];
      });
      return { kind: 'edges', key: `edges/${edgeIds.join(',')}`, edgeIds, plane, basis, uv, world: points, closed: chain.closed };
    } catch {
      return null;
    }
  }

  private planeOf(target: Target): Plane {
    return target.kind === 'face' ? target.info.plane : target.plane;
  }

  /**
   * The pointer's point on the target's plane: a snapped vertex or edge point lying on it, else
   * where the pointer's ray meets the plane.
   */
  private pointOnPlane(e: ToolPointerEvent, plane: Plane): Vec3 | null {
    const inf = e.inference;
    if (inf && POINT_SNAPS.has(inf.primary.kind) && Math.abs(planeDistance(plane, inf.point)) <= MERGE_TOL) return inf.point;
    const t = rayPlane(e.ray, plane);
    if (t !== null) return rayAt(e.ray, t);
    return inf ? planeProject(plane, inf.point) : null;
  }

  /** Signed distance for the pointer: negative inside the face polygon, positive outside; for a chain, by side. */
  private distanceFor(e: ToolPointerEvent, target: Target): number {
    const p = this.pointOnPlane(e, this.planeOf(target));
    if (!p) return 0;
    if (target.kind === 'face') {
      const l = basisToLocal(target.info.basis, p);
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

  /** The offset loops as the command would make them, in world space. */
  private previewRings(target: Target, distance: number): { points: Vec3[]; closed: boolean }[] {
    if (!this.ctx) return [];
    try {
      if (target.kind === 'face') {
        const r = offsetPolygonFull(target.info.polygon, distance, { arcs: target.info.arcs, cleanup: !this.overlaps });
        const out: { points: Vec3[]; closed: boolean }[] = [];
        for (const poly of r.polygons) for (const ring of poly) out.push({ points: ring.map((p) => basisToWorld(target.info.basis, p[0] ?? 0, p[1] ?? 0)), closed: true });
        return out;
      }
      const host = hostOfTool(this.ctx);
      const frame = contextFrame(host.doc.state, host.context.path);
      const plan = planEdgeOffset(rootOf(this.ctx).sketch, frame, target.edgeIds, distance, this.overlaps);
      return plan.rings.map((r) => ({ points: r.points.map((p) => frame.toWorld(p)), closed: r.closed }));
    } catch {
      return [];
    }
  }

  private commit(distance: number): void {
    const s = this.state;
    if (s.kind !== 'dragging' || !this.ctx) return;
    // the chain stays loaded for another offset; a face is picked again
    this.state = s.target.kind === 'edges' ? { kind: 'chain', target: s.target } : IDLE;
    this.needSide = false;
    this.ctx.statusChanged();
    this.ctx.requestRender();
    // a distance of zero changes nothing
    if (!Number.isFinite(distance) || Math.abs(distance) <= MERGE_TOL) return;
    const params: OffsetParams =
      s.target.kind === 'face'
        ? { faceRef: s.target.info.target, distance, allowOverlap: this.overlaps }
        : { edgeIds: s.target.edgeIds as number[], distance, allowOverlap: this.overlaps };
    this.execute(params);
  }

  /**
   * Redo the last offset with `params` as one undo step while it is still the top undo entry. When the
   * new offset fails the original is put back (lastError says why). False when there is none to redo.
   */
  private reapplyLast(last: LastCommit, params: OffsetParams): boolean {
    if (!this.ctx || !last.entry) return false;
    const host = hostOfTool(this.ctx);
    if (host.undoStack.peek() !== last.entry || !host.undo()) return false;
    this.execute(params);
    if (this.lastCommit === null) {
      // the original goes back, still the operation the bar shows as applied
      host.redo();
      this.lastCommit = last;
      this.ctx.committed?.();
      this.ctx.requestRender();
    }
    return true;
  }

  private execute(params: OffsetParams): void {
    if (!this.ctx) return;
    const host = hostOfTool(this.ctx);
    const before = host.undoStack.peek();
    this.lastError = null;
    this.lastCommit = null;
    try {
      this.ctx.commands.execute('sketch.offset', params);
      const entry = host.undoStack.peek();
      // an offset that recorded nothing is not this tool's to adjust (the top entry is an older step)
      if (!entry || entry === before) throw new Error('The offset changed nothing');
      this.lastCommit = { params, entry };
      this.lastFaceDistance = params.faceRef ? params.distance : null;
      this.lastShown = Math.abs(params.distance);
      this.ctx.committed?.();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    this.ctx.statusChanged();
    this.ctx.requestRender();
  }
}
