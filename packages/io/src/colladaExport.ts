// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { strToU8, zipSync } from 'fflate';
import { collectExportScene, exportFileName, type ExportNode, type ExportScene, type ModelExportOptions } from './modelExport';
import type { ModelExportResult } from './gltfExport';

// COLLADA export: the scene as a COLLADA 1.4.1 document in meters with Z up. A definition placed
// more than once is one library node that each placement instances; a textured model is a .zip holding the .dae
// with its images.

export const DAE_EXTENSION = '.dae';

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v: number): string => (Object.is(v, -0) ? 0 : Number(v.toPrecision(9))).toString();
const list = (values: readonly number[]): string => values.map(num).join(' ');

/** Unique, file-safe image names in `images/`, with an extension that matches the image's type. */
export function imageFileNames(scene: ExportScene): string[] {
  const used = new Set<string>();
  return scene.images.map((image, i) => {
    const extension = image.mime === 'image/jpeg' || image.mime === 'image/jpg' ? 'jpg' : image.mime.startsWith('image/') ? image.mime.slice(6).replace('+xml', '') : 'png';
    const stem = image.name.replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9._ -]+/g, '_').trim() || `image${i + 1}`;
    let name = `${stem}.${extension}`;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${stem} ${k}.${extension}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** Write the visible model, or its selection, as COLLADA: a `.dae`, or a `.zip` holding it and its texture images. */
export function exportCollada(state: Parameters<typeof collectExportScene>[0], options: ModelExportOptions = {}): ModelExportResult {
  const scene = collectExportScene(state, options);
  const files = imageFileNames(scene);
  const used = new Set(scene.materials.flatMap(m => (m.image !== null ? [m.image] : [])));
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">',
    `  <asset><contributor><authoring_tool>PushForm</authoring_tool></contributor><unit name="meter" meter="1"/><up_axis>Z_UP</up_axis></asset>`,
  ];
  if (used.size) {
    lines.push('  <library_images>');
    for (const i of used) lines.push(`    <image id="image${i}" name="${esc(files[i]!)}"><init_from>images/${esc(encodeURI(files[i]!))}</init_from></image>`);
    lines.push('  </library_images>');
  }
  if (scene.materials.length) {
    lines.push('  <library_effects>');
    scene.materials.forEach((material, i) => {
      const diffuse = material.image !== null
        ? `<texture texture="sampler${i}" texcoord="UVSET0"/>`
        : `<color>${list([...material.color, 1])}</color>`;
      const params = material.image !== null
        ? `<newparam sid="surface${i}"><surface type="2D"><init_from>image${material.image}</init_from></surface></newparam><newparam sid="sampler${i}"><sampler2D><source>surface${i}</source></sampler2D></newparam>`
        : '';
      const transparency = material.alpha < 1 ? `<transparent opaque="A_ONE"><color>1 1 1 ${num(material.alpha)}</color></transparent><transparency><float>1</float></transparency>` : '';
      lines.push(`    <effect id="effect${i}"><profile_COMMON>${params}<technique sid="common"><lambert><diffuse>${diffuse}</diffuse>${transparency}</lambert></technique></profile_COMMON></effect>`);
    });
    lines.push('  </library_effects>', '  <library_materials>');
    scene.materials.forEach((material, i) => lines.push(`    <material id="material${i}" name="${esc(material.name)}"><instance_effect url="#effect${i}"/></material>`));
    lines.push('  </library_materials>');
  }
  lines.push('  <library_geometries>');
  scene.meshes.forEach((mesh, m) => {
    // One set of arrays per mesh; each primitive indexes positions, normals and coordinates alike.
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [], parts: string[] = [];
    let textured = false;
    for (const primitive of mesh.primitives) {
      const base = positions.length / 3;
      positions.push(...primitive.positions); normals.push(...primitive.normals);
      const count = primitive.positions.length / 3;
      if (primitive.uvs) { uvs.push(...primitive.uvs); textured = true; } else uvs.push(...new Array<number>(count * 2).fill(0));
      parts.push(`<triangles${primitive.material !== null ? ` material="m${primitive.material}"` : ''} count="${primitive.indices.length / 3}">` +
        `<input semantic="VERTEX" source="#mesh${m}-vertices" offset="0"/><input semantic="NORMAL" source="#mesh${m}-normals" offset="0"/>` +
        `${primitive.uvs ? `<input semantic="TEXCOORD" source="#mesh${m}-uvs" offset="0" set="0"/>` : ''}<p>${primitive.indices.map(i => i + base).join(' ')}</p></triangles>`);
    }
    if (mesh.lines.length) {
      const base = positions.length / 3;
      positions.push(...mesh.lines); normals.push(...new Array<number>(mesh.lines.length).fill(0)); uvs.push(...new Array<number>((mesh.lines.length / 3) * 2).fill(0));
      parts.push(`<lines count="${mesh.lines.length / 6}"><input semantic="VERTEX" source="#mesh${m}-vertices" offset="0"/><p>${Array.from({ length: mesh.lines.length / 3 }, (_, i) => i + base).join(' ')}</p></lines>`);
    }
    const source = (id: string, values: number[], params: string[]): string => `<source id="mesh${m}-${id}"><float_array id="mesh${m}-${id}-array" count="${values.length}">${list(values)}</float_array>` +
      `<technique_common><accessor source="#mesh${m}-${id}-array" count="${values.length / params.length}" stride="${params.length}">${params.map(p => `<param name="${p}" type="float"/>`).join('')}</accessor></technique_common></source>`;
    lines.push(`    <geometry id="mesh${m}" name="${esc(mesh.name)}"><mesh>${source('positions', positions, ['X', 'Y', 'Z'])}${source('normals', normals, ['X', 'Y', 'Z'])}` +
      `${textured ? source('uvs', uvs, ['S', 'T']) : ''}<vertices id="mesh${m}-vertices"><input semantic="POSITION" source="#mesh${m}-positions"/></vertices>${parts.join('')}</mesh></geometry>`);
  });
  lines.push('  </library_geometries>');

  const instanceGeometry = (mesh: number): string => {
    const bound = [...new Set(scene.meshes[mesh]!.primitives.flatMap(p => (p.material !== null ? [p.material] : [])))];
    const binding = bound.length ? `<bind_material><technique_common>${bound.map(i => `<instance_material symbol="m${i}" target="#material${i}">` +
      `<bind_vertex_input semantic="UVSET0" input_semantic="TEXCOORD" input_set="0"/></instance_material>`).join('')}</technique_common></bind_material>` : '';
    return `<instance_geometry url="#mesh${mesh}">${binding}</instance_geometry>`;
  };
  // A mesh several placements show is a library node each of them instances.
  const shared = scene.uses.map(count => count > 1);
  const nodeXml = (node: ExportNode, depth: number, id: number[]): string => {
    const pad = '  '.repeat(depth);
    const matrix = `<matrix>${list([0, 1, 2, 3].flatMap(r => [0, 1, 2, 3].map(c => node.matrix[c * 4 + r]!)))}</matrix>`;
    const own = node.mesh === null ? '' : shared[node.mesh] ? `<instance_node url="#shared${node.mesh}"/>` : instanceGeometry(node.mesh);
    const children = node.children.map(child => `\n${nodeXml(child, depth + 1, id)}`).join('');
    return `${pad}<node id="node${id[0]!++}" name="${esc(node.name)}">${matrix}${own}${children}${children ? `\n${pad}` : ''}</node>`;
  };
  if (shared.some(Boolean)) {
    lines.push('  <library_nodes>');
    shared.forEach((isShared, mesh) => { if (isShared) lines.push(`    <node id="shared${mesh}" name="${esc(scene.meshes[mesh]!.name)}">${instanceGeometry(mesh)}</node>`); });
    lines.push('  </library_nodes>');
  }
  lines.push('  <library_visual_scenes>', `    <visual_scene id="scene" name="${esc(scene.name)}">`, nodeXml(scene.root, 3, [0]), '    </visual_scene>', '  </library_visual_scenes>',
    '  <scene><instance_visual_scene url="#scene"/></scene>', '</COLLADA>', '');
  const dae = strToU8(lines.join('\n'));
  const fileName = exportFileName(options.name ?? scene.name, DAE_EXTENSION);
  if (!used.size) return { bytes: dae, fileName, triangles: scene.triangles, notes: scene.notes };
  const entries: Record<string, Uint8Array> = { [fileName]: dae };
  for (const i of used) entries[`images/${files[i]}`] = scene.images[i]!.bytes;
  return { bytes: zipSync(entries), fileName: exportFileName(options.name ?? scene.name, '.zip'), triangles: scene.triangles, notes: scene.notes };
}
