// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { m4mul, m4transformDir, m4transformPoint, v3normalize, type MMat4, type Vec3 } from '@pushform/core';
import { strToU8, zipSync } from 'fflate';
import { imageFileNames } from './colladaExport';
import type { ModelExportResult } from './gltfExport';
import { MESH_UNITS, type MeshImportOptions } from './meshImport';
import { collectExportScene, exportFileName, isMirrored, type ExportNode, type ModelExportOptions } from './modelExport';

// OBJ export: a .zip holding the .obj, its .mtl and its texture images. OBJ has no hierarchy or
// unit, so each placement at the top of the model is one object of world-space faces in the chosen unit and up axis.

export interface ObjExportOptions extends ModelExportOptions, MeshImportOptions {}

/** Write the visible model, or its selection, as an OBJ archive. */
export function exportObj(state: Parameters<typeof collectExportScene>[0], options: ObjExportOptions): ModelExportResult {
  const scene = collectExportScene(state, options);
  const scale = MESH_UNITS.find(u => u.unit === options.unit)?.meters;
  if (scale === undefined) throw new Error(`Unknown OBJ unit: ${options.unit}`);
  // Meters with Z up to the file's unit and axes: Y up turns +Z into +Y and +Y into -Z.
  const axes = (p: Vec3): Vec3 => (options.up === 'y' ? [p[0], p[2], -p[1] + 0] : p);
  const point = (p: Vec3): Vec3 => axes([p[0] / scale, p[1] / scale, p[2] / scale]);
  const num = (v: number): string => (Object.is(v, -0) ? 0 : Number(v.toPrecision(9))).toString();
  const base = exportFileName(options.name ?? scene.name, '');
  const files = imageFileNames(scene);

  // Material names are unique, OBJ-safe words.
  const used = new Set<string>();
  const materialNames = scene.materials.map((material, i) => {
    const stem = material.name.replace(/\s+/g, '_').replace(/[^\w.-]/g, '') || `Material${i + 1}`;
    let name = stem;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${stem}_${k}`;
    used.add(name.toLowerCase());
    return name;
  });

  const out: string[] = [`# PushForm OBJ: ${scene.name}`, `# Units: ${options.unit}, ${options.up.toUpperCase()} up`, `mtllib ${base}.mtl`];
  let vertices = 0, texcoords = 0, normals = 0;
  const emit = (node: ExportNode, matrix: MMat4): void => {
    const world = m4mul(matrix, node.matrix), mirrored = isMirrored(world);
    if (node.mesh !== null) {
      const mesh = scene.meshes[node.mesh]!;
      for (const primitive of mesh.primitives) {
        out.push(`usemtl ${primitive.material !== null ? materialNames[primitive.material] : '(null)'}`);
        const count = primitive.positions.length / 3;
        for (let i = 0; i < count; i++) {
          const p = point(m4transformPoint(world, [primitive.positions[i * 3]!, primitive.positions[i * 3 + 1]!, primitive.positions[i * 3 + 2]!]) as Vec3);
          out.push(`v ${p.map(num).join(' ')}`);
          // Normals turn with the placement; a mirrored one is undone by turning the faces over.
          const n = v3normalize(axes(m4transformDir(world, [primitive.normals[i * 3]!, primitive.normals[i * 3 + 1]!, primitive.normals[i * 3 + 2]!]) as Vec3));
          out.push(`vn ${n.map(num).join(' ')}`);
          if (primitive.uvs) out.push(`vt ${num(primitive.uvs[i * 2]!)} ${num(primitive.uvs[i * 2 + 1]!)}`);
        }
        const corner = (i: number): string => {
          const v = vertices + i + 1, n = normals + i + 1;
          return primitive.uvs ? `${v}/${texcoords + i + 1}/${n}` : `${v}//${n}`;
        };
        for (let t = 0; t + 2 < primitive.indices.length; t += 3) {
          const [a, b, c] = [primitive.indices[t]!, primitive.indices[t + 1]!, primitive.indices[t + 2]!];
          out.push(`f ${(mirrored ? [a, c, b] : [a, b, c]).map(corner).join(' ')}`);
        }
        vertices += count; normals += count; if (primitive.uvs) texcoords += count;
      }
      for (let i = 0; i + 5 < mesh.lines.length; i += 6) {
        for (const at of [i, i + 3]) out.push(`v ${point(m4transformPoint(world, [mesh.lines[at]!, mesh.lines[at + 1]!, mesh.lines[at + 2]!]) as Vec3).map(num).join(' ')}`);
        out.push(`l ${vertices + 1} ${vertices + 2}`);
        vertices += 2;
      }
    }
    for (const child of node.children) emit(child, world);
  };
  // The model's own geometry comes first, outside any object; each top-level placement is an object of its name.
  emit({ ...scene.root, children: [] }, scene.root.matrix);
  const objectNames = new Set<string>();
  for (const child of scene.root.children) {
    let name = child.name.trim() || 'Object';
    for (let k = 2; objectNames.has(name); k++) name = `${child.name.trim() || 'Object'} ${k}`;
    objectNames.add(name);
    out.push(`o ${name}`);
    emit(child, scene.root.matrix);
  }

  const mtl: string[] = [`# PushForm MTL: ${scene.name}`, ''];
  scene.materials.forEach((material, i) => {
    mtl.push(`newmtl ${materialNames[i]}`, `Kd ${material.color.map(num).join(' ')}`, `d ${num(material.alpha)}`);
    if (material.image !== null) mtl.push(`map_Kd textures/${files[material.image]}`);
    mtl.push('');
  });
  const entries: Record<string, Uint8Array> = { [`${base}.obj`]: strToU8(`${out.join('\n')}\n`), [`${base}.mtl`]: strToU8(mtl.join('\n')) };
  for (const material of scene.materials) if (material.image !== null) entries[`textures/${files[material.image]}`] = scene.images[material.image]!.bytes;
  return { bytes: zipSync(entries), fileName: `${base}.zip`, triangles: scene.triangles, notes: scene.notes };
}
