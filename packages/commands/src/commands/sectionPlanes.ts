// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { Id, Mat4, MMat4, MVec3, Vec3 } from '@pushform/core';
import { m4transformDir, m4transformPoint, planeBasis, planeFromPointNormal, PushFormError, v3cross, v3dot, v3len, v3normalize } from '@pushform/core';
import { allocId, containerAt, worldSectionPlane, contextMatrix } from '@pushform/model';
import type { DocumentState, SectionPlane } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand } from '../registry/Command';
import { activeTagOpt, hostOf } from '../host/services';
import { contextFrame, draftContainerAt, requireContextPath } from './context';

const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Plane normal under an affine map: normal to the mapped plane, on the side the mapped normal
 * points to, so a section plane keeps cutting away the same side after a mirror or skew.
 */
export function mapNormal(m: Mat4 | MMat4, n: Vec3): MVec3 {
  const b = planeBasis([0, 0, 0], n), along = m4transformDir(m, b.n);
  const mapped = v3cross(m4transformDir(m, b.u), m4transformDir(m, b.v));
  if (v3len(mapped) === 0) return [b.n[0], b.n[1], b.n[2]];
  const un = v3normalize(mapped);
  return v3dot(un, along) < 0 ? [-un[0], -un[1], -un[2]] : un;
}

/** A section plane moved by `m` under a new or the same id; it keeps the side it cuts away. */
export function mapSectionPlane(s: SectionPlane, id: Id, m: Mat4 | MMat4): SectionPlane {
  const origin = m4transformPoint(m, s.origin);
  return { ...s, id, attributes: cloneJson(s.attributes), origin, plane: planeFromPointNormal(origin, mapNormal(m, s.plane.n)) };
}

/** The next free "Section n" name and symbol of a model, counting the section planes of every definition. */
export function nextSectionPlaneName(state: DocumentState): { name: string; symbol: string } {
  const taken = new Set<string>();
  for (const def of state.definitions.values()) for (const sp of def.entities.sectionPlanes.values()) { taken.add(sp.name); taken.add(sp.symbol); }
  for (let n = 1; ; n++) if (!taken.has(`Section ${n}`) && !taken.has(String(n))) return { name: `Section ${n}`, symbol: String(n) };
}

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const idSchema = z.number().int().nonnegative();
const planeRef = z.object({ path: z.array(idSchema), id: idSchema });
type PlaneRef = z.infer<typeof planeRef>;

/** The container and section plane a ref names, in a draft or a state; throws when either is missing. */
function planeAt(state: DocumentState, ref: PlaneRef): { sp: SectionPlane } {
  let sp: SectionPlane | undefined;
  try {
    sp = containerAt(state, ref.path as Id[]).sectionPlanes.get(ref.id as Id);
  } catch {
    sp = undefined;
  }
  if (!sp) throw new PushFormError('sectionPlane.target', 'That section plane no longer exists');
  return { sp };
}

/**
 * Place a section plane in the open edit context through `point` with `normal` (world coordinates) pointing to the side it keeps
 * Named and numbered after the model's other section planes unless given, on the active tag, and made the
 * context's active cut.
 */
export const addSectionPlane = defineCommand({
  id: 'sectionPlane.add',
  title: 'Section Plane',
  category: 'draw',
  params: z.object({ point: vec3, normal: vec3, name: z.string().trim().min(1).max(200).optional(), symbol: z.string().trim().min(1).max(3).optional() }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    if (v3len(p.normal) === 0) throw new PushFormError('sectionPlane.normal', 'A section plane needs a direction');
    const path = host.context.path;
    const frame = contextFrame(host.doc.state, path);
    const point = frame.toLocal(p.point), normal = frame.toLocalNormal(p.normal);
    const tag = activeTagOpt(ctx);
    let id = 0;
    host.edit('Section Plane', (draft) => {
      const state = draft as unknown as DocumentState;
      const auto = nextSectionPlaneName(state);
      const container = draftContainerAt(draft, path);
      id = allocId<Id>(draft);
      container.sectionPlanes.set(id as Id, {
        id: id as Id, name: p.name ?? auto.name, symbol: p.symbol ?? auto.symbol, plane: planeFromPointNormal(point, normal), origin: point,
        tagId: tag.tagId ?? state.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {},
      });
      container.order.push(id as Id);
      container.activeSectionPlaneId = id as Id;
    });
    host.selection.set([{ kind: 'sectionPlane', path: [...path], id: id as Id }]);
    return id;
  },
});

/** Make a section plane its container's active cut, or turn the container's cut off. */
export const setActiveSectionPlane = defineCommand({
  id: 'sectionPlane.setActive',
  title: 'Active Cut',
  category: 'edit',
  params: planeRef.extend({ active: z.boolean() }),
  undoable: true,
  run(ctx, p): void {
    const host = hostOf(ctx);
    planeAt(host.doc.state, p);
    host.edit('Active Cut', (draft) => {
      const container = draftContainerAt(draft, p.path);
      if (p.active) container.activeSectionPlaneId = p.id as Id;
      else if (container.activeSectionPlaneId === p.id) container.activeSectionPlaneId = null;
    });
  },
});

/** Turn section planes around: each cuts away the side it kept before. */
export const reverseSectionPlanes = defineCommand({
  id: 'sectionPlane.reverse',
  title: 'Reverse',
  category: 'edit',
  params: z.object({ refs: z.array(planeRef) }),
  undoable: true,
  run(ctx, p): void {
    const host = hostOf(ctx);
    for (const r of p.refs) planeAt(host.doc.state, r);
    host.edit('Reverse Section Plane', (draft) => {
      for (const r of p.refs) {
        const sp = draftContainerAt(draft, r.path).sectionPlanes.get(r.id as Id);
        // `+ 0` keeps a zero component from turning into -0
        if (sp) sp.plane = { n: [-sp.plane.n[0] + 0, -sp.plane.n[1] + 0, -sp.plane.n[2] + 0], d: -sp.plane.d + 0 };
      }
    });
  },
});

/** Hide or show section planes; a hidden active plane still cuts. Hiding deselects them. */
export const setSectionPlanesHidden = defineCommand({
  id: 'sectionPlane.setHidden',
  title: 'Hide',
  category: 'edit',
  params: z.object({ refs: z.array(planeRef), hidden: z.boolean() }),
  undoable: true,
  run(ctx, p): void {
    const host = hostOf(ctx);
    host.edit(p.hidden ? 'Hide' : 'Unhide', (draft) => {
      for (const r of p.refs) {
        const sp = draftContainerAt(draft, requireContextPath(host, r.path, 'Section plane')).sectionPlanes.get(r.id as Id);
        if (sp) sp.hidden = p.hidden;
      }
    });
    if (p.hidden) {
      const keys = new Set(p.refs.map((r) => `${r.path.join('.')}/${r.id}`));
      host.selection.set(host.selection.refs.filter((r) => r.kind !== 'sectionPlane' || !keys.has(`${r.path.join('.')}/${r.id}`)));
    }
  },
});

/** Rename a section plane and change its symbol. */
export const renameSectionPlane = defineCommand({
  id: 'sectionPlane.rename',
  title: 'Rename Section Plane',
  category: 'edit',
  params: planeRef.extend({ name: z.string().trim().min(1).max(200).optional(), symbol: z.string().trim().min(1).max(3).optional() }),
  undoable: true,
  run(ctx, p): void {
    const host = hostOf(ctx);
    planeAt(host.doc.state, p);
    host.edit('Rename Section Plane', (draft) => {
      const sp = draftContainerAt(draft, p.path).sectionPlanes.get(p.id as Id);
      if (!sp) return;
      if (p.name !== undefined) sp.name = p.name;
      if (p.symbol !== undefined) sp.symbol = p.symbol;
    });
  },
});

/** Look straight at a section plane from the side it cuts away, keeping the camera's distance. */
export const alignViewToSectionPlane = defineCommand({
  id: 'sectionPlane.alignView',
  title: 'Align View',
  category: 'view',
  params: planeRef,
  undoable: false,
  when: (ctx) => !!ctx.camera,
  run(ctx, p): void {
    const host = hostOf(ctx);
    const camera = ctx.camera;
    if (!camera) throw new PushFormError('camera.unavailable', 'No camera host is attached');
    const { sp } = planeAt(host.doc.state, p);
    const { normal, d } = worldSectionPlane(sp.plane, contextMatrix(host.doc.state, p.path as Id[]));
    const cur = camera.getState();
    const dist = Math.max(1e-3, Math.hypot(cur.eye[0] - cur.target[0], cur.eye[1] - cur.target[1], cur.eye[2] - cur.target[2]));
    // the target moves onto the plane; the eye looks along the kept side's direction
    const off = normal[0] * cur.target[0] + normal[1] * cur.target[1] + normal[2] * cur.target[2] + d;
    const target: Vec3 = [cur.target[0] - normal[0] * off, cur.target[1] - normal[1] * off, cur.target[2] - normal[2] * off];
    const eye: Vec3 = [target[0] - normal[0] * dist, target[1] - normal[1] * dist, target[2] - normal[2] * dist];
    const up: Vec3 = Math.abs(normal[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
    camera.setState({ ...cur, eye, target, up }, true);
  },
});

export const sectionPlaneCommands: readonly AnyCommand[] = [
  addSectionPlane, setActiveSectionPlane, reverseSectionPlanes, setSectionPlanesHidden, renameSectionPlane, alignViewToSectionPlane,
];
