// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { Matrix4, Vector3 } from 'three';
import type { Camera, Mesh, Object3D } from 'three';
import type { Vec3 } from '@pushform/core';
import { LENGTH_TOL } from '@pushform/core';
import type { RenderFaceCamera } from '../types';

/** Where the camera is for Always Face Camera: its eye, or only its direction in parallel projection. */
export interface FaceCameraView {
  readonly eye: Vec3;
  readonly forward: Vec3;
  readonly parallel: boolean;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const across = (v: Vec3, axis: Vec3): Vec3 => {
  const k = dot(v, axis);
  return [v[0] - axis[0] * k, v[1] - axis[1] * k, v[2] - axis[2] * k];
};

/**
 * Angle about `axis` (unit) that turns `front` toward `toward`, both taken across the axis; 0 when either lies
 * along it (a camera looking down the blue axis leaves the placement as it is).
 */
export function faceCameraAngle(axis: Vec3, front: Vec3, toward: Vec3): number {
  const f = across(front, axis), t = across(toward, axis);
  if (Math.hypot(...f) <= LENGTH_TOL || Math.hypot(...t) <= LENGTH_TOL) return 0;
  return Math.atan2(dot(axis, cross(f, t)), dot(f, t));
}

const tmpAxis = new Vector3();

/** Rotation by `angle` about the spec's axis through its pivot, in coordinates relative to the floating `origin`. */
function turnMatrix(out: Matrix4, spec: RenderFaceCamera, angle: number, origin: Vec3): Matrix4 {
  const p = sub(spec.pivot, origin);
  tmpAxis.set(spec.axis[0], spec.axis[1], spec.axis[2]);
  return out
    .makeTranslation(p[0], p[1], p[2])
    .multiply(new Matrix4().makeRotationAxis(tmpAxis, angle))
    .multiply(new Matrix4().makeTranslation(-p[0], -p[1], -p[2]));
}

interface FaceCameraState {
  /** The object's turn for the shadow pass when it Shadows Face Sun; null otherwise. */
  sun: Matrix4 | null;
}

const states = new WeakMap<Object3D, FaceCameraState>();

/**
 * Turn `group` (a body or sketch renderable) to face the camera, or put it back when `spec` is undefined.
 * With `shadowsFaceSun` and a sun direction, its `meshes` cast shadows turned toward the sun instead:
 * three.js computes each mesh's model-view matrix for the shadow camera just before `onBeforeShadow`, so that hook
 * replaces it.
 */
export function applyFaceCamera(group: Object3D, meshes: readonly Mesh[], spec: RenderFaceCamera | undefined, view: FaceCameraView, sunDirection: Vec3 | null, origin: Vec3): void {
  let state = states.get(group);
  if (!spec) {
    if (!state) return;
    group.matrixAutoUpdate = true;
    group.matrix.identity();
    group.matrixWorldNeedsUpdate = true;
    state.sun = null;
    return;
  }
  if (!state) {
    const s: FaceCameraState = { sun: null };
    state = s;
    states.set(group, s);
    const world = new Matrix4();
    for (const mesh of meshes) {
      mesh.onBeforeShadow = (_renderer, _scene, _camera, shadowCamera: Camera) => {
        if (!s.sun) return;
        world.copy(group.parent ? group.parent.matrixWorld : new Matrix4()).multiply(s.sun).multiply(mesh.matrix);
        mesh.modelViewMatrix.multiplyMatrices(shadowCamera.matrixWorldInverse, world);
      };
    }
  }
  const toward: Vec3 = view.parallel ? [-view.forward[0], -view.forward[1], -view.forward[2]] : sub(view.eye, spec.pivot);
  group.matrixAutoUpdate = false;
  turnMatrix(group.matrix, spec, faceCameraAngle(spec.axis, spec.front, toward), origin);
  group.matrixWorldNeedsUpdate = true;
  state.sun = spec.shadowsFaceSun && sunDirection ? turnMatrix(state.sun ?? new Matrix4(), spec, faceCameraAngle(spec.axis, spec.front, sunDirection), origin) : null;
}
