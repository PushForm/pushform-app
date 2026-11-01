// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { create, METRES_TO_INCHES, type ComponentDefinitionBuilder, type SkpBuilder, type Point3, type Matrix3x3, type UvPair } from 'openskp';
import { collectExportScene, exportFileName, type ExportNode, type ModelExportOptions } from './modelExport';
import type { ModelExportResult } from './gltfExport';

/** Write visible geometry as editable triangles in a legacy (2017) SKP file. */
export function exportSkp(state: Parameters<typeof collectExportScene>[0], options: ModelExportOptions = {}): ModelExportResult {
  const scene = collectExportScene(state, options), builder = create();
  const notes = [...scene.notes, 'Faces are triangulated. Tags, scenes, display settings and curve metadata are not exported.'];
  const materials = scene.materials.map(material => {
    const image = material.image === null ? undefined : scene.images[material.image];
    if (image && (image.mime === 'image/png' || image.mime === 'image/jpeg'))
      return builder.addTextureMaterial(material.name, image.bytes, image.name, 1, 1, material.alpha);
    if (image) notes.push(`Texture "${material.name}" uses an unsupported image format; its color is exported.`);
    return builder.addMaterial(material.name, material.color.map(c => Math.round(c * 255)), material.alpha);
  });
  const point = (values: number[], offset: number): Point3 => [values[offset]! * METRES_TO_INCHES, values[offset + 1]! * METRES_TO_INCHES, values[offset + 2]! * METRES_TO_INCHES];
  const geometry = (target: ComponentDefinitionBuilder | SkpBuilder, mesh: number | null): void => {
    if (mesh === null) return;
    const source = scene.meshes[mesh]!;
    // A sheet painted on both sides is represented twice by the shared scene collector.
    // Pair opposite windings into a single SKP face with front/back paint.
    const pending = new Map<string, { points: Point3[]; material: number | undefined; uv: UvPair[] | undefined }>();
    const key = (points: Point3[]): string => points.map(p => p.join(',')).join('|');
    const cyclicKey = (points: Point3[]): string => [0, 1, 2].map(i => key([...points.slice(i), ...points.slice(0, i)])).sort()[0]!;
    for (const primitive of source.primitives) {
      for (let t = 0; t < primitive.indices.length; t += 3) {
        const indices = primitive.indices.slice(t, t + 3), points = indices.map(i => point(primitive.positions, i * 3));
        const uv: UvPair[] | undefined = primitive.uvs ? indices.map((i, k) => [points[k]!, [primitive.uvs![i * 2]!, primitive.uvs![i * 2 + 1]!]]) : undefined;
        const material = primitive.material === null ? undefined : materials[primitive.material];
        const opposite = cyclicKey([...points].reverse()), front = pending.get(opposite);
        if (front) {
          target.addFace(front.points, { ...(front.material === undefined ? {} : { material: front.material }), ...(material === undefined ? {} : { backMaterial: material }), ...(front.uv ? { frontUv: front.uv } : {}), ...(uv ? { backUv: uv } : {}) });
          pending.delete(opposite);
        } else pending.set(cyclicKey(points), { points, material, uv });
      }
    }
    for (const face of pending.values()) target.addFace(face.points, { ...(face.material === undefined ? {} : { material: face.material }), ...(face.uv ? { frontUv: face.uv } : {}) });
    for (let i = 0; i < source.lines.length; i += 6) target.addPolyline([point(source.lines, i), point(source.lines, i + 3)]);
  };
  const placement = (node: ExportNode) => {
    const m = node.matrix;
    return { name: node.name, translation: point(m, 12), matrix3x3: [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]] as Matrix3x3 };
  };
  // Definitions must be closed before their parents, and all definitions precede root geometry.
  const definitions = new Map<string, ComponentDefinitionBuilder>();
  const define = (node: ExportNode): ComponentDefinitionBuilder => {
    const key = JSON.stringify([node.mesh, node.children]);
    const existing = definitions.get(key);
    if (existing) return existing;
    const children = node.children.map(child => ({ node: child, definition: define(child) }));
    const definition = builder.addComponentDefinition(node.name, target => {
      geometry(target, node.mesh);
      for (const child of children) target.addInstance(child.definition, placement(child.node));
    });
    definitions.set(key, definition);
    return definition;
  };
  const children = scene.root.children.map(node => ({ node, definition: define(node) }));
  geometry(builder, scene.root.mesh);
  for (const child of children) builder.addInstance(child.definition, placement(child.node));
  return { bytes: builder.toBytes(), fileName: exportFileName(options.name ?? scene.name, '.skp'), triangles: scene.triangles, notes };
}
