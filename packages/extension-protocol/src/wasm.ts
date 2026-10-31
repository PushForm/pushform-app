// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/**
 * The compute ABI between the host and an extension's WebAssembly modules, version 1, and a reader of the parts of
 * a module binary it constrains. A compute module:
 *
 * - imports its linear memory as `pf.memory`; the host creates that memory with the maximum the manifest declares,
 *   so the module can never grow past it;
 * - may import `pf.progress(fraction: f64)`, `pf.partial(ptr: i32, len: i32)` (the best result so far, in the same
 *   format as the final output) and `pf.should_stop() -> i32` (non-zero once the run should end early), and nothing
 *   else: no host functions, no other memory, table or global;
 * - exports `pf_abi_version() -> i32` returning 1, `pf_alloc(len: i32) -> i32` returning a pointer for the input,
 *   and `pf_run(ptr: i32, len: i32) -> i32`, which returns a pointer to the output: a little-endian u32 length
 *   followed by that many bytes.
 *
 * Input and output are bytes; the host offers JSON as UTF-8 on top of them.
 */

export const COMPUTE_ABI_VERSION = 1;
export const COMPUTE_IMPORTS: Readonly<Record<string, 'memory' | 'function'>> = {
  memory: 'memory', progress: 'function', partial: 'function', should_stop: 'function',
};
export const COMPUTE_EXPORTS = ['pf_abi_version', 'pf_alloc', 'pf_run'] as const;

export type WasmKind = 'function' | 'table' | 'memory' | 'global' | 'tag';
export interface WasmImport { module: string; name: string; kind: WasmKind; memory?: { min: number; max: number | null; shared: boolean } }
export interface WasmExport { name: string; kind: WasmKind }
export interface WasmModuleInfo { imports: WasmImport[]; exports: WasmExport[] }

const KINDS: WasmKind[] = ['function', 'table', 'memory', 'global', 'tag'];

/** Reads the import and export sections of a module binary. Throws on a malformed binary. */
export function inspectWasmModule(bytes: Uint8Array): WasmModuleInfo {
  if (bytes.byteLength < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d)
    throw new Error('not a WebAssembly module');
  if (bytes[4] !== 0x01 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) throw new Error('unsupported WebAssembly version');
  let at = 8;
  const byte = (): number => {
    if (at >= bytes.byteLength) throw new Error('truncated module');
    return bytes[at++]!;
  };
  const u32 = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = byte();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new Error('malformed integer');
    }
    return result;
  };
  const name = (): string => {
    const length = u32();
    if (at + length > bytes.byteLength) throw new Error('truncated name');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(at, at + length));
    at += length;
    return text;
  };
  const limits = (): { min: number; max: number | null; shared: boolean } => {
    const flags = byte();
    const min = u32();
    const max = flags & 0x01 ? u32() : null;
    return { min, max, shared: (flags & 0x02) !== 0 };
  };
  const skipValueType = () => { byte(); };

  const info: WasmModuleInfo = { imports: [], exports: [] };
  while (at < bytes.byteLength) {
    const id = byte();
    const size = u32();
    const end = at + size;
    if (end > bytes.byteLength) throw new Error('truncated section');
    if (id === 2) {
      for (let count = u32(); count > 0; count--) {
        const module = name();
        const field = name();
        const kindByte = byte();
        const kind = KINDS[kindByte];
        if (!kind) throw new Error('unknown import kind');
        const entry: WasmImport = { module, name: field, kind };
        if (kind === 'function') u32();
        else if (kind === 'table') { skipValueType(); limits(); }
        else if (kind === 'memory') entry.memory = limits();
        else if (kind === 'global') { skipValueType(); byte(); }
        else { byte(); u32(); }
        info.imports.push(entry);
      }
    } else if (id === 7) {
      for (let count = u32(); count > 0; count--) {
        const field = name();
        const kind = KINDS[byte()];
        if (!kind) throw new Error('unknown export kind');
        u32();
        info.exports.push({ name: field, kind });
      }
    }
    at = end;
  }
  return info;
}

/**
 * Problems that keep a module from following the compute ABI with the declared memory maximum, as readable
 * sentences; empty when it conforms.
 */
export function computeModuleProblems(bytes: Uint8Array, maxMemoryPages: number): string[] {
  let info: WasmModuleInfo;
  try {
    info = inspectWasmModule(bytes);
  } catch (error) {
    return [`it is not a valid WebAssembly module (${(error as Error).message})`];
  }
  const problems: string[] = [];
  const memory = info.imports.find((i) => i.module === 'pf' && i.name === 'memory');
  for (const entry of info.imports) {
    const expected = entry.module === 'pf' ? COMPUTE_IMPORTS[entry.name] : undefined;
    if (expected !== entry.kind) problems.push(`it imports ${entry.module}.${entry.name}, which the compute interface does not provide`);
  }
  if (!memory) problems.push('it must import its memory as pf.memory');
  else if (memory.memory) {
    if (memory.memory.shared) problems.push('its memory must not be shared');
    if (memory.memory.min > maxMemoryPages) problems.push(`it needs ${memory.memory.min} memory pages at start, more than the ${maxMemoryPages} declared`);
    if (memory.memory.max !== null && memory.memory.max < maxMemoryPages)
      problems.push(`its memory maximum (${memory.memory.max} pages) is below the ${maxMemoryPages} declared; declare at most ${memory.memory.max}`);
  }
  for (const required of COMPUTE_EXPORTS)
    if (!info.exports.some((e) => e.name === required && e.kind === 'function')) problems.push(`it does not export the function ${required}`);
  return problems;
}
