// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { VERTEX_NORMAL_TOL, v3cross, v3dot, v3len, v3normalize, v3sub, type Id, type MaterialId, type Vec3 } from '@pushform/core';
import { definitionAt } from '@pushform/model';
import type { DocumentDraft, DocumentState, MeshPart } from '@pushform/model';
import type { Material } from 'openskp';
import { groupedMeshModel, meshMaterial, type MeshCounts, type MeshGeometry, type MeshPolygon } from './meshImport';
import { prepareSketchUp, type ImportFormat } from './sketchup';
import { applySketchUpImport } from './sketchupDocument';

// Making a mesh part editable: its triangles become faces and edges by the rules for mesh imports, its face
// colors become those faces' materials, and the result (bodies, and sheet faces where it is not closed) replaces
// the part in its definition. Call inside one transaction.

const EDITABLE_FORMAT: ImportFormat = { kind: 'obj', name: 'Mesh part', notes: [] };

export interface MakeEditableResult { bodies: number; sheetFaces: number; warnings: string[] }

/** The part's triangles as polygons with the per-face vertex normals that tell the converter where a surface is smooth. */
function partPolygons(part: MeshPart, materialKey: (id: number) => number | null): MeshGeometry {
  const g = part.geometry, p = g.positions, tris = g.triangles, count = tris.length / 3;
  const point = (v: number): Vec3 => [p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!];
  // Area-weighted normals per (source face, vertex), and whether each face is flat.
  const sums = new Map<number, [number, number, number]>(), first = new Map<number, Vec3>(), flat = new Uint8Array(g.faceCount).fill(1);
  const minCos = Math.cos(VERTEX_NORMAL_TOL), vertices = p.length / 3;
  const normals: Vec3[] = [];
  for (let t = 0; t < count; t++) {
    const a = point(tris[t * 3]!), n = v3cross(v3sub(point(tris[t * 3 + 1]!), a), v3sub(point(tris[t * 3 + 2]!), a)), face = g.triangleFace[t]!;
    normals.push(n);
    const unit = v3len(n) > 0 ? v3normalize(n) : null;
    const seen = first.get(face);
    if (unit && !seen) first.set(face, unit); else if (unit && seen && v3dot(unit, seen) < minCos) flat[face] = 0;
    for (let k = 0; k < 3; k++) {
      const key = face * vertices + tris[t * 3 + k]!, sum = sums.get(key);
      if (sum) { sum[0] += n[0]; sum[1] += n[1]; sum[2] += n[2]; } else sums.set(key, [n[0], n[1], n[2]]);
    }
  }
  const polygons: MeshPolygon[] = [];
  for (let t = 0; t < count; t++) {
    const face = g.triangleFace[t]!, material = materialKey(g.faceMaterials[face]!);
    const corner = (k: number) => {
      const v = tris[t * 3 + k]!, sum = sums.get(face * vertices + v)!;
      return { position: point(v), normal: v3len(sum) > 0 ? v3normalize(sum) : null, uv: null };
    };
    // A curved face's facets stay faces of their own; a flat face's facets join into one face again.
    polygons.push({ material, corners: [corner(0), corner(1), corner(2)], keep: !flat[face] });
  }
  return { polygons, lines: [] };
}

/**
 * Replace the mesh part `id` of the container at `path` with editable geometry: bodies for its closed parts and
 * sheet faces for the rest, carrying the part's tag, hidden state, shadow flags and material. Materials the part
 * already uses are reused, not duplicated.
 */
export function makeMeshPartEditable(draft: DocumentDraft, path: readonly Id[], id: Id): MakeEditableResult {
  const state = draft as unknown as DocumentState;
  const definition = definitionAt(state, path), container = definition.entities;
  const part = container.meshParts.get(id);
  if (!part) throw new Error('The mesh part no longer exists.');
  // Scene materials stand in for the document materials the part's faces use.
  const keys = new Map<number, number>(), materials: Material[] = [], materialIds = new Map<number, MaterialId>();
  const materialKey = (materialId: number): number | null => {
    if (!materialId) return null;
    let key = keys.get(materialId);
    if (key === undefined) {
      const m = state.materials.get(materialId as MaterialId);
      if (!m) return null;
      key = materials.length; keys.set(materialId, key); materialIds.set(key, m.id);
      materials.push(meshMaterial(key, m.name, m.color as unknown as Vec3, m.alpha, null));
    }
    return key;
  };
  const counts: MeshCounts = { degenerate: 0, nonplanar: 0, duplicates: 0, turned: 0 };
  const { model } = groupedMeshModel([{ name: '', geometry: partPolygons(part, materialKey) }], materials, part.source.format, counts, undefined, { meshPartThreshold: Infinity });
  const scene = prepareSketchUp(model, undefined, EDITABLE_FORMAT);
  const bodiesBefore = new Set(container.bodies.keys()), facesBefore = new Set(container.sketch.faces.keys()), edgesBefore = new Set(container.sketch.edges.keys());
  const report = applySketchUpImport(draft, scene, { definitionId: definition.id, materialIds });
  const own = { tagId: part.tagId, hidden: part.hidden };
  for (const [bodyId, body] of container.bodies) if (!bodiesBefore.has(bodyId)) {
    Object.assign(body, own, { castShadows: part.castShadows, receiveShadows: part.receiveShadows, materialId: body.materialId ?? part.materialId });
    for (const face of body.faces.values()) face.tagId = part.tagId;
    for (const edge of body.edges.values()) edge.tagId = part.tagId;
  }
  for (const [faceId, face] of container.sketch.faces) if (!facesBefore.has(faceId)) Object.assign(face, own, { frontMaterialId: face.frontMaterialId ?? part.materialId, backMaterialId: face.backMaterialId ?? part.materialId });
  for (const [edgeId, edge] of container.sketch.edges) if (!edgesBefore.has(edgeId)) Object.assign(edge, own);
  container.meshParts.delete(id);
  container.order = container.order.filter(entry => entry !== id);
  definition.bounds = null;
  return { bodies: report.bodies, sheetFaces: report.sheetFaces, warnings: report.warnings.filter(w => !w.startsWith(EDITABLE_FORMAT.name)) };
}
