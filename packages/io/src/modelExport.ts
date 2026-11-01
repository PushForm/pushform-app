// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { basisToLocal, m4determinant, type Id, type ImageId, type MaterialId, type MMat4, type PlaneBasis, type Vec3 } from '@pushform/core';
import { triangulatePlanarFace } from '@pushform/geom';
import {
  pathKey, sketchFaceLoops, tagVisible, uvAt,
  type Body, type ComponentDefinition, type DocumentState, type EntityRef, type Material, type UvMapping,
} from '@pushform/model';

// The scene the glTF, OBJ and COLLADA exporters write: the visible model, or its selection, as a
// tree of placements whose geometry is triangles grouped by material, with normals that follow smooth edges and
// texture coordinates from each face's placement. Coordinates are meters with Z up; each writer converts them.

/** An image a texture shows, as the document's image store holds it. */
export interface ExportImage { bytes: Uint8Array; mime: string; name: string }
export interface ModelExportOptions {
  /** Export only these entities (and everything inside selected groups and components); null or absent exports the whole model. */
  selection?: readonly EntityRef[] | null | undefined;
  /** The model's name, for the root node and the files. */
  name?: string | undefined;
  /** The bytes of a texture's image; textures without one export their material's color. */
  image?: ((id: ImageId) => ExportImage | undefined) | undefined;
}

/** Triangles of one material, with a normal for every corner and texture coordinates (tiles, t up) where it is textured. */
export interface ExportPrimitive {
  material: number | null;
  positions: number[];
  normals: number[];
  uvs: number[] | null;
  indices: number[];
}
/** The geometry of one definition as placed: shared by every placement that shows the same contents. */
export interface ExportMesh { name: string; primitives: ExportPrimitive[]; lines: number[] }
export interface ExportNode {
  name: string;
  /** Local-to-parent transform, column-major, in meters. */
  matrix: MMat4;
  mesh: number | null;
  children: ExportNode[];
}
export interface ExportMaterial {
  name: string;
  /** sRGB, 0–1. */
  color: [number, number, number];
  alpha: number;
  /** The texture's image (index into `images`), or null for a plain color. */
  image: number | null;
}
export interface ExportScene {
  name: string;
  root: ExportNode;
  meshes: ExportMesh[];
  materials: ExportMaterial[];
  images: ExportImage[];
  /** How many placements show each mesh. */
  uses: number[];
  triangles: number;
  notes: string[];
}

const IDENTITY: MMat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** The file name for a model's export: its name with `extension` in place of `.pf`. */
export function exportFileName(name: string, extension: string): string {
  return `${name.replace(/\.pf$/i, '') || 'Model'}${extension}`;
}

/**
 * Collect the visible model, or the selected part of it, for export. Hidden entities, those on hidden tags, and
 * hidden placements with everything inside them are left out; a solid keeps all of its faces, its hidden faces
 * included, so it stays closed. Faces painted with the default material take the material of the nearest painted
 * placement around them, as they are drawn.
 */
export function collectExportScene(state: DocumentState, options: ModelExportOptions = {}): ExportScene {
  const selected = options.selection ? selectionScope(options.selection) : null;
  const name = (options.name ?? 'Model').replace(/\.pf$/i, '').trim() || 'Model';
  const meshes: ExportMesh[] = [], uses: number[] = [], meshKeys = new Map<string, number | null>();
  const materials: ExportMaterial[] = [], materialIndex = new Map<MaterialId, number>(), images: ExportImage[] = [], imageIndex = new Map<ImageId, number>();
  let missingImages = 0, triangles = 0;
  const skipped = new Set<string>();

  const materialOf = (id: MaterialId | null): number | null => {
    if (id === null) return null;
    const known = materialIndex.get(id);
    if (known !== undefined) return known;
    const material = state.materials.get(id);
    if (!material) return null;
    let image: number | null = null;
    if (material.texture) {
      const imageId = material.texture.imageId;
      image = imageIndex.get(imageId) ?? null;
      if (image === null) {
        const found = options.image?.(imageId);
        if (found) { image = images.length; images.push(found); imageIndex.set(imageId, image); } else missingImages++;
      }
    }
    const index = materials.length;
    materials.push({ name: material.name || `Material ${index + 1}`, color: [material.color[0], material.color[1], material.color[2]], alpha: material.alpha, image });
    materialIndex.set(id, index);
    return index;
  };
  const textureOf = (id: MaterialId | null): Material['texture'] => (id === null ? null : state.materials.get(id)?.texture ?? null);

  /** A definition's own visible geometry, as placed with `inherited` filling default-material faces. */
  const buildMesh = (definition: ComponentDefinition, path: readonly number[], inherited: MaterialId | null, whole: boolean): ExportMesh | null => {
    const entities = definition.entities, key = pathKey(path as Id[]);
    const byMaterial = new Map<string, { primitive: ExportPrimitive; corners: Map<string, number> }>();
    const lines: number[] = [];
    const add = (material: MaterialId | null, a: Vec3, b: Vec3, c: Vec3, normals: [Vec3, Vec3, Vec3], uv: ((p: Vec3) => [number, number]) | null): void => {
      const index = materialOf(material), textured = uv !== null && index !== null && materials[index]!.image !== null;
      const slot = `${index}|${textured}`;
      let entry = byMaterial.get(slot);
      if (!entry) { entry = { primitive: { material: index, positions: [], normals: [], uvs: textured ? [] : null, indices: [] }, corners: new Map() }; byMaterial.set(slot, entry); }
      const { primitive, corners } = entry;
      [a, b, c].forEach((p, k) => {
        const n = normals[k]!, st = textured ? uv!(p) : null;
        const cornerKey = `${p.join(',')}|${n.join(',')}|${st?.join(',') ?? ''}`;
        let at = corners.get(cornerKey);
        if (at === undefined) {
          at = primitive.positions.length / 3; corners.set(cornerKey, at);
          primitive.positions.push(...p); primitive.normals.push(...n);
          if (st) primitive.uvs!.push(...st);
        }
        primitive.indices.push(at);
      });
    };
    const placement = (material: MaterialId | null, basis: PlaneBasis, mapping: UvMapping): ((p: Vec3) => [number, number]) | null => {
      const texture = textureOf(material);
      if (!texture) return null;
      // Exact at each vertex; the formats interpolate affinely, so a distorted placement is approximate between them.
      return p => { const [u, v] = basisToLocal(basis, p); return uvAt(mapping, texture.widthM, texture.heightM, u, v) as [number, number]; };
    };

    for (const body of entities.bodies.values()) {
      if (body.hidden || !tagVisible(state, body.tagId)) continue;
      const wholeBody = whole || !!selected?.bodies.has(`${key}|${body.id}`);
      const faces = wholeBody ? null : selected?.faces.get(`${key}|${body.id}`);
      if (!wholeBody && !faces) continue;
      const normalAt = smoothNormals(body);
      const { verts, tris, faceId } = body.mesh;
      const at = (i: number): Vec3 => [verts[i * 3]!, verts[i * 3 + 1]!, verts[i * 3 + 2]!];
      for (let t = 0; t + 2 < tris.length; t += 3) {
        const id = faceId[t / 3]!, face = body.faces.get(id as never);
        if (!face || (faces && !faces.has(id))) continue;
        const material = face.frontMaterialId ?? body.materialId ?? inherited;
        const p = at(tris[t]!), q = at(tris[t + 1]!), r = at(tris[t + 2]!);
        add(material, p, q, r, [normalAt(id, p), normalAt(id, q), normalAt(id, r)], placement(material, face.basis, face.uv));
      }
    }
    for (const face of entities.sketch.faces.values()) {
      if (face.hidden || !tagVisible(state, face.tagId)) continue;
      if (!whole && !selected?.sketchFaces.has(`${key}|${face.id}`)) continue;
      const tri = triangulatePlanarFace(sketchFaceLoops(entities.sketch, face), face.basis);
      const at = (i: number): Vec3 => [tri.positions[i * 3]!, tri.positions[i * 3 + 1]!, tri.positions[i * 3 + 2]!];
      const n = face.basis.n, back: Vec3 = [-n[0] + 0, -n[1] + 0, -n[2] + 0];
      const front = face.frontMaterialId ?? inherited, behind = face.backMaterialId ?? inherited;
      for (let t = 0; t + 2 < tri.indices.length; t += 3) {
        const p = at(tri.indices[t]!), q = at(tri.indices[t + 1]!), r = at(tri.indices[t + 2]!);
        add(front, p, q, r, [n, n, n], placement(front, face.basis, face.uv));
        // A back side painted differently is the same face wound the other way, as two-sided exports write it.
        if (behind !== front) add(behind, p, r, q, [back, back, back], placement(behind, face.basis, face.uvBack ?? face.uv));
      }
    }
    for (const part of entities.meshParts.values()) {
      if (part.hidden || !tagVisible(state, part.tagId)) continue;
      if (!whole && !selected?.meshParts.has(`${key}|${part.id}`)) continue;
      const g = part.geometry;
      for (let t = 0; t < g.triangles.length; t += 3) {
        const at = (k: number): Vec3 => {
          const i = g.triangles[t + k]! * 3;
          return [g.positions[i]!, g.positions[i + 1]!, g.positions[i + 2]!];
        };
        const a = at(0), b = at(1), c = at(2);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n: Vec3 = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
        const length = Math.hypot(...n);
        if (!length) continue;
        const normal: Vec3 = [n[0] / length, n[1] / length, n[2] / length];
        const material = g.faceMaterials[g.triangleFace[t / 3]!] || part.materialId || inherited;
        add(material as MaterialId | null, a, b, c, [normal, normal, normal], null);
      }
    }
    // Edges that bound no face (lines, arcs) are lines.
    const bounding = new Set<number>();
    for (const face of entities.sketch.faces.values()) for (const loop of face.loops) for (const ref of loop) bounding.add(ref.edgeId);
    for (const edge of entities.sketch.edges.values()) {
      if (bounding.has(edge.id) || edge.hidden || !tagVisible(state, edge.tagId)) continue;
      if (!whole && !selected?.edges.has(`${key}|${edge.id}`)) continue;
      const a = entities.sketch.vertices.get(edge.a)?.p, b = entities.sketch.vertices.get(edge.b)?.p;
      if (a && b) lines.push(...a, ...b);
    }
    if (entities.guides.size) skipped.add('guides');
    if (entities.dimensions.size) skipped.add('dimensions');
    if (entities.texts.size) skipped.add('text');
    if (entities.sectionPlanes.size) skipped.add('section planes');
    const primitives = [...byMaterial.values()].map(entry => entry.primitive);
    if (!primitives.length && !lines.length) return null;
    return { name: definition.name || name, primitives, lines };
  };
  const meshFor = (definition: ComponentDefinition, path: readonly number[], inherited: MaterialId | null, whole: boolean): number | null => {
    // Whole contents are the same at every placement with the same inherited material; a partly selected one is its own.
    const key = whole ? `${definition.id}|${inherited ?? ''}` : `path:${pathKey(path as Id[])}`;
    let index = meshKeys.get(key);
    if (index === undefined) {
      const mesh = buildMesh(definition, path, inherited, whole);
      index = mesh ? meshes.push(mesh) - 1 : null;
      if (mesh) uses.push(0);
      meshKeys.set(key, index);
    }
    if (index !== null) {
      uses[index]!++;
      triangles += meshes[index]!.primitives.reduce((sum, p) => sum + p.indices.length / 3, 0);
    }
    return index;
  };

  const visit = (definition: ComponentDefinition, path: number[], inherited: MaterialId | null, whole: boolean, seen: Set<number>): { mesh: number | null; children: ExportNode[] } => {
    const children: ExportNode[] = [];
    for (const instance of definition.entities.instances.values()) {
      const child = state.definitions.get(instance.definitionId);
      if (!child || seen.has(child.id) || instance.hidden || !tagVisible(state, instance.tagId)) continue;
      const childPath = [...path, instance.id], key = pathKey(childPath as Id[]);
      const childWhole = whole || !!selected?.instances.has(key);
      if (!childWhole && !selected?.within.has(key)) continue;
      const content = visit(child, childPath, instance.materialId ?? inherited, childWhole, new Set([...seen, child.id]));
      if (content.mesh === null && !content.children.length) continue;
      children.push({ name: instance.name || child.name, matrix: [...(instance.transform as ArrayLike<number> as number[])], mesh: content.mesh, children: content.children });
    }
    return { mesh: meshFor(definition, path, inherited, whole), children };
  };
  const rootDefinition = state.definitions.get(state.rootDefinitionId);
  if (!rootDefinition) throw new Error('The model has no root definition.');
  const content = visit(rootDefinition, [], null, selected === null, new Set([rootDefinition.id]));
  const root: ExportNode = { name, matrix: [...IDENTITY], mesh: content.mesh, children: content.children };
  if (!triangles && !meshes.some(mesh => mesh.lines.length))
    throw new Error(selected ? 'The selection has no visible faces or edges to export.' : 'The model has no visible faces or edges to export.');

  const notes: string[] = [];
  if (missingImages) notes.push(`${missingImages} texture image${missingImages === 1 ? ' is' : 's are'} not available; ${missingImages === 1 ? 'its material exports its' : 'their materials export their'} color.`);
  if (skipped.size) {
    const list = [...skipped];
    const named = list.length === 1 ? list[0]! : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
    notes.push(`${named[0]!.toUpperCase()}${named.slice(1)} ${list.length === 1 && !named.endsWith('s') ? 'is' : 'are'} not exported.`);
  }
  return { name, root, meshes, materials, images, uses, triangles, notes };
}

/** Whether a placement's matrix mirrors (turns faces inside out). */
export function isMirrored(matrix: MMat4): boolean {
  return m4determinant(matrix) < 0;
}

/**
 * Corner normals that follow smooth edges: a corner's normal averages the planes of the faces around it that smooth
 * edges join to its own face, so a face joined by no smooth edge keeps its plane's normal.
 */
function smoothNormals(body: Body): (face: number, p: Vec3) => Vec3 {
  const pointKey = (p: Vec3): string => `${p[0].toFixed(9)},${p[1].toFixed(9)},${p[2].toFixed(9)}`;
  // Per point, the faces smooth edges join there, as union-find parents.
  const joined = new Map<string, Map<number, number>>();
  const find = (sets: Map<number, number>, f: number): number => {
    let root = sets.get(f) ?? f;
    while (root !== (sets.get(root) ?? root)) root = sets.get(root)!;
    return root;
  };
  for (const edge of body.edges.values()) {
    if (!edge.smooth) continue;
    for (const p of edge.polyline) {
      const key = pointKey(p), sets = joined.get(key) ?? joined.set(key, new Map()).get(key)!;
      const a = find(sets, edge.faceA), b = find(sets, edge.faceB);
      if (!sets.has(a)) sets.set(a, a);
      if (!sets.has(b)) sets.set(b, b);
      if (a !== b) sets.set(a, b);
    }
  }
  const planeNormal = (face: number): Vec3 => body.faces.get(face as never)?.plane.n ?? [0, 0, 1];
  const cache = new Map<string, Vec3>();
  return (face, p) => {
    const key = pointKey(p), sets = joined.get(key);
    if (!sets?.has(face)) return planeNormal(face);
    const cacheKey = `${face}|${key}`, known = cache.get(cacheKey);
    if (known) return known;
    const root = find(sets, face), sum: [number, number, number] = [0, 0, 0];
    for (const member of sets.keys()) if (find(sets, member) === root) {
      const n = planeNormal(member);
      sum[0] += n[0]; sum[1] += n[1]; sum[2] += n[2];
    }
    const length = Math.hypot(...sum), out: Vec3 = length > 0 ? [sum[0] / length, sum[1] / length, sum[2] / length] : planeNormal(face);
    cache.set(cacheKey, out);
    return out;
  };
}

/** Selected entities by container path key: whole placements, bodies, body faces, sheet faces and edges, and every placement a selection lies inside. */
export function selectionScope(refs: readonly EntityRef[]) {
  const scope = {
    instances: new Set<string>(), bodies: new Set<string>(), faces: new Map<string, Set<number>>(), sketchFaces: new Set<string>(),
    edges: new Set<string>(), meshParts: new Set<string>(), within: new Set<string>(),
  };
  for (const ref of refs) {
    const key = pathKey(ref.path);
    for (let i = 1; i <= ref.path.length; i++) scope.within.add(pathKey(ref.path.slice(0, i)));
    if (ref.kind === 'instance') scope.instances.add(pathKey([...ref.path, ref.id]));
    else if (ref.kind === 'body') scope.bodies.add(`${key}|${ref.id}`);
    else if (ref.kind === 'meshPart') scope.meshParts.add(`${key}|${ref.id}`);
    else if (ref.kind === 'face') {
      const faces = scope.faces.get(`${key}|${ref.id}`) ?? scope.faces.set(`${key}|${ref.id}`, new Set()).get(`${key}|${ref.id}`)!;
      faces.add(ref.faceId);
    } else if (ref.kind === 'sketchFace') scope.sketchFaces.add(`${key}|${ref.id}`);
    else if (ref.kind === 'sketchEdge') scope.edges.add(`${key}|${ref.id}`);
  }
  return scope;
}
