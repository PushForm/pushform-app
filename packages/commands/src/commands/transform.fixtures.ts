// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Shared fixtures for the transform command and tool tests: a PolyMesh stub (used until
 * `@pushform/model` exports the real module), a fake camera and a registry with the kernel.
 */
import type { Box3, Ray, Vec3 } from '@pushform/core';
import { m4transformPoint, MERGE_TOL, v3dist } from '@pushform/core';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { SketchGraph, type Body, type EntityContainer } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import type { CameraHost, CameraState } from '../camera/CameraHost';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT, SERVICE_KERNEL } from '../host/services';
import { modelCommands } from './model';
import { pushPullCommands } from './pushpull';
import { sketchCommands } from './sketch';
import { getPolyMeshModule, setPolyMeshModule, transformCommands, type PolyMeshModule, type TransformApplyResult } from './transform';

// ---------------------------------------------------------------------------------------------
// PolyMesh stub: used only until `@pushform/model` exports the real module (agent A).

/** Minimal PolyMesh over the face layer: planar faces fan-triangulated, no fold splitting. */
export const polyMeshStub: PolyMeshModule = {
  polyMeshFromBody(body) {
    const verts: Vec3[] = [];
    const index = new Map<string, number>();
    const idx = (p: Vec3): number => {
      const k = p.map((x) => Math.round(x / 1e-7)).join(',');
      let i = index.get(k);
      if (i === undefined) {
        i = verts.length;
        verts.push([p[0], p[1], p[2]]);
        index.set(k, i);
      }
      return i;
    };
    const faces = [...body.faces.values()].map((f) => ({ faceId: f.id, loops: f.loops.map((l) => l.map(idx)) }));
    return { verts, faces };
  },
  polyVerticesForRef(body, poly, ref) {
    const pts: Vec3[] =
      ref.kind === 'face' ? (body.faces.get(ref.faceId)?.loops.flat() ?? []) : ref.kind === 'edge' ? (body.edges.get(ref.edgeKey)?.polyline ?? []) : [];
    const out: number[] = [];
    poly.verts.forEach((v, i) => {
      if (pts.some((p) => v3dist(p, v) <= MERGE_TOL)) out.push(i);
    });
    return out;
  },
  transformVertices(poly, indices, m) {
    const set = new Set(indices);
    return { verts: poly.verts.map((v, i) => (set.has(i) ? m4transformPoint(m, v) : v)), faces: poly.faces };
  },
  foldAndTriangulate(poly) {
    const verts = new Float64Array(poly.verts.length * 3);
    poly.verts.forEach((v, i) => verts.set(v, i * 3));
    const tris: number[] = [], faceId: number[] = [];
    let maxId = -1;
    for (const f of poly.faces) {
      const loop = f.loops[0] ?? [];
      for (let i = 1; i + 1 < loop.length; i++) {
        tris.push(loop[0]!, loop[i]!, loop[i + 1]!);
        faceId.push(f.faceId);
      }
      maxId = Math.max(maxId, f.faceId);
    }
    return { mesh: { verts, tris: Uint32Array.from(tris), faceId: Uint32Array.from(faceId) }, faceOrigin: new Map(), nextFaceId: maxId + 1 };
  },
};

/** An open mesh (one triangle dropped): Manifold must reject it. */
const brokenPolyMeshStub: PolyMeshModule = {
  ...polyMeshStub,
  foldAndTriangulate(poly) {
    const r = polyMeshStub.foldAndTriangulate(poly);
    return { ...r, mesh: { verts: r.mesh.verts, tris: r.mesh.tris.slice(3), faceId: r.mesh.faceId.slice(1) } };
  },
};

export const usingRealPolyMesh = getPolyMeshModule() !== null;

/** Install the stub when the real PolyMesh module is absent (call from `beforeAll`). */
export function installPolyMeshStub(): void {
  if (!usingRealPolyMesh) setPolyMeshModule(polyMeshStub);
}

/** The broken stub for rejection tests; restore with `restorePolyMesh`. */
export function installBrokenPolyMeshStub(): void {
  setPolyMeshModule(brokenPolyMeshStub);
}
export function restorePolyMesh(): void {
  setPolyMeshModule(usingRealPolyMesh ? null : polyMeshStub);
}

// ---------------------------------------------------------------------------------------------
// setup

/** Top-down parallel camera: 600 px over 6 m → 100 px/m, screen = (400 + x·100, 300 − y·100). */
export const TOP_CAMERA: CameraState = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 35, projection: 'parallel', orthoHeight: 6 };
/** Oblique parallel camera so that no two box grips share a screen position. */
export const ISO_CAMERA: CameraState = { eye: [10, -10, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 35, projection: 'parallel', orthoHeight: 6 };

export class FakeCamera implements CameraHost {
  constructor(public state: CameraState = TOP_CAMERA) {}
  getState(): CameraState {
    return this.state;
  }
  setState(s: CameraState): void {
    this.state = s;
  }
  viewportSize(): { width: number; height: number } {
    return { width: 800, height: 600 };
  }
  screenToRay(): Ray {
    return { origin: [0, 0, 0], dir: [0, 0, -1] };
  }
  pick(): Vec3 | null {
    return null;
  }
  sceneBounds(): Box3 | null {
    return null;
  }
  orbitStart(): void {}
  orbitDrag(): void {}
  orbitEnd(): void {}
  panStart(): void {}
  panDrag(): void {}
  panEnd(): void {}
  zoomAt(): void {}
  zoomExtents(): void {}
  zoomWindow(): void {}
  standardView(): void {}
  setProjection(): void {}
  setFov(): void {}
  setFocalLength(): void {}
  previousView(): boolean {
    return false;
  }
  nextView(): boolean {
    return false;
  }
}

const kernels: KernelClient[] = [];
/** Dispose every kernel created by `setupCommands` (call from `afterEach`). */
export function disposeKernels(): void {
  for (const k of kernels.splice(0)) k.dispose();
}

export function setupCommands(cameraState: CameraState = TOP_CAMERA) {
  const host = new DocumentHost();
  const kernel = new KernelClient(new InlineBackend());
  kernels.push(kernel);
  const camera = new FakeCamera(cameraState);
  const services = new Map<string, unknown>([
    [SERVICE_DOCUMENT, host],
    [SERVICE_KERNEL, kernel],
  ]);
  const registry = new CommandRegistry({ tx: host, camera, services });
  registry.registerAll(editCommands);
  registry.registerAll(modelCommands);
  registry.registerAll(sketchCommands);
  registry.registerAll(pushPullCommands);
  registry.registerAll(transformCommands);
  const root = (): EntityContainer => host.doc.rootDefinition.entities;
  const bodies = (): Body[] => [...root().bodies.values()];
  const addBox = (min: Vec3 = [0, 0, 0], max: Vec3 = [1, 1, 1]): number => registry.execute('model.addBox', { min, max }) as number;
  const body = (id: number): Body => root().bodies.get(id as never)!;
  const apply = (params: unknown): Promise<TransformApplyResult> => registry.execute('transform.apply', params) as Promise<TransformApplyResult>;
  const addRectangle = (w = 1, h = 1, z = 0): void => {
    host.edit('Rectangle', (draft) => {
      const g = SketchGraph.for(draft);
      g.addEdge([0, 0, z], [w, 0, z]);
      g.addEdge([w, 0, z], [w, h, z]);
      g.addEdge([w, h, z], [0, h, z]);
      g.addEdge([0, h, z], [0, 0, z]);
    });
  };
  return { host, kernel, registry, camera, root, bodies, addBox, body, apply, addRectangle };
}

