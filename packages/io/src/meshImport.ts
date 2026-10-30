// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  AREA_TOL, LENGTH_TOL, MERGE_TOL, TEXCOORD_TOL, VERTEX_NORMAL_TOL, planeBasis, v3dot, v3len, v3normalize, v3sub,
  type Vec2, type Vec3,
} from '@pushform/core';
import { weldVertices } from '@pushform/geom';
import { hashImageBytes, uvAffineLeastSquares } from '@pushform/model';
import { unzipSync } from 'fflate';
import type { CoEdge, Definition, Face, Material, SkpModel } from 'openskp';
import { MAX_SKETCHUP_BYTES, prepareSketchUp, type ImportFormat, type ImportProgress, type ImportedUvMap, type SketchUpImport } from './sketchup';

// Shared conversion of polygon meshes (COLLADA, OBJ, 3DS, glTF) into the reader model the SketchUp importer converts:
// welding, merging triangles back into faces, two-sided faces, smoothing, texture placement and archives.

export const INCH = 0.0254;
/** Total unpacked size of the model and images read from one archive. */
export const MAX_MODEL_ARCHIVE_BYTES = 2 * MAX_SKETCHUP_BYTES;

export type MeshUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';
/** Units a mesh file without units of its own can be read in, with the meters one of each is. */
export const MESH_UNITS: readonly { unit: MeshUnit; label: string; meters: number }[] = [
  { unit: 'mm', label: 'Millimeters', meters: 0.001 },
  { unit: 'cm', label: 'Centimeters', meters: 0.01 },
  { unit: 'm', label: 'Meters', meters: 1 },
  { unit: 'in', label: 'Inches', meters: INCH },
  { unit: 'ft', label: 'Feet', meters: 0.3048 },
];
/** How to read an OBJ or 3DS file, which records neither its unit nor (OBJ) which axis is up. */
export interface MeshImportOptions { unit: MeshUnit; up: 'z' | 'y' }
/** The extent of a mesh file's points in its own units and axes, for the import options' size preview. */
export interface MeshExtent { min: Vec3; max: Vec3 }

/** File coordinates to meters with Z up: Y-up files turn so that +Y becomes +Z and +Z becomes -Y. */
export function meshPointConverter(options: MeshImportOptions): { point: (p: Vec3) => Vec3; direction: (d: Vec3) => Vec3 } {
  const scale = MESH_UNITS.find(u => u.unit === options.unit)?.meters ?? 1;
  const direction = options.up === 'y' ? (d: Vec3): Vec3 => [d[0], -d[2], d[1]] : (d: Vec3): Vec3 => [d[0], d[1], d[2]];
  return { direction, point: p => { const [x, y, z] = direction(p); return [x * scale, y * scale, z * scale]; } };
}

/** The placement of a group at the origin, as the reader model's 16 column-major values. */
export const IDENTITY_PLACEMENT: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export interface MeshCorner { position: Vec3; normal: Vec3 | null; uv: Vec2 | null }
/**
 * One polygon of a mesh, in meters with Z up. `smoothing` is a smoothing-group mask (3DS, OBJ `s`): two faces at an
 * angle whose masks share a bit meet at a soft, smooth edge; without masks, matching vertex normals decide.
 */
export interface MeshPolygon { corners: MeshCorner[]; material: number | null; smoothing?: number | undefined }
/** What a line's edge carries besides its ends (DXF): the reader curve it is part of and its layer, by line index. */
export interface MeshLineMeta { curve?: number; layer?: string }
export interface MeshGeometry { polygons: MeshPolygon[]; lines: [Vec3, Vec3][]; lineMeta?: (MeshLineMeta | undefined)[] }
/** The texture placement of a reader face's two sides as the file's texture coordinates give it, and its normal then. */
export interface MeshPlacement { normal: Vec3; front: ImportedUvMap | null; back: ImportedUvMap | null }
/** Counts of polygons the conversion skips or changes, for the import notes. */
export interface MeshCounts { degenerate: number; nonplanar: number; duplicates: number; turned: number }
type ReaderDefinition = Definition & { isGroup: boolean };

/** An empty reader definition: a group, a component, or (key -1) the model itself. */
export function meshDefinition(key: number, name: string, isGroup: boolean): ReaderDefinition {
  return { id: key, guid: '', name, vertices: [], edges: [], faces: [], instances: [], sectionPlanes: [], texts: [], dimensions: [],
    constructionLines: [], constructionPoints: [], isImage: false, alwaysFacesCamera: false, shadowsFaceSun: false, isGroup };
}

/** A reader material from a color (0–1), opacity and texture image; the texture's tile size is set by `setTextureTileSizes`. */
export function meshMaterial(key: number, name: string, color: Vec3, opacity: number, image: { name: string; data: Uint8Array } | null): Material {
  const [r, g, b] = color.map(c => Math.max(0, Math.min(1, Number.isFinite(c) ? c : 1)) * 255) as [number, number, number];
  return { name, color: { r, g, b, a: 255 }, transparency: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1, id: key,
    texture: image ? { filename: image.name, width: 1 / INCH, height: 1 / INCH, data: image.data } : null, colorized: false, colorizeType: 0 };
}

/**
 * One texture tile is one image, so a material's tile size is how far its placements stretch one image: the median
 * over the face sides it paints, or a meter where it paints none.
 */
export function setTextureTileSizes(materials: Material[], placements: Map<number, Map<number, MeshPlacement>>, definitionOf: (key: number) => Definition | undefined): void {
  const spans = materials.map(() => ({ width: [] as number[], height: [] as number[] }));
  for (const [key, byFace] of placements) {
    for (const face of definitionOf(key)?.faces ?? []) {
      const placed = byFace.get(face.id);
      for (const [material, map] of [[face.materialId, placed?.front], [face.backMaterialId, placed?.back]] as const) {
        if (material === null || !map) continue;
        const s = v3len([map.s[0], map.s[1], map.s[2]]), t = v3len([map.t[0], map.t[1], map.t[2]]);
        if (s > 0 && t > 0) { spans[material]!.width.push(1 / s); spans[material]!.height.push(1 / t); }
      }
    }
  }
  const median = (list: number[]): number => list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]! : 1;
  materials.forEach((material, i) => {
    if (material.texture) { material.texture.width = median(spans[i]!.width) / INCH; material.texture.height = median(spans[i]!.height) / INCH; }
  });
}

/**
 * A reader model of named groups at the origin (OBJ groups, 3DS objects), each holding its own geometry. Geometry
 * outside any group, and a file's only group, are the model itself. Returns the model and each face's texture placement.
 */
export function groupedMeshModel(groups: { name: string; geometry: MeshGeometry }[], materials: Material[], version: string,
  counts: MeshCounts, onProgress?: (p: ImportProgress) => void):
  { model: SkpModel; placements: Map<number, Map<number, MeshPlacement>> } {
  const textured = (material: number | null): boolean => material !== null && !!materials[material]?.texture;
  const placements = new Map<number, Map<number, MeshPlacement>>(), definitions = new Map<number, Definition>();
  const root = meshDefinition(-1, '', false);
  const filled = groups.filter(group => group.geometry.polygons.length || group.geometry.lines.length);
  const loose = filled.filter(group => !group.name), named = filled.filter(group => group.name);
  const build = (def: Definition, geometry: MeshGeometry): void => {
    const byFace = new Map<number, MeshPlacement>();
    buildMeshGeometry(def, geometry, counts, textured, byFace, { paintBacks: true });
    if (byFace.size) placements.set(def.id, byFace);
  };
  const merged = (list: typeof filled): MeshGeometry => ({ polygons: list.flatMap(g => g.geometry.polygons), lines: list.flatMap(g => g.geometry.lines) });
  if (named.length <= 1) build(root, merged(filled));
  else {
    if (loose.length) build(root, merged(loose));
    named.forEach((group, i) => {
      onProgress?.({ stage: 'Building groups', current: i, total: named.length });
      const def = meshDefinition(i, group.name, true);
      definitions.set(i, def);
      build(def, group.geometry);
      root.instances.push({ name: group.name, refIdx: i, guid: '', matrix: [...IDENTITY_PLACEMENT], materialId: null, hidden: false, layer: '', properties: {} });
    });
  }
  setTextureTileSizes(materials, placements, key => key === -1 ? root : definitions.get(key));
  return { placements, model: { version, definitions, root, layers: [], pages: [], scenesUnread: 0, dimensions: [],
    materials, materialsById: new Map(materials.map(m => [m.id!, m])), styles: [], units: null, unitsOptions: null, sectionDisplay: null, renderingOptions: null } };
}

/** Import notes for the polygons the conversion skipped or split. */
export function meshCountNotes(counts: MeshCounts, warn: (message: string) => void): void {
  if (counts.degenerate) warn(`${counts.degenerate} polygon${counts.degenerate === 1 ? ' that encloses' : 's that enclose'} no area ${counts.degenerate === 1 ? 'is' : 'are'} skipped.`);
  if (counts.nonplanar) warn(`${counts.nonplanar} nonplanar polygon${counts.nonplanar === 1 ? ' is' : 's are'} imported as triangles.`);
  if (counts.turned) warn(`${counts.turned} polygon${counts.turned === 1 ? ' wound against its vertex normals is' : 's wound against their vertex normals are'} turned over to face the way the normals do.`);
  if (counts.duplicates) warn(`${counts.duplicates} duplicate polygon${counts.duplicates === 1 ? ' is' : 's are'} skipped.`);
}

/**
 * Convert a reader model built from a mesh file as .skp models are converted, then place each textured side by
 * the file's texture coordinates and hash the images. Faces the converter turned outward have their sides swapped.
 */
export async function finishMeshImport(model: SkpModel, placements: Map<number, Map<number, MeshPlacement>>, format: ImportFormat,
  warnings: Set<string>, onProgress?: (p: ImportProgress) => void): Promise<SketchUpImport> {
  const scene = prepareSketchUp(model, onProgress, format);
  for (const def of [scene.root, ...scene.definitions.values()]) {
    const byFace = placements.get(def.key);
    if (byFace) for (const face of [...def.solids.flatMap(solid => solid.faces), ...def.sheets]) {
      const placed = byFace.get(face.sourceId);
      if (!placed) continue;
      const [front, back] = v3dot(face.normal, placed.normal) > 0 ? [placed.front, placed.back] : [placed.back, placed.front];
      if (front && face.front !== null && scene.materials.get(face.front)?.texture) face.frontUv = front;
      if (back && face.back !== null && scene.materials.get(face.back)?.texture) face.backUv = back;
    }
  }
  // The same hash as images added in the app, so a later import or library texture can share the asset.
  for (const image of scene.images) image.sha256 = await hashImageBytes(image.bytes);
  scene.warnings = [...scene.warnings, ...[...warnings].filter(w => !scene.warnings.includes(w))];
  return scene;
}

/** Whether the bytes begin with a zip archive's local file header. */
export function isZipBytes(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** The files an archive holds beside its model, by normalized path, and the folder that holds the model. */
export interface ArchiveResources { base: string; files: Map<string, Uint8Array> }

/** A path with `/` separators and its `.` and `..` steps resolved. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** The models, materials, Google Earth descriptions and images of a zip archive, by normalized path. */
export function unpackModelArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.byteLength > MAX_SKETCHUP_BYTES) throw new Error('Archives larger than 128 MiB are not supported yet.');
  let unpacked = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: file => {
      if (/(^|\/)__MACOSX\//.test(file.name) || !/\.(dae|obj|mtl|3ds|gltf|glb|bin|kml|png|jpe?g|gif|bmp|tga|tiff?|dds|webp)$/i.test(file.name)) return false;
      unpacked += file.originalSize;
      if (unpacked > MAX_MODEL_ARCHIVE_BYTES) throw new Error('its model and images unpack to more than 256 MiB');
      return true;
    } });
  } catch (cause) {
    throw new Error(`Could not read this archive: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return new Map(Object.entries(entries).map(([name, data]) => [normalizePath(name), data]));
}

/**
 * A file the model refers to, such as a texture image: at its path relative to the model's folder, else the archive's
 * one file of that name. Absolute paths and `file:` URLs are matched by name.
 */
export function archiveFile(resources: ArchiveResources | undefined, reference: string): { name: string; data: Uint8Array } | null {
  if (!resources || !reference.trim()) return null;
  let path = reference.trim().replace(/^file:\/*/i, '');
  try { path = decodeURIComponent(path); } catch { /* a literal % stays as written */ }
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
  const relative = /^([a-z]:)?[\\/]/i.test(path) ? null : normalizePath(`${resources.base}/${path}`);
  const keys = [...resources.files.keys()];
  const byName = keys.filter(k => k.split('/').pop()?.toLowerCase() === name.toLowerCase());
  const found = (relative !== null ? keys.find(k => k === relative) ?? keys.find(k => k.toLowerCase() === relative.toLowerCase()) : undefined) ??
    (byName.length === 1 ? byName[0] : undefined);
  return found ? { name, data: resources.files.get(found)! } : null;
}

/**
 * One source polygon on welded vertices. A sliver encloses no area: triangulators emit them between points along
 * one straight edge, and they carry those points into the face they belong to.
 */
interface Polygon {
  ring: number[]; normals: (Vec3 | null)[]; front: number | null; back: number | null; normal: Vec3; sliver: boolean;
  /** Texture coordinates of each corner, and of the same corners on the back side when a reversed copy carried them. */
  uvs: (Vec2 | null)[]; backUvs: (Vec2 | null)[] | null;
  /** Smoothing-group mask from the file, when it has one. */
  smoothing: number | undefined;
}

/**
 * The placement that best maps a face's points (meters) to their texture coordinates (tiles), as linear functions
 * in the face's plane; null without three corners that span the plane in both the face and the texture.
 */
function fitPlacement(points: Vec3[], uvs: Vec2[], normal: Vec3): ImportedUvMap | null {
  const { u, v } = planeBasis([0, 0, 0], normal);
  const fit = uvAffineLeastSquares(points.map(p => [v3dot(p, u), v3dot(p, v)] as Vec2), uvs);
  if (!fit || !fit.every(Number.isFinite)) return null;
  const [a, b, c, d, e, f] = fit;
  const map: ImportedUvMap = { s: [a * u[0] + b * v[0], a * u[1] + b * v[1], a * u[2] + b * v[2], c], t: [d * u[0] + e * v[0], d * u[1] + e * v[1], d * u[2] + e * v[2], f] };
  return v3len(v3cross3(map)) > 0 ? map : null;
}
/** The cross product of a placement's two directions: zero when the texture collapses to a line. */
function v3cross3(map: ImportedUvMap): Vec3 {
  const [s0, s1, s2] = map.s, [t0, t1, t2] = map.t;
  return [s1 * t2 - s2 * t1, s2 * t0 - s0 * t2, s0 * t1 - s1 * t0];
}
function placeAt(map: ImportedUvMap, p: Vec3): Vec2 {
  return [map.s[0] * p[0] + map.s[1] * p[1] + map.s[2] * p[2] + map.s[3], map.t[0] * p[0] + map.t[1] * p[1] + map.t[2] * p[2] + map.t[3]];
}

/** Newell's normal of a ring of points: its direction follows the winding, its length is twice the area. */
function newell(points: Vec3[]): Vec3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

/**
 * Whether a ring with Newell sum `sum` encloses no area: under the area tolerance, or thinner than the length
 * tolerance across its longest side. Points on one line far from the origin can keep a little area from rounding.
 */
function isSliver(points: Vec3[], sum: Vec3): boolean {
  const area = v3len(sum) / 2;
  if (area <= AREA_TOL) return true;
  let longest = 0;
  points.forEach((a, i) => { longest = Math.max(longest, v3len(v3sub(points[(i + 1) % points.length]!, a))); });
  return 2 * area / longest <= LENGTH_TOL;
}

/**
 * Turn one node's polygons and lines (meters, Z-up) into the reader model's vertices, edges and faces. Corners
 * within the merge tolerance are welded; adjacent polygons in one plane with the same materials become one
 * face unless a line separates them or, on a textured material, their texture coordinates do not continue across
 * the join; a polygon repeated with the opposite winding becomes the back of the first; and an edge between faces
 * in a shared smoothing group, or whose vertex normals agree on both sides, is soft and smooth. Each face's texture
 * placement goes to `placements`.
 */
export function buildMeshGeometry(def: Definition, source: MeshGeometry, counts: MeshCounts,
  textured: (material: number | null) => boolean, placements: Map<number, MeshPlacement>, options: { paintBacks?: boolean } = {}): void {
  const all: Vec3[] = [...source.polygons.flatMap(p => p.corners.map(c => c.position)), ...source.lines.flat()];
  if (!all.length) return;
  const canonical = weldVertices(Float64Array.from(all.flat()), MERGE_TOL);
  const ids = new Map<number, number>(), points: Vec3[] = [];
  const vertexAt = (i: number): number => {
    const c = canonical[i]!;
    let id = ids.get(c);
    if (id === undefined) {
      id = points.length; ids.set(c, id); points.push(all[c]!);
      def.vertices.push({ id, x: all[c]![0] / INCH, y: all[c]![1] / INCH, z: all[c]![2] / INCH });
    }
    return id;
  };
  const polygons: Polygon[] = [], byVertices = new Map<string, number>();
  const add = (ring: number[], normals: (Vec3 | null)[], uvs: (Vec2 | null)[], material: number | null, smoothing: number | undefined): void => {
    const corners = ring.map(v => points[v]!), sum = newell(corners), sliver = isSliver(corners, sum);
    const normal: Vec3 = sliver ? [0, 0, 0] : v3normalize(sum), key = [...ring].sort((a, b) => a - b).join(',');
    const same = byVertices.get(key);
    if (same !== undefined) {
      const first = polygons[same]!;
      // The same polygon wound the other way is the other side of one face (two-sided exports); a sliver has no side.
      if (sliver || first.sliver) return;
      if (v3dot(first.normal, normal) < 0 && first.back === null && material !== null) {
        first.back = material;
        first.backUvs = first.ring.map(v => uvs[ring.indexOf(v)] ?? null);
      } else counts.duplicates++;
      return;
    }
    byVertices.set(key, polygons.length);
    polygons.push({ ring, normals, front: material, back: null, normal, sliver, uvs, backUvs: null, smoothing });
  };
  let at = 0;
  for (const polygon of source.polygons) {
    const ring: number[] = [], normals: (Vec3 | null)[] = [], uvs: (Vec2 | null)[] = [];
    for (const corner of polygon.corners) {
      const v = vertexAt(at++);
      if (ring.at(-1) === v) continue;
      ring.push(v); normals.push(corner.normal); uvs.push(corner.uv);
    }
    while (ring.length > 1 && ring[0] === ring.at(-1)) { ring.pop(); normals.pop(); uvs.pop(); }
    if (ring.length < 3) { counts.degenerate++; continue; }
    // The file's vertex normals show which way a polygon faces; one wound against them is turned over.
    if (normals.every(Boolean)) {
      const facing = normals.reduce<Vec3>((total, n) => [total[0] + n![0], total[1] + n![1], total[2] + n![2]], [0, 0, 0]);
      if (v3dot(facing, newell(ring.map(v => points[v]!))) < 0) { ring.reverse(); normals.reverse(); uvs.reverse(); counts.turned++; }
    }
    const sum = newell(ring.map(v => points[v]!));
    if (isSliver(ring.map(v => points[v]!), sum)) { add(ring, normals, uvs, polygon.material, polygon.smoothing); continue; }
    const normal = v3normalize(sum), centroid = ring.reduce<Vec3>((c, v) => [c[0] + points[v]![0] / ring.length,
      c[1] + points[v]![1] / ring.length, c[2] + points[v]![2] / ring.length], [0, 0, 0]);
    if (ring.some(v => Math.abs(v3dot(v3sub(points[v]!, centroid), normal)) > MERGE_TOL / 2)) {
      counts.nonplanar++;
      for (let i = 1; i + 1 < ring.length; i++) add([ring[0]!, ring[i]!, ring[i + 1]!], [normals[0]!, normals[i]!, normals[i + 1]!],
        [uvs[0]!, uvs[i]!, uvs[i + 1]!], polygon.material, polygon.smoothing);
    } else add(ring, normals, uvs, polygon.material, polygon.smoothing);
  }
  /** A polygon's own texture placement on one side, when every corner has coordinates. */
  const polygonPlacement = (polygon: Polygon, uvs: (Vec2 | null)[] | null): ImportedUvMap | null =>
    uvs && uvs.every(Boolean) ? fitPlacement(polygon.ring.map(v => points[v]!), uvs as Vec2[], polygon.normal) : null;
  /**
   * Whether a polygon's coordinates on one side follow the first polygon's placement. Without a placement there (no
   * coordinates, or coordinates collapsed to a line) there is no seam to keep.
   */
  const follows = (map: ImportedUvMap | null, polygon: Polygon, uvs: (Vec2 | null)[] | null): boolean => {
    if (!map) return true;
    if (!uvs?.every(Boolean)) return false;
    return polygon.ring.every((v, k) => {
      const [s, t] = placeAt(map, points[v]!), [s0, t0] = uvs[k]!;
      return Math.abs(s - s0) <= TEXCOORD_TOL && Math.abs(t - t0) <= TEXCOORD_TOL;
    });
  };
  const lineEnds = source.lines.map(() => [vertexAt(at++), vertexAt(at++)] as const);

  const undirected = (a: number, b: number): string => a < b ? `${a}:${b}` : `${b}:${a}`;
  const directed = new Map<string, number>(), uses = new Map<string, number>();
  polygons.forEach((polygon, i) => polygon.ring.forEach((a, k) => {
    const b = polygon.ring[(k + 1) % polygon.ring.length]!;
    directed.set(`${a}>${b}`, i);
    uses.set(undirected(a, b), (uses.get(undirected(a, b)) ?? 0) + 1);
  }));
  const lines = new Set(lineEnds.filter(([a, b]) => a !== b).map(([a, b]) => undirected(a, b)));

  // Coplanar neighbours with the same materials join one face, measured against the first polygon's plane.
  const group = new Int32Array(polygons.length).fill(-1), groups: number[][] = [];
  polygons.forEach((seed, i) => {
    if (group[i] !== -1 || seed.sliver) return;
    const members = [i], offset = v3dot(seed.normal, points[seed.ring[0]!]!);
    // A texture seam inside a plane stays an edge: a textured side joins only polygons its placement continues into.
    const frontMap = textured(seed.front) ? polygonPlacement(seed, seed.uvs) : null;
    const backMap = textured(seed.back) ? polygonPlacement(seed, seed.backUvs) : null;
    group[i] = groups.length;
    for (let m = 0; m < members.length; m++) {
      const polygon = polygons[members[m]!]!;
      polygon.ring.forEach((a, k) => {
        const b = polygon.ring[(k + 1) % polygon.ring.length]!, edge = undirected(a, b);
        if (lines.has(edge) || uses.get(edge) !== 2) return;
        const j = directed.get(`${b}>${a}`);
        if (j === undefined || group[j] !== -1) return;
        const other = polygons[j]!;
        if (other.sliver || other.front !== seed.front || other.back !== seed.back || v3dot(other.normal, seed.normal) <= 0) return;
        if (other.ring.some(v => Math.abs(v3dot(seed.normal, points[v]!) - offset) > MERGE_TOL / 2)) return;
        if (textured(seed.front) && !follows(frontMap, other, other.uvs)) return;
        if (textured(seed.back) && !follows(backMap, other, other.backUvs)) return;
        group[j] = groups.length; members.push(j);
      });
    }
    groups.push(members);
  });
  // A sliver joins the face across its longest side, the one inside that face's triangulation; slivers that
  // continue a sliver follow it there. Slivers that reach no face are dropped.
  for (let joined = true; joined;) {
    joined = false;
    polygons.forEach((polygon, i) => {
      if (!polygon.sliver || group[i] !== -1) return;
      let a = 0, b = 0, longest = -1;
      polygon.ring.forEach((p, k) => {
        const q = polygon.ring[(k + 1) % polygon.ring.length]!, length = v3len(v3sub(points[q]!, points[p]!));
        if (length > longest) { longest = length; a = p; b = q; }
      });
      const j = directed.get(`${b}>${a}`);
      if (j === undefined || group[j] === -1 || polygons[j]!.front !== polygon.front) return;
      group[i] = group[j]!; groups[group[j]!]!.push(i); joined = true;
    });
  }
  counts.degenerate += polygons.filter((polygon, i) => polygon.sliver && group[i] === -1).length;

  const edgeIds = new Map<string, number>();
  const coEdge = (a: number, b: number): CoEdge => {
    const key = undirected(a, b);
    let id = edgeIds.get(key);
    if (id === undefined) {
      id = def.edges.length + 1; edgeIds.set(key, id);
      def.edges.push({ id, v1Id: Math.min(a, b), v2Id: Math.max(a, b), soft: false, smooth: false, hidden: false });
    }
    return { edgeId: id, orientation: a < b ? 1 : 0 };
  };
  const faceOf = new Int32Array(polygons.length);
  const emit = (loops: number[][], members: number[]): void => {
    const first = polygons[members[0]!]!, id = def.faces.length + 1;
    for (const m of members) faceOf[m] = id;
    const face: Face = { id, loops: loops.map(loop => loop.map((a, k) => coEdge(a, loop[(k + 1) % loop.length]!))),
      normal: [...first.normal], materialId: first.front, backMaterialId: first.back ?? (options.paintBacks ? first.front : null),
      uvTransform: null, uvTransformBack: null, uvProjected: false, uvProjectedBack: false, hidden: false };
    def.faces.push(face);
    // Each textured side's placement fits every corner of its polygons that has coordinates.
    const side = (material: number | null, uvsOf: (polygon: Polygon) => (Vec2 | null)[] | null): ImportedUvMap | null => {
      if (!textured(material)) return null;
      const at: Vec3[] = [], uv: Vec2[] = [];
      for (const m of members) {
        const polygon = polygons[m]!, uvs = uvsOf(polygon);
        polygon.ring.forEach((v, k) => { const c = uvs?.[k]; if (c) { at.push(points[v]!); uv.push(c); } });
      }
      return fitPlacement(at, uv, first.normal);
    };
    // Without a back side of its own, a face of a format with no back materials shows its front material on both sides.
    const paintBack = first.back === null && !!options.paintBacks;
    const front = side(first.front, polygon => polygon.uvs), back = side(paintBack ? first.front : first.back, polygon => paintBack ? polygon.uvs : polygon.backUvs);
    if (front || back) placements.set(id, { normal: [...first.normal], front, back });
  };
  for (const members of groups) {
    const loops = members.length > 1 ? boundaryLoops(members, polygons, points, directed, group) : null;
    if (loops) emit(loops, members);
    else for (const m of members) if (!polygons[m]!.sliver) emit([polygons[m]!.ring], [m]);
  }
  lineEnds.forEach(([a, b], k) => {
    if (a === b) return;
    const { edgeId } = coEdge(a, b), meta = source.lineMeta?.[k];
    if (meta) Object.assign(def.edges[edgeId - 1]!, meta);
  });

  // Soft and smooth where two faces at an angle share a smoothing group or, without groups, both endpoints' vertex normals.
  const edges = new Map(def.edges.map(e => [undirected(e.v1Id, e.v2Id), e]));
  const normalAt = (polygon: Polygon, v: number): Vec3 | null => polygon.normals[polygon.ring.indexOf(v)] ?? null;
  const agree = (p: Vec3 | null, q: Vec3 | null): boolean => !!p && !!q && Math.acos(Math.max(-1, Math.min(1, v3dot(p, q)))) <= VERTEX_NORMAL_TOL;
  // A sliver lies in the plane of the face it joined.
  const faceNormal = (i: number): Vec3 => polygons[i]!.sliver ? polygons[groups[group[i]!]![0]!]!.normal : polygons[i]!.normal;
  for (const [key, edge] of edges) {
    const a = edge.v1Id, b = edge.v2Id, i = directed.get(`${a}>${b}`), j = directed.get(`${b}>${a}`);
    if (i === undefined || j === undefined || uses.get(key) !== 2 || !faceOf[i] || !faceOf[j] || faceOf[i] === faceOf[j] || lines.has(key)) continue;
    const p = polygons[i]!, q = polygons[j]!;
    // Faces in one plane that stay apart because their materials differ keep a hard edge between them.
    const flat = Math.acos(Math.max(-1, Math.min(1, v3dot(faceNormal(i), faceNormal(j))))) <= VERTEX_NORMAL_TOL;
    if (flat && (p.front !== q.front || p.back !== q.back)) continue;
    // Smoothing groups decide where the file has them; otherwise the vertex normals of both faces must agree at both ends.
    const smooth = p.smoothing !== undefined && q.smoothing !== undefined ? (p.smoothing & q.smoothing) !== 0
      : agree(normalAt(p, a), normalAt(q, a)) && agree(normalAt(p, b), normalAt(q, b));
    if (smooth) { edge.soft = true; edge.smooth = true; }
  }
}

/**
 * The outline of a group of coplanar polygons: one counterclockwise outer loop about the group's normal, then its
 * holes. Where the outline passes through a vertex twice, each loop keeps to its own side by taking the outgoing
 * edge that turns least clockwise. Null when the group does not form one outer loop, so its polygons stay separate.
 */
function boundaryLoops(members: number[], polygons: Polygon[], points: Vec3[], directed: Map<string, number>, group: Int32Array): number[][] | null {
  const own = group[members[0]!]!, normal = polygons[members[0]!]!.normal;
  const outgoing = new Map<number, number[]>();
  let remaining = 0;
  for (const m of members) {
    const ring = polygons[m]!.ring;
    ring.forEach((a, k) => {
      const b = ring[(k + 1) % ring.length]!, back = directed.get(`${b}>${a}`);
      if (back !== undefined && group[back] === own) return;
      (outgoing.get(a) ?? outgoing.set(a, []).get(a)!).push(b);
      remaining++;
    });
  }
  const { u, v } = planeBasis([0, 0, 0], normal);
  const angle = (from: number, to: number): number => {
    const d = v3sub(points[to]!, points[from]!);
    return Math.atan2(v3dot(d, v), v3dot(d, u));
  };
  const loops: number[][] = [];
  while (remaining) {
    const start = [...outgoing].find(([, list]) => list.length)![0];
    const loop = [start];
    let previous = start, current = outgoing.get(start)!.pop()!;
    remaining--;
    while (current !== start) {
      // Every step uses up one boundary edge, so a walk that finds none left is not closed.
      const options = outgoing.get(current);
      if (!options?.length) return null;
      // Smallest clockwise turn from the reversed incoming direction keeps each loop on its own side.
      const back = angle(current, previous);
      let best = 0, bestTurn = Infinity;
      options.forEach((next, k) => {
        const turn = ((back - angle(current, next)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
        if (turn < bestTurn) { bestTurn = turn; best = k; }
      });
      const next = options.splice(best, 1)[0]!;
      remaining--;
      loop.push(current);
      previous = current; current = next;
    }
    loops.push(loop);
  }
  const signed = loops.map(loop => v3dot(newell(loop.map(i => points[i]!)), normal));
  const outer = signed.filter(area => area > 0);
  if (outer.length !== 1 || signed.some(area => area === 0)) return null;
  const k = signed.findIndex(area => area > 0);
  return [loops[k]!, ...loops.filter((_, i) => i !== k)];
}
