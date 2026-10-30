// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  AREA_TOL, LENGTH_TOL, RATIO_TOL, basisToLocal, m4identity, m4invert, m4mul, m4rotationAxis, m4scaling, m4transformDir, m4transformPoint, m4translation,
  planeBasis, v3len, v3normalize, type MMat4, type Vec2, type Vec3,
} from '@pushform/core';
import { signedArea, triangulatePolygon } from '@pushform/geom';
import type { Definition, Instance, Material, SkpModel } from 'openskp';
import {
  INCH, archiveFile, buildMeshGeometry, finishMeshImport, meshCountNotes, meshDefinition, setTextureTileSizes,
  type ArchiveResources, type MeshCorner, type MeshGeometry, type MeshPlacement,
} from './meshImport';
import { MAX_SKETCHUP_BYTES, type ImportFormat, type ImportProgress, type SketchUpImport } from './sketchup';
import { child, childrenNamed, parseXml, type XmlElement } from './xml';

// COLLADA (.dae) import. The scene is rebuilt as the reader model the .skp importer
// converts, so solids, sheets, components and materials follow the same rules as a .skp import.

export const MAX_COLLADA_BYTES = MAX_SKETCHUP_BYTES;
export const COLLADA_FORMAT: ImportFormat = { kind: 'collada', name: 'COLLADA', notes: [
  'COLLADA import: geometry, nodes, instanced nodes and materials are imported, with textures from .zip and .kmz archives. Cameras, lights, animations and skinned meshes are not imported.',
] };

/** COLLADA models: a `.dae` file, or a `.zip` or `.kmz` (Google Earth) archive holding one with its images. */
export function isColladaModelFile(name: string): boolean { return /\.(dae|zip|kmz)$/i.test(name); }

/** Whether the bytes begin like an XML document (after an optional byte-order mark and white space). */
export function isXmlBytes(bytes: Uint8Array): boolean {
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  return bytes[i] === 0x3c;
}

/**
 * Parse and prepare off the UI thread. No document is mutated until this succeeds. `resources` are the files of
 * the archive the model came from, where its texture images are found.
 */
export async function readCollada(bytes: Uint8Array, onProgress?: (p: ImportProgress) => void, resources?: ArchiveResources): Promise<SketchUpImport> {
  if (bytes.byteLength > MAX_COLLADA_BYTES) throw new Error('COLLADA files larger than 128 MiB are not supported yet.');
  onProgress?.({ stage: 'Reading COLLADA model', current: 0, total: 1 });
  let root: XmlElement;
  try { root = parseXml(new TextDecoder().decode(bytes)); } catch (cause) {
    throw new Error(`Could not read this COLLADA file: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (root.name !== 'COLLADA') throw new Error('Not a COLLADA model: the document root is not <COLLADA>.');
  const warnings = new Set<string>();
  const { model, placements } = colladaModel(root, message => { warnings.add(message); }, resources);
  onProgress?.({ stage: 'Reading COLLADA model', current: 1, total: 1 });
  return finishMeshImport(model, placements, COLLADA_FORMAT, warnings, onProgress);
}


/** COLLADA axes to PushForm's Z-up: right stays +X, up becomes +Z and "in" becomes -Y (column-major). */
const UP_AXES: Record<string, MMat4> = {
  Z_UP: m4identity(),
  Y_UP: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1],
  X_UP: [0, 0, 1, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 1],
};

const numbers = (text: string | undefined): number[] => {
  const trimmed = text?.trim();
  return trimmed ? trimmed.split(/\s+/).map(Number) : [];
};


/**
 * Rebuild a COLLADA scene as the reader model: nodes become groups, nodes placed through `<instance_node>`
 * become shared components, and each node's meshes become its faces, merged into polygons where adjacent
 * coplanar triangles share a material. Positions are converted to inches (the reader model's unit) in Z-up axes.
 * `placements` holds each face's texture placement by definition key and face id.
 */
export function colladaModel(root: XmlElement, warn: (message: string) => void, resources?: ArchiveResources):
  { model: SkpModel; placements: Map<number, Map<number, MeshPlacement>> } {
  const ids = new Map<string, XmlElement>();
  const counts = { cameras: 0, lights: 0, controllers: 0, textured: 0, degenerate: 0, nonplanar: 0, duplicates: 0, turned: 0, transforms: 0 };
  const placements = new Map<number, Map<number, MeshPlacement>>();
  const index = (element: XmlElement): void => {
    const id = element.attrs.id;
    if (id && !ids.has(id)) ids.set(id, element);
    if (element.name === 'instance_camera') counts.cameras++;
    else if (element.name === 'instance_light') counts.lights++;
    else if (element.name === 'instance_controller') counts.controllers++;
    for (const item of element.children) index(item);
  };
  index(root);
  const lookup = (url: string | undefined, name: string): XmlElement | undefined => {
    const target = url?.startsWith('#') ? ids.get(url.slice(1)) : undefined;
    return target?.name === name ? target : undefined;
  };

  const asset = child(root, 'asset');
  const meter = Number(child(asset ?? root, 'unit')?.attrs.meter ?? 1);
  const scale = Number.isFinite(meter) && meter > 0 ? meter : 1;
  if (scale !== meter) warn('The file\'s unit is invalid; its lengths are read as meters.');
  const upName = child(asset ?? root, 'up_axis')?.text.trim() || 'Y_UP';
  const axes = UP_AXES[upName] ?? UP_AXES.Y_UP!;
  if (!UP_AXES[upName]) warn(`Unknown up axis "${upName}"; the model is read as Y-up.`);
  // Every placement is conjugated by the unit and axis change, so each definition keeps Z-up coordinates in meters.
  const convert = m4mul(axes, m4scaling([scale, scale, scale])), unconvert = m4invert(convert)!;

  /** An image's file in the archive: its path relative to the model, else the one file of that name. */
  /** An image's file in the archive. */
  const imageFile = (image: XmlElement): { name: string; data: Uint8Array } | null => {
    const from = child(image, 'init_from');
    return archiveFile(resources, child(from ?? image, 'ref')?.text ?? from?.text ?? '');
  };
  const materials: Material[] = [], materialKeys = new Map<string, number | null>();
  const materialKey = (id: string): number | null => {
    const known = materialKeys.get(id);
    if (known !== undefined) return known;
    const element = ids.get(id);
    if (element?.name !== 'material') { materialKeys.set(id, null); return null; }
    const key = materials.length;
    materials.push(readMaterial(element, key, lookup, ids, imageFile, counts));
    materialKeys.set(id, key);
    return key;
  };
  const textured = (material: number | null): boolean => material !== null && !!materials[material]?.texture;

  const sources = new Map<string, (i: number) => number[] | null>(), sourceIds = new Map<XmlElement, number>();
  /** Reads `size` values of each element of a `<source>`, by index; null for a missing or non-numeric one. */
  const accessor = (element: XmlElement | undefined, size: number): ((i: number) => number[] | null) | null => {
    if (!element) return null;
    const id = sourceIds.get(element) ?? sourceIds.set(element, sourceIds.size).get(element)!, cacheKey = `${id}:${size}`;
    const cached = sources.get(cacheKey);
    if (cached) return cached;
    const data = numbers(child(element, 'float_array')?.text);
    const info = child(child(element, 'technique_common') ?? element, 'accessor');
    const stride = Number(info?.attrs.stride ?? size), offset = Number(info?.attrs.offset ?? 0);
    const count = Number(info?.attrs.count ?? Math.floor(data.length / (stride || 1)));
    const read = (i: number): number[] | null => {
      if (!Number.isInteger(i) || i < 0 || i >= count || stride < size) return null;
      const at = offset + i * stride, value = Array.from({ length: size }, (_, k) => data[at + k] ?? NaN);
      return value.every(Number.isFinite) ? value : null;
    };
    sources.set(cacheKey, read);
    return read;
  };
  const points = (element: XmlElement | undefined): ((i: number) => Vec3 | null) | null => {
    const read = accessor(element, 3);
    return read ? (i: number) => read(i) as Vec3 | null : null;
  };

  const geometryOf = (geometry: XmlElement, bindings: Map<string, { target: string; set: number | null }>): MeshGeometry => {
    const out: MeshGeometry = { polygons: [], lines: [] };
    const mesh = child(geometry, 'mesh');
    const name = geometry.attrs.name || geometry.attrs.id || 'geometry';
    if (!mesh) { warn(`${name}: only mesh geometry is imported.`); return out; }
    const vertices = child(mesh, 'vertices');
    const vertexInput = (semantic: string): XmlElement | undefined =>
      childrenNamed(vertices ?? mesh, 'input').find(input => input.attrs.semantic === semantic);
    const positions = points(lookup(vertexInput('POSITION')?.attrs.source, 'source'));
    const vertexNormals = points(lookup(vertexInput('NORMAL')?.attrs.source, 'source'));
    const vertexTexcoords = accessor(lookup(vertexInput('TEXCOORD')?.attrs.source, 'source'), 2);
    if (!positions) { warn(`${name}: skipped, it has no vertex positions.`); return out; }
    for (const primitive of mesh.children) {
      if (!['triangles', 'polylist', 'polygons', 'trifans', 'tristrips', 'lines', 'linestrips'].includes(primitive.name)) continue;
      const inputs = childrenNamed(primitive, 'input');
      const stride = Math.max(0, ...inputs.map(input => Number(input.attrs.offset ?? 0))) + 1;
      const vertexOffset = Number(inputs.find(input => input.attrs.semantic === 'VERTEX')?.attrs.offset ?? NaN);
      const normalInput = inputs.find(input => input.attrs.semantic === 'NORMAL');
      const normals = normalInput ? points(lookup(normalInput.attrs.source, 'source')) : null;
      const normalOffset = Number(normalInput?.attrs.offset ?? 0);
      if (!Number.isInteger(vertexOffset)) { warn(`${name}: a ${primitive.name} element without vertices is skipped.`); continue; }
      const symbol = primitive.attrs.material, bound = symbol === undefined ? undefined : bindings.get(symbol);
      // Edges carry no material, so a line's material (SketchUp's edge colors) is not imported.
      const lines = primitive.name === 'lines' || primitive.name === 'linestrips';
      const material = symbol === undefined || lines ? null : materialKey((bound?.target ?? `#${symbol}`).replace(/^#/, ''));
      // The texture coordinate set the material binds, else the first.
      const texcoordInputs = inputs.filter(input => input.attrs.semantic === 'TEXCOORD');
      const texcoordInput = texcoordInputs.find(input => bound?.set !== null && bound?.set !== undefined && Number(input.attrs.set ?? 0) === bound.set) ?? texcoordInputs[0];
      const texcoords = texcoordInput ? accessor(lookup(texcoordInput.attrs.source, 'source'), 2) : null;
      const texcoordOffset = Number(texcoordInput?.attrs.offset ?? 0);
      let malformed = false;
      const corners = (p: number[]): MeshCorner[] => {
        const list: MeshCorner[] = [];
        for (let k = 0; k * stride < p.length; k++) {
          const at = p[k * stride + vertexOffset];
          const position = at === undefined ? null : positions(at);
          if (!position) { malformed = true; return []; }
          const normal = normals ? normals(p[k * stride + normalOffset] ?? -1) : vertexNormals ? vertexNormals(at!) : null;
          const uv = texcoords ? texcoords(p[k * stride + texcoordOffset] ?? -1) : vertexTexcoords ? vertexTexcoords(at!) : null;
          list.push({ position, normal, uv: uv as Vec2 | null });
        }
        return list;
      };
      const polygon = (list: MeshCorner[]): void => { if (list.length >= 3) out.polygons.push({ corners: list, material }); };
      const lists = childrenNamed(primitive, 'p');
      if (primitive.name === 'triangles') {
        const all = lists.flatMap(p => corners(numbers(p.text)));
        for (let i = 0; i + 2 < all.length; i += 3) polygon(all.slice(i, i + 3));
      } else if (primitive.name === 'polylist') {
        const all = lists.flatMap(p => corners(numbers(p.text)));
        let at = 0;
        for (const n of numbers(child(primitive, 'vcount')?.text)) {
          if (!Number.isInteger(n) || n < 0 || at + n > all.length) { malformed = true; break; }
          polygon(all.slice(at, at + n)); at += n;
        }
      } else if (primitive.name === 'polygons') {
        for (const p of lists) polygon(corners(numbers(p.text)));
        // A polygon with holes is cut into triangles that join back into one face with those holes.
        for (const ph of childrenNamed(primitive, 'ph')) {
          const outline = child(ph, 'p');
          if (!outline) continue;
          for (const triangle of holedTriangles([corners(numbers(outline.text)), ...childrenNamed(ph, 'h').map(h => corners(numbers(h.text)))])) polygon(triangle);
        }
      } else if (primitive.name === 'trifans') {
        for (const p of lists) {
          const fan = corners(numbers(p.text));
          for (let i = 1; i + 1 < fan.length; i++) polygon([fan[0]!, fan[i]!, fan[i + 1]!]);
        }
      } else if (primitive.name === 'tristrips') {
        for (const p of lists) {
          const strip = corners(numbers(p.text));
          for (let i = 0; i + 2 < strip.length; i++)
            polygon(i % 2 === 0 ? [strip[i]!, strip[i + 1]!, strip[i + 2]!] : [strip[i + 1]!, strip[i]!, strip[i + 2]!]);
        }
      } else {
        for (const p of lists) {
          const chain = corners(numbers(p.text));
          const step = primitive.name === 'lines' ? 2 : 1;
          for (let i = 0; i + 1 < chain.length; i += step) out.lines.push([chain[i]!.position, chain[i + 1]!.position]);
        }
      }
      if (malformed) warn(`${name}: a ${primitive.name} element with invalid indices or coordinates is skipped.`);
    }
    return out;
  };

  const nodeMatrix = (node: XmlElement): MMat4 => {
    let matrix = m4identity();
    for (const element of node.children) {
      const v = numbers(element.text);
      let step: MMat4 | null = null;
      if (element.name === 'matrix' && v.length === 16) step = Array.from({ length: 16 }, (_, i) => v[(i % 4) * 4 + Math.floor(i / 4)]!);
      else if (element.name === 'translate' && v.length === 3) step = m4translation([v[0]!, v[1]!, v[2]!]);
      else if (element.name === 'scale' && v.length === 3) step = m4scaling([v[0]!, v[1]!, v[2]!]);
      else if (element.name === 'rotate' && v.length === 4) {
        const axis: Vec3 = [v[0]!, v[1]!, v[2]!];
        if (v3len(axis) > LENGTH_TOL) step = m4rotationAxis(axis, v[3]! * Math.PI / 180);
        else continue;
      } else if (['matrix', 'translate', 'scale', 'rotate', 'lookat', 'skew'].includes(element.name)) { counts.transforms++; continue; }
      else continue;
      if (!step.every(Number.isFinite)) { counts.transforms++; continue; }
      matrix = m4mul(matrix, step);
    }
    return matrix;
  };
  /** A source-space node transform as the reader model's 16 column-major values, with translation in inches. */
  const placement = (matrix: MMat4): number[] => {
    const out = m4mul(m4mul(convert, matrix), unconvert);
    out[12] = out[12]! / INCH; out[13] = out[13]! / INCH; out[14] = out[14]! / INCH;
    return out;
  };
  const instance = (name: string, refIdx: number, matrix: MMat4): Instance => ({
    name, refIdx, guid: '', matrix: placement(matrix), materialId: null, hidden: false, layer: '', properties: {},
  });

  const definitions = new Map<number, Definition>(), components = new Map<XmlElement, number>();
  let nextKey = 0;
  const nodeName = (node: XmlElement): string => node.attrs.name ?? node.attrs.id ?? '';
  /** A node placed through `<instance_node>` is one shared component definition, however often it is placed. */
  const component = (node: XmlElement): number => {
    const known = components.get(node);
    if (known !== undefined) return known;
    const key = nextKey++, def = meshDefinition(key, nodeName(node), false);
    // Registered before filling, so a node that places itself is a cyclic reference the converter reports.
    components.set(node, key); definitions.set(key, def);
    fill(def, node);
    return key;
  };
  const hasContent = (node: XmlElement): boolean => node.children.some(item =>
    item.name === 'instance_geometry' || item.name === 'instance_node' || (item.name === 'node' && hasContent(item)));
  const place = (parent: Definition, node: XmlElement): void => {
    const matrix = nodeMatrix(node), nested = childrenNamed(node, 'instance_node');
    // A node holding only one instanced node is that component's placement, not a group around it.
    if (nested.length === 1 && !childrenNamed(node, 'instance_geometry').length && !childrenNamed(node, 'node').some(hasContent)) {
      const target = lookup(nested[0]!.attrs.url, 'node');
      if (!target) { warn(`${nodeName(node) || 'A node'}: skipped, it places a missing node.`); return; }
      parent.instances.push(instance(nodeName(node) || nodeName(target), component(target), m4mul(matrix, nodeMatrix(target))));
      return;
    }
    if (!hasContent(node)) return;
    const key = nextKey++, def = meshDefinition(key, nodeName(node), true);
    definitions.set(key, def);
    fill(def, node);
    parent.instances.push(instance(nodeName(node), key, matrix));
  };
  const fill = (def: Definition, node: XmlElement): void => {
    const geometry: MeshGeometry = { polygons: [], lines: [] };
    for (const placed of childrenNamed(node, 'instance_geometry')) {
      const target = lookup(placed.attrs.url, 'geometry');
      if (!target) { warn(`${nodeName(node) || 'A node'}: a missing geometry is skipped.`); continue; }
      const bindings = new Map<string, { target: string; set: number | null }>();
      for (const bind of childrenNamed(child(child(placed, 'bind_material') ?? placed, 'technique_common') ?? placed, 'instance_material')) {
        const input = childrenNamed(bind, 'bind_vertex_input').find(item => item.attrs.input_semantic === 'TEXCOORD');
        if (bind.attrs.symbol && bind.attrs.target)
          bindings.set(bind.attrs.symbol, { target: bind.attrs.target, set: input ? Number(input.attrs.input_set ?? 0) : null });
      }
      const source = geometryOf(target, bindings);
      const point = (p: Vec3): Vec3 => m4transformPoint(convert, p) as Vec3;
      for (const polygon of source.polygons) geometry.polygons.push({ material: polygon.material, corners: polygon.corners.map(c => ({
        position: point(c.position), normal: c.normal && v3len(c.normal) > LENGTH_TOL ? v3normalize(m4transformDir(axes, c.normal)) : null,
        uv: c.uv })) });
      for (const [a, b] of source.lines) geometry.lines.push([point(a), point(b)]);
    }
    const byFace = new Map<number, MeshPlacement>();
    buildMeshGeometry(def, geometry, counts, textured, byFace);
    if (byFace.size) placements.set(def.id, byFace);
    for (const placed of childrenNamed(node, 'instance_node')) {
      const target = lookup(placed.attrs.url, 'node');
      if (!target) { warn(`${nodeName(node) || 'A node'}: a placement of a missing node is skipped.`); continue; }
      def.instances.push(instance(nodeName(target), component(target), nodeMatrix(target)));
    }
    for (const item of childrenNamed(node, 'node')) place(def, item);
  };

  const scenes = childrenNamed(child(root, 'library_visual_scenes') ?? root, 'visual_scene');
  const chosen = lookup(child(child(root, 'scene') ?? root, 'instance_visual_scene')?.attrs.url, 'visual_scene') ?? scenes[0];
  if (!chosen) throw new Error('No supported geometry was found in this COLLADA file: it has no visual scene.');
  const top = meshDefinition(-1, '', false);
  const nodes = childrenNamed(chosen, 'node');
  // A scene whose one node holds the model at its origin (SketchUp exports wrap everything in one) is the model itself.
  const wrapper = nodes.length === 1 ? nodes[0]! : null;
  if (wrapper && isIdentity(nodeMatrix(wrapper))) fill(top, wrapper);
  else for (const node of nodes) place(top, node);

  setTextureTileSizes(materials, placements, key => key === -1 ? top : definitions.get(key));
  if (counts.textured) warn(resources
    ? `${counts.textured} texture image${counts.textured === 1 ? ' is' : 's are'} missing from the archive; ${counts.textured === 1 ? 'its material uses its' : 'their materials use their'} color.`
    : `${counts.textured} textured material${counts.textured === 1 ? ' uses its' : 's use their'} color: textures are imported from a .zip or .kmz archive that holds the model with its images.`);
  if (counts.cameras || counts.lights) warn('Cameras and lights are not imported.');
  if (counts.controllers) warn(`${counts.controllers} skinned or morphed mesh${counts.controllers === 1 ? ' is' : 'es are'} not imported.`);
  if (child(root, 'library_animations')) warn('Animations are not imported; the model is imported in its rest position.');
  meshCountNotes(counts, warn);
  if (counts.transforms) warn(`${counts.transforms} unsupported or invalid node transform${counts.transforms === 1 ? ' is' : 's are'} ignored.`);

  const version = [root.attrs.version, child(child(asset ?? root, 'contributor') ?? root, 'authoring_tool')?.text.trim()]
    .filter(Boolean).join(', ').slice(0, 100);
  return { placements, model: {
    version, definitions, root: top, layers: [], pages: [], scenesUnread: 0, dimensions: [],
    materials, materialsById: new Map(materials.map(m => [m.id!, m])), styles: [], units: null, unitsOptions: null, sectionDisplay: null, renderingOptions: null,
  } };
}

/**
 * A polygon's outline and holes as triangles wound like the outline, triangulated in the outline's plane. An outline
 * that encloses no area comes back alone, to be counted as such.
 */
function holedTriangles(rings: MeshCorner[][]): MeshCorner[][] {
  const outline = rings[0];
  if (!outline || outline.length < 3) return [];
  const sum: [number, number, number] = [0, 0, 0];
  outline.forEach((c, k) => {
    const p = c.position, q = outline[(k + 1) % outline.length]!.position;
    sum[0] += (p[1] - q[1]) * (p[2] + q[2]); sum[1] += (p[2] - q[2]) * (p[0] + q[0]); sum[2] += (p[0] - q[0]) * (p[1] + q[1]);
  });
  if (v3len(sum) / 2 <= AREA_TOL) return [outline];
  const basis = planeBasis(outline[0]!.position, v3normalize(sum));
  // The outline runs counterclockwise about its own normal; holes are turned clockwise, as the triangulation expects.
  const ordered = rings.filter(ring => ring.length >= 3).map((ring, i) => {
    const area = signedArea(ring.map(c => basisToLocal(basis, c.position)));
    return i > 0 && area > 0 ? [...ring].reverse() : ring;
  });
  const corners = ordered.flat();
  const { coords, indices } = triangulatePolygon(ordered.map(ring => ring.map(c => { const [x, y] = basisToLocal(basis, c.position); return [x, y]; })));
  const at = (v: number): [number, number] => [coords[v * 2]!, coords[v * 2 + 1]!];
  const triangles: [number, number, number][] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) triangles.push([indices[i]!, indices[i + 1]!, indices[i + 2]!]);
  // Where holes' edges line up, the triangulation leaves zero-area triangles and corners lying inside other triangles'
  // edges, which would join the holes into one. Those triangles are dropped and those edges split at the corner.
  const area = ([u, v, w]: [number, number, number]): number => {
    const [p, q, r] = [at(u), at(v), at(w)];
    return Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / 2;
  };
  const onEdge = (v: number, u: number, w: number): boolean => {
    const p = at(v), a = at(u), b = at(w), dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (length <= LENGTH_TOL) return false;
    const along = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length;
    return along > LENGTH_TOL && along < length - LENGTH_TOL && Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / length <= LENGTH_TOL;
  };
  const work = triangles.filter(tri => area(tri) > AREA_TOL), out: [number, number, number][] = [];
  while (work.length && out.length + work.length < indices.length * 4) {
    const tri = work.pop()!;
    let split = false;
    for (let k = 0; k < 3 && !split; k++) {
      const u = tri[k]!, w = tri[(k + 1) % 3]!, apex = tri[(k + 2) % 3]!;
      const v = corners.findIndex((_, i) => i !== u && i !== w && onEdge(i, u, w));
      if (v >= 0) { work.push([u, v, apex], [v, w, apex]); split = true; }
    }
    if (!split) out.push(tri);
  }
  return [...out, ...work].map(tri => tri.map(v => corners[v]!));
}

function isIdentity(matrix: MMat4): boolean {
  return matrix.every((value, i) => Math.abs(value - (i % 5 === 0 ? 1 : 0)) <= (i >= 12 ? LENGTH_TOL : RATIO_TOL));
}

/** Every descendant of an element, depth first. */
function descendants(element: XmlElement): XmlElement[] {
  return element.children.flatMap(item => [item, ...descendants(item)]);
}

/**
 * A `<material>`'s color, opacity and texture image from its common-profile effect (COLLADA 1.4 §7, "Determining
 * Transparency"). A `<texture>` names a sampler, whose surface names the image (1.4), or a sampler that places an
 * image (1.5), or the image itself. The texture's tile size is set once its placements are known.
 */
function readMaterial(element: XmlElement, key: number, lookup: (url: string | undefined, name: string) => XmlElement | undefined,
  ids: Map<string, XmlElement>, imageFile: (image: XmlElement) => { name: string; data: Uint8Array } | null, counts: { textured: number }): Material {
  const effect = lookup(child(element, 'instance_effect')?.attrs.url, 'effect');
  const technique = child(child(effect ?? element, 'profile_COMMON') ?? element, 'technique');
  const shading = technique?.children.find(item => ['constant', 'lambert', 'phong', 'blinn'].includes(item.name));
  const colorOf = (name: string): number[] | null => {
    const value = numbers(child(child(shading ?? element, name) ?? element, 'color')?.text);
    return value.length >= 3 && value.every(Number.isFinite) ? value : null;
  };
  const surface = shading?.name === 'constant' ? 'emission' : 'diffuse';
  const textureRef = child(child(shading ?? element, surface) ?? element, 'texture')?.attrs.texture;
  let texture: Material['texture'] = null;
  if (textureRef !== undefined) {
    const params = new Map((effect ? descendants(effect) : []).filter(item => item.name === 'newparam' && item.attrs.sid).map(item => [item.attrs.sid!, item]));
    const sampler = child(params.get(textureRef) ?? element, 'sampler2D');
    const surfaceParam = params.get(child(sampler ?? element, 'source')?.text.trim() ?? '');
    const imageId = child(child(surfaceParam ?? element, 'surface') ?? element, 'init_from')?.text.trim();
    const image = (imageId !== undefined ? ids.get(imageId) : undefined) ?? lookup(child(sampler ?? element, 'instance_image')?.attrs.url, 'image') ??
      (ids.get(textureRef)?.name === 'image' ? ids.get(textureRef) : undefined);
    const file = image?.name === 'image' ? imageFile(image) : null;
    if (file) texture = { filename: file.name, width: 1 / INCH, height: 1 / INCH, data: file.data };
    else counts.textured++;
  }
  const [r, g, b] = (colorOf(surface) ?? [1, 1, 1]).map(c => Math.max(0, Math.min(1, c)) * 255) as [number, number, number];
  let opacity = 1;
  const transparent = child(shading ?? element, 'transparent'), filter = colorOf('transparent');
  if (transparent && filter) {
    const amount = Number(child(child(shading ?? element, 'transparency') ?? element, 'float')?.text ?? 1);
    const f = Number.isFinite(amount) ? amount : 1, alpha = filter[3] ?? 1;
    const luminance = filter[0]! * 0.212671 + filter[1]! * 0.71516 + filter[2]! * 0.072169;
    const mode = transparent.attrs.opaque ?? 'A_ONE';
    opacity = mode === 'RGB_ZERO' ? 1 - luminance * f : mode === 'RGB_ONE' ? luminance * f : mode === 'A_ZERO' ? 1 - alpha * f : alpha * f;
  }
  return { name: element.attrs.name || element.attrs.id || 'Material', color: { r, g, b, a: 255 },
    transparency: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1, id: key, texture, colorized: false, colorizeType: 0 };
}
