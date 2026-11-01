// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MeshImportOptions } from './meshImport';
import { readModelImport } from './modelImport';
import { stepPreviewTransfer } from './stepWasm';

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (event: MessageEvent<{ bytes: Uint8Array; preview?: boolean; mesh?: MeshImportOptions | undefined; limits?: { stepBytes?: number | undefined; meshPartThreshold?: number | undefined } }>) => {
  try {
    const { bytes, mesh, limits, preview } = event.data;
    const scene = await readModelImport(bytes, progress => scope.postMessage({ type: 'progress', progress }), mesh, limits, undefined,
      preview ? p => scope.postMessage({ type: 'preview', preview: p }, stepPreviewTransfer(p)) : undefined);
    const transfer: Transferable[] = [];
    for (const def of [scene.root, ...scene.definitions.values()]) for (const solid of def.solids)
      transfer.push(solid.mesh.verts.buffer as ArrayBuffer, solid.mesh.tris.buffer as ArrayBuffer, solid.mesh.faceId.buffer as ArrayBuffer);
    // Each texture image owns its buffer (the reader's bytes are copied), so it can move too.
    for (const image of scene.images) transfer.push(image.bytes.buffer as ArrayBuffer);
    scope.postMessage({ type: 'result', scene }, transfer);
  } catch (cause) {
    scope.postMessage({ type: 'error', message: cause instanceof Error ? cause.message : 'Could not import this model.' });
  }
};
