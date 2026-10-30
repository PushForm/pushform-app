// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { FaceLocalId, Id, MVec3, Vec3 } from '@pushform/core';
import { LENGTH_TOL, MERGE_TOL, PushFormError, basisToLocal, basisToWorld, m4mul, m4scaling, m4translation, planeFromPointNormal, v3len, v3normalize } from '@pushform/core';
import { cellKey } from '@pushform/geom';
import { allocId, reconcileBody } from '@pushform/model';
import type { Body, CommonAttrs, DocumentDraft, Guide, Draft } from '@pushform/model';
import { containerAt } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand, CommandContext } from '../registry/Command';
import { DocumentHost } from '../host/DocumentHost';
import { hostOf, SERVICE_DOCUMENT } from '../host/services';
import { currentFrame, draftContainerAt } from './context';

/**
 * Guides (Tape Measure / Protractor output) and the Tape Measure's "resize model". Guides are
 * inference-only entities in the current context's `guides` map (`Guide` in `@pushform/model`):
 * `line` (infinite, origin + unit dir), `point`, and `segment` (the dashed leader of a guide point).
 * Params are world points; they are stored context-local.
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const idList = z.array(z.number().int().nonnegative());

/** Root entity container of a draft (inferred draft type: immer's Draft is too deep to name). */
function rootContainer(draft: DocumentDraft) {
  const root = draft.definitions.get(draft.rootDefinitionId);
  if (!root) throw new PushFormError('model.noRoot', 'Document has no root definition');
  return root.entities;
}

function guideAttrs(draft: DocumentDraft): CommonAttrs {
  return { tagId: draft.defaultTagId, hidden: false, locked: false, castShadows: false, receiveShadows: false, attributes: {} };
}

function insertGuide(draft: DocumentDraft, path: readonly number[], guide: Guide): number {
  const root = draftContainerAt(draft, path);
  root.guides.set(guide.id, guide);
  root.order.push(guide.id);
  return guide.id as number;
}

function hasGuides(ctx: CommandContext): boolean {
  const h = ctx.services.get(SERVICE_DOCUMENT);
  return h instanceof DocumentHost && containerAt(h.doc.state, h.context.path).guides.size > 0;
}

// ------------------------------------------------------------------------------- guides.*

/** Infinite guide line through `point` along `dir`. Returns the guide id. */
export const guidesAddLine = defineCommand({
  id: 'guides.addLine',
  title: 'Guide Line',
  category: 'draw',
  params: z.object({ point: vec3, dir: vec3 }),
  undoable: true,
  run(ctx, p) {
    if (v3len(p.dir) <= LENGTH_TOL) throw new PushFormError('guides.dir', 'Guide line direction must be non-zero');
    const host = hostOf(ctx);
    const f = currentFrame(host);
    return host.edit('Guide Line', (draft) =>
      insertGuide(draft, f.path, { id: allocId<Id>(draft), kind: 'line', origin: f.toLocal(p.point), dir: v3normalize(f.toLocalDir(p.dir)), ...guideAttrs(draft) }),
    );
  },
});

/** Guide point; with `leaderFrom` also the dashed leader segment drawn from the start point. */
export const guidesAddPoint = defineCommand({
  id: 'guides.addPoint',
  title: 'Guide Point',
  category: 'draw',
  params: z.object({ point: vec3, leaderFrom: vec3.optional() }),
  undoable: true,
  run(ctx, p): { id: number; leaderId: number | null } {
    const host = hostOf(ctx);
    const f = currentFrame(host);
    return host.edit('Guide Point', (draft) => {
      let leaderId: number | null = null;
      if (p.leaderFrom && v3len([p.point[0] - p.leaderFrom[0], p.point[1] - p.leaderFrom[1], p.point[2] - p.leaderFrom[2]]) > MERGE_TOL) {
        leaderId = insertGuide(draft, f.path, { id: allocId<Id>(draft), kind: 'segment', origin: f.toLocal(p.leaderFrom), end: f.toLocal(p.point), ...guideAttrs(draft) });
      }
      const id = insertGuide(draft, f.path, { id: allocId<Id>(draft), kind: 'point', origin: f.toLocal(p.point), ...guideAttrs(draft) });
      return { id, leaderId };
    });
  },
});

/** Finite guide segment from `a` to `b`. */
export const guidesAddSegment = defineCommand({
  id: 'guides.addSegment',
  title: 'Guide Segment',
  category: 'draw',
  params: z.object({ a: vec3, b: vec3 }),
  undoable: true,
  run(ctx, p) {
    const host = hostOf(ctx);
    const f = currentFrame(host);
    return host.edit('Guide Segment', (draft) =>
      insertGuide(draft, f.path, { id: allocId<Id>(draft), kind: 'segment', origin: f.toLocal(p.a), end: f.toLocal(p.b), ...guideAttrs(draft) }),
    );
  },
});

export const guidesDelete = defineCommand({
  id: 'guides.delete',
  title: 'Delete Guides',
  category: 'edit',
  params: z.object({ ids: idList }),
  undoable: true,
  run(ctx, { ids }) {
    const host = hostOf(ctx);
    return host.edit('Delete Guides', (draft) => {
      const root = draftContainerAt(draft, host.context.path);
      const removed = new Set<Id>();
      for (const id of ids) {
        if (root.guides.delete(id as Id)) removed.add(id as Id);
      }
      if (removed.size) root.order = root.order.filter((x) => !removed.has(x));
      return removed.size;
    });
  },
});

/** Edit › Delete Guides: every guide of the current context. */
export const deleteAllGuides = defineCommand({
  id: 'edit.deleteGuides',
  title: 'Delete Guides',
  category: 'edit',
  menu: 'Edit',
  params: z.object({}),
  undoable: true,
  when: hasGuides,
  run(ctx) {
    const host = hostOf(ctx);
    return host.edit('Delete Guides', (draft) => {
      const root = draftContainerAt(draft, host.context.path);
      const ids = new Set<Id>(root.guides.keys());
      root.guides.clear();
      root.order = root.order.filter((x) => !ids.has(x));
      return ids.size;
    });
  },
});

// ------------------------------------------------------------------------------- model.resize

export const ResizeParamsSchema = z.object({
  /** Uniform scale factor (> 0). */
  factor: z.number().positive().finite(),
  /** Fixed point of the scaling; the model origin by default. */
  about: vec3.optional(),
});
export type ResizeParams = z.infer<typeof ResizeParamsSchema>;

/**
 * Tape Measure "Resize model?": uniformly scale everything in the root context about `about`
 * (always the root: nested instances follow through their transforms).
 * Bodies are scaled directly (a uniform scale keeps a solid valid), sketch geometry, guides,
 * curves, section planes, dimensions, leader texts and instance transforms follow.
 */
export const modelResize = defineCommand({
  id: 'model.resize',
  title: 'Resize Model',
  category: 'edit',
  params: ResizeParamsSchema,
  undoable: true,
  run(ctx, p) {
    const host = hostOf(ctx);
    const f = p.factor;
    const about: Vec3 = p.about ?? [0, 0, 0];
    const sp = (v: Vec3): MVec3 => [about[0] + (v[0] - about[0]) * f, about[1] + (v[1] - about[1]) * f, about[2] + (v[2] - about[2]) * f];
    const scaleMatrix = m4mul(m4translation(about), m4mul(m4scaling([f, f, f]), m4translation([-about[0], -about[1], -about[2]])));
    return host.edit('Resize Model', (draft) => {
      const root = rootContainer(draft);
      let n = 0;

      for (const body of root.bodies.values()) {
        const b = body as unknown as Body;
        // imprint vertices → world (old basis) so they can be re-expressed after the rebuild
        const imprintWorld = new Map<FaceLocalId, Map<number, MVec3>>();
        for (const [fid, g] of b.imprints) {
          const face = b.faces.get(fid);
          if (!face) continue;
          const m = new Map<number, MVec3>();
          for (const [vid, uv] of g.vertices) m.set(vid, sp(basisToWorld(face.basis, uv[0], uv[1])));
          imprintWorld.set(fid, m);
        }
        const src = b.mesh.verts;
        const verts = new Float64Array(src.length);
        for (let i = 0; i < src.length; i += 3) {
          verts[i] = about[0] + (src[i]! - about[0]) * f;
          verts[i + 1] = about[1] + (src[i + 1]! - about[1]) * f;
          verts[i + 2] = about[2] + (src[i + 2]! - about[2]) * f;
        }
        reconcileBody(b, { mesh: { verts, tris: b.mesh.tris, faceId: b.mesh.faceId }, faceOrigin: new Map() });
        for (const [fid, m] of imprintWorld) {
          const g = b.imprints.get(fid);
          const face = b.faces.get(fid);
          if (!g || !face) continue;
          for (const [vid, w] of m) {
            const l = basisToLocal(face.basis, w);
            g.vertices.set(vid, [l[0], l[1]]);
          }
          g.version += 1;
        }
        for (const c of b.curves.values()) {
          c.center = sp(c.center);
          c.radius *= f;
        }
        n++;
      }

      const sketch = root.sketch;
      sketch.vertexHash.clear();
      delete sketch.packedVertexIndex;
      for (const v of sketch.vertices.values()) {
        v.p = sp(v.p);
        const k = cellKey(v.p, MERGE_TOL);
        const list = sketch.vertexHash.get(k);
        if (list) list.push(v.id);
        else sketch.vertexHash.set(k, [v.id]);
        n++;
      }
      for (const face of sketch.faces.values()) {
        const origin = sp(face.basis.origin);
        face.basis.origin = origin;
        face.plane = planeFromPointNormal(origin, face.plane.n) as Draft<typeof face.plane>;
      }
      for (const c of sketch.curves.values()) {
        c.center = sp(c.center);
        c.radius *= f;
      }
      for (const g of root.guides.values()) {
        g.origin = sp(g.origin);
        if (g.kind === 'segment') g.end = sp(g.end);
        n++;
      }
      for (const s of root.sectionPlanes.values()) {
        s.origin = sp(s.origin);
        s.plane = planeFromPointNormal(s.origin, s.plane.n) as Draft<typeof s.plane>;
      }
      for (const d of root.dimensions.values()) {
        d.start = sp(d.start);
        d.end = sp(d.end);
        d.offset = [d.offset[0] * f, d.offset[1] * f, d.offset[2] * f];
      }
      for (const t of root.texts.values()) {
        if (t.kind !== 'leader') continue;
        t.position = sp(t.position);
        if (t.offset) t.offset = [t.offset[0] * f, t.offset[1] * f, t.offset[2] * f];
      }
      for (const inst of root.instances.values()) {
        inst.transform = m4mul(scaleMatrix, inst.transform) as unknown as typeof inst.transform;
        n++;
      }
      for (const img of root.images.values()) {
        img.transform = m4mul(scaleMatrix, img.transform) as unknown as typeof img.transform;
      }
      return n;
    });
  },
});

export const guideCommands: readonly AnyCommand[] = [guidesAddLine, guidesAddPoint, guidesAddSegment, guidesDelete, deleteAllGuides, modelResize];
