// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { M4_IDENTITY } from '@pushform/core';
import type { MeshData, Vec3, Mat4 } from '@pushform/core';
import { BackSide, FrontSide, Group, Mesh, MeshLambertMaterial } from 'three';
import type { BufferGeometry } from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { BACK_COLOR, FACE_MATERIAL_COMMON, FRONT_COLOR } from './BodyRenderable';
import { buildFaceGeometry, extractEdgeSegments, transformedVerts } from './buildGeometry';
import { EdgeBatch } from './EdgeBatch';

export const PREVIEW_OPACITY = 0.5;

/**
 * Translucent preview bodies (Push/Pull real preview): each mesh gets front/back Lambert meshes at
 * 50 % opacity (no depth write) and a full edge batch using the shared edge material.
 */
export class PreviewLayer {
  readonly group = new Group();
  readonly front = new MeshLambertMaterial({
    color: FRONT_COLOR,
    side: FrontSide,
    transparent: true,
    opacity: PREVIEW_OPACITY,
    depthWrite: false,
    ...FACE_MATERIAL_COMMON,
  });
  readonly back = new MeshLambertMaterial({
    color: BACK_COLOR,
    side: BackSide,
    transparent: true,
    opacity: PREVIEW_OPACITY,
    depthWrite: false,
    ...FACE_MATERIAL_COMMON,
  });
  meshes: readonly MeshData[] | null = null;
  private geometries: BufferGeometry[] = [];
  private batches: EdgeBatch[] = [];
  private origin: Vec3 = [0, 0, 0];

  constructor(private readonly edgeMaterial: LineMaterial) {
    this.group.name = 'Preview';
    this.group.renderOrder = 5;
  }

  private transform: Mat4 = M4_IDENTITY;

  set(meshes: readonly MeshData[] | null, origin: Vec3 = this.origin, transform: Mat4 = M4_IDENTITY): boolean {
    if (meshes === this.meshes && origin === this.origin && transform === this.transform) return false;
    this.clear();
    this.meshes = meshes;
    this.origin = origin;
    this.transform = transform;
    if (!meshes) return true;
    for (const mesh of meshes) {
      const g = buildFaceGeometry(mesh, transform, origin);
      this.geometries.push(g);
      const front = new Mesh(g, this.front);
      const back = new Mesh(g, this.back);
      front.renderOrder = 5;
      back.renderOrder = 5;
      const edges = new EdgeBatch(this.edgeMaterial);
      edges.setSegments(extractEdgeSegments(mesh, transformedVerts(mesh, transform, origin)));
      edges.renderOrder = 6;
      this.batches.push(edges);
      this.group.add(front, back, edges);
    }
    return true;
  }

  get isEmpty(): boolean {
    return !this.meshes || this.meshes.length === 0;
  }

  private clear(): void {
    for (const g of this.geometries) g.dispose();
    for (const b of this.batches) b.geometry.dispose();
    this.geometries = [];
    this.batches = [];
    this.group.clear();
  }

  dispose(): void {
    this.clear();
    this.front.dispose();
    this.back.dispose();
  }
}
