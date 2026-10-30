// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { m4transformPoint } from '@pushform/core';
import type { Vec3 } from '@pushform/core';
import { BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshLambertMaterial } from 'three';
import type { TextureCache } from '../materials/TextureCache';
import type { RenderImage } from '../types';
import { FADE_OPACITY } from './BodyRenderable';

/** Color of a picture whose bytes are missing (light grey). */
export const MISSING_IMAGE_COLOR = 0xd9d9d9;

/** The rectangle of a picture in world coordinates, counter-clockwise from its origin corner. */
export function imageCorners(image: Pick<RenderImage, 'transform' | 'widthM' | 'heightM'>): Vec3[] {
  const { transform: m, widthM: w, heightM: h } = image;
  return [m4transformPoint(m, [0, 0, 0]), m4transformPoint(m, [w, 0, 0]), m4transformPoint(m, [w, h, 0]), m4transformPoint(m, [0, h, 0])];
}

/** Origin-relative positions, normal and uv of one picture's two triangles (testable without WebGL). */
export function buildImageArrays(image: RenderImage, origin: Vec3): { positions: Float32Array; normals: Float32Array; uvs: Float32Array } {
  const c = imageCorners(image);
  const positions = new Float32Array(18), normals = new Float32Array(18);
  const uvOf: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const uvs = new Float32Array(12);
  const e1: Vec3 = [c[1]![0] - c[0]![0], c[1]![1] - c[0]![1], c[1]![2] - c[0]![2]];
  const e2: Vec3 = [c[3]![0] - c[0]![0], c[3]![1] - c[0]![1], c[3]![2] - c[0]![2]];
  const n: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  [0, 1, 2, 0, 2, 3].forEach((corner, i) => {
    const p = c[corner]!;
    positions.set([p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]], i * 3);
    normals.set([n[0] / len, n[1] / len, n[2] / len], i * 3);
    uvs.set(uvOf[corner]!, i * 2);
  });
  return { positions, normals, uvs };
}

/** One placed picture: a two-sided textured quad with its container path for edit-context fading and section cuts. */
export class ImageRenderable extends Mesh<BufferGeometry, MeshLambertMaterial> {
  readonly path: readonly number[];
  isFaded = false;
  constructor(readonly image: RenderImage, origin: Vec3, textures: TextureCache) {
    const material = new MeshLambertMaterial({ side: DoubleSide, transparent: true, alphaTest: 0.02, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    if (image.textureUrl) material.map = textures.get(image.textureUrl);
    else material.color.set(MISSING_IMAGE_COLOR);
    super(new BufferGeometry(), material);
    this.name = `Image ${image.key}`;
    this.path = image.path;
    this.castShadow = image.castShadows;
    this.receiveShadow = image.receiveShadows;
    this.setOrigin(origin);
  }
  setOrigin(origin: Vec3): void {
    const a = buildImageArrays(this.image, origin);
    this.geometry.setAttribute('position', new BufferAttribute(a.positions, 3));
    this.geometry.setAttribute('normal', new BufferAttribute(a.normals, 3));
    this.geometry.setAttribute('uv', new BufferAttribute(a.uvs, 2));
    this.geometry.computeBoundingSphere();
    this.geometry.computeBoundingBox();
  }
  /** Opacity for the edit context (faded outside it) and X-ray. */
  setOpacity(faded: boolean, xray: number | null): void {
    this.isFaded = faded;
    const opacity = Math.min(faded ? FADE_OPACITY : 1, xray ?? 1);
    if (this.material.opacity !== opacity) this.material.opacity = opacity;
    this.material.depthWrite = xray === null;
  }
  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * The model's placed pictures, diffed by render key and object identity: an unchanged `RenderImage` keeps its
 * mesh. Textures come from the shared `TextureCache`, so a picture and a material using the same image share one.
 */
export class ImageLayer {
  readonly group = new Group();
  private readonly items = new Map<string, ImageRenderable>();
  private last: readonly RenderImage[] = [];
  constructor(private readonly textures: TextureCache) {
    this.group.name = 'Images';
  }
  get renderables(): IterableIterator<ImageRenderable> {
    return this.items.values();
  }
  get images(): readonly RenderImage[] {
    return this.last;
  }
  /** Replace the pictures; returns true when anything changed. */
  set(images: readonly RenderImage[], origin: Vec3): boolean {
    if (images === this.last) return false;
    let changed = false;
    const seen = new Set<string>();
    for (const image of images) {
      seen.add(image.key);
      const r = this.items.get(image.key);
      if (r && r.image === image) continue;
      if (r) { this.group.remove(r); r.dispose(); }
      const next = new ImageRenderable(image, origin, this.textures);
      this.items.set(image.key, next);
      this.group.add(next);
      changed = true;
    }
    for (const [key, r] of this.items) {
      if (seen.has(key)) continue;
      this.group.remove(r);
      r.dispose();
      this.items.delete(key);
      changed = true;
    }
    this.last = images;
    return changed;
  }
  setOrigin(origin: Vec3): void {
    for (const r of this.items.values()) r.setOrigin(origin);
  }
  dispose(): void {
    for (const r of this.items.values()) r.dispose();
    this.items.clear();
    this.group.clear();
  }
}
