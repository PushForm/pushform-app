// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Box3, Vec3 } from '@pushform/core';
import {
  BackSide, BufferAttribute, BufferGeometry, Color, DecrementWrapStencilOp, DoubleSide, FrontSide, Group, IncrementWrapStencilOp, Mesh,
  MeshBasicMaterial, NotEqualStencilFunc, Quaternion, ReplaceStencilOp, AlwaysStencilFunc, Vector2, Vector3,
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
/** Radius of a section marker's bubble in CSS px; the rest of the marker is sized in bubble radii. */
const BUBBLE_PX = 14;
/** Outline and divider width, in bubble radii (1.5 px). */
const STROKE = 1.5 / BUBBLE_PX;
/** Text height in each half of the bubble, and the widest a text may be before it is shrunk to fit. */
const TEXT_SIZE = 0.62;
const TEXT_WIDTH = 1.4;
/** The arrow: half its base width, and its length when it lies square to the view. */
const ARROW_HALF = 0.55;
const ARROW_LENGTH = 0.9;
/** How far, in bubble radii, a marker is drawn toward the camera, so it covers the plane's outline at its corner. */
const LIFT = 2;
/** Below this share of its length on screen an arrow, seen end on, is not drawn. */
const ARROW_MIN = 0.15;
const PAPER = 0xffffff;

/** One section marker: a bubble facing the camera at a corner of a plane, with its arrow. */
interface Marker {
  readonly group: Group;
  readonly arrow: Mesh<BufferGeometry, MeshBasicMaterial>;
  readonly at: Vec3;
  /** `at` in render coordinates. */
  readonly position: Vec3;
  readonly dir: Vec3;
}

/**
 * Section planes and cuts: each plane as a translucent rectangle outlined in the active or inactive color, with a
 * section marker at each corner: a bubble split across its middle holding the plane's symbol over the sheet the
 * section is drawn on, and an arrow pointing to the side the cut keeps. For each active cut, the faces of the
 * solids it cuts filled through the stencil buffer (valid because every Body is a closed manifold) and the section
 * lines where it crosses them.
 */
export class SectionLayer {
  readonly group = new Group();
  sections: RenderSections = EMPTY_SECTIONS;
  private readonly cutGroup = new Group();
  private readonly planeGroup = new Group();
  private labels: Text[] = [];
  private markers: Marker[] = [];
  private lineMaterials: LineMaterial[] = [];
  private resolution = new Vector2(1, 1);
  private origin: Vec3 = [0, 0, 0];
  private readonly view = new Vector3();
  private readonly facing = new Quaternion();
  private readonly inverse = new Quaternion();
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
    for (const text of this.labels) text.dispose();
    this.labels = [];
    this.markers = [];
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
      const outline = new LineSegmentsGeometry();
      outline.setPositions([...c[0], ...c[1], ...c[1], ...c[2], ...c[2], ...c[3], ...c[3], ...c[0]]);
      const material = new LineMaterial({ color: color.getHex(), linewidth: p.active || p.selected ? 2 : 1, worldUnits: false });
      material.resolution = this.resolution;
      this.lineMaterials.push(material);
      const line = new LineSegments2(outline, material);
      line.renderOrder = 5;
      line.frustumCulled = false;
      // a hidden plane, shown with hidden geometry, has no fill
      if (!p.hidden) {
        const fill = new BufferGeometry();
        fill.setAttribute('position', new BufferAttribute(new Float32Array([...c[0], ...c[1], ...c[2], ...c[0], ...c[2], ...c[3]]), 3));
        // The fill is neutral grey; the outline carries the active or inactive color.
        const quad = new Mesh(fill, new MeshBasicMaterial({ color: new Color(sections.inactiveColor), transparent: true, opacity: SECTION_PLANE_OPACITY, side: DoubleSide, depthWrite: false }));
        quad.renderOrder = 5;
        quad.userData['sectionPlane'] = p.id;
        this.planeGroup.add(quad);
      }
      this.planeGroup.add(line);
      // A marker at each corner, so one can be read from any side.
      for (const at of p.corners) this.addMarker(p.symbol, p.sheet ?? '', color, at, p.normal, rel(at));
    }
    this.ready = Promise.all(this.labels.map((text) => new Promise<void>((resolve) => text.sync(() => { fitText(text); resolve(); })))).then(() => undefined);
  }

  /**
   * A bubble of one bubble radius, split by a horizontal line, with `symbol` in its top half and `sheet` in its bottom
   * half, and its arrow; `update` turns it to the camera, sizes it and points the arrow.
   */
  private addMarker(symbol: string, sheet: string, color: Color, at: Vec3, dir: Vec3, position: Vec3): void {
    const group = new Group();
    group.position.set(...position);
    // Transparent, so the marker draws after the plane's translucent fill, in render order.
    const part = (geometry: BufferGeometry, hex: number, order: number): Mesh<BufferGeometry, MeshBasicMaterial> => {
      const mesh = new Mesh(geometry, new MeshBasicMaterial({ color: hex, side: DoubleSide, transparent: true, depthWrite: false }));
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      group.add(mesh);
      return mesh;
    };
    part(discGeometry(0, 1), PAPER, 6);
    part(discGeometry(1 - STROKE, 1), color.getHex(), 7);
    part(rectGeometry(1 - STROKE / 2, STROKE / 2), color.getHex(), 7);
    const arrow = part(new BufferGeometry(), color.getHex(), 7);
    arrow.geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    for (const [content, y] of [[symbol, 0.45], [sheet, -0.45]] as const) {
      if (!content) continue;
      const text = new Text();
      text.text = content;
      text.fontSize = TEXT_SIZE;
      text.anchorX = 'center';
      text.anchorY = 'middle';
      text.color = color.getHex();
      text.position.set(0, y, 0);
      (text.material as { depthWrite?: boolean }).depthWrite = false;
      text.renderOrder = 8;
      text.frustumCulled = false;
      group.add(text);
      this.labels.push(text);
    }
    this.planeGroup.add(group);
    this.markers.push({ group, arrow, at, position, dir });
  }

  /** Per frame: markers face the camera at a fixed screen size, and each arrow points along its plane's normal as seen. */
  update(camera: Camera, wppAt: (p: Vec3) => number): void {
    const facing = camera.getWorldQuaternion(this.facing);
    this.inverse.copy(facing).invert();
    const view = camera.getWorldDirection(this.view);
    const [vx, vy, vz] = [view.x, view.y, view.z];
    for (const { group, arrow, at, position, dir } of this.markers) {
      group.quaternion.copy(facing);
      const radius = wppAt(at) * BUBBLE_PX;
      group.scale.setScalar(radius);
      group.position.set(position[0] - vx * radius * LIFT, position[1] - vy * radius * LIFT, position[2] - vz * radius * LIFT);
      // The normal in the bubble's own axes: x right and y up on screen.
      const seen = this.view.set(dir[0], dir[1], dir[2]).applyQuaternion(this.inverse);
      const share = Math.hypot(seen.x, seen.y);
      arrow.visible = share >= ARROW_MIN;
      if (!arrow.visible) continue;
      const x = seen.x / share, y = seen.y / share;
      // From the bubble's edge, foreshortened as the normal turns toward or away from the viewer.
      const base = 1 - STROKE, tip = base + ARROW_LENGTH * share;
      const corners = arrow.geometry.getAttribute('position') as BufferAttribute;
      corners.array.set([x * tip, y * tip, 0, x * base - y * ARROW_HALF, y * base + x * ARROW_HALF, 0, x * base + y * ARROW_HALF, y * base - x * ARROW_HALF, 0]);
      corners.needsUpdate = true;
      arrow.geometry.computeBoundingSphere();
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

/** A ring between radii `inner` and `outer` in the xy plane; a disc when `inner` is 0. */
function discGeometry(inner: number, outer: number, segments = 40): BufferGeometry {
  const out: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2, b = ((i + 1) / segments) * Math.PI * 2;
    const p = (r: number, t: number): number[] => [Math.cos(t) * r, Math.sin(t) * r, 0];
    out.push(...p(inner, a), ...p(outer, a), ...p(outer, b));
    if (inner > 0) out.push(...p(inner, a), ...p(outer, b), ...p(inner, b));
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(out), 3));
  return g;
}

/** A rectangle centred on the origin, `halfWidth` by `halfHeight`, in the xy plane. */
function rectGeometry(halfWidth: number, halfHeight: number): BufferGeometry {
  const w = halfWidth, h = halfHeight;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-w, -h, 0, w, -h, 0, w, h, 0, -w, -h, 0, w, h, 0, -w, h, 0]), 3));
  return g;
}

/** Shrinks a laid-out label that is wider than the bubble's half allows. */
function fitText(text: Text): void {
  const bounds = text.textRenderInfo?.blockBounds;
  const width = bounds ? bounds[2]! - bounds[0]! : 0;
  text.scale.setScalar(width > TEXT_WIDTH ? TEXT_WIDTH / width : 1);
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
