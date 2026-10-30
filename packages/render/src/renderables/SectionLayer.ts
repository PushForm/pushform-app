// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Box3, Vec3 } from '@pushform/core';
import {
  BackSide, BufferAttribute, BufferGeometry, Color, DecrementWrapStencilOp, DoubleSide, FrontSide, Group, IncrementWrapStencilOp, Mesh,
  MeshBasicMaterial, NotEqualStencilFunc, ReplaceStencilOp, AlwaysStencilFunc, Vector2, Vector3,
} from 'three';
import type { Camera, Plane } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { Text } from 'troika-three-text';
import type { RenderBody, RenderPath, RenderSectionCut, RenderSections } from '../types';
import { EMPTY_SECTIONS, cutsFor, renderPathWithin } from '../types';
import { palette } from './palette';
import { clipPlaneOf, sectionSegments, setObjectClipping } from './sectionGeometry';

/** A body as the section layer needs it: its render-space face geometry and whether it is drawn. */
export interface SectionBody {
  readonly body: RenderBody;
  readonly geometry: BufferGeometry;
  readonly visible: boolean;
}

/** Render order of the cut passes: after every opaque body and sketch (0), before overlays. */
const CUT_ORDER = 2;
/** Opacity of a section plane's translucent fill. */
export const SECTION_PLANE_OPACITY = 0.2;
/** Symbol label size and arrow length in CSS px. */
const SYMBOL_PX = 13;
const ARROW_PX = 22;

/**
 * Section planes and cuts: each plane as a translucent rectangle outlined in the active or inactive
 * color, with its symbol and arrows toward the kept side at two opposite sides; for each active cut, the faces of the
 * solids it cuts filled through the stencil buffer (valid because every Body is a closed manifold) and the section
 * lines where it crosses them.
 */
export class SectionLayer {
  readonly group = new Group();
  sections: RenderSections = EMPTY_SECTIONS;
  private readonly cutGroup = new Group();
  private readonly planeGroup = new Group();
  private labels: { text: Text; at: Vec3 }[] = [];
  private arrows: { mesh: Mesh<BufferGeometry, MeshBasicMaterial>; at: Vec3; dir: Vec3 }[] = [];
  private lineMaterials: LineMaterial[] = [];
  private resolution = new Vector2(1, 1);
  private origin: Vec3 = [0, 0, 0];
  private readonly view = new Vector3();
  /** Resolves once every symbol label has been laid out. */
  ready: Promise<void> = Promise.resolve();

  constructor() {
    this.group.name = 'Sections';
    this.cutGroup.name = 'SectionCuts';
    this.planeGroup.name = 'SectionPlanes';
    this.group.add(this.cutGroup, this.planeGroup);
  }

  /** Clipping planes, in render coordinates, for an entity at `path`. */
  clipPlanesFor(path: RenderPath, origin: Vec3 = this.origin): Plane[] {
    return cutsFor(this.sections.cuts, path).map((c) => clipPlaneOf(c, origin));
  }

  /** Rebuild planes and cuts from `sections` for the given bodies; `bounds` sizes the fill caps. */
  set(sections: RenderSections, bodies: readonly SectionBody[], origin: Vec3, bounds: Box3 | null): void {
    this.sections = sections;
    this.origin = origin;
    this.clear();
    this.buildCuts(sections, bodies, origin, bounds);
    this.buildPlanes(sections, origin);
  }

  private clear(): void {
    for (const g of [this.cutGroup, this.planeGroup]) {
      g.traverse((o) => {
        const m = o as Mesh;
        if (m.geometry && !(m.userData['sharedGeometry'] as boolean | undefined)) m.geometry.dispose();
        const mat = m.material as { dispose?: () => void } | undefined;
        if (mat && !Array.isArray(mat)) mat.dispose?.();
      });
      g.clear();
    }
    for (const { text } of this.labels) text.dispose();
    this.labels = [];
    this.arrows = [];
    this.lineMaterials = [];
  }

  private buildCuts(sections: RenderSections, bodies: readonly SectionBody[], origin: Vec3, bounds: Box3 | null): void {
    sections.cuts.forEach((cut, k) => {
      const base = CUT_ORDER + k * 3;
      const inside = bodies.filter((b) => renderPathWithin(b.body.path, cut.path));
      // Cuts of the containers this one lies in clip everything it fills.
      const ancestors = sections.cuts.filter((c) => c !== cut && renderPathWithin(cut.path, c.path)).map((c) => clipPlaneOf(c, origin));
      if (sections.fill && bounds) {
        for (const b of inside) {
          if (!b.visible) continue;
          const planes = this.clipPlanesFor(b.body.path, origin);
          for (const [side, op] of [[BackSide, IncrementWrapStencilOp], [FrontSide, DecrementWrapStencilOp]] as const) {
            const material = new MeshBasicMaterial({
              side, colorWrite: false, depthWrite: false, depthTest: false,
              stencilWrite: true, stencilFunc: AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op,
            });
            const mesh = new Mesh(b.geometry, material);
            mesh.userData['sharedGeometry'] = true;
            mesh.renderOrder = base;
            mesh.frustumCulled = false;
            setObjectClipping(mesh, planes);
            this.cutGroup.add(mesh);
          }
        }
        const cap = new Mesh(capGeometry(cut, bounds, origin), new MeshBasicMaterial({
          color: new Color(sections.fillColor), side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
          stencilWrite: true, stencilRef: 0, stencilFunc: NotEqualStencilFunc,
          stencilFail: ReplaceStencilOp, stencilZFail: ReplaceStencilOp, stencilZPass: ReplaceStencilOp,
        }));
        cap.renderOrder = base + 1;
        cap.frustumCulled = false;
        setObjectClipping(cap, ancestors);
        // The stencil counts of one cut must not leak into the next.
        const clip = cap.onBeforeRender, unclip = cap.onAfterRender;
        cap.onAfterRender = (renderer, ...rest) => { unclip.call(cap, renderer, ...rest); renderer.clearStencil(); };
        cap.onBeforeRender = clip;
        this.cutGroup.add(cap);
      }
      for (const b of inside) {
        if (!b.visible) continue;
        const positions = sectionSegments(b.body.mesh, b.body.transform, cut.normal, cut.d, origin);
        if (!positions.length) continue;
        const geometry = new LineSegmentsGeometry();
        geometry.setPositions(positions);
        const material = new LineMaterial({ color: new Color(sections.lineColor).getHex(), linewidth: sections.lineWidth, worldUnits: false });
        material.resolution = this.resolution;
        this.lineMaterials.push(material);
        const line = new LineSegments2(geometry, material);
        line.renderOrder = base + 2;
        line.frustumCulled = false;
        // The line lies in its own cut; the body's other cuts still clip it.
        const others = cutsFor(sections.cuts, b.body.path).filter((c) => c !== cut).map((c) => clipPlaneOf(c, origin));
        setObjectClipping(line, others);
        this.cutGroup.add(line);
      }
    });
  }

  private buildPlanes(sections: RenderSections, origin: Vec3): void {
    const rel = (p: Vec3): Vec3 => [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    for (const p of sections.planes) {
      const color = new Color(p.selected ? palette.select.getHex() : p.active ? sections.activeColor : sections.inactiveColor);
      const c = p.corners.map(rel) as [Vec3, Vec3, Vec3, Vec3];
      const fill = new BufferGeometry();
      fill.setAttribute('position', new BufferAttribute(new Float32Array([...c[0], ...c[1], ...c[2], ...c[0], ...c[2], ...c[3]]), 3));
      // The fill is neutral grey; the outline carries the active or inactive color.
      const quad = new Mesh(fill, new MeshBasicMaterial({ color: new Color(sections.inactiveColor), transparent: true, opacity: SECTION_PLANE_OPACITY, side: DoubleSide, depthWrite: false }));
      quad.renderOrder = 5;
      quad.userData['sectionPlane'] = p.id;
      const outline = new LineSegmentsGeometry();
      outline.setPositions([...c[0], ...c[1], ...c[1], ...c[2], ...c[2], ...c[3], ...c[3], ...c[0]]);
      const material = new LineMaterial({ color: color.getHex(), linewidth: p.active || p.selected ? 2 : 1, worldUnits: false });
      material.resolution = this.resolution;
      this.lineMaterials.push(material);
      const line = new LineSegments2(outline, material);
      line.renderOrder = 5;
      line.frustumCulled = false;
      this.planeGroup.add(quad, line);
      // Symbol and arrow at the middles of two opposite sides, pointing to the side the cut keeps.
      for (const [a, b] of [[p.corners[0], p.corners[1]], [p.corners[2], p.corners[3]]] as const) {
        const at: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        const text = new Text();
        text.text = p.symbol;
        text.fontSize = 1;
        text.anchorX = 'center';
        text.anchorY = 'middle';
        text.color = color.getHex();
        text.outlineWidth = '12%';
        text.outlineColor = '#ffffff';
        text.position.set(...rel(at));
        (text.material as { depthWrite?: boolean }).depthWrite = false;
        text.renderOrder = 6;
        this.planeGroup.add(text);
        this.labels.push({ text, at });
        const arrow = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ color, side: DoubleSide, depthWrite: false }));
        arrow.renderOrder = 6;
        arrow.frustumCulled = false;
        this.planeGroup.add(arrow);
        this.arrows.push({ mesh: arrow, at, dir: p.normal });
      }
    }
    this.ready = Promise.all(this.labels.map(({ text }) => new Promise<void>((resolve) => text.sync(() => resolve())))).then(() => undefined);
  }

  /** Per frame: labels face the camera at a fixed screen size; arrows keep their screen length. */
  update(camera: Camera, wppAt: (p: Vec3) => number): void {
    for (const { text, at } of this.labels) {
      text.quaternion.copy(camera.quaternion);
      const s = wppAt(at) * SYMBOL_PX;
      text.scale.set(s, s, s);
    }
    for (const { mesh, at, dir } of this.arrows) {
      const len = wppAt(at) * ARROW_PX, w = len * 0.25;
      // Across the arrow, in the plane facing the camera.
      const view = camera.getWorldDirection(this.view);
      let across: Vec3 = [dir[1] * view.z - dir[2] * view.y, dir[2] * view.x - dir[0] * view.z, dir[0] * view.y - dir[1] * view.x];
      const l = Math.hypot(...across);
      across = l > 1e-9 ? [across[0] / l, across[1] / l, across[2] / l] : [0, 0, 0];
      const o = this.origin;
      const start: Vec3 = [at[0] - o[0] + dir[0] * len * 0.4, at[1] - o[1] + dir[1] * len * 0.4, at[2] - o[2] + dir[2] * len * 0.4];
      const tip: Vec3 = [start[0] + dir[0] * len, start[1] + dir[1] * len, start[2] + dir[2] * len];
      const tri = [...tip, start[0] + across[0] * w, start[1] + across[1] * w, start[2] + across[2] * w, start[0] - across[0] * w, start[1] - across[1] * w, start[2] - across[2] * w];
      mesh.geometry.setAttribute('position', new BufferAttribute(new Float32Array(tri), 3));
      mesh.geometry.computeBoundingSphere();
    }
  }

  get isEmpty(): boolean {
    return this.sections.planes.length === 0 && this.sections.cuts.length === 0;
  }

  /** Line widths are CSS pixels. */
  setResolution(width: number, height: number): void {
    this.resolution.set(width, height);
    for (const m of this.lineMaterials) m.resolution = this.resolution;
  }

  dispose(): void {
    this.clear();
  }
}

/** A rectangle in the cut's plane covering `bounds` (projected) with room to spare, in render coordinates. */
function capGeometry(cut: RenderSectionCut, bounds: Box3, origin: Vec3): BufferGeometry {
  const n = cut.normal;
  const a: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(n, a)), v = cross(n, u);
  const center: Vec3 = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
  const dist = n[0] * center[0] + n[1] * center[1] + n[2] * center[2] + cut.d;
  const c: Vec3 = [center[0] - n[0] * dist - origin[0], center[1] - n[1] * dist - origin[1], center[2] - n[2] * dist - origin[2]];
  const r = Math.max(1, Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]));
  const corner = (su: number, sv: number): number[] => [c[0] + (u[0] * su + v[0] * sv) * r, c[1] + (u[1] * su + v[1] * sv) * r, c[2] + (u[2] * su + v[2] * sv) * r];
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([...corner(-1, -1), ...corner(1, -1), ...corner(1, 1), ...corner(-1, -1), ...corner(1, 1), ...corner(-1, 1)]), 3));
  return g;
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
