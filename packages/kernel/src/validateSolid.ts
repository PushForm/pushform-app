// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MeshData } from '@pushform/core';
import { KernelError } from './protocol';
import { loadManifold } from './worker/ManifoldModule';
import { manifoldFromSoup } from './worker/meshio';

/** Validate a staged mesh without normalizing it or retaining a kernel cache entry. */
export async function validateSolidMesh(mesh: MeshData, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (mesh.verts.length % 3 || mesh.tris.length % 3 || mesh.faceId.length !== mesh.tris.length / 3) throw new KernelError('InvalidInput', 'Invalid mesh column lengths');
  for (const n of mesh.verts) if (!Number.isFinite(n)) throw new KernelError('InvalidInput', 'Nonfinite mesh coordinate');
  for (const index of mesh.tris) if (index >= mesh.verts.length / 3) throw new KernelError('InvalidInput', 'Mesh vertex index out of range');
  const wasm = await loadManifold(); signal?.throwIfAborted();
  const solid = manifoldFromSoup(wasm, mesh, wasm.Manifold.reserveIDs(1));
  try {
    if (solid.isEmpty() || !(solid.volume() > 0)) throw new KernelError('InvalidInput', 'Body must enclose positive volume');
    signal?.throwIfAborted();
  } finally { solid.delete(); }
}
