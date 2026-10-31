// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { m4determinant, m4identity, m4transformPoint, v3cross, v3len, v3sub, type Box3, type DefId, type MMat4, type Vec3 } from '@pushform/core';
import { walkInstances } from './context';
import type { ComponentDefinition, DocumentState } from './entities';
import { sketchFaceLoops } from './sketch/sketchFace';

/**
 * Model statistics as counted per placement: every placement of a group or
 * component counts its contents again, hidden or not. The sample check uses them to compare an import with the
 * source model.
 */
export interface ModelStatistics {
  faces: number;
  edges: number;
  vertices: number;
  /** Total face area in m², each face once. */
  area: number;
  /**
   * Total volume in m³ of the group and component placements counted as solids, scaled by each placement:
   * those whose contents are closed solids only, without sheet faces, loose edges, or groups, components or images
   * nested beside them (a group holding another group is not a solid). Geometry at the top of the model
   * has no volume.
   */
  volume: number;
  /** World bounds of faces and edges in meters, or null for an empty model. */
  bounds: Box3 | null;
  /** Group and component definitions placed somewhere in the model. */
  definitions: number;
  /** Placements of groups and components, every nesting level counted. */
  instances: number;
  /** Materials other than the default material. */
  materials: number;
  /** Tags other than Untagged. */
  tags: number;
  scenes: number;
}

function loopArea(loop: readonly Vec3[]): number {
  let total: Vec3 = [0, 0, 0];
  for (let i = 1; i + 1 < loop.length; i++) {
    const c = v3cross(v3sub(loop[i]!, loop[0]!), v3sub(loop[i + 1]!, loop[0]!));
    total = [total[0] + c[0], total[1] + c[1], total[2] + c[2]];
  }
  return v3len(total) / 2;
}
const faceArea = (loops: readonly (readonly Vec3[])[], matrix: MMat4): number => {
  const world = loops.map(loop => loop.map(p => m4transformPoint(matrix, p) as Vec3));
  return loopArea(world[0] ?? []) - world.slice(1).reduce((sum, loop) => sum + loopArea(loop), 0);
};

export function modelStatistics(state: DocumentState): ModelStatistics {
  const stats: ModelStatistics = { faces: 0, edges: 0, vertices: 0, area: 0, volume: 0, bounds: null, definitions: 0, instances: 0,
    materials: [...state.materials.keys()].filter(id => id !== state.defaultMaterialId).length,
    tags: [...state.tags.keys()].filter(id => id !== state.defaultTagId).length, scenes: state.scenes.size };
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const include = (p: Vec3): void => { for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, p[k]!); max[k] = Math.max(max[k]!, p[k]!); } };
  const count = (definition: ComponentDefinition, matrix: MMat4, placed: boolean): void => {
    const scale = Math.abs(m4determinant(matrix)), entities = definition.entities;
    for (const body of entities.bodies.values()) {
      stats.faces += body.faces.size;
      for (const edge of body.edges.values()) stats.edges += Math.max(1, edge.polyline.length - 1);
      stats.vertices += body.mesh.verts.length / 3;
      for (const face of body.faces.values()) stats.area += faceArea(face.loops, matrix);
      for (let i = 0; i < body.mesh.verts.length; i += 3)
        include(m4transformPoint(matrix, [body.mesh.verts[i]!, body.mesh.verts[i + 1]!, body.mesh.verts[i + 2]!]) as Vec3);
    }
    for (const part of entities.meshParts.values()) {
      const p = part.geometry.positions;
      stats.vertices += p.length / 3;
      for (let i = 0; i < p.length; i += 3) include(m4transformPoint(matrix, [p[i]!, p[i + 1]!, p[i + 2]!]) as Vec3);
    }
    const sketch = entities.sketch;
    stats.faces += sketch.faces.size;
    stats.edges += sketch.edges.size;
    stats.vertices += sketch.vertices.size;
    for (const face of sketch.faces.values()) stats.area += faceArea(sketchFaceLoops(sketch, face), matrix);
    for (const vertex of sketch.vertices.values()) include(m4transformPoint(matrix, vertex.p) as Vec3);
    const solid = placed && entities.bodies.size > 0 && sketch.faces.size === 0 && sketch.edges.size === 0 && entities.instances.size === 0 &&
      entities.images.size === 0 && entities.meshParts.size === 0 && [...entities.bodies.values()].every(body => body.valid);
    if (solid) for (const body of entities.bodies.values()) stats.volume += body.props.volume * scale;
  };
  const root = state.definitions.get(state.rootDefinitionId);
  if (root) count(root, m4identity(), false);
  const placed = new Set<number>();
  for (const visit of walkInstances(state)) {
    stats.instances++;
    placed.add(visit.definition.id);
    count(visit.definition, visit.matrix, true);
  }
  stats.definitions = placed.size;
  if (Number.isFinite(min[0])) stats.bounds = { min, max };
  return stats;
}

/** Entity counts shown by Model Info's Statistics. */
export interface EntityCounts {
  solids: number;
  /** Faces of solids. */
  solidFaces: number;
  /** Faces of sheet (loose) geometry. */
  sheetFaces: number;
  /** Edge segments of solids and sheet geometry. */
  edges: number;
  /** Placements of groups. */
  groups: number;
  /** Placements of components. */
  componentInstances: number;
  guides: number;
  dimensions: number;
  texts: number;
  images: number;
  sectionPlanes: number;
  /** Mesh parts (display-only imported geometry) and the triangles they hold. */
  meshParts: number;
  meshPartTriangles: number;
  /** Component definitions in the model, placed or not. */
  componentDefinitions: number;
  /** Materials other than the default material. */
  materials: number;
  /** Tags other than Untagged. */
  tags: number;
  styles: number;
  scenes: number;
}

/**
 * Counts the model's entities: the top level of the model, or with `nested` the contents of every group and
 * component placement too, each placement counted again. Hidden entities count. With `definitionId`, the entities are
 * those of that group or component; the model-wide counts (definitions, materials, tags, styles, scenes) stay.
 */
export function entityCounts(state: DocumentState, nested: boolean, definitionId: DefId = state.rootDefinitionId): EntityCounts {
  const counts: EntityCounts = { solids: 0, solidFaces: 0, sheetFaces: 0, edges: 0, groups: 0, componentInstances: 0, guides: 0,
    dimensions: 0, texts: 0, images: 0, sectionPlanes: 0, meshParts: 0, meshPartTriangles: 0,
    componentDefinitions: [...state.definitions.values()].filter(d => d.id !== state.rootDefinitionId && !d.isGroup).length,
    materials: [...state.materials.keys()].filter(id => id !== state.defaultMaterialId).length,
    tags: [...state.tags.keys()].filter(id => id !== state.defaultTagId).length, styles: state.styles.size, scenes: state.scenes.size };
  const contents = (definition: ComponentDefinition): void => {
    const entities = definition.entities;
    counts.solids += entities.bodies.size;
    for (const body of entities.bodies.values()) {
      counts.solidFaces += body.faces.size;
      for (const edge of body.edges.values()) counts.edges += Math.max(1, edge.polyline.length - 1);
    }
    counts.sheetFaces += entities.sketch.faces.size;
    counts.edges += entities.sketch.edges.size;
    counts.guides += entities.guides.size;
    counts.dimensions += entities.dimensions.size;
    counts.texts += entities.texts.size;
    counts.images += entities.images.size;
    counts.sectionPlanes += entities.sectionPlanes.size;
    counts.meshParts += entities.meshParts.size;
    for (const part of entities.meshParts.values()) counts.meshPartTriangles += part.geometry.triangles.length / 3;
  };
  const placement = (definition: ComponentDefinition): void => { if (definition.isGroup) counts.groups++; else counts.componentInstances++; };
  const top = state.definitions.get(definitionId);
  if (!top) return counts;
  contents(top);
  // Each placement inside `top`, at every depth with `nested`; a definition that contains itself is not entered again.
  const visit = (definition: ComponentDefinition, enclosing: ReadonlySet<DefId>): void => {
    for (const instance of definition.entities.instances.values()) {
      const placed = state.definitions.get(instance.definitionId);
      if (!placed) continue;
      placement(placed);
      if (nested && !enclosing.has(placed.id)) { contents(placed); visit(placed, new Set([...enclosing, placed.id])); }
    }
  };
  visit(top, new Set([top.id]));
  return counts;
}
