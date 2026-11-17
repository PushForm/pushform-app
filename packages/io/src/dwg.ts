// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { parseDxfHeader } from './dxf';
import { autocadRelease, readDxf } from './dxfModel';
import type { MeshImportOptions } from './meshImport';
import type { ImportFormat, ImportProgress, SketchUpImport } from './sketchup';
import { wasiImports } from './stepWasm';

// DWG import. The reader module (crates/dwg-reader) converts the drawing to DXF text on the device, and the DXF
// importers read that, so a DWG drawing imports by the same rules as the DXF drawing it would be saved as.

export const DWG_FORMAT: ImportFormat = { kind: 'dwg', name: 'DWG', notes: [
  'DWG import: the drawing is converted to DXF and imported as one. Lines, polylines, arcs, circles, ellipses, splines, 3D faces, 2D solids, polyface and polygon meshes, blocks and layers are imported. Text, dimensions, hatches, points, images, ACIS solids and paper space layouts are not.',
] };

export function isDwgFile(name: string): boolean { return /\.dwg$/i.test(name); }

/** A DWG file starts with its format version: `AC` and four more characters, such as `AC1027` (`AC1.50` in the oldest files). */
export function isDwgBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 6 || bytes[0] !== 0x41 || bytes[1] !== 0x43) return false;
  for (let i = 2; i < 6; i++) if (!(bytes[i]! >= 0x30 && bytes[i]! <= 0x39) && bytes[i] !== 0x2e) return false;
  return true;
}

/** The AutoCAD release that wrote the drawing, for the import report's source version. */
export function dwgVersion(code: string): string {
  const release = autocadRelease(code);
  return release ? `AutoCAD ${release} DWG (${code})` : code ? `DWG (${code})` : 'DWG';
}

interface DwgReaderModule {
  memory: WebAssembly.Memory;
  pf_alloc(len: number): number;
  pf_free(ptr: number, len: number): void;
  pf_dwg_convert(ptr: number, len: number): number;
  pf_dwg_release(): void;
  pf_dwg_dxf_ptr(): number; pf_dwg_dxf_len(): number;
  pf_dwg_info_ptr(): number; pf_dwg_info_len(): number;
  pf_error_ptr(): number; pf_error_len(): number;
}

let modulePromise: Promise<DwgReaderModule> | undefined;

async function instantiate(source: BufferSource | WebAssembly.Module): Promise<DwgReaderModule> {
  // The module makes only a few WASI calls (clock, random bytes, its panic message), served without a file system.
  const holder: { memory?: WebAssembly.Memory } = {};
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasiImports(() => holder.memory!) });
  const exports = instance.exports as unknown as DwgReaderModule & { _initialize?: () => void };
  holder.memory = exports.memory;
  exports._initialize?.();
  return exports;
}

/**
 * The reader module (`packages/io/wasm/pushform-dwg.wasm`, built by `pnpm build:dwg-reader`), loaded on the first DWG
 * read so that it downloads only then. Node reads the file beside the package; the browser and the desktop webview
 * fetch the URL Vite gives the bundled file.
 */
function loadDwgReader(): Promise<DwgReaderModule> {
  modulePromise ??= (async () => {
    if (typeof process !== 'undefined' && process.versions?.node) {
      const { readFile } = await import('node:fs/promises');
      // PF_DWG_WASM points tests at the module by path, where the test environment gives modules no file URL.
      const bytes = await readFile(process.env.PF_DWG_WASM ?? new URL('../wasm/pushform-dwg.wasm', import.meta.url)).catch(() => { throw new Error('The DWG reader is not built: run pnpm build:dwg-reader.'); });
      return instantiate(bytes);
    }
    const { default: wasmUrl } = await import('../wasm/pushform-dwg.wasm?url');
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`The DWG reader could not be downloaded (${response.status}).`);
    return instantiate(typeof WebAssembly.compileStreaming === 'function' ? await WebAssembly.compileStreaming(response) : await response.arrayBuffer());
  })();
  modulePromise.catch(() => { modulePromise = undefined; });
  return modulePromise;
}

export interface DwgConversion {
  /** The drawing as ASCII DXF text. */
  dxf: Uint8Array;
  /** The drawing's format version, such as `AC1027`. */
  version: string;
  /** Notes about content that could not be read. */
  notes: string[];
}

/** Convert a DWG drawing to DXF text on this device. */
export async function convertDwg(bytes: Uint8Array): Promise<DwgConversion> {
  if (!isDwgBytes(bytes)) throw new Error('This file is not a DWG drawing.');
  const m = await loadDwgReader();
  const copy = (ptr: number, len: number): Uint8Array => new Uint8Array(m.memory.buffer, ptr, len).slice();
  const text = (ptr: number, len: number): string => len ? new TextDecoder().decode(copy(ptr, len)) : '';
  let input = 0;
  try {
    input = m.pf_alloc(bytes.length);
    if (!input) throw new Error('This DWG drawing is too large to read here.');
    new Uint8Array(m.memory.buffer, input, bytes.length).set(bytes);
    if (!m.pf_dwg_convert(input, bytes.length)) throw new Error(text(m.pf_error_ptr(), m.pf_error_len()) || 'This DWG drawing could not be read.');
    const [version = '', ...notes] = text(m.pf_dwg_info_ptr(), m.pf_dwg_info_len()).split('\n');
    return { dxf: copy(m.pf_dwg_dxf_ptr(), m.pf_dwg_dxf_len()), version, notes };
  } catch (error) {
    // A trap (the reader ran out of memory or stopped on content it cannot read) leaves the module unusable.
    if (error instanceof WebAssembly.RuntimeError) { modulePromise = undefined; throw new Error('This DWG drawing could not be read.'); }
    throw error;
  } finally {
    if (modulePromise) { if (input) m.pf_free(input, bytes.length); m.pf_dwg_release(); }
  }
}

/**
 * Read a DWG drawing as a model. A drawing that records no units is read in `options.unit` when the caller chose
 * one, else in inches when it was started in imperial units and in millimeters otherwise, as AutoCAD treats it.
 */
export async function readDwg(bytes: Uint8Array, options?: MeshImportOptions, onProgress?: (p: ImportProgress) => void): Promise<SketchUpImport> {
  onProgress?.({ stage: 'Converting DWG drawing', current: 0, total: 1 });
  const converted = await convertDwg(bytes);
  const unit = options?.unit ?? (parseDxfHeader(converted.dxf).measurement === 'imperial' ? 'in' : 'mm');
  const scene = await readDxf(converted.dxf, { unit, up: 'z' }, onProgress, { format: DWG_FORMAT, version: dwgVersion(converted.version) });
  return converted.notes.length ? { ...scene, warnings: [...converted.notes, ...scene.warnings] } : scene;
}
