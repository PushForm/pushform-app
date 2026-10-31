// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MeshPartGeometry } from '@pushform/model';

/**
 * The STEP reader module (`crates/step-reader`, SolidCraft's reader compiled to `wasm32-wasip1`), loaded once on the
 * first STEP read. The module needs only a handful of WASI calls (clock, random bytes, writing its panic message), so a
 * small shim serves it in the browser, the desktop webview and Node alike; nothing is read from a file system.
 */
export interface StepReaderModule {
  memory: WebAssembly.Memory;
  pf_alloc(len: number): number;
  pf_free(ptr: number, len: number): void;
  /** `mode` 0: plain triangles for files that become faces; 1: the display mesh for files that stay mesh parts. */
  pf_step_open(ptr: number, len: number, mode: number, threshold: number): number;
  pf_step_progress(handle: number): bigint;
  pf_step_step(handle: number): number;
  pf_step_finish(handle: number): number;
  pf_step_result_ptr(handle: number): number;
  pf_step_close(handle: number): void;
  pf_error_len(): number;
  pf_error_ptr(): number;
}

const ENOSYS = 52, EBADF = 8, ESUCCESS = 0;
let stderr = '';

/** The WASI preview 1 calls the reader can make, served without a file system; the rest fail with ENOSYS. */
function wasiImports(getMemory: () => WebAssembly.Memory): WebAssembly.ModuleImports {
  const view = () => new DataView(getMemory().buffer);
  const bytes = () => new Uint8Array(getMemory().buffer);
  const known: Record<string, (...args: number[]) => number> = {
    fd_write: (fd, iovs, count, written) => {
      const v = view(); let total = 0;
      for (let i = 0; i < count; i++) {
        const ptr = v.getUint32(iovs + i * 8, true), len = v.getUint32(iovs + i * 8 + 4, true);
        if (fd === 2) stderr += new TextDecoder().decode(bytes().subarray(ptr, ptr + len));
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
    random_get: (ptr, len) => { crypto.getRandomValues(bytes().subarray(ptr!, ptr! + len!)); return ESUCCESS; },
    sched_yield: () => ESUCCESS,
    poll_oneoff: () => ENOSYS,
    proc_exit: (code) => { throw new Error(`The STEP reader stopped (exit ${code}).${stderr ? ` ${stderr.trim()}` : ''}`); },
  };
  return new Proxy(known, { get: (target, name: string) => target[name] ?? (() => ENOSYS) });
}

export async function instantiateStepReader(source: BufferSource | WebAssembly.Module): Promise<StepReaderModule> {
  // The imports need the memory the instance exports, so they read it through a holder filled in after instantiation.
  const holder: { memory?: WebAssembly.Memory } = {};
  const imports = { wasi_snapshot_preview1: wasiImports(() => holder.memory!) };
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const instance = await WebAssembly.instantiate(module, imports);
  const exports = instance.exports as unknown as StepReaderModule & { _initialize?: () => void };
  holder.memory = exports.memory;
  exports._initialize?.();
  return exports;
}

/** The reader's last error message. */
export function stepReaderError(m: StepReaderModule): string {
  const len = m.pf_error_len(), ptr = m.pf_error_ptr();
  return len && ptr ? new TextDecoder().decode(new Uint8Array(m.memory.buffer, ptr, len)) : (stderr.trim() || 'The STEP reader failed.');
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
