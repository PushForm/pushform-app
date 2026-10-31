// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, MaterialId, Vec3 } from '@pushform/core';
import { definitionAt } from '@pushform/model';
import type { DocumentDraft, DocumentState } from '@pushform/model';
import type { Material } from 'openskp';
import { groupedMeshModel, meshMaterial, meshPartPolygons, type MeshCounts } from './meshImport';
import { prepareSketchUp, type ImportFormat } from './sketchup';
import { applySketchUpImport } from './sketchupDocument';

// Making a mesh part editable: its triangles become faces and edges by the rules for mesh imports, its face
// colors become those faces' materials, and the result (bodies, and sheet faces where it is not closed) replaces
// the part in its definition. Call inside one transaction.

const EDITABLE_FORMAT: ImportFormat = { kind: 'obj', name: 'Mesh part', notes: [] };

export interface MakeEditableResult { bodies: number; sheetFaces: number; warnings: string[] }

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
  const { model } = groupedMeshModel([{ name: '', geometry: meshPartPolygons(part.geometry, materialKey) }], materials, part.source.format, counts, undefined, { meshPartThreshold: Infinity });
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
