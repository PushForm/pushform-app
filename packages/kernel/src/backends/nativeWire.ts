// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * The binary protocol between the webview and the Rust kernel (crates/native-kernel, `wire.rs`), both directions
 * little-endian. Meshes stay as raw typed arrays, never JSON. Every decoded result owns its buffers, like a result
 * from the worker, since consumers may transfer them onwards.
 */
import { resolveHardwareOptions } from '../hardware';
import type {
  BooleanOp,
  BooleanResult,
  BodyRef,
  ComponentsResult,
  EdgeBlendResult,
  EnsureBodyRequest,
  EnsureBodyResponse,
  FaceOrigin,
  FromTrianglesResult,
  HardwareResult,
  KernelComponent,
  KernelRequest,
  ManifoldStatus,
  MeshWire,
  PolygonsWithHoles,
  PropertiesResult,
  PushPullPreview,
  PushPullPreviewRequest,
  PushPullRequest,
  PushPullResult,
  ReleaseRequest,
  ReleaseResult,
  ResFor,
  SectionCutResult,
  StatsResult,
  ToolSoup,
} from '../protocol';

const OP_ENSURE_BODY = 1;
const OP_PUSH_PULL = 2;
const OP_RELEASE = 3;
const OP_INIT = 4;
const OP_EXTRUDE_SKETCH = 5;
const OP_BOOLEAN = 6;
const OP_TRANSFORM = 7;
const OP_AUTOFOLD = 8;
const OP_SECTION_CUT = 9;
const OP_PROPERTIES = 10;
const OP_FROM_TRIANGLES = 11;
const OP_DECOMPOSE = 12;
const OP_SIMPLIFY = 13;
const OP_HULL = 14;
const OP_FOLLOW_ME = 15;
const OP_REVOLVE = 16;
const OP_EDGE_BLEND = 17;
const OP_STATS = 18;
const OP_VALIDATE_SOLID = 19;
const OP_HARDWARE = 20;

const BOOLEAN_OPS: readonly BooleanOp[] = ['add', 'subtract', 'intersect', 'split', 'trim'];

/** Status names in the order `wire.rs` writes them for `fromTriangles`. */
const STATUS_NAMES: readonly ManifoldStatus[] = ['NoError', 'NonFiniteVertex', 'NotManifold', 'VertexOutOfBounds', 'PropertiesWrongLength', 'MissingPositionProperties', 'MergeVectorsDifferentLengths', 'MergeIndexOutOfBounds', 'TransformWrongLength', 'RunIndexWrongLength', 'FaceIDWrongLength', 'InvalidConstruction', 'ResultTooLarge', 'InvalidTangents', 'Cancelled', 'Unknown', 'Unknown'];

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

  /** A string as its UTF-8 length and bytes. */
  string(value: string): void {
    const bytes = new TextEncoder().encode(value);
    this.u32(bytes.byteLength);
    this.reserve(bytes.byteLength);
    new Uint8Array(this.buffer, this.at, bytes.byteLength).set(bytes);
    this.at += bytes.byteLength;
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

/** Each array with its own length, so a mesh Manifold must reject arrives exactly as it was sent. */
function writeMesh(w: Writer, mesh: MeshWire | ToolSoup): void {
  w.u32(mesh.verts.length);
  w.u32(mesh.tris.length);
  w.u32(mesh.faceId.length);
  w.raw(mesh.verts);
  w.raw(mesh.tris);
  w.raw(mesh.faceId);
}

function writeBody(w: Writer, body: BodyRef): void {
  w.f64(body.bodyId);
  w.f64(body.version);
}

function writeVec3(w: Writer, v: readonly number[]): void {
  w.f64(v[0]!);
  w.f64(v[1]!);
  w.f64(v[2]!);
}

function writeBasis(w: Writer, basis: { origin: readonly number[]; u: readonly number[]; v: readonly number[]; n: readonly number[] }): void {
  writeVec3(w, basis.origin);
  writeVec3(w, basis.u);
  writeVec3(w, basis.v);
  writeVec3(w, basis.n);
}

/** Contour sizes then points. A point missing a coordinate gets `missing`, as the operation reading it would see it. */
function writePolygon(w: Writer, polygon: PolygonsWithHoles, missing: number): void {
  w.u32(polygon.length);
  for (const contour of polygon) w.u32(contour.length);
  for (const contour of polygon) {
    for (const point of contour) {
      w.f64(point[0] ?? missing);
      w.f64(point[1] ?? missing);
    }
  }
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

/** Asks the kernel whether a mesh is a valid solid enclosing positive volume; the answer is an empty response or an error. */
export function encodeValidateSolid(mesh: Pick<MeshWire, 'verts' | 'tris' | 'faceId'>): Uint8Array {
  const w = new Writer();
  w.u32(OP_VALIDATE_SOLID);
  writeMesh(w, mesh as MeshWire);
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
  writeBody(w, req.body);
  const { region, distance, mode, nextFaceId } = req;
  w.f64(region.faceId);
  w.u32(region.regionIsWholeFace ? 1 : 0);
  writeBasis(w, region.basis);
  w.f64(distance);
  w.u32(mode === 'newBody' ? 1 : 0);
  w.u32(req.preview ? 1 : 0);
  w.f64(nextFaceId);
  writePolygon(w, region.polygon, 0);
  return w.finish();
}

/** Encode any kernel request for the Rust kernel. */
export function encodeRequest(req: KernelRequest): Uint8Array {
  const w = new Writer();
  switch (req.type) {
    case 'init':
      w.u32(OP_INIT);
      break;
    case 'ensureBody':
      return encodeEnsureBody(req);
    case 'pushPull':
      return encodePushPull(req);
    case 'release':
      return encodeRelease(req);
    case 'extrudeSketch':
      w.u32(OP_EXTRUDE_SKETCH);
      writeBasis(w, req.basis);
      w.f64(req.distance);
      w.f64(req.nextFaceId);
      writePolygon(w, req.polygon, 0);
      // Leave ordinary requests byte-identical to the existing binary protocol.
      if (req.validateProfile) w.u32(1);
      break;
    case 'boolean':
      w.u32(OP_BOOLEAN);
      w.u32(BOOLEAN_OPS.indexOf(req.op));
      writeBody(w, req.a);
      writeBody(w, req.b);
      w.f64(req.nextFaceId);
      break;
    case 'transform':
      w.u32(OP_TRANSFORM);
      writeBody(w, req.body);
      w.u32(req.matrix.length);
      for (const x of req.matrix) w.f64(x);
      w.f64(req.nextFaceId);
      break;
    case 'autofold':
      w.u32(OP_AUTOFOLD);
      writeMesh(w, req.mesh);
      w.f64(req.nextFaceId);
      break;
    case 'sectionCut':
      w.u32(OP_SECTION_CUT);
      writeBody(w, req.body);
      writeVec3(w, req.plane.n);
      w.f64(req.plane.d);
      break;
    case 'properties':
      w.u32(OP_PROPERTIES);
      writeBody(w, req.body);
      break;
    case 'fromTriangles':
      w.u32(OP_FROM_TRIANGLES);
      writeMesh(w, req.mesh);
      w.f64(req.nextFaceId);
      break;
    case 'decompose':
      w.u32(OP_DECOMPOSE);
      writeBody(w, req.body);
      w.f64(req.nextFaceId);
      break;
    case 'simplify':
      w.u32(OP_SIMPLIFY);
      writeBody(w, req.body);
      w.u32(req.tolerance !== undefined ? 1 : 0);
      w.f64(req.tolerance ?? 0);
      w.f64(req.nextFaceId);
      break;
    case 'hull':
      w.u32(OP_HULL);
      w.u32(req.bodies.length);
      for (const body of req.bodies) writeBody(w, body);
      w.f64(req.nextFaceId);
      break;
    case 'followMe':
      w.u32(OP_FOLLOW_ME);
      writePolygon(w, req.profile, Number.NaN);
      writeBasis(w, req.profileBasis);
      w.u32(req.path.length);
      for (const p of req.path) writeVec3(w, p);
      w.u32(req.closed ? 1 : 0);
      w.f64(req.nextFaceId);
      break;
    case 'revolve':
      w.u32(OP_REVOLVE);
      writePolygon(w, req.profile, 0);
      writeBasis(w, req.profileBasis);
      writeVec3(w, req.axisOrigin);
      writeVec3(w, req.axisDir);
      w.f64(req.angleDeg);
      w.f64(req.segments);
      w.f64(req.nextFaceId);
      break;
    case 'edgeBlend':
      w.u32(OP_EDGE_BLEND);
      writeBody(w, req.body);
      w.u32(req.cut.length);
      for (const soup of req.cut) writeMesh(w, soup);
      w.u32(req.add.length);
      for (const soup of req.add) writeMesh(w, soup);
      w.f64(req.nextFaceId);
      break;
    case 'hardware': {
      const options = resolveHardwareOptions(req.options);
      w.u32(OP_HARDWARE);
      w.string(options.shape);
      w.f64(options.length);
      w.f64(options.width);
      w.f64(options.projection);
      w.f64(options.spacing);
      w.f64(options.grip);
      w.f64(options.wall);
      w.f64(options.segments);
      w.f64(req.nextFaceId);
      // Only this shape uses the profile divisions, so every other shape's request is unchanged.
      if (options.shape === 'knob-domed') w.f64(options.profileSegments);
      break;
    }
    case 'stats':
      w.u32(OP_STATS);
      break;
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

function readComponents(r: Reader, count: number): KernelComponent[] {
  const components: KernelComponent[] = [];
  for (let i = 0; i < count; i++) components.push(readComponent(r));
  return components;
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
    const face = r.f64();
    sideFaceForBoundaryEdge[face] = r.u32();
  }
  const nextFaceId = r.f64();
  return { components: readComponents(r, numComponents), sideFaceForBoundaryEdge, nextFaceId, bodyRunId, toolRunId, ...(moved ? { moved: true } : {}) };
}

function decodeComponents(buffer: ArrayBuffer): ComponentsResult {
  const r = new Reader(buffer);
  r.u32();
  const count = r.u32();
  const nextFaceId = r.f64();
  return { components: readComponents(r, count), nextFaceId };
}

function decodeBoolean(buffer: ArrayBuffer): BooleanResult {
  const r = new Reader(buffer);
  r.u32();
  const aRunId = r.u32();
  const bRunId = r.u32();
  const numComponents = r.u32();
  const numSecondary = r.u32();
  const nextFaceId = r.f64();
  const components = readComponents(r, numComponents);
  const secondary = readComponents(r, numSecondary);
  return { components, secondary, nextFaceId, aRunId, bRunId };
}

function decodeHardware(buffer: ArrayBuffer, req: Extract<KernelRequest, { type: 'hardware' }>): HardwareResult {
  const r = new Reader(buffer);
  r.u32();
  const numComponents = r.u32();
  const numCenters = r.u32();
  const nextFaceId = r.f64();
  const mountingCenters: HardwareResult['mountingCenters'] = [];
  for (let i = 0; i < numCenters; i++) mountingCenters.push([r.f64(), r.f64(), r.f64()]);
  return { components: readComponents(r, numComponents), nextFaceId, mountingCenters, resolved: resolveHardwareOptions(req.options) };
}

function decodeEdgeBlend(buffer: ArrayBuffer): EdgeBlendResult {
  const r = new Reader(buffer);
  r.u32();
  const bodyRunId = r.u32();
  const toolRunId = r.u32();
  const count = r.u32();
  const nextFaceId = r.f64();
  return { components: readComponents(r, count), nextFaceId, bodyRunId, toolRunId };
}

function decodeFromTriangles(buffer: ArrayBuffer): FromTrianglesResult {
  const r = new Reader(buffer);
  r.u32();
  const status = STATUS_NAMES[r.u32()] ?? 'Unknown';
  const count = r.u32();
  const nextFaceId = r.f64();
  return { status, components: readComponents(r, count), nextFaceId };
}

function decodeSectionCut(buffer: ArrayBuffer): SectionCutResult {
  const r = new Reader(buffer);
  r.u32();
  const count = r.u32();
  const lengths: number[] = [];
  for (let i = 0; i < count; i++) lengths.push(r.u32());
  return { loops: lengths.map((len) => r.f64s(len)) };
}

function decodeProperties(buffer: ArrayBuffer): PropertiesResult {
  const r = new Reader(buffer);
  r.u32();
  const volume = r.f64();
  const area = r.f64();
  const genus = r.f64();
  const min: [number, number, number] = [r.f64(), r.f64(), r.f64()];
  const max: [number, number, number] = [r.f64(), r.f64(), r.f64()];
  return { volume, area, genus, bounds: { min, max } };
}

function decodeStats(buffer: ArrayBuffer): StatsResult {
  const r = new Reader(buffer);
  r.u32();
  const cached = r.u32();
  return { cached, heapBytes: r.f64() };
}

/** Decode the Rust kernel's answer to `req`. */
export function decodeResponse<R extends KernelRequest>(req: R, buffer: ArrayBuffer): ResFor<R> {
  const decode = (): unknown => {
    switch (req.type) {
      case 'init':
        return { ready: true };
      case 'ensureBody':
        return decodeEnsureBody(buffer);
      case 'release':
        return decodeRelease(buffer);
      case 'pushPull':
      case 'extrudeSketch':
        return decodePushPull(buffer);
      case 'boolean':
        return decodeBoolean(buffer);
      case 'edgeBlend':
        return decodeEdgeBlend(buffer);
      case 'fromTriangles':
        return decodeFromTriangles(buffer);
      case 'hardware':
        return decodeHardware(buffer, req);
      case 'sectionCut':
        return decodeSectionCut(buffer);
      case 'properties':
        return decodeProperties(buffer);
      case 'stats':
        return decodeStats(buffer);
      default:
        return decodeComponents(buffer);
    }
  };
  return decode() as ResFor<R>;
}
