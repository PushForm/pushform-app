// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, Vector2, Vector3 } from 'three';
import type { Camera } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { Text } from 'troika-three-text';
import type { RenderText, RenderTextArrow, RenderTexts } from '../types';
import { EMPTY_TEXTS } from '../types';
import { palette } from './palette';

/** Arrowhead and dot sizes in CSS px, as dimension arrows. */
export const TEXT_ARROW_PX = { length: 10, width: 6, dot: 3, slash: 5 } as const;
/** Screen pixels per text point, at 96 px per inch. */
const PX_PER_PT = 96 / 72;
/** troika font size before per-frame scaling (world units). */
const BASE_FONT = 1;
/** Depth of screen text in normalized device coordinates: just past the near plane, in front of the model. */
const SCREEN_TEXT_NDC_Z = -0.999;

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/** A leader text's label point: the anchor plus its pushpin offset, or its view offset along `right` and `up`. */
export function textLabelPoint(t: Pick<RenderText, 'position' | 'offset' | 'viewOffset'>, right: Vec3, up: Vec3): Vec3 {
  if (t.viewOffset) return add(add(t.position, right, t.viewOffset[0]), up, t.viewOffset[1]);
  return t.offset ? add(t.position, t.offset) : t.position;
}

/**
 * A leader's arrow at `tip`, pointing back along unit `back` toward the label, in world units for `wpp` world units per
 * pixel: filled triangles (closed arrow, dot) and line segments (open arrow, slash), each a flat list of points.
 */
export function textArrowGeometry(arrow: RenderTextArrow, tip: Vec3, back: Vec3, view: Vec3, wpp: number): { triangles: Vec3[]; segments: Vec3[] } {
  const across = unit(cross(back, view));
  const l = TEXT_ARROW_PX.length * wpp, w = (TEXT_ARROW_PX.width / 2) * wpp;
  const base = add(tip, back, l);
  switch (arrow) {
    case 'closed':
      return { triangles: [tip, add(base, across, w), add(base, across, -w)], segments: [] };
    case 'open':
      return { triangles: [], segments: [tip, add(base, across, w), tip, add(base, across, -w)] };
    case 'slash': {
      const s = TEXT_ARROW_PX.slash * wpp;
      const d = unit(add(across, back));
      return { triangles: [], segments: [add(tip, d, s), add(tip, d, -s)] };
    }
    case 'dot': {
      const r = TEXT_ARROW_PX.dot * wpp, n = 10, triangles: Vec3[] = [];
      const up = unit(cross(view, across));
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        triangles.push(tip, add(add(tip, across, Math.cos(a0) * r), up, Math.sin(a0) * r), add(add(tip, across, Math.cos(a1) * r), up, Math.sin(a1) * r));
      }
      return { triangles, segments: [] };
    }
    default:
      return { triangles: [], segments: [] };
  }
}

/**
 * Texts of the model: labels that face the camera at their point size on screen beside their label
 * point, leader lines from the anchor to the label point and arrows at the anchor, laid out every frame because view-based leaders and screen
 * text follow the view. Selected texts draw in the selection color.
 */
export class TextLayer {
  readonly group = new Group();
  texts: RenderTexts = EMPTY_TEXTS;
  private origin: Vec3 = [0, 0, 0];
  private readonly lineMaterials: [LineMaterial, LineMaterial];
  private readonly lines: [LineSegments2, LineSegments2];
  private readonly fillMaterials: [MeshBasicMaterial, MeshBasicMaterial];
  private readonly fills: [Mesh<BufferGeometry, MeshBasicMaterial>, Mesh<BufferGeometry, MeshBasicMaterial>];
  private labels: Text[] = [];
  private labelsDirty = false;
  private readonly labelMaterial = new MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true });
  /** Resolves once every label's text has been laid out (troika lays text out asynchronously). */
  ready: Promise<void> = Promise.resolve();

  constructor() {
    this.group.name = 'Texts';
    const colors = [0x000000, palette.select.getHex()] as const;
    this.lineMaterials = colors.map((color) => new LineMaterial({ color, linewidth: 1, worldUnits: false, depthTest: true, depthWrite: false })) as [LineMaterial, LineMaterial];
    this.lines = this.lineMaterials.map((m) => {
      const line = new LineSegments2(new LineSegmentsGeometry(), m);
      line.frustumCulled = false;
      line.visible = false;
      return line;
    }) as [LineSegments2, LineSegments2];
    this.fillMaterials = colors.map((color) => new MeshBasicMaterial({ color: new Color(color), side: DoubleSide, depthWrite: false })) as [MeshBasicMaterial, MeshBasicMaterial];
    this.fills = this.fillMaterials.map((m) => {
      const mesh = new Mesh(new BufferGeometry(), m);
      mesh.frustumCulled = false;
      mesh.visible = false;
      return mesh;
    }) as [Mesh<BufferGeometry, MeshBasicMaterial>, Mesh<BufferGeometry, MeshBasicMaterial>];
    this.group.add(...this.lines, ...this.fills);
  }

  /** Replace the texts; returns true when anything changed (compared by object identity). */
  set(texts: RenderTexts | null, origin: Vec3 = this.origin): boolean {
    const next = texts ?? EMPTY_TEXTS;
    if (next === this.texts && origin === this.origin) return false;
    this.texts = next;
    this.origin = origin;
    for (const label of this.labels) {
      this.group.remove(label);
      label.dispose();
    }
    this.labels = [];
    this.labelsDirty = true;
    if (!next.items.length) for (const o of [...this.lines, ...this.fills]) o.visible = false;
    return true;
  }

  /**
   * Make the labels now and resolve once troika has laid them out. Troika lays text out with WebGL, so the viewport
   * calls this only when it has a renderer; otherwise labels are made on the first drawn frame.
   */
  prepare(): Promise<void> {
    if (this.labelsDirty) this.buildLabels();
    return this.ready;
  }

  private buildLabels(): void {
    this.labelsDirty = false;
    this.labels = this.texts.items.map((t) => {
      const label = new Text();
      label.text = t.text;
      label.fontSize = BASE_FONT;
      const screen = t.kind === 'screen';
      label.anchorX = 'left';
      label.anchorY = screen ? 'top' : 'middle';
      label.color = t.selected ? palette.select.getHex() : new Color(t.color).getHex();
      label.outlineWidth = '12%';
      label.outlineColor = '#ffffff';
      // text is drawn over the model; its leader is not. Troika derives its shader from this base material.
      label.material = this.labelMaterial;
      label.renderOrder = 8;
      label.visible = false;
      this.group.add(label);
      return label;
    });
    this.ready = Promise.all(this.labels.map((t) => new Promise<void>((resolve) => t.sync(() => resolve())))).then(() => undefined);
  }

  /** Per frame: place, turn and size the labels and lay out the leaders and arrows for the current view. */
  update(camera: Camera, wppAt: (p: Vec3) => number): void {
    const items = this.texts.items;
    if (items.length === 0) return;
    if (this.labelsDirty) this.buildLabels();
    const o = this.origin;
    const fwd = new Vector3(), right = new Vector3(), up = new Vector3();
    camera.getWorldDirection(fwd);
    right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const view: Vec3 = [fwd.x, fwd.y, fwd.z], r: Vec3 = [right.x, right.y, right.z], u: Vec3 = [up.x, up.y, up.z];
    const segments: [number[], number[]] = [[], []], triangles: [number[], number[]] = [[], []];
    const push = (out: number[], pts: readonly Vec3[]) => { for (const p of pts) out.push(p[0] - o[0], p[1] - o[1], p[2] - o[2]); };
    items.forEach((t, i) => {
      const label = this.labels[i];
      if (!label) return;
      let at: Vec3;
      if (t.kind === 'screen') {
        const p = new Vector3(t.position[0] * 2 - 1, 1 - t.position[1] * 2, SCREEN_TEXT_NDC_Z).unproject(camera);
        at = [p.x + o[0], p.y + o[1], p.z + o[2]];
      } else at = textLabelPoint(t, r, u);
      const wpp = wppAt(at);
      const scale = (wpp * t.fontSizePt * PX_PER_PT) / BASE_FONT;
      label.position.set(at[0] - o[0], at[1] - o[1], at[2] - o[2]);
      label.quaternion.copy(camera.quaternion);
      label.scale.set(scale, scale, scale);
      label.visible = true;
      if (t.kind !== 'leader') return;
      const toLabel = sub(at, t.position);
      // the text starts at the label point when it is right of the anchor on screen, and ends there otherwise
      const side = toLabel[0] * r[0] + toLabel[1] * r[1] + toLabel[2] * r[2] >= 0 ? 'left' : 'right';
      if (label.anchorX !== side) label.anchorX = side;
      if (t.leader === 'none') return;
      const k = t.selected ? 1 : 0;
      if (len(toLabel) <= wpp) return;
      push(segments[k], [t.position, at]);
      const arrow = textArrowGeometry(t.arrow, t.position, unit(toLabel), view, wppAt(t.position));
      push(triangles[k], arrow.triangles);
      push(segments[k], arrow.segments);
    });
    for (const k of [0, 1] as const) {
      const line = this.lines[k];
      line.geometry.dispose();
      const g = new LineSegmentsGeometry();
      if (segments[k].length) g.setPositions(segments[k]);
      line.geometry = g;
      line.visible = segments[k].length > 0;
      const fill = this.fills[k];
      fill.visible = triangles[k].length > 0;
      if (!fill.visible) continue;
      fill.geometry.setAttribute('position', new BufferAttribute(new Float32Array(triangles[k]), 3));
      fill.geometry.computeBoundingSphere();
    }
  }

  get isEmpty(): boolean {
    return this.texts.items.length === 0;
  }

  /** Line widths are CSS pixels, as in the overlay. */
  setResolution(width: number, height: number): void {
    for (const m of this.lineMaterials) m.resolution = new Vector2(width, height);
  }

  dispose(): void {
    for (const label of this.labels) label.dispose();
    this.labels = [];
    for (const line of this.lines) line.geometry.dispose();
    for (const mesh of this.fills) mesh.geometry.dispose();
    for (const m of this.lineMaterials) m.dispose();
    for (const m of this.fillMaterials) m.dispose();
    this.labelMaterial.dispose();
    this.group.clear();
  }
}
