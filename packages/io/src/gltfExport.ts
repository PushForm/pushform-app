// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { m4mul, type MMat4 } from '@pushform/core';
import { collectExportScene, exportFileName, type ExportNode, type ModelExportOptions } from './modelExport';

// glTF export: the scene as a binary glTF 2.0 file, Y up and in meters as the format defines,
// with shared meshes for definitions placed more than once and textures embedded.

export const GLB_EXTENSION = '.glb';

export interface ModelExportResult { bytes: Uint8Array; fileName: string; triangles: number; notes: string[] }

/** glTF base colors are linear; PushForm's material colors are sRGB. */
function srgbToLinear(c: number): number {
  const x = Math.max(0, Math.min(1, c));
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/** PushForm's Z-up axes to glTF's Y-up: +Z becomes +Y and +Y becomes -Z (column-major), and back. */
const TO_Y_UP: MMat4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const FROM_Y_UP: MMat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

/** Write the visible model, or its selection, as a `.glb` file. */
export function exportGlb(state: Parameters<typeof collectExportScene>[0], options: ModelExportOptions = {}): ModelExportResult {
  const scene = collectExportScene(state, options);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const bufferViews: object[] = [], accessors: object[] = [];
  const view = (data: Uint8Array, target?: number): number => {
    const padded = Math.ceil(length / 4) * 4;
    if (padded > length) { chunks.push(new Uint8Array(padded - length)); length = padded; }
    chunks.push(data);
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.byteLength, ...(target ? { target } : {}) });
    length += data.byteLength;
    return bufferViews.length - 1;
  };
  const floats = (values: number[], type: 'VEC2' | 'VEC3', bounds: boolean): number => {
    const size = type === 'VEC2' ? 2 : 3, data = Float32Array.from(values);
    const accessor: Record<string, unknown> = { bufferView: view(new Uint8Array(data.buffer), 34962), componentType: 5126, count: values.length / size, type };
    if (bounds) {
      const min = Array<number>(size).fill(Infinity), max = Array<number>(size).fill(-Infinity);
      for (let i = 0; i < data.length; i++) { const k = i % size; min[k] = Math.min(min[k]!, data[i]!); max[k] = Math.max(max[k]!, data[i]!); }
      Object.assign(accessor, { min, max });
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };
  const indices = (values: number[], count: number): number => {
    const wide = count > 65535, data = wide ? Uint32Array.from(values) : Uint16Array.from(values);
    accessors.push({ bufferView: view(new Uint8Array(data.buffer, 0, data.byteLength), 34963), componentType: wide ? 5125 : 5123, count: values.length, type: 'SCALAR' });
    return accessors.length - 1;
  };
  const yUp = (values: number[]): number[] => {
    const out = new Array<number>(values.length);
    for (let i = 0; i < values.length; i += 3) { out[i] = values[i]!; out[i + 1] = values[i + 2]!; out[i + 2] = -values[i + 1]! + 0; }
    return out;
  };

  const images = scene.images.map(image => {
    const mime = image.mime === 'image/jpg' ? 'image/jpeg' : image.mime;
    return mime === 'image/png' || mime === 'image/jpeg' ? { bufferView: view(image.bytes), mimeType: mime, name: image.name } : null;
  });
  const unsupported = images.filter(image => image === null).length;
  const imageIndex = new Map<number, number>(), gltfImages: object[] = [];
  images.forEach((image, i) => { if (image) { imageIndex.set(i, gltfImages.length); gltfImages.push(image); } });
  const materials = scene.materials.map(material => {
    const texture = material.image !== null ? imageIndex.get(material.image) : undefined;
    return {
      name: material.name,
      pbrMetallicRoughness: {
        baseColorFactor: [...material.color.map(srgbToLinear), material.alpha],
        metallicFactor: 0, roughnessFactor: 1,
        ...(texture !== undefined ? { baseColorTexture: { index: texture } } : {}),
      },
      ...(material.alpha < 1 ? { alphaMode: 'BLEND' } : {}),
      doubleSided: true,
    };
  });
  const textures = gltfImages.map((_, i) => ({ source: i, sampler: 0 }));

  const meshes = scene.meshes.map(mesh => {
    const primitives: object[] = mesh.primitives.map(primitive => {
      const count = primitive.positions.length / 3;
      const attributes: Record<string, number> = { POSITION: floats(yUp(primitive.positions), 'VEC3', true), NORMAL: floats(yUp(primitive.normals), 'VEC3', false) };
      // glTF's texture origin is the image's top left; PushForm's is its bottom left.
      if (primitive.uvs) attributes.TEXCOORD_0 = floats(primitive.uvs.map((v, i) => (i % 2 ? 1 - v : v)), 'VEC2', false);
      return { attributes, indices: indices(primitive.indices, count), ...(primitive.material !== null ? { material: primitive.material } : {}) };
    });
    if (mesh.lines.length) primitives.push({ attributes: { POSITION: floats(yUp(mesh.lines), 'VEC3', true) }, mode: 1 });
    return { name: mesh.name, primitives };
  });

  const nodes: object[] = [];
  const isIdentity = (m: MMat4): boolean => m.every((v, i) => v === (i % 5 === 0 ? 1 : 0));
  const addNode = (node: ExportNode): number => {
    const index = nodes.length, out: Record<string, unknown> = { name: node.name };
    nodes.push(out);
    // Each placement is conjugated by the axis change, so every mesh keeps Y-up coordinates.
    const matrix = m4mul(m4mul(TO_Y_UP, node.matrix), FROM_Y_UP).map(v => v + 0);
    if (!isIdentity(matrix)) out.matrix = matrix;
    if (node.mesh !== null) out.mesh = node.mesh;
    if (node.children.length) out.children = node.children.map(addNode);
    return index;
  };
  const root = addNode(scene.root);

  const json = {
    asset: { version: '2.0', generator: 'PushForm' },
    scene: 0, scenes: [{ name: scene.name, nodes: [root] }], nodes, meshes,
    ...(materials.length ? { materials } : {}),
    ...(gltfImages.length ? { images: gltfImages, textures, samplers: [{ wrapS: 10497, wrapT: 10497 }] } : {}),
    accessors, bufferViews, buffers: [{ byteLength: Math.ceil(length / 4) * 4 }],
  };
  const notes = [...scene.notes];
  if (unsupported) notes.push(`${unsupported} texture image${unsupported === 1 ? ' is' : 's are'} neither PNG nor JPEG, which glTF requires; ${unsupported === 1 ? 'its material exports its' : 'their materials export their'} color.`);
  return { bytes: glb(json, chunks, length), fileName: exportFileName(options.name ?? scene.name, GLB_EXTENSION), triangles: scene.triangles, notes };
}

/** A binary glTF file: the 12-byte header, the JSON chunk padded with spaces, and the binary chunk padded with zeros. */
function glb(json: object, chunks: Uint8Array[], length: number): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.byteLength / 4) * 4, binLength = Math.ceil(length / 4) * 4;
  const out = new Uint8Array(12 + 8 + jsonLength + 8 + binLength), data = new DataView(out.buffer);
  data.setUint32(0, 0x46546c67, true); data.setUint32(4, 2, true); data.setUint32(8, out.byteLength, true);
  data.setUint32(12, jsonLength, true); data.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20); out.fill(0x20, 20 + text.byteLength, 20 + jsonLength);
  data.setUint32(20 + jsonLength, binLength, true); data.setUint32(24 + jsonLength, 0x004e4942, true);
  let at = 28 + jsonLength;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}
