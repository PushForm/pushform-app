// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL, v3len, v3normalize, type Vec2, type Vec3 } from '@pushform/core';
import type { Material } from 'openskp';
import {
  archiveFile, finishMeshImport, groupedMeshModel, meshCountNotes, meshMaterial, meshPointConverter,
  type ArchiveResources, type MeshCorner, type MeshCounts, type MeshExtent, type MeshGeometry, type MeshImportOptions,
} from './meshImport';
import { MAX_SKETCHUP_BYTES, type ImportFormat, type ImportProgress, type SketchUpImport } from './sketchup';

// Wavefront OBJ import: faces, lines, groups and .mtl materials, through the shared mesh conversion.

export const OBJ_FORMAT: ImportFormat = { kind: 'obj', name: 'OBJ', notes: [
  'OBJ import: faces, lines, groups and materials are imported, with .mtl materials and textures from a .zip archive that holds them. Points, curves and surfaces are not imported.',
] };

export function isObjModelFile(name: string): boolean { return /\.obj$/i.test(name); }

const KEYWORDS = new Set(['v', 'vt', 'vn', 'vp', 'f', 'l', 'p', 'o', 'g', 's', 'mtllib', 'usemtl', 'usemap', 'mg', 'cstype', 'curv', 'surf']);

/** Whether the bytes read like an OBJ file: its first statement, after comments, is an OBJ keyword. */
export function isObjText(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 4096));
  for (const line of head.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    return KEYWORDS.has(trimmed.split(/\s+/)[0]!);
  }
  return false;
}

/** Statements with backslash continuations joined and comments dropped. */
function statements(text: string): string[][] {
  const out: string[][] = [];
  let pending = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = pending + raw;
    if (line.endsWith('\\')) { pending = `${line.slice(0, -1)} `; continue; }
    pending = '';
    const hash = line.indexOf('#'), body = (hash < 0 ? line : line.slice(0, hash)).trim();
    if (body) out.push(body.split(/\s+/));
  }
  return out;
}

/** The extent of the file's vertices in its own units and axes. */
export function objExtent(bytes: Uint8Array): MeshExtent | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const text = new TextDecoder().decode(bytes);
  let at = 0;
  while (at < text.length) {
    const end = text.indexOf('\n', at), line = text.slice(at, end < 0 ? text.length : end);
    at = end < 0 ? text.length : end + 1;
    if (line.charCodeAt(0) !== 118 || (line.charCodeAt(1) !== 32 && line.charCodeAt(1) !== 9)) continue;
    const v = line.trim().split(/\s+/);
    for (let k = 0; k < 3; k++) {
      const x = Number(v[k + 1]);
      if (Number.isFinite(x)) { min[k] = Math.min(min[k]!, x); max[k] = Math.max(max[k]!, x); }
    }
  }
  return min.every(Number.isFinite) ? { min, max } : null;
}

interface ObjMaterial { color: Vec3; opacity: number; map: string | null; scale: Vec2; offset: Vec2 }

/** The materials of a `.mtl` file by name: diffuse color, dissolve, and diffuse texture with its scale and offset. */
function parseMtl(text: string): Map<string, ObjMaterial> {
  const out = new Map<string, ObjMaterial>();
  let current: ObjMaterial | null = null;
  for (const [keyword, ...args] of statements(text)) {
    const word = keyword!.toLowerCase();
    if (word === 'newmtl') { current = { color: [0.8, 0.8, 0.8], opacity: 1, map: null, scale: [1, 1], offset: [0, 0] }; out.set(args.join(' '), current); }
    else if (!current) continue;
    else if (word === 'kd' && args.length >= 3) current.color = [Number(args[0]), Number(args[1]), Number(args[2])];
    else if (word === 'd' && args.length) current.opacity = Number(args.at(-1));
    else if (word === 'tr' && args.length) current.opacity = 1 - Number(args.at(-1));
    else if (word === 'map_kd') {
      // Options come first; the rest is the file name, which may contain spaces.
      const OPTIONS: Record<string, number> = { '-blendu': 1, '-blendv': 1, '-cc': 1, '-clamp': 1, '-mm': 2, '-texres': 1, '-bm': 1, '-imfchan': 1, '-type': 1, '-boost': 1 };
      let i = 0;
      while (i < args.length && args[i]!.startsWith('-')) {
        const option = args[i]!.toLowerCase();
        if (option === '-s' || option === '-o' || option === '-t') {
          const values: number[] = [];
          i++;
          while (i < args.length && values.length < 3 && Number.isFinite(Number(args[i]))) values.push(Number(args[i++]));
          if (option === '-s') current.scale = [values[0] ?? 1, values[1] ?? values[0] ?? 1];
          if (option === '-o') current.offset = [values[0] ?? 0, values[1] ?? 0];
        } else i += 1 + (OPTIONS[option] ?? 0);
      }
      const name = args.slice(i).join(' ');
      current.map = name || null;
    }
  }
  return out;
}

/**
 * Read an OBJ model in the given unit and up axis. `resources` are the files of the archive the
 * model came from, where its `.mtl` libraries and texture images are found.
 */
export async function readObj(bytes: Uint8Array, options: MeshImportOptions, onProgress?: (p: ImportProgress) => void,
  resources?: ArchiveResources): Promise<SketchUpImport> {
  if (bytes.byteLength > MAX_SKETCHUP_BYTES) throw new Error('OBJ files larger than 128 MiB are not supported yet.');
  onProgress?.({ stage: 'Reading OBJ model', current: 0, total: 1 });
  const warnings = new Set<string>(), warn = (message: string): void => { warnings.add(message); };
  const convert = meshPointConverter(options);
  const positions: Vec3[] = [], normals: Vec3[] = [], uvs: Vec2[] = [];
  const counts: MeshCounts = { degenerate: 0, nonplanar: 0, duplicates: 0, turned: 0 };
  let malformed = 0, unsupported = 0;

  const libraries = new Map<string, ObjMaterial>();
  const materials: Material[] = [], materialKeys = new Map<string, number | null>(), undefinedMaterials = new Set<string>();
  let missingImages = 0;
  const materialKey = (name: string): number | null => {
    const known = materialKeys.get(name);
    if (known !== undefined) return known;
    const source = libraries.get(name);
    if (!source) { undefinedMaterials.add(name); materialKeys.set(name, null); return null; }
    const image = source.map ? archiveFile(resources, source.map) : null;
    if (source.map && !image) missingImages++;
    const key = materials.length;
    materials.push(meshMaterial(key, name, source.color, source.opacity, image));
    materialKeys.set(name, key);
    return key;
  };

  const groups = new Map<string, MeshGeometry>();
  const geometry = (name: string): MeshGeometry => groups.get(name) ?? groups.set(name, { polygons: [], lines: [] }).get(name)!;
  // Faces belong to the current object (`o`), or to the current group (`g`) in files without objects.
  let objectName: string | null = null, material: number | null = null;
  let current = geometry(''), smoothing: number | undefined;
  let scaled = { scale: [1, 1] as Vec2, offset: [0, 0] as Vec2 };
  const index = (token: string | undefined, length: number): number | null => {
    if (!token) return null;
    const n = Number(token);
    if (!Number.isInteger(n) || n === 0) return null;
    const i = n > 0 ? n - 1 : length + n;
    return i >= 0 && i < length ? i : null;
  };
  const all = statements(new TextDecoder().decode(bytes));
  for (const [keyword, ...args] of all) {
    switch (keyword) {
      case 'v': positions.push(convert.point([Number(args[0]), Number(args[1]), Number(args[2])])); break;
      case 'vn': normals.push(convert.direction([Number(args[0]), Number(args[1]), Number(args[2])])); break;
      case 'vt': uvs.push([Number(args[0]), Number(args[1] ?? 0)]); break;
      case 'mtllib': {
        // A library name may contain spaces; try the whole rest of the line first, then each word.
        const names = [args.join(' '), ...args];
        for (const name of names) {
          const file = archiveFile(resources, name);
          if (file) { for (const [key, value] of parseMtl(new TextDecoder().decode(file.data))) libraries.set(key, value); break; }
        }
        break;
      }
      case 'usemtl': {
        // `usemtl (null)` or a bare `usemtl`, as exporters write for unpainted faces, is the default material.
        material = args.length === 0 || args.join(' ') === '(null)' ? null : materialKey(args.join(' '));
        const source = libraries.get(args.join(' '));
        scaled = { scale: source?.scale ?? [1, 1], offset: source?.offset ?? [0, 0] };
        break;
      }
      case 'o': objectName = args.join(' '); current = geometry(objectName); break;
      case 'g': if (objectName === null) current = geometry(args.join(' ')); break;
      case 's': smoothing = !args[0] || args[0] === 'off' || args[0] === '0' ? 0 : 1 << ((Math.abs(Number(args[0]) || 1) - 1) % 31); break;
      case 'f': case 'l': {
        const corners: MeshCorner[] = [];
        let valid = true;
        for (const token of args) {
          const [v, t, n] = token.split('/');
          const p = index(v, positions.length);
          if (p === null) { valid = false; break; }
          const ti = t ? index(t, uvs.length) : null, ni = n ? index(n, normals.length) : null;
          const uv = ti === null ? null : uvs[ti]!, normal = ni === null ? null : normals[ni]!;
          corners.push({ position: positions[p]!, uv: uv && [uv[0] * scaled.scale[0] + scaled.offset[0], uv[1] * scaled.scale[1] + scaled.offset[1]],
            normal: normal && v3len(normal) > LENGTH_TOL ? v3normalize(normal) : null });
        }
        if (!valid || corners.some(c => !c.position.every(Number.isFinite))) { malformed++; break; }
        if (keyword === 'l') { for (let i = 0; i + 1 < corners.length; i++) current.lines.push([corners[i]!.position, corners[i + 1]!.position]); break; }
        // A face with vertex normals is smoothed by them; the smoothing group decides only without them.
        if (corners.length >= 3) current.polygons.push({ corners, material, smoothing: corners.every(c => c.normal) ? undefined : smoothing });
        break;
      }
      case 'p': case 'curv': case 'curv2': case 'surf': case 'cstype': unsupported++; break;
      default: break;
    }
  }
  if (malformed) warn(`${malformed} face${malformed === 1 ? ' or line' : 's or lines'} with invalid vertex indices or coordinates ${malformed === 1 ? 'is' : 'are'} skipped.`);
  if (unsupported) warn('Points, curves and surfaces are not imported.');
  if (undefinedMaterials.size) warn(resources
    ? `${undefinedMaterials.size} material${undefinedMaterials.size === 1 ? ' the model uses is' : 's the model uses are'} not defined in its .mtl files; ${undefinedMaterials.size === 1 ? 'its faces use' : 'their faces use'} the default material.`
    : `${undefinedMaterials.size} material${undefinedMaterials.size === 1 ? '' : 's'} named in the file ${undefinedMaterials.size === 1 ? 'uses' : 'use'} the default material: materials and textures are imported from a .zip archive that holds the model with its .mtl files and images.`);
  if (missingImages) warn(`${missingImages} texture image${missingImages === 1 ? ' is' : 's are'} missing from the archive; ${missingImages === 1 ? 'its material uses its' : 'their materials use their'} color.`);
  onProgress?.({ stage: 'Reading OBJ model', current: 1, total: 1 });
  const { model, placements } = groupedMeshModel([...groups].map(([name, geometry]) => ({ name, geometry })), materials, 'OBJ', counts, onProgress);
  meshCountNotes(counts, warn);
  return finishMeshImport(model, placements, OBJ_FORMAT, warnings, onProgress);
}
