// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Conversion between the Float64 wire mesh and Manifold's Float32 MeshGL.
 * Positions are uploaded/read relative to the bounds centre so float32 only has to carry the
 * body's extent, not its distance from the origin; the Manifold itself lives in world coordinates.
 */
import type { Manifold, ManifoldToplevel, Mesh } from 'manifold-3d';
import { box3Center, box3FromPositions } from '@pushform/core';
import { KernelError, type ManifoldStatus } from '../protocol';

/** Triangles with per-triangle provenance, as read back from a Manifold. */
export interface ReadMesh {
  verts: Float64Array;
  tris: Uint32Array;
  /** Per triangle: originalID of the run the triangle came from. */
  runId: Uint32Array;
  /** Per triangle: source face id. */
  faceId: Uint32Array;
}

export interface TriangleSoup {
  verts: Float64Array;
  tris: Uint32Array;
  faceId: Uint32Array;
}

/** Build the MeshGL for `soup` with positions relative to `center` and the given originalID. */
function meshGLFrom(wasm: ManifoldToplevel, soup: TriangleSoup, runId: number, center: readonly number[]): Mesh {
  const n = soup.verts.length;
  const props = new Float32Array(n);
  for (let i = 0; i < n; i += 3) {
    props[i] = soup.verts[i]! - center[0]!;
    props[i + 1] = soup.verts[i + 1]! - center[1]!;
    props[i + 2] = soup.verts[i + 2]! - center[2]!;
  }
  return new wasm.Mesh({
    numProp: 3,
    vertProperties: props,
    triVerts: new Uint32Array(soup.tris),
    faceID: new Uint32Array(soup.faceId),
    runIndex: new Uint32Array([0, soup.tris.length]),
    runOriginalID: new Uint32Array([runId]),
  });
}

function statusOf(e: unknown): ManifoldStatus {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? (code as ManifoldStatus) : 'Unknown';
}

/**
 * Create a Manifold (in world coordinates) from a triangle soup. Returns the status instead of
 * throwing when Manifold rejects the input.
 */
export function tryManifoldFromSoup(
  wasm: ManifoldToplevel,
  soup: TriangleSoup,
  runId: number,
): { manifold: Manifold; status: 'NoError' } | { manifold?: undefined; status: ManifoldStatus } {
  if (soup.tris.length === 0 || soup.tris.length % 3 !== 0 || soup.faceId.length !== soup.tris.length / 3) {
    return { status: 'FaceIDWrongLength' };
  }
  const center = box3Center(box3FromPositions(soup.verts));
  let local: Manifold;
  try {
    // The JS wrapper throws ManifoldError (with `.code`) when status() !== 'NoError'.
    local = new wasm.Manifold(meshGLFrom(wasm, soup, runId, center));
  } catch (e) {
    return { status: statusOf(e) };
  }
  const status = local.status();
  if (status !== 'NoError') {
    local.delete();
    return { status };
  }
  const world = local.translate(center[0], center[1], center[2]);
  local.delete();
  return { manifold: world, status: 'NoError' };
}

/** Like {@link tryManifoldFromSoup} but throws a `ManifoldError` KernelError on failure. */
export function manifoldFromSoup(wasm: ManifoldToplevel, soup: TriangleSoup, runId: number): Manifold {
  const r = tryManifoldFromSoup(wasm, soup, runId);
  if (r.manifold === undefined) throw new KernelError('ManifoldError', `Mesh rejected by Manifold: ${r.status}`, { status: r.status });
  return r.manifold;
}

/**
 * Read a Manifold back as welded Float64 triangles with provenance. Vertices are read relative to
 * the bounding-box centre; merge vectors are applied so every edge is shared by index.
 */
export function readManifold(m: Manifold): ReadMesh {
  if (m.isEmpty()) {
    return { verts: new Float64Array(0), tris: new Uint32Array(0), runId: new Uint32Array(0), faceId: new Uint32Array(0) };
  }
  const box = m.boundingBox();
  const c = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const shifted = m.translate(-c[0]!, -c[1]!, -c[2]!);
  const mg = shifted.getMesh();
  shifted.delete();

  const numVert = mg.numVert;
  const remap = new Uint32Array(numVert);
  for (let i = 0; i < numVert; i++) remap[i] = i;
  const from = mg.mergeFromVert, to = mg.mergeToVert;
  if (from !== undefined && to !== undefined) {
    for (let i = 0; i < from.length; i++) remap[from[i]!] = to[i]!;
  }
  const numTri = mg.numTri;
  const used = new Int32Array(numVert).fill(-1);
  let count = 0;
  const tris = new Uint32Array(numTri * 3);
  for (let i = 0; i < tris.length; i++) {
    const v = remap[mg.triVerts[i]!]!;
    if (used[v] === -1) used[v] = count++;
    tris[i] = used[v]!;
  }
  const verts = new Float64Array(count * 3);
  const p = mg.vertProperties, np = mg.numProp;
  for (let v = 0; v < numVert; v++) {
    const o = used[v]!;
    if (o === -1) continue;
    verts[o * 3] = p[v * np]! + c[0]!;
    verts[o * 3 + 1] = p[v * np + 1]! + c[1]!;
    verts[o * 3 + 2] = p[v * np + 2]! + c[2]!;
  }
  const runId = new Uint32Array(numTri);
  const runIndex = mg.runIndex, runOriginalID = mg.runOriginalID;
  if (runIndex !== undefined && runOriginalID !== undefined) {
    for (let r = 0; r < runOriginalID.length; r++) {
      const start = runIndex[r]! / 3;
      const end = r + 1 < runIndex.length ? runIndex[r + 1]! / 3 : numTri;
      runId.fill(runOriginalID[r]!, start, end);
    }
  }
  const faceId = mg.faceID !== undefined && mg.faceID.length === numTri ? new Uint32Array(mg.faceID) : new Uint32Array(numTri);
  return { verts, tris, runId, faceId };
}
