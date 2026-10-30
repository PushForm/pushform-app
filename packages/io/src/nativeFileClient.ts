// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ImageId } from '@pushform/core';
import type { DocumentState, ImageBlob } from '@pushform/model';
import type { LayoutDocumentState } from '@pushform/layout';
import { assertLayoutState, encodeLayoutArchiveSync, parseLayoutFile } from './layoutFile';
import { decodeModelFile, encodeModelArchiveSync, type DecodedModelFile, type ModelArchiveImage } from './modelFile';
import { validateModelState } from './modelSession';
import { encodeNativeModelFile, decodeNativeModelFile, isNativeModelFile } from './native/modelFile';
import { layoutContentIdentity } from './native/layoutIdentity';
import { modelContentIdentity } from './native/modelIdentity';
import { encodeNativeLayoutFile, decodeNativeLayoutFile } from './native/layoutFile';

/**
 * Native archive work off the UI thread. Compression and inflation of .pf/.pfl archives run in a
 * disposable worker per request; the same code runs inline where `Worker` is unavailable (Node,
 * tests), behind the same promise-returning API.
 *
 * Modeling callers capture immutable state and assets; Protobuf encoding runs in the worker.
 * Layout snapshots also encode in the worker; legacy helpers accept manifest text.
 */
export type NativeFileRequest =
  | { type: 'encode-native-layout'; state: LayoutDocumentState }
  | { type: 'encode-native-model'; state: DocumentState; images: readonly ModelArchiveImage[] }
  | { type: 'encode-model'; content: string; images: readonly ModelArchiveImage[] }
  | { type: 'encode-layout'; content: string }
  | { type: 'decode-model'; bytes: Uint8Array }
  | { type: 'decode-layout'; bytes: Uint8Array };

/** A decoded .pf with a compact semantic saved-state identity, never a JSON copy of the model. */
export interface OpenedModelFile extends DecodedModelFile { contentIdentity: string }
/** A decoded .pfl with validated state and a compact saved-state identity. */
export interface OpenedLayoutFile { state: LayoutDocumentState; contentIdentity: string }

export type NativeFileResult<R extends NativeFileRequest> =
  R extends { type: 'encode-model' | 'encode-native-model' | 'encode-layout' | 'encode-native-layout' } ? Uint8Array :
  R extends { type: 'decode-model' } ? OpenedModelFile : OpenedLayoutFile;
type WorkerMessage = { type: 'result'; result: unknown } | { type: 'error'; message: string };

/** Execute a request synchronously; the worker and the inline fallback both call this. */
export function runNativeFileRequest<R extends NativeFileRequest>(request: R): NativeFileResult<R> {
  switch (request.type) {
    case 'encode-native-layout': throw new Error('Binary Layout encoding requires runNativeFileRequestAsync');
    case 'encode-native-model': throw new Error('Binary model encoding requires runNativeFileRequestAsync');
    case 'encode-model': return encodeModelArchiveSync(request.content, request.images) as NativeFileResult<R>;
    case 'encode-layout': return encodeLayoutArchiveSync(request.content) as NativeFileResult<R>;
    case 'decode-model': {
      const file = decodeModelFile(request.bytes);
      return { ...file, contentIdentity: modelContentIdentity(file.state) } as NativeFileResult<R>;
    }
    case 'decode-layout': {
      const state = parseLayoutFile(request.bytes);
      return { state, contentIdentity: layoutContentIdentity(state) } as NativeFileResult<R>;
    }
  }
}

export async function runNativeFileRequestAsync<R extends NativeFileRequest>(request: R): Promise<NativeFileResult<R>> {
  if (request.type === 'encode-native-layout') return await encodeNativeLayoutFile(request.state) as NativeFileResult<R>;
  if (request.type === 'decode-layout' && isNativeModelFile(request.bytes)) {
    const bytes = request.bytes;
    const state = await decodeNativeLayoutFile({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) });
    return { state, contentIdentity: layoutContentIdentity(state) } as NativeFileResult<R>;
  }
  if (request.type === 'encode-native-model') return await encodeNativeModelFile(request.state, new Map(request.images.map(image => [image.id, image.blob]))) as NativeFileResult<R>;
  if (request.type === 'decode-model' && isNativeModelFile(request.bytes)) {
    const bytes = request.bytes;
    const file = await decodeNativeModelFile({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) });
    return { ...file, contentIdentity: modelContentIdentity(file.state) } as NativeFileResult<R>;
  }
  return runNativeFileRequest(request);
}

/** Buffers a result owns outright, so a worker can move rather than copy them. */
export function nativeFileTransferables(result: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (view: ArrayBufferView | undefined): void => {
    if (view && view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
  };
  if (result instanceof Uint8Array) add(result);
  else if (result && typeof result === 'object' && 'images' in result) {
    const file = result as OpenedModelFile;
    for (const definition of file.state.definitions.values()) for (const body of definition.entities.bodies.values()) {
      add(body.mesh.verts); add(body.mesh.tris); add(body.mesh.faceId);
    }
    for (const image of file.images.values()) add(image.bytes);
  }
  return [...buffers];
}

function dispatch<R extends NativeFileRequest>(request: R, prepare?: () => { copy: R; transfer: ArrayBuffer[] }): Promise<NativeFileResult<R>> {
  if (typeof Worker === 'undefined') return runNativeFileRequestAsync(request);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./nativeFileWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      // No worker support in this host: do the work here rather than failing the save or open.
      resolve(runNativeFileRequestAsync(request)); return;
    }
    let settled = false;
    const finish = (): void => { settled = true; worker.terminate(); };
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (settled) return;
      finish();
      const msg = event.data;
      if (msg.type === 'error') { reject(new Error(msg.message)); return; }
      try { resolve(checkResult(request, msg.result)); } catch (cause) { reject(cause); }
    };
    // The worker script failing to load leaves the request intact; finish it inline.
    worker.onerror = () => { if (!settled) { finish(); resolve(runNativeFileRequestAsync(request)); } };
    worker.onmessageerror = () => { if (!settled) { finish(); reject(new Error('Could not receive the document result.')); } };
    try {
      const { copy, transfer } = prepare?.() ?? { copy: request, transfer: [] };
      worker.postMessage(copy, transfer);
    }
    catch (cause) { finish(); reject(cause); }
  });
}

/** Re-check structure after the structured clone; the worker's result is data, not a trusted object graph. */
function checkResult<R extends NativeFileRequest>(request: R, result: unknown): NativeFileResult<R> {
  switch (request.type) {
    case 'encode-model': case 'encode-native-model': case 'encode-layout': case 'encode-native-layout':
      if (!(result instanceof Uint8Array)) throw new Error('Could not encode the document.');
      return result as NativeFileResult<R>;
    case 'decode-model': {
      const file = result as Partial<OpenedModelFile> | null;
      if (!file || typeof file.contentIdentity !== 'string' || !/^pf-model-v1-sha256:[a-f0-9]{64}$/.test(file.contentIdentity) || !(file.images instanceof Map)) throw new Error('Invalid model document');
      const state: DocumentState = validateModelState(file.state);
      const images: Map<ImageId, ImageBlob> = file.images;
      return { state, images, contentIdentity: file.contentIdentity } as NativeFileResult<R>;
    }
    case 'decode-layout': {
      const file = result as Partial<OpenedLayoutFile> | null;
      if (!file || typeof file.contentIdentity !== 'string' || !/^pf-layout-v1-sha256:[a-f0-9]{64}$/.test(file.contentIdentity)) throw new Error('Invalid Layout document');
      return { state: assertLayoutState(file.state), contentIdentity: file.contentIdentity } as NativeFileResult<R>;
    }
  }
}

/** Compress a captured `modelJson` snapshot and its image entries into .pf bytes. */
export function encodeModelArchive(content: string, images: readonly ModelArchiveImage[]): Promise<Uint8Array> {
  const request = { type: 'encode-model', content, images } as const;
  return dispatch(request, () => {
    // Allocate transfer copies only after a worker exists; the live image store keeps its buffers.
    const copies = images.map(({ id, blob }) => ({ id, blob: { bytes: new Uint8Array(blob.bytes), mime: blob.mime } }));
    return { copy: { ...request, images: copies }, transfer: copies.map(image => image.blob.bytes.buffer as ArrayBuffer) };
  });
}

/** Capture immutable state and asset entries before dispatch; live geometry buffers are never detached. */
export function encodeModelSnapshot(state: DocumentState, images: readonly ModelArchiveImage[]): Promise<Uint8Array> {
  const request = { type: 'encode-native-model', state, images } as const;
  return dispatch(request);
}

/** Compress a captured `layoutJson` snapshot into .pfl bytes. */
export function encodeLayoutArchive(content: string): Promise<Uint8Array> {
  const request = { type: 'encode-layout', content } as const;
  return dispatch(request);
}

/** Encode captured immutable Layout state as Protobuf and binary assets in a worker. */
export function encodeLayoutSnapshot(state: LayoutDocumentState): Promise<Uint8Array> {
  const request = { type: 'encode-native-layout', state } as const;
  return dispatch(request);
}

/** Inflate, parse, and hydrate a .pf archive; the caller's bytes are left intact. */
export function openModelFile(bytes: Uint8Array): Promise<OpenedModelFile> {
  const request = { type: 'decode-model', bytes } as const;
  return dispatch(request, () => {
    const copy = new Uint8Array(bytes);
    return { copy: { ...request, bytes: copy }, transfer: [copy.buffer as ArrayBuffer] };
  });
}

/** Inflate, parse, and validate a .pfl archive; the caller's bytes are left intact. */
export function openLayoutFile(bytes: Uint8Array): Promise<OpenedLayoutFile> {
  const request = { type: 'decode-layout', bytes } as const;
  return dispatch(request, () => {
    const copy = new Uint8Array(bytes);
    return { copy: { ...request, bytes: copy }, transfer: [copy.buffer as ArrayBuffer] };
  });
}
