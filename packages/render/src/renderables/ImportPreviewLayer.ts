// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { box3Empty, box3Expand, box3IsEmpty, M4_IDENTITY, m4mul, m4transformPoint } from '@pushform/core';
import type { Box3, Mat4, MVec3, Vec3 } from '@pushform/core';
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Group, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshLambertMaterial, SRGBColorSpace } from 'three';
import { FACE_MATERIAL_COMMON } from './BodyRenderable';
import { palette } from './palette';

/** A part of a model being imported: its mesh in its own frame (meters), color, and hard edges as segments. */
export interface ImportPreviewPart {
  readonly id: number;
  readonly color: readonly [number, number, number] | null;
  readonly positions: Float32Array;
  readonly triangles: Uint32Array;
  /** Two end points (six numbers) per segment. */
  readonly edges: Float32Array;
}
/** A placement of an imported part: column-major, meters, in the frame the import goes into. */
export interface ImportPreviewPlacement { readonly part: number; readonly matrix: readonly number[] }
/** What an import hands the viewport as it reads: parts and placements since the last batch. */
export interface ImportPreviewBatch { readonly parts: readonly ImportPreviewPart[]; readonly placements: readonly ImportPreviewPlacement[] }

const PREVIEW_EDGE_COLOR = 0x333333;

interface PartEntry { faces: BufferGeometry; edges: BufferGeometry; material: MeshLambertMaterial; min: MVec3; max: MVec3 }
interface Placed { part: number; world: Mat4; faces: Mesh; edges: LineSegments }

/**
 * The parts of a model that is still being imported, drawn outside the document so the model appears as it is read.
 * Each part's geometry is built once and shared by its placements; faces are flat shaded from the triangles
 * (no normals are stored) in the part's color, with its hard edges as thin lines. Nothing here can be picked or edited:
 * the import replaces the layer with the document's own geometry when it is applied.
 */
export class ImportPreviewLayer {
  readonly group = new Group();
  private readonly parts = new Map<number, PartEntry>();
  private readonly placed: Placed[] = [];
  /** Placements whose part has not arrived yet (the reader sends a part first, but a batch is not relied on). */
  private pending: ImportPreviewPlacement[] = [];
  private readonly materials = new Map<string, MeshLambertMaterial>();
  private readonly edgeMaterial = new LineBasicMaterial({ color: PREVIEW_EDGE_COLOR });
  private base: Mat4 = M4_IDENTITY;
  private origin: Vec3 = [0, 0, 0];
  private bounds: { min: MVec3; max: MVec3 } = box3Empty();

  constructor() {
    this.group.name = 'Import preview';
  }

  get isEmpty(): boolean {
    return this.placed.length === 0;
  }

  /** World bounds of everything placed so far, or null before the first placement. */
  worldBounds(): Box3 | null {
    return box3IsEmpty(this.bounds) ? null : { min: [...this.bounds.min], max: [...this.bounds.max] };
  }

  /** Start a preview whose placements are relative to `base` (the world matrix of the context the import goes into). */
  begin(base: Mat4 = M4_IDENTITY): void {
    this.clear();
    this.base = base;
  }

  /** Add a batch; returns whether anything new is drawn. */
  add(batch: ImportPreviewBatch): boolean {
    for (const part of batch.parts) if (!this.parts.has(part.id)) this.parts.set(part.id, this.buildPart(part));
    const waiting = [...this.pending, ...batch.placements];
    this.pending = [];
    let changed = false;
    for (const placement of waiting) {
      const entry = this.parts.get(placement.part);
      if (!entry) { this.pending.push(placement); continue; }
      const world = m4mul(this.base, [...placement.matrix]) as unknown as Mat4;
      const faces = new Mesh(entry.faces, entry.material), edges = new LineSegments(entry.edges, this.edgeMaterial);
      for (const object of [faces, edges]) { object.matrixAutoUpdate = false; object.frustumCulled = true; }
      const item: Placed = { part: placement.part, world, faces, edges };
      this.place(item);
      this.placed.push(item);
      this.group.add(faces, edges);
      for (const x of [entry.min[0], entry.max[0]]) for (const y of [entry.min[1], entry.max[1]]) for (const z of [entry.min[2], entry.max[2]])
        box3Expand(this.bounds, m4transformPoint(world, [x, y, z]));
      changed = true;
    }
    return changed;
  }

  setOrigin(origin: Vec3): void {
    this.origin = origin;
    for (const item of this.placed) this.place(item);
  }

  /** Remove everything (the import was applied, failed or was cancelled). */
  clear(): boolean {
    const had = this.placed.length > 0 || this.parts.size > 0;
    this.group.clear();
    for (const entry of this.parts.values()) { entry.faces.dispose(); entry.edges.dispose(); }
    for (const material of this.materials.values()) material.dispose();
    this.parts.clear();
    this.materials.clear();
    this.placed.length = 0;
    this.pending = [];
    this.bounds = box3Empty();
    this.base = M4_IDENTITY;
    return had;
  }

  dispose(): void {
    this.clear();
    this.edgeMaterial.dispose();
  }

  /** Render-space matrix of a placement: its world matrix moved by the floating origin. */
  private place(item: Placed): void {
    const m = new Matrix4().fromArray(item.world as unknown as number[]);
    m.premultiply(new Matrix4().makeTranslation(-this.origin[0], -this.origin[1], -this.origin[2]));
    item.faces.matrix.copy(m);
    item.edges.matrix.copy(m);
    item.faces.matrixWorldNeedsUpdate = true;
    item.edges.matrixWorldNeedsUpdate = true;
  }

  private buildPart(part: ImportPreviewPart): PartEntry {
    const faces = new BufferGeometry();
    faces.setAttribute('position', new BufferAttribute(part.positions, 3));
    faces.setIndex(new BufferAttribute(part.triangles, 1));
    faces.computeBoundingSphere();
    const edges = new BufferGeometry();
    edges.setAttribute('position', new BufferAttribute(part.edges, 3));
    edges.computeBoundingSphere();
    const min: MVec3 = [Infinity, Infinity, Infinity], max: MVec3 = [-Infinity, -Infinity, -Infinity];
    const p = part.positions;
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
      const v = p[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
    if (p.length === 0) { min.fill(0); max.fill(0); }
    return { faces, edges, material: this.material(part.color), min, max };
  }

  private material(color: readonly [number, number, number] | null): MeshLambertMaterial {
    const key = color ? color.join(',') : 'default';
    let material = this.materials.get(key);
    if (!material) {
      const c = color ? new Color().setRGB(color[0], color[1], color[2], SRGBColorSpace) : palette.front.clone();
      material = new MeshLambertMaterial({ color: c, side: DoubleSide, flatShading: true, ...FACE_MATERIAL_COMMON });
      this.materials.set(key, material);
    }
    return material;
  }
}
