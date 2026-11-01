// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec3 } from '@pushform/core';
import { create, METRES_TO_INCHES, type ComponentDefinitionBuilder, type SkpBuilder, type Point3, type Matrix3x3, type UvPair } from 'openskp';
import { collectExportScene, exportFileName, segmentKey, type ExportEdgeFlags, type ExportFace, type ExportNode, type ExportUv, type ModelExportOptions } from './modelExport';
import type { ModelExportResult } from './gltfExport';

type Target = ComponentDefinitionBuilder | SkpBuilder;

/**
 * Write the visible model in a legacy (2017) SKP file: each face as one face with its holes, edges with their soft,
 * smooth and hidden flags, groups and components as component definitions with their placements, names and paint.
 */
export function exportSkp(state: Parameters<typeof collectExportScene>[0], options: ModelExportOptions = {}): ModelExportResult {
  const scene = collectExportScene(state, { ...options, faces: true }), builder = create();
  const notes = [...scene.notes, 'Tags, scenes, display settings and curve metadata are not exported.'];
  const materials = scene.materials.map(material => {
    const image = material.image === null ? undefined : scene.images[material.image];
    if (image && (image.mime === 'image/png' || image.mime === 'image/jpeg'))
      return builder.addTextureMaterial(material.name, image.bytes, image.name, 1, 1, material.alpha);
    if (image) notes.push(`Texture "${material.name}" uses an unsupported image format; its color is exported.`);
    return builder.addMaterial(material.name, material.color.map(c => Math.round(c * 255)), material.alpha);
  });
  const textured = (index: number | null): boolean => index !== null && scene.materials[index]!.image !== null && materials[index] !== undefined;
  const handle = (index: number): number => materials[index]!;
  const inches = (p: Vec3): Point3 => [p[0] * METRES_TO_INCHES, p[1] * METRES_TO_INCHES, p[2] * METRES_TO_INCHES];
  const point = (values: number[], offset: number): Point3 => [values[offset]! * METRES_TO_INCHES, values[offset + 1]! * METRES_TO_INCHES, values[offset + 2]! * METRES_TO_INCHES];
  const skipped = { empty: 0, split: 0, unplaced: 0 };

  /** Three points of a loop spanning its largest triangle, with their texture coordinates; none when the loop has no area. */
  const pins = (loop: Vec3[], uv: ExportUv | null): UvPair[] | undefined => {
    if (!uv || loop.length < 3) return undefined;
    const a = loop[0]!, d2 = (p: Vec3) => (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2 + (p[2] - a[2]) ** 2;
    const b = loop.reduce((best, p) => (d2(p) > d2(best) ? p : best), a);
    const area = (p: Vec3) => {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
      return Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
    };
    const c = loop.reduce((best, p) => (area(p) > area(best) ? p : best), a);
    if (area(c) <= 0) return undefined;
    return [a, b, c].map(p => [inches(p), uv(p)] as UvPair);
  };
  const edges = (target: Target, a: Vec3, b: Vec3, flags: ExportEdgeFlags): void =>
    target.addEdges([inches(a), inches(b)], { softEdges: flags.soft, smoothEdges: flags.smooth, hiddenEdges: flags.hidden });
  /**
   * One polygon: with its texture placements, then without them when they map to a line; a polygon that cannot be
   * written as one face is reported to the caller. openskp checks a face before writing any of it, so a refused
   * face leaves the file as it was.
   */
  const polygon = (target: Target, face: ExportFace, outer: Vec3[], holes: Vec3[][]): 'written' | 'refused' => {
    const base = { ...(face.front === null ? {} : { material: handle(face.front) }), ...(face.back === null ? {} : { backMaterial: handle(face.back) }),
      ...(face.hidden ? { hidden: true } : {}), ...(holes.length ? { holes: holes.map(loop => loop.map(inches)) } : {}) };
    const frontUv = textured(face.front) ? pins(outer, face.frontUv) : undefined, backUv = textured(face.back) ? pins(outer, face.backUv) : undefined;
    try {
      target.addFace(outer.map(inches), { ...base, ...(frontUv ? { frontUv } : {}), ...(backUv ? { backUv } : {}) });
      return 'written';
    } catch (error) {
      if (!(frontUv || backUv) || !/texture/i.test(String((error as Error)?.message))) return 'refused';
    }
    try {
      target.addFace(outer.map(inches), base);
      skipped.unplaced++;
      return 'written';
    } catch { return 'refused'; }
  };
  const writeFace = (target: Target, face: ExportFace): void => {
    // Flagged edges first: a face reuses an edge already written, with its flags.
    face.loops.forEach((loop, l) => loop.forEach((p, i) => {
      const flags = face.edges[l]?.[i];
      if (flags) edges(target, p, loop[(i + 1) % loop.length]!, flags);
    }));
    if (face.loops[0] && face.loops[0].length >= 3 && polygon(target, face, face.loops[0], face.loops.slice(1)) === 'written') return;
    // A face slightly off its plane, or with holes off it, is written as its triangles with the edges between them hidden.
    const outline = new Set(face.loops.flatMap(loop => loop.map((p, i) => segmentKey(p, loop[(i + 1) % loop.length]!))));
    const hidden = { soft: false, smooth: false, hidden: true };
    let written = 0;
    for (const triangle of face.triangles) {
      for (let i = 0; i < 3; i++) {
        const a = triangle[i]!, b = triangle[(i + 1) % 3]!;
        if (!outline.has(segmentKey(a, b))) edges(target, a, b, hidden);
      }
      if (polygon(target, face, triangle, []) === 'written') written++;
    }
    if (written) skipped.split++; else skipped.empty++;
  };

  const geometry = (target: Target, mesh: number | null): void => {
    if (mesh === null) return;
    const source = scene.meshes[mesh]!;
    for (const face of source.faces ?? []) writeFace(target, face);
    for (let i = 0; i < source.lines.length; i += 6) target.addEdges([point(source.lines, i), point(source.lines, i + 3)]);
  };
  const placement = (node: ExportNode) => {
    const m = node.matrix;
    return { name: node.placementName ?? node.name, translation: point(m, 12), matrix3x3: [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]] as Matrix3x3,
      ...(node.material === null || node.material === undefined ? {} : { material: handle(node.material) }) };
  };
  // Definitions must be closed before their parents, and all definitions precede root geometry.
  const definitions = new Map<string, ComponentDefinitionBuilder>();
  const define = (node: ExportNode): ComponentDefinitionBuilder => {
    // A definition's contents: its geometry and its placements, not how it is itself placed.
    const key = JSON.stringify([node.definitionName, node.mesh, node.children]);
    const existing = definitions.get(key);
    if (existing) return existing;
    const children = node.children.map(child => ({ node: child, definition: define(child) }));
    const definition = builder.addComponentDefinition(node.definitionName || node.name, target => {
      geometry(target, node.mesh);
      for (const child of children) target.addInstance(child.definition, placement(child.node));
    });
    definitions.set(key, definition);
    return definition;
  };
  const children = scene.root.children.map(node => ({ node, definition: define(node) }));
  geometry(builder, scene.root.mesh);
  for (const child of children) builder.addInstance(child.definition, placement(child.node));
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  if (skipped.empty) notes.push(`${skipped.empty} ${plural(skipped.empty, 'face encloses', 'faces enclose')} no area and ${plural(skipped.empty, 'was', 'were')} left out.`);
  if (skipped.split) notes.push(`${skipped.split} ${plural(skipped.split, 'face is', 'faces are')} not quite flat and ${plural(skipped.split, 'was', 'were')} written as triangles with hidden edges between them.`);
  if (skipped.unplaced) notes.push(`${skipped.unplaced} textured ${plural(skipped.unplaced, 'face', 'faces')} could not keep ${plural(skipped.unplaced, 'its', 'their')} texture placement and use the texture's default placement.`);
  return { bytes: builder.toBytes(), fileName: exportFileName(options.name ?? scene.name, '.skp'), triangles: scene.triangles, notes };
}
