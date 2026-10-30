// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec2, Vec3 } from '@pushform/core';
import type { Material } from 'openskp';
import {
  archiveFile, finishMeshImport, groupedMeshModel, meshCountNotes, meshMaterial, meshPointConverter,
  type ArchiveResources, type MeshCounts, type MeshExtent, type MeshGeometry, type MeshImportOptions,
} from './meshImport';
import { MAX_SKETCHUP_BYTES, type ImportFormat, type ImportProgress, type SketchUpImport } from './sketchup';

// 3D Studio (.3ds) import: the meshes and materials of the editor chunk, through the shared mesh
// conversion. 3DS stores every mesh in world coordinates with Z up, so objects become groups at the origin.

export const THREE_DS_FORMAT: ImportFormat = { kind: '3ds', name: '3DS', notes: [
  '3DS import: meshes, smoothing groups and materials are imported, with textures from a .zip archive that holds them. Keyframe animation, object pivots, cameras and lights are not imported.',
] };

export function is3dsModelFile(name: string): boolean { return /\.3ds$/i.test(name); }
/** Whether the bytes begin with a 3DS main chunk whose length fits the file. */
export function is3dsBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 6 || bytes[0] !== 0x4d || bytes[1] !== 0x4d) return false;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2, true);
  return length >= 6 && length <= bytes.length;
}

const MAIN = 0x4d4d, EDITOR = 0x3d3d, OBJECT = 0x4000, TRIMESH = 0x4100, VERTICES = 0x4110, FACES = 0x4120, FACE_MATERIAL = 0x4130,
  TEXCOORDS = 0x4140, SMOOTHING = 0x4150, MATERIAL = 0xafff, MATERIAL_NAME = 0xa000, DIFFUSE = 0xa020, TRANSPARENCY = 0xa050,
  TEXTURE = 0xa200, MAP_NAME = 0xa300, MAP_USCALE = 0xa354, MAP_VSCALE = 0xa356, MAP_UOFFSET = 0xa358, MAP_VOFFSET = 0xa35a,
  COLOR_FLOAT = 0x0010, COLOR_BYTES = 0x0011, LINEAR_BYTES = 0x0012, LINEAR_FLOAT = 0x0013, PERCENT_INT = 0x0030, PERCENT_FLOAT = 0x0031,
  CAMERA = 0x4700, LIGHT = 0x4600, KEYFRAMER = 0xb000;

/** A chunk: its id, where its body starts after the 6-byte header, and where it ends. */
interface Chunk { id: number; body: number; end: number }

/** The chunks between two offsets; a truncated or overlong chunk ends the list. */
function chunks(view: DataView, start: number, end: number): Chunk[] {
  const out: Chunk[] = [];
  for (let at = start; at + 6 <= end;) {
    const id = view.getUint16(at, true), length = view.getUint32(at + 2, true);
    if (length < 6 || at + length > end) break;
    out.push({ id, body: at + 6, end: at + length });
    at += length;
  }
  return out;
}

/** A zero-terminated string (3DS names are single-byte text) and the offset after it. */
function cString(bytes: Uint8Array, at: number, end: number): [string, number] {
  let stop = at;
  while (stop < end && bytes[stop] !== 0) stop++;
  return [String.fromCharCode(...bytes.subarray(at, stop)), Math.min(stop + 1, end)];
}

/** The extent of the file's mesh vertices in its own units. */
export function threeDsExtent(bytes: Uint8Array): MeshExtent | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const walk = (start: number, end: number): void => {
    for (const chunk of chunks(view, start, end)) {
      if (chunk.id === MAIN || chunk.id === EDITOR || chunk.id === TRIMESH) walk(chunk.body, chunk.end);
      else if (chunk.id === OBJECT) walk(cString(bytes, chunk.body, chunk.end)[1], chunk.end);
      else if (chunk.id === VERTICES) {
        const n = view.getUint16(chunk.body, true);
        for (let i = 0; i < n && chunk.body + 2 + i * 12 + 12 <= chunk.end; i++) for (let k = 0; k < 3; k++) {
          const x = view.getFloat32(chunk.body + 2 + i * 12 + k * 4, true);
          if (Number.isFinite(x)) { min[k] = Math.min(min[k]!, x); max[k] = Math.max(max[k]!, x); }
        }
      }
    }
  };
  walk(0, bytes.length);
  return min.every(Number.isFinite) ? { min, max } : null;
}

interface ThreeDsMaterial { color: Vec3; opacity: number; map: string | null; scale: Vec2; offset: Vec2 }

/** Read a 3DS model in the given unit; `resources` are the archive's files, where textures are found. */
export async function read3ds(bytes: Uint8Array, options: MeshImportOptions, onProgress?: (p: ImportProgress) => void,
  resources?: ArchiveResources): Promise<SketchUpImport> {
  if (bytes.byteLength > MAX_SKETCHUP_BYTES) throw new Error('3DS files larger than 128 MiB are not supported yet.');
  if (!is3dsBytes(bytes)) throw new Error('Not a 3DS model: invalid file header.');
  onProgress?.({ stage: 'Reading 3DS model', current: 0, total: 1 });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const warnings = new Set<string>(), warn = (message: string): void => { warnings.add(message); };
  // 3DS is always Z up; only its unit is a choice.
  const convert = meshPointConverter({ unit: options.unit, up: 'z' });
  const counts: MeshCounts = { degenerate: 0, nonplanar: 0, duplicates: 0, turned: 0 };
  let cameras = 0, lights = 0, malformed = 0;

  const color = (chunk: Chunk): Vec3 | null => {
    const parts = chunks(view, chunk.body, chunk.end);
    const pick = parts.find(p => p.id === COLOR_BYTES) ?? parts.find(p => p.id === COLOR_FLOAT) ?? parts.find(p => p.id === LINEAR_BYTES) ?? parts.find(p => p.id === LINEAR_FLOAT);
    if (!pick || pick.end - pick.body < 3) return null;
    return pick.id === COLOR_BYTES || pick.id === LINEAR_BYTES
      ? [bytes[pick.body]! / 255, bytes[pick.body + 1]! / 255, bytes[pick.body + 2]! / 255]
      : pick.end - pick.body >= 12 ? [view.getFloat32(pick.body, true), view.getFloat32(pick.body + 4, true), view.getFloat32(pick.body + 8, true)] : null;
  };
  const percent = (chunk: Chunk): number | null => {
    const part = chunks(view, chunk.body, chunk.end).find(p => p.id === PERCENT_INT || p.id === PERCENT_FLOAT);
    if (!part) return null;
    return part.id === PERCENT_INT ? view.getUint16(part.body, true) / 100 : view.getFloat32(part.body, true) / 100;
  };
  const float = (chunk: Chunk | undefined, fallback: number): number => {
    if (!chunk || chunk.end - chunk.body < 4) return fallback;
    const value = view.getFloat32(chunk.body, true);
    return Number.isFinite(value) ? value : fallback;
  };

  const sources = new Map<string, ThreeDsMaterial>();
  const readMaterial = (chunk: Chunk): void => {
    const material: ThreeDsMaterial = { color: [0.8, 0.8, 0.8], opacity: 1, map: null, scale: [1, 1], offset: [0, 0] };
    let name = '';
    for (const part of chunks(view, chunk.body, chunk.end)) {
      if (part.id === MATERIAL_NAME) name = cString(bytes, part.body, part.end)[0];
      else if (part.id === DIFFUSE) material.color = color(part) ?? material.color;
      else if (part.id === TRANSPARENCY) material.opacity = 1 - (percent(part) ?? 0);
      else if (part.id === TEXTURE) {
        const map = chunks(view, part.body, part.end), find = (id: number): Chunk | undefined => map.find(c => c.id === id);
        const mapName = find(MAP_NAME);
        if (mapName) material.map = cString(bytes, mapName.body, mapName.end)[0] || null;
        material.scale = [float(find(MAP_USCALE), 1), float(find(MAP_VSCALE), 1)];
        material.offset = [float(find(MAP_UOFFSET), 0), float(find(MAP_VOFFSET), 0)];
      }
    }
    if (name) sources.set(name, material);
  };
  const materials: Material[] = [], materialKeys = new Map<string, number | null>();
  let missingImages = 0;
  const materialKey = (name: string): number | null => {
    const known = materialKeys.get(name);
    if (known !== undefined) return known;
    const source = sources.get(name);
    if (!source) { materialKeys.set(name, null); return null; }
    const image = source.map ? archiveFile(resources, source.map) : null;
    if (source.map && !image) missingImages++;
    const key = materials.length;
    materials.push(meshMaterial(key, name, source.color, source.opacity, image));
    materialKeys.set(name, key);
    return key;
  };

  const groups: { name: string; geometry: MeshGeometry }[] = [];
  const readMesh = (name: string, chunk: Chunk): void => {
    const parts = chunks(view, chunk.body, chunk.end);
    const vertexChunk = parts.find(p => p.id === VERTICES), faceChunk = parts.find(p => p.id === FACES);
    if (!vertexChunk || !faceChunk) return;
    const vertexCount = view.getUint16(vertexChunk.body, true);
    if (vertexChunk.body + 2 + vertexCount * 12 > vertexChunk.end) { malformed++; return; }
    const at = (i: number, k: number): number => view.getFloat32(vertexChunk.body + 2 + i * 12 + k * 4, true);
    const points = Array.from({ length: vertexCount }, (_, i) => convert.point([at(i, 0), at(i, 1), at(i, 2)]));
    const uvChunk = parts.find(p => p.id === TEXCOORDS);
    const uvCount = uvChunk ? view.getUint16(uvChunk.body, true) : 0;
    const uvAt = (i: number): Vec2 | null => uvChunk && i < uvCount && uvChunk.body + 2 + i * 8 + 8 <= uvChunk.end
      ? [view.getFloat32(uvChunk.body + 2 + i * 8, true), view.getFloat32(uvChunk.body + 6 + i * 8, true)] : null;
    const faceCount = view.getUint16(faceChunk.body, true), faceEnd = faceChunk.body + 2 + faceCount * 8;
    if (faceEnd > faceChunk.end) { malformed++; return; }
    // Material assignments and smoothing groups are sub-chunks after the face list.
    const faceMaterial = new Array<number | null>(faceCount).fill(null), faceUv = new Array<{ scale: Vec2; offset: Vec2 } | null>(faceCount).fill(null);
    let smoothing: Uint32Array | null = null;
    for (const sub of chunks(view, faceEnd, faceChunk.end)) {
      if (sub.id === FACE_MATERIAL) {
        const [materialName, at] = cString(bytes, sub.body, sub.end), key = materialKey(materialName), source = sources.get(materialName) ?? null;
        const n = at + 2 <= sub.end ? view.getUint16(at, true) : 0;
        for (let i = 0; i < n && at + 2 + i * 2 + 2 <= sub.end; i++) {
          const face = view.getUint16(at + 2 + i * 2, true);
          if (face < faceCount) { faceMaterial[face] = key; faceUv[face] = source; }
        }
      } else if (sub.id === SMOOTHING && sub.body + faceCount * 4 <= sub.end) {
        smoothing = new Uint32Array(faceCount);
        for (let i = 0; i < faceCount; i++) smoothing[i] = view.getUint32(sub.body + i * 4, true);
      }
    }
    const geometry: MeshGeometry = { polygons: [], lines: [] };
    for (let f = 0; f < faceCount; f++) {
      const ids = [0, 1, 2].map(k => view.getUint16(faceChunk.body + 2 + f * 8 + k * 2, true));
      if (ids.some(i => i >= vertexCount)) { malformed++; continue; }
      const tiling = faceUv[f];
      geometry.polygons.push({ material: faceMaterial[f] ?? null, smoothing: smoothing ? smoothing[f]! : undefined, corners: ids.map(i => {
        const uv = uvAt(i);
        return { position: points[i]!, normal: null, uv: uv && tiling ? [uv[0] * tiling.scale[0] + tiling.offset[0], uv[1] * tiling.scale[1] + tiling.offset[1]] : uv };
      }) });
    }
    groups.push({ name: name || `Object ${groups.length + 1}`, geometry });
  };

  let keyframer = false;
  const main = chunks(view, 0, bytes.length).find(c => c.id === MAIN)!;
  const editor = chunks(view, main.body, main.end);
  keyframer = editor.some(c => c.id === KEYFRAMER);
  const scene = editor.filter(c => c.id === EDITOR).flatMap(c => chunks(view, c.body, c.end));
  // Materials first: meshes refer to them by name.
  for (const chunk of scene) if (chunk.id === MATERIAL) readMaterial(chunk);
  const objects = scene.filter(c => c.id === OBJECT);
  objects.forEach((chunk, i) => {
    onProgress?.({ stage: 'Reading 3DS model', current: i, total: objects.length });
    const [name, at] = cString(bytes, chunk.body, chunk.end);
    for (const part of chunks(view, at, chunk.end)) {
      if (part.id === TRIMESH) readMesh(name, part);
      else if (part.id === CAMERA) cameras++;
      else if (part.id === LIGHT) lights++;
    }
  });
  if (malformed) warn(`${malformed} mesh${malformed === 1 ? ' or face' : 'es or faces'} with invalid data ${malformed === 1 ? 'is' : 'are'} skipped.`);
  if (cameras || lights) warn('Cameras and lights are not imported.');
  if (keyframer) warn('The keyframe data (animation and object pivots) is not imported; meshes are imported where they are stored.');
  if (missingImages) warn(resources
    ? `${missingImages} texture image${missingImages === 1 ? ' is' : 's are'} missing from the archive; ${missingImages === 1 ? 'its material uses its' : 'their materials use their'} color.`
    : `${missingImages} textured material${missingImages === 1 ? ' uses its' : 's use their'} color: textures are imported from a .zip archive that holds the model with its images.`);
  // Objects that share a name stay apart, as 3DS keeps them.
  const { model, placements } = groupedMeshModel(groups, materials, '3DS', counts, onProgress);
  meshCountNotes(counts, warn);
  return finishMeshImport(model, placements, THREE_DS_FORMAT, warnings, onProgress);
}
