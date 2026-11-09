// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** The fixtures and process plumbing shared by the kernel differential tests. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { meshBox, planeBasis, v3cross, v3normalize, type MeshData, type Vec3 } from '@pushform/core';
import type { RustKernelModule } from '../../wasm/pushform-kernel.js';
import type { KernelClient } from '../client/KernelClient';
import type { PolygonsWithHoles, PushPullRegion } from '../protocol';
import { square, topRegion } from '../test/helpers';
import type { NativeKernelTransport } from './NativeKernelBackend';

/** The native kernel's test process: framed requests over stdio. Needs its binary to be built. */
export class HarnessTransport implements NativeKernelTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private incoming = Buffer.alloc(0);
  private readonly waiting: Array<{ resolve: (b: ArrayBuffer) => void; reject: (e: unknown) => void }> = [];

  constructor(private readonly path: string) {}

  start(): void {
    this.child = spawn(this.path, [], { stdio: 'pipe' });
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
  }
  stop(): void {
    this.child?.kill();
  }
  private onData(chunk: Buffer): void {
    this.incoming = Buffer.concat([this.incoming, chunk]);
    while (this.incoming.length >= 5) {
      const len = this.incoming.readUInt32LE(1);
      if (this.incoming.length < 5 + len) return;
      const status = this.incoming[0]!;
      const body = this.incoming.subarray(5, 5 + len);
      this.incoming = this.incoming.subarray(5 + len);
      const w = this.waiting.shift()!;
      if (status === 0) w.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
      else w.reject(body.toString('utf8'));
    }
  }
  private frame(kind: number, payload: Uint8Array): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      const head = Buffer.alloc(5);
      head[0] = kind;
      head.writeUInt32LE(payload.byteLength, 1);
      this.child!.stdin.write(head);
      this.child!.stdin.write(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength));
    });
  }
  available(): Promise<boolean> {
    return Promise.resolve(true);
  }
  call(request: Uint8Array): Promise<ArrayBuffer> {
    return this.frame(0, request);
  }
  async abort(): Promise<void> {
    await this.frame(1, new Uint8Array());
  }
}

export type RustModuleFactory = (options?: object) => Promise<RustKernelModule>;

export { InlineRustTransport } from './InlineRustTransport';

export interface DifferentialCase {
  name: string;
  mesh: () => Promise<MeshData> | MeshData;
  region: (mesh: MeshData) => PushPullRegion;
  distance: number;
  mode?: 'merge' | 'newBody';
  nextFaceId: number;
}

/** A box rotated about (1,1,0) by 30 degrees and moved far from the origin, with its faces labelled like `meshBox`. */
function rotatedBox(): { mesh: MeshData; top: Vec3; center: Vec3 } {
  const box = meshBox([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
  const angle = (30 * Math.PI) / 180;
  const axis = v3normalize([1, 1, 0]);
  const rotate = (p: Vec3): Vec3 => {
    const c = Math.cos(angle), s = Math.sin(angle);
    const d = axis[0] * p[0] + axis[1] * p[1] + axis[2] * p[2];
    const x = v3cross(axis, p);
    return [p[0] * c + x[0] * s + axis[0] * d * (1 - c), p[1] * c + x[1] * s + axis[1] * d * (1 - c), p[2] * c + x[2] * s + axis[2] * d * (1 - c)];
  };
  const center: Vec3 = [100, -50, 20];
  const verts = new Float64Array(box.verts.length);
  for (let i = 0; i < verts.length; i += 3) {
    const r = rotate([box.verts[i]!, box.verts[i + 1]!, box.verts[i + 2]!]);
    verts[i] = r[0] + center[0];
    verts[i + 1] = r[1] + center[1];
    verts[i + 2] = r[2] + center[2];
  }
  return { mesh: { verts, tris: box.tris, faceId: box.faceId }, top: rotate([0, 0, 1]), center };
}

/** Body built with the WebAssembly kernel (booleans are not part of the native kernel). */
async function lShapedBody(wasm: KernelClient): Promise<MeshData> {
  const slab = meshBox([0, 0, 0], [2, 1, 1]);
  const block = meshBox([0, 0, 1], [1, 1, 2]);
  await wasm.ensureBody(900, 1, slab);
  await wasm.ensureBody(901, 1, block);
  const union = await wasm.boolean({ op: 'add', a: { bodyId: 900, version: 1 }, b: { bodyId: 901, version: 1 }, nextFaceId: 6 });
  return union.components[0]!.mesh;
}

/** An n-sided prism about the z axis: side quads with their own face ids, then the two caps. */
function prism(sides: number, radius: number, height: number): MeshData & { capTop: number; capBottom: number } {
  const verts: number[] = [];
  const tris: number[] = [];
  const faceId: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * 2 * Math.PI;
    verts.push(radius * Math.cos(a), radius * Math.sin(a), 0, radius * Math.cos(a), radius * Math.sin(a), height);
  }
  const bottom = (i: number): number => (i % sides) * 2;
  const top = (i: number): number => (i % sides) * 2 + 1;
  for (let i = 0; i < sides; i++) {
    tris.push(bottom(i), bottom(i + 1), top(i + 1), bottom(i), top(i + 1), top(i));
    faceId.push(i, i);
  }
  for (let i = 1; i + 1 < sides; i++) {
    tris.push(top(0), top(i), top(i + 1));
    faceId.push(sides);
    tris.push(bottom(0), bottom(i + 1), bottom(i));
    faceId.push(sides + 1);
  }
  return { verts: new Float64Array(verts), tris: new Uint32Array(tris), faceId: new Uint32Array(faceId), capTop: sides, capBottom: sides + 1 };
}

const nGonCap = (sides: number, radius: number): PolygonsWithHoles => [Array.from({ length: sides }, (_, i) => [radius * Math.cos((i / sides) * 2 * Math.PI), radius * Math.sin((i / sides) * 2 * Math.PI)])];

/** The side facet `i` of `prism(sides, radius, height)` as a whole-face region. */
function prismSideRegion(sides: number, radius: number, height: number, i: number): PushPullRegion {
  const angle = ((i + 0.5) / sides) * 2 * Math.PI;
  const n: Vec3 = [Math.cos(angle), Math.sin(angle), 0];
  const ca: Vec3 = [radius * Math.cos((i / sides) * 2 * Math.PI), radius * Math.sin((i / sides) * 2 * Math.PI), 0];
  const cb: Vec3 = [radius * Math.cos(((i + 1) / sides) * 2 * Math.PI), radius * Math.sin(((i + 1) / sides) * 2 * Math.PI), 0];
  const mid: Vec3 = [(ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2, height / 2];
  const basis = planeBasis(mid, n);
  const uv = (p: Vec3): [number, number] => [
    (p[0] - mid[0]) * basis.u[0] + (p[1] - mid[1]) * basis.u[1] + (p[2] - mid[2]) * basis.u[2],
    (p[0] - mid[0]) * basis.v[0] + (p[1] - mid[1]) * basis.v[1] + (p[2] - mid[2]) * basis.v[2],
  ];
  const up = (p: Vec3): Vec3 => [p[0], p[1], height];
  const polygon = [[uv(ca), uv(cb), uv(up(cb)), uv(up(ca))]];
  return { faceId: i, basis, polygon, regionIsWholeFace: true };
}

export function largestUpFace(mesh: MeshData): number {
  const area = new Map<number, number>();
  for (let t = 0; t < mesh.faceId.length; t++) {
    const [a, b, c] = [mesh.tris[t * 3]!, mesh.tris[t * 3 + 1]!, mesh.tris[t * 3 + 2]!];
    const pa: Vec3 = [mesh.verts[a * 3]!, mesh.verts[a * 3 + 1]!, mesh.verts[a * 3 + 2]!];
    const pb: Vec3 = [mesh.verts[b * 3]!, mesh.verts[b * 3 + 1]!, mesh.verts[b * 3 + 2]!];
    const pc: Vec3 = [mesh.verts[c * 3]!, mesh.verts[c * 3 + 1]!, mesh.verts[c * 3 + 2]!];
    const n = v3cross([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]]);
    if (n[2] <= 1e-9) continue;
    area.set(mesh.faceId[t]!, (area.get(mesh.faceId[t]!) ?? 0) + n[2]);
  }
  return [...area.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]![0];
}

/** A base and an overhang joined by a post on the left half, as in the kernel's overhang fixture. */
async function overhangBody(wasm: KernelClient): Promise<MeshData> {
  await wasm.ensureBody(902, 1, meshBox([0, 0, 0], [2, 1, 1]));
  await wasm.ensureBody(903, 1, meshBox([0, 0, 1], [1, 1, 1.5]));
  await wasm.ensureBody(904, 1, meshBox([0, 0, 1.5], [2, 1, 2.5]));
  const u1 = await wasm.boolean({ op: 'add', a: { bodyId: 902, version: 1 }, b: { bodyId: 903, version: 1 }, nextFaceId: 6 });
  await wasm.ensureBody(905, 1, u1.components[0]!.mesh);
  const u2 = await wasm.boolean({ op: 'add', a: { bodyId: 905, version: 1 }, b: { bodyId: 904, version: 1 }, nextFaceId: u1.nextFaceId });
  return u2.components[0]!.mesh;
}

const unitTop = (polygon: PolygonsWithHoles, whole: boolean): PushPullRegion => topRegion([0.5, 0.5, 1], polygon, 1, whole);
const box = (): MeshData => meshBox([0, 0, 0], [1, 1, 1]);

function rotatedRegion(polygon: PolygonsWithHoles, whole: boolean): PushPullRegion {
  const { top, center } = rotatedBox();
  return { faceId: 1, basis: planeBasis([center[0] + top[0] * 0.5, center[1] + top[1] * 0.5, center[2] + top[2] * 0.5], top), polygon, regionIsWholeFace: whole };
}

/** The push/pull fixtures; `kernel` is the TypeScript kernel used to build the bodies that need booleans. */
export function differentialCases(kernel: () => KernelClient): DifferentialCase[] {
  return [
  { name: 'pull the whole top face by moving it', mesh: box, region: () => unitTop(square(0, 0, 1), true), distance: 1, nextFaceId: 6 },
  { name: 'pull a square region up', mesh: box, region: () => unitTop(square(0, 0, 0.2), false), distance: 0.5, nextFaceId: 6 },
  { name: 'push a square through the box', mesh: box, region: () => unitTop(square(0, 0, 0.2), false), distance: -1, nextFaceId: 6 },
  { name: 'push a blind hole', mesh: box, region: () => unitTop(square(0, 0, 0.2), false), distance: -0.5, nextFaceId: 6 },
  { name: 'pull a region with a hole', mesh: box, region: () => unitTop([...square(0, 0, 0.6), [[-0.1, -0.1], [-0.1, 0.1], [0.1, 0.1], [0.1, -0.1]]], false), distance: 0.3, nextFaceId: 6 },
  { name: 'pull a concave region', mesh: box, region: () => unitTop([[[-0.3, -0.3], [0.3, -0.3], [0.3, 0.1], [0.05, 0.1], [0.05, 0.3], [-0.3, 0.3]]], false), distance: 0.4, nextFaceId: 6 },
  { name: 'newBody mode extrudes a standalone solid', mesh: box, region: () => unitTop(square(0, 0, 0.5), false), distance: 0.25, mode: 'newBody', nextFaceId: 1 },
  { name: 'split the body by pushing a slot across it', mesh: () => meshBox([0, 0, 0], [3, 1, 1]), region: () => ({ faceId: 1, basis: planeBasis([1.5, 0.5, 1], [0, 0, 1]), polygon: [[[-0.25, -2], [0.25, -2], [0.25, 2], [-0.25, 2]]], regionIsWholeFace: false }), distance: -1.5, nextFaceId: 6 },
  { name: 'pull a stepped body face up to merge coplanar', mesh: () => lShapedBody(kernel()), region: () => topRegion([1.5, 0.5, 1], square(0, 0, 1), 1, true), distance: 1, nextFaceId: 8 },
  { name: 'pull into the underside of an overhang and fuse', mesh: () => overhangBody(kernel()), region: () => topRegion([1.5, 0.5, 1], square(0, 0, 1), 1, true), distance: 0.5, nextFaceId: 40 },
  { name: 'rotated box far from the origin: pull a region', mesh: () => rotatedBox().mesh, region: () => rotatedRegion(square(0, 0, 0.2), false), distance: 0.5, nextFaceId: 6 },
  { name: 'rotated box: push a blind hole', mesh: () => rotatedBox().mesh, region: () => rotatedRegion(square(0, 0, 0.3), false), distance: -0.4, nextFaceId: 6 },
  { name: 'rotated box: pull the whole face', mesh: () => rotatedBox().mesh, region: () => rotatedRegion(square(0, 0, 1), true), distance: 0.7, nextFaceId: 6 },
  { name: '64-gon prism: pull a square region on the cap', mesh: () => prism(64, 1, 2), region: () => ({ faceId: 64, basis: planeBasis([0, 0, 2], [0, 0, 1]), polygon: square(0.1, -0.2, 0.5), regionIsWholeFace: false }), distance: 0.75, nextFaceId: 66 },
  { name: '64-gon prism: pull the whole cap by moving it', mesh: () => prism(64, 1, 2), region: () => ({ faceId: 64, basis: planeBasis([0, 0, 2], [0, 0, 1]), polygon: nGonCap(64, 1), regionIsWholeFace: true }), distance: 0.5, nextFaceId: 66 },
  { name: '64-gon prism: push a blind hole in the cap', mesh: () => prism(64, 1, 2), region: () => ({ faceId: 64, basis: planeBasis([0, 0, 2], [0, 0, 1]), polygon: nGonCap(16, 0.4), regionIsWholeFace: false }), distance: -1.2, nextFaceId: 66 },
  { name: '64-gon prism: pull a whole side facet', mesh: () => prism(64, 1, 2), region: () => prismSideRegion(64, 1, 2, 5), distance: 0.3, nextFaceId: 66 },
  ];
}
