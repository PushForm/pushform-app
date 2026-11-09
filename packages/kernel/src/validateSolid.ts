// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MeshData } from '@pushform/core';
import { KernelError } from './protocol';

/** Validate a staged mesh without normalizing it or retaining a kernel cache entry. */
export async function validateSolidMesh(mesh: MeshData, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (mesh.verts.length % 3 || mesh.tris.length % 3 || mesh.faceId.length !== mesh.tris.length / 3) throw new KernelError('InvalidInput', 'Invalid mesh column lengths');
  for (const n of mesh.verts) if (!Number.isFinite(n)) throw new KernelError('InvalidInput', 'Nonfinite mesh coordinate');
  for (const index of mesh.tris) if (index >= mesh.verts.length / 3) throw new KernelError('InvalidInput', 'Mesh vertex index out of range');
  await (await import('./rustWasm')).validateSolidWithRust(mesh);
  signal?.throwIfAborted();
}
