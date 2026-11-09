// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Runs push/pull down both paths on the kernel's fixtures and compares them: WebAssembly through the inline backend and
 * native through the kernel's own harness process, over the real binary protocol. Needs the harness binary:
 *   cargo build --release --features harness --bin pushform-native-kernel-harness   (in crates/native-kernel)
 * Skipped when it has not been built, so the suite stays independent of cmake and C++.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meshBox, planeBasis, type MeshData, type Vec3 } from '@pushform/core';
import { InlineBackend } from './InlineBackend';
import { NativeKernelBackend } from './NativeKernelBackend';
import { differentialCases, HarnessTransport, largestUpFace, type DifferentialCase } from './differentialFixtures';
import { KernelClient } from '../client/KernelClient';
import { meshTopologyProblems } from '../meshChecks';
import type { FaceOrigin, MeshWire, PolygonsWithHoles, PushPullPreview, PushPullResult } from '../protocol';
import { square, topRegion } from '../test/helpers';

const harnessPath = resolve(__dirname, '../../../../crates/native-kernel/target/release/pushform-native-kernel-harness');
const haveHarness = existsSync(harnessPath);

const POSITION_TOLERANCE = 1e-9;
const box = (): MeshData => meshBox([0, 0, 0], [1, 1, 1]);

let harness: HarnessTransport;
let wasm: KernelClient;
const cases = differentialCases(() => wasm);
let native: NativeKernelBackend;
const uploaded = new Map<string, MeshWire>();

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
    harness = new HarnessTransport(harnessPath);
    harness.start();
    wasm = new KernelClient(new InlineBackend({ typescriptOnly: true }));
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

  async function both(c: DifferentialCase, preview: boolean): Promise<{ wasm: PushPullResult | PushPullPreview; native: PushPullResult | PushPullPreview }> {
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
