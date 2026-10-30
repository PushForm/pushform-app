// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { DoubleSide, Matrix4, Mesh, PlaneGeometry, ShaderMaterial, Color, Vector3 } from 'three';
import type { RenderAxes } from '../types';
import { DEFAULT_RENDER_AXES } from '../types';

/**
 * Large ground plane with a shader grid (minor/major lines) that fades with distance. The plane
 * lies in the drawing axes' XY plane through their origin (`setAxes`), so grid lines follow a
 * relocated axes gizmo; `setOrigin` applies the floating render origin. Toggle with `visible`.
 */
export class GroundGrid extends Mesh<PlaneGeometry, ShaderMaterial> {
  axes: RenderAxes = DEFAULT_RENDER_AXES;
  private floatingOrigin: readonly [number, number, number] = [0, 0, 0];

  constructor(opts: { spacing?: number; majorEvery?: number; extent?: number; fade?: number } = {}) {
    const spacing = opts.spacing ?? 1;
    const major = opts.majorEvery ?? 10;
    const extent = opts.extent ?? 4000;
    const fade = opts.fade ?? 120;
    const material = new ShaderMaterial({
      uniforms: {
        uSpacing: { value: spacing },
        uMajor: { value: major },
        uFade: { value: fade },
        uMinorColor: { value: new Color(0x9aa3ad) },
        uMajorColor: { value: new Color(0x6b7681) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        varying vec2 vLocal;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          vLocal = position.xy;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uSpacing, uMajor, uFade;
        uniform vec3 uMinorColor, uMajorColor;
        varying vec3 vWorld;
        varying vec2 vLocal;
        float gridLine(vec2 c) {
          vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
          return 1.0 - min(min(g.x, g.y), 1.0);
        }
        void main() {
          vec2 p = vLocal;
          float minor = gridLine(p / uSpacing);
          float majorL = gridLine(p / (uSpacing * uMajor));
          float d = distance(vWorld, cameraPosition);
          float fadeF = 1.0 - smoothstep(uFade * 0.25, uFade, d);
          float a = max(minor * 0.35, majorL * 0.6) * fadeF;
          vec3 col = mix(uMinorColor, uMajorColor, majorL);
          if (a < 0.01) discard;
          gl_FragColor = vec4(col, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    super(new PlaneGeometry(extent, extent, 1, 1), material);
    this.renderOrder = -10;
    this.frustumCulled = false;
    this.name = 'GroundGrid';
  }

  /** Align the grid plane with the drawing axes (lines pass through their origin). */
  setAxes(axes: RenderAxes): void {
    this.axes = axes;
    this.apply();
  }

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
}
