// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import { BufferAttribute, BufferGeometry, Color, Group, Points, ShaderMaterial } from 'three';
import type { EdgeSegments, RenderGuides } from '../types';
import { EMPTY_GUIDES } from '../types';
import { EdgeBatch } from './EdgeBatch';
import { createEdgeMaterial, DEFAULT_EDGE_WIDTH } from './EdgeMaterial';
import type { EdgeMaterial } from './EdgeMaterial';

/** Half-length of the segment that stands in for an infinite guide line (world units). */
export const GUIDE_EXTENT = 1e4;
/** Default guide color (the style's "Guides" modeling color: dark grey). */
export const GUIDE_COLOR = 0x4d4d4d;
/** Guide point glyph (×) size in CSS px. */
export const GUIDE_POINT_SIZE = 9;

/** Plain-array geometry of a guide set, origin-relative (testable without WebGL). */
export interface GuideGeometry {
  /** Dashed segments: infinite lines clipped to ±GUIDE_EXTENT around their point, then finite segments. */
  readonly lines: EdgeSegments;
  /** Guide point positions [x,y,z,...]. */
  readonly points: Float32Array;
}

export function buildGuideGeometry(guides: RenderGuides, origin: Vec3, extent = GUIDE_EXTENT): GuideGeometry {
  const pos: number[] = [];
  const push = (p: Vec3) => pos.push(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
  for (const l of guides.lines) {
    const len = Math.hypot(l.dir[0], l.dir[1], l.dir[2]);
    if (len === 0) continue;
    const d: Vec3 = [(l.dir[0] / len) * extent, (l.dir[1] / len) * extent, (l.dir[2] / len) * extent];
    push([l.p[0] - d[0], l.p[1] - d[1], l.p[2] - d[2]]);
    push([l.p[0] + d[0], l.p[1] + d[1], l.p[2] + d[2]]);
  }
  for (const s of guides.segments ?? []) {
    push(s.a);
    push(s.b);
  }
  const n = pos.length / 6;
  const normalA = new Float32Array(n * 3);
  const normalB = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    normalA[i * 3 + 2] = 1;
    normalB[i * 3 + 2] = 1;
  }
  const pts: number[] = [];
  for (const p of guides.points) pts.push(p.p[0] - origin[0], p.p[1] - origin[1], p.p[2] - origin[2]);
  return {
    lines: { positions: new Float32Array(pos), normalA, normalB, flags: new Uint8Array(n) },
    points: new Float32Array(pts),
  };
}

/**
 * Construction guides of the edit context: dashed thin lines (an infinite line is a long segment
 * around its anchor) and × glyphs for guide points. Depth-tested like edges.
 */
export class GuideLayer {
  readonly group = new Group();
  readonly lineMaterial: EdgeMaterial;
  readonly pointMaterial: ShaderMaterial;
  readonly lines: EdgeBatch;
  readonly points: Points;
  guides: RenderGuides = EMPTY_GUIDES;
  private origin: Vec3 = [0, 0, 0];

  constructor(color = GUIDE_COLOR) {
    this.group.name = 'Guides';
    this.lineMaterial = createEdgeMaterial({ width: DEFAULT_EDGE_WIDTH, profileWidth: DEFAULT_EDGE_WIDTH, dashed: true, color });
    this.lineMaterial.dashSize = 5;
    this.lineMaterial.gapSize = 4;
    this.pointMaterial = new ShaderMaterial({
      uniforms: { uSize: { value: GUIDE_POINT_SIZE }, uColor: { value: new Color(color) } },
      vertexShader: /* glsl */ `
        uniform float uSize;
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uSize;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColor;
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          if (abs(p.x - p.y) > 0.3 && abs(p.x + p.y) > 0.3) discard;
          gl_FragColor = vec4(uColor, 1.0);
        }
      `,
      transparent: false,
      depthTest: true,
      depthWrite: false,
    });
    this.lines = new EdgeBatch(this.lineMaterial);
    this.lines.name = 'GuideLines';
    this.points = new Points(new BufferGeometry(), this.pointMaterial);
    this.points.name = 'GuidePoints';
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.group.add(this.lines, this.points);
  }

  /** Replace the guides; returns true when anything changed (compared by object identity). */
  set(guides: RenderGuides | null, origin: Vec3 = this.origin): boolean {
    const next = guides ?? EMPTY_GUIDES;
    if (next === this.guides && origin === this.origin) return false;
    this.guides = next;
    this.origin = origin;
    const g = buildGuideGeometry(next, origin);
    this.lines.setSegments(g.lines);
    this.points.geometry.dispose();
    const pg = new BufferGeometry();
    pg.setAttribute('position', new BufferAttribute(g.points, 3));
    this.points.geometry = pg;
    this.points.visible = g.points.length > 0;
    return true;
  }

  get isEmpty(): boolean {
    return this.lines.segmentCount === 0 && !this.points.visible;
  }

  setColor(hex: number): void {
    this.lineMaterial.setColorHex(hex);
    (this.pointMaterial.uniforms['uColor']?.value as Color | undefined)?.set(hex);
  }

  setResolution(width: number, height: number, pixelRatio: number): void {
    this.lineMaterial.resolution.set(width, height);
    const u = this.pointMaterial.uniforms['uSize'];
    if (u) u.value = GUIDE_POINT_SIZE * pixelRatio;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.points.geometry.dispose();
    this.lineMaterial.dispose();
    this.pointMaterial.dispose();
    this.group.clear();
  }
}
