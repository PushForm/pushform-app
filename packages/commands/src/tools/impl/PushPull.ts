// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MeshData, Ray, Vec2, Vec3 } from '@pushform/core';
import {
  basisToLocal,
  basisToWorld,
  COPLANAR_TOL,
  formatLength,
  planeBasis,
  PUSH_PULL_MATCH_HEIGHT_ANGLE,
  PushFormError,
  v3addScaled,
  v3dot,
  v3sub,
} from '@pushform/core';
import type { PushPullMode, PushPullPreview, PushPullResult } from '@pushform/kernel';
import type { InferenceOptions, InferenceResult, PickHit, Snap } from '@pushform/inference';
import { SNAP_COLORS } from '@pushform/inference';
import type { DocumentState, EntityContainer, EntityRef } from '@pushform/model';
import { computeRegions, containerAt, regionAt, sketchFaceLoops, surfaceFaceIds } from '@pushform/model';
import { pointInPolygon } from '@pushform/geom';
import type { MMat4 } from '@pushform/core';
import { DocumentHost } from '../../host/DocumentHost';
import { hostOf, kernelOf, SERVICE_DOCUMENT } from '../../host/services';
import { contextFrame, samePath } from '../../commands/context';
import { sketchSurfaceFaceIds } from '../../commands/sketchQueries';
import {
  planPushPull,
  PUSH_PULL_MESSAGES,
  runPushPullKernel,
  runPushPullPreview,
  type PushPullApplyParams,
  type PushPullPlan,
  type PushPullTarget,
} from '../../commands/pushpull';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolSettingValue, ToolStatus } from '../Tool';
import { toggleSetting } from '../settings';
import { pointerField } from '../entry';

/** Pointer travel (CSS px) that turns a press into a drag-release gesture. */
const DRAG_PX = 4;
/** Minimum spacing between real kernel previews while dragging. */
const PREVIEW_INTERVAL_MS = 80;
/** How long the distance must hold still before the drag asks for a full kernel result. */
export const PREVIEW_PAUSE_MS = 200;
/** A hovered face matches its height only when it is this close to parallel with the pulled face. */
const MATCH_HEIGHT_MIN_COS = Math.cos(PUSH_PULL_MATCH_HEIGHT_ANGLE);
/** Point snaps: on the way, they win over a matched height. */
const POINT_SNAPS: ReadonlySet<Snap['kind']> = new Set(['endpoint', 'midpoint', 'center', 'intersection', 'origin']);
/** Status when a distance is typed with no face to apply it to. */
const POINT_TO_FACE = 'Point to a face, then type the distance.';

const HOVER_COLOR = '#2d5bd1';
const GHOST_FACE_COLOR = '#2d5bd1';
const GHOST_EDGE_COLOR = '#1a1a1a';

interface Target {
  /** Plain-number ref accepted by `pushpull.apply` (its `path` is the edit context). */
  readonly ref: PushPullTarget;
  /** Identity of the geometry being edited (ref + body version) for preview/commit matching. */
  readonly key: string;
  /** World-space unit normal of the face. */
  readonly normal: Vec3;
  /** Region loops in world space: outer first, then holes. */
  readonly loops: readonly (readonly Vec3[])[];
  /** Body replaced by the preview in `merge` mode (null for sketch faces). */
  readonly bodyId: number | null;
  /** local → world matrix of the face's container (identity at the root). */
  readonly matrix: MMat4;
  /** Why the face cannot be pushed or pulled (a face of a smooth surface), else null. */
  readonly refusal: string | null;
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'hover'; readonly target: Target }
  | {
      readonly kind: 'dragging';
      readonly target: Target;
      readonly base: Vec3;
      readonly downScreen: Vec2;
      /**
       * Where the pointer was along the pull line at the press. Zero when the press was on the face;
       * a press elsewhere (a preselected face) moves the face by how far the pointer moves from there.
       */
      readonly offset: number;
      /** Button still held since the press that started the drag. */
      pressed: boolean;
      /** Pointer travelled more than DRAG_PX since the press. */
      moved: boolean;
      distance: number;
    };

/** What a preview was asked to show. */
interface PreviewRequest {
  readonly key: string;
  readonly distance: number;
  readonly mode: PushPullMode;
  readonly quality: 'cheap' | 'full';
}

interface PreviewBase extends PreviewRequest {
  /** One per resulting solid for a full result; a cheap preview draws all of them as one mesh. */
  readonly meshes: readonly MeshData[];
  readonly replacesBodyId: number | null;
  /** The body or sketch the result was computed against (its identity changes with every edit). */
  readonly source: unknown;
}

/** Drawn while the pointer moves. It has no kernel result, so it cannot be committed. */
interface CheapPreview extends PreviewBase {
  readonly quality: 'cheap';
}

/** Computed once the pointer pauses: a kernel result a commit may reuse. */
interface FullPreview extends PreviewBase {
  readonly quality: 'full';
  readonly result: PushPullResult;
}

type Preview = CheapPreview | FullPreview;

interface LastCommit {
  params: PushPullApplyParams;
  /** The apply command finished successfully (the VCB may re-edit it). */
  applied: boolean;
  /** Its undo entry, once applied: a redo replaces it only while it is the top entry. */
  entry: unknown;
}

const IDLE: State = { kind: 'idle' };

/**
 * Push/Pull (P). Hover highlights the face/region under the cursor; press (or click) on it to
 * start, move along the face normal, release after a drag or click again to commit. With one face
 * selected when the tool is chosen, the next press anywhere pulls that face. Double-click repeats
 * the last distance; a typed length applies during the drag, re-edits the last commit (undo +
 * re-apply, one undo entry) or pulls the hovered face. A Ctrl/Alt tap toggles `newBody`. Esc cancels.
 *
 * Drag feedback is a transient prism in the overlay plus a debounced real kernel preview exposed
 * through `previewMeshes` / `previewReplacesBodyId` for the renderer (see those getters). The
 * preview is cheap while the distance changes; once it holds still for `PREVIEW_PAUSE_MS` it is
 * replaced by a full result, which is what a release can commit without running the kernel again.
 */
export class PushPullTool implements Tool {
  readonly id = 'pushpull';
  readonly title = 'Push/Pull';
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['length'];

  private ctx: ToolContext | null = null;
  private state: State = IDLE;
  private mode: PushPullMode = 'merge';
  /** The one face selected when the tool was chosen: the next press pulls it. */
  private preselected: Target | null = null;
  private lastDistance: number | null = null;
  private lastCommit: LastCommit | null = null;
  private lastError: string | null = null;
  /** Serializes commits and VCB re-applies (each awaits the kernel). */
  private queue: Promise<void> = Promise.resolve();
  private preview: Preview | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPreviewAt = 0;
  /** Armed while waiting for the distance to hold still. */
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  /** The kernel preview asked for most recently, until it settles. */
  private requested: PreviewRequest | null = null;
  /** Settles with the kernel preview asked for most recently. */
  private previewSettled: Promise<void> = Promise.resolve();

  // --- renderer contract ----------------------------------------------------------------------

  /**
   * Real kernel preview of the drag, for the renderer (`tool.previewMeshes`). Non-empty only while
   * dragging and only when the latest preview result still matches the current target, distance
   * and mode; otherwise the overlay ghost is all there is. Meshes are `MeshData` in the
   * coordinates of the edited container (one per resulting solid for a full result, one in all for
   * a cheap one); `previewMatrix` maps them to world. In `merge` mode they replace the body `previewReplacesBodyId`, which the renderer
   * should hide while drawing them; for `newBody` and sketch-face pulls they are additional
   * solids and `previewReplacesBodyId` is null.
   */
  get previewMeshes(): readonly MeshData[] {
    return this.currentPreview()?.meshes ?? [];
  }

  /** local → world matrix for `previewMeshes` (the edit context's matrix; identity at the root). */
  get previewMatrix(): MMat4 {
    const s = this.state;
    return s.kind === 'dragging' ? s.target.matrix : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  /** Body id hidden while `previewMeshes` is drawn (merge mode), else null. */
  get previewReplacesBodyId(): number | null {
    return this.currentPreview()?.replacesBodyId ?? null;
  }

  /** Current mode: `newBody` after Ctrl/Alt toggle ("keep starting face"). */
  get pushPullMode(): PushPullMode {
    return this.mode;
  }

  /** Signed distance of the current drag, or null when not dragging. */
  get dragDistance(): number | null {
    return this.state.kind === 'dragging' ? this.state.distance : null;
  }

  /** Resolves when every queued commit / re-apply has settled (tests). */
  get settled(): Promise<void> {
    return this.queue;
  }

  // --- lifecycle ------------------------------------------------------------------------------

  /** Only a pull under way is an operation in progress; hovering a face is not. */
  hasPendingWork(): boolean {
    return this.state.kind === 'dragging';
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.state = IDLE;
    // New body is a mode toggle: off each time the tool is chosen.
    this.mode = 'merge';
    this.lastCommit = null;
    this.lastError = null;
    this.preselected = this.selectedFace();
  }

  deactivate(): void {
    this.clearPreview();
    this.state = IDLE;
    this.lastCommit = null;
    this.preselected = null;
    this.ctx = null;
  }

  suspend(): void {
    // Keep the drag alive across a middle-button orbit; just stop previewing until it resumes.
    this.cancelPreviewTimer();
  }

  resume(): void {
    this.schedulePreview();
    this.armPause();
  }

  inferenceOptions(): InferenceOptions {
    if (this.state.kind === 'dragging') {
      const { base, target } = this.state;
      return {
        anchor: base,
        // The face being pushed must not be hovered: its plane contains the base point.
        ignore: [target.ref as unknown as EntityRef],
        // Constrain the cursor to the line through the base point along the face normal.
        lockSnap: {
          kind: 'perpendicular',
          point: base,
          dir: target.normal,
          color: SNAP_COLORS.perpendicular,
          label: 'Perpendicular to Face',
        },
      };
    }
    return { kinds: ['face', 'sketchFace'], pickOnly: true };
  }

  // --- pointer --------------------------------------------------------------------------------

  onPointerMove(e: ToolPointerEvent): void {
    if (this.state.kind === 'dragging') {
      const s = this.state;
      if (!s.moved && screenDist(e.screen, s.downScreen) > DRAG_PX) s.moved = true;
      const distance = this.distanceFor(e, s);
      if (distance !== s.distance) this.armPause();
      s.distance = distance;
      this.schedulePreview();
      this.ctx?.requestRender();
      return;
    }
    this.hover(e.inference?.hit ?? null);
  }

  onPointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    if (this.state.kind === 'dragging') {
      const s = this.state;
      if (s.pressed) return;
      // Second click of click-move-click. A click that never moved (first half of a double-click) is a no-op.
      if (!s.moved && screenDist(e.screen, s.downScreen) <= DRAG_PX) {
        this.endDrag();
        this.hover(e.inference?.hit ?? null);
        return;
      }
      this.commit(s.target, this.distanceFor(e, s));
      return;
    }
    const hit = e.inference?.hit ?? null;
    const hovered = this.resolveTarget(hit);
    const pre = this.preselected;
    this.preselected = null;
    this.lastCommit = null;
    this.lastError = null;
    if (pre && !(hovered && hit && sameFace(hovered.ref, pre.ref))) {
      // The selected face is pulled from a press anywhere: by how far the pointer moves along its line.
      const base = loopCentroid(pre.loops[0] ?? []);
      const offset = closestParamOnLine(base, pre.normal, e.ray);
      this.state = { kind: 'dragging', target: pre, base, offset, downScreen: e.screen, pressed: true, moved: false, distance: 0 };
      this.ctx?.statusChanged();
      return;
    }
    if (!hovered || !hit) {
      this.state = IDLE;
      this.ctx?.statusChanged();
      return;
    }
    if (hovered.refusal) {
      this.lastError = hovered.refusal;
      this.ctx?.statusChanged();
      return;
    }
    this.state = { kind: 'dragging', target: hovered, base: hit.point, offset: 0, downScreen: e.screen, pressed: true, moved: false, distance: 0 };
    this.ctx?.statusChanged();
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0 || this.state.kind !== 'dragging' || !this.state.pressed) return;
    const s = this.state;
    s.pressed = false;
    if (!s.moved && screenDist(e.screen, s.downScreen) <= DRAG_PX) return; // click-move-click continues
    this.commit(s.target, this.distanceFor(e, s));
  }

  /** Repeat the last distance on the face under the pointer: out after a pull out, in after a push in, along its front. */
  onDoubleClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || this.lastDistance === null) return;
    if (this.state.kind === 'dragging') this.endDrag();
    const target = this.resolveTarget(e.inference?.hit ?? null);
    if (!target) return;
    if (target.refusal) {
      this.lastError = target.refusal;
      this.ctx?.statusChanged();
      return;
    }
    this.state = { kind: 'hover', target };
    this.commit(target, this.lastDistance);
  }

  // --- keys / VCB -----------------------------------------------------------------------------

  onKeyDown(e: ToolKeyEvent): boolean {
    if (e.repeat) return false;
    if (e.key === 'Control') {
      this.setMode(this.mode === 'merge' ? 'newBody' : 'merge');
      return true;
    }
    return false;
  }

  onVcb(v: VcbValue): void {
    if (v.kind !== 'length') return;
    const s = this.state;
    if (s.kind === 'dragging') {
      // A loose face takes the distance in the direction it is being pulled; a solid's face along its front.
      this.commit(s.target, isLoose(s.target.ref) ? (s.distance !== 0 ? Math.sign(s.distance) : this.viewerSide(s.target)) * v.meters : v.meters);
      return;
    }
    const last = this.lastCommit;
    if (last && this.redoable(last)) {
      // Just after a pull: redo it at the new distance, the same way it went (a negative one goes the other way).
      if (Math.abs(v.meters) <= COPLANAR_TOL) return;
      this.redoLast(last, (p) => ({ ...p, distance: (Math.sign(p.distance) || 1) * v.meters }));
      this.ctx?.statusChanged();
      return;
    }
    // Nothing in progress: pull the face the pointer is on.
    const target = this.pointedTarget();
    if (!target) {
      this.lastError = POINT_TO_FACE;
      this.ctx?.statusChanged();
      return;
    }
    if (target.refusal) {
      this.lastError = target.refusal;
      this.ctx?.statusChanged();
      return;
    }
    this.preselected = null;
    this.commit(target, isLoose(target.ref) ? this.viewerSide(target) * v.meters : v.meters);
  }

  /** The bar switched New body just after a pull: redo that pull in the new mode, as one undo step. */
  adjustLast(id: string, value: ToolSettingValue): boolean {
    const last = this.lastCommit;
    if (id !== 'newBody' || !last) return false;
    const mode: PushPullMode = typeof value === 'boolean' ? (value ? 'newBody' : 'merge') : this.mode;
    if (mode === last.params.mode) return true;
    const redone = this.redoLast(last, (p) => ({ ...p, mode }));
    this.ctx?.statusChanged();
    return redone;
  }

  onCancel(): void {
    if (this.state.kind === 'dragging') {
      this.endDrag();
      return;
    }
    this.lastCommit = null;
    this.lastError = null;
    this.preselected = null;
    this.state = IDLE;
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  // --- overlay / status -----------------------------------------------------------------------

  overlay(): readonly OverlayPrimitive[] {
    const s = this.state;
    if (s.kind === 'dragging') {
      if (Math.abs(s.distance) <= COPLANAR_TOL) return highlight(s.target.loops);
      return ghostPrism(s.target.loops, s.target.normal, s.distance);
    }
    const target = this.pointedTarget();
    return target && !target.refusal ? highlight(target.loops) : [];
  }

  status(): ToolStatus {
    return { ...this.baseStatus(), settings: [toggleSetting('newBody', 'New body', this.mode === 'newBody', 'primary')] };
  }

  onSetting(id: string, value: ToolSettingValue): void {
    if (id !== 'newBody' || typeof value !== 'boolean') return;
    this.setMode(value ? 'newBody' : 'merge');
  }

  private setMode(mode: PushPullMode): void {
    this.mode = mode;
    // A pull under way is previewed again in the new mode.
    this.clearPreview();
    this.schedulePreview();
    this.armPause();
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  private baseStatus(): ToolStatus {
    const s = this.state;
    const doc = this.ctx?.commands.ctx.services.get(SERVICE_DOCUMENT);
    const units = doc instanceof DocumentHost ? doc.doc.state.meta.units : null;
    const fmt = (d: number): string => (units ? formatLength(d, units) : d.toString());
    if (s.kind === 'dragging') {
      // A loose face has no inside: its distance is how far it is pulled, whichever way. A solid's face is signed along its front.
      const shown = isLoose(s.target.ref) ? Math.abs(s.distance) : s.distance;
      return { instructor: `Click or type distance.`, vcbLabel: 'Distance', vcbValue: fmt(shown), fields: [pointerField('Distance', 'length', fmt(shown))] };
    }
    const pointed = this.pointedTarget();
    const instructor = this.lastError
      ?? pointed?.refusal
      ?? (this.preselected ? 'Click anywhere to pull the selected face, or type a distance.' : `Select face to push or pull.`);
    const last = this.lastCommit ? (isLoose(this.lastCommit.params.target) ? Math.abs(this.lastCommit.params.distance) : this.lastCommit.params.distance) : this.lastDistance;
    return { instructor, vcbLabel: 'Distance', vcbValue: last === null ? undefined : fmt(last) };
  }

  // --- internals ------------------------------------------------------------------------------

  /** The face a typed distance or the highlight applies to: the preselected face, else the hovered one. */
  private pointedTarget(): Target | null {
    if (this.preselected) return this.preselected;
    return this.state.kind === 'hover' ? this.state.target : null;
  }

  /** +1 when the face's front looks toward the camera, else -1: the side a loose face is pulled to before the pointer moves. */
  private viewerSide(target: Target): number {
    const cam = this.ctx?.camera.getState();
    if (!cam) return 1;
    return v3dot(target.normal, v3sub(cam.eye, cam.target)) < 0 ? -1 : 1;
  }

  private hover(hit: PickHit | null): void {
    const target = this.resolveTarget(hit);
    const prevKey = this.state.kind === 'hover' ? this.state.target.key : null;
    this.state = target ? { kind: 'hover', target } : IDLE;
    if ((target?.key ?? null) !== prevKey) {
      this.ctx?.requestRender();
      this.ctx?.statusChanged();
    }
  }

  private endDrag(): void {
    this.clearPreview();
    this.state = IDLE;
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  /** The face to pull from the next press: exactly one face selected in the open context, if it can be pulled. */
  private selectedFace(): Target | null {
    if (!this.ctx) return null;
    const host = hostOf(this.ctx.commands.ctx);
    const refs = host.selection.refs;
    if (refs.length !== 1) return null;
    const ref = refs[0]!;
    if (ref.kind !== 'face' && ref.kind !== 'sketchFace') return null;
    const target = this.resolveRef(ref, null);
    return target && !target.refusal ? target : null;
  }

  /** Resolve the geometry under the cursor into a target (world normal and loops) using the current document state. */
  private resolveTarget(hit: PickHit | null): Target | null {
    return hit ? this.resolveRef(hit.ref, hit.point) : null;
  }

  /** Resolve a face ref into a target; `point` (world) picks the region of a divided face when the ref names none. */
  private resolveRef(ref: EntityRef, point: Vec3 | null): Target | null {
    if (!this.ctx) return null;
    const host = hostOf(this.ctx.commands.ctx);
    if (!samePath(ref.path, host.context.path)) return null; // only the open context is editable
    const state: DocumentState = host.doc.state;
    let container: EntityContainer;
    try {
      container = containerAt(state, ref.path);
    } catch {
      return null;
    }
    const frame = contextFrame(state, ref.path);
    const path = [...ref.path] as number[];
    const toWorld = (loops: readonly (readonly Vec3[])[]): Vec3[][] => loops.map((l) => l.map((p) => frame.toWorld(p)));
    if (ref.kind === 'sketchFace') {
      const face = container.sketch.faces.get(ref.id);
      if (!face) return null;
      return {
        ref: { kind: 'sketchFace', path, id: ref.id },
        key: `${path.join('.')}/sketchFace/${ref.id}`,
        normal: frame.toWorldNormal(face.plane.n),
        loops: toWorld(sketchFaceLoops(container.sketch, face)),
        bodyId: null,
        matrix: frame.matrix,
        refusal: sketchSurfaceFaceIds(container.sketch, face.id).length > 1 ? PUSH_PULL_MESSAGES.smooth : null,
      };
    }
    if (ref.kind !== 'face') return null;
    const body = container.bodies.get(ref.id);
    const face = body?.faces.get(ref.faceId);
    if (!body || !face) return null;
    const regions = computeRegions(body, ref.faceId);
    let index = ref.region ?? -1;
    if (index < 0 && regions.length > 1 && point) {
      const l = basisToLocal(face.basis, frame.toLocal(point));
      index = regionAt(regions, [l[0], l[1]]);
    }
    if (index < 0) index = 0;
    const region = regions[index];
    if (!region) return null;
    const loops = region.wholeFace
      ? face.loops
      : region.polygon.map((ring) => ring.map((p) => basisToWorld(face.basis, p[0] ?? 0, p[1] ?? 0)));
    return {
      ref: { kind: 'face', path, id: ref.id, faceId: ref.faceId, region: index },
      key: `${path.join('.')}/face/${ref.id}/${ref.faceId}/${index}@${body.version}`,
      normal: frame.toWorldNormal(face.plane.n),
      loops: toWorld(loops),
      bodyId: body.id,
      matrix: frame.matrix,
      refusal: surfaceFaceIds(body, ref.faceId).length > 1 ? PUSH_PULL_MESSAGES.smooth : null,
    };
  }

  /**
   * Signed distance along the normal for a pointer event. A point snap on the way sets it exactly;
   * otherwise a hovered face nearly parallel to the pulled one (other than the pulled face itself,
   * and not one seen through it) sets the height where the pull line crosses its plane ("match
   * height"); otherwise the pointer is followed along the pull line.
   */
  private distanceFor(e: ToolPointerEvent, s: Extract<State, { kind: 'dragging' }>): number {
    const { target, base } = s;
    const along = (p: Vec3): number => v3dot(v3sub(p, base), target.normal);
    const inf = e.inference;
    if (!inf) return closestParamOnLine(base, target.normal, e.ray) - s.offset;
    if (POINT_SNAPS.has(inf.primary.kind) || inf.secondary.some((snap) => POINT_SNAPS.has(snap.kind) || (snap.kind === 'guide' && !snap.dir))) {
      return along(inf.point);
    }
    const matched = matchHeight(inf, e.ray, target, base);
    if (matched !== null) return matched;
    // The point was put on a hovered face that does not set the height: follow the pointer instead.
    if (inf.secondary.some((snap) => snap.kind === 'onFace')) return closestParamOnLine(base, target.normal, e.ray) - s.offset;
    // Crossing an edge sets the point exactly.
    if (inf.secondary.some((snap) => snap.kind === 'onEdge')) return along(inf.point);
    return along(inf.point) - s.offset;
  }

  private commit(target: Target, distance: number): void {
    if (!this.ctx) return;
    if (!Number.isFinite(distance) || Math.abs(distance) <= COPLANAR_TOL) {
      this.endDrag();
      return;
    }
    const mode = this.mode;
    const params: PushPullApplyParams = { target: target.ref, distance, mode };
    // Only a full result can be committed; after a cheap preview the kernel runs in full.
    const pre = this.preview;
    const preview = pre?.quality === 'full' && pre.key === target.key && pre.distance === distance && pre.mode === mode ? pre : null;
    const last: LastCommit = { params, applied: false, entry: null };
    this.lastCommit = last;
    this.lastError = null;
    this.clearPreview();
    this.state = IDLE;
    const ctx = this.ctx;
    this.enqueue(async () => {
      const host = hostOf(ctx.commands.ctx);
      try {
        await ctx.commands.execute('pushpull.apply', { ...params, ...reusablePreview(host.doc.state, params, preview) });
      } catch (err) {
        if (this.lastCommit === last) this.lastCommit = null;
        throw err;
      }
      last.applied = true;
      last.entry = host.undoStack.peek();
      this.lastDistance = distance;
      if (this.ctx === ctx) ctx.committed?.();
      ctx.statusChanged();
    });
    ctx.statusChanged();
    ctx.requestRender();
  }

  /** The last pull can still be redone: it is queued, or its undo entry is the last change. */
  private redoable(last: LastCommit): boolean {
    if (!this.ctx || this.lastCommit !== last) return false;
    if (!last.applied) return true;
    return hostOf(this.ctx.commands.ctx).undoStack.peek() === last.entry;
  }

  /**
   * Undo the last pull and apply it again with `next(params)` (one undo entry). The original stays,
   * and the shown and double-click distances keep their values, when the redo is skipped or fails.
   * False when the last pull can no longer be redone.
   */
  private redoLast(last: LastCommit, next: (p: PushPullApplyParams) => PushPullApplyParams): boolean {
    if (!this.redoable(last) || !this.ctx) return false;
    const ctx = this.ctx;
    this.enqueue(async () => {
      if (this.lastCommit !== last || !last.applied) return;
      const host = hostOf(ctx.commands.ctx);
      // Only re-edit while our commit is still the last thing that happened to the document.
      if (host.undoStack.peek() !== last.entry || !host.undo()) return;
      const params = next(last.params);
      try {
        await ctx.commands.execute('pushpull.apply', params);
      } catch (err) {
        host.redo();
        throw err;
      }
      last.params = params;
      last.entry = host.undoStack.peek();
      this.lastDistance = params.distance;
      if (this.ctx === ctx) ctx.committed?.();
      ctx.statusChanged();
    });
    return true;
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err: unknown) => {
      this.lastError = userMessage(err);
      this.ctx?.statusChanged();
    });
  }

  // --- real preview ---------------------------------------------------------------------------

  private currentPreview(): Preview | null {
    const p = this.preview;
    const s = this.state;
    if (!p || s.kind !== 'dragging') return null;
    return p.key === s.target.key && p.distance === s.distance && p.mode === this.mode ? p : null;
  }

  private schedulePreview(): void {
    if (this.state.kind !== 'dragging' || this.previewTimer !== null) return;
    const delay = Math.max(0, PREVIEW_INTERVAL_MS - (Date.now() - this.lastPreviewAt));
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      this.lastPreviewAt = Date.now();
      this.previewSettled = this.runPreview('cheap');
    }, delay);
  }

  /**
   * Ask for a full result once the distance has held still. A cheap preview still on its way is
   * let finish first: asking now would supersede it, and the pointer would wait for the slower run
   * with nothing new on screen.
   */
  private armPause(): void {
    this.cancelPauseTimer();
    if (this.state.kind !== 'dragging') return;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      void this.previewSettled.then(() => {
        if (this.pauseTimer !== timer) return; // the distance changed or the drag ended meanwhile
        this.pauseTimer = null;
        this.previewSettled = this.runPreview('full');
      });
    }, PREVIEW_PAUSE_MS);
    this.pauseTimer = timer;
  }

  private async runPreview(quality: PreviewRequest['quality']): Promise<void> {
    const s = this.state;
    const ctx = this.ctx;
    if (!ctx || s.kind !== 'dragging' || Math.abs(s.distance) <= COPLANAR_TOL) return;
    const { target, distance } = s;
    const mode = this.mode;
    const covers = (p: PreviewRequest | null): boolean =>
      p !== null && p.key === target.key && p.distance === distance && p.mode === mode && (p.quality === 'full' || quality === 'cheap');
    // A request for something already shown, or already on its way, would only supersede it.
    if (covers(this.preview) || covers(this.requested)) return;
    const requested: PreviewRequest = { key: target.key, distance, mode, quality };
    this.requested = requested;
    const host = hostOf(ctx.commands.ctx);
    const kernel = kernelOf(ctx.commands.ctx);
    try {
      const plan = planPushPull(host.doc.state, target.ref, distance, mode);
      // A sketch face has no solid to reprocess, so its full result is as cheap and is reusable.
      const r = await kernel.coalesced<PushPullResult | PushPullPreview>('pushpull-preview', () =>
        plan.kind === 'body' && quality === 'cheap' ? runPushPullPreview(kernel, plan) : runPushPullKernel(kernel, plan),
      );
      // A result for a drag that has ended must not linger for the next one.
      if (r.status !== 'current' || this.state !== s) return;
      const base = { key: target.key, distance, mode, replacesBodyId: mode === 'merge' ? target.bodyId : null, source: planSource(plan) };
      if ('preview' in r.value) {
        // A push that would leave nothing is refused when it ends; until then the ghost shows it.
        if (r.value.mesh.tris.length === 0) return;
        this.preview = { ...base, quality: 'cheap', meshes: [r.value.mesh] };
      } else {
        if (r.value.components.length === 0) return;
        this.preview = { ...base, quality: 'full', meshes: r.value.components.map((c) => c.mesh), result: r.value };
      }
      if (this.currentPreview()) ctx.requestRender();
    } catch {
      // A failed preview is not an error the user needs to see; the ghost stays.
    } finally {
      if (this.requested === requested) this.requested = null;
    }
  }

  private cancelPreviewTimer(): void {
    if (this.previewTimer !== null) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.cancelPauseTimer();
  }

  private cancelPauseTimer(): void {
    if (this.pauseTimer !== null) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
  }

  private clearPreview(): void {
    this.cancelPreviewTimer();
    this.preview = null;
    this.requested = null;
  }
}

// ---------------------------------------------------------------------------------------------
// helpers

function screenDist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Same face (any region of it), as an entity ref or a push/pull target. */
function sameFace(a: EntityRef | PushPullTarget, b: PushPullTarget): boolean {
  if (a.kind !== b.kind || a.id !== b.id || !samePath(a.path, b.path)) return false;
  return a.kind !== 'face' || b.kind !== 'face' || a.faceId === b.faceId;
}

function loopCentroid(loop: readonly Vec3[]): Vec3 {
  const c: [number, number, number] = [0, 0, 0];
  for (const p of loop) for (let i = 0; i < 3; i++) c[i]! += p[i]! / loop.length;
  return c;
}

/**
 * The height a hovered face sets for the pull (along its normal from `base`), or null when it sets
 * none: the face is the pulled one, is more than 30° from parallel to it, is a solid's face seen
 * from behind, or is seen through the pulled face.
 */
function matchHeight(inf: InferenceResult, ray: Ray, target: Target, base: Vec3): number | null {
  // The engine reports the face whose plane it put the point on; a hand-made pick only has the hit.
  const onFace = inf.secondary.find((snap) => snap.kind === 'onFace' && snap.plane && snap.ref);
  const hit = inf.hit;
  const surface = onFace?.ref && onFace.plane
    ? { ref: onFace.ref, normal: onFace.plane.n, point: onFace.point }
    : hit?.normal && (hit.ref.kind === 'face' || hit.ref.kind === 'sketchFace')
      ? { ref: hit.ref, normal: hit.normal, point: hit.point }
      : null;
  if (!surface || sameFace(surface.ref, target.ref)) return null;
  // A solid's face turned away from the view is only in sight through the pulled face.
  if (surface.ref.kind === 'face' && v3dot(surface.normal, ray.dir) > 0) return null;
  const denom = v3dot(surface.normal, target.normal);
  if (Math.abs(denom) < MATCH_HEIGHT_MIN_COS) return null;
  if (seenThroughTarget(ray, target, base, surface.point)) return null;
  const t = v3dot(surface.normal, v3sub(surface.point, base)) / denom;
  return Number.isFinite(t) ? t : null;
}

/** The ray passes through the pulled face, where it was when the pull started, before reaching `point`. */
function seenThroughTarget(ray: Ray, target: Target, base: Vec3, point: Vec3): boolean {
  const denom = v3dot(ray.dir, target.normal);
  if (Math.abs(denom) <= 1e-12) return false;
  const s = v3dot(v3sub(base, ray.origin), target.normal) / denom;
  if (s <= 0 || s >= v3dot(v3sub(point, ray.origin), ray.dir) - COPLANAR_TOL) return false;
  const basis = planeBasis(base, target.normal);
  const flat = (p: Vec3): [number, number] => {
    const l = basisToLocal(basis, p);
    return [l[0], l[1]];
  };
  return pointInPolygon(flat(v3addScaled(ray.origin, ray.dir, s)), target.loops.map((loop) => loop.map(flat)));
}

/** What a preview or commit was computed against: its identity changes with every edit of it. */
function planSource(plan: PushPullPlan): unknown {
  return plan.kind === 'body' ? plan.body : plan.container.sketch;
}

/** The full preview result to commit, when it was computed against the face as it is now. */
function reusablePreview(state: DocumentState, params: PushPullApplyParams, preview: FullPreview | null): Partial<PushPullApplyParams> {
  if (!preview) return {};
  let plan: PushPullPlan;
  try {
    plan = planPushPull(state, params.target, params.distance, params.mode);
  } catch {
    return {};
  }
  if (planSource(plan) !== preview.source) return {};
  return plan.kind === 'body' ? { precomputed: preview.result, precomputedVersion: plan.body.version } : { precomputed: preview.result };
}

/** A failure in the words the status bar shows. */
function userMessage(err: unknown): string {
  if (err instanceof PushFormError && (err.code.startsWith('pushpull.') || err.code === 'context.mismatch')) return err.message;
  return PUSH_PULL_MESSAGES.failed;
}

/** Parameter t of the point on the line `base + t·dir` (unit dir) closest to the ray. */
function closestParamOnLine(base: Vec3, dir: Vec3, ray: Ray): number {
  const w0 = v3sub(base, ray.origin);
  const a = v3dot(dir, dir), b = v3dot(dir, ray.dir), c = v3dot(ray.dir, ray.dir);
  const d = v3dot(dir, w0), e = v3dot(ray.dir, w0);
  const denom = a * c - b * b;
  if (denom < 1e-12) return 0;
  return (b * e - c * d) / denom;
}

/** Hovered region: a translucent blue polygon with its holes left open and outlined. */
function highlight(loops: readonly (readonly Vec3[])[]): OverlayPrimitive[] {
  const out: OverlayPrimitive[] = [];
  loops.forEach((loop, i) => {
    if (i === 0) out.push({ kind: 'polygon', points: loop, holes: loops.slice(1), color: HOVER_COLOR, opacity: 0.25 });
    else out.push({ kind: 'polyline', points: loop, color: HOVER_COLOR, closed: true, width: 1.5 });
  });
  return out;
}

/** Transient prism: cap translated by distance·n, side quads, and the cap/vertical edges. */
function ghostPrism(loops: readonly (readonly Vec3[])[], n: Vec3, distance: number): OverlayPrimitive[] {
  const out: OverlayPrimitive[] = [];
  const caps = loops.map((loop) => loop.map((p) => v3addScaled(p, n, distance)));
  loops.forEach((loop, li) => {
    const cap = caps[li]!;
    if (li === 0) out.push({ kind: 'polygon', points: cap, holes: caps.slice(1), color: GHOST_FACE_COLOR, opacity: 0.2 });
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
      const a2 = cap[i]!, b2 = cap[(i + 1) % loop.length]!;
      out.push({ kind: 'polygon', points: [a, b, b2, a2], color: GHOST_FACE_COLOR, opacity: 0.12 });
      out.push({ kind: 'polyline', points: [a, a2], color: GHOST_EDGE_COLOR, width: 1 });
    }
    out.push({ kind: 'polyline', points: cap, color: GHOST_EDGE_COLOR, closed: true, width: 1.5 });
  });
  return out;
}

/** Tools contributed by this module, for the bootstrap's `ToolManager.register` loop. */
export function pushPullTools(): Tool[] {
  return [new PushPullTool()];
}

/** A loose (sketch) face, not yet part of a solid: pulled either way, it becomes one. */
function isLoose(ref: PushPullTarget): boolean {
  return ref.kind === 'sketchFace';
}
