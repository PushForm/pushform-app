// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Runs push/pull three ways on the kernel's fixtures and requires exact equality: the TypeScript kernel, the native Rust
 * kernel (threaded) and the Rust kernel's WebAssembly module (single-threaded). Needs the harness binary (see
 * nativeDifferential.test.ts) and the module from `pnpm build:kernel-wasm`; skipped when either is missing.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meshBox, planeBasis, type MeshData, type Vec3 } from '@pushform/core';
import { KernelClient } from '../client/KernelClient';
import { meshTopologyProblems } from '../meshChecks';
import type { FaceOrigin, KernelErrorInfo, MeshWire, PolygonsWithHoles, PushPullPreview, PushPullResult } from '../protocol';
import { square, topRegion } from '../test/helpers';
import { InlineBackend } from './InlineBackend';
import { validateSolidMesh } from '../validateSolid';
import { NativeKernelBackend } from './NativeKernelBackend';
import { differentialCases, HarnessTransport, InlineRustTransport, largestUpFace, type DifferentialCase, type RustModuleFactory } from './differentialFixtures';
import { encodePushPull, encodeValidateSolid } from './nativeWire';

const harnessPath = resolve(__dirname, '../../../../crates/native-kernel/target/release/pushform-native-kernel-harness');
const modulePath = resolve(__dirname, '../../wasm/pushform-kernel.js');
const ready = existsSync(harnessPath) && existsSync(modulePath);

const loadFactory = async (): Promise<RustModuleFactory> => ((await import(/* @vite-ignore */ modulePath)) as { default: RustModuleFactory }).default;

const bits = (v: number): string => new BigUint64Array(new Float64Array([v]).buffer)[0]!.toString(16);

/** The first index where two number arrays differ, as text, or undefined; floats compare by their bit patterns. */
function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): string | undefined {
  if (a.length !== b.length) return `lengths ${a.length} and ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (Object.is(a[i], b[i])) continue;
    return `index ${i}: ${a[i]} (${bits(a[i]!)}) and ${b[i]} (${bits(b[i]!)})`;
  }
  return undefined;
}

function compareMeshes(label: string, a: MeshWire, b: MeshWire): void {
  expect(firstDifference(a.verts, b.verts), `${label}: positions`).toBeUndefined();
  expect(firstDifference(a.tris, b.tris), `${label}: triangle indices`).toBeUndefined();
  expect(firstDifference(a.faceId, b.faceId), `${label}: face ids`).toBeUndefined();
}

function mapOrigins(origins: FaceOrigin, runMap: Map<number, number>): Array<[number, Array<{ runId: number; faceId: number }>]> {
  return [...origins.entries()].map(([face, list]) => [face, list.map((o) => {
    expect(runMap.has(o.runId), `face ${face} has an origin in an unknown run ${o.runId}`).toBe(true);
    return { runId: runMap.get(o.runId)!, faceId: o.faceId };
  })]);
}

/** Exact equality of two full results. Run ids are process-wide counters, so `runMap` carries `b`'s ids to `a`'s. */
function compareFull(label: string, a: PushPullResult, b: PushPullResult, runMap: Map<number, number>): void {
  expect(b.moved, `${label}: moved`).toEqual(a.moved);
  expect(b.nextFaceId, `${label}: nextFaceId`).toBe(a.nextFaceId);
  expect(b.sideFaceForBoundaryEdge, `${label}: side faces`).toEqual(a.sideFaceForBoundaryEdge);
  expect(b.components.length, `${label}: component count`).toBe(a.components.length);
  expect(runMap.get(b.bodyRunId), `${label}: body run id maps`).toBe(a.bodyRunId);
  expect(runMap.get(b.toolRunId), `${label}: tool run id maps`).toBe(a.toolRunId);
  for (let i = 0; i < a.components.length; i++) {
    const [ca, cb] = [a.components[i]!, b.components[i]!];
    compareMeshes(`${label} #${i}`, ca.mesh, cb.mesh);
    expect(bits(cb.props.volume), `${label} #${i}: volume bits`).toBe(bits(ca.props.volume));
    expect(bits(cb.props.area), `${label} #${i}: area bits`).toBe(bits(ca.props.area));
    expect(runMap.get(cb.mesh.runId), `${label} #${i}: result run id maps`).toBe(ca.mesh.runId);
    const keep = new Map([...runMap.values()].map((v) => [v, v]));
    expect(mapOrigins(cb.faceOrigin, runMap), `${label} #${i}: face origins`).toEqual(mapOrigins(ca.faceOrigin, keep));
    expect(meshTopologyProblems(cb.mesh), `${label} #${i}: closed manifold`).toEqual([]);
  }
}

/** Maps the run ids of `from` onto those of `to` by role. A real difference shows up when `compareFull` checks them. */
function runIdMap(to: PushPullResult, from: PushPullResult): Map<number, number> {
  const map = new Map([[from.bodyRunId, to.bodyRunId], [from.toolRunId, to.toolRunId]]);
  from.components.forEach((c, i) => {
    if (to.components[i]) map.set(c.mesh.runId, to.components[i]!.mesh.runId);
  });
  return map;
}

describe.skipIf(!ready)('TypeScript, native Rust and WebAssembly Rust push/pull agree exactly', () => {
  let ts: KernelClient;
  let harness: HarnessTransport;
  let native: NativeKernelBackend;
  let wasm: NativeKernelBackend;
  const cases = differentialCases(() => ts);
  const uploaded = new Map<string, MeshWire>();
  let nextBody = 2000;
  const summary: string[] = [];

  beforeAll(async () => {
    ts = new KernelClient(new InlineBackend({ typescriptOnly: true }));
    await ts.init();
    harness = new HarnessTransport(harnessPath);
    harness.start();
    const noFallback = { request: () => { throw new Error('unexpected fallback to the worker'); }, abortAll: () => undefined, dispose: () => undefined };
    const provider = (bodyId: number, version: number) => uploaded.get(`${bodyId}:${version}`);
    native = new NativeKernelBackend(noFallback as never, harness, { fallback: false });
    native.setMeshProvider(provider);
    wasm = new NativeKernelBackend(noFallback as never, new InlineRustTransport(await loadFactory()), { fallback: false });
    wasm.setMeshProvider(provider);
  });
  afterAll(() => {
    harness?.stop();
    ts?.dispose();
    if (process.env.PF_NATIVE_DIFF_SUMMARY) process.stderr.write(`\nthree-way summary:\n${summary.join('\n')}\n`);
  });

  async function runAll(c: DifferentialCase, preview: boolean): Promise<[PushPullResult | PushPullPreview, PushPullResult | PushPullPreview, PushPullResult | PushPullPreview]> {
    const mesh = await c.mesh();
    const body = { bodyId: nextBody++, version: 1 };
    uploaded.set(`${body.bodyId}:1`, { ...mesh, runId: 0 });
    await ts.ensureBody(body.bodyId, 1, mesh);
    const request = { body, region: c.region(mesh), distance: c.distance, mode: c.mode ?? ('merge' as const), nextFaceId: c.nextFaceId };
    const run = (backend: NativeKernelBackend) => backend.request({ type: 'pushPull', ...request, ...(preview ? { preview: true } : {}) } as Parameters<NativeKernelBackend['request']>[0]) as Promise<PushPullResult | PushPullPreview>;
    return [preview ? await ts.pushPull({ ...request, preview: true }) : await ts.pushPull(request), await run(native), await run(wasm)];
  }

  it.each(cases)('$name', async (c) => {
    const [a, n, r] = await runAll(c, false) as [PushPullResult, PushPullResult, PushPullResult];
    compareFull(`native: ${c.name}`, a, n, runIdMap(a, n));
    compareFull(`wasm: ${c.name}`, a, r, runIdMap(a, r));
    expect([n.bodyRunId, n.toolRunId, ...n.components.map((x) => x.mesh.runId)], `${c.name}: raw run ids of native and wasm`).toEqual([r.bodyRunId, r.toolRunId, ...r.components.map((x) => x.mesh.runId)]);
    compareFull(`native vs wasm: ${c.name}`, n, r, new Map([...runIdMap(n, r).keys()].map((k) => [k, k])));
    const runs = (x: PushPullResult): string => [x.bodyRunId, x.toolRunId, ...x.components.map((k) => k.mesh.runId)].join(',');
    summary.push(`${c.name}: identical across all three (${a.components.reduce((sum, x) => sum + x.mesh.faceId.length, 0)} triangles; run ids ts ${runs(a)} native ${runs(n)} wasm ${runs(r)})`);
  });

  it.each(cases)('preview: $name', async (c) => {
    const [a, n, r] = await runAll(c, true) as [PushPullPreview, PushPullPreview, PushPullPreview];
    compareMeshes(`preview native: ${c.name}`, a.mesh, n.mesh);
    compareMeshes(`preview wasm: ${c.name}`, a.mesh, r.mesh);
    expect(n.mesh.runId).toBe(0);
    expect(r.mesh.runId).toBe(0);
    summary.push(`preview ${c.name}: identical across all three`);
  });

  it('stays identical over a chain of push/pulls feeding each result to the next', async () => {
    const start: MeshData = meshBox([0, 0, 0], [2, 2, 1]);
    let meshes: [MeshData, MeshData, MeshData] = [start, start, start];
    let nextFaceId = 6;
    const bodyId = nextBody++;
    const steps: Array<{ origin: Vec3; polygon: PolygonsWithHoles; distance: number }> = [
      { origin: [1, 1, 1], polygon: square(0, 0, 1), distance: 0.5 },
      { origin: [0.75, 0.75, 1.5], polygon: square(0, 0, 0.2), distance: -1.25 },
      { origin: [1, 1, 1], polygon: [[[-0.9, -0.9], [0.9, -0.9], [0.9, 0.9], [-0.9, 0.9]], [[-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0.5, -0.5]]], distance: 0.2 },
    ];
    for (let step = 0; step < steps.length; step++) {
      const s = steps[step]!;
      const faceId = largestUpFace(meshes[0]);
      expect(largestUpFace(meshes[1])).toBe(faceId);
      expect(largestUpFace(meshes[2])).toBe(faceId);
      const version = step + 1;
      uploaded.set(`${bodyId}:${version}`, { ...meshes[1], runId: 0 });
      await ts.ensureBody(bodyId, version, meshes[0]);
      const request = { body: { bodyId, version }, region: { faceId, basis: planeBasis(s.origin, [0, 0, 1]), polygon: s.polygon, regionIsWholeFace: false }, distance: s.distance, mode: 'merge' as const, nextFaceId };
      const a = await ts.pushPull(request);
      const n = (await native.request({ type: 'pushPull', ...request })) as PushPullResult;
      const r = (await wasm.request({ type: 'pushPull', ...request })) as PushPullResult;
      compareFull(`chain step ${step} native`, a, n, runIdMap(a, n));
      compareFull(`chain step ${step} wasm`, a, r, runIdMap(a, r));
      compareFull(`chain step ${step} native vs wasm`, n, r, new Map([...runIdMap(n, r).keys()].map((k) => [k, k])));
      summary.push(`chain step ${step}: identical across all three`);
      meshes = [a.components[0]!.mesh, n.components[0]!.mesh, r.components[0]!.mesh];
      nextFaceId = a.nextFaceId;
    }
  });

  it('rejects a zero distance with the same error from all three', async () => {
    const mesh = meshBox([0, 0, 0], [1, 1, 1]);
    uploaded.set('801:1', { ...mesh, runId: 0 });
    await ts.ensureBody(801, 1, mesh);
    const request = { body: { bodyId: 801, version: 1 }, region: topRegion([0.5, 0.5, 1], square(0, 0, 1), 1, true), distance: 0, mode: 'merge' as const, nextFaceId: 6 };
    const failure = await ts.pushPull(request).then(() => { throw new Error('expected a failure'); }, (e: { code: string; message: string }) => ({ code: e.code, message: e.message }));
    const encoded = encodePushPull({ type: 'pushPull', ...request });
    const rejected = (e: unknown): KernelErrorInfo => JSON.parse(String(e)) as KernelErrorInfo;
    const fromNative = await harness.call(encoded).then(() => { throw new Error('expected a failure'); }, rejected);
    const transport = new InlineRustTransport(await loadFactory());
    const fromWasm = await transport.call(encoded).then(() => { throw new Error('expected a failure'); }, rejected);
    expect(fromNative).toEqual(failure);
    expect(fromWasm).toEqual(failure);
  });

  // The check `readNativeBody` runs on every stored body: the same outcome down both kernels.
  it.each([
    { name: 'a valid box', mesh: () => meshBox([0, 0, 0], [1, 2, 3]) },
    { name: 'an inverted box with negative volume', mesh: () => { const m = meshBox([0, 0, 0], [1, 1, 1]); const tris = new Uint32Array(m.tris); for (let i = 0; i < tris.length; i += 3) { const a = tris[i + 1]!; tris[i + 1] = tris[i + 2]!; tris[i + 2] = a; } return { ...m, tris }; } },
    { name: 'an open mesh', mesh: () => { const m = meshBox([0, 0, 0], [1, 1, 1]); return { verts: m.verts, tris: m.tris.slice(0, 30), faceId: m.faceId.slice(0, 10) }; } },
    { name: 'an empty mesh', mesh: () => ({ verts: new Float64Array(0), tris: new Uint32Array(0), faceId: new Uint32Array(0) }) },
    { name: 'two separate boxes', mesh: () => { const a = meshBox([0, 0, 0], [1, 1, 1]), b = meshBox([3, 0, 0], [4, 1, 1]); return { verts: new Float64Array([...a.verts, ...b.verts]), tris: new Uint32Array([...a.tris, ...b.tris.map((i) => i + 8)]), faceId: new Uint32Array([...a.faceId, ...b.faceId]) }; } },
  ])('validates $name the same way', async ({ mesh }) => {
    const m = mesh();
    const fromTs = await validateSolidMesh(m).then(() => 'ok', (e: { code: string; message: string; details?: unknown }) => JSON.stringify({ code: e.code, message: e.message, details: e.details }));
    const transport = new InlineRustTransport(await loadFactory());
    const fromWasm = await transport.call(encodeValidateSolid(m)).then(() => 'ok', (e: unknown) => {
      const info = JSON.parse(String(e)) as KernelErrorInfo;
      return JSON.stringify({ code: info.code, message: info.message, details: info.details });
    });
    expect(fromWasm).toEqual(fromTs);
  });
});
