// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { BufferAttribute, BufferGeometry, Group, InstancedBufferAttribute, Mesh } from 'three';
import type { Material, Object3D, TypedArray } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { EdgeBatch } from './EdgeBatch';
import { shadowDisplay } from './BodyRenderable';

/** What a body or sketch renderable draws: two face meshes over material groups, and its edge passes. */
export interface BatchSource extends Object3D {
  readonly front: Mesh<BufferGeometry, Material | Material[]>;
  readonly back: Mesh<BufferGeometry, Material | Material[]>;
  readonly edges: EdgeBatch;
  readonly hiddenEdges: EdgeBatch;
  readonly backEdges: LineSegments2;
}

/** Vertices (faces) or segments (edges) one batch holds before another is started, bounding the cost of an edit. */
export const BATCH_CAPACITY = 1 << 18;

/** Attributes both sides of a face mesh share; the rest (colors, texture coordinates) belong to one side. */
const SHARED = new Set(['position', 'normal', 'faceId', 'flags']);

type Side = 'front' | 'back';
interface FaceSide { readonly side: Side; readonly geometry: BufferGeometry; readonly material: Material }
/**
 * Triangles of a source drawn with one material on each side named here: both sides of a source whose sides are each
 * one material (a pair, sharing the position, normal, face and flag buffers as the source does), or one side's group.
 */
interface FacePiece {
  readonly kind: 'faces';
  readonly source: BatchSource;
  readonly sides: readonly FaceSide[];
  readonly start: number;
  readonly count: number;
  readonly cast: boolean;
  readonly receive: boolean;
  readonly receiveFlag: boolean | undefined;
}
interface EdgePiece { readonly kind: 'edges' | 'hidden'; readonly source: BatchSource; readonly batch: EdgeBatch; readonly back: LineSegments2 | null }
type Piece = FacePiece | EdgePiece;

interface Range { readonly start: number; readonly count: number; readonly at: number }

interface Chunk {
  readonly key: string;
  readonly members: Set<BatchSource>;
  /** Vertices or segments the members held when they were assigned (the capacity check). */
  size: number;
  dirty: boolean;
  /** The merged face meshes (one per side) or the edge batch and its back-edges pass. */
  objects: Object3D[];
  /** Where each member's face ranges sit in the merged geometry (selection tint copies). */
  ranges: Map<BatchSource, Range[]>;
}

const id = (m: Material): string => m.uuid;
const vertexCount = (g: BufferGeometry): number => g.getAttribute('position')?.count ?? 0;

/** The material a mesh draws over its whole geometry, or null when it draws several groups. */
function soleMaterial(mesh: Mesh<BufferGeometry, Material | Material[]>): Material | null {
  const groups = mesh.geometry.groups, total = vertexCount(mesh.geometry);
  if (!Array.isArray(mesh.material)) return groups.length <= 1 ? mesh.material : null;
  if (groups.length === 0) return mesh.material[0] ?? null;
  if (groups.length > 1) return null;
  const g = groups[0]!;
  return g.start === 0 && g.count >= total ? mesh.material[g.materialIndex ?? 0] ?? null : null;
}

/** The pieces a source draws now, by batch key. Hidden passes are left out. */
function piecesOf(source: BatchSource): Map<string, Piece[]> {
  const out = new Map<string, Piece[]>();
  const add = (key: string, piece: Piece): void => {
    const list = out.get(key);
    if (list) list.push(piece);
    else out.set(key, [piece]);
  };
  const total = vertexCount(source.front.geometry);
  if (total) {
    // Bodies keep their entity's flag beside the On Faces display setting; sketches never receive.
    const flag = source.front.userData['receiveShadows'] as boolean | undefined;
    const cast = source.front.castShadow;
    const receive = flag === undefined ? source.front.receiveShadow : shadowDisplay.onFaces && flag;
    const shadow = `${cast ? 1 : 0}|${flag === undefined ? 'n' : ''}${(flag ?? receive) ? 1 : 0}`;
    const piece = (sides: FaceSide[], start: number, count: number): FacePiece => ({ kind: 'faces', source, sides, start, count, cast, receive, receiveFlag: flag });
    const front = source.front.visible ? soleMaterial(source.front) : null, back = source.back.visible ? soleMaterial(source.back) : null;
    if (front && back) {
      add(`pair|${id(front)}|${id(back)}|${shadow}`, piece([{ side: 'front', geometry: source.front.geometry, material: front }, { side: 'back', geometry: source.back.geometry, material: back }], 0, total));
    } else {
      for (const side of ['front', 'back'] as const) {
        const mesh = source[side];
        if (!mesh.visible) continue;
        const groups = mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count: total, materialIndex: 0 }];
        for (const g of groups) {
          const m = Array.isArray(mesh.material) ? mesh.material[g.materialIndex ?? 0] : mesh.material;
          const count = Math.min(g.count, total - g.start);
          if (m && count > 0) add(`${side}|${id(m)}|${shadow}`, piece([{ side, geometry: mesh.geometry, material: m }], g.start, count));
        }
      }
    }
  }
  if (source.edges.visible && source.edges.segmentCount > 0) {
    add(`edges|${id(source.edges.material)}|${id(source.backEdges.material as Material)}`, { kind: 'edges', source, batch: source.edges, back: source.backEdges });
  }
  if (source.hiddenEdges.visible && source.hiddenEdges.segmentCount > 0) {
    add(`hidden|${id(source.hiddenEdges.material)}`, { kind: 'hidden', source, batch: source.hiddenEdges, back: null });
  }
  return out;
}

const sizeOf = (pieces: readonly Piece[]): number => pieces.reduce((n, p) => n + (p.kind === 'faces' ? p.count : p.batch.segmentCount), 0);

/** One merged attribute: the pieces' ranges of `name` in `geometryOf(piece)`, copied end to end. */
function mergeAttribute(pieces: readonly FacePiece[], total: number, name: string, geometryOf: (p: FacePiece) => BufferGeometry): BufferAttribute | null {
  let layout: BufferAttribute | null = null;
  for (const p of pieces) {
    const a = geometryOf(p).getAttribute(name);
    if (a instanceof BufferAttribute) { layout = a; break; }
  }
  if (!layout) return null;
  const size = layout.itemSize;
  const out = new ((layout.array as TypedArray).constructor as new (n: number) => TypedArray)(total * size);
  let at = 0;
  for (const p of pieces) {
    // An attribute a piece lacks stays zero there (no projective divisor, no tint).
    const a = geometryOf(p).getAttribute(name);
    if (a instanceof BufferAttribute) out.set((a.array as TypedArray).subarray(p.start * size, (p.start + p.count) * size), at * size);
    at += p.count;
  }
  return new BufferAttribute(out, size, layout.normalized);
}

/** A view of `count` items of a merged attribute from item `at`. */
const viewOf = (attr: BufferAttribute, at: number, count: number): BufferAttribute =>
  new BufferAttribute((attr.array as TypedArray).subarray(at * attr.itemSize, (at + count) * attr.itemSize), attr.itemSize, attr.normalized);

/**
 * Static geometry batched per material (PF-191): the faces of every body and sketch renderable that draws the same
 * materials with the same shadow flags are merged into a few meshes, and their edges into a few edge batches, so a
 * model draws in tens of calls instead of several per body and sketch. Batches hold up to `BATCH_CAPACITY` vertices
 * or segments; changing a source rebuilds only the batches it is in, on the next `flush`, and selection tint copies
 * a source's flags into its ranges without a rebuild. A source drawn wholly in batches keeps no copy of its geometry:
 * its attributes become views of the batches' arrays, which section cuts use and which it draws itself from while it
 * cannot be batched.
 */
export class SceneBatches {
  readonly group = new Group();
  private chunks = new Map<string, Chunk[]>();
  private memberships = new Map<BatchSource, Set<Chunk>>();

  constructor() {
    this.group.name = 'Batches';
  }

  has(source: BatchSource): boolean {
    return this.memberships.has(source);
  }

  /** Add a source, or note that what it draws changed. */
  update(source: BatchSource): void {
    const pieces = piecesOf(source);
    const before = this.memberships.get(source) ?? new Set<Chunk>();
    const after = new Set<Chunk>();
    for (const [key, list] of pieces) {
      let chunk = [...before].find((c) => c.key === key);
      if (!chunk) {
        const size = sizeOf(list);
        const all = this.chunks.get(key) ?? [];
        chunk = all.find((c) => c.size + size <= BATCH_CAPACITY);
        if (!chunk) {
          chunk = { key, members: new Set(), size: 0, dirty: true, objects: [], ranges: new Map() };
          all.push(chunk);
          this.chunks.set(key, all);
        }
        chunk.members.add(source);
        chunk.size += size;
      }
      chunk.dirty = true;
      after.add(chunk);
    }
    for (const chunk of before) {
      if (after.has(chunk)) continue;
      chunk.members.delete(source);
      chunk.dirty = true;
    }
    this.memberships.set(source, after);
  }

  remove(source: BatchSource): void {
    const chunks = this.memberships.get(source);
    if (!chunks) return;
    for (const chunk of chunks) {
      chunk.members.delete(source);
      chunk.dirty = true;
    }
    this.memberships.delete(source);
  }

  /** Copy a source's selection flags into the batches holding its faces. */
  syncFlags(source: BatchSource): void {
    // Its front geometry's flags hold the tint, in the vertex order both sides' ranges follow.
    const from = source.front.geometry.getAttribute('flags') as BufferAttribute | undefined;
    if (!from) return;
    for (const chunk of this.memberships.get(source) ?? []) {
      if (chunk.dirty) continue;
      const ranges = chunk.ranges.get(source);
      if (!ranges) continue;
      const targets = new Set<BufferAttribute>();
      for (const o of chunk.objects) {
        const t = (o as Mesh).geometry?.getAttribute('flags');
        if (t instanceof BufferAttribute) targets.add(t);
      }
      for (const target of targets) {
        for (const r of ranges) {
          if (from.array !== target.array) (target.array as Uint8Array).set((from.array as Uint8Array).subarray(r.start, r.start + r.count), r.at);
          target.addUpdateRange(r.at, r.count);
        }
        target.needsUpdate = true;
      }
    }
  }

  /** Rebuild the batches whose members changed. Returns true when any did. */
  flush(): boolean {
    let changed = false;
    for (const [key, list] of this.chunks) {
      for (const chunk of [...list]) {
        if (!chunk.dirty) continue;
        changed = true;
        chunk.dirty = false;
        this.disposeObjects(chunk);
        chunk.ranges = new Map();
        if (!chunk.members.size) {
          list.splice(list.indexOf(chunk), 1);
          continue;
        }
        const pieces: Piece[] = [];
        for (const member of chunk.members) pieces.push(...(piecesOf(member).get(key) ?? []));
        chunk.size = sizeOf(pieces);
        if (pieces[0]?.kind === 'faces') this.buildFaces(chunk, pieces as FacePiece[]);
        else if (pieces[0]) this.buildEdges(chunk, pieces as EdgePiece[]);
      }
      if (!list.length) this.chunks.delete(key);
    }
    return changed;
  }

  /** The merged front-face meshes (picking: every triangle once). */
  faceMeshes(): Mesh[] {
    return this.allFaceMeshes().filter((m) => m.name === 'faces');
  }

  /** Every merged face mesh, front and back. */
  allFaceMeshes(): Mesh[] {
    const out: Mesh[] = [];
    for (const list of this.chunks.values()) for (const c of list) for (const o of c.objects) if (o instanceof Mesh && !(o instanceof LineSegments2)) out.push(o);
    return out;
  }

  /** Batches drawn, for tests and measurements. */
  get batchCount(): number {
    let n = 0;
    for (const list of this.chunks.values()) n += list.length;
    return n;
  }

  private buildFaces(chunk: Chunk, pieces: FacePiece[]): void {
    const first = pieces[0]!;
    const total = pieces.reduce((n, p) => n + p.count, 0);
    // Shared attributes are merged once, from the first side; each side's own attributes from that side.
    const shared = new Map<string, BufferAttribute>();
    for (const name of SHARED) {
      const merged = mergeAttribute(pieces, total, name, (p) => p.sides[0]!.geometry);
      if (merged) shared.set(name, merged);
    }
    const sides = first.sides.map((s, i) => {
      const geometry = new BufferGeometry();
      for (const [name, attr] of shared) geometry.setAttribute(name, attr);
      for (const name of Object.keys(s.geometry.attributes)) {
        if (SHARED.has(name)) continue;
        const merged = mergeAttribute(pieces, total, name, (p) => p.sides[i]!.geometry);
        if (merged) geometry.setAttribute(name, merged);
      }
      return { side: s.side, geometry, material: s.material };
    });
    let at = 0;
    for (const p of pieces) {
      const list = chunk.ranges.get(p.source);
      const range = { start: p.start, count: p.count, at };
      if (list) list.push(range);
      else chunk.ranges.set(p.source, [range]);
      // A source drawn wholly in this batch keeps no copy of its own: its attributes become views of the batch's,
      // its sides sharing the views of the shared ones as they shared the buffers.
      if (p.start === 0 && p.count === vertexCount(p.sides[0]!.geometry)) {
        const views = new Map<string, BufferAttribute>();
        for (const [name, attr] of shared) views.set(name, viewOf(attr, at, p.count));
        p.sides.forEach((s, i) => {
          for (const name of Object.keys(s.geometry.attributes)) {
            const merged = sides[i]!.geometry.getAttribute(name);
            const view = views.get(name) ?? (merged instanceof BufferAttribute ? viewOf(merged, at, p.count) : null);
            if (view) s.geometry.setAttribute(name, view);
          }
        });
      }
      at += p.count;
    }
    for (const s of sides) {
      s.geometry.computeBoundingBox();
      s.geometry.computeBoundingSphere();
      const mesh = new Mesh(s.geometry, s.material);
      mesh.name = s.side === 'front' ? 'faces' : 'backfaces';
      mesh.castShadow = first.cast;
      mesh.receiveShadow = first.receive;
      if (first.receiveFlag !== undefined) mesh.userData['receiveShadows'] = first.receiveFlag;
      mesh.matrixAutoUpdate = false;
      chunk.objects.push(mesh);
      this.group.add(mesh);
    }
  }

  private buildEdges(chunk: Chunk, pieces: EdgePiece[]): void {
    const total = pieces.reduce((n, p) => n + p.batch.segmentCount, 0);
    const positions = new Float32Array(total * 6), colors = new Float32Array(total * 6);
    const normalA = new Float32Array(total * 3), normalB = new Float32Array(total * 3), flags = new Uint8Array(total);
    let at = 0;
    for (const { batch } of pieces) {
      const n = batch.segmentCount, g = batch.geometry;
      const start = g.getAttribute('instanceStart') as unknown as { data: { array: Float32Array } };
      const color = g.getAttribute('instanceColorStart') as unknown as { data: { array: Float32Array } } | undefined;
      positions.set(start.data.array.subarray(0, n * 6), at * 6);
      if (color) colors.set(color.data.array.subarray(0, n * 6), at * 6);
      else colors.fill(1, at * 6, (at + n) * 6);
      normalA.set((g.getAttribute('instanceNormalA').array as Float32Array).subarray(0, n * 3), at * 3);
      normalB.set((g.getAttribute('instanceNormalB').array as Float32Array).subarray(0, n * 3), at * 3);
      flags.set((g.getAttribute('instanceFlags').array as Uint8Array).subarray(0, n), at);
      at += n;
    }
    // The sources keep views of the merged arrays instead of their own (their line distances stay theirs).
    at = 0;
    for (const { batch } of pieces) {
      const n = batch.segmentCount, g = batch.geometry;
      g.setPositions(positions.subarray(at * 6, (at + n) * 6));
      g.setColors(colors.subarray(at * 6, (at + n) * 6));
      g.setAttribute('instanceNormalA', new InstancedBufferAttribute(normalA.subarray(at * 3, (at + n) * 3), 3));
      g.setAttribute('instanceNormalB', new InstancedBufferAttribute(normalB.subarray(at * 3, (at + n) * 3), 3));
      g.setAttribute('instanceFlags', new InstancedBufferAttribute(flags.subarray(at, at + n), 1));
      at += n;
    }
    const first = pieces[0]!;
    const edges = new EdgeBatch(first.batch.material);
    edges.setSegments({ positions, normalA, normalB, flags, colors });
    edges.matrixAutoUpdate = false;
    chunk.objects.push(edges);
    this.group.add(edges);
    if (first.back) {
      const back = new LineSegments2(edges.geometry, first.back.material as LineMaterial);
      back.name = 'BackEdges';
      back.frustumCulled = false;
      back.renderOrder = 1;
      back.matrixAutoUpdate = false;
      chunk.objects.push(back);
      this.group.add(back);
    }
  }

  private disposeObjects(chunk: Chunk): void {
    for (const o of chunk.objects) {
      this.group.remove(o);
      // The back-edges pass shares its edge batch's geometry.
      if (!(o instanceof LineSegments2) || o instanceof EdgeBatch) (o as Mesh).geometry.dispose();
    }
    chunk.objects = [];
  }

  dispose(): void {
    for (const list of this.chunks.values()) for (const chunk of list) this.disposeObjects(chunk);
    this.chunks.clear();
    this.memberships.clear();
  }
}
