// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Runs every kernel operation down three paths and requires them to agree bit for bit: the TypeScript kernel, the native
 * Rust kernel (threaded, through its harness process) and the Rust kernel's WebAssembly module (single-threaded). Each
 * call goes to all three in lockstep, so run ids and everything else in a result must be identical. Errors compare by
 * code, message and details. Needs the harness binary (see nativeDifferential.test.ts) and the module from
 * `pnpm build:kernel-wasm`; skipped when either is missing.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { m4translation, meshBox, planeBasis, v3cross, v3normalize, v3sub, type MeshData, type Vec3 } from '@pushform/core';
import { KernelClient } from '../client/KernelClient';
import { meshTopologyProblems } from '../meshChecks';
import { toKernelErrorInfo, type BodyRef, type KernelErrorInfo, type KernelRequest, type MeshWire, type PolygonsWithHoles, type ResFor, type ToolSoup } from '../protocol';
import { square, topRegion } from '../test/helpers';
import { InlineBackend } from './InlineBackend';
import type { KernelBackend } from './KernelBackend';
import { NativeKernelBackend, type NativeKernelTransport } from './NativeKernelBackend';
import { differentialCases, HarnessTransport, InlineRustTransport, type RustModuleFactory } from './differentialFixtures';

const harnessPath = process.env.PF_KERNEL_HARNESS ?? resolve(__dirname, '../../../../crates/native-kernel/target/release/pushform-native-kernel-harness');
const modulePath = resolve(__dirname, '../../wasm/pushform-kernel.js');
const ready = existsSync(harnessPath) && existsSync(modulePath);

type Outcome = { ok: true; value: unknown } | { ok: false; error: KernelErrorInfo };

function bits(v: number): string {
  return new BigUint64Array(new Float64Array([v]).buffer)[0]!.toString(16);
}

/** First difference between two values as a path and description; floats compare by bit pattern. */
function diffValues(a: unknown, b: unknown, path: string): string | undefined {
  if (typeof a === 'number' && typeof b === 'number') {
    return Object.is(a, b) ? undefined : `${path}: ${a} (${bits(a)}) vs ${b} (${bits(b)})`;
  }
  if (a instanceof Float64Array || a instanceof Uint32Array) {
    if (!(b instanceof Float64Array || b instanceof Uint32Array) || a.constructor !== b.constructor) return `${path}: array type`;
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return `${path}[${i}]: ${a[i]} (${bits(a[i]!)}) vs ${b[i]} (${bits(b[i]!)})`;
    }
    return undefined;
  }
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return `${path}: map size`;
    const ea = [...a.entries()], eb = [...b.entries()];
    for (let i = 0; i < ea.length; i++) {
      const diff = diffValues(ea[i]![0], eb[i]![0], `${path}.key#${i}`) ?? diffValues(ea[i]![1], eb[i]![1], `${path}.value#${i}`);
      if (diff !== undefined) return diff;
    }
    return undefined;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return `${path}: array length`;
    for (let i = 0; i < a.length; i++) {
      const diff = diffValues(a[i], b[i], `${path}[${i}]`);
      if (diff !== undefined) return diff;
    }
    return undefined;
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const keysA = Object.keys(a as object).sort();
    const keysB = Object.keys(b as object).sort();
    if (keysA.join() !== keysB.join()) return `${path}: keys ${keysA.join()} vs ${keysB.join()}`;
    for (const key of keysA) {
      const diff = diffValues((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
      if (diff !== undefined) return diff;
    }
    return undefined;
  }
  return a === b ? undefined : `${path}: ${String(a)} vs ${String(b)}`;
}

function normalizeForCompare(type: KernelRequest['type'], value: unknown): unknown {
  if (type === 'stats') {
    // Heap sizes are properties of each runtime's allocator, not of the kernel's results.
    return { cached: (value as { cached: number }).cached };
  }
  return value;
}

/** Thrown when the kernels disagree; never swallowed by `outcome`. */
class Mismatch extends Error {}

const outcome = async (p: Promise<unknown>): Promise<Outcome> => {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    if (e instanceof Mismatch) throw e;
    return { ok: false, error: toKernelErrorInfo(e) };
  }
};

/** Sends every request to the three kernels in lockstep, compares the outcomes exactly and hands back the TypeScript one. */
class TriadBackend implements KernelBackend {
  readonly counts = new Map<string, number>();
  readonly failures: string[] = [];
  constructor(
    private readonly ts: KernelBackend,
    private readonly native: KernelBackend,
    private readonly wasm: KernelBackend,
  ) {}

  async request<R extends KernelRequest>(req: R): Promise<ResFor<R>> {
    const [a, n, r] = await Promise.all([outcome(this.ts.request(req)), outcome(this.native.request(req)), outcome(this.wasm.request(req))]);
    this.counts.set(req.type, (this.counts.get(req.type) ?? 0) + 1);
    const compare = (b: Outcome, label: string): void => {
      const left = a.ok ? { ok: true, value: normalizeForCompare(req.type, a.value) } : a;
      const right = b.ok ? { ok: true, value: normalizeForCompare(req.type, b.value) } : b;
      const diff = diffValues(left, right, req.type);
      if (diff !== undefined) {
        const failure = `${req.type} (${label}): ${diff}`;
        this.failures.push(failure);
        throw new Mismatch(failure);
      }
    };
    compare(n, 'native');
    compare(r, 'wasm');
    if (!a.ok) throw Object.assign(new Error(a.error.message), a.error);
    return a.value as ResFor<R>;
  }

  abortAll(): void {
    throw new Error('not used by this test');
  }
  dispose(): void {
    this.ts.dispose();
    this.native.dispose();
    this.wasm.dispose();
  }
}

/** Mesh from index polygons (fans), one face id per polygon; vertices are shared by index. */
function meshFromPolygons(verts: number[][], polys: Array<{ id: number; loop: number[] }>): MeshWire {
  const tris: number[] = [], faceId: number[] = [];
  for (const { id, loop } of polys) {
    for (let j = 1; j + 1 < loop.length; j++) {
      tris.push(loop[0]!, loop[j]!, loop[j + 1]!);
      faceId.push(id);
    }
  }
  return { verts: Float64Array.from(verts.flat()), tris: Uint32Array.from(tris), faceId: Uint32Array.from(faceId), runId: 0 };
}

const wire = (mesh: MeshData): MeshWire => ({ ...mesh, runId: 0 });
const BOX_VERTS = (): number[][] => [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const BOX_SIDES = [
  { id: 0, loop: [0, 3, 2, 1] },
  { id: 2, loop: [0, 1, 5, 4] },
  { id: 3, loop: [1, 2, 6, 5] },
  { id: 4, loop: [2, 3, 7, 6] },
  { id: 5, loop: [3, 0, 4, 7] },
];

function circleProfile(segments: number, radius: number): PolygonsWithHoles {
  return [Array.from({ length: segments }, (_, i) => [radius * Math.cos((2 * Math.PI * i) / segments), radius * Math.sin((2 * Math.PI * i) / segments)])];
}

const xz = { origin: [0, 0, 0] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 0, 1] as Vec3, n: [0, -1, 0] as Vec3 };
const rectProfile = (rIn: number, rOut: number, h: number): PolygonsWithHoles => [[[rIn, 0], [rOut, 0], [rOut, h], [rIn, h]]];

const toolSoup = (min: Vec3, max: Vec3): ToolSoup => {
  const m = meshBox(min, max);
  return { verts: m.verts, tris: m.tris, faceId: m.faceId };
};

describe.skipIf(!ready)('every kernel operation agrees bit for bit across TypeScript, native Rust and WebAssembly Rust', () => {
  let ts: KernelBackend;
  let harness: HarnessTransport;
  let client: KernelClient;
  let triad: TriadBackend;
  let nextBody = 1;
  /** When set, alters the next native answer: the comparison must catch it. */
  let tamper: ((response: Uint8Array) => void) | undefined;

  const expectAllAgree = async (req: KernelRequest): Promise<Outcome> => outcome(triad.request(req));
  const newBody = async (mesh: MeshData | MeshWire): Promise<BodyRef & { mesh: MeshWire }> => {
    const bodyId = nextBody++;
    const m = 'runId' in mesh ? mesh : wire(mesh);
    await client.ensureBody(bodyId, 1, m);
    return { bodyId, version: 1, mesh: m };
  };
  const uploadBox = (min: Vec3, max: Vec3) => newBody(meshBox(min, max));
  const uploadComponent = (c: { mesh: MeshWire }) => newBody(c.mesh);

  beforeAll(async () => {
    ts = new InlineBackend();
    harness = new HarnessTransport(harnessPath);
    harness.start();
    const tampering: NativeKernelTransport = {
      available: () => harness.available(),
      call: async (request) => {
        const buffer = await harness.call(request);
        const change = tamper;
        tamper = undefined;
        change?.(new Uint8Array(buffer));
        return buffer;
      },
      abort: () => harness.abort(),
    };
    const native = new NativeKernelBackend(undefined, tampering, { fallback: false });
    const factory = ((await import(/* @vite-ignore */ modulePath)) as { default: RustModuleFactory }).default;
    const wasm = new NativeKernelBackend(undefined, new InlineRustTransport(factory), { fallback: false });
    triad = new TriadBackend(ts, native, wasm);
    client = new KernelClient(triad);
    await client.init();
  });

  afterAll(() => {
    const line = `[${[...triad.counts.entries()].map(([k, v]) => `${k}:${v}`).join(' ')}]`;
    if (process.env.PF_NATIVE_DIFF_SUMMARY) process.stderr.write(`\nthree-way requests ${line}\n`);
    expect(triad.failures).toEqual([]);
    harness.stop();
    client.dispose();
  });

  describe('fromTriangles', () => {
    it('a box, an open mesh and non-adjacent coplanar faces', async () => {
      await client.fromTriangles({ mesh: wire(meshBox([0, 0, 0], [2, 3, 4])), nextFaceId: 6 });
      const box = meshBox([0, 0, 0], [1, 1, 1]);
      const open = { verts: box.verts, tris: box.tris.slice(0, 30), faceId: box.faceId.slice(0, 10), runId: 0 };
      const openResult = await client.fromTriangles({ mesh: open, nextFaceId: 6 });
      expect(openResult.status).toBe('NotManifold');
      const a = meshBox([0, 0, 0], [1, 1, 1]), b = meshBox([2, 0, 0], [3, 1, 1]);
      const verts = new Float64Array([...a.verts, ...b.verts]);
      const tris = new Uint32Array([...a.tris, ...b.tris.map((i) => i + 8)]);
      const faceId = new Uint32Array([...a.faceId, ...b.faceId]);
      await client.fromTriangles({ mesh: { verts, tris, faceId, runId: 0 }, nextFaceId: 6 });
    });

    it('statuses for broken meshes', async () => {
      const box = wire(meshBox([0, 0, 0], [1, 1, 1]));
      await expectAllAgree({ type: 'fromTriangles', mesh: { ...box, faceId: box.faceId.slice(0, 3) }, nextFaceId: 6 });
      await expectAllAgree({ type: 'fromTriangles', mesh: { verts: new Float64Array(0), tris: new Uint32Array(0), faceId: new Uint32Array(0), runId: 0 }, nextFaceId: 6 });
      const nan = new Float64Array(box.verts);
      nan[0] = Number.NaN;
      await expectAllAgree({ type: 'fromTriangles', mesh: { ...box, verts: nan }, nextFaceId: 6 });
      const inf = new Float64Array(box.verts);
      inf[0] = Infinity;
      await expectAllAgree({ type: 'fromTriangles', mesh: { ...box, verts: inf }, nextFaceId: 6 });
      const oob = new Uint32Array(box.tris);
      oob[0] = 99;
      await expectAllAgree({ type: 'fromTriangles', mesh: { ...box, tris: oob }, nextFaceId: 6 });
      await expectAllAgree({ type: 'fromTriangles', mesh: { verts: box.verts.slice(0, 16), tris: box.tris.slice(0, 3), faceId: box.faceId.slice(0, 1), runId: 0 }, nextFaceId: 6 });
    });

    it('wraps face ids past 2^32 and keeps them exact past 2^53 the way a JavaScript number does', async () => {
      await client.fromTriangles({ mesh: wire(meshBox([0, 0, 0], [1, 1, 1])), nextFaceId: 2 ** 32 - 3 });
      await client.fromTriangles({ mesh: wire(meshBox([0, 0, 0], [1, 1, 1])), nextFaceId: 2 ** 53 });
      await client.transform({ body: await uploadBox([0, 0, 0], [1, 1, 1]), matrix: m4translation([1, 0, 0]), nextFaceId: 2 ** 32 - 3 });
    });
  });

  describe('ensureBody and bodies', () => {
    it('upload, cached and needMesh, then properties', async () => {
      const body = await uploadBox([0, 0, 0], [1, 2, 3]);
      await client.properties({ body });
      await expectAllAgree({ type: 'ensureBody', bodyId: body.bodyId, version: 1 });
      await expectAllAgree({ type: 'ensureBody', bodyId: 123456, version: 1 });
      await expectAllAgree({ type: 'ensureBody', bodyId: body.bodyId, version: 2, mesh: body.mesh });
    });

    it('rejected meshes', async () => {
      const box = wire(meshBox([0, 0, 0], [1, 1, 1]));
      await expectAllAgree({ type: 'ensureBody', bodyId: nextBody++, version: 1, mesh: { verts: box.verts, tris: box.tris.slice(0, 30), faceId: box.faceId.slice(0, 10), runId: 0 } });
      await expectAllAgree({ type: 'ensureBody', bodyId: nextBody++, version: 1, mesh: { ...box, faceId: new Uint32Array(1) } });
      const nan = new Float64Array(box.verts);
      nan[5] = Number.NaN;
      await expectAllAgree({ type: 'ensureBody', bodyId: nextBody++, version: 1, mesh: { ...box, verts: nan } });
      const oob = new Uint32Array(box.tris);
      oob[3] = 1000;
      await expectAllAgree({ type: 'ensureBody', bodyId: nextBody++, version: 1, mesh: { ...box, tris: oob } });
    });

    it('release one version, all versions and unknown bodies; stats', async () => {
      const body = await uploadBox([0, 0, 0], [1, 1, 1]);
      await expectAllAgree({ type: 'ensureBody', bodyId: body.bodyId, version: 2, mesh: body.mesh });
      await expectAllAgree({ type: 'stats' });
      await expectAllAgree({ type: 'release', bodyId: body.bodyId, version: 2 });
      await expectAllAgree({ type: 'release', bodyId: body.bodyId, version: 2 });
      await expectAllAgree({ type: 'release', bodyId: body.bodyId });
      await expectAllAgree({ type: 'release', bodyId: 987654 });
      await expectAllAgree({ type: 'stats' });
    });

    it('a body uploaded and used far from the origin keeps exact positions', async () => {
      const body = await uploadBox([1000.125, -2000.0625, 300.5], [1000.875, -2000.0, 300.75]);
      await client.properties({ body });
      await client.transform({ body, matrix: m4translation([0.1, 0.2, 0.3]), nextFaceId: 6 });
    });
  });

  describe('pushPull and extrudeSketch', () => {
    const cases = differentialCases(() => client);
    it.each(cases)('full: $name', async (c) => {
      const mesh = await c.mesh();
      const body = await newBody(mesh);
      await client.pushPull({ body, region: c.region(mesh), distance: c.distance, mode: c.mode ?? 'merge', nextFaceId: c.nextFaceId });
    });
    it.each(cases)('preview: $name', async (c) => {
      const mesh = await c.mesh();
      const body = await newBody(mesh);
      await client.pushPull({ body, region: c.region(mesh), distance: c.distance, mode: c.mode ?? 'merge', preview: true, nextFaceId: c.nextFaceId });
    });

    it('extrudes sketches with and without holes, in both directions', async () => {
      const basis = { origin: [0, 0, 0] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 1, 0] as Vec3, n: [0, 0, 1] as Vec3 };
      await client.extrudeSketch({ basis, polygon: [...square(0, 0, 2), ...square(0, 0, 1)], distance: -3, nextFaceId: 1 });
      await client.extrudeSketch({ basis, polygon: square(0.1, 0.2, 2), distance: 3, nextFaceId: 7 });
      await client.extrudeSketch({ basis: { ...basis, origin: [10.5, -3.25, 2] }, polygon: circleProfile(120, 0.5), distance: 1.25, nextFaceId: 1 });
    });

    it('rejects bad distances and region polygons the same way', async () => {
      const body = await uploadBox([0, 0, 0], [1, 1, 1]);
      const region = topRegion([0.5, 0.5, 1], square(0, 0, 1), 1, true);
      await expectAllAgree({ type: 'pushPull', body, region, distance: 0, mode: 'merge', nextFaceId: 6 });
      await expectAllAgree({ type: 'pushPull', body, region, distance: Number.NaN, mode: 'merge', nextFaceId: 6 });
      await expectAllAgree({ type: 'pushPull', body: { bodyId: 99999, version: 1 }, region, distance: 1, mode: 'merge', nextFaceId: 6 });
      await expectAllAgree({ type: 'pushPull', body, region: { ...region, polygon: [] }, distance: 1, mode: 'merge', nextFaceId: 6 });
      await expectAllAgree({ type: 'pushPull', body, region: { ...region, polygon: [[[0, 0], [1, 0]]] }, distance: 1, mode: 'merge', nextFaceId: 6 });
      await expectAllAgree({ type: 'pushPull', body, region: { ...region, polygon: [[[0, 0], [1, 0], [2, 0]]], regionIsWholeFace: false }, distance: 1, mode: 'merge', nextFaceId: 6 });
      await expectAllAgree({ type: 'extrudeSketch', basis: region.basis, polygon: [], distance: 1, nextFaceId: 1 });
      await expectAllAgree({ type: 'extrudeSketch', basis: region.basis, polygon: square(0, 0, 1), distance: 0, nextFaceId: 1 });
      await expectAllAgree({ type: 'extrudeSketch', basis: region.basis, polygon: [[[0, 0], [1, 0], [2, 0]]], distance: 1, nextFaceId: 1 });
    });

    it('a region whose face id is past 2^32 in a whole-face pull', async () => {
      const body = await uploadBox([0, 0, 0], [1, 1, 1]);
      await client.pushPull({ body, region: { faceId: 2 ** 32 + 1, basis: planeBasis([0.5, 0.5, 1], [0, 0, 1]), polygon: square(0, 0, 0.2), regionIsWholeFace: true }, distance: 1, mode: 'merge', nextFaceId: 6 });
      await client.pushPull({ body, region: { faceId: 7.5, basis: planeBasis([0.5, 0.5, 1], [0, 0, 1]), polygon: square(0, 0, 0.2), regionIsWholeFace: true }, distance: 1, mode: 'merge', nextFaceId: 6 });
    });
  });

  describe('boolean', () => {
    const stile: [Vec3, Vec3] = [[0.002, -0.01905, 0.003], [0.0592, 0, 1.37]];
    const rail: [Vec3, Vec3] = [[0.0592, -0.01905, 0.003], [0.5498, 0, 0.0602]];

    it('add, subtract, intersect, split and trim', async () => {
      const a = await uploadBox([0, 0, 0], [1, 1, 1]);
      const b = await uploadBox([0.5, 0.5, 0.5], [2, 2, 2]);
      await client.boolean({ op: 'subtract', a, b, nextFaceId: 6 });
      await client.boolean({ op: 'split', a, b, nextFaceId: 6 });
      await client.boolean({ op: 'intersect', a, b, nextFaceId: 6 });
      await client.boolean({ op: 'add', a, b, nextFaceId: 6 });
      await client.boolean({ op: 'trim', a, b, nextFaceId: 6 });
    });

    it('a subtract that removes everything', async () => {
      const a = await uploadBox([0, 0, 0], [1, 1, 1]);
      const b = await uploadBox([-1, -1, -1], [2, 2, 2]);
      expect((await client.boolean({ op: 'subtract', a, b, nextFaceId: 6 })).components).toHaveLength(0);
    });

    it('solids that share a face, part of a face, an edge, or nothing', async () => {
      const a = await uploadBox(...stile);
      const b = await uploadBox(...rail);
      await client.boolean({ op: 'add', a, b, nextFaceId: 6 });
      const c = await uploadBox([0.1015, -0.0508, 0.2604], [0.2795, -0.0381, 0.2731]);
      const d = await uploadBox([0.1015, -0.0381, 0.2604], [0.1142, -0.0126, 0.2731]);
      await client.boolean({ op: 'add', a: c, b: d, nextFaceId: 6 });
      const e = await uploadBox([0, 0, 0], [1, 1, 1]);
      const f = await uploadBox([1, 1, 0], [2, 2, 1]);
      await client.boolean({ op: 'add', a: e, b: f, nextFaceId: 6 });
      const g = await uploadBox([rail[0][0] + 1e-6, rail[0][1], rail[0][2]], rail[1]);
      await client.boolean({ op: 'add', a, b: g, nextFaceId: 6 });
    });

    it('rejects unknown bodies, first a then b', async () => {
      const a = await uploadBox([0, 0, 0], [1, 1, 1]);
      await expectAllAgree({ type: 'boolean', op: 'add', a: { bodyId: 77777, version: 1 }, b: a, nextFaceId: 6 });
      await expectAllAgree({ type: 'boolean', op: 'add', a, b: { bodyId: 77778, version: 3 }, nextFaceId: 6 });
    });
  });

  describe('transform', () => {
    it('translate, mirror, rotate about an offset point', async () => {
      const body = await uploadBox([0, 0, 0], [1, 2, 3]);
      await client.transform({ body, matrix: m4translation([10, 0, 0]), nextFaceId: 6 });
      await client.transform({ body, matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], nextFaceId: 6 });
      const c = Math.cos(0.7), s = Math.sin(0.7);
      await client.transform({ body, matrix: [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 3.5, -2.25, 1, 1], nextFaceId: 6 });
      await client.transform({ body, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1, 0.2, 0.3, 2], nextFaceId: 6 });
    });

    it('rejects bad matrices before looking at the body', async () => {
      const body = await uploadBox([0, 0, 0], [1, 1, 1]);
      await expectAllAgree({ type: 'transform', body, matrix: [1, 0, 0], nextFaceId: 6 });
      const nan = m4translation([1, 0, 0]);
      nan[5] = Number.NaN;
      await expectAllAgree({ type: 'transform', body, matrix: nan, nextFaceId: 6 });
      await expectAllAgree({ type: 'transform', body: { bodyId: 55555, version: 1 }, matrix: m4translation([1, 0, 0]), nextFaceId: 6 });
    });
  });

  describe('autofold', () => {
    it('folds and collapses meshes, and rejects self-intersecting and open meshes', async () => {
      const v = BOX_VERTS();
      v[4] = [0, 0, 1.3];
      v[5] = [1, 0, 1.15];
      await client.autofold({ body: { bodyId: 1, version: 1 }, mesh: meshFromPolygons(v, [...BOX_SIDES, { id: 1, loop: [4, 5, 6] }, { id: 6, loop: [4, 6, 7] }]), nextFaceId: 7 });
      const wedge = BOX_VERTS().slice(0, 4).concat([[1, 1, 1], [0, 1, 1]]);
      await client.autofold({
        body: { bodyId: 1, version: 1 },
        mesh: meshFromPolygons(wedge, [
          { id: 0, loop: [0, 3, 2, 1] },
          { id: 2, loop: [0, 1, 4, 5] },
          { id: 3, loop: [1, 2, 4] },
          { id: 4, loop: [2, 3, 5, 4] },
          { id: 5, loop: [3, 0, 5] },
        ]),
        nextFaceId: 6,
      });
      const pierced = BOX_VERTS();
      pierced[5] = [1, 0, -0.5];
      await expectAllAgree({
        type: 'autofold',
        body: { bodyId: 1, version: 1 },
        mesh: meshFromPolygons(pierced, [
          { id: 0, loop: [0, 3, 2, 1] },
          { id: 1, loop: [5, 6, 7] },
          { id: 6, loop: [5, 7, 4] },
          { id: 2, loop: [5, 4, 0] },
          { id: 7, loop: [5, 0, 1] },
          { id: 3, loop: [5, 1, 2] },
          { id: 8, loop: [5, 2, 6] },
          { id: 4, loop: [2, 3, 7, 6] },
          { id: 5, loop: [3, 0, 4, 7] },
        ]),
        nextFaceId: 9,
      });
      const box = meshBox([0, 0, 0], [1, 1, 1]);
      await expectAllAgree({ type: 'autofold', body: { bodyId: 1, version: 1 }, mesh: { verts: box.verts, tris: box.tris.slice(0, 30), faceId: box.faceId.slice(0, 10), runId: 0 }, nextFaceId: 6 });
    });

    it('rejects malformed meshes and many touching triangles', async () => {
      const box = wire(meshBox([0, 0, 0], [1, 1, 1]));
      await expectAllAgree({ type: 'autofold', body: { bodyId: 1, version: 1 }, mesh: { ...box, faceId: box.faceId.slice(0, 2) }, nextFaceId: 6 });
      await expectAllAgree({ type: 'autofold', body: { bodyId: 1, version: 1 }, mesh: { verts: new Float64Array(0), tris: new Uint32Array(0), faceId: new Uint32Array(0), runId: 0 }, nextFaceId: 6 });
      const a = meshBox([0, 0, 0], [1, 1, 1]), c = meshBox([0.25, 0.25, 0.5], [0.75, 0.75, 2]);
      const verts = new Float64Array([...a.verts, ...c.verts]);
      const tris = new Uint32Array([...a.tris, ...c.tris.map((i) => i + 8)]);
      const faceId = new Uint32Array([...a.faceId, ...c.faceId]);
      await expectAllAgree({ type: 'autofold', body: { bodyId: 1, version: 1 }, mesh: { verts, tris, faceId, runId: 0 }, nextFaceId: 12 });
    });

    it('a dense mesh goes through the triangle tree the same way', async () => {
      const tube = await client.followMe({ profile: circleProfile(40, 0.2), profileBasis: planeBasis([0, 0, 0], [1, 0, 0]), path: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1]], closed: false, nextFaceId: 1 });
      const m = tube.components[0]!.mesh;
      await client.autofold({ body: { bodyId: 1, version: 1 }, mesh: m, nextFaceId: 100 });
      const dented = new Float64Array(m.verts);
      for (let i = 2; i < dented.length; i += 6) dented[i] = dented[i]! * 1.2;
      await expectAllAgree({ type: 'autofold', body: { bodyId: 1, version: 1 }, mesh: { ...m, verts: dented }, nextFaceId: 100 });
    });
  });

  describe('sectionCut', () => {
    it('flat and tilted planes, a hollow body, and misses', async () => {
      const body = await uploadBox([0, 0, 0], [2, 1, 1]);
      await client.sectionCut({ body, plane: { n: [0, 0, 1], d: -0.5 } });
      await client.sectionCut({ body, plane: { n: [Math.SQRT1_2, 0, Math.SQRT1_2], d: -Math.SQRT1_2 } });
      await client.sectionCut({ body, plane: { n: [0, 0, 1], d: -5 } });
      const hollow = await client.pushPull({ body, region: topRegion([1, 0.5, 1], square(0, 0, 0.5), 1, false), distance: -1, mode: 'merge', nextFaceId: 6 });
      const b2 = await uploadComponent(hollow.components[0]!);
      await client.sectionCut({ body: b2, plane: { n: [0, 0, 1], d: -0.3 } });
    });

    it('rejects a zero normal and unknown bodies', async () => {
      const body = await uploadBox([0, 0, 0], [1, 1, 1]);
      await expectAllAgree({ type: 'sectionCut', body, plane: { n: [0, 0, 0], d: 0 } });
      await expectAllAgree({ type: 'sectionCut', body: { bodyId: 44444, version: 1 }, plane: { n: [0, 0, 1], d: 0 } });
    });
  });

  describe('properties', () => {
    it('a box and a body with a through-hole', async () => {
      const body = await uploadBox([0, 0, 0], [1, 2, 3]);
      await client.properties({ body });
      const r = await client.pushPull({ body, region: topRegion([0.5, 1, 3], square(0, 0, 0.2), 1, false), distance: -3, mode: 'merge', nextFaceId: 6 });
      await client.properties({ body: await uploadComponent(r.components[0]!) });
      await expectAllAgree({ type: 'properties', body: { bodyId: 33333, version: 9 } });
    });
  });

  describe('decompose and simplify', () => {
    it('decomposes a split body and a single solid', async () => {
      const a = await uploadBox([0, 0, 0], [1, 1, 1]);
      await client.decompose({ body: a, nextFaceId: 6 });
      const b = await uploadBox([5, 0, 0], [7, 2, 2]);
      const both = await client.boolean({ op: 'add', a, b, nextFaceId: 6 });
      expect(both.components).toHaveLength(2);
      await expectAllAgree({ type: 'decompose', body: { bodyId: 22222, version: 1 }, nextFaceId: 6 });
    });

    it('simplify keeps a box, and large tolerances collapse small features', async () => {
      const body = await uploadBox([0, 0, 0], [1, 1, 1]);
      await client.simplify({ body, nextFaceId: 6 });
      const pulled = await client.pushPull({ body, region: topRegion([0.5, 0.5, 1], square(0, 0, 0.2), 1, false), distance: 1e-3, mode: 'merge', nextFaceId: 6 });
      const b2 = await uploadComponent(pulled.components[0]!);
      await client.simplify({ body: b2, nextFaceId: 20 });
      await client.simplify({ body: b2, tolerance: 0.01, nextFaceId: 20 });
      await client.simplify({ body: b2, tolerance: 0, nextFaceId: 20 });
      await expectAllAgree({ type: 'simplify', body: { bodyId: 11111, version: 1 }, nextFaceId: 6 });
    });
  });

  describe('hull', () => {
    it('hull of one, two and three bodies', async () => {
      const a = await uploadBox([0, 0, 0], [1, 1, 1]);
      const b = await uploadBox([2, 0, 0], [3, 1, 1]);
      const c = await uploadBox([0, 3, 2], [1, 4, 5]);
      await client.hull({ bodies: [a], nextFaceId: 1 });
      await client.hull({ bodies: [a, b], nextFaceId: 1 });
      await client.hull({ bodies: [a, b, c], nextFaceId: 50 });
    });

    it('rejects an empty list and unknown bodies', async () => {
      const a = await uploadBox([0, 0, 0], [1, 1, 1]);
      await expectAllAgree({ type: 'hull', bodies: [], nextFaceId: 1 });
      await expectAllAgree({ type: 'hull', bodies: [a, { bodyId: 66666, version: 1 }], nextFaceId: 1 });
    });
  });

  describe('followMe', () => {
    const squareProfile = (size: number, origin: Vec3, n: Vec3) => ({ profile: square(0, 0, size), profileBasis: planeBasis(origin, n) });

    it('straight, mitred, offset, tilted, closed and hollow sweeps', async () => {
      await client.followMe({ ...squareProfile(0.2, [0, 0, 0], [1, 0, 0]), path: [[0, 0, 0], [1, 0, 0]], closed: false, nextFaceId: 1 });
      await client.followMe({ ...squareProfile(0.2, [0, 0, 0], [1, 0, 0]), path: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], closed: false, nextFaceId: 1 });
      await client.followMe({ profile: [[[0, 0], [0.2, 0], [0.2, 0.2], [0, 0.2]]], profileBasis: { origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] }, path: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], closed: false, nextFaceId: 1 });
      const n: Vec3 = [Math.cos(Math.PI / 6), 0, Math.sin(Math.PI / 6)];
      await client.followMe({ profile: square(0, 0, 0.2), profileBasis: planeBasis([1, 0, 0], n), path: [[0, 0, 0], [1, 0, 0]], closed: false, nextFaceId: 1 });
      await client.followMe({ profile: circleProfile(24, 0.1), profileBasis: planeBasis([0, 0, 0], [1, 0, 0]), path: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], closed: true, nextFaceId: 1 });
      await client.followMe({ profile: [...square(0, 0, 0.4), ...square(0, 0, 0.2)], profileBasis: planeBasis([0, 0, 0], [0, 0, 1]), path: [[0, 0, 0], [0, 0, 1], [1, 0, 1]], closed: false, nextFaceId: 1 });
      // Repeated points in the path and profiles past the triangulator's z-order threshold (80 vertices).
      await client.followMe({ profile: circleProfile(100, 0.1), profileBasis: planeBasis([0, 0, 0], [1, 0, 0]), path: [[0, 0, 0], [0, 0, 0], [0.5, 0, 0], [0.5, 0, 0], [1, 0.1, 0]], closed: false, nextFaceId: 3 });
      await client.followMe({ profile: [circleProfile(90, 0.2)[0]!, circleProfile(20, 0.1)[0]!.reverse()], profileBasis: planeBasis([0, 0, 0], [1, 0, 0]), path: [[0, 0, 0], [1, 0, 0]], closed: false, nextFaceId: 3 });
      // Many holes: the hole bridges and their block index.
      const holes: PolygonsWithHoles = [circleProfile(40, 1)[0]!];
      for (let i = 0; i < 6; i++) holes.push(circleProfile(12, 0.05)[0]!.map(([x, y]) => [x! + 0.5 * Math.cos(i), y! + 0.5 * Math.sin(i)]));
      await client.followMe({ profile: holes, profileBasis: planeBasis([0, 0, 0], [1, 0, 0]), path: [[0, 0, 0], [0.2, 0.05, 0]], closed: false, nextFaceId: 3 });
    });

    it('rejects degenerate input the same way, in the same order', async () => {
      const base = squareProfile(0.2, [0, 0, 0], [1, 0, 0]);
      await expectAllAgree({ type: 'followMe', ...base, path: [[0, 0, 0]], closed: false, nextFaceId: 1 });
      await expectAllAgree({ type: 'followMe', ...base, path: [[0, 0, 0], [1, 0, 0], [0, 0, 0]], closed: false, nextFaceId: 1 });
      await expectAllAgree({ type: 'followMe', ...squareProfile(0.2, [0, 0, 0], [0, 0, 1]), path: [[0, 0, 0], [1, 0, 0]], closed: false, nextFaceId: 1 });
      await expectAllAgree({ type: 'followMe', ...base, path: [[0, 0, 0], [Infinity, 0, 0]], closed: false, nextFaceId: 1 });
      await expectAllAgree({ type: 'followMe', ...base, path: [[0, 0, 0], [1, 0, 0]], closed: true, nextFaceId: 1 });
      await expectAllAgree({ type: 'followMe', profile: [[[0, 0], [1, 0]]], profileBasis: base.profileBasis, path: [[0, 0, 0], [1, 0, 0]], closed: false, nextFaceId: 1 });
      await expectAllAgree({ type: 'followMe', profile: [[[0, 0], [1, 0], [2, 0]]], profileBasis: base.profileBasis, path: [[0, 0, 0], [1, 0, 0]], closed: false, nextFaceId: 1 });
    });
  });

  describe('revolve', () => {
    it('full and partial turns, clipped profiles and arbitrary axes', async () => {
      await client.revolve({ profile: rectProfile(0.5, 1, 1), profileBasis: xz, axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360, segments: 48, nextFaceId: 1 });
      await client.revolve({ profile: rectProfile(0.5, 1, 1), profileBasis: xz, axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 90, segments: 48, nextFaceId: 1 });
      const basis = { origin: [0, 2, 0] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 0, 1] as Vec3, n: [0, -1, 0] as Vec3 };
      await client.revolve({ profile: rectProfile(-0.5, 1, 1), profileBasis: basis, axisOrigin: [0, 2, 5], axisDir: [0, 0, -1], angleDeg: 360, segments: 24, nextFaceId: 1 });
      await client.revolve({ profile: rectProfile(0.2, 1.5, 0.7), profileBasis: planeBasis([2, 3, 4], [1, 1, 0]), axisOrigin: [2, 3, 4], axisDir: [1, -1, 0.5], angleDeg: 137.5, segments: 13, nextFaceId: 9 });
      await client.revolve({ profile: [...rectProfile(1, 2, 1), [[1.25, 0.25], [1.25, 0.75], [1.75, 0.75], [1.75, 0.25]]], profileBasis: xz, axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 200, segments: 36, nextFaceId: 1 });
    });

    it('rejects bad angles, segments, axes and profiles the same way', async () => {
      const base = { type: 'revolve' as const, profile: rectProfile(0.5, 1, 1), profileBasis: xz, axisOrigin: [0, 0, 0] as Vec3, axisDir: [0, 0, 1] as Vec3, segments: 24, nextFaceId: 1 };
      await expectAllAgree({ ...base, angleDeg: 0 });
      await expectAllAgree({ ...base, angleDeg: Number.NaN });
      await expectAllAgree({ ...base, angleDeg: 361 });
      await expectAllAgree({ ...base, angleDeg: 90, segments: 2 });
      await expectAllAgree({ ...base, angleDeg: 90, segments: 2.5 });
      await expectAllAgree({ ...base, angleDeg: 90, axisDir: [0, 1, 0] });
      await expectAllAgree({ ...base, angleDeg: 90, axisDir: [0, 0, 0] });
      await expectAllAgree({ ...base, angleDeg: 90, axisDir: [Number.NaN, 0, 1] });
      await expectAllAgree({ ...base, angleDeg: 90, profile: [] });
      await expectAllAgree({ ...base, angleDeg: 90, profile: [[[1, 0], [2, 0]]] });
      await expectAllAgree({ ...base, angleDeg: 90, profile: [[[1, 0], [2, 0], [3, 0]]] });
      await expectAllAgree({ ...base, angleDeg: 90, profile: rectProfile(-2, -1, 1) });
      await expectAllAgree({ ...base, angleDeg: 90, profile: rectProfile(-2, -0, 1), profileBasis: { ...xz, origin: [-5, 0, 0] } });
    });
  });

  describe('edgeBlend', () => {
    it('cuts, adds and both, with one and many prisms', async () => {
      const body = await uploadBox([0, 0, 0], [1, 1, 1]);
      await client.edgeBlend({ body, cut: [toolSoup([0.8, -0.1, 0.8], [1.1, 1.1, 1.1])], add: [], nextFaceId: 6 });
      await client.edgeBlend({ body, cut: [], add: [toolSoup([1, 0.25, 0.25], [1.2, 0.75, 0.75])], nextFaceId: 6 });
      await client.edgeBlend({ body, cut: [toolSoup([0.8, -0.1, 0.8], [1.1, 1.1, 1.1]), toolSoup([-0.1, 0.8, 0.8], [1.1, 1.1, 1.1])], add: [toolSoup([0.1, 0.1, 1], [0.3, 0.3, 1.2]), toolSoup([0.6, 0.6, 1], [0.8, 0.8, 1.2])], nextFaceId: 40 });
    });

    it('rejects the same inputs the same way', async () => {
      const body = await uploadBox([0, 0, 0], [1, 1, 1]);
      await expectAllAgree({ type: 'edgeBlend', body, cut: [], add: [], nextFaceId: 6 });
      await expectAllAgree({ type: 'edgeBlend', body: { bodyId: 88888, version: 1 }, cut: [], add: [], nextFaceId: 6 });
      await expectAllAgree({ type: 'edgeBlend', body: { bodyId: 88888, version: 1 }, cut: [toolSoup([0, 0, 0], [1, 1, 1])], add: [], nextFaceId: 6 });
      const good = toolSoup([0.8, -0.1, 0.8], [1.1, 1.1, 1.1]);
      await expectAllAgree({ type: 'edgeBlend', body, cut: [{ ...good, faceId: good.faceId.slice(0, 2) }], add: [], nextFaceId: 6 });
      const opened = { verts: good.verts, tris: good.tris.slice(0, 18), faceId: good.faceId.slice(0, 6) };
      await expectAllAgree({ type: 'edgeBlend', body, cut: [good], add: [opened], nextFaceId: 6 });
      await expectAllAgree({ type: 'edgeBlend', body, cut: [opened], add: [], nextFaceId: 6 });
      const nan = new Float64Array(good.verts);
      nan[0] = Number.NaN;
      await expectAllAgree({ type: 'edgeBlend', body, cut: [{ ...good, verts: nan }], add: [], nextFaceId: 6 });
    });
  });

  describe('dense meshes, where the threaded native build takes its parallel code paths', () => {
    const torus = async (axisOffset: number, segments: number, ringSegments: number, spin: number): Promise<BodyRef & { mesh: MeshWire }> => {
      const profile: PolygonsWithHoles = [circleProfile(ringSegments, 0.45)[0]!.map(([x, y]) => [x! + 1.5, y! + 0.5])];
      const r = await client.revolve({ profile, profileBasis: { origin: [axisOffset, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] }, axisOrigin: [axisOffset, 0, 0], axisDir: [0, 0, 1], angleDeg: 360, segments, nextFaceId: 1 });
      const c = Math.cos(spin), s = Math.sin(spin);
      const body = await uploadComponent(r.components[0]!);
      const moved = await client.transform({ body, matrix: [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1], nextFaceId: r.nextFaceId });
      return uploadComponent(moved.components[0]!);
    };

    it('booleans and follow-up operations on tens of thousands of triangles stay identical', async () => {
      const a = await torus(0, 160, 24, 0.31);
      const b = await torus(0.7, 150, 22, 1.1);
      const add = await client.boolean({ op: 'add', a, b, nextFaceId: 100000 });
      const sub = await client.boolean({ op: 'subtract', a, b, nextFaceId: 200000 });
      const cross = await client.boolean({ op: 'intersect', a, b, nextFaceId: 300000 });
      await client.boolean({ op: 'split', a, b, nextFaceId: 400000 });
      const merged = await uploadComponent(add.components[0]!);
      await client.sectionCut({ body: merged, plane: { n: v3normalize([0.2, 0.5, 1]), d: -0.3 } });
      await client.properties({ body: merged });
      await client.simplify({ body: merged, tolerance: 0.001, nextFaceId: 500000 });
      await client.decompose({ body: await uploadComponent(sub.components[0]!), nextFaceId: 500000 });
      await client.hull({ bodies: [a, b], nextFaceId: 600000 });
      await client.autofold({ body: merged, mesh: cross.components[0]!.mesh, nextFaceId: 700000 });
    }, 300000);

    it('a sweep and a chain of booleans past 100k halfedges stay identical', async () => {
      const path: Vec3[] = [];
      for (let i = 0; i < 160; i++) {
        const a = i * 0.22;
        path.push([Math.cos(a) * (1 + i * 0.02), Math.sin(a) * (1 + i * 0.02), i * 0.02]);
      }
      const sweep = await client.followMe({ profile: circleProfile(40, 0.05), profileBasis: planeBasis(path[0]!, v3normalize(v3sub(path[1]!, path[0]!))), path, closed: false, nextFaceId: 1 });
      const body = await uploadComponent(sweep.components[0]!);
      const a = await torus(0.2, 300, 60, 0.7);
      const b = await torus(-0.4, 260, 50, 2.0);
      let current = await client.boolean({ op: 'add', a, b, nextFaceId: 1000000 });
      const merged = await uploadComponent(current.components[0]!);
      await client.boolean({ op: 'subtract', a: merged, b: body, nextFaceId: current.nextFaceId });
      current = await client.boolean({ op: 'intersect', a: merged, b: a, nextFaceId: current.nextFaceId });
      await client.pushPull({ body: await uploadComponent(current.components[0]!), region: { faceId: 7, basis: planeBasis([0, 0, 0], [0, 0, 1]), polygon: square(0, 0, 0.1), regionIsWholeFace: false }, distance: 0.1, mode: 'merge', nextFaceId: current.nextFaceId });
    }, 600000);
  });

  describe('seeded random sequences', () => {
    /** mulberry32: small, seedable, and the same everywhere. */
    function rng(seed: number): () => number {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function starPolygon(r: () => number, cx: number, cy: number, maxRadius: number): number[][] {
      const n = 3 + Math.floor(r() * 16);
      const points: number[][] = [];
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n;
        const radius = maxRadius * (0.5 + 0.5 * r());
        points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
      }
      return points;
    }

    interface Solid {
      ref: BodyRef;
      mesh: MeshWire;
    }

    /** Largest triangle's plane on the largest face, as a small square region. */
    function randomRegion(mesh: MeshWire, r: () => number): { faceId: number; basis: ReturnType<typeof planeBasis>; polygon: PolygonsWithHoles; regionIsWholeFace: boolean; inside: number } | undefined {
      const areas = new Map<number, number>();
      const bestTri = new Map<number, number>();
      for (let t = 0; t < mesh.faceId.length; t++) {
        const [a, b, c] = [mesh.tris[t * 3]! * 3, mesh.tris[t * 3 + 1]! * 3, mesh.tris[t * 3 + 2]! * 3];
        const e1: Vec3 = [mesh.verts[b]! - mesh.verts[a]!, mesh.verts[b + 1]! - mesh.verts[a + 1]!, mesh.verts[b + 2]! - mesh.verts[a + 2]!];
        const e2: Vec3 = [mesh.verts[c]! - mesh.verts[a]!, mesh.verts[c + 1]! - mesh.verts[a + 1]!, mesh.verts[c + 2]! - mesh.verts[a + 2]!];
        const n = v3cross(e1, e2);
        const area = Math.hypot(n[0], n[1], n[2]);
        const f = mesh.faceId[t]!;
        areas.set(f, (areas.get(f) ?? 0) + area);
        if (area > (bestTri.has(f) ? triArea(mesh, bestTri.get(f)!) : -1)) bestTri.set(f, t);
      }
      const faces = [...areas.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      if (faces.length === 0) return undefined;
      const face = faces[Math.floor(r() * Math.min(faces.length, 6))]![0];
      const t = bestTri.get(face)!;
      const [ia, ib, ic] = [mesh.tris[t * 3]! * 3, mesh.tris[t * 3 + 1]! * 3, mesh.tris[t * 3 + 2]! * 3];
      const pa: Vec3 = [mesh.verts[ia]!, mesh.verts[ia + 1]!, mesh.verts[ia + 2]!];
      const pb: Vec3 = [mesh.verts[ib]!, mesh.verts[ib + 1]!, mesh.verts[ib + 2]!];
      const pc: Vec3 = [mesh.verts[ic]!, mesh.verts[ic + 1]!, mesh.verts[ic + 2]!];
      const n = v3normalize(v3cross(v3sub(pb, pa), v3sub(pc, pa)));
      const centroid: Vec3 = [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3];
      const inside = Math.min(triInscribed(pa, pb, pc), 0.4);
      return { faceId: face, basis: planeBasis(centroid, n), polygon: [starPolygon(r, 0, 0, inside * 0.8)], regionIsWholeFace: false, inside };
    }

    function triArea(mesh: MeshWire, t: number): number {
      const [a, b, c] = [mesh.tris[t * 3]! * 3, mesh.tris[t * 3 + 1]! * 3, mesh.tris[t * 3 + 2]! * 3];
      const n = v3cross([mesh.verts[b]! - mesh.verts[a]!, mesh.verts[b + 1]! - mesh.verts[a + 1]!, mesh.verts[b + 2]! - mesh.verts[a + 2]!], [mesh.verts[c]! - mesh.verts[a]!, mesh.verts[c + 1]! - mesh.verts[a + 1]!, mesh.verts[c + 2]! - mesh.verts[a + 2]!]);
      return Math.hypot(n[0], n[1], n[2]);
    }

    function triInscribed(a: Vec3, b: Vec3, c: Vec3): number {
      const ab = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const bc = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
      const ca = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
      const s = (ab + bc + ca) / 2;
      const area = Math.sqrt(Math.max(0, s * (s - ab) * (s - bc) * (s - ca)));
      return s > 0 ? area / s : 0;
    }

    async function randomStep(r: () => number, solids: Solid[], freshId: () => number, nextFace: { value: number }): Promise<void> {
      const newSolidsFrom = async (components: Array<{ mesh: MeshWire }>): Promise<Solid[]> => {
        const made: Solid[] = [];
        for (const c of components) {
          const id = freshId();
          await triad.request({ type: 'ensureBody', bodyId: id, version: 1, mesh: c.mesh });
          made.push({ ref: { bodyId: id, version: 1 }, mesh: c.mesh });
        }
        return made;
      };
      const pickSolid = (): Solid | undefined => solids[Math.floor(r() * solids.length)];
      const op = Math.floor(r() * 16);
      const victim = pickSolid();
      const replace = async (components: Array<{ mesh: MeshWire }>): Promise<void> => {
        const made = await newSolidsFrom(components);
        solids.push(...made);
      };
      const randomBox = (): Solid => {
        const c: Vec3 = [(r() - 0.5) * 3, (r() - 0.5) * 3, (r() - 0.5) * 3];
        const h: Vec3 = [0.1 + r() * 0.9, 0.1 + r() * 0.9, 0.1 + r() * 0.9];
        return { ref: { bodyId: 0, version: 1 }, mesh: wire(meshBox([c[0] - h[0], c[1] - h[1], c[2] - h[2]], [c[0] + h[0], c[1] + h[1], c[2] + h[2]])) };
      };
      const useNewBox = async (): Promise<Solid> => {
        const box = randomBox();
        const id = freshId();
        box.ref.bodyId = id;
        await triad.request({ type: 'ensureBody', bodyId: id, version: 1, mesh: box.mesh });
        solids.push(box);
        return box;
      };
      switch (op) {
        case 0: { // boolean
          const a = victim ?? (await useNewBox());
          const b = r() < 0.5 && solids.length > 1 ? solids[Math.floor(r() * solids.length)]! : await useNewBox();
          const kind = (['add', 'subtract', 'intersect', 'split', 'trim'] as const)[Math.floor(r() * 5)]!;
          const out = await outcome(triad.request({ type: 'boolean', op: kind, a: a.ref, b: b.ref, nextFaceId: nextFace.value }));
          if (out.ok) {
            const v = out.value as { components: Array<{ mesh: MeshWire }>; secondary: Array<{ mesh: MeshWire }>; nextFaceId: number };
            nextFace.value = v.nextFaceId;
            await replace([...v.components, ...v.secondary]);
          }
          break;
        }
        case 1: { // transform
          if (!victim) break;
          const angle = r() * 6, c = Math.cos(angle), s = Math.sin(angle);
          const sign = r() < 0.2 ? -1 : 1;
          const scale = 0.5 + r();
          const matrix = [sign * scale * c, sign * scale * s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, (r() - 0.5) * 2, (r() - 0.5) * 2, (r() - 0.5) * 2, 1];
          const out = await outcome(triad.request({ type: 'transform', body: victim.ref, matrix, nextFaceId: nextFace.value }));
          if (out.ok) {
            const v = out.value as { components: Array<{ mesh: MeshWire }>; nextFaceId: number };
            nextFace.value = v.nextFaceId;
            await replace(v.components);
          }
          break;
        }
        case 2:
        case 3: { // pushPull
          if (!victim) break;
          const region = randomRegion(victim.mesh, r);
          if (!region) break;
          const distance = (r() < 0.5 ? -1 : 1) * (0.02 + r() * 0.6);
          const out = await outcome(triad.request({ type: 'pushPull', body: victim.ref, region, distance, mode: r() < 0.1 ? 'newBody' : 'merge', nextFaceId: nextFace.value, ...(r() < 0.2 ? { preview: true as const } : {}) }));
          if (out.ok) {
            const v = out.value as { components?: Array<{ mesh: MeshWire }>; nextFaceId?: number };
            if (v.components) {
              nextFace.value = v.nextFaceId!;
              await replace(v.components);
            }
          }
          break;
        }
        case 4: { // extrudeSketch
          const basis = planeBasis([(r() - 0.5) * 2, (r() - 0.5) * 2, (r() - 0.5) * 2], v3normalize([r() - 0.5, r() - 0.5, r() - 0.5 + 0.001]));
          const out = await outcome(triad.request({ type: 'extrudeSketch', basis, polygon: [starPolygon(r, 0, 0, 0.3 + r())], distance: (r() < 0.5 ? -1 : 1) * (0.1 + r()), nextFaceId: nextFace.value }));
          if (out.ok) {
            const v = out.value as { components: Array<{ mesh: MeshWire }>; nextFaceId: number };
            nextFace.value = v.nextFaceId;
            await replace(v.components);
          }
          break;
        }
        case 5:
          if (victim) await outcome(triad.request({ type: 'properties', body: victim.ref }));
          break;
        case 6:
          if (victim) {
            await outcome(triad.request({ type: 'sectionCut', body: victim.ref, plane: { n: v3normalize([r() - 0.5, r() - 0.5, r() - 0.5 + 0.001]), d: (r() - 0.5) * 2 } }));
          }
          break;
        case 7: {
          if (!victim) break;
          const out = await outcome(triad.request({ type: 'simplify', body: victim.ref, ...(r() < 0.5 ? { tolerance: r() * 0.05 } : {}), nextFaceId: nextFace.value }));
          if (out.ok) {
            const v = out.value as { components: Array<{ mesh: MeshWire }>; nextFaceId: number };
            nextFace.value = v.nextFaceId;
            await replace(v.components);
          }
          break;
        }
        case 8: {
          if (!victim) break;
          const out = await outcome(triad.request({ type: 'decompose', body: victim.ref, nextFaceId: nextFace.value }));
          if (out.ok) {
            const v = out.value as { components: Array<{ mesh: MeshWire }>; nextFaceId: number };
            nextFace.value = v.nextFaceId;
            await replace(v.components);
          }
          break;
        }
        case 9: {
          const a = victim ?? (await useNewBox());
          const b = solids[Math.floor(r() * solids.length)]!;
          const out = await outcome(triad.request({ type: 'hull', bodies: [a.ref, b.ref], nextFaceId: nextFace.value }));
          if (out.ok) {
            const v = out.value as { components: Array<{ mesh: MeshWire }>; nextFaceId: number };
            nextFace.value = v.nextFaceId;
            await replace(v.components);
          }
          break;
        }
        case 10: {
          const path: Vec3[] = [[0, 0, 0]];
          let at: Vec3 = [0, 0, 0];
          const count = 2 + Math.floor(r() * 4);
          for (let i = 0; i < count; i++) {
            at = [at[0] + (r() * 0.8) - 0.1, at[1] + (r() - 0.5), at[2] + (r() - 0.5) * 0.5];
            path.push(at);
          }
          const out = await outcome(triad.request({ type: 'followMe', profile: [starPolygon(r, 0, 0, 0.05 + 0.15 * r())], profileBasis: planeBasis([0, 0, 0], v3normalize(v3sub(path[1]!, path[0]!))), path, closed: r() < 0.2, nextFaceId: nextFace.value }));
          if (out.ok) {
            const v = out.value as { components: Array<{ mesh: MeshWire }>; nextFaceId: number };
            nextFace.value = v.nextFaceId;
            await replace(v.components);
          }
          break;
        }
        case 11: {
          const out = await outcome(triad.request({ type: 'revolve', profile: [starPolygon(r, 1 + r(), r() * 0.5, 0.1 + 0.4 * r())], profileBasis: xz, axisOrigin: [0, 0, 0], axisDir: [r() * 0.3, r() * 0.3, 1], angleDeg: 30 + r() * 330, segments: 3 + Math.floor(r() * 60), nextFaceId: nextFace.value }));
          if (out.ok) {
            const v = out.value as { components: Array<{ mesh: MeshWire }>; nextFaceId: number };
            nextFace.value = v.nextFaceId;
            await replace(v.components);
          }
          break;
        }
        case 12: {
          if (!victim) break;
          const center: Vec3 = [victim.mesh.verts[0]!, victim.mesh.verts[1]!, victim.mesh.verts[2]!];
          const a = 0.05 + r() * 0.2;
          const cutTool = toolSoup([center[0] - a, center[1] - a, center[2] - a], [center[0] + a, center[1] + a, center[2] + a]);
          const addTool = toolSoup([center[0] + a, center[1], center[2]], [center[0] + a * 2, center[1] + a, center[2] + a]);
          const choice = r();
          const out = await outcome(triad.request({ type: 'edgeBlend', body: victim.ref, cut: choice < 0.7 ? [cutTool] : [], add: choice > 0.3 ? [addTool] : [], nextFaceId: nextFace.value }));
          if (out.ok) {
            const v = out.value as { components: Array<{ mesh: MeshWire }>; nextFaceId: number };
            nextFace.value = v.nextFaceId;
            await replace(v.components);
          }
          break;
        }
        case 13: {
          if (!victim) break;
          const verts = new Float64Array(victim.mesh.verts);
          for (let i = 0; i < verts.length; i++) verts[i] = verts[i]! + (r() - 0.5) * 0.005;
          await outcome(triad.request({ type: 'autofold', body: victim.ref, mesh: { ...victim.mesh, verts }, nextFaceId: nextFace.value }));
          break;
        }
        case 14: {
          if (!victim) break;
          await outcome(triad.request({ type: 'release', bodyId: victim.ref.bodyId, version: victim.ref.version }));
          solids.splice(solids.indexOf(victim), 1);
          await outcome(triad.request({ type: 'stats' }));
          break;
        }
        case 15:
          await useNewBox();
          break;
      }
      while (solids.length > 6) {
        const old = solids.shift()!;
        await outcome(triad.request({ type: 'release', bodyId: old.ref.bodyId, version: old.ref.version }));
      }
    }

    const seedCount = Number(process.env.PF_DIFF_SEEDS ?? 16);
    const sequenceLength = Number(process.env.PF_DIFF_STEPS ?? 50);
    const seeds = Array.from({ length: seedCount }, (_, i) => i + 1);

    it.each(seeds)('seed %i: chained operations stay identical', async (seed) => {
      const r = rng(seed * 1000003);
      let id = 100000 * seed;
      const nextFace = { value: 100 };
      const solids: Solid[] = [];
      const first = await triad.request({ type: 'fromTriangles', mesh: wire(meshBox([0, 0, 0], [1, 1, 1])), nextFaceId: 6 });
      for (const c of first.components) {
        const bodyId = id++;
        await triad.request({ type: 'ensureBody', bodyId, version: 1, mesh: c.mesh });
        solids.push({ ref: { bodyId, version: 1 }, mesh: c.mesh });
      }
      for (let step = 0; step < sequenceLength; step++) {
        await randomStep(r, solids, () => id++, nextFace);
        for (const s of solids) expect(meshTopologyProblems(s.mesh).filter((p) => p !== 'signed volume is not positive'), `seed ${seed} step ${step}: closed manifold`).toEqual([]);
      }
    }, 120000);
  });

  describe('the comparison itself', () => {
    it('catches a one-bit change in positions, a triangle index, a face id, a run id and a volume', () => {
      const comp = { mesh: { verts: new Float64Array([0.1, 0.2, 0.3]), tris: new Uint32Array([0, 1, 2]), faceId: new Uint32Array([5]), runId: 9 }, faceOrigin: new Map([[5, [{ runId: 9, faceId: 1 }]]]), props: { volume: 1.5, area: 2.5 } };
      const clone = () => ({ mesh: { verts: new Float64Array(comp.mesh.verts), tris: new Uint32Array(comp.mesh.tris), faceId: new Uint32Array(comp.mesh.faceId), runId: comp.mesh.runId }, faceOrigin: new Map([[5, [{ runId: 9, faceId: 1 }]]]), props: { ...comp.props } });
      expect(diffValues(comp, clone(), 'c')).toBeUndefined();
      const pos = clone();
      new BigUint64Array(pos.mesh.verts.buffer)[0]! ^= 1n;
      expect(diffValues(comp, pos, 'c')).toMatch(/verts\[0\]/);
      const tri = clone();
      tri.mesh.tris[1] = 2;
      expect(diffValues(comp, tri, 'c')).toMatch(/tris\[1\]/);
      const face = clone();
      face.mesh.faceId[0] = 6;
      expect(diffValues(comp, face, 'c')).toMatch(/faceId/);
      const run = clone();
      run.mesh.runId = 10;
      expect(diffValues(comp, run, 'c')).toMatch(/runId/);
      const vol = clone();
      vol.props.volume = 1.5000000000000002;
      expect(diffValues(comp, vol, 'c')).toMatch(/volume/);
      const negZero = clone();
      negZero.mesh.verts[0] = 0;
      expect(diffValues({ x: 0 }, { x: -0 }, 'c')).toBeDefined();
    });

    it('catches a one-bit change in a real answer from the Rust kernel', async () => {
      const req: KernelRequest = { type: 'fromTriangles', mesh: wire(meshBox([0.1, 0.2, 0.3], [1, 1, 1])), nextFaceId: 6 };
      tamper = (bytes) => { bytes[bytes.length - 1]! ^= 1; };
      try {
        await expect(triad.request(req)).rejects.toThrow(/fromTriangles \(native\):/);
      } finally {
        tamper = undefined;
        expect(triad.failures).toHaveLength(1);
        triad.failures.length = 0;
      }
    });
  });
});
