// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { viewportCameraBasis, type LayoutViewportCamera } from '@pushform/layout';
import { child, type XmlElement } from './xml';

/**
 * LayOut's `e:camera` (confirmed against LayOut 2027's model_to_paper_point on 168 corpus viewports): eye,
 * target and up in model inches; perspective `fov` is vertical across the unzoomed view; a parallel view is
 * `height` inches tall. With `twoDCamera="1"` the frame shows `twoDScale` of that view, centered at
 * (`twoDxCenter`, `twoDyCenter`) in units of the unzoomed half-height (and half-width, which is the half-height
 * times the frame aspect).
 */
export interface LayOutCamera {
  perspective: boolean;
  eye: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  height: number;
  twoDCamera: boolean;
  twoDScale: number;
  twoDxCenter: number;
  twoDyCenter: number;
}

const number = (element: XmlElement | undefined, key: string, fallback: number) => {
  const value = Number(element?.attrs[key]);
  return element?.attrs[key] !== undefined && Number.isFinite(value) ? value : fallback;
};
const vector = (element: XmlElement | undefined, fallback: [number, number, number]): [number, number, number] =>
  [number(element, 'x', fallback[0]), number(element, 'y', fallback[1]), number(element, 'z', fallback[2])];

/** Reads an `e:camera` element. */
export function readLayOutCamera(camera: XmlElement): LayOutCamera {
  return {
    perspective: camera.attrs.projection !== '1',
    eye: vector(child(camera, 'eye'), [0, 0, 0]), target: vector(child(camera, 'target'), [0, 0, 0]), up: vector(child(camera, 'up'), [0, 0, 1]),
    fov: number(camera, 'fov', 35), height: number(camera, 'height', 1),
    twoDCamera: camera.attrs.twoDCamera === '1', twoDScale: number(camera, 'twoDScale', 1),
    twoDxCenter: number(camera, 'twoDxCenter', 0), twoDyCenter: number(camera, 'twoDyCenter', 0),
  };
}

const INCH = 0.0254;
const DEG = Math.PI / 180;
const scaled = (v: readonly number[], k: number) => [v[0]! * k, v[1]! * k, v[2]! * k] as [number, number, number];
const unit = (v: readonly number[]) => { const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1; return scaled(v, 1 / l); };

/** PushForm's camera for a LayOut viewport whose frame is `width` × `height` paper inches. */
export function viewportCameraFromLayOut(camera: LayOutCamera, width: number, height: number): LayoutViewportCamera {
  const aspect = width / height;
  const zoom = camera.twoDCamera && camera.twoDScale > 0 ? camera.twoDScale : 1;
  const eye = scaled(camera.eye, INCH), target = scaled(camera.target, INCH), up = unit(camera.up);
  if (camera.perspective) {
    const tangent = Math.tan(camera.fov * DEG / 2);
    const shift: [number, number] = camera.twoDCamera ? [camera.twoDxCenter * tangent * aspect, camera.twoDyCenter * tangent] : [0, 0];
    return { eye, target, up, projection: 'perspective', fov: 2 * Math.atan(tangent * zoom) / DEG, scale: 1,
      ...(shift[0] || shift[1] ? { shift } : {}) };
  }
  // Parallel: fold the off-center view into the eye and target so the frame center is on the view axis.
  const half = camera.height / 2;
  const [sx, sy] = camera.twoDCamera ? [camera.twoDxCenter * half * aspect * INCH, camera.twoDyCenter * half * INCH] : [0, 0];
  const basis = viewportCameraBasis({ eye, target, up, projection: 'parallel', fov: camera.fov, scale: 1 });
  const offset = [0, 1, 2].map(i => basis.right[i]! * sx + basis.up[i]! * sy);
  return {
    eye: [eye[0] + offset[0]!, eye[1] + offset[1]!, eye[2] + offset[2]!],
    target: [target[0] + offset[0]!, target[1] + offset[1]!, target[2] + offset[2]!],
    up, projection: 'parallel', fov: camera.fov, scale: height / (camera.height * zoom),
  };
}

/** The LayOut camera that shows `camera` in a frame of `width` × `height` paper inches. */
export function layOutCameraFromViewport(camera: LayoutViewportCamera, width: number, height: number, fallbackFov = 30): LayOutCamera {
  const aspect = width / height;
  const [sx, sy] = camera.shift ?? [0, 0];
  const base = { eye: scaled(camera.eye, 1 / INCH), target: scaled(camera.target, 1 / INCH), up: unit(camera.up), twoDScale: 1 };
  if (camera.projection === 'perspective') {
    const tangent = Math.tan(camera.fov * DEG / 2);
    const off = sx !== 0 || sy !== 0;
    return { ...base, perspective: true, fov: camera.fov, height: 0, twoDCamera: off,
      twoDxCenter: off ? sx / (tangent * aspect) : 0, twoDyCenter: off ? sy / tangent : 0 };
  }
  const viewHeight = height / camera.scale;
  const off = sx !== 0 || sy !== 0;
  return { ...base, perspective: false, fov: camera.fov > 0 ? camera.fov : fallbackFov, height: viewHeight, twoDCamera: off,
    twoDxCenter: off ? sx / INCH / (viewHeight / 2 * aspect) : 0, twoDyCenter: off ? sy / INCH / (viewHeight / 2) : 0 };
}
