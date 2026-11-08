// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * The binary protocol between the webview and the native kernel (crates/native-kernel, `wire.rs`), both directions
 * little-endian. Meshes stay as raw typed arrays, never JSON. Every decoded result owns its buffers, like a result
 * from the worker, since consumers may transfer them onwards.
 */
import type {
  EnsureBodyRequest,
  EnsureBodyResponse,
  FaceOrigin,
  KernelComponent,
  MeshWire,
  PushPullPreview,
  PushPullPreviewRequest,
  PushPullRequest,
  PushPullResult,
  ReleaseRequest,
  ReleaseResult,
} from '../protocol';

const OP_ENSURE_BODY = 1;
const OP_PUSH_PULL = 2;
const OP_RELEASE = 3;

class Writer {
  private buffer = new ArrayBuffer(64);
  private view = new DataView(this.buffer);
  private at = 0;

  private reserve(bytes: number): void {
    if (this.at + bytes <= this.buffer.byteLength) return;
    let size = this.buffer.byteLength * 2;
    while (size < this.at + bytes) size *= 2;
    const grown = new ArrayBuffer(size);
    new Uint8Array(grown).set(new Uint8Array(this.buffer, 0, this.at));
    this.buffer = grown;
    this.view = new DataView(grown);
  }

  u32(value: number): void {
    this.reserve(4);
    this.view.setUint32(this.at, value, true);
    this.at += 4;
  }

  f64(value: number): void {
    this.reserve(8);
    this.view.setFloat64(this.at, value, true);
    this.at += 8;
  }

  /** Raw bytes of a typed array; desktop platforms are little-endian, as the format is. */
  raw(values: Float64Array | Uint32Array): void {
    this.reserve(values.byteLength);
    new Uint8Array(this.buffer, this.at, values.byteLength).set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
    this.at += values.byteLength;
  }

  finish(): Uint8Array {
    return new Uint8Array(this.buffer, 0, this.at);
  }
}

function writeMesh(w: Writer, mesh: MeshWire): void {
  w.u32(mesh.verts.length / 3);
  w.u32(mesh.tris.length / 3);
  w.raw(mesh.verts);
  w.raw(mesh.tris);
  w.raw(mesh.faceId);
}

export function encodeEnsureBody(req: EnsureBodyRequest): Uint8Array {
  const w = new Writer();
  w.u32(OP_ENSURE_BODY);
  w.f64(req.bodyId);
  w.f64(req.version);
  w.u32(req.mesh !== undefined ? 1 : 0);
  if (req.mesh !== undefined) writeMesh(w, req.mesh);
  return w.finish();
}

export function encodeRelease(req: ReleaseRequest): Uint8Array {
  const w = new Writer();
  w.u32(OP_RELEASE);
  w.f64(req.bodyId);
  w.u32(req.version !== undefined ? 1 : 0);
  w.f64(req.version ?? 0);
  return w.finish();
}

export function encodePushPull(req: PushPullRequest | PushPullPreviewRequest): Uint8Array {
  const w = new Writer();
  w.u32(OP_PUSH_PULL);
  w.f64(req.body.bodyId);
  w.f64(req.body.version);
  const { region, distance, mode, nextFaceId } = req;
  w.u32(region.faceId);
  w.u32(region.regionIsWholeFace ? 1 : 0);
  for (const vector of [region.basis.origin, region.basis.u, region.basis.v, region.basis.n]) {
    w.f64(vector[0]);
    w.f64(vector[1]);
    w.f64(vector[2]);
  }
  w.f64(distance);
  w.u32(mode === 'newBody' ? 1 : 0);
  w.u32(req.preview ? 1 : 0);
  w.f64(nextFaceId);
  w.u32(region.polygon.length);
  for (const contour of region.polygon) w.u32(contour.length);
  for (const contour of region.polygon) {
    for (const point of contour) {
      w.f64(point[0] ?? 0);
      w.f64(point[1] ?? 0);
    }
  }
  return w.finish();
}

class Reader {
  private readonly view: DataView;
  private at = 0;

  constructor(private readonly buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  u32(): number {
    const value = this.view.getUint32(this.at, true);
    this.at += 4;
    return value;
  }

  f64(): number {
    this.align(8);
    const value = this.view.getFloat64(this.at, true);
    this.at += 8;
    return value;
  }

  private align(n: number): void {
    this.at = Math.ceil(this.at / n) * n;
  }

  /** A run of `count` Float64s as its own buffer. */
  f64s(count: number): Float64Array {
    this.align(8);
    const out = new Float64Array(this.buffer.slice(this.at, this.at + count * 8));
    this.at += count * 8;
    return out;
  }

  /** A run of `count` Uint32s as its own buffer. */
  u32s(count: number): Uint32Array {
    this.align(4);
    const out = new Uint32Array(this.buffer.slice(this.at, this.at + count * 4));
    this.at += count * 4;
    return out;
  }
}

export function decodeEnsureBody(buffer: ArrayBuffer): EnsureBodyResponse {
  const r = new Reader(buffer);
  r.u32();
  const status = r.u32();
  return { status: status === 0 ? 'cached' : 'needMesh', runId: r.u32() };
}

export function decodeRelease(buffer: ArrayBuffer): ReleaseResult {
  const r = new Reader(buffer);
  r.u32();
  return { released: r.u32() };
}

function readComponent(r: Reader): KernelComponent {
  const volume = r.f64();
  const area = r.f64();
  const runId = r.u32();
  const numVerts = r.u32();
  const numTris = r.u32();
  const numOrigins = r.u32();
  const faceOrigin: FaceOrigin = new Map();
  for (let i = 0; i < numOrigins; i++) {
    const face = r.u32();
    const count = r.u32();
    const origins = [];
    for (let k = 0; k < count; k++) origins.push({ runId: r.u32(), faceId: r.u32() });
    faceOrigin.set(face, origins);
  }
  const verts = r.f64s(numVerts * 3);
  const tris = r.u32s(numTris * 3);
  const faceId = r.u32s(numTris);
  return { mesh: { verts, tris, faceId, runId }, faceOrigin, props: { volume, area } };
}

export function decodePushPull(buffer: ArrayBuffer): PushPullResult | PushPullPreview {
  const r = new Reader(buffer);
  r.u32();
  const kind = r.u32();
  if (kind === 1) {
    const numVerts = r.u32();
    const numTris = r.u32();
    const verts = r.f64s(numVerts * 3);
    const tris = r.u32s(numTris * 3);
    const faceId = r.u32s(numTris);
    return { preview: true, mesh: { verts, tris, faceId, runId: 0 } };
  }
  const moved = r.u32() !== 0;
  const bodyRunId = r.u32();
  const toolRunId = r.u32();
  const numSide = r.u32();
  const numComponents = r.u32();
  const sideFaceForBoundaryEdge: Record<number, number> = {};
  for (let i = 0; i < numSide; i++) {
    const face = r.u32();
    sideFaceForBoundaryEdge[face] = r.u32();
  }
  const nextFaceId = r.f64();
  const components: KernelComponent[] = [];
  for (let i = 0; i < numComponents; i++) components.push(readComponent(r));
  return { components, sideFaceForBoundaryEdge, nextFaceId, bodyRunId, toolRunId, ...(moved ? { moved: true } : {}) };
}
