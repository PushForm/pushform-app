// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { DefId, Id, Mat4, MMat4, MVec3, Plane, Vec3 } from '@pushform/core';
import {
  basisToLocal,
  COPLANAR_TOL,
  GLUE_ORIENTATION_TOL,
  LENGTH_TOL,
  m4fromBasis,
  MERGE_TOL,
  m4invert,
  m4mul,
  m4rotationAxis,
  m4transformDir,
  m4transformPoint,
  m4translation,
  planeBasis,
  planeDistance,
  planeFlip,
  planeFromPointNormal,
  PushFormError,
  v3anyPerpendicular,
  v3cross,
  v3dot,
  v3len,
  v3normalize,
  v3sub,
} from '@pushform/core';
import { cellKey, pointInPolygon } from '@pushform/geom';
import { allocId, contextMatrix, instanceAt, loopPoints, textureTiles, uvRebaseSides } from '@pushform/model';
import type { Axes, ComponentBehaviors, ComponentInstance, DocumentDraft, DocumentState, EntityContainer, EntityRef, Sketch, TextureTileOf } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { hostOf, registryOf } from '../host/services';
import { orthonormalAxes } from './axes';
import { draftContainerAt } from './context';
import { mapGuide, mapDimension, pointMapFromMatrix } from './groups';
import { mapNormal, mapSectionPlane } from './sectionPlanes';
import { EntityRefSchema } from './sketch';
import { toEntityRefs, transformBodyInPlace } from './transform';
import { componentAxesPick } from '../tools/impl/ComponentAxesTool';

/**
 * Component axes and behaviors: Change Axes re-expresses a definition in new axes without moving
 * anything; glue keeps placements on the plane of a face; Always Face Camera and Shadows Face Sun are drawn by the
 * renderer (render adapter `faceCamera`).
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const planeOrigin = (pl: Plane): MVec3 => [-pl.n[0] * pl.d, -pl.n[1] * pl.d, -pl.n[2] * pl.d];

/** A plane moved by `m` (any invertible affine matrix). */
export function mapPlane(m: Mat4 | MMat4, plane: Plane): Plane {
  return planeFromPointNormal(m4transformPoint(m, planeOrigin(plane)), mapNormal(m, plane.n));
}

/** Whether a component with `glueTo` glues to a face with world normal `n`. */
export function glueAllows(glueTo: ComponentBehaviors['glueTo'], n: Vec3): boolean {
  if (glueTo === 'none') return false;
  if (glueTo === 'any') return true;
  const up = Math.abs(v3normalize(n)[2]);
  const level = up >= Math.cos(GLUE_ORIENTATION_TOL);
  const upright = up <= Math.sin(GLUE_ORIENTATION_TOL);
  return glueTo === 'horizontal' ? level : glueTo === 'vertical' ? upright : !level && !upright;
}

// ---------------------------------------------------------------------------------------------
// Change Axes

/** Sketch geometry moved rigidly by `m` in place: ids, loops and attachments survive; textures stay put. */
export function transformSketchInPlace(sketch: Sketch, m: Mat4 | MMat4, tiles: TextureTileOf, tol: number): void {
  for (const v of sketch.vertices.values()) v.p = m4transformPoint(m, v.p);
  sketch.vertexHash.clear();
  delete sketch.packedVertexIndex;
  for (const v of sketch.vertices.values()) {
    const k = cellKey(v.p, tol);
    const list = sketch.vertexHash.get(k);
    if (list) list.push(v.id);
    else sketch.vertexHash.set(k, [v.id]);
  }
  for (const c of sketch.curves.values()) {
    c.center = m4transformPoint(m, c.center);
    c.normal = v3normalize(m4transformDir(m, c.normal));
  }
  for (const f of sketch.faces.values()) {
    const plane = mapPlane(m, f.plane);
    const basis = planeBasis(planeOrigin(plane), plane.n);
    const sides = uvRebaseSides(f, f.basis, basis, tiles(f.frontMaterialId), tiles(f.backMaterialId), (p) => m4transformPoint(m, p));
    f.plane = plane;
    f.basis = basis;
    f.uv = sides.uv;
    if (sides.uvBack) f.uvBack = sides.uvBack;
    else delete f.uvBack;
  }
}

const mapAxes = (m: Mat4 | MMat4, a: Axes): Axes => ({
  origin: m4transformPoint(m, a.origin),
  x: v3normalize(m4transformDir(m, a.x)),
  y: v3normalize(m4transformDir(m, a.y)),
  z: v3normalize(m4transformDir(m, a.z)),
});

/**
 * Give definition `defId` the axes `frame` (an orthonormal frame in its current coordinates): its contents are
 * re-expressed in the frame and every placement of it, in any container, is multiplied by the frame, so nothing
 * moves in the model.
 */
export function rebaseDefinition(draft: DocumentDraft, defId: DefId, frame: MMat4): void {
  const state = draft as unknown as DocumentState;
  const def = state.definitions.get(defId);
  if (!def) throw new PushFormError('component.missing', `No component definition ${defId}`);
  const inv = m4invert(frame);
  if (!inv) throw new PushFormError('axes.degenerate', 'The component axes are degenerate');
  const tiles = textureTiles(draft);
  const c: EntityContainer = def.entities;
  const map = pointMapFromMatrix(inv);
  for (const b of c.bodies.values()) transformBodyInPlace(b, inv, tiles);
  for (const i of c.instances.values()) {
    i.transform = m4mul(inv, i.transform) as unknown as Mat4;
    if (i.gluedPlane) i.gluedPlane = mapPlane(inv, i.gluedPlane);
  }
  for (const [id, g] of [...c.guides]) c.guides.set(id, mapGuide(g, id, map));
  for (const [id, sp] of [...c.sectionPlanes]) c.sectionPlanes.set(id, mapSectionPlane(sp, id, inv));
  for (const [id, d] of [...c.dimensions]) c.dimensions.set(id, mapDimension(d, id, inv));
  for (const t of c.texts.values()) {
    t.position = m4transformPoint(inv, t.position);
    if (t.offset) t.offset = m4transformDir(inv, t.offset);
  }
  for (const im of c.images.values()) im.transform = m4mul(inv, im.transform) as unknown as Mat4;
  transformSketchInPlace(c.sketch, inv, tiles, MERGE_TOL);
  def.axes = mapAxes(inv, def.axes);
  def.bounds = null;
  for (const d of state.definitions.values()) {
    for (const inst of d.entities.instances.values()) if (inst.definitionId === defId) inst.transform = m4mul(inst.transform, frame) as unknown as Mat4;
  }
}

/** Axes in an instance's definition coordinates from world origin and directions, as an orthonormal frame matrix. */
export function definitionFrame(worldToDefinition: Mat4 | MMat4, origin: Vec3, x: Vec3, y: Vec3, zDir?: Vec3): MMat4 {
  const axes = orthonormalAxes(
    m4transformPoint(worldToDefinition, origin),
    m4transformDir(worldToDefinition, x),
    m4transformDir(worldToDefinition, y),
    zDir ? m4transformDir(worldToDefinition, zDir) : undefined,
  );
  return m4fromBasis(axes.origin, axes.x, axes.y, axes.z);
}

function componentInstance(state: DocumentState, ref: EntityRef, what: string): ComponentInstance {
  if (ref.kind !== 'instance') throw new PushFormError('component.target', `Select a component to ${what}`);
  const inst = instanceAt(state, [...ref.path, ref.id]);
  if (!inst) throw new PushFormError('component.target', `Select a component to ${what}`);
  return inst;
}

export const componentChangeAxes = defineCommand({
  id: 'component.changeAxes',
  title: 'Change Axes',
  category: 'edit',
  params: z.object({ ref: EntityRefSchema, origin: vec3, x: vec3, y: vec3, z: vec3.optional() }),
  undoable: true,
  run(ctx, p) {
    const host = hostOf(ctx);
    const ref = toEntityRefs([p.ref])[0]!;
    const state = host.doc.state;
    const inst = componentInstance(state, ref, 'change its axes');
    const def = state.definitions.get(inst.definitionId);
    if (!def || def.isGroup) throw new PushFormError('component.group', 'Change Axes applies to components, not groups');
    if (inst.locked) throw new PushFormError('instance.locked', 'A locked component cannot change its axes');
    const toDefinition = m4invert(contextMatrix(state, [...ref.path, ref.id]));
    if (!toDefinition) throw new PushFormError('context.singular', 'The component placement is singular');
    const frame = definitionFrame(toDefinition, p.origin, p.x, p.y, p.z);
    host.edit('Change Axes', (draft) => rebaseDefinition(draft, def.id, frame));
    return { definitionId: def.id };
  },
});

/** Change Axes (context menu): pick the new axes with the component axes tool, then `component.changeAxes`. */
export const componentChangeAxesPick = defineCommand({
  id: 'component.changeAxesPick',
  title: 'Change Axes',
  category: 'edit',
  params: z.object({ ref: EntityRefSchema }),
  undoable: false,
  run(ctx, p) {
    const host = hostOf(ctx);
    const ref = toEntityRefs([p.ref])[0]!;
    const inst = componentInstance(host.doc.state, ref, 'change its axes');
    if (host.doc.state.definitions.get(inst.definitionId)?.isGroup) throw new PushFormError('component.group', 'Change Axes applies to components, not groups');
    if (inst.locked) throw new PushFormError('instance.locked', 'A locked component cannot change its axes');
    const registry = registryOf(ctx);
    componentAxesPick.request = {
      instruction: 'Pick the new component axes.',
      onPicked: (axes) => registry.execute('component.changeAxes', { ref: p.ref, origin: axes.origin, x: axes.x, y: axes.y, z: axes.z }),
    };
    ctx.tools?.activate('componentAxes');
  },
});

// ---------------------------------------------------------------------------------------------
// Glue

/**
 * World matrix placing instance `ref` on a face: its origin moves to `point`, its blue axis turns to
 * `normal`, and its red axis stays as close to where it pointed as the face allows. Rotations only, so a
 * mirrored or scaled placement keeps its handedness and scale.
 */
export function placeOnFaceMatrix(state: DocumentState, ref: EntityRef, point: Vec3, normal: Vec3): MMat4 {
  const world = contextMatrix(state, [...ref.path, ref.id]);
  const origin = m4transformPoint(world, [0, 0, 0]);
  const blue = v3normalize(m4transformDir(world, [0, 0, 1]));
  const red = v3normalize(m4transformDir(world, [1, 0, 0]));
  const n = v3normalize(normal);
  let r1: MMat4;
  const axis = v3cross(blue, n);
  if (v3len(axis) > LENGTH_TOL) r1 = m4rotationAxis(v3normalize(axis), Math.atan2(v3len(axis), v3dot(blue, n)));
  else r1 = v3dot(blue, n) > 0 ? m4translation([0, 0, 0]) : m4rotationAxis(red, Math.PI);
  const turnedRed = v3normalize(m4transformDir(r1, red));
  // red pointing straight into the face lies level on it
  const across = v3sub(red, [n[0] * v3dot(red, n), n[1] * v3dot(red, n), n[2] * v3dot(red, n)]);
  const wanted = v3len(across) > LENGTH_TOL ? across : v3len(v3cross([0, 0, 1], n)) > LENGTH_TOL ? v3cross([0, 0, 1], n) : v3anyPerpendicular(n);
  let r = r1;
  if (v3len(wanted) > LENGTH_TOL) {
    const w = v3normalize(wanted);
    const angle = Math.atan2(v3dot(n, v3cross(turnedRed, w)), v3dot(turnedRed, w));
    r = m4mul(m4rotationAxis(n, angle), r1);
  }
  return m4mul(m4translation(point), m4mul(r, m4translation([-origin[0], -origin[1], -origin[2]])));
}

export const componentPlaceOnFace = defineCommand({
  id: 'component.placeOnFace',
  title: 'Move',
  category: 'internal',
  params: z.object({ ref: EntityRefSchema, point: vec3, normal: vec3, copy: z.boolean().optional() }),
  undoable: true,
  run(ctx, p): EntityRef {
    const host = hostOf(ctx);
    const ref = toEntityRefs([p.ref])[0]!;
    const state = host.doc.state;
    const inst = componentInstance(state, ref, 'place it');
    if (inst.locked && !p.copy) throw new PushFormError('instance.locked', 'A locked group/component cannot be moved');
    const parent = contextMatrix(state, ref.path);
    const parentInv = m4invert(parent);
    if (!parentInv) throw new PushFormError('context.singular', 'The context transform is singular');
    const local = m4mul(parentInv, m4mul(placeOnFaceMatrix(state, ref, p.point, p.normal), parent));
    const plane = mapPlane(parentInv, planeFromPointNormal(p.point, p.normal));
    let placed: Id = ref.id;
    host.edit(p.copy ? 'Copy' : 'Move', (draft) => {
      const container = draftContainerAt(draft, ref.path);
      const source = container.instances.get(ref.id)!;
      let target = source;
      if (p.copy) {
        target = { ...source, id: allocId<Id>(draft), attributes: JSON.parse(JSON.stringify(source.attributes)) as typeof source.attributes };
        container.instances.set(target.id, target);
        container.order.push(target.id);
      }
      target.transform = m4mul(local, source.transform) as unknown as Mat4;
      target.gluedPlane = plane;
      placed = target.id;
    });
    const out: EntityRef = { kind: 'instance', path: ref.path, id: placed };
    if (p.copy) host.selection.set([out]);
    return out;
  },
});

export const componentUnglue = defineCommand({
  id: 'component.unglue',
  title: 'Unglue',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema).optional() }),
  undoable: true,
  run(ctx, p) {
    const host = hostOf(ctx);
    const refs = (p.refs ? toEntityRefs(p.refs) : host.selection.refs).filter((r) => r.kind === 'instance');
    const state = host.doc.state;
    const glued = refs.filter((r) => instanceAt(state, [...r.path, r.id])?.gluedPlane);
    if (!glued.length) throw new PushFormError('component.notGlued', 'Nothing selected is glued');
    host.edit('Unglue', (draft) => {
      for (const r of glued) {
        const inst = instanceAt(draft as unknown as DocumentState, [...r.path, r.id]);
        if (inst) delete inst.gluedPlane;
      }
    });
    return { count: glued.length };
  },
});

/**
 * Plane of a face in `container` (local coordinates) that a component made with `glueTo` glues to: a sketch
 * face or face of a solid of an allowed orientation that contains `origin` and whose normal runs along `blue`.
 * `toWorldNormal` judges the orientation in the model.
 */
export function glueFaceAt(container: EntityContainer, glueTo: ComponentBehaviors['glueTo'], origin: Vec3, blue: Vec3, toWorldNormal: (n: Vec3) => Vec3): Plane | null {
  if (glueTo === 'none') return null;
  const b = v3normalize(blue);
  const candidates: { plane: Plane; loops: (readonly Vec3[])[] }[] = [];
  for (const f of container.sketch.faces.values()) candidates.push({ plane: f.plane, loops: f.loops.map((l) => loopPoints(container.sketch, l)) });
  for (const body of container.bodies.values()) for (const f of body.faces.values()) candidates.push({ plane: f.plane, loops: f.loops });
  for (const c of candidates) {
    if (Math.abs(v3dot(c.plane.n, b)) < Math.cos(GLUE_ORIENTATION_TOL)) continue;
    if (Math.abs(planeDistance(c.plane, origin)) > COPLANAR_TOL) continue;
    if (!glueAllows(glueTo, toWorldNormal(c.plane.n))) continue;
    const basis = planeBasis(planeOrigin(c.plane), c.plane.n);
    const uv = (p: Vec3): [number, number] => {
      const l = basisToLocal(basis, p);
      return [l[0], l[1]];
    };
    // stored facing the way the component's blue axis points
    if (pointInPolygon(uv(origin), c.loops.map((loop) => loop.map(uv)))) return v3dot(c.plane.n, b) >= 0 ? c.plane : planeFlip(c.plane);
  }
  return null;
}

export const componentBehaviorCommands: readonly AnyCommand[] = [componentChangeAxes, componentChangeAxesPick, componentPlaceOnFace, componentUnglue];
