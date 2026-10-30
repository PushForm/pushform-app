// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Matrix4, Mesh, MeshBasicMaterial, Vector2, Vector3 } from 'three';
import type { Camera } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { Text } from 'troika-three-text';
import type { RenderDimension, RenderDimensions } from '../types';
import { EMPTY_DIMENSIONS } from '../types';
import { palette } from './palette';
import { textArrowGeometry } from './TextLayer';

/** Default dimension color. */
export const DIMENSION_COLOR = 0x000000;
/** Arrowhead length and width in CSS px. */
export const DIMENSION_ARROW_PX = { length: 10, width: 6 } as const;
/** Screen pixels per text point, at 96 px per inch. */
const PX_PER_PT = 96 / 72;
/** troika font size before per-frame scaling (world units); the mesh is scaled to the wanted screen size. */
const BASE_FONT = 1;

/** Line segment positions of a set of dimensions, origin-relative, split by selection (testable without WebGL). */
export function buildDimensionLines(items: readonly RenderDimension[], origin: Vec3): { normal: Float32Array; selected: Float32Array } {
  const normal: number[] = [], selected: number[] = [];
  for (const d of items) {
    const out = d.selected ? selected : normal;
    for (const [a, b] of d.lines) out.push(a[0] - origin[0], a[1] - origin[1], a[2] - origin[2], b[0] - origin[0], b[1] - origin[1], b[2] - origin[2]);
  }
  return { normal: new Float32Array(normal), selected: new Float32Array(selected) };
}

/**
 * Arrowhead triangles facing the camera, sized in screen pixels at each tip: the tip, then two base corners a
 * length back along the line and half a width to either side across it.
 */
export function buildArrowTriangles(arrows: ReadonlyArray<{ tip: Vec3; back: Vec3 }>, origin: Vec3, view: Vec3, wppAt: (p: Vec3) => number): Float32Array {
  const out = new Float32Array(arrows.length * 9);
  arrows.forEach(({ tip, back }, i) => {
    const wpp = wppAt(tip);
    // Across the line, in the plane facing the camera; a line pointing at the camera has no visible arrow.
    let across: Vec3 = [back[1] * view[2] - back[2] * view[1], back[2] * view[0] - back[0] * view[2], back[0] * view[1] - back[1] * view[0]];
    const len = Math.hypot(across[0], across[1], across[2]);
    across = len > 1e-9 ? [across[0] / len, across[1] / len, across[2] / len] : [0, 0, 0];
    const l = DIMENSION_ARROW_PX.length * wpp, w = (DIMENSION_ARROW_PX.width / 2) * wpp;
    const base: Vec3 = [tip[0] + back[0] * l, tip[1] + back[1] * l, tip[2] + back[2] * l];
    out.set([
      tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2],
      base[0] + across[0] * w - origin[0], base[1] + across[1] * w - origin[1], base[2] + across[2] * w - origin[2],
      base[0] - across[0] * w - origin[0], base[1] - across[1] * w - origin[1], base[2] - across[2] * w - origin[2],
    ], i * 9);
  });
  return out;
}

/**
 * Endpoints of dimensions in one color, sized in screen pixels at each tip: filled triangles (closed arrows,
 * dots) and line segments (open arrows, slashes), origin-relative.
 */
export function buildDimensionEndpoints(items: readonly RenderDimension[], origin: Vec3, view: Vec3, wppAt: (p: Vec3) => number): { triangles: Float32Array; segments: Float32Array } {
  const triangles: number[] = [], segments: number[] = [];
  const push = (out: number[], points: readonly Vec3[]) => { for (const p of points) out.push(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]); };
  for (const d of items) {
    for (const { tip, back } of d.arrows) {
      const g = textArrowGeometry(d.arrow ?? 'closed', tip, back, view, wppAt(tip));
      push(triangles, g.triangles);
      push(segments, g.segments);
    }
  }
  return { triangles: new Float32Array(triangles), segments: new Float32Array(segments) };
}

/**
 * Where text along a dimension line sits and which way it reads, for a camera looking along `view` with
 * screen `right` and `up`: it reads left to right (bottom to top when the line is vertical on screen), faces the camera,
 * and sits on the line (centered), beside it on the text's top side (above), or on the side away from the measured
 * points (outside), `gap` world units from the line to the text's middle.
 */
export function alignedTextFrame(aligned: NonNullable<RenderDimension['aligned']>, at: Vec3, view: Vec3, right: Vec3, up: Vec3, gap: number): { x: Vec3; y: Vec3; z: Vec3; position: Vec3 } {
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const sideways = dot(aligned.along, right);
  const x = sideways < -1e-6 || (Math.abs(sideways) <= 1e-6 && dot(aligned.along, up) < 0) ? neg(aligned.along) : aligned.along;
  let y = aligned.out;
  // Face the camera: the text's front (x × y) points back along the view.
  if (dot(cross(x, y), view) > 0) y = neg(y);
  const z = cross(x, y);
  const shift = aligned.position === 'centered' ? 0 : gap;
  const toward = aligned.position === 'outside' ? aligned.out : y;
  return { x, y, z, position: [at[0] + toward[0] * shift, at[1] + toward[1] * shift, at[2] + toward[2] * shift] };
}

/**
 * Dimensions of the model: extension lines, dimension lines and leaders as 1 px lines, arrowheads and text
 * that keep their screen size as the camera moves, depth-tested like edges. Selected dimensions draw in the
 * selection color.
 */
export class DimensionLayer {
  readonly group = new Group();
  dimensions: RenderDimensions = EMPTY_DIMENSIONS;
  private origin: Vec3 = [0, 0, 0];
  private readonly lineMaterials: [LineMaterial, LineMaterial];
  private readonly lines: [LineSegments2, LineSegments2];
  private readonly arrowMaterials: [MeshBasicMaterial, MeshBasicMaterial];
  private readonly arrows: [Mesh<BufferGeometry, MeshBasicMaterial>, Mesh<BufferGeometry, MeshBasicMaterial>];
  /** Open arrows and slashes, laid out every frame like the filled endpoints. */
  private readonly endpointLines: [LineSegments2, LineSegments2];
  private labels: Text[] = [];
  /** Resolves once every label's text has been laid out (troika lays text out asynchronously). */
  ready: Promise<void> = Promise.resolve();

  constructor() {
    this.group.name = 'Dimensions';
    const colors = [DIMENSION_COLOR, palette.select.getHex()] as const;
    this.lineMaterials = colors.map((color) => new LineMaterial({ color, linewidth: 1, worldUnits: false, depthTest: true, depthWrite: false })) as [LineMaterial, LineMaterial];
    this.lines = this.lineMaterials.map((m) => {
      const line = new LineSegments2(new LineSegmentsGeometry(), m);
      line.frustumCulled = false;
      line.visible = false;
      return line;
    }) as [LineSegments2, LineSegments2];
    this.arrowMaterials = colors.map((color) => new MeshBasicMaterial({ color: new Color(color), side: DoubleSide, depthWrite: false })) as [MeshBasicMaterial, MeshBasicMaterial];
    this.arrows = this.arrowMaterials.map((m) => {
      const mesh = new Mesh(new BufferGeometry(), m);
      mesh.frustumCulled = false;
      mesh.visible = false;
      return mesh;
    }) as [Mesh<BufferGeometry, MeshBasicMaterial>, Mesh<BufferGeometry, MeshBasicMaterial>];
    this.endpointLines = this.lineMaterials.map((m) => {
      const line = new LineSegments2(new LineSegmentsGeometry(), m);
      line.frustumCulled = false;
      line.visible = false;
      return line;
    }) as [LineSegments2, LineSegments2];
    this.group.add(...this.lines, ...this.arrows, ...this.endpointLines);
  }

  /** Replace the dimensions; returns true when anything changed (compared by object identity). */
  set(dimensions: RenderDimensions | null, origin: Vec3 = this.origin): boolean {
    const next = dimensions ?? EMPTY_DIMENSIONS;
    if (next === this.dimensions && origin === this.origin) return false;
    this.dimensions = next;
    this.origin = origin;
    const { normal, selected } = buildDimensionLines(next.items, origin);
    [normal, selected].forEach((positions, i) => {
      const line = this.lines[i]!;
      line.geometry.dispose();
      const g = new LineSegmentsGeometry();
      if (positions.length) g.setPositions(positions);
      line.geometry = g;
      line.visible = positions.length > 0;
    });
    // update() lays the endpoints out, but skips an empty set: hide the previous set's here.
    for (const [i, selected] of [false, true].entries()) {
      this.arrows[i]!.visible = next.items.some((d) => d.selected === selected && d.arrows.length > 0);
      this.endpointLines[i]!.visible = false;
    }
    for (const label of this.labels) { this.group.remove(label); label.dispose(); }
    this.labels = next.items.map((d) => {
      const t = new Text();
      t.text = d.text;
      t.fontSize = BASE_FONT;
      t.anchorX = 'center';
      t.anchorY = 'middle';
      t.color = d.selected ? palette.select.getHex() : DIMENSION_COLOR;
      t.outlineWidth = '12%';
      t.outlineColor = '#ffffff';
      t.position.set(d.textAt[0] - origin[0], d.textAt[1] - origin[1], d.textAt[2] - origin[2]);
      (t.material as { depthWrite?: boolean }).depthWrite = false;
      t.renderOrder = 6;
      this.group.add(t);
      return t;
    });
    this.ready = Promise.all(this.labels.map((t) => new Promise<void>((resolve) => t.sync(() => resolve())))).then(() => undefined);
    return true;
  }

  /**
   * Per frame: turn the text to face the camera, or along its dimension line, and size text and endpoints in
   * screen pixels.
   */
  update(camera: Camera, wppAt: (p: Vec3) => number): void {
    const items = this.dimensions.items;
    if (items.length === 0) return;
    const forward = new Vector3();
    camera.getWorldDirection(forward);
    const view: Vec3 = [forward.x, forward.y, forward.z];
    const r = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0), u = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const right: Vec3 = [r.x, r.y, r.z], up: Vec3 = [u.x, u.y, u.z];
    const basis = new Matrix4();
    items.forEach((d, i) => {
      const label = this.labels[i];
      if (!label) return;
      const em = wppAt(d.textAt) * d.fontSizePt * PX_PER_PT;
      const scale = em / BASE_FONT;
      label.scale.set(scale, scale, scale);
      if (!d.aligned) {
        label.quaternion.copy(camera.quaternion);
        return;
      }
      // Half the text's height plus a few pixels clear of the line.
      const frame = alignedTextFrame(d.aligned, d.textAt, view, right, up, em * 0.6 + wppAt(d.textAt) * 3);
      basis.makeBasis(new Vector3(...frame.x), new Vector3(...frame.y), new Vector3(...frame.z));
      label.quaternion.setFromRotationMatrix(basis);
      label.position.set(frame.position[0] - this.origin[0], frame.position[1] - this.origin[1], frame.position[2] - this.origin[2]);
    });
    for (const [i, selected] of [false, true].entries()) {
      const { triangles, segments } = buildDimensionEndpoints(items.filter((d) => d.selected === selected), this.origin, view, wppAt);
      const mesh = this.arrows[i]!;
      mesh.visible = triangles.length > 0;
      if (triangles.length) {
        const g = mesh.geometry as BufferGeometry;
        g.setAttribute('position', new BufferAttribute(triangles, 3));
        g.computeBoundingSphere();
      }
      const line = this.endpointLines[i]!;
      line.visible = segments.length > 0;
      if (segments.length) {
        line.geometry.dispose();
        const g = new LineSegmentsGeometry();
        g.setPositions(segments);
        line.geometry = g;
      }
    }
  }

  get isEmpty(): boolean {
    return this.dimensions.items.length === 0;
  }

  /** Line widths are CSS pixels, as in the overlay. */
  setResolution(width: number, height: number): void {
    for (const m of this.lineMaterials) m.resolution = new Vector2(width, height);
  }

  dispose(): void {
    for (const label of this.labels) label.dispose();
    this.labels = [];
    for (const line of [...this.lines, ...this.endpointLines]) line.geometry.dispose();
    for (const mesh of this.arrows) mesh.geometry.dispose();
    for (const m of this.lineMaterials) m.dispose();
    for (const m of this.arrowMaterials) m.dispose();
    this.group.clear();
  }
}
