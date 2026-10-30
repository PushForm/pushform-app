// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { FaceLocalId, Id, TagId, Vec3 } from '@pushform/core';
import { addImprintEdge, containerAt, entityRefKey, findFaceContainingPoints, segmentFaceSpans, removeImprintEdge } from '@pushform/model';
import type { DocumentDraft, DocumentState, EdgeKey, EntityRef } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand, CommandContext } from '../registry/Command';
import { DocumentHost } from '../host/DocumentHost';
import { activeTagOpt, hostOf, SERVICE_DOCUMENT } from '../host/services';
import { currentFrame, draftBodyAt, draftContainerAt, refsInContext, requireContextPath, sketchGraphAt, type ContextFrame } from './context';

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const idSchema = z.number().int().nonnegative();
const idList = z.array(idSchema);
const ENTITY_KINDS = [
  'instance',
  'body',
  'face',
  'edge',
  'imprintEdge',
  'sketchVertex',
  'sketchEdge',
  'sketchFace',
  'guide',
  'image',
  'sectionPlane',
  'text',
  'dimension',
] as const;

/**
 * Zod schema for `EntityRef` (selection commands, scripts, MCP). One flat object with a refine
 * per kind: a discriminated union of 13 members is too deep for the compiler.
 */
export const EntityRefSchema = z
  .object({
    kind: z.enum(ENTITY_KINDS),
    path: z.array(idSchema),
    id: idSchema,
    faceId: idSchema.optional(),
    region: z.number().int().nullable().optional(),
    edgeKey: z.string().regex(/^\d+:\d+:\d+$/).optional(),
    edgeId: z.number().int().optional(),
  })
  .refine(
    (r) =>
      r.kind === 'face'
        ? r.faceId !== undefined && r.region !== undefined
        : r.kind === 'edge'
          ? r.edgeKey !== undefined
          : r.kind === 'imprintEdge'
            ? r.faceId !== undefined && r.edgeId !== undefined
            : true,
    { message: 'EntityRef is missing the fields of its kind' },
  );
const refList = z.object({ refs: z.array(EntityRefSchema) });

/** Validated ref params → runtime refs (only the id brands and per-kind field narrowing differ). */
function asRefs(refs: readonly z.infer<typeof EntityRefSchema>[]): EntityRef[] {
  return refs.map((r): EntityRef => {
    const path = r.path as Id[], id = r.id as Id;
    switch (r.kind) {
      case 'face':
        return { kind: 'face', path, id, faceId: r.faceId as FaceLocalId, region: r.region ?? null };
      case 'edge':
        return { kind: 'edge', path, id, edgeKey: r.edgeKey as EdgeKey };
      case 'imprintEdge':
        return { kind: 'imprintEdge', path, id, faceId: r.faceId as FaceLocalId, edgeId: r.edgeId ?? 0 };
      default:
        return { kind: r.kind, path, id };
    }
  });
}

/** Enablement guard that does not throw when the document service is absent. */
function hasSelection(ctx: CommandContext): boolean {
  const h = ctx.services.get(SERVICE_DOCUMENT);
  return h instanceof DocumentHost && !h.selection.isEmpty;
}

/** Everything selectable in the current edit context: sketch edges/faces, bodies, instances, guides. */
export function allContextRefs(host: DocumentHost): EntityRef[] {
  const path = host.context.path;
  const c = containerAt(host.doc.state, path);
  const refs: EntityRef[] = [];
  for (const id of c.sketch.edges.keys()) refs.push({ kind: 'sketchEdge', path, id });
  for (const id of c.sketch.faces.keys()) refs.push({ kind: 'sketchFace', path, id });
  for (const id of c.bodies.keys()) refs.push({ kind: 'body', path, id });
  for (const id of c.instances.keys()) refs.push({ kind: 'instance', path, id });
  for (const id of c.guides.keys()) refs.push({ kind: 'guide', path, id });
  return refs;
}

const edgeFlags = { soft: z.boolean().optional(), smooth: z.boolean().optional(), hidden: z.boolean().optional() };
type EdgeFlags = { soft?: boolean | undefined; smooth?: boolean | undefined; hidden?: boolean | undefined };
function flagOpts(f: EdgeFlags): { soft?: boolean; smooth?: boolean; hidden?: boolean; tagId?: TagId } {
  const o: { soft?: boolean; smooth?: boolean; hidden?: boolean; tagId?: TagId } = {};
  if (f.soft !== undefined) o.soft = f.soft;
  if (f.smooth !== undefined) o.smooth = f.smooth;
  if (f.hidden !== undefined) o.hidden = f.hidden;
  return o;
}

// ------------------------------------------------------------------------------- sketch.*

/**
 * Add one segment (context-local points) to the container at `path`, routing it so that the parts that lie on
 * body faces become imprint edges of those faces (splitting them into regions), and the rest is loose sketch geometry,
 * the pieces meeting where the segment crosses a face's boundary. Edges of closed shapes pass
 * `clip: false`: such an edge imprints only when it lies wholly on one face, and is otherwise sketch, so that a shape
 * partly over a face still closes into a sketch face. Returns the created ids (sketch edge ids and imprint edge ids).
 */
export function addRoutedEdge(draft: DocumentDraft, path: readonly number[], a: Vec3, b: Vec3, flags: ReturnType<typeof flagOpts>, clip = true): number[] {
  const container = draftContainerAt(draft, path);
  if (!clip) {
    const loc = findFaceContainingPoints(container, [a, b]);
    const body = loc ? draftBodyAt(draft, path, loc.bodyId) : null;
    if (loc && body) return addImprintEdge(body, loc.faceId, a, b, flags);
    return sketchGraphAt(draft, path).addEdge(a, b, flags).map((id) => id as number);
  }
  const at = (t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const sketch = (p: Vec3, q: Vec3): number[] => sketchGraphAt(draft, path).addEdge(p, q, flags).map((id) => id as number);
  const ids: number[] = [];
  let t = 0;
  for (const span of segmentFaceSpans(container, a, b)) {
    // a span overlapping one already used (coincident faces of touching solids) keeps only its new part
    const t0 = Math.max(span.t0, t);
    if (span.t1 <= t0) continue;
    if (t0 > t) ids.push(...sketch(at(t), at(t0)));
    const body = draftBodyAt(draft, path, span.bodyId);
    ids.push(...(body ? addImprintEdge(body, span.faceId, at(t0), at(span.t1), flags) : sketch(at(t0), at(span.t1))));
    t = span.t1;
  }
  if (t < 1) ids.push(...sketch(at(t), b));
  return ids;
}

/** World points of a command's params → context-local. */
const localPoint = (frame: ContextFrame, p: readonly number[]): Vec3 => frame.toLocal([p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]);

export const addEdge = defineCommand({
  id: 'sketch.addEdge',
  title: 'Line',
  category: 'draw',
  params: z.object({ a: vec3, b: vec3, ...edgeFlags }),
  undoable: true,
  run(ctx, p) {
    const host = hostOf(ctx);
    const frame = currentFrame(host);
    return host.edit('Line', (draft) => addRoutedEdge(draft, frame.path, localPoint(frame, p.a), localPoint(frame, p.b), { ...flagOpts(p), ...activeTagOpt(ctx) }));
  },
});

export const addPolyline = defineCommand({
  id: 'sketch.addPolyline',
  title: 'Polyline',
  category: 'draw',
  params: z.object({ points: z.array(vec3).min(2), closed: z.boolean().optional(), ...edgeFlags }),
  undoable: true,
  run(ctx, p) {
    const host = hostOf(ctx);
    const frame = currentFrame(host);
    return host.edit('Polyline', (draft) => {
      const ids: number[] = [];
      const pts = p.points.map((q) => localPoint(frame, q));
      const n = pts.length;
      const count = p.closed && n > 2 ? n : n - 1;
      for (let i = 0; i < count; i++) {
        const a = pts[i]!, b = pts[(i + 1) % n]!;
        ids.push(...addRoutedEdge(draft, frame.path, a, b, { ...flagOpts(p), ...activeTagOpt(ctx) }, !p.closed));
      }
      return ids;
    });
  },
});

export const rectangle = defineCommand({
  id: 'sketch.rectangle',
  title: 'Rectangle',
  category: 'draw',
  params: z.object({ a: vec3, b: vec3, c: vec3, d: vec3 }),
  undoable: true,
  run(ctx, p) {
    const host = hostOf(ctx);
    const frame = currentFrame(host);
    return host.edit('Rectangle', (draft) => {
      const corners = [p.a, p.b, p.c, p.d].map((q) => localPoint(frame, q));
      const ids: number[] = [];
      for (let i = 0; i < 4; i++) ids.push(...addRoutedEdge(draft, frame.path, corners[i]!, corners[(i + 1) % 4]!, { ...activeTagOpt(ctx) }, false));
      return ids;
    });
  },
});

export const eraseEdge = defineCommand({
  id: 'sketch.eraseEdge',
  title: 'Erase Edge',
  category: 'edit',
  params: z.object({ id: idSchema }),
  undoable: true,
  run(ctx, { id }) {
    const host = hostOf(ctx);
    return host.edit('Erase', (draft) => {
      const g = sketchGraphAt(draft, host.context.path);
      const existed = g.sketch.edges.has(id as Id);
      g.removeEdge(id as Id);
      return existed;
    });
  },
});

export const eraseEdges = defineCommand({
  id: 'sketch.eraseEdges',
  title: 'Erase Edges',
  category: 'edit',
  params: z.object({ ids: idList }),
  undoable: true,
  run(ctx, { ids }) {
    const host = hostOf(ctx);
    return host.edit('Erase', (draft) => {
      const g = sketchGraphAt(draft, host.context.path);
      let n = 0;
      for (const id of ids) {
        if (!g.sketch.edges.has(id as Id)) continue;
        g.removeEdge(id as Id);
        n++;
      }
      return n;
    });
  },
});

export const eraseFace = defineCommand({
  id: 'sketch.eraseFace',
  title: 'Erase Face',
  category: 'edit',
  params: z.object({ id: idSchema }),
  undoable: true,
  run(ctx, { id }) {
    const host = hostOf(ctx);
    return host.edit('Erase Face', (draft) => {
      const g = sketchGraphAt(draft, host.context.path);
      const existed = g.sketch.faces.has(id as Id);
      g.removeFace(id as Id);
      return existed;
    });
  },
});

/** Hide / soften / smooth sketch edges (Eraser with Shift / Ctrl). */
export const setEdgeFlags = defineCommand({
  id: 'sketch.setEdgeFlags',
  title: 'Edge Flags',
  category: 'edit',
  params: z.object({ ids: idList, ...edgeFlags }),
  undoable: true,
  run(ctx, p) {
    const host = hostOf(ctx);
    return host.edit('Edge Flags', (draft) => {
      const sketch = draftContainerAt(draft, host.context.path).sketch;
      let n = 0;
      for (const id of p.ids) {
        const e = sketch.edges.get(id as Id);
        if (!e) continue;
        if (p.soft !== undefined) e.soft = p.soft;
        if (p.smooth !== undefined) e.smooth = p.smooth;
        if (p.hidden !== undefined) e.hidden = p.hidden;
        n++;
      }
      return n;
    });
  },
});

// ------------------------------------------------------------------------------- edit.*

export interface DeleteResult {
  readonly removed: number;
  readonly skipped: number;
  /** Status-bar text when something could not be deleted, else null. */
  readonly message: string | null;
}

/** Erase imprint edges (lines drawn on body faces). */
export const eraseImprintEdges = defineCommand({
  id: 'imprint.erase',
  title: 'Erase Lines',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema) }),
  undoable: true,
  run(ctx, p) {
    const host = hostOf(ctx);
    return host.edit('Erase', (draft) => {
      let n = 0;
      for (const r of asRefs(p.refs)) {
        if (r.kind !== 'imprintEdge') continue;
        const body = draftBodyAt(draft, requireContextPath(host, r.path, 'Edge'), r.id);
        if (body && removeImprintEdge(body, r.faceId, r.edgeId)) n++;
      }
      return n;
    });
  },
});

/** Set soft/smooth/hidden on body edges and imprint edges (Eraser modifiers on solids). */
export const setBodyEdgeFlags = defineCommand({
  id: 'edges.setFlags',
  title: 'Edge Flags',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema), ...edgeFlags }),
  undoable: true,
  run(ctx, p) {
    const host = hostOf(ctx);
    const flags = flagOpts(p);
    return host.edit('Edge Flags', (draft) => {
      let n = 0;
      for (const r of asRefs(p.refs)) {
        if (r.kind !== 'edge' && r.kind !== 'imprintEdge') continue;
        const body = draftContainerAt(draft, requireContextPath(host, r.path, 'Edge')).bodies.get(r.id);
        if (!body) continue;
        if (r.kind === 'edge') {
          const e = body.edges.get(r.edgeKey);
          if (!e) continue;
          if (flags.soft !== undefined) e.soft = flags.soft;
          if (flags.smooth !== undefined) e.smooth = flags.smooth;
          if (flags.hidden !== undefined) e.hidden = flags.hidden;
          n++;
        } else if (r.kind === 'imprintEdge') {
          const e = body.imprints.get(r.faceId)?.edges.get(r.edgeId);
          if (!e) continue;
          if (flags.soft !== undefined) e.soft = flags.soft;
          if (flags.smooth !== undefined) e.smooth = flags.smooth;
          if (flags.hidden !== undefined) e.hidden = flags.hidden;
          n++;
        }
      }
      return n;
    });
  },
});

/** Whether an edge or face (sketch, body or imprint) is hidden; null for other refs or a missing entity. */
export function geometryHidden(state: DocumentState, ref: EntityRef): boolean | null {
  let container;
  try {
    container = containerAt(state, ref.path);
  } catch {
    return null;
  }
  switch (ref.kind) {
    case 'sketchEdge':
      return container.sketch.edges.get(ref.id)?.hidden ?? null;
    case 'sketchFace':
      return container.sketch.faces.get(ref.id)?.hidden ?? null;
    case 'edge':
      return container.bodies.get(ref.id)?.edges.get(ref.edgeKey)?.hidden ?? null;
    case 'imprintEdge':
      return container.bodies.get(ref.id)?.imprints.get(ref.faceId)?.edges.get(ref.edgeId)?.hidden ?? null;
    case 'face':
      return container.bodies.get(ref.id)?.faces.get(ref.faceId)?.hidden ?? null;
    default:
      return null;
  }
}

/**
 * Hide or unhide edges and faces: sketch edges and faces, body edges, imprint edges and body faces, in any
 * edit context, as one undoable step. A hidden body face keeps its solid's mesh and topology. Hiding
 * removes the entities from the selection; other refs are ignored.
 */
export const setGeometryHidden = defineCommand({
  id: 'geometry.setHidden',
  title: 'Hide',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema), hidden: z.boolean() }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    const refs = asRefs(p.refs);
    const changed: EntityRef[] = [];
    host.edit(p.hidden ? 'Hide' : 'Unhide', (draft) => {
      for (const r of refs) {
        if (geometryHidden(draft as unknown as DocumentState, r) === null) continue;
        const container = draftContainerAt(draft, requireContextPath(host, r.path, 'Entity'));
        const target =
          r.kind === 'sketchEdge' ? container.sketch.edges.get(r.id)
          : r.kind === 'sketchFace' ? container.sketch.faces.get(r.id)
          : r.kind === 'edge' ? container.bodies.get(r.id)?.edges.get(r.edgeKey)
          : r.kind === 'imprintEdge' ? container.bodies.get(r.id)?.imprints.get(r.faceId)?.edges.get(r.edgeId)
          : r.kind === 'face' ? container.bodies.get(r.id)?.faces.get(r.faceId)
          : undefined;
        if (!target || target.hidden === p.hidden) continue;
        target.hidden = p.hidden;
        changed.push(r);
      }
    });
    if (p.hidden && changed.length) {
      const keys = new Set(changed.map(entityRefKey));
      host.selection.set(host.selection.refs.filter((r) => !keys.has(entityRefKey(r))));
    }
    return changed.length;
  },
});

/**
 * Erase the current selection (entities of the open context): sketch edges (with their faces),
 * sketch faces (edges kept), bodies, group/component instances, guides. Body faces / edges are
 * skipped (they need a boolean to stay manifold).
 */
export const deleteSelection = defineCommand({
  id: 'edit.delete',
  title: 'Delete',
  category: 'edit',
  icon: 'delete',
  menu: 'Edit',
  keybinding: 'Delete',
  params: z.object({}),
  undoable: true,
  when: hasSelection,
  run(ctx): DeleteResult {
    const host = hostOf(ctx);
    const refs = host.selection.refs;
    const path = host.context.path;
    let removed = 0, skipped = 0;
    skipped += refs.length - refsInContext(host, refs).length;
    host.edit('Delete', (draft) => {
      const root = draftContainerAt(draft, path);
      const g = sketchGraphAt(draft, path);
      for (const r of refsInContext(host, refs)) {
        switch (r.kind) {
          case 'sketchEdge':
            if (g.sketch.edges.has(r.id)) {
              g.removeEdge(r.id);
              removed++;
            }
            break;
          case 'sketchFace':
            if (g.sketch.faces.has(r.id)) {
              g.removeFace(r.id);
              removed++;
            }
            break;
          case 'body':
            if (root.bodies.delete(r.id)) {
              root.order = root.order.filter((x) => x !== r.id);
              removed++;
            }
            break;
          case 'instance': {
            const inst = root.instances.get(r.id);
            if (inst && !inst.locked && root.instances.delete(r.id)) {
              root.order = root.order.filter((x) => x !== r.id);
              removed++;
            } else skipped++;
            break;
          }
          case 'guide':
            if (root.guides.delete(r.id)) {
              root.order = root.order.filter((x) => x !== r.id);
              removed++;
            }
            break;
          case 'sectionPlane':
            if (root.sectionPlanes.delete(r.id)) {
              root.order = root.order.filter((x) => x !== r.id);
              if (root.activeSectionPlaneId === r.id) root.activeSectionPlaneId = null;
              removed++;
            }
            break;
          case 'dimension':
            if (root.dimensions.delete(r.id)) {
              root.order = root.order.filter((x) => x !== r.id);
              removed++;
            }
            break;
          case 'text':
            if (root.texts.delete(r.id)) {
              root.order = root.order.filter((x) => x !== r.id);
              removed++;
            }
            break;
          case 'image': {
            const image = root.images.get(r.id);
            if (image && !image.locked && root.images.delete(r.id)) {
              root.order = root.order.filter((x) => x !== r.id);
              removed++;
            } else skipped++;
            break;
          }
          case 'imprintEdge': {
            const body = draftBodyAt(draft, path, r.id);
            if (body && removeImprintEdge(body, r.faceId, r.edgeId)) removed++;
            else skipped++;
            break;
          }
          default:
            skipped++;
        }
      }
    });
    host.selection.clear();
    const message = skipped
      ? `${skipped} item${skipped === 1 ? '' : 's'} not deleted: faces and edges of a solid cannot be erased (hide or soften them with the Eraser modifiers, or Push/Pull the face), locked groups/components must be unlocked first.`
      : null;
    return { removed, skipped, message };
  },
});

export const selectAll = defineCommand({
  id: 'edit.selectAll',
  title: 'Select All',
  category: 'edit',
  menu: 'Edit',
  keybinding: 'Mod+A',
  params: z.object({}),
  undoable: false,
  run(ctx) {
    const host = hostOf(ctx);
    host.selection.set(allContextRefs(host));
    return host.selection.size;
  },
});

export const selectNone = defineCommand({
  id: 'edit.selectNone',
  title: 'Select None',
  category: 'edit',
  menu: 'Edit',
  keybinding: 'Mod+T',
  params: z.object({}),
  undoable: false,
  run(ctx) {
    hostOf(ctx).selection.clear();
  },
});

export const invertSelection = defineCommand({
  id: 'edit.invertSelection',
  title: 'Invert Selection',
  category: 'edit',
  menu: 'Edit',
  keybinding: 'Mod+Shift+I',
  params: z.object({}),
  undoable: false,
  run(ctx) {
    const host = hostOf(ctx);
    const sel = host.selection;
    sel.set(allContextRefs(host).filter((r) => !sel.has(r)));
    return sel.size;
  },
});

// ------------------------------------------------------------------------------- selection.*
// Selection is runtime state: not undoable, but `host.selection` emits `change` for the UI.

export const selectionSet = defineCommand({
  id: 'selection.set',
  title: 'Set Selection',
  category: 'internal',
  params: refList,
  undoable: false,
  run: (ctx, p) => hostOf(ctx).selection.set(asRefs(p.refs)),
});
export const selectionAdd = defineCommand({
  id: 'selection.add',
  title: 'Add To Selection',
  category: 'internal',
  params: refList,
  undoable: false,
  run: (ctx, p) => hostOf(ctx).selection.add(asRefs(p.refs)),
});
export const selectionRemove = defineCommand({
  id: 'selection.remove',
  title: 'Remove From Selection',
  category: 'internal',
  params: refList,
  undoable: false,
  run: (ctx, p) => hostOf(ctx).selection.remove(asRefs(p.refs)),
});
export const selectionToggle = defineCommand({
  id: 'selection.toggle',
  title: 'Toggle Selection',
  category: 'internal',
  params: refList,
  undoable: false,
  run: (ctx, p) => hostOf(ctx).selection.toggle(asRefs(p.refs)),
});

export const sketchCommands: readonly AnyCommand[] = [
  addEdge,
  addPolyline,
  rectangle,
  eraseEdge,
  eraseEdges,
  eraseFace,
  setEdgeFlags,
  deleteSelection,
  selectAll,
  selectNone,
  invertSelection,
  selectionSet,
  selectionAdd,
  selectionRemove,
  selectionToggle,
  eraseImprintEdges,
  setBodyEdgeFlags,
  setGeometryHidden,
];
