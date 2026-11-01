// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MeshData, Ray, Vec2, Vec3 } from '@pushform/core';
import { basisToLocal, basisToWorld, COPLANAR_TOL, formatLength, v3addScaled, v3dot, v3sub } from '@pushform/core';
import type { PushPullMode, PushPullResult } from '@pushform/kernel';
import type { InferenceOptions, PickHit } from '@pushform/inference';
import { SNAP_COLORS } from '@pushform/inference';
import type { DocumentState, EntityContainer, EntityRef } from '@pushform/model';
import { computeRegions, containerAt, regionAt, sketchFaceLoops } from '@pushform/model';
import type { MMat4 } from '@pushform/core';
import { DocumentHost } from '../../host/DocumentHost';
import { hostOf, kernelOf, SERVICE_DOCUMENT } from '../../host/services';
import { contextFrame, samePath } from '../../commands/context';
import { planPushPull, runPushPullKernel, type PushPullApplyParams, type PushPullTarget } from '../../commands/pushpull';
import type { VcbKind, VcbValue } from '../../vcb/parse';
import type { OverlayPrimitive } from '../overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus } from '../Tool';
import { pointerField } from '../entry';

/** Pointer travel (CSS px) that turns a press into a drag-release gesture. */
const DRAG_PX = 4;
/** Minimum spacing between real kernel previews while dragging. */
const PREVIEW_INTERVAL_MS = 80;
/** A hovered face must not be nearly parallel to the pull line for "match height" to apply. */
const MATCH_HEIGHT_MIN_COS = 0.05;

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
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'hover'; readonly target: Target }
  | {
      readonly kind: 'dragging';
      readonly target: Target;
      readonly base: Vec3;
      readonly downScreen: Vec2;
      /** Button still held since the press that started the drag. */
      pressed: boolean;
      /** Pointer travelled more than DRAG_PX since the press. */
      moved: boolean;
      distance: number;
    };

interface Preview {
  readonly key: string;
  readonly distance: number;
  readonly mode: PushPullMode;
  readonly result: PushPullResult;
  readonly replacesBodyId: number | null;
}

interface LastCommit {
  params: PushPullApplyParams;
  /** The apply command finished successfully (the VCB may re-edit it). */
  applied: boolean;
}

const IDLE: State = { kind: 'idle' };

/**
 * Push/Pull (P). Hover highlights the face/region under the cursor; press (or click) on it to
 * start, move along the face normal, release after a drag or click again to commit. Double-click
 * repeats the last distance; a typed length applies during the drag or re-edits the last commit
 * (undo + re-apply, one undo entry). Ctrl/Alt toggles `newBody` ("keep starting face"). Esc cancels.
 *
 * Drag feedback is a transient prism in the overlay plus a debounced real kernel preview exposed
 * through `previewMeshes` / `previewReplacesBodyId` for the renderer (see those getters).
 */
export class PushPullTool implements Tool {
  readonly id = 'pushpull';
  readonly title = 'Push/Pull';
  readonly cursor = 'crosshair';
  readonly vcbSchema: readonly VcbKind[] = ['length'];

  private ctx: ToolContext | null = null;
  private state: State = IDLE;
  private mode: PushPullMode = 'merge';
  private lastDistance: number | null = null;
  private lastCommit: LastCommit | null = null;
  private lastError: string | null = null;
  /** Serializes commits and VCB re-applies (each awaits the kernel). */
  private queue: Promise<void> = Promise.resolve();
  private preview: Preview | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPreviewAt = 0;

  // --- renderer contract ----------------------------------------------------------------------

  /**
   * Real kernel preview of the drag, for the renderer (`tool.previewMeshes`). Non-empty only while
   * dragging and only when the latest preview result still matches the current target, distance
   * and mode; otherwise the overlay ghost is all there is. Meshes are `MeshData` in the
   * coordinates of the edited container (one per resulting solid); `previewMatrix` maps them to
   * world. In `merge` mode they replace the body `previewReplacesBodyId`, which the renderer
   * should hide while drawing them; for `newBody` and sketch-face pulls they are additional
   * solids and `previewReplacesBodyId` is null.
   */
  get previewMeshes(): readonly MeshData[] {
    const p = this.currentPreview();
    return p ? p.result.components.map((c) => ({ verts: c.mesh.verts, tris: c.mesh.tris, faceId: c.mesh.faceId })) : [];
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

  hasPendingWork(): boolean {
    return this.state.kind !== 'idle';
  }

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    this.state = IDLE;
    this.lastCommit = null;
    this.lastError = null;
  }

  deactivate(): void {
    this.clearPreview();
    this.state = IDLE;
    this.lastCommit = null;
    this.ctx = null;
  }

  suspend(): void {
    // Keep the drag alive across a middle-button orbit; just stop previewing until it resumes.
    this.cancelPreviewTimer();
  }

  resume(): void {
    this.schedulePreview();
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
      s.distance = this.distanceFor(e, s.target, s.base);
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
      this.commit(this.distanceFor(e, s.target, s.base));
      return;
    }
    const hit = e.inference?.hit ?? null;
    const target = this.resolveTarget(hit);
    if (!target || !hit) {
      this.state = IDLE;
      return;
    }
    this.lastCommit = null;
    this.lastError = null;
    this.state = { kind: 'dragging', target, base: hit.point, downScreen: e.screen, pressed: true, moved: false, distance: 0 };
    this.ctx?.statusChanged();
  }

  onPointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0 || this.state.kind !== 'dragging' || !this.state.pressed) return;
    const s = this.state;
    s.pressed = false;
    if (!s.moved && screenDist(e.screen, s.downScreen) <= DRAG_PX) return; // click-move-click continues
    this.commit(this.distanceFor(e, s.target, s.base));
  }

  onDoubleClick(e: ToolPointerEvent): void {
    if (e.button !== 0 || this.lastDistance === null) return;
    if (this.state.kind === 'dragging') this.endDrag();
    const target = this.resolveTarget(e.inference?.hit ?? null);
    if (!target) return;
    this.state = { kind: 'hover', target };
    this.commit(this.lastDistance);
  }

  // --- keys / VCB -----------------------------------------------------------------------------

  onKeyDown(e: ToolKeyEvent): boolean {
    if (e.repeat) return false;
    if (e.key === 'Control' || e.key === 'Alt') {
      this.mode = this.mode === 'merge' ? 'newBody' : 'merge';
      this.clearPreview();
      this.schedulePreview();
      this.ctx?.statusChanged();
      this.ctx?.requestRender();
      return true;
    }
    return false;
  }

  onVcb(v: VcbValue): void {
    if (v.kind !== 'length') return;
    const s = this.state;
    if (s.kind === 'dragging') {
      // A loose face takes the distance in the direction it is being pulled; a solid's face along its front.
      this.commit(isLoose(s.target.ref) ? (s.distance !== 0 ? Math.sign(s.distance) : this.viewerSide(s.target)) * v.meters : v.meters);
      return;
    }
    const last = this.lastCommit;
    if (!last) return;
    // Re-editing a loose face's pull keeps its direction.
    const distance = isLoose(last.params.target) ? (Math.sign(last.params.distance) || 1) * v.meters : v.meters;
    const params: PushPullApplyParams = { target: last.params.target, distance, mode: last.params.mode };
    last.params = params;
    this.lastDistance = distance;
    this.enqueue(async () => {
      if (!last.applied || this.lastCommit !== last) return;
      const ctx = this.ctx;
      if (!ctx) return;
      const host = hostOf(ctx.commands.ctx);
      // Only re-edit when our commit is still the last thing that happened to the document.
      if (host.undoStack.peek()?.label !== 'Push/Pull' || !host.undo()) return;
      last.applied = false;
      await ctx.commands.execute('pushpull.apply', params);
      last.applied = true;
    });
    this.ctx?.statusChanged();
  }

  onCancel(): void {
    if (this.state.kind === 'dragging') {
      this.endDrag();
      return;
    }
    this.lastCommit = null;
    this.lastError = null;
    this.state = IDLE;
  }

  // --- overlay / status -----------------------------------------------------------------------

  overlay(): readonly OverlayPrimitive[] {
    const s = this.state;
    if (s.kind === 'hover') return highlight(s.target.loops);
    if (s.kind !== 'dragging') return [];
    if (Math.abs(s.distance) <= COPLANAR_TOL) return highlight(s.target.loops);
    return ghostPrism(s.target.loops, s.target.normal, s.distance);
  }

  status(): ToolStatus {
    const s = this.state;
    const doc = this.ctx?.commands.ctx.services.get(SERVICE_DOCUMENT);
    const units = doc instanceof DocumentHost ? doc.doc.state.meta.units : null;
    const fmt = (d: number): string => (units ? formatLength(d, units) : d.toString());
    const modeHint = this.mode === 'newBody' ? ' [New body]' : '';
    if (s.kind === 'dragging') {
      // A loose face has no inside: its distance is how far it is pulled, whichever way. A solid's face is signed along its front.
      const shown = isLoose(s.target.ref) ? Math.abs(s.distance) : s.distance;
      return { instructor: `Click or type distance.${modeHint}`, vcbLabel: 'Distance', vcbValue: fmt(shown), fields: [pointerField('Distance', 'length', fmt(shown))] };
    }
    const instructor = this.lastError ? `Push/Pull failed: ${this.lastError}` : `Select face to push or pull.${modeHint}`;
    const last = this.lastCommit ? (isLoose(this.lastCommit.params.target) ? Math.abs(this.lastCommit.params.distance) : this.lastCommit.params.distance) : this.lastDistance;
    return { instructor, vcbLabel: 'Distance', vcbValue: last === null ? undefined : fmt(last) };
  }

  // --- internals ------------------------------------------------------------------------------

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
    if ((target?.key ?? null) !== prevKey) this.ctx?.requestRender();
  }

  private endDrag(): void {
    this.clearPreview();
    this.state = IDLE;
    this.ctx?.statusChanged();
    this.ctx?.requestRender();
  }

  /** Resolve the geometry under the cursor into a target (world normal and loops) using the current document state. */
  private resolveTarget(hit: PickHit | null): Target | null {
    if (!hit || !this.ctx) return null;
    const ref: EntityRef = hit.ref;
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
      };
    }
    if (ref.kind !== 'face') return null;
    const body = container.bodies.get(ref.id);
    const face = body?.faces.get(ref.faceId);
    if (!body || !face) return null;
    const regions = computeRegions(body, ref.faceId);
    let index = ref.region ?? -1;
    if (index < 0 && regions.length > 1) {
      const l = basisToLocal(face.basis, frame.toLocal(hit.point));
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
    };
  }

  /**
   * Signed distance along the normal for a pointer event: a hovered face (other than the target)
   * sets the height where the pull line crosses its plane ("match height"); otherwise the
   * inference point is projected onto the pull line; without inference, the ray's closest point.
   */
  private distanceFor(e: ToolPointerEvent, target: Target, base: Vec3): number {
    const inf = e.inference;
    if (!inf) return closestParamOnLine(base, target.normal, e.ray);
    const hit = inf.hit;
    if (hit?.normal && hit.ref.kind === 'face' && !sameRef(hit.ref, target.ref)) {
      const denom = v3dot(hit.normal, target.normal);
      if (Math.abs(denom) > MATCH_HEIGHT_MIN_COS) {
        const t = v3dot(hit.normal, v3sub(hit.point, base)) / denom;
        if (Number.isFinite(t)) return t;
      }
    }
    return v3dot(v3sub(inf.point, base), target.normal);
  }

  private commit(distance: number): void {
    const s = this.state;
    const target = s.kind === 'dragging' || s.kind === 'hover' ? s.target : null;
    if (!target || !this.ctx) return;
    if (!Number.isFinite(distance) || Math.abs(distance) <= COPLANAR_TOL) {
      this.endDrag();
      return;
    }
    const mode = this.mode;
    const params: PushPullApplyParams = { target: target.ref, distance, mode };
    const pre = this.preview;
    const precomputed = pre && pre.key === target.key && pre.distance === distance && pre.mode === mode ? pre.result : undefined;
    const last: LastCommit = { params, applied: false };
    this.lastCommit = last;
    this.lastDistance = distance;
    this.lastError = null;
    this.clearPreview();
    this.state = IDLE;
    const ctx = this.ctx;
    this.enqueue(async () => {
      await ctx.commands.execute('pushpull.apply', precomputed ? { ...params, precomputed } : params);
      last.applied = true;
    });
    ctx.statusChanged();
    ctx.requestRender();
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err: unknown) => {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastCommit = null;
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
      void this.runPreview();
    }, delay);
  }

  private async runPreview(): Promise<void> {
    const s = this.state;
    const ctx = this.ctx;
    if (!ctx || s.kind !== 'dragging' || Math.abs(s.distance) <= COPLANAR_TOL) return;
    const { target, distance } = s;
    const mode = this.mode;
    if (this.preview && this.preview.key === target.key && this.preview.distance === distance && this.preview.mode === mode) return;
    const host = hostOf(ctx.commands.ctx);
    const kernel = kernelOf(ctx.commands.ctx);
    try {
      const plan = planPushPull(host.doc.state, target.ref, distance, mode);
      const r = await kernel.coalesced('pushpull-preview', () => runPushPullKernel(kernel, plan, true));
      if (r.status !== 'current') return;
      this.preview = { key: target.key, distance, mode, result: r.value, replacesBodyId: mode === 'merge' ? target.bodyId : null };
      if (this.currentPreview()) ctx.requestRender();
    } catch {
      // A failed preview is not an error the user needs to see; the ghost stays.
    }
  }

  private cancelPreviewTimer(): void {
    if (this.previewTimer !== null) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
  }

  private clearPreview(): void {
    this.cancelPreviewTimer();
    this.preview = null;
  }
}

// ---------------------------------------------------------------------------------------------
// helpers

function screenDist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function sameRef(a: EntityRef, b: PushPullTarget): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;
  return a.kind !== 'face' || b.kind !== 'face' || a.faceId === b.faceId;
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
