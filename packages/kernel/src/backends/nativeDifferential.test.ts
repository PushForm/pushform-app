// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Runs push/pull down both paths on the kernel's fixtures and compares them: WebAssembly through the inline backend and
 * native through the kernel's own harness process, over the real binary protocol. Needs the harness binary:
 *   cargo build --release --features harness --bin pushform-native-kernel-harness   (in crates/native-kernel)
 * Skipped when it has not been built, so the suite stays independent of cmake and C++.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meshBox, planeBasis, v3cross, v3normalize, type MeshData, type Vec3 } from '@pushform/core';
import { InlineBackend } from './InlineBackend';
import { NativeKernelBackend, type NativeKernelTransport } from './NativeKernelBackend';
import { KernelClient } from '../client/KernelClient';
import { meshTopologyProblems } from '../meshChecks';
import type { FaceOrigin, MeshWire, PolygonsWithHoles, PushPullPreview, PushPullRegion, PushPullResult } from '../protocol';
import { square, topRegion } from '../test/helpers';

const harnessPath = resolve(__dirname, '../../../../crates/native-kernel/target/release/pushform-native-kernel-harness');
const haveHarness = existsSync(harnessPath);

class HarnessTransport implements NativeKernelTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private incoming = Buffer.alloc(0);
  private readonly waiting: Array<{ resolve: (b: ArrayBuffer) => void; reject: (e: unknown) => void }> = [];

  start(): void {
    this.child = spawn(harnessPath, [], { stdio: 'pipe' });
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

const POSITION_TOLERANCE = 1e-9;

let harness: HarnessTransport;
let wasm: KernelClient;
let native: NativeKernelBackend;
const uploaded = new Map<string, MeshWire>();

interface Case {
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
async function lShapedBody(): Promise<MeshData> {
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

function largestUpFace(mesh: MeshData): number {
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

const unitTop = (polygon: PolygonsWithHoles, whole: boolean): PushPullRegion => topRegion([0.5, 0.5, 1], polygon, 1, whole);
const box = (): MeshData => meshBox([0, 0, 0], [1, 1, 1]);

function rotatedRegion(polygon: PolygonsWithHoles, whole: boolean): PushPullRegion {
  const { top, center } = rotatedBox();
  return { faceId: 1, basis: planeBasis([center[0] + top[0] * 0.5, center[1] + top[1] * 0.5, center[2] + top[2] * 0.5], top), polygon, regionIsWholeFace: whole };
}

const cases: Case[] = [
  { name: 'pull the whole top face by moving it', mesh: box, region: () => unitTop(square(0, 0, 1), true), distance: 1, nextFaceId: 6 },
  { name: 'pull a square region up', mesh: box, region: () => unitTop(square(0, 0, 0.2), false), distance: 0.5, nextFaceId: 6 },
  { name: 'push a square through the box', mesh: box, region: () => unitTop(square(0, 0, 0.2), false), distance: -1, nextFaceId: 6 },
  { name: 'push a blind hole', mesh: box, region: () => unitTop(square(0, 0, 0.2), false), distance: -0.5, nextFaceId: 6 },
  { name: 'pull a region with a hole', mesh: box, region: () => unitTop([...square(0, 0, 0.6), [[-0.1, -0.1], [-0.1, 0.1], [0.1, 0.1], [0.1, -0.1]]], false), distance: 0.3, nextFaceId: 6 },
  { name: 'pull a concave region', mesh: box, region: () => unitTop([[[-0.3, -0.3], [0.3, -0.3], [0.3, 0.1], [0.05, 0.1], [0.05, 0.3], [-0.3, 0.3]]], false), distance: 0.4, nextFaceId: 6 },
  { name: 'newBody mode extrudes a standalone solid', mesh: box, region: () => unitTop(square(0, 0, 0.5), false), distance: 0.25, mode: 'newBody', nextFaceId: 1 },
  { name: 'split the body by pushing a slot across it', mesh: () => meshBox([0, 0, 0], [3, 1, 1]), region: () => ({ faceId: 1, basis: planeBasis([1.5, 0.5, 1], [0, 0, 1]), polygon: [[[-0.25, -2], [0.25, -2], [0.25, 2], [-0.25, 2]]], regionIsWholeFace: false }), distance: -1.5, nextFaceId: 6 },
  { name: 'pull a stepped body face up to merge coplanar', mesh: lShapedBody, region: () => topRegion([1.5, 0.5, 1], square(0, 0, 1), 1, true), distance: 1, nextFaceId: 8 },
  { name: 'rotated box far from the origin: pull a region', mesh: () => rotatedBox().mesh, region: () => rotatedRegion(square(0, 0, 0.2), false), distance: 0.5, nextFaceId: 6 },
  { name: 'rotated box: push a blind hole', mesh: () => rotatedBox().mesh, region: () => rotatedRegion(square(0, 0, 0.3), false), distance: -0.4, nextFaceId: 6 },
  { name: 'rotated box: pull the whole face', mesh: () => rotatedBox().mesh, region: () => rotatedRegion(square(0, 0, 1), true), distance: 0.7, nextFaceId: 6 },
  { name: '64-gon prism: pull a square region on the cap', mesh: () => prism(64, 1, 2), region: () => ({ faceId: 64, basis: planeBasis([0, 0, 2], [0, 0, 1]), polygon: square(0.1, -0.2, 0.5), regionIsWholeFace: false }), distance: 0.75, nextFaceId: 66 },
  { name: '64-gon prism: pull the whole cap by moving it', mesh: () => prism(64, 1, 2), region: () => ({ faceId: 64, basis: planeBasis([0, 0, 2], [0, 0, 1]), polygon: nGonCap(64, 1), regionIsWholeFace: true }), distance: 0.5, nextFaceId: 66 },
  { name: '64-gon prism: push a blind hole in the cap', mesh: () => prism(64, 1, 2), region: () => ({ faceId: 64, basis: planeBasis([0, 0, 2], [0, 0, 1]), polygon: nGonCap(16, 0.4), regionIsWholeFace: false }), distance: -1.2, nextFaceId: 66 },
  { name: '64-gon prism: pull a whole side facet', mesh: () => prism(64, 1, 2), region: () => prismSideRegion(64, 1, 2, 5), distance: 0.3, nextFaceId: 66 },
];

function expectMeshes(name: string, a: MeshWire, b: MeshWire): number {
  expect(b.tris, `${name}: triangle indices`).toEqual(a.tris);
  expect(b.faceId, `${name}: face ids`).toEqual(a.faceId);
  expect(b.verts.length, `${name}: vertex count`).toBe(a.verts.length);
  let worst = 0;
  for (let i = 0; i < a.verts.length; i++) {
    worst = Math.max(worst, Math.abs(a.verts[i]! - b.verts[i]!));
  }
  expect(worst, `${name}: largest position difference`).toBeLessThanOrEqual(POSITION_TOLERANCE);
  return worst;
}

function mapRuns(origins: FaceOrigin, runMap: Map<number, number>): Array<[number, Array<{ runId: number; faceId: number }>]> {
  return [...origins.entries()].map(([face, list]) => [face, list.map((o) => ({ runId: runMap.get(o.runId) ?? -o.runId, faceId: o.faceId }))]);
}

function compareResults(name: string, wasmResult: PushPullResult, nativeResult: PushPullResult): number {
  expect(nativeResult.moved, `${name}: moved`).toEqual(wasmResult.moved);
  expect(nativeResult.nextFaceId, `${name}: nextFaceId`).toBe(wasmResult.nextFaceId);
  expect(nativeResult.sideFaceForBoundaryEdge, `${name}: side faces`).toEqual(wasmResult.sideFaceForBoundaryEdge);
  expect(nativeResult.components.length, `${name}: component count`).toBe(wasmResult.components.length);
  let worst = 0;
  const runMap = new Map([[nativeResult.bodyRunId, wasmResult.bodyRunId], [nativeResult.toolRunId, wasmResult.toolRunId]]);
  for (let i = 0; i < wasmResult.components.length; i++) {
    const a = wasmResult.components[i]!, b = nativeResult.components[i]!;
    worst = Math.max(worst, expectMeshes(`${name} #${i}`, a.mesh, b.mesh));
    expect(b.props.volume, `${name}: volume`).toBeCloseTo(a.props.volume, 9);
    expect(b.props.area, `${name}: area`).toBeCloseTo(a.props.area, 9);
    runMap.set(b.mesh.runId, a.mesh.runId);
    expect(mapRuns(b.faceOrigin, runMap), `${name}: face origins`).toEqual(mapRuns(a.faceOrigin, new Map([...runMap.values()].map((v) => [v, v]))));
    expect(meshTopologyProblems(b.mesh), `${name}: closed manifold`).toEqual([]);
  }
  return worst;
}

describe.skipIf(!haveHarness)('native push/pull matches WebAssembly', () => {
  beforeAll(async () => {
    harness = new HarnessTransport();
    harness.start();
    wasm = new KernelClient(new InlineBackend());
    await wasm.init();
    // A worker that fails the test if the native path silently falls back.
    const noFallback = { request: () => { throw new Error('unexpected fallback to the worker'); }, abortAll: () => undefined, dispose: () => undefined };
    native = new NativeKernelBackend(noFallback as never, harness);
    native.setMeshProvider((bodyId, version) => uploaded.get(`${bodyId}:${version}`));
  });
  afterAll(() => {
    harness?.stop();
    wasm?.dispose();
  });

  let nextBody = 1000;
  const summary: string[] = [];

  async function both(c: Case, preview: boolean): Promise<{ wasm: PushPullResult | PushPullPreview; native: PushPullResult | PushPullPreview }> {
    const mesh = await c.mesh();
    const body = { bodyId: nextBody++, version: 1 };
    uploaded.set(`${body.bodyId}:1`, { ...mesh, runId: 0 });
    await wasm.ensureBody(body.bodyId, 1, mesh);
    const request = { body, region: c.region(mesh), distance: c.distance, mode: c.mode ?? ('merge' as const), nextFaceId: c.nextFaceId };
    const w = preview ? await wasm.pushPull({ ...request, preview: true }) : await wasm.pushPull(request);
    const n = (await native.request({ type: 'pushPull', ...request, ...(preview ? { preview: true } : {}) } as Parameters<typeof native.request>[0])) as PushPullResult | PushPullPreview;
    return { wasm: w, native: n };
  }

  it.each(cases)('$name', async (c) => {
    const { wasm: w, native: n } = await both(c, false);
    const worst = compareResults(c.name, w as PushPullResult, n as PushPullResult);
    summary.push(`${c.name}: largest position difference ${worst === 0 ? '0 (bit-identical)' : worst.toExponential(2)}`);
  });

  it.each(cases)('preview: $name', async (c) => {
    const { wasm: w, native: n } = await both(c, true);
    const worst = expectMeshes(`preview ${c.name}`, (w as PushPullPreview).mesh, (n as PushPullPreview).mesh);
    expect((n as PushPullPreview).mesh.runId).toBe(0);
    summary.push(`preview ${c.name}: largest position difference ${worst === 0 ? '0 (bit-identical)' : worst.toExponential(2)}`);
  });

  it('stays identical over a chain of push/pulls feeding each result to the next', async () => {
    let wasmMesh: MeshData = meshBox([0, 0, 0], [2, 2, 1]);
    let nativeMesh: MeshData = wasmMesh;
    let nextFaceId = 6;
    const bodyId = nextBody++;
    const regions: Array<{ origin: Vec3; polygon: PolygonsWithHoles; faceOf: 'top' | 'moved'; distance: number; whole: boolean }> = [
      { origin: [1, 1, 1], polygon: square(0, 0, 1), faceOf: 'top', distance: 0.5, whole: false },
      { origin: [0.75, 0.75, 1.5], polygon: square(0, 0, 0.2), faceOf: 'top', distance: -1.25, whole: false },
      { origin: [1, 1, 1], polygon: [[[-0.9, -0.9], [0.9, -0.9], [0.9, 0.9], [-0.9, 0.9]], [[-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0.5, -0.5]]], faceOf: 'top', distance: 0.2, whole: false },
    ];
    for (let step = 0; step < regions.length; step++) {
      const r = regions[step]!;
      // The top face of the previous step's body: the largest face facing +z.
      const faceId = largestUpFace(wasmMesh);
      expect(largestUpFace(nativeMesh)).toBe(faceId);
      const version = step + 1;
      uploaded.set(`${bodyId}:${version}`, { ...nativeMesh, runId: 0 });
      await wasm.ensureBody(bodyId, version, wasmMesh);
      const request = { body: { bodyId, version }, region: { faceId, basis: planeBasis(r.origin, [0, 0, 1]), polygon: r.polygon, regionIsWholeFace: r.whole }, distance: r.distance, mode: 'merge' as const, nextFaceId };
      const w = await wasm.pushPull(request);
      const n = (await native.request({ type: 'pushPull', ...request })) as PushPullResult;
      const worst = compareResults(`chain step ${step}`, w, n);
      summary.push(`chain step ${step}: largest position difference ${worst === 0 ? '0 (bit-identical)' : worst.toExponential(2)}`);
      wasmMesh = w.components[0]!.mesh;
      nativeMesh = n.components[0]!.mesh;
      nextFaceId = w.nextFaceId;
    }
  });

  it('rejects a zero distance the same way', async () => {
    const mesh = box();
    uploaded.set('800:1', { ...mesh, runId: 0 });
    await wasm.ensureBody(800, 1, mesh);
    const request = { body: { bodyId: 800, version: 1 }, region: topRegion([0.5, 0.5, 1], square(0, 0, 1), 1, true), distance: 0, mode: 'merge' as const, nextFaceId: 6 };
    await expect(wasm.pushPull(request)).rejects.toMatchObject({ code: 'InvalidInput', message: 'pushPull.distance must be a non-zero finite number' });
    await expect(harness.call(new Uint8Array(2))).rejects.toBeTruthy();
    const encoded = (await import('./nativeWire')).encodePushPull({ type: 'pushPull', ...request });
    await harness.call(encoded).then(
      () => { throw new Error('expected a failure'); },
      (e: string) => expect(JSON.parse(e)).toMatchObject({ code: 'InvalidInput', message: 'pushPull.distance must be a non-zero finite number' }),
    );
  });

  afterAll(() => {
    if (process.env.PF_NATIVE_DIFF_SUMMARY) process.stderr.write(`\nnative differential summary:\n${summary.join('\n')}\n`);
  });
});
