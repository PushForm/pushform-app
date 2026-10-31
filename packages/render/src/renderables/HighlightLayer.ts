// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { planeBasis } from '@pushform/core';
import type { PlaneBasis, Vec3 } from '@pushform/core';
import { triangulatePlanarFace } from '@pushform/geom';
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, Points, ShaderMaterial } from 'three';
import type { EntityHighlight, HighlightState } from '../types';
import { EMPTY_HIGHLIGHT } from '../types';
import { SELECT_COLOR } from './BodyRenderable';
import { GUIDE_EXTENT } from './GuideLayer';
import { EdgeBatch } from './EdgeBatch';
import { createEdgeMaterial } from './EdgeMaterial';
import type { EdgeMaterial } from './EdgeMaterial';

/** Plain-array geometry for one highlight class (hover or selected); testable without WebGL. */
export interface HighlightGeometry {
  /** Unwelded triangles of face overlays, origin-relative. */
  readonly facePositions: Float32Array;
  /** Edge segments [x1,y1,z1,x2,y2,z2,...], origin-relative. */
  readonly edgePositions: Float32Array;
  /** Vertex markers, origin-relative. */
  readonly vertexPositions: Float32Array;
  /** Render keys of bodies to tint whole. */
  readonly bodyKeys: ReadonlySet<string>;
  /** Path keys of instances whose bodies are tinted (every body whose path is within the instance). */
  readonly instanceKeys: ReadonlySet<string>;
  readonly sketchFaceIds: ReadonlySet<number>;
}

/** The 12 edges of an axis-aligned box as point pairs. */
export function box3Segments(min: Vec3, max: Vec3): [Vec3, Vec3][] {
  const c = (i: number): Vec3 => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const pairs: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  return pairs.map(([a, b]) => [c(a), c(b)]);
}

/** Plane basis of a loop from its Newell normal (robust for concave rings). */
export function loopBasis(loop: readonly Vec3[]): PlaneBasis | null {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  if (Math.hypot(nx, ny, nz) === 0) return null;
  return planeBasis(loop[0]!, [nx, ny, nz]);
}

export function buildHighlightGeometry(items: readonly EntityHighlight[], origin: Vec3): HighlightGeometry {
  const faces: number[] = [];
  const edges: number[] = [];
  const verts: number[] = [];
  const bodyKeys = new Set<string>();
  const instanceKeys = new Set<string>();
  const sketchFaceIds = new Set<number>();
  const push = (arr: number[], p: Vec3) => arr.push(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
  const addFace = (loops: readonly (readonly Vec3[])[]) => {
    const outer = loops[0];
    if (!outer || outer.length < 3) return;
    const basis = loopBasis(outer);
    if (!basis) return;
    const tri = triangulatePlanarFace(loops, basis);
    for (let i = 0; i < tri.indices.length; i++) {
      const v = tri.indices[i]! * 3;
      faces.push(tri.positions[v]! - origin[0], tri.positions[v + 1]! - origin[1], tri.positions[v + 2]! - origin[2]);
    }
  };
  const addPolyline = (pts: readonly Vec3[]) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      push(edges, pts[i]!);
      push(edges, pts[i + 1]!);
    }
  };
  for (const h of items) {
    switch (h.kind) {
      case 'face':
        addFace(h.loops);
        break;
      case 'sketchFace':
        sketchFaceIds.add(h.id);
        addFace(h.loops);
        break;
      case 'edge':
        addPolyline(h.points);
        break;
      case 'sketchEdge':
        addPolyline([h.a, h.b]);
        break;
      case 'sketchVertex':
        push(verts, h.p);
        break;
      case 'image':
        if (h.corners.length < 3) break;
        addFace([h.corners]);
        addPolyline([...h.corners, h.corners[0]!]);
        break;
      case 'body':
        bodyKeys.add(h.key);
        // The tint alone is faint on light faces; the body's edges make a selected solid read as selected.
        for (const edge of h.edges ?? []) addPolyline(edge);
        break;
      case 'instance':
        instanceKeys.add(h.key);
        for (const [a, b] of box3Segments(h.bounds.min, h.bounds.max)) addPolyline([a, b]);
        break;
      case 'guide':
        if (!h.dir) push(verts, h.p);
        else if (h.end) addPolyline([h.p, h.end]);
        else {
          const l = Math.hypot(h.dir[0], h.dir[1], h.dir[2]) || 1;
          const d: Vec3 = [(h.dir[0] / l) * GUIDE_EXTENT, (h.dir[1] / l) * GUIDE_EXTENT, (h.dir[2] / l) * GUIDE_EXTENT];
          addPolyline([
            [h.p[0] - d[0], h.p[1] - d[1], h.p[2] - d[2]],
            [h.p[0] + d[0], h.p[1] + d[1], h.p[2] + d[2]],
          ]);
        }
        break;
    }
  }
  return {
    facePositions: new Float32Array(faces),
    edgePositions: new Float32Array(edges),
    vertexPositions: new Float32Array(verts),
    bodyKeys,
    instanceKeys,
    sketchFaceIds,
  };
}

class HighlightSet {
  readonly group = new Group();
  readonly faceMaterial: MeshBasicMaterial;
  readonly edgeMaterial: EdgeMaterial;
  readonly vertexMaterial: ShaderMaterial;
  private faceMesh: Mesh;
  private edges: EdgeBatch;
  private points: Points;

  constructor(name: string, color: number, faceOpacity: number, edgeWidth: number, vertexSize: number) {
    this.group.name = name;
    this.faceMaterial = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: faceOpacity,
      depthTest: true,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.edgeMaterial = createEdgeMaterial({ color, width: edgeWidth, profileWidth: edgeWidth });
    this.edgeMaterial.polygonOffset = true;
    this.edgeMaterial.polygonOffsetFactor = -3;
    this.edgeMaterial.polygonOffsetUnits = -3;
    this.vertexMaterial = new ShaderMaterial({
      uniforms: { uSize: { value: vertexSize }, uColor: { value: new Color(color) } },
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
          vec2 p = abs(gl_PointCoord * 2.0 - 1.0);
          if (max(p.x, p.y) > 1.0) discard;
          gl_FragColor = vec4(uColor, 1.0);
        }
      `,
      transparent: false,
      depthTest: true,
      depthWrite: false,
    });
    this.faceMesh = new Mesh(new BufferGeometry(), this.faceMaterial);
    this.faceMesh.frustumCulled = false;
    this.faceMesh.renderOrder = 2;
    this.edges = new EdgeBatch(this.edgeMaterial);
    this.edges.renderOrder = 3;
    this.points = new Points(new BufferGeometry(), this.vertexMaterial);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.group.add(this.faceMesh, this.edges, this.points);
    this.setGeometry(null);
  }

  setGeometry(g: HighlightGeometry | null): void {
    this.faceMesh.geometry.dispose();
    const fg = new BufferGeometry();
    fg.setAttribute('position', new BufferAttribute(g?.facePositions ?? new Float32Array(0), 3));
    this.faceMesh.geometry = fg;
    this.faceMesh.visible = (g?.facePositions.length ?? 0) > 0;
    this.edges.setSegments(g?.edgePositions ?? new Float32Array(0));
    this.points.geometry.dispose();
    const pg = new BufferGeometry();
    pg.setAttribute('position', new BufferAttribute(g?.vertexPositions ?? new Float32Array(0), 3));
    this.points.geometry = pg;
    this.points.visible = (g?.vertexPositions.length ?? 0) > 0;
  }

  /** The style's Selected color. */
  setColor(hex: number): void {
    this.faceMaterial.color.set(hex);
    this.edgeMaterial.color.set(hex);
    (this.vertexMaterial.uniforms['uColor']!.value as Color).set(hex);
  }

  setResolution(width: number, height: number, pixelRatio: number, vertexSize: number): void {
    this.edgeMaterial.resolution.set(width, height);
    const u = this.vertexMaterial.uniforms['uSize'];
    if (u) u.value = vertexSize * pixelRatio;
  }

  dispose(): void {
    this.faceMesh.geometry.dispose();
    this.edges.geometry.dispose();
    this.points.geometry.dispose();
    this.faceMaterial.dispose();
    this.edgeMaterial.dispose();
    this.vertexMaterial.dispose();
  }
}

/**
 * Hover + selection highlights drawn in the main scene (depth-tested, polygon-offset above faces):
 * translucent face overlays, thick blue edges and square vertex markers. Whole-body and
 * sketch-face tints are reported back to SceneSync, which sets `flags` on the renderables.
 */
export class HighlightLayer {
  readonly group = new Group();
  readonly hover = new HighlightSet('Hover', SELECT_COLOR, 0.18, 2.5, 7);
  readonly selected = new HighlightSet('Selected', SELECT_COLOR, 0.35, 3, 7);
  state: HighlightState = EMPTY_HIGHLIGHT;
  private origin: Vec3 = [0, 0, 0];

  constructor() {
    this.group.name = 'Highlights';
    this.group.add(this.hover.group, this.selected.group);
  }

  /** Hover and selection in the style's Selected color. */
  setColor(hex: number): void {
    this.hover.setColor(hex);
    this.selected.setColor(hex);
  }

  /** Apply a highlight state; returns the body keys / instance keys / sketch-face ids to tint (hover ∪ selected). */
  set(state: HighlightState, origin: Vec3 = this.origin): { bodyKeys: Set<string>; instanceKeys: Set<string>; sketchFaceIds: Set<number> } {
    this.state = state;
    this.origin = origin;
    const hover = buildHighlightGeometry(state.hover ? [state.hover] : [], origin);
    const selected = buildHighlightGeometry(state.selected, origin);
    this.hover.setGeometry(hover);
    this.selected.setGeometry(selected);
    return {
      bodyKeys: new Set([...hover.bodyKeys, ...selected.bodyKeys]),
      instanceKeys: new Set([...hover.instanceKeys, ...selected.instanceKeys]),
      sketchFaceIds: new Set([...hover.sketchFaceIds, ...selected.sketchFaceIds]),
    };
  }

  setResolution(width: number, height: number, pixelRatio: number): void {
    this.hover.setResolution(width, height, pixelRatio, 7);
    this.selected.setResolution(width, height, pixelRatio, 7);
  }

  dispose(): void {
    this.hover.dispose();
    this.selected.dispose();
    this.group.clear();
  }
}
