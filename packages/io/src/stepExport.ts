// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { m4determinant, m4mul, type Id, type MaterialId, type MMat4, type Vec3 } from '@pushform/core';
import { pathKey, sketchFaceLoops, tagVisible, type ComponentDefinition, type DocumentState } from '@pushform/model';
import { exportFileName, selectionScope, type ModelExportOptions } from './modelExport';
import type { ImportProgress } from './sketchup';
import { loadStepReader } from './stepModule';
import { stepReaderError } from './stepWasm';

// STEP export. The visible model, or its selection, becomes products (one per definition as it is placed) of parts
// (one per body, one for the sheet faces, one per mesh part) made of polygon faces over shared vertices. The STEP
// writer (crates/step-reader on SolidCraft's kernel) sews each part into a B-rep and writes the product structure,
// names and colors. Coordinates are meters; the file is in millimeters.

export const STEP_EXTENSION = '.step';

interface StepFace { loops: number[][]; /** sRGB and opacity of a face's own color. */ color: [number, number, number, number] | null }
export interface StepPart { name: string; color: [number, number, number] | null; opacity: number; vertices: number[]; faces: StepFace[] }
interface StepChild { product: number; matrix: MMat4; name: string }
export interface StepProduct { name: string; parts: StepPart[]; children: StepChild[] }
export interface StepScene { name: string; products: StepProduct[]; root: number; notes: string[]; parts: number }

/** Whether a placement is a rotation and a translation, which STEP's item-defined transformation can state. */
function isRigid(m: MMat4): boolean {
  const column = (c: number): Vec3 => [m[c * 4]!, m[c * 4 + 1]!, m[c * 4 + 2]!];
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const [x, y, z] = [column(0), column(1), column(2)];
  return Math.abs(dot(x, x) - 1) < 1e-6 && Math.abs(dot(y, y) - 1) < 1e-6 && Math.abs(dot(z, z) - 1) < 1e-6
    && Math.abs(dot(x, y)) < 1e-6 && Math.abs(dot(x, z)) < 1e-6 && Math.abs(dot(y, z)) < 1e-6 && m4determinant(m) > 0
    && Math.abs(m[3]!) + Math.abs(m[7]!) + Math.abs(m[11]!) < 1e-9;
}

function transformed(part: StepPart, m: MMat4): StepPart {
  const vertices: number[] = [];
  for (let i = 0; i < part.vertices.length; i += 3) {
    const x = part.vertices[i]!, y = part.vertices[i + 1]!, z = part.vertices[i + 2]!;
    vertices.push(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
  }
  // A mirror turns the faces inside out: run every loop the other way.
  const flip = m4determinant(m) < 0;
  return { ...part, vertices, faces: part.faces.map(f => flip ? { ...f, loops: f.loops.map(l => [...l].reverse()) } : f) };
}

/** A product with its children's parts moved into it, for a placement that is scaled or mirrored. */
function flattened(products: readonly StepProduct[], index: number, m: MMat4): StepPart[] {
  const product = products[index]!;
  return [...product.parts.map(p => transformed(p, m)), ...product.children.flatMap(c => flattened(products, c.product, m4mul(m, c.matrix)))];
}

const rgb = (color: readonly number[]): [number, number, number] => [color[0]!, color[1]!, color[2]!];

/**
 * Collect the visible model, or the selected part of it, for STEP export. Hidden entities and those on hidden tags
 * are left out, as in the other exports; a solid keeps all its faces. Mesh parts are written as faceted solids, and
 * the notes say which.
 */
export function collectStepScene(state: DocumentState, options: ModelExportOptions = {}): StepScene {
  const selected = options.selection ? selectionScope(options.selection) : null;
  const name = (options.name ?? 'Model').replace(/\.pf$/i, '').trim() || 'Model';
  const products: StepProduct[] = [], productKeys = new Map<string, number | null>();
  const notes: string[] = [], skipped = new Set<string>(), meshParts: string[] = [];
  let curved = false, dropped = 0, partCount = 0;

  const looks = (id: MaterialId | null): { color: [number, number, number]; alpha: number } | null => {
    const material = id === null ? undefined : state.materials.get(id);
    return material ? { color: rgb(material.color), alpha: material.alpha } : null;
  };
  /** Builds a part's vertices (shared by position) and faces. */
  const builder = (partName: string, material: MaterialId | null) => {
    const own = looks(material), vertices: number[] = [], index = new Map<string, number>(), faces: StepFace[] = [];
    const vertex = (p: ArrayLike<number>): number => {
      const key = `${p[0]!.toFixed(9)},${p[1]!.toFixed(9)},${p[2]!.toFixed(9)}`;
      let at = index.get(key);
      if (at === undefined) { at = vertices.length / 3; index.set(key, at); vertices.push(p[0]!, p[1]!, p[2]!); }
      return at;
    };
    const add = (loops: readonly (readonly ArrayLike<number>[])[], faceMaterial: MaterialId | null): void => {
      const cleaned = loops.map(loop => {
        const ids = loop.map(vertex).filter((v, k, all) => v !== all[(k + all.length - 1) % all.length]);
        return ids.length >= 3 ? ids : [];
      });
      if (!cleaned[0]?.length) { dropped++; return; }
      const look = faceMaterial === null ? null : looks(faceMaterial);
      const differs = look && (!own || look.color.some((c, k) => c !== own.color[k]) || look.alpha !== own.alpha);
      faces.push({ loops: cleaned.filter(l => l.length), color: differs ? [...look.color, look.alpha] as StepFace['color'] : null });
    };
    const finish = (): StepPart | null => faces.length ? { name: partName, color: own?.color ?? null, opacity: own?.alpha ?? 1, vertices, faces } : null;
    return { add, finish };
  };

  const buildProduct = (definition: ComponentDefinition, path: readonly number[], inherited: MaterialId | null, whole: boolean): StepPart[] => {
    const entities = definition.entities, key = pathKey(path as Id[]), parts: StepPart[] = [];
    for (const body of entities.bodies.values()) {
      if (body.hidden || !tagVisible(state, body.tagId)) continue;
      const wholeBody = whole || !!selected?.bodies.has(`${key}|${body.id}`);
      const faces = wholeBody ? null : selected?.faces.get(`${key}|${body.id}`);
      if (!wholeBody && !faces) continue;
      const b = builder(`Body ${body.id}`, body.materialId ?? inherited);
      for (const face of body.faces.values()) {
        if (faces && !faces.has(face.id)) continue;
        if (face.surfaceId !== null) curved = true;
        b.add(face.loops, face.frontMaterialId);
      }
      const part = b.finish();
      if (part) parts.push(part);
    }
    const sheets = builder('Faces', null);
    for (const face of entities.sketch.faces.values()) {
      if (face.hidden || !tagVisible(state, face.tagId)) continue;
      if (!whole && !selected?.sketchFaces.has(`${key}|${face.id}`)) continue;
      sheets.add(sketchFaceLoops(entities.sketch, face), face.frontMaterialId ?? inherited);
    }
    const sheet = sheets.finish();
    if (sheet) parts.push(sheet);
    for (const meshPart of entities.meshParts.values()) {
      if (meshPart.hidden || !tagVisible(state, meshPart.tagId)) continue;
      if (!whole && !selected?.meshParts.has(`${key}|${meshPart.id}`)) continue;
      const g = meshPart.geometry, b = builder(meshPart.name || `Part ${meshPart.id}`, meshPart.materialId ?? inherited);
      for (let t = 0; t + 2 < g.triangles.length; t += 3) {
        const corner = (k: number): number[] => [g.positions[g.triangles[t + k]! * 3]!, g.positions[g.triangles[t + k]! * 3 + 1]!, g.positions[g.triangles[t + k]! * 3 + 2]!];
        const faceMaterial = g.faceMaterials[g.triangleFace[t / 3]!] ?? 0;
        b.add([[corner(0), corner(1), corner(2)]], faceMaterial ? faceMaterial as MaterialId : null);
      }
      const part = b.finish();
      if (part) { parts.push(part); meshParts.push(`${part.name} (${(g.triangles.length / 3).toLocaleString('en-US')} triangles)`); }
    }
    if (entities.guides.size) skipped.add('guides');
    if (entities.dimensions.size) skipped.add('dimensions');
    if (entities.texts.size) skipped.add('text');
    if (entities.sectionPlanes.size) skipped.add('section planes');
    if (entities.sketch.edges.size && !entities.sketch.faces.size && !entities.bodies.size) skipped.add('loose edges');
    return parts;
  };

  const visit = (definition: ComponentDefinition, path: number[], inherited: MaterialId | null, whole: boolean, seen: Set<number>, productName: string): StepProduct => {
    const children: StepChild[] = [];
    for (const instance of definition.entities.instances.values()) {
      const child = state.definitions.get(instance.definitionId);
      if (!child || seen.has(child.id) || instance.hidden || !tagVisible(state, instance.tagId)) continue;
      const childPath = [...path, instance.id], key = pathKey(childPath as Id[]);
      const childWhole = whole || !!selected?.instances.has(key);
      if (!childWhole && !selected?.within.has(key)) continue;
      const material = instance.materialId ?? inherited;
      // Whole contents are the same at every placement with the same inherited material; a partly selected one is its own.
      const productKey = childWhole ? `${child.id}|${material ?? ''}` : `path:${key}`;
      let at = productKeys.get(productKey);
      if (at === undefined) {
        const product = visit(child, childPath, material, childWhole, new Set([...seen, child.id]), child.name || 'Component');
        at = product.parts.length || product.children.length ? products.push(product) - 1 : null;
        productKeys.set(productKey, at);
      }
      if (at !== null) children.push({ product: at, matrix: [...(instance.transform as ArrayLike<number> as number[])] as MMat4, name: instance.name || child.name });
    }
    return { name: productName, parts: buildProduct(definition, path, inherited, whole), children };
  };

  const rootDefinition = state.definitions.get(state.rootDefinitionId);
  if (!rootDefinition) throw new Error('The model has no root definition.');
  const top = visit(rootDefinition, [], null, selected === null, new Set([rootDefinition.id]), name);

  // A placement that is scaled or mirrored cannot be stated in STEP: the part is written already moved.
  for (const product of [top, ...products]) {
    const kept: StepChild[] = [];
    for (const child of product.children) {
      if (isRigid(child.matrix)) kept.push(child);
      else for (const part of flattened(products, child.product, child.matrix)) product.parts.push({ ...part, name: part.name });
    }
    product.children = kept;
  }
  products.push(top);
  partCount = products.reduce((sum, p) => sum + p.parts.length, 0);
  if (!partCount) throw new Error(selected ? 'The selection has no visible faces to export.' : 'The model has no visible faces to export.');

  if (curved) notes.push('Curved surfaces are exported as flat facets.');
  if (meshParts.length) notes.push(`Mesh parts are exported as faceted solids: ${meshParts.slice(0, 5).join(', ')}${meshParts.length > 5 ? `, and ${meshParts.length - 5} more` : ''}.`);
  if (dropped) notes.push(`${dropped} face${dropped === 1 ? ' has' : 's have'} no area and ${dropped === 1 ? 'is' : 'are'} not exported.`);
  if (skipped.size) {
    const list = [...skipped], named = list.length === 1 ? list[0]! : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
    notes.push(`${named[0]!.toUpperCase()}${named.slice(1)} ${list.length === 1 && !named.endsWith('s') ? 'is' : 'are'} not exported.`);
  }
  return { name, products, root: products.length - 1, notes, parts: partCount };
}

/** The request the STEP writer takes (`crates/step-reader/src/export.rs`). */
export function encodeStepRequest(scene: StepScene, header: { fileName: string; timeStamp?: string; description?: string }): Uint8Array {
  const chunks: Uint8Array[] = [], text = new TextEncoder();
  let scratch = new DataView(new ArrayBuffer(8));
  const push = (bytes: Uint8Array): void => { chunks.push(bytes); };
  const u8 = (v: number): void => push(Uint8Array.of(v));
  const u32 = (v: number): void => { scratch = new DataView(new ArrayBuffer(4)); scratch.setUint32(0, v, true); push(new Uint8Array(scratch.buffer)); };
  const f32 = (v: number): void => { scratch = new DataView(new ArrayBuffer(4)); scratch.setFloat32(0, v, true); push(new Uint8Array(scratch.buffer)); };
  const str = (s: string): void => { const b = text.encode(s); u32(b.length); push(b); };
  const colour = (c: readonly number[]): void => { for (const v of c) f32(v); };
  push(text.encode('PFSTEPX1'));
  [header.fileName, header.timeStamp ?? '', '', '', header.description ?? 'PushForm model'].forEach(str);
  u32(scene.root);
  u32(scene.products.length);
  for (const product of scene.products) {
    str(product.name);
    u32(product.parts.length);
    for (const part of product.parts) {
      str(part.name);
      if (part.color) { u8(1); colour(part.color); } else { u8(0); }
      f32(part.opacity);
      u32(part.vertices.length / 3);
      push(new Uint8Array(Float64Array.from(part.vertices).buffer));
      u32(part.faces.length);
      for (const face of part.faces) {
        if (face.color) { u8(1); colour(face.color); } else u8(0);
        u32(face.loops.length);
        for (const loop of face.loops) { u32(loop.length); push(new Uint8Array(Uint32Array.from(loop).buffer)); }
      }
    }
    u32(product.children.length);
    for (const child of product.children) { u32(child.product); push(new Uint8Array(Float64Array.from(child.matrix).buffer)); str(child.name); }
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * A host that writes STEP outside the wasm module (the desktop app, natively on every core): it takes the request,
 * reports progress, and answers the file's text as bytes. It stops when the signal aborts.
 */
export type NativeStepWriter = (request: Uint8Array, onProgress?: (p: ImportProgress) => void, signal?: AbortSignal) => Promise<Uint8Array>;
let nativeStepWriter: NativeStepWriter | null = null;
export function setNativeStepWriter(writer: NativeStepWriter | null): void { nativeStepWriter = writer; }
export function hasNativeStepWriter(): boolean { return nativeStepWriter !== null; }

/** Write the file with the wasm module, on this thread. */
export async function writeStepWithModule(request: Uint8Array): Promise<Uint8Array> {
  const m = await loadStepReader({ threads: false });
  const ptr = m.pf_alloc(request.byteLength);
  new Uint8Array(m.memory.buffer, ptr, request.byteLength).set(request);
  const len = m.pf_step_export(ptr, request.byteLength);
  m.pf_free(ptr, request.byteLength);
  if (!len) throw new Error(`The model could not be written as STEP: ${stepReaderError(m)}`);
  return new Uint8Array(m.memory.buffer, m.pf_step_export_ptr(), len).slice();
}

type WriterMessage = { type: 'result'; bytes: Uint8Array } | { type: 'error'; message: string };

/** Write the file in a disposable worker, so cancelling stops it; inline where there are no workers (Node, tests). */
export function writeStepInWorker(request: Uint8Array, options: { signal?: AbortSignal | undefined; onProgress?: ((p: ImportProgress) => void) | undefined } = {}): Promise<Uint8Array> {
  const cancelled = (): DOMException => new DOMException('Export cancelled.', 'AbortError');
  if (options.signal?.aborted) return Promise.reject(cancelled());
  options.onProgress?.({ stage: 'Writing STEP', current: 0, total: 1 });
  if (nativeStepWriter) return nativeStepWriter(request, options.onProgress, options.signal);
  if (typeof Worker === 'undefined') return writeStepWithModule(request);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./stepExportWorker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const cleanup = (): void => { settled = true; worker.terminate(); options.signal?.removeEventListener('abort', abort); };
    const abort = (): void => { if (!settled) { cleanup(); reject(cancelled()); } };
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<WriterMessage>) => {
      if (settled) return;
      cleanup();
      if (event.data.type === 'result') resolve(event.data.bytes); else reject(new Error(event.data.message));
    };
    worker.onerror = event => { if (!settled) { cleanup(); reject(new Error(event.message || 'The STEP export worker failed.')); } };
    const copy = new Uint8Array(request);
    try { worker.postMessage({ request: copy }, [copy.buffer]); } catch (cause) { cleanup(); reject(cause); }
  });
}

export interface StepExportResult { bytes: Uint8Array; fileName: string; parts: number; notes: string[] }
export interface StepExportOptions extends ModelExportOptions { signal?: AbortSignal | undefined; onProgress?: ((p: ImportProgress) => void) | undefined; now?: Date | undefined }

/** Write the visible model, or its selection, as a `.step` file. */
export async function exportStep(state: DocumentState, options: StepExportOptions = {}): Promise<StepExportResult> {
  const scene = collectStepScene(state, options), fileName = exportFileName(scene.name, STEP_EXTENSION);
  const request = encodeStepRequest(scene, { fileName, timeStamp: (options.now ?? new Date()).toISOString().slice(0, 19) });
  const bytes = await writeStepInWorker(request, options);
  return { bytes, fileName, parts: scene.parts, notes: scene.notes };
}
