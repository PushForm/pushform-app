// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { OverlayCircle, OverlayPrimitive, OverlayPoint, OverlayPolygon, OverlayPolyline, OverlayLabel } from '@pushform/commands';
import { planeBasis } from '@pushform/core';
import type { Vec3 } from '@pushform/core';
import { triangulatePlanarFace } from '@pushform/geom';
import { loopBasis } from '../renderables/HighlightLayer';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  OrthographicCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
} from 'three';
import type { Camera, WebGLRenderer, Object3D } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { Text } from 'troika-three-text';

const SHAPE_INDEX: Record<OverlayPoint['shape'], number> = { square: 0, circle: 1, diamond: 2, cross: 3, x: 4 };

/** Segments of a circle overlay: the ring plus optional radial ticks (every 4th tick is longer). */
export function circleSegments(c: Pick<OverlayCircle, 'center' | 'normal' | 'radius' | 'ticks'>, ringSegments = 72): Vec3[][] {
  const b = planeBasis(c.center, c.normal);
  const at = (angle: number, r: number): Vec3 => [
    c.center[0] + (b.u[0] * Math.cos(angle) + b.v[0] * Math.sin(angle)) * r,
    c.center[1] + (b.u[1] * Math.cos(angle) + b.v[1] * Math.sin(angle)) * r,
    c.center[2] + (b.u[2] * Math.cos(angle) + b.v[2] * Math.sin(angle)) * r,
  ];
  const out: Vec3[][] = [];
  for (let i = 0; i < ringSegments; i++) {
    out.push([at((i / ringSegments) * Math.PI * 2, c.radius), at(((i + 1) / ringSegments) * Math.PI * 2, c.radius)]);
  }
  const ticks = c.ticks ?? 0;
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * Math.PI * 2;
    const major = ticks % 4 === 0 && i % (ticks / 4) === 0;
    out.push([at(a, c.radius * (major ? 0.82 : 0.9)), at(a, c.radius)]);
  }
  return out;
}

/** The 12 edges of an axis-aligned box. */
export function boxSegments(min: Vec3, max: Vec3): Vec3[][] {
  const c = (i: number): Vec3 => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const pairs: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  return pairs.map(([a, b]) => [c(a), c(b)]);
}

/**
 * Triangles (flat xyz, relative to `origin`) filling a planar overlay polygon: earcut over the
 * outline and its holes, so concave outlines stay inside and holes stay open.
 */
export function polygonTriangles(p: Pick<OverlayPolygon, 'points' | 'holes'>, origin: Vec3): Float32Array {
  if (p.points.length < 3) return new Float32Array(0);
  const basis = loopBasis(p.points);
  if (!basis) return new Float32Array(0);
  const rings = [p.points, ...(p.holes ?? []).filter((h) => h.length >= 3)];
  const tri = triangulatePlanarFace(rings, basis);
  const out = new Float32Array(tri.indices.length * 3);
  for (let i = 0; i < tri.indices.length; i++) {
    const v = tri.indices[i]! * 3;
    out[i * 3] = tri.positions[v]! - origin[0];
    out[i * 3 + 1] = tri.positions[v + 1]! - origin[1];
    out[i * 3 + 2] = tri.positions[v + 2]! - origin[2];
  }
  return out;
}

/**
 * Renders tool overlay primitives in two extra passes: a world-space scene (depth test off) using
 * the main camera, and a screen-space scene (pixel orthographic camera) for screen rects.
 * Cursor hints are DOM elements, handled by the UI.
 */
export class OverlayLayer {
  readonly worldScene = new Scene();
  readonly screenScene = new Scene();
  private screenCamera = new OrthographicCamera(0, 1, 0, 1, -1, 1);
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private origin: Vec3 = [0, 0, 0];
  private disposables: { dispose(): void }[] = [];
  private labels: Text[] = [];
  private pointMaterial: ShaderMaterial;

  constructor() {
    this.pointMaterial = new ShaderMaterial({
      uniforms: { uPixelRatio: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 color;
        attribute float shape;
        attribute float size;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vShape;
        void main() {
          vColor = color;
          vShape = shape;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uPixelRatio;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vColor;
        varying float vShape;
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0; // -1..1
          float a = 0.0;
          float s = vShape;
          if (s < 0.5) { a = 1.0; }                                  // square
          else if (s < 1.5) { a = length(p) <= 1.0 ? 1.0 : 0.0; }     // circle
          else if (s < 2.5) { a = (abs(p.x) + abs(p.y)) <= 1.0 ? 1.0 : 0.0; } // diamond
          else if (s < 3.5) { a = (abs(p.x) < 0.2 || abs(p.y) < 0.2) ? 1.0 : 0.0; } // cross
          else { a = (abs(p.x - p.y) < 0.28 || abs(p.x + p.y) < 0.28) ? 1.0 : 0.0; } // x
          if (a < 0.5) discard;
          gl_FragColor = vec4(vColor, 1.0);
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: NormalBlending,
    });
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;
    this.screenCamera.left = 0;
    this.screenCamera.right = width;
    this.screenCamera.top = 0;
    this.screenCamera.bottom = height;
    this.screenCamera.updateProjectionMatrix();
    const u = this.pointMaterial.uniforms['uPixelRatio'];
    if (u) u.value = pixelRatio;
  }

  setOrigin(origin: Vec3): void {
    this.origin = origin;
  }

  /** Rebuild the overlay objects from primitives. Cheap enough for tool-rate updates. */
  set(prims: readonly OverlayPrimitive[], camera: Camera, worldPerPixelAt: (p: Vec3) => number): void {
    this.clear();
    const points: OverlayPoint[] = [];
    for (const p of prims) {
      switch (p.kind) {
        case 'point':
          points.push(p);
          break;
        case 'polyline':
          this.addPolyline(p);
          break;
        case 'polygon':
          this.addPolygon(p);
          break;
        case 'label':
          this.addLabel(p, camera, worldPerPixelAt);
          break;
        case 'screenRect':
          this.addScreenRect(p.a, p.b, p.color, !!p.dashed);
          break;
        case 'screenPolyline':
          this.addScreenPolyline(p.points, p.color, !!p.dashed, !!p.closed);
          break;
        case 'circle':
          this.addSegments(circleSegments(p), p.color, p.width ?? 1.5, !!p.dashed);
          break;
        case 'box':
          this.addSegments(boxSegments(p.min, p.max), p.color, p.width ?? 1.5, !!p.dashed);
          break;
        case 'cursorHint':
          break; // DOM
      }
    }
    if (points.length) this.addPoints(points);
  }

  render(renderer: WebGLRenderer, camera: Camera): void {
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    for (const l of this.labels) l.quaternion.copy(camera.quaternion);
    renderer.render(this.worldScene, camera);
    renderer.clearDepth();
    renderer.render(this.screenScene, this.screenCamera);
    renderer.autoClear = autoClear;
  }

  clear(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    for (const l of this.labels) l.dispose();
    this.labels = [];
    this.worldScene.clear();
    this.screenScene.clear();
  }

  dispose(): void {
    this.clear();
    this.pointMaterial.dispose();
  }

  // --- builders ---------------------------------------------------------------------------------

  private rel(p: Vec3): [number, number, number] {
    return [p[0] - this.origin[0], p[1] - this.origin[1], p[2] - this.origin[2]];
  }

  private addPoints(points: OverlayPoint[]): void {
    const n = points.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const shape = new Float32Array(n);
    const size = new Float32Array(n);
    const c = new Color();
    points.forEach((p, i) => {
      const r = this.rel(p.position);
      pos[i * 3] = r[0]; pos[i * 3 + 1] = r[1]; pos[i * 3 + 2] = r[2];
      c.set(p.color);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      shape[i] = SHAPE_INDEX[p.shape];
      size[i] = p.size ?? 8;
    });
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('color', new BufferAttribute(col, 3));
    g.setAttribute('shape', new BufferAttribute(shape, 1));
    g.setAttribute('size', new BufferAttribute(size, 1));
    const obj = new Points(g, this.pointMaterial);
    obj.frustumCulled = false;
    obj.renderOrder = 10;
    this.track(obj, this.worldScene, g);
  }

  private lineMaterial(color: string, width: number, dashed: boolean): LineMaterial {
    const m = new LineMaterial({
      color: new Color(color).getHex(),
      linewidth: width,
      dashed,
      dashSize: 6,
      gapSize: 4,
      dashScale: 1,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      worldUnits: false,
    });
    m.resolution = new Vector2(this.width, this.height);
    this.disposables.push(m);
    return m;
  }

  private addPolyline(p: OverlayPolyline): void {
    if (p.points.length < 2) return;
    const pts = p.closed ? [...p.points, p.points[0]!] : p.points;
    const arr = new Float32Array((pts.length - 1) * 6);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = this.rel(pts[i]!), b = this.rel(pts[i + 1]!);
      arr.set([a[0], a[1], a[2], b[0], b[1], b[2]], i * 6);
    }
    const g = new LineSegmentsGeometry();
    g.setPositions(arr);
    const line = new LineSegments2(g, this.lineMaterial(p.color, p.width ?? 1.5, !!p.dashed));
    line.computeLineDistances();
    line.frustumCulled = false;
    line.renderOrder = 5;
    this.track(line, this.worldScene, g);
  }

  /** Independent segments (circle rings, ticks, box edges) as one fat-line object. */
  private addSegments(segs: readonly (readonly Vec3[])[], color: string, width: number, dashed: boolean): void {
    if (segs.length === 0) return;
    const arr = new Float32Array(segs.length * 6);
    segs.forEach((s, i) => {
      const a = this.rel(s[0]!), b = this.rel(s[1]!);
      arr.set([a[0], a[1], a[2], b[0], b[1], b[2]], i * 6);
    });
    const g = new LineSegmentsGeometry();
    g.setPositions(arr);
    const line = new LineSegments2(g, this.lineMaterial(color, width, dashed));
    line.computeLineDistances();
    line.frustumCulled = false;
    line.renderOrder = 5;
    this.track(line, this.worldScene, g);
  }

  private addPolygon(p: OverlayPolygon): void {
    const pos = polygonTriangles(p, this.origin);
    if (pos.length === 0) return;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    const m = new MeshBasicMaterial({
      color: new Color(p.color),
      transparent: true,
      opacity: p.opacity ?? 0.25,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      blending: NormalBlending,
    });
    this.disposables.push(m);
    const mesh = new Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    this.track(mesh, this.worldScene, g);
  }

  private addLabel(p: OverlayLabel, _camera: Camera, worldPerPixelAt: (q: Vec3) => number): void {
    const t = new Text();
    t.text = p.text;
    t.color = p.color ?? '#1a1a1a';
    t.anchorX = 'left';
    t.anchorY = 'bottom';
    t.outlineWidth = '12%';
    t.outlineColor = '#ffffff';
    const wpp = worldPerPixelAt(p.position);
    t.fontSize = 13 * wpp;
    const r = this.rel(p.position);
    const off = p.offset ?? [8, 8];
    t.position.set(r[0], r[1], r[2]);
    // Offset in screen pixels along camera right/up is applied after billboarding; approximate here.
    t.position.x += off[0] * wpp * 0;
    (t.material as { depthTest?: boolean }).depthTest = false;
    t.renderOrder = 20;
    t.sync();
    this.labels.push(t);
    this.worldScene.add(t);
  }

  private addScreenRect(a: readonly [number, number], b: readonly [number, number], color: string, dashed: boolean): void {
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
    const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    const arr = new Float32Array([x0, y0, 0, x1, y0, 0, x1, y0, 0, x1, y1, 0, x1, y1, 0, x0, y1, 0, x0, y1, 0, x0, y0, 0]);
    const g = new LineSegmentsGeometry();
    g.setPositions(arr);
    const line = new LineSegments2(g, this.lineMaterial(color, 1.5, dashed));
    line.computeLineDistances();
    line.frustumCulled = false;
    this.track(line, this.screenScene, g);
    const fill = new Mesh(
      new BufferGeometry().setAttribute(
        'position',
        new BufferAttribute(new Float32Array([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0]), 3),
      ),
      new MeshBasicMaterial({ color: new Color(color), transparent: true, opacity: 0.08, depthTest: false, side: DoubleSide, blending: AdditiveBlending }),
    );
    this.disposables.push(fill.material, fill.geometry);
    this.screenScene.add(fill);
  }

  private addScreenPolyline(points: readonly (readonly [number, number])[], color: string, dashed: boolean, closed: boolean): void {
    if (points.length < 2) return;
    const pts = closed ? [...points, points[0]!] : points;
    const arr = new Float32Array((pts.length - 1) * 6);
    for (let i = 0; i < pts.length - 1; i++) arr.set([pts[i]![0], pts[i]![1], 0, pts[i + 1]![0], pts[i + 1]![1], 0], i * 6);
    const g = new LineSegmentsGeometry();
    g.setPositions(arr);
    const line = new LineSegments2(g, this.lineMaterial(color, 1.5, dashed));
    line.computeLineDistances();
    line.frustumCulled = false;
    this.track(line, this.screenScene, g);
  }

  private track(obj: Object3D, scene: Scene, ...disposables: { dispose(): void }[]): void {
    this.disposables.push(...disposables);
    scene.add(obj);
  }
}
