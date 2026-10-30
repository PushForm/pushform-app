// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL, type Box3 } from '@pushform/core';
import type { ImportedScene } from '@pushform/io';
import { layoutFrameSize, viewportCameraBasis, type LayoutViewportCamera } from '@pushform/layout';
import { cameraFrameBox, cameraOrbit, cameraPan, cameraStandardView, cameraZoom, DEFAULT_CAMERA, type CameraState, type StandardView } from '@pushform/render';
import { viewportCameraState } from './layoutViewportRenders';

type Point = [number, number];

/** Switch projection while keeping the target-plane framing and off-center image placement. */
export function projectionViewportCamera(camera: LayoutViewportCamera, projection: LayoutViewportCamera['projection'], frame: readonly Point[]): LayoutViewportCamera {
  if (projection === camera.projection) return camera;
  const depth = Math.max(LENGTH_TOL, Math.hypot(...camera.eye.map((value, i) => value - camera.target[i]!)));
  const { height } = layoutFrameSize(frame);
  const shift = camera.shift?.map(value => projection === 'parallel' ? value * depth : value / depth) as Point | undefined;
  return { ...camera, projection, shift,
    ...(projection === 'parallel' ? { scale: height / 1000 / (2 * depth * Math.tan(camera.fov * Math.PI / 360)) }
      : { fov: 2 * Math.atan(height / 1000 / camera.scale / (2 * depth)) * 180 / Math.PI }),
  };
}

/** Back from the renderer's camera; a parallel view keeps its paper scale through `orthoHeight`. */
export function viewportCameraFromState(state: CameraState, heightMm: number, previous?: LayoutViewportCamera): LayoutViewportCamera {
  return {
    eye: [...state.eye], target: [...state.target], up: [...state.up], projection: state.projection, fov: state.fov,
    scale: state.projection === 'parallel' ? heightMm / 1000 / state.orthoHeight : previous?.scale ?? 1,
    ...(previous?.shift ? { shift: previous.shift } : {}),
  };
}

/** A model scene's camera in a frame; null when the scene saves no camera. */
export function sceneViewportCamera(scene: ImportedScene, frame: readonly Point[]): LayoutViewportCamera | null {
  const camera = scene.camera;
  if (!camera) return null;
  const { height } = layoutFrameSize(frame);
  return { eye: [...camera.eye], target: [...camera.target], up: [...camera.up], projection: camera.perspective ? 'perspective' : 'parallel',
    fov: camera.fov > 0 ? camera.fov : 35, scale: camera.perspective || camera.height <= 0 ? 1 : height / 1000 / camera.height };
}

/** A standard view (Top, Front, ...) of the whole model in a frame, keeping the projection. */
export function standardViewportCamera(camera: LayoutViewportCamera, view: StandardView, frame: readonly Point[], bounds: Box3 | null): LayoutViewportCamera {
  const { width, height } = layoutFrameSize(frame);
  let state = cameraStandardView(viewportCameraState(camera, height), view);
  if (bounds) state = cameraFrameBox(state, bounds, width / height);
  return viewportCameraFromState(state, height, { ...camera, shift: undefined });
}

/** The camera a new view starts with: the model's first scene, else an iso view of the whole model. */
export function initialViewportCamera(scenes: readonly ImportedScene[], frame: readonly Point[], bounds: Box3 | null): { camera: LayoutViewportCamera; scene: string | null } {
  for (const scene of scenes) {
    const camera = sceneViewportCamera(scene, frame);
    if (camera) return { camera, scene: scene.name };
  }
  const start: LayoutViewportCamera = { eye: [...DEFAULT_CAMERA.eye], target: [...DEFAULT_CAMERA.target], up: [0, 0, 1], projection: 'perspective', fov: 35, scale: 1 };
  return { camera: standardViewportCamera(start, 'iso', frame, bounds), scene: null };
}

/** A paper-space drag expressed along the frame's own axes, in millimeters. */
function frameDelta(frame: readonly Point[], delta: Point): Point {
  const [tl, tr, , bl] = frame as Point[];
  const ux = [tr![0] - tl![0], tr![1] - tl![1]], vy = [bl![0] - tl![0], bl![1] - tl![1]];
  const lu = Math.hypot(ux[0]!, ux[1]!) || 1, lv = Math.hypot(vy[0]!, vy[1]!) || 1;
  return [(delta[0] * ux[0]! + delta[1] * ux[1]!) / lu, (delta[0] * vy[0]! + delta[1] * vy[1]!) / lv];
}

/** Orbit around the camera target by a paper drag: a frame-width drag turns half a revolution. */
export function orbitViewportCamera(camera: LayoutViewportCamera, frame: readonly Point[], deltaMm: Point): LayoutViewportCamera {
  const { width, height } = layoutFrameSize(frame);
  const [du, dv] = frameDelta(frame, deltaMm);
  const turn = Math.PI / Math.max(width, height, 1e-6);
  return viewportCameraFromState(cameraOrbit(viewportCameraState(camera, height), camera.target, -du * turn, dv * turn), height, camera);
}

/** Pan so the model follows a paper drag. */
export function panViewportCamera(camera: LayoutViewportCamera, frame: readonly Point[], deltaMm: Point): LayoutViewportCamera {
  const { height } = layoutFrameSize(frame);
  const [du, dv] = frameDelta(frame, deltaMm);
  // The renderer pans in pixels of a viewport `height` pixels tall; the frame's millimeters serve as those pixels.
  return viewportCameraFromState(cameraPan(viewportCameraState(camera, height), du, dv, height), height, camera);
}

/** Zoom toward the view center; `factor` < 1 zooms in. */
export function zoomViewportCamera(camera: LayoutViewportCamera, frame: readonly Point[], factor: number): LayoutViewportCamera {
  const { height } = layoutFrameSize(frame);
  return viewportCameraFromState(cameraZoom(viewportCameraState(camera, height), factor, null), height, camera);
}

type V3 = [number, number, number];

/**
 * A view keeping a model camera's eye and direction, its frame cropped to `points`
 * (model coordinates) with a margin. The frame takes their on-screen aspect within `maxWidth` ×
 * `maxHeight` millimeters; `shift` centers them, and the field of view (perspective) or the scale
 * (parallel) makes them fill it.
 */
export function croppedViewportCamera(state: CameraState, points: readonly (readonly number[])[], maxWidth: number, maxHeight: number, margin = 0.05):
  { camera: LayoutViewportCamera; width: number; height: number } {
  const base: LayoutViewportCamera = { eye: [...state.eye], target: [...state.target], up: [...state.up], projection: state.projection, fov: state.fov, scale: 1 };
  const { forward, right, up } = viewportCameraBasis(base);
  const perspective = state.projection === 'perspective';
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of points) {
    const d: V3 = [p[0]! - state.eye[0], p[1]! - state.eye[1], p[2]! - state.eye[2]];
    const dot = (a: V3) => d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
    const depth = dot(forward);
    if (perspective && depth <= 1e-9) continue;
    const x = perspective ? dot(right) / depth : dot(right), y = perspective ? dot(up) / depth : dot(up);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (!Number.isFinite(x0)) {
    // Nothing in front of the eye: the whole view at a 4:3 aspect.
    const h = perspective ? 2 * Math.tan(state.fov * Math.PI / 360) : state.orthoHeight;
    x0 = -h * 2 / 3; x1 = h * 2 / 3; y0 = -h / 2; y1 = h / 2;
  }
  let w = x1 - x0, h = y1 - y0;
  const span = Math.max(w, h, perspective ? 1e-6 : 1e-4);
  // A flat or point-like extent still gets a frame.
  w = Math.max(w, span * 0.05); h = Math.max(h, span * 0.05);
  const pad = Math.max(w, h) * margin;
  w += 2 * pad; h += 2 * pad;
  const k = Math.min(maxWidth / w, maxHeight / h);
  const width = w * k, height = h * k;
  const shift: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const camera: LayoutViewportCamera = perspective
    ? { ...base, fov: 2 * Math.atan(h / 2) * 180 / Math.PI, shift }
    : { ...base, scale: height / 1000 / h, shift };
  return { camera, width, height };
}
