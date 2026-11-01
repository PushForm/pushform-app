// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MeshPartGeometry } from '@pushform/model';
import { threadTableBytes } from './stepThreads';

/**
 * The STEP reader module (`crates/step-reader`, SolidCraft's reader compiled to `wasm32-wasip1`), loaded once on the
 * first STEP read. The module needs only a handful of WASI calls (clock, random bytes, writing its panic message), so a
 * small shim serves it in the browser, the desktop webview and Node alike; nothing is read from a file system.
 */
export interface StepReaderModule {
  memory: WebAssembly.Memory;
  /** The host's threads for `pf_step_mesh_start` (the threaded build, where the host could start workers). */
  threads?: StepThreadPool;
  pf_alloc(len: number): number;
  pf_free(ptr: number, len: number): void;
  /**
   * `mode` 0: plain triangles for files that become faces; 1: the display mesh for files that stay mesh parts.
   * `threads`: the threads the host offers (1: none); the conversion and the meshing use them where the build can.
   */
  pf_step_open(ptr: number, len: number, mode: number, threshold: number, threads: number): number;
  pf_step_progress(handle: number): bigint;
  pf_step_step(handle: number): number;
  /**
   * Finish the conversion; 1 on success. With threads the parts were meshed as they were converted (poll
   * `pf_step_mesh_done`); without, `pf_step_mesh` meshes one part per call (1 while more remain).
   */
  pf_step_finish(handle: number): number;
  /** Bodies whose part is meshed, of the bodies planned; moves during the conversion too. */
  pf_step_mesh_progress(handle: number): bigint;
  pf_step_mesh(handle: number): number;
  pf_step_mesh_done(handle: number): number;
  pf_step_result(handle: number): number;
  pf_step_result_ptr(handle: number): number;
  /**
   * The parts meshed, and the placements whose part is meshed, since the last call, as a preview buffer
   * (`decodeStepPreview`); its length, or 0 when nothing new is ready. Absent from modules built before previews.
   */
  pf_step_preview?(handle: number): number;
  pf_step_preview_ptr?(handle: number): number;
  pf_step_close(handle: number): void;
  /** Write the STEP file for a request (see `stepExport.ts`); the text's length, or 0 on failure. `pf_step_export_ptr` then points at it. */
  pf_step_export(ptr: number, len: number): number;
  pf_step_export_ptr(): number;
  pf_error_len(): number;
  pf_error_ptr(): number;
}

/**
 * Threads for the threaded build (`wasm32-wasip1-threads`): the module's memory is shared, and `spawn` runs
 * `wasi_thread_start(tid, start)` on a worker for each thread the module starts, returning the thread id (or -1).
 * `failure` holds the message of a worker that stopped, which fails the read it was part of.
 */
export interface StepThreadPool {
  readonly memory: WebAssembly.Memory;
  readonly count: number;
  spawn(start: number): number;
  /** Workers to make: `start` gets the address of their thread table (see `threadTableBytes`), once the module is instantiated, and resolves when they are ready. */
  readonly capacity: number;
  start(table: number): Promise<void>;
  readonly failure?: string | undefined;
}

const ENOSYS = 52, EBADF = 8, ESUCCESS = 0;
let stderr = '';

/** The WASI preview 1 calls the reader can make, served without a file system; the rest fail with ENOSYS. */
export function wasiImports(getMemory: () => WebAssembly.Memory): WebAssembly.ModuleImports {
  const view = () => new DataView(getMemory().buffer);
  const bytes = () => new Uint8Array(getMemory().buffer);
  const known: Record<string, (...args: number[]) => number> = {
    fd_write: (fd, iovs, count, written) => {
      const v = view(); let total = 0;
      for (let i = 0; i < count; i++) {
        const ptr = v.getUint32(iovs + i * 8, true), len = v.getUint32(iovs + i * 8 + 4, true);
        // Copied out first: browsers refuse to decode (or fill) a view of a shared memory.
        if (fd === 2) stderr += new TextDecoder().decode(bytes().slice(ptr, ptr + len));
        total += len;
      }
      v.setUint32(written!, total, true);
      return ESUCCESS;
    },
    fd_close: () => ESUCCESS,
    fd_seek: () => EBADF,
    fd_read: () => EBADF,
    fd_fdstat_get: (fd, out) => { if (fd > 2) return EBADF; bytes().fill(0, out, out! + 24); return ESUCCESS; },
    fd_prestat_get: () => EBADF,
    environ_sizes_get: (count, size) => { const v = view(); v.setUint32(count!, 0, true); v.setUint32(size!, 0, true); return ESUCCESS; },
    environ_get: () => ESUCCESS,
    args_sizes_get: (count, size) => { const v = view(); v.setUint32(count!, 0, true); v.setUint32(size!, 0, true); return ESUCCESS; },
    args_get: () => ESUCCESS,
    clock_time_get: (_id, _precision, out) => { view().setBigUint64(out!, BigInt(Math.round(performance.now() * 1e6)), true); return ESUCCESS; },
    random_get: (ptr, len) => { const random = new Uint8Array(len!); crypto.getRandomValues(random); bytes().set(random, ptr); return ESUCCESS; },
    sched_yield: () => ESUCCESS,
    poll_oneoff: () => ENOSYS,
    proc_exit: (code) => { throw new Error(`The STEP reader stopped (exit ${code}).${stderr ? ` ${stderr.trim()}` : ''}`); },
  };
  return new Proxy(known, { get: (target, name: string) => target[name] ?? (() => ENOSYS) });
}

/**
 * Instantiate the reader. The single-threaded build exports its memory; the threaded build imports the shared memory
 * of `threads` and asks it for workers, and runs single-threaded (one part per `pf_step_mesh` call) without them.
 */
export async function instantiateStepReader(source: BufferSource | WebAssembly.Module, threads?: StepThreadPool): Promise<StepReaderModule> {
  // The imports need the memory the instance exports, so they read it through a holder filled in after instantiation.
  const holder: { memory?: WebAssembly.Memory | undefined } = { memory: threads?.memory };
  const imports: WebAssembly.Imports = { wasi_snapshot_preview1: wasiImports(() => holder.memory!) };
  if (threads) { imports.env = { memory: threads.memory }; imports.wasi = { 'thread-spawn': (start: number) => threads.spawn(start) }; }
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const instance = await WebAssembly.instantiate(module, imports);
  const exports = instance.exports as unknown as StepReaderModule & { _initialize?: () => void; pf_init?: () => void };
  holder.memory = exports.memory;
  exports._initialize?.();
  // The threaded build's main thread is set up by the host (a library has no start function to do it), and its
  // threads number themselves from a counter in the shared memory.
  exports.pf_init?.();
  if (threads) await threads.start(exports.pf_alloc(threadTableBytes(threads.capacity)));
  // The exports object is frozen, so the module handed out is a copy that can carry the thread pool.
  return { ...exports, memory: exports.memory, threads } as StepReaderModule;
}

/** The reader's last error message. */
export function stepReaderError(m: StepReaderModule): string {
  const len = m.pf_error_len(), ptr = m.pf_error_ptr();
  return len && ptr ? new TextDecoder().decode(new Uint8Array(m.memory.buffer, ptr, len).slice()) : (stderr.trim() || 'The STEP reader failed.');
}

export interface StepReaderPart { name: string; closed: boolean; color: [number, number, number] | null; geometry: MeshPartGeometry }
export interface StepReaderPlacement { part: number; name: string; instance: string; path: string[]; matrix: number[] }
export interface StepReaderResult { parts: StepReaderPart[]; placements: StepReaderPlacement[]; warnings: string[]; schema: string; system: string }

/** Decode the reader's result buffer (`write_result` in the crate): copies every array out of the module's memory. */
export function decodeStepResult(buffer: Uint8Array): StepReaderResult {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let at = 0;
  const magic = new TextDecoder().decode(buffer.subarray(0, 8));
  if (magic !== 'PFSTEP01') throw new Error('The STEP reader returned a result this app does not understand.');
  at = 8;
  const pad = (): void => { at = (at + 7) & ~7; };
  const u32 = (): number => { const v = view.getUint32(at, true); at += 4; return v; };
  const f32 = (): number => { const v = view.getFloat32(at, true); at += 4; return v; };
  const text = (): string => { const len = u32(); const s = new TextDecoder().decode(buffer.subarray(at, at + len)); at += len; pad(); return s; };
  const u32s = (): Uint32Array => { const len = u32(); const out = new Uint32Array(len); for (let i = 0; i < len; i++) out[i] = view.getUint32(at + i * 4, true); at += len * 4; pad(); return out; };
  const f64s = (): Float64Array => { const len = u32(); pad(); const out = new Float64Array(len); for (let i = 0; i < len; i++) out[i] = view.getFloat64(at + i * 8, true); at += len * 8; return out; };
  const u8s = (): Uint8Array => { const len = u32(); const out = buffer.slice(at, at + len); at += len; pad(); return out; };
  const partCount = u32(); pad();
  const parts: StepReaderPart[] = [];
  for (let i = 0; i < partCount; i++) {
    const name = text(), closed = u32() === 1, r = f32(), g = f32(), b = f32(), faceCount = u32(); pad();
    const positions = f64s(), triangles = u32s(), triangleFace = u32s(), edgeOffsets = u32s(), edgePositions = f64s(), edgeFlags = u8s();
    parts.push({ name, closed, color: r < 0 ? null : [r, g, b], geometry: { positions, triangles, triangleFace, faceCount, faceMaterials: new Uint32Array(faceCount), edgeOffsets, edgePositions, edgeFlags } });
  }
  const placementCount = u32(); pad();
  const placements: StepReaderPlacement[] = [];
  for (let i = 0; i < placementCount; i++) {
    const part = u32(), name = text(), instance = text(), depth = u32(); pad();
    const path: string[] = [];
    for (let d = 0; d < depth; d++) path.push(text());
    const matrix: number[] = [];
    for (let k = 0; k < 16; k++) { matrix.push(view.getFloat64(at, true)); at += 8; }
    placements.push({ part, name, instance, path, matrix });
  }
  const warningCount = u32(); pad();
  const warnings: string[] = [];
  for (let i = 0; i < warningCount; i++) warnings.push(text());
  return { parts, placements, warnings, schema: text(), system: text() };
}

/** A part in a preview: its mesh in its own frame (meters, Float32 for drawing), color, and hard edges as segments. */
export interface StepPreviewPart {
  /** Number of the part within its read; placements name it. */
  id: number;
  color: [number, number, number] | null;
  positions: Float32Array;
  triangles: Uint32Array;
  /** Hard edges, two end points (six numbers) per segment. */
  edges: Float32Array;
}
/** A placement in a preview: the part it places and its column-major matrix in meters. */
export interface StepPreviewPlacement { part: number; matrix: number[] }
/**
 * What a STEP read hands out while it runs: the parts meshed since the last preview and the placements whose part is
 * now meshed (a placement comes in the same preview as its part, or a later one). For drawing only; the result
 * carries the model.
 */
export interface StepPreview { parts: StepPreviewPart[]; placements: StepPreviewPlacement[] }

/** Decode a preview buffer (`write_preview` in the crate); every array is copied out of `buffer`. */
export function decodeStepPreview(buffer: Uint8Array): StepPreview {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (new TextDecoder().decode(buffer.slice(0, 8)) !== 'PFPREV01') throw new Error('The STEP reader returned a preview this app does not understand.');
  let at = 8;
  const pad = (): void => { at = (at + 7) & ~7; };
  const u32 = (): number => { const v = view.getUint32(at, true); at += 4; return v; };
  const f32 = (): number => { const v = view.getFloat32(at, true); at += 4; return v; };
  const f32s = (): Float32Array => { const len = u32(); const out = new Float32Array(len); for (let i = 0; i < len; i++) out[i] = view.getFloat32(at + i * 4, true); at += len * 4; pad(); return out; };
  const u32s = (): Uint32Array => { const len = u32(); const out = new Uint32Array(len); for (let i = 0; i < len; i++) out[i] = view.getUint32(at + i * 4, true); at += len * 4; pad(); return out; };
  const partCount = u32(); pad();
  const parts: StepPreviewPart[] = [];
  for (let i = 0; i < partCount; i++) {
    const id = u32(), r = f32(), g = f32(), b = f32(); pad();
    parts.push({ id, color: r < 0 ? null : [r, g, b], positions: f32s(), triangles: u32s(), edges: f32s() });
  }
  const placementCount = u32(); pad();
  const placements: StepPreviewPlacement[] = [];
  for (let i = 0; i < placementCount; i++) {
    const part = u32(); pad();
    const matrix: number[] = [];
    for (let k = 0; k < 16; k++) { matrix.push(view.getFloat64(at, true)); at += 8; }
    placements.push({ part, matrix });
  }
  return { parts, placements };
}

/** The buffers a preview owns, to transfer it between threads without copying. */
export function stepPreviewTransfer(preview: StepPreview): ArrayBuffer[] {
  return preview.parts.flatMap(p => [p.positions.buffer as ArrayBuffer, p.triangles.buffer as ArrayBuffer, p.edges.buffer as ArrayBuffer]);
}
