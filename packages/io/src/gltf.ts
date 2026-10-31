// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LENGTH_TOL, RATIO_TOL, m4identity, m4invert, m4mul, m4scaling, m4translation, v3len, v3normalize, type MMat4, type Vec2, type Vec3 } from '@pushform/core';
import type { Definition, Instance, Material, SkpModel } from 'openskp';
import {
  INCH, archiveFile, buildMeshGeometry, finishMeshImport, meshCountNotes, meshDefinition, meshMaterial, setTextureTileSizes,
  type ArchiveResources, type MeshCorner, type MeshGeometry, type MeshPlacement, meshPartFromGeometry,
  type MeshPartOptions,
} from './meshImport';
import { MAX_SKETCHUP_BYTES, MESH_PART_THRESHOLD, type ImportFormat, type ImportProgress, type SketchUpImport, type ImportedMeshPart } from './sketchup';

// glTF 2.0 (.gltf, .glb) import. The scene is rebuilt as the reader model the SketchUp importer
// converts, as COLLADA scenes are, so solids, sheets, components and materials follow the same rules.

export const GLTF_FORMAT: ImportFormat = { kind: 'gltf', name: 'glTF', notes: [
  'glTF import: meshes, the node hierarchy and materials (base color, opacity and base color texture) are imported. Animations, skins, morph targets, cameras, lights and extensions are not imported.',
] };

/** glTF models: a `.gltf` (JSON) or `.glb` (binary) file, or a `.zip` holding one with its buffers and images. */
export function isGltfModelFile(name: string): boolean { return /\.(gltf|glb)$/i.test(name); }

/** Whether the bytes begin with a binary glTF header (`glTF`). */
export function isGlbBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

/** Whether the bytes begin like a JSON object (after an optional byte-order mark and white space): a `.gltf` file. */
export function isGltfJson(bytes: Uint8Array): boolean {
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  return bytes[i] === 0x7b;
}

/** Extensions whose content the reader handles: quantized attributes read as any accessor, unlit materials by their base color. */
const HANDLED_EXTENSIONS = new Set(['KHR_mesh_quantization', 'KHR_materials_unlit']);
/** Extensions the report already names by what they hold (lights). */
const NOTED_EXTENSIONS = new Set(['KHR_lights_punctual']);
/** Extensions that compress geometry, without which no mesh can be read. */
const COMPRESSION_EXTENSIONS = new Set(['KHR_draco_mesh_compression', 'EXT_meshopt_compression']);

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

// The parts of the glTF 2.0 JSON the reader uses.
interface GltfAccessor {
  bufferView?: number; byteOffset?: number; componentType: number; normalized?: boolean; count: number; type: string;
  sparse?: { count: number; indices: { bufferView: number; byteOffset?: number; componentType: number }; values: { bufferView: number; byteOffset?: number } };
}
interface GltfTextureRef { index: number; texCoord?: number; extensions?: Record<string, unknown> }
interface GltfPrimitive { attributes: Record<string, number>; indices?: number; material?: number; mode?: number; targets?: unknown[]; extensions?: Record<string, unknown> }
interface GltfNode {
  name?: string; children?: number[]; mesh?: number; camera?: number; skin?: number; matrix?: number[];
  translation?: number[]; rotation?: number[]; scale?: number[]; extensions?: Record<string, unknown>;
}
interface Gltf {
  asset?: { version?: string; generator?: string };
  scene?: number; scenes?: { nodes?: number[] }[]; nodes?: GltfNode[];
  meshes?: { name?: string; primitives?: GltfPrimitive[] }[];
  accessors?: GltfAccessor[]; bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { uri?: string; byteLength: number }[];
  materials?: { name?: string; alphaMode?: string; pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: GltfTextureRef } }[];
  textures?: { source?: number; extensions?: Record<string, { source?: number }> }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string; name?: string }[];
  animations?: unknown[]; skins?: unknown[];
  extensionsUsed?: string[]; extensionsRequired?: string[];
}

/** A `.gltf` file's JSON, or a `.glb` file's JSON and binary chunk. */
function parseContainer(bytes: Uint8Array): { json: Gltf; bin: Uint8Array | null } {
  const decode = (data: Uint8Array): Gltf => {
    let json: unknown;
    try { json = JSON.parse(new TextDecoder().decode(data)); } catch (cause) {
      throw new Error(`Could not read this glTF file: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('Could not read this glTF file: it is not a JSON object.');
    return json as Gltf;
  };
  if (!isGlbBytes(bytes)) return { json: decode(bytes), bin: null };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== 2) throw new Error('Only glTF 2.0 files are supported; this binary glTF file is an older version.');
  const length = Math.min(view.getUint32(8, true), bytes.byteLength);
  let json: Gltf | null = null, bin: Uint8Array | null = null;
  for (let at = 12; at + 8 <= length;) {
    const size = view.getUint32(at, true), type = view.getUint32(at + 4, true), data = bytes.subarray(at + 8, Math.min(at + 8 + size, length));
    if (type === 0x4e4f534a && !json) json = decode(data);
    else if (type === 0x004e4942 && !bin) bin = data;
    at += 8 + size + ((4 - (size % 4)) % 4);
  }
  if (!json) throw new Error('Could not read this glTF file: the binary file has no JSON chunk.');
  return { json, bin };
}

/** The bytes of a `data:` URI (base64 or percent-encoded), or null for another URI. */
function dataUri(uri: string): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(uri);
  if (!match) return null;
  const [, mime = '', params = '', body = ''] = match;
  if (/;base64/i.test(params)) {
    const text = atob(body.replace(/\s/g, ''));
    return { bytes: Uint8Array.from(text, c => c.charCodeAt(0)), mime };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(body)), mime };
}

/** glTF base colors are linear; PushForm's material colors are sRGB. */
/** A linear color channel (0–1) as sRGB. */
export function linearToSrgb(c: number): number {
  const x = Math.max(0, Math.min(1, Number.isFinite(c) ? c : 1));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
}

/** A node's local transform: its `matrix` (column-major), else translation × rotation (quaternion x, y, z, w) × scale. */
function nodeMatrix(node: GltfNode): MMat4 | null {
  if (node.matrix) return node.matrix.length === 16 && node.matrix.every(Number.isFinite) ? [...node.matrix] : null;
  const [tx = 0, ty = 0, tz = 0] = node.translation ?? [], [sx = 1, sy = 1, sz = 1] = node.scale ?? [];
  let [x = 0, y = 0, z = 0, w = 1] = node.rotation ?? [];
  const length = Math.hypot(x, y, z, w);
  if (![tx, ty, tz, sx, sy, sz, length].every(Number.isFinite) || length <= RATIO_TOL) return null;
  x /= length; y /= length; z /= length; w /= length;
  const rotation: MMat4 = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
  return m4mul(m4mul(m4translation([tx, ty, tz]), rotation), m4scaling([sx, sy, sz]));
}

/** glTF's Y-up axes to PushForm's Z-up: right stays +X, up becomes +Z and forward (+Z) becomes -Y (column-major). */
const Y_UP: MMat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
const Y_DOWN = m4invert(Y_UP)!;
const toZUp = (p: Vec3): Vec3 => [p[0], -p[2], p[1]];

/**
 * Parse and prepare off the UI thread. No document is mutated until this succeeds. `resources` are the files of the
 * archive the model came from, where a `.gltf` file's buffers and images are found.
 */
export async function readGltf(bytes: Uint8Array, onProgress?: (p: ImportProgress) => void, resources?: ArchiveResources, parts: MeshPartOptions = {}): Promise<SketchUpImport> {
  if (bytes.byteLength > MAX_SKETCHUP_BYTES) throw new Error('glTF files larger than 128 MiB are not supported yet.');
  onProgress?.({ stage: 'Reading glTF model', current: 0, total: 1 });
  const { json, bin } = parseContainer(bytes);
  const version = json.asset?.version;
  if (typeof version !== 'string' || !version.startsWith('2.')) throw new Error(`Only glTF 2.0 files are supported; this file is glTF ${version ?? 'of an unknown version'}.`);
  const compressed = (json.extensionsRequired ?? []).filter(name => COMPRESSION_EXTENSIONS.has(name));
  if (compressed.length) throw new Error(`This glTF file's geometry is compressed (${compressed.join(', ')}), which is not supported yet.`);
  const warnings = new Set<string>();
  const { model, placements, meshParts } = gltfModel(json, bin, message => { warnings.add(message); }, resources, parts);
  onProgress?.({ stage: 'Reading glTF model', current: 1, total: 1 });
  return finishMeshImport(model, placements, GLTF_FORMAT, warnings, onProgress, { meshParts });
}

/**
 * Rebuild a glTF scene as the reader model: nodes become groups placed by their transforms, a mesh that several nodes
 * place becomes one shared component, and each mesh's primitives become faces and edges, merged into polygons where
 * adjacent coplanar triangles share a material. Positions are converted to inches (the reader model's unit) in Z-up axes.
 */
export function gltfModel(json: Gltf, bin: Uint8Array | null, warn: (message: string) => void, resources?: ArchiveResources, parts: MeshPartOptions = {}):
  { model: SkpModel; placements: Map<number, Map<number, MeshPlacement>>; meshParts: Map<number, ImportedMeshPart[]> } {
  const counts = {
    degenerate: 0, nonplanar: 0, duplicates: 0, turned: 0, points: 0, malformed: 0, morphs: 0, skinned: 0, cameras: 0, lights: 0,
    transforms: 0, textured: 0, textureTransforms: 0,
  };
  const nodes = json.nodes ?? [], meshes = json.meshes ?? [];

  // Buffers: the binary chunk of a .glb, a data URI, or a file beside the model in its archive.
  const buffers = (json.buffers ?? []).map((buffer, i): Uint8Array | null => {
    if (buffer.uri === undefined) return i === 0 ? bin : null;
    const inline = dataUri(buffer.uri);
    if (inline) return inline.bytes;
    return archiveFile(resources, buffer.uri)?.data ?? null;
  });
  // A .gltf opened alone cannot reach the files beside it, and without its buffers it has no geometry.
  const missing = (json.buffers ?? []).flatMap((buffer, i) => buffer.uri !== undefined && !dataUri(buffer.uri) && !buffers[i] ? [buffer.uri] : []);
  if (missing.length) {
    const names = missing.map(uri => { try { return decodeURIComponent(uri); } catch { return uri; } }).join(', ');
    throw new Error(`This glTF file keeps its geometry in separate files (${names}) that ${resources ? 'the archive does not hold' : 'were not imported with it'}: import a .zip archive that holds the .gltf file with its .bin and image files.`);
  }
  const viewBytes = (index: number | undefined): { bytes: Uint8Array; stride: number | undefined } | null => {
    const view = index === undefined ? undefined : json.bufferViews?.[index];
    const buffer = view ? buffers[view.buffer] : null;
    if (!view || !buffer) return null;
    const start = view.byteOffset ?? 0;
    if (start + view.byteLength > buffer.byteLength) return null;
    return { bytes: buffer.subarray(start, start + view.byteLength), stride: view.byteStride };
  };

  /** An accessor's values as numbers, `size` per element, normalized where it says so; null when it cannot be read. */
  const accessorCache = new Map<number, { size: number; values: Float64Array } | null>();
  const accessor = (index: number | undefined): { size: number; values: Float64Array } | null => {
    if (index === undefined) return null;
    if (accessorCache.has(index)) return accessorCache.get(index)!;
    const read = (): { size: number; values: Float64Array } | null => {
      const a = json.accessors?.[index], size = a ? COMPONENTS[a.type] : undefined;
      if (!a || !size || !Number.isInteger(a.count) || a.count < 0) return null;
      const values = new Float64Array(a.count * size);
      const fill = (target: Float64Array, from: { bytes: Uint8Array; stride: number | undefined }, offset: number, componentType: number,
        count: number, width: number, normalized: boolean): boolean => {
        const bytesPer = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[componentType];
        if (!bytesPer) return false;
        const stride = from.stride ?? bytesPer * width, data = new DataView(from.bytes.buffer, from.bytes.byteOffset, from.bytes.byteLength);
        if (count && offset + (count - 1) * stride + width * bytesPer > from.bytes.byteLength) return false;
        for (let i = 0; i < count; i++) for (let k = 0; k < width; k++) {
          const at = offset + i * stride + k * bytesPer;
          let v: number;
          switch (componentType) {
            case 5120: v = data.getInt8(at); if (normalized) v = Math.max(v / 127, -1); break;
            case 5121: v = data.getUint8(at); if (normalized) v /= 255; break;
            case 5122: v = data.getInt16(at, true); if (normalized) v = Math.max(v / 32767, -1); break;
            case 5123: v = data.getUint16(at, true); if (normalized) v /= 65535; break;
            case 5125: v = data.getUint32(at, true); break;
            default: v = data.getFloat32(at, true);
          }
          target[i * width + k] = v;
        }
        return true;
      };
      if (a.bufferView !== undefined) {
        const view = viewBytes(a.bufferView);
        if (!view || !fill(values, view, a.byteOffset ?? 0, a.componentType, a.count, size, !!a.normalized)) return null;
      }
      // Sparse accessors replace some elements of the base values (zeros without a buffer view).
      if (a.sparse) {
        const s = a.sparse, at = new Float64Array(s.count), replaced = new Float64Array(s.count * size);
        const indexView = viewBytes(s.indices.bufferView), valueView = viewBytes(s.values.bufferView);
        if (!indexView || !valueView || !fill(at, { bytes: indexView.bytes, stride: undefined }, s.indices.byteOffset ?? 0, s.indices.componentType, s.count, 1, false) ||
          !fill(replaced, { bytes: valueView.bytes, stride: undefined }, s.values.byteOffset ?? 0, a.componentType, s.count, size, !!a.normalized)) return null;
        for (let i = 0; i < s.count; i++) {
          const target = at[i]!;
          if (Number.isInteger(target) && target >= 0 && target < a.count) values.set(replaced.subarray(i * size, (i + 1) * size), target * size);
        }
      }
      return { size, values };
    };
    const result = read();
    accessorCache.set(index, result);
    return result;
  };

  // Materials: the base color (linear, so converted to sRGB), its alpha when the material blends, and its texture.
  const materials: Material[] = [], materialKeys = new Map<number, number | null>(), texcoordSets = new Map<number, number>();
  const imageOf = (textureRef: GltfTextureRef | undefined): { name: string; data: Uint8Array } | null | undefined => {
    if (!textureRef) return undefined;
    if (textureRef.extensions?.KHR_texture_transform) counts.textureTransforms++;
    const texture = json.textures?.[textureRef.index];
    const source = texture?.source ?? Object.values(texture?.extensions ?? {}).find(ext => typeof ext?.source === 'number')?.source;
    const image = source === undefined ? undefined : json.images?.[source];
    if (!image) return null;
    const extension = (mime: string | undefined): string => mime === 'image/jpeg' ? 'jpg' : mime?.startsWith('image/') ? mime.slice(6) : 'png';
    if (image.bufferView !== undefined) {
      const view = viewBytes(image.bufferView);
      return view ? { name: image.name ? `${image.name}.${extension(image.mimeType)}` : `image${source}.${extension(image.mimeType)}`, data: view.bytes } : null;
    }
    if (image.uri === undefined) return null;
    const inline = dataUri(image.uri);
    if (inline) return { name: `${image.name ?? `image${source}`}.${extension(inline.mime || image.mimeType)}`, data: inline.bytes };
    return archiveFile(resources, image.uri);
  };
  const materialKey = (index: number | undefined): number | null => {
    if (index === undefined) return null;
    const known = materialKeys.get(index);
    if (known !== undefined) return known;
    const source = json.materials?.[index];
    if (!source) { materialKeys.set(index, null); return null; }
    const pbr = source.pbrMetallicRoughness, factor = pbr?.baseColorFactor ?? [1, 1, 1, 1];
    const color: Vec3 = [linearToSrgb(factor[0] ?? 1), linearToSrgb(factor[1] ?? 1), linearToSrgb(factor[2] ?? 1)];
    const opacity = source.alphaMode === 'BLEND' ? factor[3] ?? 1 : 1;
    const image = imageOf(pbr?.baseColorTexture);
    if (image === null) counts.textured++;
    const key = materials.length;
    materials.push(meshMaterial(key, source.name || `Material ${index + 1}`, color, opacity, image ?? null));
    if (pbr?.baseColorTexture) texcoordSets.set(key, pbr.baseColorTexture.texCoord ?? 0);
    materialKeys.set(index, key);
    return key;
  };
  const textured = (material: number | null): boolean => material !== null && !!materials[material]?.texture;

  /** A mesh's primitives as polygons and lines in meters with Z up. */
  const meshGeometry = (mesh: { name?: string; primitives?: GltfPrimitive[] }): MeshGeometry => {
    const out: MeshGeometry = { polygons: [], lines: [] };
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.targets?.length) counts.morphs++;
      const mode = primitive.mode ?? 4;
      if (mode === 0) { counts.points++; continue; }
      const positions = accessor(primitive.attributes.POSITION);
      if (!positions || positions.size !== 3) { counts.malformed++; continue; }
      const material = mode >= 4 ? materialKey(primitive.material) : null;
      const normals = accessor(primitive.attributes.NORMAL);
      const texcoords = accessor(primitive.attributes[`TEXCOORD_${material === null ? 0 : texcoordSets.get(material) ?? 0}`]);
      const vertexCount = positions.values.length / 3;
      const indexData = primitive.indices === undefined ? null : accessor(primitive.indices);
      if (primitive.indices !== undefined && (!indexData || indexData.size !== 1)) { counts.malformed++; continue; }
      const order = indexData ? Array.from(indexData.values) : Array.from({ length: vertexCount }, (_, i) => i);
      if (order.some(i => !Number.isInteger(i) || i < 0 || i >= vertexCount)) { counts.malformed++; continue; }
      const point = (i: number): Vec3 => toZUp([positions.values[i * 3]!, positions.values[i * 3 + 1]!, positions.values[i * 3 + 2]!]);
      const corner = (i: number): MeshCorner => {
        const n = normals?.size === 3 ? toZUp([normals.values[i * 3]!, normals.values[i * 3 + 1]!, normals.values[i * 3 + 2]!]) : null;
        // glTF's texture origin is the image's top left; PushForm's is its bottom left.
        const uv: Vec2 | null = texcoords?.size === 2 ? [texcoords.values[i * 2]!, 1 - texcoords.values[i * 2 + 1]!] : null;
        return { position: point(i), normal: n && v3len(n) > LENGTH_TOL ? v3normalize(n) : null, uv: uv && uv.every(Number.isFinite) ? uv : null };
      };
      if (mode === 4) for (let i = 0; i + 2 < order.length; i += 3) out.polygons.push({ corners: [corner(order[i]!), corner(order[i + 1]!), corner(order[i + 2]!)], material });
      else if (mode === 5) for (let i = 0; i + 2 < order.length; i++) {
        const [a, b, c] = i % 2 === 0 ? [order[i]!, order[i + 1]!, order[i + 2]!] : [order[i + 1]!, order[i]!, order[i + 2]!];
        out.polygons.push({ corners: [corner(a), corner(b), corner(c)], material });
      } else if (mode === 6) for (let i = 1; i + 1 < order.length; i++) out.polygons.push({ corners: [corner(order[0]!), corner(order[i]!), corner(order[i + 1]!)], material });
      else if (mode === 1) for (let i = 0; i + 1 < order.length; i += 2) out.lines.push([point(order[i]!), point(order[i + 1]!)]);
      else if (mode === 2 || mode === 3) {
        for (let i = 0; i + 1 < order.length; i++) out.lines.push([point(order[i]!), point(order[i + 1]!)]);
        if (mode === 2 && order.length > 2) out.lines.push([point(order.at(-1)!), point(order[0]!)]);
      } else counts.malformed++;
    }
    return out;
  };

  const placements = new Map<number, Map<number, MeshPlacement>>(), definitions = new Map<number, Definition>();
  let nextKey = 0;
  // Triangles the file's accessors promise, counted before any is read, decide between faces and mesh parts.
  const promised = meshes.flatMap(mesh => mesh.primitives ?? []).reduce((n, primitive) => {
    const mode = primitive.mode ?? 4, count = json.accessors?.[primitive.indices ?? primitive.attributes.POSITION ?? -1]?.count ?? 0;
    return n + (mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0);
  }, 0);
  const asMeshParts = promised > (parts.meshPartThreshold ?? MESH_PART_THRESHOLD), meshParts = new Map<number, ImportedMeshPart[]>();
  const source = parts.source ?? { format: 'glTF', system: json.asset?.generator ?? '' };
  const build = (def: Definition, geometry: MeshGeometry): void => {
    if (asMeshParts) { meshParts.set(def.id, [meshPartFromGeometry(geometry, def.name || 'Mesh', source, counts)]); return; }
    const byFace = new Map<number, MeshPlacement>();
    buildMeshGeometry(def, geometry, counts, textured, byFace, { paintBacks: true });
    if (byFace.size) placements.set(def.id, byFace);
  };
  /** A node transform (Y-up meters) as the reader model's 16 column-major values in Z-up axes, with translation in inches. */
  const instance = (name: string, refIdx: number, matrix: MMat4): Instance => {
    const out = m4mul(m4mul(Y_UP, matrix), Y_DOWN);
    out[12] = out[12]! / INCH; out[13] = out[13]! / INCH; out[14] = out[14]! / INCH;
    return { name, refIdx, guid: '', matrix: out, materialId: null, hidden: false, layer: '', properties: {} };
  };
  const meshName = (index: number): string => meshes[index]?.name || `Mesh ${index + 1}`;

  // The nodes of the scene, and how many of them place each mesh: a mesh placed more than once is a shared component.
  const sceneIndex = json.scene ?? 0, listed = json.scenes?.[sceneIndex]?.nodes;
  const childOf = new Set(nodes.flatMap(node => node.children ?? []));
  const roots = listed ?? nodes.map((_, i) => i).filter(i => !childOf.has(i));
  const uses = new Map<number, number>(), reached = new Set<number>();
  const visit = (i: number): void => {
    const node = nodes[i];
    if (!node || reached.has(i)) return;
    reached.add(i);
    if (node.mesh !== undefined) uses.set(node.mesh, (uses.get(node.mesh) ?? 0) + 1);
    if (node.camera !== undefined) counts.cameras++;
    if (node.extensions?.KHR_lights_punctual) counts.lights++;
    if (node.skin !== undefined && node.mesh !== undefined) counts.skinned++;
    for (const c of node.children ?? []) visit(c);
  };
  roots.forEach(visit);
  const contentCache = new Map<number, boolean>();
  const hasContent = (i: number): boolean => {
    const known = contentCache.get(i);
    if (known !== undefined) return known;
    contentCache.set(i, false);
    const node = nodes[i], result = !!node && ((node.mesh !== undefined && !!meshes[node.mesh]) || (node.children ?? []).some(hasContent));
    contentCache.set(i, result);
    return result;
  };

  const components = new Map<number, number>();
  const component = (mesh: number): number => {
    const known = components.get(mesh);
    if (known !== undefined) return known;
    const key = nextKey++, def = meshDefinition(key, meshName(mesh), false);
    components.set(mesh, key); definitions.set(key, def);
    build(def, meshGeometry(meshes[mesh]!));
    return key;
  };
  const transformOf = (node: GltfNode): MMat4 => {
    const matrix = nodeMatrix(node);
    if (!matrix) counts.transforms++;
    return matrix ?? m4identity();
  };
  const placing = new Set<number>();
  const place = (parent: Definition, i: number): void => {
    const node = nodes[i];
    if (!node || !hasContent(i) || placing.has(i)) return;
    const name = node.name || (node.mesh !== undefined ? meshName(node.mesh) : '');
    const shared = node.mesh !== undefined && (uses.get(node.mesh) ?? 0) > 1;
    // A node that only places a shared mesh is that component's placement, not a group around it.
    if (shared && !(node.children ?? []).some(hasContent)) {
      parent.instances.push(instance(name, component(node.mesh!), transformOf(node)));
      return;
    }
    const key = nextKey++, def = meshDefinition(key, name, true);
    definitions.set(key, def);
    fill(def, i);
    parent.instances.push(instance(name, key, transformOf(node)));
  };
  const fill = (def: Definition, i: number): void => {
    const node = nodes[i]!;
    placing.add(i);
    if (node.mesh !== undefined && meshes[node.mesh]) {
      if ((uses.get(node.mesh) ?? 0) > 1) def.instances.push(instance(meshName(node.mesh), component(node.mesh), m4identity()));
      else build(def, meshGeometry(meshes[node.mesh]!));
    }
    for (const c of node.children ?? []) place(def, c);
    placing.delete(i);
  };

  const top = meshDefinition(-1, '', false);
  const content = roots.filter(hasContent);
  // A scene whose one node holds the model at its origin is the model itself.
  const only = content.length === 1 ? nodes[content[0]!]! : null;
  const onlyMatrix = only ? nodeMatrix(only) : null;
  if (only && onlyMatrix && isIdentity(onlyMatrix)) fill(top, content[0]!);
  else for (const i of content) place(top, i);

  setTextureTileSizes(materials, placements, key => key === -1 ? top : definitions.get(key));
  if (counts.malformed) warn(`${counts.malformed} primitive${counts.malformed === 1 ? ' with missing or invalid data is' : 's with missing or invalid data are'} skipped.`);
  if (counts.points) warn(`${counts.points} point primitive${counts.points === 1 ? ' is' : 's are'} not imported.`);
  if (counts.textured) warn(resources
    ? `${counts.textured} texture image${counts.textured === 1 ? ' is' : 's are'} missing from the archive; ${counts.textured === 1 ? 'its material uses its' : 'their materials use their'} color.`
    : `${counts.textured} textured material${counts.textured === 1 ? ' uses its' : 's use their'} color: the images of a .gltf file are imported from a .zip archive that holds them, or from a .glb file.`);
  if (counts.textureTransforms) warn(`${counts.textureTransforms} texture transform${counts.textureTransforms === 1 ? ' is' : 's are'} not applied.`);
  if (counts.cameras || counts.lights) warn('Cameras and lights are not imported.');
  if (json.animations?.length) warn('Animations are not imported; the model is imported in its rest position.');
  if (counts.skinned) warn(`${counts.skinned} skinned mesh${counts.skinned === 1 ? ' is' : 'es are'} imported in ${counts.skinned === 1 ? 'its' : 'their'} rest pose; skins are not imported.`);
  if (counts.morphs) warn(`Morph targets of ${counts.morphs} primitive${counts.morphs === 1 ? ' are' : 's are'} not imported.`);
  if (counts.transforms) warn(`${counts.transforms} invalid node transform${counts.transforms === 1 ? ' is' : 's are'} ignored.`);
  const unhandled = (json.extensionsUsed ?? []).filter(name => !HANDLED_EXTENSIONS.has(name) && !NOTED_EXTENSIONS.has(name));
  if (unhandled.length) warn(`Extensions not imported: ${unhandled.join(', ')}.`);
  meshCountNotes(counts, warn);

  const version = [json.asset?.version, json.asset?.generator].filter(Boolean).join(', ').slice(0, 100);
  return { placements, meshParts, model: {
    version, definitions, root: top, layers: [], pages: [], scenesUnread: 0, dimensions: [],
    materials, materialsById: new Map(materials.map(m => [m.id!, m])), styles: [], units: null, unitsOptions: null, sectionDisplay: null, renderingOptions: null,
  } };
}

function isIdentity(matrix: MMat4): boolean {
  return matrix.every((value, i) => Math.abs(value - (i % 5 === 0 ? 1 : 0)) <= (i >= 12 ? LENGTH_TOL : RATIO_TOL));
}
