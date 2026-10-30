// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { BufferGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, OrthographicCamera, Vector3 } from 'three';
import type { WebGLRenderer } from 'three';
import { applyFaceCamera, faceCameraAngle } from './faceCamera';
import type { RenderFaceCamera } from '../types';

const spec = (over: Partial<RenderFaceCamera> = {}): RenderFaceCamera => ({ pivot: [2, 0, 0], axis: [0, 0, 1], front: [0, -1, 0], shadowsFaceSun: false, ...over });

describe('faceCameraAngle', () => {
  it('turns the front toward the camera about the axis', () => {
    expect(faceCameraAngle([0, 0, 1], [0, -1, 0], [0, -5, 3])).toBeCloseTo(0, 12);
    expect(faceCameraAngle([0, 0, 1], [0, -1, 0], [5, 0, 1])).toBeCloseTo(Math.PI / 2, 12);
    expect(Math.abs(faceCameraAngle([0, 0, 1], [0, -1, 0], [0, 4, 0]))).toBeCloseTo(Math.PI, 12);
  });

  it('leaves the placement as it is for a camera along the axis', () => {
    expect(faceCameraAngle([0, 0, 1], [0, -1, 0], [0, 0, 10])).toBe(0);
  });
});

describe('applyFaceCamera', () => {
  const view = { eye: [7, 0, 1] as const, forward: [-1, 0, 0] as const, parallel: false };

  it('turns the group about the pivot (relative to the floating origin) and puts it back without a spec', () => {
    const group = new Group(), mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    group.add(mesh);
    applyFaceCamera(group, [mesh], spec(), view, null, [1, 0, 0]);
    expect(group.matrixAutoUpdate).toBe(false);
    // pivot (2,0,0) is (1,0,0) relative to the origin; the front (−y) turns toward +x, where the eye is
    const front = new Vector3(0, -1, 0).transformDirection(group.matrix);
    expect(front.x).toBeCloseTo(1, 12);
    const pivot = new Vector3(1, 0, 0).applyMatrix4(group.matrix);
    expect(pivot.toArray().map((v) => +v.toFixed(12))).toEqual([1, 0, 0]);
    applyFaceCamera(group, [mesh], undefined, view, null, [1, 0, 0]);
    expect(group.matrixAutoUpdate).toBe(true);
    expect(group.matrix.equals(new Matrix4())).toBe(true);
  });

  it('faces against the view direction in parallel projection', () => {
    const group = new Group(), mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    group.add(mesh);
    applyFaceCamera(group, [mesh], spec(), { eye: [0, 0, 0], forward: [0, -1, 0], parallel: true }, null, [0, 0, 0]);
    expect(new Vector3(0, -1, 0).transformDirection(group.matrix).y).toBeCloseTo(1, 12);
  });

  it('casts the shadow turned toward the sun with Shadows Face Sun', () => {
    const parent = new Group(), group = new Group(), mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    parent.add(group);
    group.add(mesh);
    applyFaceCamera(group, [mesh], spec({ pivot: [0, 0, 0], shadowsFaceSun: true }), view, [0, 1, 0], [0, 0, 0]);
    parent.updateMatrixWorld(true);
    const shadowCamera = new OrthographicCamera();
    shadowCamera.updateMatrixWorld(true);
    mesh.modelViewMatrix.identity();
    mesh.onBeforeShadow(null as unknown as WebGLRenderer, null as never, shadowCamera, shadowCamera, mesh.geometry, mesh.material, null as never);
    // the sun is toward +y, so the front (−y) is turned to +y in the shadow pass, unlike the camera turn (+x)
    const front = new Vector3(0, -1, 0).transformDirection(new Matrix4().copy(shadowCamera.matrixWorld).multiply(mesh.modelViewMatrix));
    expect(front.y).toBeCloseTo(1, 12);
    // without it the shadow pass keeps the drawn turn
    applyFaceCamera(group, [mesh], spec({ pivot: [0, 0, 0] }), view, [0, 1, 0], [0, 0, 0]);
    mesh.modelViewMatrix.identity();
    mesh.onBeforeShadow(null as unknown as WebGLRenderer, null as never, shadowCamera, shadowCamera, mesh.geometry, mesh.material, null as never);
    expect(mesh.modelViewMatrix.equals(new Matrix4())).toBe(true);
  });
});
