// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { BufferGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial, LineDashedMaterial, Matrix4, Vector3 } from 'three';
import type { RenderAxes } from '../types';
import { DEFAULT_RENDER_AXES } from '../types';

/**
 * Draw order of each axis line. It is set on the lines, not on this group: three.js sorts by a
 * group's render order before any object's own, so a group order below the sky background's
 * would draw the axes first and the sky (which ignores depth) would paint over them.
 */
const AXES_RENDER_ORDER = -5;

/**
 * Model axes: red X, green Y, blue Z; solid positive halves, dotted negative halves.
 * `setAxes` moves/rotates the gizmo to the drawing axes; `setOrigin` applies the floating origin.
 */
export class Axes extends Group {
  axes: RenderAxes = DEFAULT_RENDER_AXES;
  private floatingOrigin: readonly [number, number, number] = [0, 0, 0];

  constructor(length = 1000) {
    super();
    this.name = 'Axes';
    const axes: { dir: [number, number, number]; color: number }[] = [
      { dir: [1, 0, 0], color: 0xd0342c },
      { dir: [0, 1, 0], color: 0x2fa84f },
      { dir: [0, 0, 1], color: 0x2a6fd6 },
    ];
    for (const { dir, color } of axes) {
      const pos = new BufferGeometry();
      pos.setAttribute('position', new Float32BufferAttribute([0, 0, 0, dir[0] * length, dir[1] * length, dir[2] * length], 3));
      const posLine = new Line(pos, new LineBasicMaterial({ color, depthTest: true }));
      posLine.frustumCulled = false;
      posLine.renderOrder = AXES_RENDER_ORDER;
      this.add(posLine);

      const neg = new BufferGeometry();
      neg.setAttribute('position', new Float32BufferAttribute([0, 0, 0, -dir[0] * length, -dir[1] * length, -dir[2] * length], 3));
      const negLine = new Line(neg, new LineDashedMaterial({ color, dashSize: 0.12, gapSize: 0.12, depthTest: true }));
      negLine.computeLineDistances();
      negLine.frustumCulled = false;
      negLine.renderOrder = AXES_RENDER_ORDER;
      this.add(negLine);
    }
  }

  /** Place the gizmo at the drawing axes (world origin + unit x/y/z). */
  setAxes(axes: RenderAxes): void {
    this.axes = axes;
    this.apply();
  }

  /** Floating render origin (geometry is drawn relative to it). */
  setOrigin(x: number, y: number, z: number): void {
    this.floatingOrigin = [x, y, z];
    this.apply();
  }

  private apply(): void {
    const { origin, x, y, z } = this.axes;
    const o = this.floatingOrigin;
    this.position.set(origin[0] - o[0], origin[1] - o[1], origin[2] - o[2]);
    const m = new Matrix4().makeBasis(new Vector3(x[0], x[1], x[2]), new Vector3(y[0], y[1], y[2]), new Vector3(z[0], z[1], z[2]));
    this.quaternion.setFromRotationMatrix(m);
    this.updateMatrix();
  }

  dispose(): void {
    for (const c of this.children) {
      const line = c as Line;
      line.geometry.dispose();
      (line.material as LineBasicMaterial).dispose();
    }
  }
}
