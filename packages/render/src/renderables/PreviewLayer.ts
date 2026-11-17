// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { M4_IDENTITY } from '@pushform/core';
import type { MeshData, Vec3, Mat4 } from '@pushform/core';
import { BackSide, FrontSide, Group, Mesh, MeshLambertMaterial } from 'three';
import type { BufferGeometry } from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { BACK_COLOR, FACE_MATERIAL_COMMON, FRONT_COLOR, patchSelectTint } from './BodyRenderable';
import { buildFaceGeometry, extractEdgeSegments, transformedVerts } from './buildGeometry';
import type { RenderBodySurface } from '../types';
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
    // Bright Studio and the other studio environments light faces in the shader, with no scene
    // lights, so a preview needs the same patch as the solid it replaces or it renders black.
    patchSelectTint(this.front);
    patchSelectTint(this.back);
  }

  private transform: Mat4 = M4_IDENTITY;
  surfaces: readonly (readonly RenderBodySurface[])[] | undefined;
  get matrix(): Mat4 { return this.transform; }

  set(meshes: readonly MeshData[] | null, origin: Vec3 = this.origin, transform: Mat4 = M4_IDENTITY, surfaces?: readonly (readonly RenderBodySurface[])[]): boolean {
    if (meshes === this.meshes && origin === this.origin && transform === this.transform && surfaces === this.surfaces) return false;
    this.clear();
    this.meshes = meshes;
    this.origin = origin;
    this.transform = transform;
    this.surfaces = surfaces;
    if (!meshes) return true;
    for (const [i, mesh] of meshes.entries()) {
      const groups = surfaces?.[i];
      const g = buildFaceGeometry(mesh, transform, origin, { smoothGroups: groups });
      this.geometries.push(g);
      const front = new Mesh(g, this.front);
      const back = new Mesh(g, this.back);
      front.renderOrder = 5;
      back.renderOrder = 5;
      const edges = new EdgeBatch(this.edgeMaterial);
      // Use the same smooth groups for edge visibility as for shading.
      const groupFace = new Map<number, number>();
      for (const group of groups ?? [])
        for (const fid of group.faceIds) groupFace.set(fid, group.faceIds[0]!);
      const edgeMesh = groups ? {
        ...mesh, faceId: mesh.faceId.map((fid) => groupFace.get(fid) ?? fid),
      } : mesh;
      edges.setSegments(extractEdgeSegments(edgeMesh, transformedVerts(mesh, transform, origin)));
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
