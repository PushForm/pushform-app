// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL, VERTEX_NORMAL_TOL, v3dot, v3len, v3normalize, type Vec3 } from '@pushform/core';
import type { Definition, Instance, Material } from 'openskp';
import type { OcctMesh, OcctNode } from 'occt-import-js';
import { linearToSrgb } from './gltf';
import {
  IDENTITY_PLACEMENT, buildMeshGeometry, finishMeshImport, meshCountNotes, meshDefinition, meshMaterial,
  type MeshCorner, type MeshCounts, type MeshGeometry, type MeshPlacement,
} from './meshImport';
import { MAX_SKETCHUP_BYTES, type ImportFormat, type ImportProgress, type SketchUpImport } from './sketchup';
import { loadStepReader } from './stepModule';

// STEP (ISO 10303-21) import. OpenCascade reads the B-rep and divides each face into triangles in meters; the parts
// and assemblies are rebuilt as the reader model the .skp importer converts, so solids and sheets follow its rules.

export const STEP_FORMAT: ImportFormat = { kind: 'step', name: 'STEP', notes: [
  'STEP import: solids and surfaces are imported with the assembly structure, part names and colors; curved surfaces are divided into smoothed facets. Product data, tolerances and annotations (PMI) are not imported.',
] };

/**
 * The largest STEP file the desktop app reads; the browser keeps the limit every import shares. Reading takes about
 * thirteen times the file's size in memory, and the reader's wasm memory ends at 4 GiB.
 */
export const MAX_DESKTOP_STEP_BYTES = 256 * 1024 * 1024;

export function isStepModelFile(name: string): boolean { return /\.(step|stp)$/i.test(name); }

/** A STEP physical file: `ISO-10303-21;` after an optional byte order mark and white space. */
export function isStepBytes(bytes: Uint8Array): boolean {
  return /^\uFEFF?\s*ISO-10303-21\s*;/.test(new TextDecoder().decode(bytes.subarray(0, 256)));
}

/** Full turns are divided into 24 segments, as circles drawn in PushForm are. */
const ANGULAR_DEFLECTION = Math.PI / 12;
/** The largest gap between a curved surface and its facets, as a fraction of each part's size. */
const LINEAR_DEFLECTION_RATIO = 0.001;

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

/** Read a STEP file of at most `maxBytes` (the shared import limit unless the desktop app allows more). */
export async function readStep(bytes: Uint8Array, onProgress?: (p: ImportProgress) => void, maxBytes = MAX_SKETCHUP_BYTES): Promise<SketchUpImport> {
  if (bytes.byteLength > maxBytes) throw new Error(`STEP files larger than ${maxBytes / (1024 * 1024)} MiB are not supported yet.`);
  if (!isStepBytes(bytes)) throw new Error('Not a STEP model: the file does not begin with ISO-10303-21.');
  onProgress?.({ stage: 'Loading the STEP reader', current: 0, total: 1 });
  const reader = await loadStepReader();
  onProgress?.({ stage: 'Reading STEP model', current: 0, total: 1 });
  const result = reader.ReadStepFile(bytes, {
    linearUnit: 'meter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: LINEAR_DEFLECTION_RATIO, angularDeflection: ANGULAR_DEFLECTION,
  });
  if (!result.success) throw new Error('This STEP file could not be read: its data is malformed or uses a schema the reader does not support.');
  // The reader can run out of memory dividing the surfaces of a very large model after reading its parts.
  if (result.meshes.some(mesh => mesh.brep_faces.length) && !result.meshes.some(mesh => mesh.index.array.length))
    throw new Error('The STEP reader read this model\'s parts but could not divide their surfaces into faces. The model may be too large for the STEP reader.');
  onProgress?.({ stage: 'Reading STEP model', current: 1, total: 1 });

  const warnings = new Set<string>(), counts: MeshCounts = { degenerate: 0, nonplanar: 0, duplicates: 0, turned: 0 };
  const materials: Material[] = [], materialKeys = new Map<string, number>();
  const materialKey = (color: readonly number[] | null | undefined): number | null => {
    if (!color || color.length < 3) return null;
    const srgb: Vec3 = [linearToSrgb(color[0]!), linearToSrgb(color[1]!), linearToSrgb(color[2]!)];
    const hex = srgb.map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
    let key = materialKeys.get(hex);
    if (key === undefined) {
      key = materials.length;
      materialKeys.set(hex, key);
      materials.push(meshMaterial(key, `Color ${hex}`, srgb, 1, null));
    }
    return key;
  };

  const geometry = (mesh: OcctMesh): MeshGeometry => {
    const positions = mesh.attributes.position.array, normals = mesh.attributes.normal?.array, index = mesh.index.array;
    const corner = (i: number): MeshCorner => {
      const n: Vec3 | null = normals ? [normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!] : null;
      return { position: [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!], normal: n && v3len(n) > LENGTH_TOL ? v3normalize(n) : null, uv: null };
    };
    const out: MeshGeometry = { polygons: [], lines: [] };
    const triangles = index.length / 3;
    // Each B-rep face is a run of triangles, with its own color or else the part's. A flat face's triangles join into
    // one face again; a curved face's facets stay faces of their own, since facets finer than the merge tolerance that
    // were joined across a slight bend would no longer meet their neighbours.
    const faces = mesh.brep_faces.length ? mesh.brep_faces : [{ first: 0, last: triangles - 1, color: null }];
    const minCos = Math.cos(VERTEX_NORMAL_TOL);
    for (const face of faces) {
      const material = materialKey(face.color ?? mesh.color), first = Math.max(0, face.first), last = Math.min(face.last, triangles - 1);
      const polygons = [];
      for (let t = first; t <= last; t++) polygons.push([corner(index[t * 3]!), corner(index[t * 3 + 1]!), corner(index[t * 3 + 2]!)]);
      const reference = polygons[0]?.find(c => c.normal)?.normal;
      const flat = !!reference && polygons.every(corners => corners.every(c => !c.normal || v3dot(c.normal, reference) >= minCos));
      for (const corners of polygons) out.polygons.push({ material, corners, keep: !flat });
    }
    return out;
  };

  const meshes = result.meshes;
  const hasTriangles = (i: number): boolean => (meshes[i]?.index.array.length ?? 0) >= 3;
  const hasContent = (node: OcctNode): boolean => node.meshes.some(hasTriangles) || node.children.some(hasContent);
  const placements = new Map<number, Map<number, MeshPlacement>>(), definitions = new Map<number, Definition>();
  const root = meshDefinition(-1, '', false);
  const build = (def: Definition, source: MeshGeometry): void => {
    const byFace = new Map<number, MeshPlacement>();
    buildMeshGeometry(def, source, counts, () => false, byFace, { paintBacks: true });
    if (byFace.size) placements.set(def.id, byFace);
  };
  let nextKey = 0, built = 0;
  const total = meshes.filter((_, i) => hasTriangles(i)).length;
  const group = (parent: Definition, name: string): Definition => {
    const key = nextKey++, def = meshDefinition(key, name, true);
    definitions.set(key, def);
    const placement: Instance = { name, refIdx: key, guid: '', matrix: [...IDENTITY_PLACEMENT], materialId: null, hidden: false, layer: '', properties: {} };
    parent.instances.push(placement);
    return def;
  };
  const part = (def: Definition, mesh: OcctMesh): void => {
    onProgress?.({ stage: 'Building parts', current: built++, total });
    build(def, geometry(mesh));
  };
  // The reader places every part in world coordinates. Each part is its own group, so parts that touch are not welded
  // into one another; an assembly is a group of its parts and subassemblies; a part alone in its node is that node.
  const fill = (def: Definition, node: OcctNode): void => {
    const parts = node.meshes.filter(hasTriangles).map(i => meshes[i]!), children = node.children.filter(hasContent);
    if (parts.length === 1 && !children.length) { part(def, parts[0]!); return; }
    parts.forEach((mesh, i) => part(group(def, mesh.name || (node.name ? `${node.name} ${i + 1}` : `Part ${i + 1}`)), mesh));
    children.forEach((child, i) => fill(group(def, child.name || `Assembly ${i + 1}`), child));
  };
  // An assembly wrapper with a single item, as most files have at the top, is the model itself.
  let top = result.root;
  for (let only = top.children.filter(hasContent); !top.meshes.some(hasTriangles) && only.length === 1; only = top.children.filter(hasContent)) top = only[0]!;
  fill(root, top);

  const header = stepHeader(bytes);
  const version = [header.schema, header.system].filter(Boolean).join(', ') || 'STEP';
  meshCountNotes(counts, message => { warnings.add(message); });
  const model = { version, definitions, root, layers: [], pages: [], scenesUnread: 0, dimensions: [], materials,
    materialsById: new Map(materials.map(m => [m.id!, m])), styles: [], units: null, unitsOptions: null, sectionDisplay: null, renderingOptions: null };
  return finishMeshImport(model, placements, STEP_FORMAT, warnings, onProgress);
}
