// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { type Vec3 } from '@pushform/core';
import type { Definition, Instance, Material } from 'openskp';
import { IDENTITY_PLACEMENT, INCH, finishMeshImport, meshDefinition, meshMaterial, type MeshPlacement } from './meshImport';
import { MAX_SKETCHUP_BYTES, type ImportFormat, type ImportProgress, type ImportedMeshPart, type SketchUpImport } from './sketchup';
import { loadStepReader } from './stepModule';
import { decodeStepResult, stepReaderError, type StepReaderResult } from './stepWasm';

// STEP (ISO 10303-21) import. The reader module (crates/step-reader) parses the file, converts its solids one at a
// time and meshes each distinct part once; the parts and their placements are rebuilt as the reader model the .skp
// importer converts, so solids and sheets follow its rules, or as mesh parts when the file is large.

export const STEP_FORMAT: ImportFormat = { kind: 'step', name: 'STEP', notes: [
  'STEP import: solids and surfaces are imported with the assembly structure, part names, colors and edges; a part placed many times becomes one component; curved surfaces are divided into smoothed facets. Product data, tolerances and annotations (PMI) are not imported.',
] };

/**
 * The largest STEP file the desktop app reads; the browser keeps the limit every import shares. The reader holds the
 * file's text and its parsed entities together, and its wasm memory ends at 4 GiB.
 */
export const MAX_DESKTOP_STEP_BYTES = 256 * 1024 * 1024;

/** The reader's meshing (crates/step-reader mode bits): the display mesh, whose faces share their boundary points, welded at the merge tolerance, with flat faces re-triangulated from their outlines. */
const DISPLAY_MODE = 1 | 2 | 4;

export function isStepModelFile(name: string): boolean { return /\.(step|stp)$/i.test(name); }

/** A STEP physical file: `ISO-10303-21;` after an optional byte order mark and white space. */
export function isStepBytes(bytes: Uint8Array): boolean {
  return /^\uFEFF?\s*ISO-10303-21\s*;/.test(new TextDecoder().decode(bytes.subarray(0, 256)));
}

const SCHEMAS: readonly [RegExp, string][] = [
  [/^AP242_/i, 'AP242'], [/^AP203_CONFIGURATION/i, 'AP203 edition 2'], [/^CONFIG_CONTROL_DESIGN/i, 'AP203'],
  [/^AUTOMOTIVE_DESIGN/i, 'AP214'], [/^AP214/i, 'AP214'],
];

/** The application protocol the header's FILE_SCHEMA names, and the originating system its FILE_NAME records. */
export function stepHeader(bytes: Uint8Array): { schema: string | null; system: string | null } {
  const head = new TextDecoder().decode(bytes.subarray(0, 64 * 1024));
  const header = /HEADER\s*;([\s\S]*?)ENDSEC\s*;/i.exec(head)?.[1] ?? '';
  const schemaName = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/i.exec(header)?.[1]?.trim() ?? '';
  const schema = schemaName ? SCHEMAS.find(([pattern]) => pattern.test(schemaName))?.[1] ?? schemaName.split(/\s/)[0]! : null;
  // FILE_NAME(name, time stamp, (authors), (organizations), preprocessor, originating system, authorization).
  const fileName = /FILE_NAME\s*\(([\s\S]*?)\)\s*;/i.exec(header)?.[1] ?? '';
  const fields = [...fileName.matchAll(/'((?:[^']|'')*)'|\([^)]*\)|\$/g)].map(m => m[1]?.replace(/''/g, "'") ?? '');
  const system = fields[5]?.trim() || fields[4]?.trim() || null;
  return { schema, system };
}

/**
 * A host that converts STEP files outside the wasm module (the desktop app, natively on every core). It takes the
 * file's bytes and the reader's mode and threshold, reports progress, and answers the reader's result buffer.
 */
export type NativeStepReader = (bytes: Uint8Array, mode: number, threshold: number, onProgress?: (p: ImportProgress) => void) => Promise<Uint8Array>;
let nativeStepReader: NativeStepReader | null = null;
export function setNativeStepReader(reader: NativeStepReader | null): void { nativeStepReader = reader; }
export function hasNativeStepReader(): boolean { return nativeStepReader !== null; }

/** Run the reader module over the file: parse, convert solid by solid with progress, and decode the result. */
async function readWithModule(bytes: Uint8Array, mode: number, threshold: number, onProgress?: (p: ImportProgress) => void): Promise<StepReaderResult> {
  const m = await loadStepReader();
  const ptr = m.pf_alloc(bytes.byteLength);
  new Uint8Array(m.memory.buffer, ptr, bytes.byteLength).set(bytes);
  // The reader's memory only grows, so its size says how far a large file is pushing the 4 GiB wasm limit.
  const memory = (): string => `${Math.round(m.memory.buffer.byteLength / 1048576).toLocaleString('en-US')} MB`;
  onProgress?.({ stage: 'Reading STEP model', current: 0, total: 1, detail: memory() });
  const handle = m.pf_step_open(ptr, bytes.byteLength, mode, Math.min(threshold, 0xffff_ffff));
  m.pf_free(ptr, bytes.byteLength);
  if (!handle) throw new Error(`This STEP file could not be read: ${stepReaderError(m)}`);
  try {
    let reported = -1;
    while (m.pf_step_step(handle)) {
      const packed = m.pf_step_progress(handle), done = Number(packed >> 32n), total = Number(packed & 0xffff_ffffn);
      if (done !== reported) { reported = done; onProgress?.({ stage: 'Converting parts', current: done, total, detail: memory() }); }
    }
    if (!m.pf_step_finish(handle)) throw new Error(`This STEP file could not be read: ${stepReaderError(m)}`);
    // Each distinct part is meshed once; a repeated placement passes in no time, so the count moves by bodies.
    reported = -1;
    const report = (): void => {
      const packed = m.pf_step_mesh_progress(handle), done = Number(packed >> 32n), total = Number(packed & 0xffff_ffffn);
      if (done !== reported) { reported = done; onProgress?.({ stage: 'Meshing parts', current: done, total, detail: memory() }); }
    };
    if (m.threads && m.pf_step_mesh_start(handle, m.threads.count)) {
      // The threads mesh while this thread only watches; a worker that stopped fails the read, since its part never finishes.
      report();
      while (!m.pf_step_mesh_done(handle)) {
        if (m.threads.failure) throw new Error(`The STEP reader stopped: ${m.threads.failure}`);
        await new Promise(resolve => setTimeout(resolve, 100));
        report();
      }
    } else {
      do report(); while (m.pf_step_mesh(handle));
    }
    { const packed = m.pf_step_mesh_progress(handle), total = Number(packed & 0xffff_ffffn); onProgress?.({ stage: 'Meshing parts', current: total, total, detail: memory() }); }
    const len = m.pf_step_result(handle);
    if (!len) throw new Error(`This STEP file could not be read: ${stepReaderError(m)}`);
    // The result is decoded in place, except from the threaded build's shared memory, whose views browsers will not decode text from.
    const result = new Uint8Array(m.memory.buffer, m.pf_step_result_ptr(handle), len);
    return decodeStepResult(typeof SharedArrayBuffer !== 'undefined' && m.memory.buffer instanceof SharedArrayBuffer ? result.slice() : result);
  } finally { m.pf_step_close(handle); }
}

/**
 * Read a STEP file of at most `maxBytes` (the shared import limit unless the desktop app allows more). A STEP file
 * always imports as mesh parts, made editable on demand.
 */
export async function readStep(bytes: Uint8Array, onProgress?: (p: ImportProgress) => void, maxBytes = MAX_SKETCHUP_BYTES): Promise<SketchUpImport> {
  if (bytes.byteLength > maxBytes) throw new Error(`STEP files larger than ${maxBytes / (1024 * 1024)} MiB are not supported yet.`);
  if (!isStepBytes(bytes)) throw new Error('Not a STEP model: the file does not begin with ISO-10303-21.');
  onProgress?.({ stage: 'Loading the STEP reader', current: 0, total: 1 });
  // PF_STEP_MODE lets tests compare the reader's meshing modes.
  const mode = typeof process !== 'undefined' && process.env?.PF_STEP_MODE ? Number(process.env.PF_STEP_MODE) : DISPLAY_MODE;
  const result = nativeStepReader ? decodeStepResult(await nativeStepReader(bytes, mode, 0, onProgress)) : await readWithModule(bytes, mode, 0, onProgress);
  const warnings = new Set<string>(result.warnings.map(w => `STEP: ${w}`));
  const header = stepHeader(bytes), system = result.system || header.system || '';
  const materials: Material[] = [], materialKeys = new Map<string, number>();
  const materialKey = (color: readonly number[] | null): number | null => {
    if (!color) return null;
    const srgb: Vec3 = [color[0]!, color[1]!, color[2]!];
    const hex = srgb.map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
    let key = materialKeys.get(hex);
    if (key === undefined) { key = materials.length; materialKeys.set(hex, key); materials.push(meshMaterial(key, `Color ${hex}`, srgb, 1, null)); }
    return key;
  };

  // The reader model: one definition per distinct part, placed by every placement, inside groups for the assemblies
  // named by the placements' paths. A file of one part at the origin is that part itself.
  const root = meshDefinition(-1, '', false), definitions = new Map<number, Definition>(), meshParts = new Map<number, ImportedMeshPart[]>();
  const placements = new Map<number, Map<number, MeshPlacement>>();
  let nextKey = 0;
  // Parts that share a name are numbered in file order, so two unnamed solids of one product stay apart.
  const baseNames = result.parts.map((part, index) => part.name || result.placements.find(p => p.part === index)?.name || 'Part');
  const nameCounts = new Map<string, number>();
  for (const name of baseNames) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  const seen = new Map<string, number>(), names = baseNames.map(name => {
    if (nameCounts.get(name)! < 2) return name;
    const n = (seen.get(name) ?? 0) + 1; seen.set(name, n); return `${name} ${n}`;
  });
  const partName = (index: number): string => names[index]!;
  const fill = (def: Definition, index: number): void => {
    const part = result.parts[index]!;
    meshParts.set(def.id, [...meshParts.get(def.id) ?? [], { name: partName(index), source: { format: 'STEP', system },
      geometry: part.geometry, faceMaterialKeys: new Int32Array(part.geometry.faceCount).fill(-1), material: materialKey(part.color) }]);
  };
  const isIdentity = (m: readonly number[]): boolean => m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-12);
  const only = result.placements.length === 1 && result.parts.length === 1 && isIdentity(result.placements[0]!.matrix);
  if (only) fill(root, 0);
  else {
    const partDefs = new Map<number, number>();
    const partDef = (index: number): number => {
      let key = partDefs.get(index);
      if (key === undefined) { key = nextKey++; const def = meshDefinition(key, partName(index), false); definitions.set(key, def); fill(def, index); partDefs.set(index, key); }
      return key;
    };
    // Assembly groups by path prefix; the one assembly every placement shares at the top is the model itself.
    const common = result.placements.length > 1 && result.placements.every(p => p.path.length > 1 && p.path[0] === result.placements[0]!.path[0]) ? 1 : 0;
    const groups = new Map<string, Definition>([['', root]]);
    const groupFor = (path: readonly string[]): Definition => {
      const key = path.join('\u0000');
      let def = groups.get(key);
      if (!def) {
        const parent = groupFor(path.slice(0, -1)), id = nextKey++;
        def = meshDefinition(id, path.at(-1) || 'Assembly', true); definitions.set(id, def); groups.set(key, def);
        parent.instances.push({ name: def.name, refIdx: id, guid: '', matrix: [...IDENTITY_PLACEMENT], materialId: null, hidden: false, layer: '', properties: {} });
      }
      return def;
    };
    for (const placement of result.placements) {
      const parent = groupFor(placement.path.slice(common, Math.max(common, placement.path.length - 1)));
      const matrix = [...placement.matrix];
      matrix[12] = matrix[12]! / INCH; matrix[13] = matrix[13]! / INCH; matrix[14] = matrix[14]! / INCH;
      const instance: Instance = { name: placement.instance || partName(placement.part), refIdx: partDef(placement.part), guid: '', matrix, materialId: null, hidden: false, layer: '', properties: {} };
      parent.instances.push(instance);
    }
  }
  const version = [header.schema ?? result.schema, system].filter(Boolean).join(', ') || 'STEP';
  const model = { version, definitions, root, layers: [], pages: [], scenesUnread: 0, dimensions: [], materials,
    materialsById: new Map(materials.map(m => [m.id!, m])), styles: [], units: null, unitsOptions: null, sectionDisplay: null, renderingOptions: null };
  return finishMeshImport(model, placements, STEP_FORMAT, warnings, onProgress, { meshParts, allowEmpty: true });
}
