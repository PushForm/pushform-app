// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { Emitter } from '@pushform/core';
import type { Box3, MVec3, Ray, Vec2, Vec3 } from '@pushform/core';
import type { CameraHost, CameraState, Projection, StandardView } from '@pushform/commands';
import { OrthographicCamera, PerspectiveCamera } from 'three';
import type { Camera } from 'three';
import {
  DEFAULT_CAMERA,
  cameraDistance,
  cameraFrameBox,
  cameraOrbit,
  cameraPan,
  cameraRay,
  cameraSetFov,
  cameraSetProjection,
  cameraStandardView,
  cameraStateEquals,
  cameraZoom,
  focalLengthToFov,
  pointAtTargetDepth,
} from './CameraState';

export interface CameraControllerEvents extends Record<string, unknown> {
  changed: CameraState;
}

export interface CameraControllerHooks {
  /** World point under the cursor from geometry picking (set by the Viewport). */
  pick?: (screen: Vec2) => Vec3 | null;
  /** Current drawable bounds (set by the Viewport). */
  sceneBounds?: () => Box3 | null;
}

const HISTORY_MAX = 100;
const ZOOM_HISTORY_COALESCE_MS = 600;

/**
 * Implements the commands `CameraHost` on top of the pure CameraState math
 * and keeps the two three.js cameras in sync. Z is up.
 */
export class CameraController implements CameraHost {
  readonly events = new Emitter<CameraControllerEvents>();
  readonly perspective = new PerspectiveCamera(35, 1, 0.05, 5000);
  readonly orthographic = new OrthographicCamera(-1, 1, 1, -1, -5000, 5000);
  private state: CameraState;
  private width = 1;
  private height = 1;
  private origin: MVec3 = [0, 0, 0];
  private past: CameraState[] = [];
  private future: CameraState[] = [];
  private lastZoomPush = 0;
  private drag: { kind: 'orbit' | 'pan'; last: Vec2; pivot: Vec3; free: boolean } | null = null;

  constructor(
    initial: CameraState = DEFAULT_CAMERA,
    readonly hooks: CameraControllerHooks = {},
  ) {
    this.state = initial;
    this.perspective.up.set(0, 0, 1);
    this.orthographic.up.set(0, 0, 1);
    this.applyToThree();
  }

  /** Active three.js camera for the current projection. */
  get three(): Camera {
    return this.state.projection === 'parallel' ? this.orthographic : this.perspective;
  }

  get aspect(): number {
    return this.width / Math.max(this.height, 1);
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.applyToThree();
  }

  /** Floating origin: three.js positions are world − origin. */
  setOrigin(origin: Vec3): void {
    this.origin = [origin[0], origin[1], origin[2]];
    this.applyToThree();
  }

  getOrigin(): Vec3 {
    return this.origin;
  }

  // --- CameraHost -------------------------------------------------------------------------------

  getState(): CameraState {
    return this.state;
  }

  setState(state: CameraState, history = true): void {
    if (cameraStateEquals(state, this.state)) return;
    if (history) this.pushHistory();
    this.commit(state);
  }

  viewportSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  screenToRay(x: number, y: number): Ray {
    const ndcX = (x / this.width) * 2 - 1;
    const ndcY = 1 - (y / this.height) * 2;
    return cameraRay(this.state, ndcX, ndcY, this.aspect);
  }

  pick(screen: Vec2): Vec3 | null {
    return this.hooks.pick?.(screen) ?? null;
  }

  sceneBounds(): Box3 | null {
    return this.hooks.sceneBounds?.() ?? null;
  }

  orbitStart(screen: Vec2, opts: { free?: boolean } = {}): void {
    this.pushHistory();
    const pivot = this.pick(screen) ?? this.defaultPivot();
    this.drag = { kind: 'orbit', last: screen, pivot, free: !!opts.free };
  }

  orbitDrag(screen: Vec2): void {
    const d = this.drag;
    if (!d || d.kind !== 'orbit') return;
    const dx = screen[0] - d.last[0];
    const dy = screen[1] - d.last[1];
    d.last = screen;
    const k = (2 * Math.PI) / this.height;
    this.commit(cameraOrbit(this.state, d.pivot, -dx * k, -dy * k, { free: d.free }));
  }

  orbitEnd(): void {
    if (this.drag?.kind === 'orbit') this.drag = null;
  }

  panStart(screen: Vec2): void {
    this.pushHistory();
    this.drag = { kind: 'pan', last: screen, pivot: this.state.target, free: false };
  }

  panDrag(screen: Vec2): void {
    const d = this.drag;
    if (!d || d.kind !== 'pan') return;
    const dx = screen[0] - d.last[0];
    const dy = screen[1] - d.last[1];
    d.last = screen;
    this.commit(cameraPan(this.state, dx, dy, this.height));
  }

  panEnd(): void {
    if (this.drag?.kind === 'pan') this.drag = null;
  }

  zoomAt(screen: Vec2 | null, factor: number): void {
    const now = Date.now();
    if (now - this.lastZoomPush > ZOOM_HISTORY_COALESCE_MS) this.pushHistory();
    this.lastZoomPush = now;
    let anchor: Vec3 | null = null;
    if (screen) {
      anchor = this.pick(screen) ?? pointAtTargetDepth(this.state, this.screenToRay(screen[0], screen[1]));
    }
    this.commit(cameraZoom(this.state, factor, anchor));
  }

  zoomExtents(): void {
    const box = this.sceneBounds();
    this.pushHistory();
    if (!box) {
      this.commit(cameraFrameBox(this.state, { min: [-5, -5, 0], max: [5, 5, 2] }, this.aspect));
      return;
    }
    this.commit(cameraFrameBox(this.state, box, this.aspect));
  }

  zoomBox(box: Box3): void {
    this.pushHistory();
    this.commit(cameraFrameBox(this.state, box, this.aspect));
  }

  zoomWindow(a: Vec2, b: Vec2): void {
    const w = Math.abs(b[0] - a[0]);
    const h = Math.abs(b[1] - a[1]);
    if (w < 1 || h < 1) return;
    this.pushHistory();
    const cx = (a[0] + b[0]) / 2;
    const cy = (a[1] + b[1]) / 2;
    const center = pointAtTargetDepth(this.state, this.screenToRay(cx, cy));
    const scale = Math.max(w / this.width, h / this.height);
    // Recenter (pan) then zoom around the new target.
    const shift: MVec3 = [center[0] - this.state.target[0], center[1] - this.state.target[1], center[2] - this.state.target[2]];
    const panned: CameraState = {
      ...this.state,
      eye: [this.state.eye[0] + shift[0], this.state.eye[1] + shift[1], this.state.eye[2] + shift[2]],
      target: center,
    };
    this.commit(cameraZoom(panned, scale, null));
  }

  standardView(view: StandardView): void {
    this.pushHistory();
    this.commit(cameraStandardView(this.state, view));
  }

  setProjection(p: Projection): void {
    if (p === this.state.projection) return;
    this.pushHistory();
    this.commit(cameraSetProjection(this.state, p));
  }

  setFov(deg: number): void {
    this.pushHistory();
    this.commit(cameraSetFov(this.state, deg));
  }

  setFocalLength(mm: number): void {
    this.setFov(focalLengthToFov(mm, this.aspect));
  }

  previousView(): boolean {
    const s = this.past.pop();
    if (!s) return false;
    this.future.push(this.state);
    this.commit(s);
    return true;
  }

  nextView(): boolean {
    const s = this.future.pop();
    if (!s) return false;
    this.past.push(this.state);
    this.commit(s);
    return true;
  }

  // --- internals ------------------------------------------------------------------------------

  private defaultPivot(): Vec3 {
    const box = this.sceneBounds();
    if (box) {
      return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    }
    return this.state.target;
  }

  private pushHistory(): void {
    const last = this.past[this.past.length - 1];
    if (last && cameraStateEquals(last, this.state)) return;
    this.past.push(this.state);
    if (this.past.length > HISTORY_MAX) this.past.shift();
    this.future = [];
  }

  private commit(state: CameraState): void {
    this.state = state;
    this.applyToThree();
    this.events.emit('changed', state);
  }

  private applyToThree(): void {
    const s = this.state;
    const o = this.origin;
    const dist = cameraDistance(s);
    const near = Math.max(0.005, dist * 0.002);
    const far = Math.max(dist * 50, 2000);
    for (const cam of [this.perspective, this.orthographic]) {
      cam.position.set(s.eye[0] - o[0], s.eye[1] - o[1], s.eye[2] - o[2]);
      cam.up.set(s.up[0], s.up[1], s.up[2]);
      cam.lookAt(s.target[0] - o[0], s.target[1] - o[1], s.target[2] - o[2]);
    }
    this.perspective.fov = s.fov;
    this.perspective.aspect = this.aspect;
    this.perspective.near = near;
    this.perspective.far = far;
    this.perspective.updateProjectionMatrix();
    const hh = s.orthoHeight / 2;
    this.orthographic.left = -hh * this.aspect;
    this.orthographic.right = hh * this.aspect;
    this.orthographic.top = hh;
    this.orthographic.bottom = -hh;
    this.orthographic.near = -far;
    this.orthographic.far = far;
    this.orthographic.updateProjectionMatrix();
    this.perspective.updateMatrixWorld();
    this.orthographic.updateMatrixWorld();
  }
}
