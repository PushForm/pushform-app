// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Box3, Ray, Vec3 } from '@pushform/core';
import type { Vec2 } from '@pushform/core';

export type Projection = 'perspective' | 'parallel';
export type StandardView = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';

/** Serializable camera state. Z is up. */
export interface CameraState {
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
  /** Vertical field of view in degrees (perspective). */
  readonly fov: number;
  readonly projection: Projection;
  /** Visible world height at the target for parallel projection. */
  readonly orthoHeight: number;
}

/**
 * Camera operations the render package implements. Screen coordinates are CSS pixels relative to
 * the viewport's top-left corner. Tools and camera commands talk to this interface only.
 */
export interface CameraHost {
  getState(): CameraState;
  /** Replace the state. `history` (default true) records the previous state for Camera › Previous. */
  setState(state: CameraState, history?: boolean): void;
  viewportSize(): { width: number; height: number };
  screenToRay(x: number, y: number): Ray;
  /** World point under the cursor (geometry hit) or null. */
  pick(screen: Vec2): Vec3 | null;
  /** Bounds of everything drawable, or null when the scene is empty. */
  sceneBounds(): Box3 | null;

  orbitStart(screen: Vec2, opts?: { free?: boolean }): void;
  orbitDrag(screen: Vec2): void;
  orbitEnd(): void;

  panStart(screen: Vec2): void;
  panDrag(screen: Vec2): void;
  panEnd(): void;

  /** Zoom by `factor` (< 1 zooms in) keeping the point under `screen` fixed (or the view center). */
  zoomAt(screen: Vec2 | null, factor: number): void;
  zoomExtents(): void;
  /** Frame a world box from the current direction, as Zoom Extents frames the scene (Zoom Selection). */
  zoomBox?(box: Box3): void;
  zoomWindow(a: Vec2, b: Vec2): void;
  standardView(view: StandardView): void;
  setProjection(p: Projection): void;
  setFov(deg: number): void;
  /** Focal length in mm (35 mm equivalent, 36 mm wide frame). */
  setFocalLength(mm: number): void;
  previousView(): boolean;
  nextView(): boolean;
}
