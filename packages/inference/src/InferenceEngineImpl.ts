// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, MMat4, Plane, Ray, Vec2, Vec3 } from '@pushform/core';
import {
  COPLANAR_TOL,
  ANGLE_TOL,
  MERGE_TOL,
  PICK_PX,
  m4identity,
  m4transformDir,
  m4transformPoint,
  planeDistance,
  planeProject,
  rayAt,
  rayPlane,
  V3_X,
  V3_Y,
  V3_Z,
  v3addScaled,
  v3anyPerpendicular,
  v3cross,
  v3dist,
  v3dot,
  v3len,
  v3lerp,
  v3normalize,
  v3sub,
} from '@pushform/core';
import { lineLineClosest3D } from '@pushform/geom';
import { contextInverse, contextMatrix, entityRefKey, pathKey, type Curve, type DocumentState, type EntityRef } from '@pushform/model';
import type { InferenceEngine } from './InferenceEngine';
import {
  choosePick,
  PickService,
  samePath,
  type EdgeCandidate,
  type GuideCandidate,
  type PickCandidates,
  type SurfaceCandidate,
} from './PickService';
import { SpatialIndex } from './SpatialIndex';
import {
  GROUND_PLANE,
  SNAP_COLORS,
  freeInference,
  type Axis,
  type InferenceInput,
  type InferenceLine,
  type InferenceOptions,
  type InferenceResult,
  type PickHit,
  type ReferenceEdge,
  type Snap,
  type PickBoxMode,
} from './types';

export interface InferenceEngineOptions {
  /** Initial edit context (instance path; default root). Change it later with `setContext`. */
  readonly path?: readonly Id[] | undefined;
  /** Monotonic clock in ms (default `performance.now`). */
  readonly clock?: (() => number) | undefined;
  /** Hover time before a snapped point enters the inference memory (~400 ms). */
  readonly hoverDelayMs?: number | undefined;
  /** Depth of the from-point memory (3). */
  readonly memorySize?: number | undefined;
  /** Distance along the ray used for free points when the ray misses the plane. */
  readonly freeDistance?: number | undefined;
  /** Share an index with other services (e.g. the renderer's hover highlight). */
  readonly index?: SpatialIndex | undefined;
}

/**
 * How long one pointer query may spend catching the index up with the document. Past it, the query sees an empty
 * index until the rest is built in idle time, so the first hover over a large model never stalls (PF-189).
 */
export const POINTER_INDEX_BUDGET_MS = 40;

export const AXIS_DIR: Record<Axis, Vec3> = { x: V3_X, y: V3_Y, z: V3_Z };
export const AXIS_COLOR: Record<Axis, string> = { x: SNAP_COLORS.axisX, y: SNAP_COLORS.axisY, z: SNAP_COLORS.axisZ };
export const AXIS_LABEL: Record<Axis, string> = { x: 'On Red Axis', y: 'On Green Axis', z: 'On Blue Axis' };
const AXES: readonly Axis[] = ['x', 'y', 'z'];

/** Point snaps that pin the cursor to an exact location (they win over directional snaps). */
const STRONG_KINDS: ReadonlySet<Snap['kind']> = new Set(['endpoint', 'midpoint', 'center', 'intersection', 'origin']);
function isStrong(s: Snap): boolean {
  return STRONG_KINDS.has(s.kind) || (s.kind === 'guide' && s.dir === undefined);
}
/** Linear snaps that already constrain the point to a line (from-point lines do not replace them). */
const DIRECTIONAL_KINDS: ReadonlySet<Snap['kind']> = new Set(['parallel', 'perpendicular', 'tangent', 'extension']);

/** Line constraint (origin + dir) to be resolved against the cursor and whatever it is over. */
interface LineConstraint {
  readonly origin: Vec3;
  readonly dir: Vec3;
}

/** Where a line constraint got its point from. */
type Via = 'point' | 'plane' | 'edge' | 'ray';

interface Context {
  readonly surface: SurfaceCandidate | null;
  readonly edge: EdgeCandidate | null;
  /** The edit context path (for "in Group" marking of secondary snaps). */
  readonly path: readonly Id[];
}

/** A candidate direction through the anchor (parallel / perpendicular / tangent). */
interface DirCandidate {
  readonly kind: 'parallel' | 'perpendicular' | 'tangent';
  readonly dir: Vec3;
  readonly ref: EntityRef | undefined;
  readonly label: string;
  readonly color: string;
}

/** A straight line (finite or infinite) taking part in intersection snaps. */
interface IntersectLine {
  readonly origin: Vec3;
  readonly dir: Vec3;
  /** Segment length when finite, Infinity for guide lines. */
  readonly length: number;
  readonly ref: EntityRef;
}

/**
 * Inference: picking, point snaps, directional snaps from an anchor, from-point
 * memory, locks and the free-point plane rule.
 */
export class InferenceEngineImpl implements InferenceEngine {
  readonly index: SpatialIndex;
  readonly picker: PickService;
  private readonly clock: () => number;
  private readonly hoverDelayMs: number;
  private readonly memorySize: number;
  private readonly freeDistance: number;

  private memory: Vec3[] = [];
  private hover: { key: string; since: number; pushed: boolean } | null = null;
  private hoverEdge: { key: string; since: number } | null = null;
  /** The last edge the user rested on (reference for parallel / perpendicular / extension). */
  private refEdge: ReferenceEdge | null = null;
  /** Tangent directions at the current anchor, memoized per (anchor, index generation). */
  private tangentCache: { key: string; generation: number; dirs: DirCandidate[] } | null = null;
  /** Edit context used when `InferenceOptions.context` is not given. */
  private ctxPath: readonly Id[] = [];
  /** Context matrices memoized per (state, path). */
  private matrixCache = new Map<string, { matrix: MMat4; inverse: MMat4 }>();
  private matrixState: DocumentState | null = null;

  constructor(opts: InferenceEngineOptions = {}) {
    this.index = opts.index ?? new SpatialIndex(opts.path ?? []);
    this.picker = new PickService(this.index);
    this.ctxPath = [...(opts.path ?? [])];
    this.clock = opts.clock ?? (() => performance.now());
    this.hoverDelayMs = opts.hoverDelayMs ?? 400;
    this.memorySize = opts.memorySize ?? 3;
    this.freeDistance = opts.freeDistance ?? 10;
  }

  setState(state: DocumentState): void {
    this.index.setState(state);
  }

  /** The edit context used when a call does not pass `InferenceOptions.context`. */
  get context(): readonly Id[] {
    return this.ctxPath;
  }
  /** Set the open edit context (the shell calls this on Edit Group / Close Group). */
  setContext(path: readonly Id[]): void {
    if (samePath(path, this.ctxPath)) return;
    this.ctxPath = [...path];
    this.clearMemory();
  }

  /** local→world matrix of the context at `path` (default: the current context). */
  contextMatrix(path: readonly Id[] = this.ctxPath): MMat4 {
    return this.matrices(path).matrix;
  }
  /** world→local matrix of the context at `path` (default: the current context). */
  contextInverse(path: readonly Id[] = this.ctxPath): MMat4 {
    return this.matrices(path).inverse;
  }
  /** World point → local coordinates of the container at `path` (default: the current context). */
  toLocal(point: Vec3, path: readonly Id[] = this.ctxPath): Vec3 {
    return path.length === 0 ? point : m4transformPoint(this.matrices(path).inverse, point);
  }
  /** Local point of the container at `path` (default: the current context) → world. */
  toWorld(point: Vec3, path: readonly Id[] = this.ctxPath): Vec3 {
    return path.length === 0 ? point : m4transformPoint(this.matrices(path).matrix, point);
  }

  private matrices(path: readonly Id[]): { matrix: MMat4; inverse: MMat4 } {
    const state = this.index.documentState;
    if (state !== this.matrixState) {
      this.matrixCache.clear();
      this.matrixState = state;
    }
    const key = pathKey(path);
    let m = this.matrixCache.get(key);
    if (!m) {
      m = state && path.length > 0 ? { matrix: contextMatrix(state, path), inverse: contextInverse(state, path) } : { matrix: m4identity(), inverse: m4identity() };
      this.matrixCache.set(key, m);
    }
    return m;
  }

  pick(input: InferenceInput, opts: InferenceOptions = {}): PickHit | null {
    if (input.project) this.projector = input.project;
    return this.index.within(POINTER_INDEX_BUDGET_MS, () => this.picker.pick(input, this.pickOptions(opts)));
  }

  private pickOptions(opts: InferenceOptions): { kinds: InferenceOptions['kinds']; ignore: InferenceOptions['ignore']; context: readonly Id[]; dimensions: boolean } {
    // Dimensions are picked by selection (a pick-only query for any kind) or when asked for by kind.
    return { kinds: opts.kinds, ignore: opts.ignore, context: opts.context ?? this.ctxPath, dimensions: (!!opts.pickOnly && !opts.kinds) || !!opts.kinds?.includes('dimension') };
  }

  /** Screen projector used by `pickBox`; remembered from the last input that carried one. */
  private projector: ((p: Vec3) => Vec2) | null = null;
  setProjector(project: ((p: Vec3) => Vec2) | null): void {
    this.projector = project;
  }

  /** Box selection (Select tool): `window` = fully inside, `crossing` = touching. */
  pickBox(rect: { min: Vec2; max: Vec2; mode: PickBoxMode }, opts: InferenceOptions = {}): EntityRef[] {
    if (!this.projector) return [];
    return this.picker.pickBox({ min: rect.min, max: rect.max }, { project: this.projector }, rect.mode, this.pickOptions(opts));
  }

  /** Lasso selection (Lasso tool) inside a closed screen outline: `window` = fully inside, `crossing` = touching. */
  pickLasso(outline: readonly Vec2[], mode: PickBoxMode, opts: InferenceOptions = {}): EntityRef[] {
    if (!this.projector) return [];
    return this.picker.pickLasso(outline, { project: this.projector }, mode, this.pickOptions(opts));
  }

  rememberPoint(point: Vec3): void {
    this.memory = this.memory.filter((p) => v3dist(p, point) > MERGE_TOL);
    this.memory.unshift([point[0], point[1], point[2]]);
    if (this.memory.length > this.memorySize) this.memory.length = this.memorySize;
  }

  /** Remembered points, most recent first. */
  get rememberedPoints(): readonly Vec3[] {
    return this.memory;
  }

  /**
   * The edge used for "Parallel to Edge" / "Perpendicular to Edge" / "On Line" (extension).
   * Set automatically after resting on an edge for the hover delay; tools may set it explicitly
   * (e.g. the Line tool after clicking on an edge) or clear it with null.
   */
  get referenceEdge(): ReferenceEdge | null {
    return this.refEdge;
  }
  set referenceEdge(edge: ReferenceEdge | null) {
    this.refEdge = edge ? { ...edge, dir: v3normalize(edge.dir) } : null;
  }

  clearMemory(): void {
    this.memory = [];
    this.hover = null;
    this.hoverEdge = null;
    this.refEdge = null;
    this.tangentCache = null;
  }

  resolve(input: InferenceInput, opts: InferenceOptions = {}): InferenceResult {
    return this.index.within(POINTER_INDEX_BUDGET_MS, () => this.resolveNow(input, opts));
  }

  private resolveNow(input: InferenceInput, opts: InferenceOptions): InferenceResult {
    if (input.project) this.projector = input.project;
    const { ray, pixelSizeAt } = input;
    const freePlane = opts.plane ?? GROUND_PLANE;
    const freePoint = this.freePoint(ray, freePlane);
    const context = opts.context ?? this.ctxPath;
    const cands = this.picker.candidates(input, this.pickOptions(opts));
    const hit = this.picker.contextualize(choosePick(cands), context);
    if (opts.pickOnly) {
      this.updateHover(null, hit, cands);
      return freeInference(hit?.point ?? freePoint, cands.surface?.plane ?? freePlane, hit);
    }

    const ctx: Context = {
      surface: cands.surface,
      edge: hit && (hit.ref.kind === 'edge' || hit.ref.kind === 'sketchEdge') ? (cands.edges[0] ?? null) : null,
      path: context,
    };
    // Without point inferences the point is where the cursor meets a face, else the free plane.
    const mode = opts.snapping ?? 'all';
    let primary: Snap = (mode === 'all' ? this.pointSnap(cands, input, context) : null)
      ?? { kind: 'free', point: mode === 'all' ? freePoint : (cands.surface?.point ?? freePoint), color: SNAP_COLORS.free, label: '' };
    const secondary: Snap[] = [];
    const lines: InferenceLine[] = [];
    let lockedAxis: Axis | null = null;
    const strong = isStrong(primary);
    const anchor = opts.anchor ?? null;

    // ---- locks (override everything else)
    const lockSnap = opts.lockSnap ?? null;
    const lockAxis = opts.lockAxis ?? null;
    if (lockSnap && lockSnap.dir) {
      const r = this.resolveOnLine({ origin: lockSnap.point, dir: lockSnap.dir }, ray, ctx, strong ? primary : null);
      const strongSnap = strong ? primary : null;
      primary = { ...lockSnap, point: r.point };
      if (strongSnap) secondary.push(strongSnap);
      else this.pushVia(secondary, r.via, ctx);
      if (lockSnap.axis) lockedAxis = lockSnap.axis;
      lines.push({ a: lockSnap.point, b: r.point, color: lockSnap.color, dashed: false });
    } else if (lockSnap && lockSnap.plane) {
      // Shift+Alt: the drawing plane is frozen; points live on it, axis lines in it still work.
      const plane = lockSnap.plane;
      let point: Vec3;
      if (strong) {
        point = planeProject(plane, primary.point);
        secondary.push(primary);
      } else if (primary.kind !== 'free' && Math.abs(planeDistance(plane, primary.point)) <= COPLANAR_TOL) {
        // an edge / face point already on the plane keeps its snap as context
        point = planeProject(plane, primary.point);
        secondary.push(primary);
      } else {
        const t = rayPlane(ray, plane);
        point = t === null ? rayAt(ray, this.freeDistance) : rayAt(ray, t);
        const inPlane = anchor && Math.abs(planeDistance(plane, anchor)) <= COPLANAR_TOL ? anchor : null;
        const best = inPlane ? nearestAxisLine(ray, inPlane, pixelSizeAt, PICK_PX.edge) : null;
        if (inPlane && best && Math.abs(v3dot(AXIS_DIR[best.axis], plane.n)) <= ANGLE_TOL) {
          const c = lineLineClosest3D(inPlane, AXIS_DIR[best.axis], ray.origin, ray.dir);
          if (!c.parallel) {
            point = c.p;
            secondary.push(axisSnap(best.axis, point));
            lines.push({ a: inPlane, b: point, color: AXIS_COLOR[best.axis], dashed: false });
          }
        }
      }
      primary = { ...lockSnap, point };
    } else if (lockAxis) {
      const origin = anchor ?? this.memory[0] ?? [0, 0, 0];
      const r = this.resolveOnLine({ origin, dir: AXIS_DIR[lockAxis] }, ray, ctx, strong ? primary : null);
      const strongSnap = strong ? primary : null;
      primary = axisSnap(lockAxis, r.point);
      lockedAxis = lockAxis;
      if (strongSnap) secondary.push(strongSnap);
      else this.pushVia(secondary, r.via, ctx);
      lines.push({ a: origin, b: r.point, color: AXIS_COLOR[lockAxis], dashed: false });
    } else {
      // ---- directional snaps from the anchor
      if (anchor && mode === 'directional') {
        const d = this.nearestDirection(ray, anchor, pixelSizeAt, freePlane);
        if (d) {
          const r = this.resolveOnLine({ origin: anchor, dir: d.dir }, ray, ctx, null);
          primary = { kind: d.kind, point: r.point, dir: d.dir, ref: d.ref, color: d.color, label: d.label };
          lines.push({ a: anchor, b: r.point, color: d.color, dashed: false });
        }
      } else if (anchor && mode === 'all') {
        const best = nearestAxisLine(ray, anchor, pixelSizeAt, PICK_PX.edge);
        if (strong) {
          // keep the exact point; show the axis when it happens to be aligned with the anchor
          const aligned = alignedAxis(anchor, primary.point);
          if (aligned) {
            secondary.push(axisSnap(aligned, primary.point));
            lines.push({ a: anchor, b: primary.point, color: AXIS_COLOR[aligned], dashed: false });
          }
        } else if (primary.kind === 'extension' && primary.dir) {
          // "On Line" already constrains the point; intersect it with an anchor axis when both agree
          if (best) {
            const c = lineLineClosest3D(anchor, AXIS_DIR[best.axis], primary.point, primary.dir);
            if (!c.parallel && Math.sqrt(c.distSq) <= PICK_PX.edge * pixelSizeAt(screenT(ray, c.p))) {
              secondary.push({ ...primary, point: c.p });
              primary = axisSnap(best.axis, c.p);
              lines.push({ a: anchor, b: c.p, color: primary.color, dashed: false });
            }
          }
        } else if (best) {
          const r = this.resolveOnLine({ origin: anchor, dir: AXIS_DIR[best.axis] }, ray, ctx, null);
          primary = axisSnap(best.axis, r.point);
          this.pushVia(secondary, r.via, ctx);
          lines.push({ a: anchor, b: r.point, color: AXIS_COLOR[best.axis], dashed: false });
        } else {
          const d = this.nearestDirection(ray, anchor, pixelSizeAt, freePlane);
          if (d) {
            const r = this.resolveOnLine({ origin: anchor, dir: d.dir }, ray, ctx, null);
            primary = { kind: d.kind, point: r.point, dir: d.dir, ref: d.ref, color: d.color, label: d.label };
            this.pushVia(secondary, r.via, ctx);
            lines.push({ a: anchor, b: r.point, color: d.color, dashed: false });
          }
        }
      }

      // ---- from-point inference out of the memory
      if (mode === 'all' && !isStrong(primary)) {
        const fp = this.nearestFromPointLine(ray, anchor, pixelSizeAt);
        if (fp) {
          const fromDir = AXIS_DIR[fp.axis];
          if (primary.kind === 'onAxis' && primary.dir && anchor) {
            // intersect the anchor axis line with the from-point line
            const c = lineLineClosest3D(anchor, primary.dir, fp.origin, fromDir);
            if (!c.parallel && Math.sqrt(c.distSq) <= PICK_PX.edge * pixelSizeAt(screenT(ray, c.p))) {
              primary = { ...primary, point: c.p };
              lines.length = 0;
              lines.push({ a: anchor, b: c.p, color: primary.color, dashed: false });
              secondary.push(fromPointSnap(fp.axis, c.p));
              lines.push({ a: fp.origin, b: c.p, color: AXIS_COLOR[fp.axis], dashed: true });
            }
          } else if (!DIRECTIONAL_KINDS.has(primary.kind)) {
            const r = this.resolveOnLine({ origin: fp.origin, dir: fromDir }, ray, ctx, null);
            primary = fromPointSnap(fp.axis, r.point);
            secondary.length = 0;
            this.pushVia(secondary, r.via, ctx);
            lines.length = 0;
            lines.push({ a: fp.origin, b: r.point, color: AXIS_COLOR[fp.axis], dashed: true });
            if (anchor) {
              const aligned = alignedAxis(anchor, r.point);
              if (aligned) {
                secondary.push(axisSnap(aligned, r.point));
                lines.push({ a: anchor, b: r.point, color: AXIS_COLOR[aligned], dashed: false });
              }
            }
          }
        }
      }
    }

    // ---- dashed extension line from the nearer end of the referenced edge
    const ext = primary.kind === 'extension' ? primary : secondary.find((s) => s.kind === 'extension');
    if (ext && this.refEdge) {
      const e = this.refEdge;
      const end = v3dist(ext.point, e.a) < v3dist(ext.point, e.b) ? e.a : e.b;
      lines.push({ a: end, b: ext.point, color: ext.color, dashed: true });
    }

    this.updateHover(primary, hit, cands);
    const plane = cands.surface?.plane ?? (lockSnap?.plane ?? freePlane);
    const fromLabels = secondary.filter((s) => s.kind === 'fromPoint').map((s) => s.label);
    const otherLabels = secondary.filter((s) => s.kind !== 'fromPoint').map((s) => s.label);
    const tooltip = [...fromLabels, primary.label, ...otherLabels].filter((l) => l.length > 0).join(' · ');
    return { point: primary.point, primary, secondary, lines, lockedAxis, tooltip, hit, plane };
  }

  // ------------------------------------------------------------------------------------------
  // Point snaps

  /** Priority: endpoint > intersection > midpoint > center > on edge > extension > on face > guide > origin. */
  private pointSnap(c: PickCandidates, input: InferenceInput, context: readonly Id[]): Snap | null {
    const { ray, pixelSizeAt } = input;
    const mark = (s: Snap): Snap => this.markContext(s, context);
    const v = c.vertices[0];
    if (v) return mark({ kind: 'endpoint', point: v.point, ref: v.ref, color: SNAP_COLORS.endpoint, label: 'Endpoint' });
    const x = this.intersectionSnap(c, input);
    if (x) return mark(x);
    for (const e of c.edges) {
      const mid = this.edgeMidpoint(e);
      if (screenDistance(ray, mid, pixelSizeAt) <= PICK_PX.vertex) {
        return mark({ kind: 'midpoint', point: mid, ref: e.ref, dir: e.dir, color: SNAP_COLORS.midpoint, label: 'Midpoint' });
      }
    }
    const ctr = c.centers[0];
    if (ctr) {
      return mark({ kind: 'center', point: ctr.point, ref: ctr.center.ref ?? undefined, color: SNAP_COLORS.center, label: 'Center' });
    }
    const e = c.edges[0];
    if (e) return mark({ kind: 'onEdge', point: e.point, ref: e.ref, dir: e.dir, color: SNAP_COLORS.onEdge, label: 'On Edge' });
    const ext = this.extensionSnap(ray, pixelSizeAt);
    if (ext) return mark(ext);
    const s = c.surface;
    if (s) return mark({ kind: 'onFace', point: s.point, ref: s.ref, plane: s.plane, color: SNAP_COLORS.onFace, label: 'On Face' });
    const g = c.guides[0];
    if (g) {
      return mark(
        g.dir
          ? { kind: 'guide', point: g.point, ref: g.ref, dir: g.dir, color: SNAP_COLORS.guide, label: 'On Line' }
          : { kind: 'guide', point: g.point, ref: g.ref, color: SNAP_COLORS.guide, label: 'Guide Point' },
      );
    }
    if (screenDistance(ray, [0, 0, 0], pixelSizeAt) <= PICK_PX.vertex) {
      return { kind: 'origin', point: [0, 0, 0], color: SNAP_COLORS.origin, label: 'Origin' };
    }
    return null;
  }

  /**
   * Snaps to entities of another group/component than the edit context turn magenta and get the
   * "in Group" / "in Component" suffix. The point stays in world space.
   */
  private markContext(snap: Snap, context: readonly Id[]): Snap {
    const ref = snap.ref;
    if (!ref || ref.kind === 'instance' || samePath(ref.path, context)) return snap;
    const owner = this.index.container(ref.path);
    const where = owner && !owner.isGroup && ref.path.length > 0 ? 'Component' : 'Group';
    return { ...snap, color: SNAP_COLORS.otherContext, label: snap.label ? `${snap.label} in ${where}` : snap.label, inOtherContext: true };
  }

  /**
   * Intersection (black ×): two edges/guides near the cursor whose 3D lines meet within
   * MERGE_TOL, with the crossing point within PICK_PX.vertex of the cursor. Edge × edge,
   * guide × edge and guide × guide; crossings at an endpoint are endpoints, not intersections.
   */
  private intersectionSnap(c: PickCandidates, input: InferenceInput): Snap | null {
    const { ray, pixelSizeAt } = input;
    const lines: IntersectLine[] = [];
    for (const e of c.edges) {
      const ext = this.edgeExtent(e);
      lines.push({ origin: ext.a, dir: e.dir, length: v3dist(ext.a, ext.b), ref: e.ref });
    }
    for (const g of c.guides) {
      const l = guideLine(g);
      if (l) lines.push(l);
    }
    if (lines.length < 2) return null;
    let best: { point: Vec3; screenDist: number; ref: EntityRef } | null = null;
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const a = lines[i]!, b = lines[j]!;
        if (entityRefKey(a.ref) === entityRefKey(b.ref)) continue;
        const x = lineLineClosest3D(a.origin, a.dir, b.origin, b.dir);
        if (x.parallel || Math.sqrt(x.distSq) > MERGE_TOL) continue;
        if (!within(x.t, a.length) || !within(x.s, b.length)) continue;
        if (atEnd(x.t, a.length) || atEnd(x.s, b.length)) continue;
        const point = v3lerp(x.p, x.q, 0.5);
        const screenDist = screenDistance(ray, point, pixelSizeAt);
        if (screenDist > PICK_PX.vertex) continue;
        if (!best || screenDist < best.screenDist) best = { point, screenDist, ref: a.ref };
      }
    }
    return best ? { kind: 'intersection', point: best.point, ref: best.ref, color: SNAP_COLORS.intersection, label: 'Intersection' } : null;
  }

  /**
   * "On Line": the cursor is within tolerance of the infinite line through the referenced edge
   * but beyond one of its ends. The point is the line's closest approach to the cursor ray.
   */
  private extensionSnap(ray: Ray, pixelSizeAt: (t: number) => number): Snap | null {
    const e = this.refEdge;
    if (!e) return null;
    const c = lineLineClosest3D(e.a, e.dir, ray.origin, ray.dir);
    if (c.parallel || c.s <= 0) return null;
    const px = pixelSizeAt(c.s);
    if (px <= 0 || Math.sqrt(c.distSq) / px > PICK_PX.edge) return null;
    const len = v3dist(e.a, e.b);
    if (c.t >= -MERGE_TOL && c.t <= len + MERGE_TOL) return null; // on the edge itself: "On Edge"
    return { kind: 'extension', point: c.p, ref: e.ref, dir: e.dir, color: SNAP_COLORS.extension, label: 'On Line' };
  }

  /** Midpoint of the whole edge (a body edge is a collinear polyline run; a sketch edge one segment). */
  private edgeMidpoint(e: EdgeCandidate): Vec3 {
    const ext = this.edgeExtent(e);
    return v3lerp(ext.a, ext.b, 0.5);
  }

  /** Full extent of the edge a candidate segment belongs to. */
  private edgeExtent(e: EdgeCandidate): { a: Vec3; b: Vec3 } {
    if (e.ref.kind === 'edge') {
      const rec = this.index.body(e.ref.id, e.ref.path)?.edges.get(e.ref.edgeKey);
      const first = rec?.polyline[0], last = rec?.polyline[rec.polyline.length - 1];
      if (first && last) return { a: first, b: last };
    }
    return { a: e.a, b: e.b };
  }

  // ------------------------------------------------------------------------------------------
  // Directional snaps (parallel / perpendicular / tangent)

  /** Candidate directions through the anchor: from the reference edge and from curve tangents. */
  private directions(anchor: Vec3, freePlane: Plane): DirCandidate[] {
    const out: DirCandidate[] = [];
    const e = this.refEdge;
    if (e) {
      out.push({ kind: 'parallel', dir: e.dir, ref: e.ref, label: 'Parallel to Edge', color: SNAP_COLORS.parallel });
      out.push({ kind: 'perpendicular', dir: perpendicularTo(e, anchor, freePlane), ref: e.ref, label: 'Perpendicular to Edge', color: SNAP_COLORS.perpendicular });
    }
    out.push(...this.tangentsAt(anchor));
    return out;
  }

  /** The candidate direction whose line through the anchor passes nearest the cursor (within PICK_PX.edge). */
  private nearestDirection(ray: Ray, anchor: Vec3, pixelSizeAt: (t: number) => number, freePlane: Plane): DirCandidate | null {
    let best: { d: DirCandidate; screenDist: number } | null = null;
    for (const d of this.directions(anchor, freePlane)) {
      const c = lineLineClosest3D(anchor, d.dir, ray.origin, ray.dir);
      if (c.parallel || c.s <= 0) continue;
      const px = pixelSizeAt(c.s);
      const screenDist = px > 0 ? Math.sqrt(c.distSq) / px : Infinity;
      if (screenDist <= PICK_PX.edge && (!best || screenDist < best.screenDist)) best = { d, screenDist };
    }
    return best?.d ?? null;
  }

  /**
   * "Tangent at Vertex" (cyan): when the anchor is an end vertex of an arc edge (sketch or body
   * edge with a `curveId`), the direction continues the arc's tangent past that vertex.
   */
  private tangentsAt(anchor: Vec3): DirCandidate[] {
    const generation = this.index.generation;
    const key = roundKey(anchor);
    if (this.tangentCache && this.tangentCache.key === key && this.tangentCache.generation === generation) return this.tangentCache.dirs;
    const dirs: DirCandidate[] = [];
    const push = (curve: Curve | undefined, vertex: Vec3, other: Vec3, ref: EntityRef): void => {
      if (!curve || curve.kind !== 'arc') return;
      const dir = arcTangent(curve, vertex, other);
      if (dir) dirs.push({ kind: 'tangent', dir, ref, label: 'Tangent at Vertex', color: SNAP_COLORS.tangent });
    };
    for (const sk of this.index.sketches()) {
      const curves = new Map<number, Curve>();
      for (const seg of sk.segments) {
        if (seg.ref.kind !== 'sketchEdge') continue;
        const e = sk.sketch.edges.get(seg.ref.id);
        if (!e || e.curveId === null) continue;
        let curve = curves.get(e.curveId);
        if (!curve) {
          const c = sk.sketch.curves.get(e.curveId);
          if (!c) continue;
          curve = this.worldCurve(c, sk.path);
          curves.set(e.curveId, curve);
        }
        if (v3dist(seg.a, anchor) <= MERGE_TOL) push(curve, seg.a, seg.b, seg.ref);
        else if (v3dist(seg.b, anchor) <= MERGE_TOL) push(curve, seg.b, seg.a, seg.ref);
      }
    }
    for (const b of this.index.bodies()) {
      for (const e of b.edges.values()) {
        if (e.record.curveId === null || e.polyline.length < 2) continue;
        const first = e.polyline[0]!, last = e.polyline[e.polyline.length - 1]!;
        const ref: EntityRef = { kind: 'edge', path: b.path, id: b.id, edgeKey: e.key };
        if (v3dist(first, anchor) <= MERGE_TOL) push(b.curves.get(e.record.curveId), first, e.polyline[1]!, ref);
        else if (v3dist(last, anchor) <= MERGE_TOL) push(b.curves.get(e.record.curveId), last, e.polyline[e.polyline.length - 2]!, ref);
      }
    }
    this.tangentCache = { key, generation, dirs };
    return dirs;
  }

  /** A sketch curve with world-space center / normal. */
  private worldCurve(c: Curve, path: readonly Id[]): Curve {
    if (path.length === 0) return c;
    const m = this.matrices(path).matrix;
    return { ...c, center: m4transformPoint(m, c.center), normal: v3normalize(m4transformDir(m, c.normal)) };
  }

  // ------------------------------------------------------------------------------------------
  // Line constraints

  /**
   * Resolve a line constraint: a strong point snap is projected onto the line; otherwise the line
   * is intersected with the hovered face plane or edge line ("pull to the height of that face"),
   * falling back to the point of the line nearest the cursor ray.
   */
  private resolveOnLine(line: LineConstraint, ray: Ray, ctx: Context, strong: Snap | null): { point: Vec3; via: Via } {
    const { origin, dir } = line;
    if (strong) return { point: v3addScaled(origin, dir, v3dot(v3sub(strong.point, origin), dir)), via: 'point' };
    if (ctx.surface) {
      const denom = v3dot(ctx.surface.plane.n, dir);
      // Match-height rule: intersect the line with the hovered plane, unless that plane already
      // passes through the line's origin (e.g. the face being pushed), which would pin the point.
      if (Math.abs(denom) > ANGLE_TOL && Math.abs(planeDistance(ctx.surface.plane, origin)) > COPLANAR_TOL) {
        const s = -planeDistance(ctx.surface.plane, origin) / denom;
        const p = v3addScaled(origin, dir, s);
        if (v3dot(v3sub(p, ray.origin), ray.dir) > 0) return { point: p, via: 'plane' };
      }
    }
    if (ctx.edge) {
      const c = lineLineClosest3D(origin, dir, ctx.edge.a, ctx.edge.dir);
      if (!c.parallel && Math.sqrt(c.distSq) <= MERGE_TOL * 10) return { point: c.p, via: 'edge' };
    }
    const c = lineLineClosest3D(origin, dir, ray.origin, ray.dir);
    if (c.parallel) return { point: origin, via: 'ray' };
    return { point: c.p, via: 'ray' };
  }

  private pushVia(secondary: Snap[], via: Via, ctx: Context): void {
    if (via === 'plane' && ctx.surface) {
      const s = ctx.surface;
      secondary.push(this.markContext({ kind: 'onFace', point: s.point, ref: s.ref, plane: s.plane, color: SNAP_COLORS.onFace, label: 'On Face' }, ctx.path));
    } else if (via === 'edge' && ctx.edge) {
      const e = ctx.edge;
      secondary.push(this.markContext({ kind: 'onEdge', point: e.point, ref: e.ref, dir: e.dir, color: SNAP_COLORS.onEdge, label: 'On Edge' }, ctx.path));
    }
  }

  /** Best (origin, axis) among the remembered points whose axis line passes the cursor. */
  private nearestFromPointLine(
    ray: Ray,
    anchor: Vec3 | null,
    pixelSizeAt: (t: number) => number,
  ): { origin: Vec3; axis: Axis; screenDist: number } | null {
    let best: { origin: Vec3; axis: Axis; screenDist: number } | null = null;
    for (const p of this.memory) {
      if (anchor && v3dist(p, anchor) <= MERGE_TOL) continue;
      const a = nearestAxisLine(ray, p, pixelSizeAt, PICK_PX.edge);
      if (a && (!best || a.screenDist < best.screenDist)) best = { origin: p, axis: a.axis, screenDist: a.screenDist };
    }
    return best;
  }

  // ------------------------------------------------------------------------------------------
  // Memory / hover tracking

  private updateHover(primary: Snap | null, hit: PickHit | null, cands: PickCandidates): void {
    const now = this.clock();
    if (primary && isStrong(primary)) {
      const key = `${primary.kind}|${primary.ref ? entityRefKey(primary.ref) : ''}|${roundKey(primary.point)}`;
      if (this.hover?.key === key) {
        if (!this.hover.pushed && now - this.hover.since >= this.hoverDelayMs) {
          this.rememberPoint(primary.point);
          this.hover.pushed = true;
        }
      } else this.hover = { key, since: now, pushed: false };
    } else this.hover = null;

    const edge = hit && (hit.ref.kind === 'edge' || hit.ref.kind === 'sketchEdge') ? (cands.edges[0] ?? null) : null;
    if (edge) {
      const key = entityRefKey(edge.ref);
      if (this.hoverEdge?.key === key) {
        if (now - this.hoverEdge.since >= this.hoverDelayMs) {
          const ext = this.edgeExtent(edge);
          this.refEdge = { ref: edge.ref, a: ext.a, b: ext.b, dir: edge.dir };
        }
      } else this.hoverEdge = { key, since: now };
    } else this.hoverEdge = null;
  }

  // ------------------------------------------------------------------------------------------

  /** Free point: the ray on the plane, or a fixed distance along the ray when it misses. */
  private freePoint(ray: Ray, plane: Plane): Vec3 {
    const t = rayPlane(ray, plane);
    return t === null ? rayAt(ray, this.freeDistance) : rayAt(ray, t);
  }
}

/** Factory mirroring the class constructor (for hosts that prefer functions). */
export function createInferenceEngine(opts: InferenceEngineOptions = {}): InferenceEngineImpl {
  return new InferenceEngineImpl(opts);
}

// ---------------------------------------------------------------------------------------------
// Helpers

function axisSnap(axis: Axis, point: Vec3): Snap {
  return { kind: 'onAxis', point, dir: AXIS_DIR[axis], axis, color: AXIS_COLOR[axis], label: AXIS_LABEL[axis] };
}

function fromPointSnap(axis: Axis, point: Vec3): Snap {
  return { kind: 'fromPoint', point, dir: AXIS_DIR[axis], axis, color: AXIS_COLOR[axis], label: 'From Point' };
}

/** Ray parameter of the closest approach to p (clamped to the ray). */
function screenT(ray: Ray, p: Vec3): number {
  return Math.max(0, v3dot(v3sub(p, ray.origin), ray.dir));
}

/** Screen distance (px) between the ray and a world point; Infinity for points behind the camera. */
export function screenDistance(ray: Ray, p: Vec3, pixelSizeAt: (t: number) => number): number {
  const t = v3dot(v3sub(p, ray.origin), ray.dir);
  if (t < 0) return Infinity;
  const px = pixelSizeAt(t);
  const d = v3dist(rayAt(ray, t), p);
  return px > 0 ? d / px : d === 0 ? 0 : Infinity;
}

/** The axis line through `origin` nearest the cursor within `tolPx`, or null. */
function nearestAxisLine(
  ray: Ray,
  origin: Vec3,
  pixelSizeAt: (t: number) => number,
  tolPx: number,
): { axis: Axis; screenDist: number } | null {
  let best: { axis: Axis; screenDist: number } | null = null;
  for (const axis of AXES) {
    const c = lineLineClosest3D(origin, AXIS_DIR[axis], ray.origin, ray.dir);
    if (c.parallel || c.s < 0) continue;
    const px = pixelSizeAt(c.s);
    const screenDist = px > 0 ? Math.sqrt(c.distSq) / px : Infinity;
    if (screenDist <= tolPx && (!best || screenDist < best.screenDist)) best = { axis, screenDist };
  }
  return best;
}

/** Axis along which `p` lies from `anchor` (exactly, within MERGE_TOL), or null. */
function alignedAxis(anchor: Vec3, p: Vec3): Axis | null {
  const d = v3sub(p, anchor);
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len <= MERGE_TOL) return null;
  for (const axis of AXES) {
    const a = AXIS_DIR[axis];
    const off = v3addScaled(d, a, -v3dot(d, a));
    if (Math.hypot(off[0], off[1], off[2]) <= MERGE_TOL) return axis;
  }
  return null;
}

/**
 * Perpendicular to the reference edge through the anchor: the foot-of-perpendicular direction
 * when the anchor is off the edge line, else the perpendicular lying in the drawing plane.
 */
export function perpendicularTo(edge: { a: Vec3; dir: Vec3 }, anchor: Vec3, plane: Plane): Vec3 {
  const foot = v3addScaled(edge.a, edge.dir, v3dot(v3sub(anchor, edge.a), edge.dir));
  const off = v3sub(anchor, foot);
  if (v3len(off) > MERGE_TOL) return v3normalize(off);
  const inPlane = v3cross(edge.dir, plane.n);
  if (v3len(inPlane) > ANGLE_TOL) return v3normalize(inPlane);
  return v3normalize(v3anyPerpendicular(edge.dir));
}

/** Tangent of an arc at `vertex`, oriented away from `other` (the edge's far end). */
export function arcTangent(curve: Curve, vertex: Vec3, other: Vec3): Vec3 | null {
  const r = v3sub(vertex, curve.center);
  const t = v3cross(curve.normal, r);
  if (v3len(t) <= MERGE_TOL) return null;
  const dir = v3normalize(t);
  return v3dot(dir, v3sub(vertex, other)) < 0 ? [0 - dir[0], 0 - dir[1], 0 - dir[2]] : dir;
}

function guideLine(g: GuideCandidate): IntersectLine | null {
  const guide = g.guide;
  switch (guide.kind) {
    case 'line':
      return { origin: guide.origin, dir: v3normalize(guide.dir), length: Infinity, ref: g.ref };
    case 'segment':
      return { origin: guide.origin, dir: v3normalize(v3sub(guide.end, guide.origin)), length: v3dist(guide.origin, guide.end), ref: g.ref };
    default:
      return null;
  }
}

/** Parameter `t` (distance along a unit direction) lies on a line of `length` (Infinity = full line). */
function within(t: number, length: number): boolean {
  if (!Number.isFinite(length)) return true;
  return t >= -MERGE_TOL && t <= length + MERGE_TOL;
}
function atEnd(t: number, length: number): boolean {
  if (!Number.isFinite(length)) return false;
  return Math.abs(t) <= MERGE_TOL || Math.abs(t - length) <= MERGE_TOL;
}

function roundKey(p: Vec3): string {
  const r = (x: number): number => Math.round(x / MERGE_TOL);
  return `${r(p[0])},${r(p[1])},${r(p[2])}`;
}
