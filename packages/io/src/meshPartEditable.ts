// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { MERGE_TOL, v3cross, v3dot, v3len, v3normalize, v3sub, type DefId, type FaceLocalId, type Id, type MaterialId, type MeshData, type Vec3 } from '@pushform/core';
import { weldVertices } from '@pushform/geom';
import { meshTopologyProblems } from '@pushform/kernel';
import { bodyFromMesh, definitionAt } from '@pushform/model';
import type { DocumentDraft, DocumentState, EntityContainer, MeshPart, MeshPartGeometry } from '@pushform/model';
import type { Material } from 'openskp';
import { groupedMeshModel, meshMaterial, meshPartPolygons, type MeshCounts } from './meshImport';
import { prepareSketchUp, type ImportFormat } from './sketchup';
import { applySketchUpImport } from './sketchupDocument';

// Making a mesh part editable. The part's triangles are the body's mesh as they are, and its faces come from the
// part's own record of which source face each triangle belongs to: a flat source face is one face, any other its
// facets. Nothing is merged or re-triangulated, so a shell that is closed stays a closed solid. A connected part of
// the mesh that is not closed becomes sheet faces by the rules for mesh imports. Call inside one transaction.

const SHEET_FORMAT: ImportFormat = { kind: 'obj', name: 'Mesh part', notes: [] };
/** meshTopologyProblems' finding for a closed, consistently oriented shell that faces inward. */
const INSIDE_OUT = 'signed volume is not positive';

export interface MakeEditableResult { bodies: number; sheetFaces: number; warnings: string[] }

function reverseTriangles(tris: Uint32Array): Uint32Array {
  const out = new Uint32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) { out[i] = tris[i]!; out[i + 1] = tris[i + 2]!; out[i + 2] = tris[i + 1]!; }
  return out;
}

/** The welded mesh with a face id per triangle: a flat source face keeps one number, a curved one's facets get their own. */
function facedMesh(g: MeshPartGeometry): { mesh: MeshData; sourceFace: Uint32Array } {
  const canonical = weldVertices(g.positions, MERGE_TOL);
  const ids = new Map<number, number>(), verts: number[] = [];
  const vertex = (i: number): number => {
    const c = canonical[i]!;
    let id = ids.get(c);
    if (id === undefined) { id = verts.length / 3; ids.set(c, id); verts.push(g.positions[c * 3]!, g.positions[c * 3 + 1]!, g.positions[c * 3 + 2]!); }
    return id;
  };
  const point = (v: number): Vec3 => [verts[v * 3]!, verts[v * 3 + 1]!, verts[v * 3 + 2]!];
  const tris: number[] = [], source: number[] = [];
  for (let t = 0; t < g.triangles.length / 3; t++) {
    const a = vertex(g.triangles[t * 3]!), b = vertex(g.triangles[t * 3 + 1]!), c = vertex(g.triangles[t * 3 + 2]!);
    if (a === b || b === c || a === c) continue;
    tris.push(a, b, c); source.push(g.triangleFace[t]!);
  }
  // A source face is flat when every welded point of it lies within half the merge tolerance of one plane.
  const normals = new Map<number, Vec3>(), members = new Map<number, Set<number>>();
  for (let t = 0; t < source.length; t++) {
    const f = source[t]!, a = point(tris[t * 3]!), b = point(tris[t * 3 + 1]!), c = point(tris[t * 3 + 2]!), n = v3cross(v3sub(b, a), v3sub(c, a));
    const acc = normals.get(f) ?? [0, 0, 0];
    normals.set(f, [acc[0] + n[0], acc[1] + n[1], acc[2] + n[2]]);
    const set = members.get(f) ?? members.set(f, new Set()).get(f)!;
    set.add(tris[t * 3]!); set.add(tris[t * 3 + 1]!); set.add(tris[t * 3 + 2]!);
  }
  const flat = new Map<number, number>();
  let next = 0;
  for (const [f, sum] of normals) {
    if (v3len(sum) === 0) continue;
    const n = v3normalize(sum), points = [...members.get(f)!].map(point);
    const c: [number, number, number] = [0, 0, 0];
    for (const p of points) { c[0] += p[0] / points.length; c[1] += p[1] / points.length; c[2] += p[2] / points.length; }
    if (points.every(p => Math.abs(v3dot(v3sub(p, c), n)) <= MERGE_TOL / 2)) flat.set(f, next++);
  }
  const faceId = new Uint32Array(source.length);
  for (let t = 0; t < source.length; t++) { const f = flat.get(source[t]!); faceId[t] = f ?? next++; }
  return { mesh: { verts: Float64Array.from(verts), tris: Uint32Array.from(tris), faceId }, sourceFace: Uint32Array.from(source) };
}

/** Triangles grouped into connected shells (by shared welded edges), each as its own compact mesh. */
function shells(mesh: MeshData, sourceFace: Uint32Array): { mesh: MeshData; sourceFace: Uint32Array; triangles: number[] }[] {
  const count = mesh.tris.length / 3, parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  const byEdge = new Map<number, number>(), vertices = mesh.verts.length / 3;
  for (let t = 0; t < count; t++) for (let k = 0; k < 3; k++) {
    const a = mesh.tris[t * 3 + k]!, b = mesh.tris[t * 3 + (k + 1) % 3]!, key = Math.min(a, b) * vertices + Math.max(a, b);
    const other = byEdge.get(key);
    if (other === undefined) byEdge.set(key, t); else parent[find(t)] = find(other);
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < count; t++) { const r = find(t); (groups.get(r) ?? groups.set(r, []).get(r)!).push(t); }
  return [...groups.values()].map(triangles => {
    const remap = new Map<number, number>(), verts: number[] = [], tris: number[] = [], faceId: number[] = [], source: number[] = [];
    for (const t of triangles) {
      for (let k = 0; k < 3; k++) {
        const v = mesh.tris[t * 3 + k]!;
        let id = remap.get(v);
        if (id === undefined) { id = verts.length / 3; remap.set(v, id); verts.push(mesh.verts[v * 3]!, mesh.verts[v * 3 + 1]!, mesh.verts[v * 3 + 2]!); }
        tris.push(id);
      }
      faceId.push(mesh.faceId[t]!); source.push(sourceFace[t]!);
    }
    return { mesh: { verts: Float64Array.from(verts), tris: Uint32Array.from(tris), faceId: Uint32Array.from(faceId) }, sourceFace: Uint32Array.from(source), triangles };
  });
}

/**
 * Replace the mesh part `id` of the container at `path` with editable geometry: a body for every closed shell, sheet
 * faces for the rest, carrying the part's tag, hidden state, shadow flags and material; source faces with a color of
 * their own keep it as their faces' material.
 */
export function makeMeshPartEditable(draft: DocumentDraft, path: readonly Id[], id: Id): MakeEditableResult {
  const state = draft as unknown as DocumentState;
  const definition = definitionAt(state, path), container = definition.entities;
  const part = container.meshParts.get(id);
  if (!part) throw new Error('The mesh part no longer exists.');
  const own = { tagId: part.tagId, hidden: part.hidden, castShadows: part.castShadows, receiveShadows: part.receiveShadows };
  const faceMaterial = (face: number): MaterialId | null => { const m = part.geometry.faceMaterials[face]!; return m && state.materials.has(m as MaterialId) ? m as MaterialId : null; };
  const { mesh, sourceFace } = facedMesh(part.geometry);
  const result: MakeEditableResult = { bodies: 0, sheetFaces: 0, warnings: [] };
  const open: number[] = [];
  for (const shell of shells(mesh, sourceFace)) {
    let m = shell.mesh, problems = meshTopologyProblems(m);
    // A closed, consistently oriented shell that is only inside out is a solid: turn it outward.
    if (problems.length === 1 && problems[0] === INSIDE_OUT) { m = { ...m, tris: reverseTriangles(m.tris) }; problems = meshTopologyProblems(m); }
    if (problems.length) { open.push(...shell.triangles); continue; }
    const body = bodyFromMesh(draft, m, { tagId: part.tagId, materialId: part.materialId, container: container as never, weldTol: MERGE_TOL });
    Object.assign(body, own);
    // The source face of each face: a flat face's own, a curved face's facets share theirs.
    const faceSource = new Map<FaceLocalId, number>();
    for (let t = 0; t < m.tris.length / 3; t++) faceSource.set(m.faceId[t]! as FaceLocalId, shell.sourceFace[t]!);
    for (const face of body.faces.values()) {
      const material = faceMaterial(faceSource.get(face.id)!);
      if (material !== null) { face.frontMaterialId = material; face.backMaterialId = material; }
    }
    for (const edge of body.edges.values()) {
      if (faceSource.get(edge.faceA) === faceSource.get(edge.faceB)) { edge.soft = true; edge.smooth = true; }
    }
    result.bodies++;
  }
  if (open.length) result.sheetFaces += openShellsAsSheets(draft, definition.id, container, part, mesh, sourceFace, open, result.warnings);
  container.meshParts.delete(id);
  container.order = container.order.filter(entry => entry !== id);
  definition.bounds = null;
  return result;
}

/** Triangles of shells that are not closed go through the mesh converter, which makes sheet faces of them. */
function openShellsAsSheets(draft: DocumentDraft, definitionId: DefId, container: EntityContainer, part: MeshPart, mesh: MeshData,
  sourceFace: Uint32Array, triangles: number[], warnings: string[]): number {
  const state = draft as unknown as DocumentState;
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
  // Only the open triangles, as a geometry of their own.
  const tris = new Uint32Array(triangles.length * 3), triangleFace = new Uint32Array(triangles.length);
  triangles.forEach((t, i) => { tris.set(mesh.tris.subarray(t * 3, t * 3 + 3), i * 3); triangleFace[i] = sourceFace[t]!; });
  const geometry: MeshPartGeometry = { ...part.geometry, positions: mesh.verts, triangles: tris, triangleFace };
  const counts: MeshCounts = { degenerate: 0, nonplanar: 0, duplicates: 0, turned: 0 };
  const { model } = groupedMeshModel([{ name: '', geometry: meshPartPolygons(geometry, materialKey) }], materials, part.source.format, counts, undefined, { meshPartThreshold: Infinity });
  const scene = prepareSketchUp(model, undefined, SHEET_FORMAT);
  const facesBefore = new Set(container.sketch.faces.keys()), edgesBefore = new Set(container.sketch.edges.keys()), bodiesBefore = new Set(container.bodies.keys());
  const report = applySketchUpImport(draft, scene, { definitionId, materialIds });
  const own = { tagId: part.tagId, hidden: part.hidden };
  for (const [faceId, face] of container.sketch.faces) if (!facesBefore.has(faceId)) Object.assign(face, own, { frontMaterialId: face.frontMaterialId ?? part.materialId, backMaterialId: face.backMaterialId ?? part.materialId });
  for (const [edgeId, edge] of container.sketch.edges) if (!edgesBefore.has(edgeId)) Object.assign(edge, own);
  for (const [bodyId, body] of container.bodies) if (!bodiesBefore.has(bodyId)) Object.assign(body, own, { castShadows: part.castShadows, receiveShadows: part.receiveShadows, materialId: body.materialId ?? part.materialId });
  warnings.push(...report.warnings.filter(w => !w.startsWith(SHEET_FORMAT.name)));
  return report.sheetFaces;
}
