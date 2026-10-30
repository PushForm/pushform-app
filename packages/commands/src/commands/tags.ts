// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { PushFormError } from '@pushform/core';
import type { Id, TagFolderId, TagId } from '@pushform/core';
import { allocId, containerAt } from '@pushform/model';
import type { DocumentDraft, DocumentState, EntityContainer, EntityRef, Rgb, Tag, TagFolder } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand, CommandContext } from '../registry/Command';
import type { DocumentHost } from '../host/DocumentHost';
import { displayOf, hostOf } from '../host/services';
import { refsInContext } from './context';
import { EntityRefSchema, allContextRefs } from './sketch';
import { patchActiveStyle } from './styles';

/**
 * Tags: named visibility layers with a color and a dash pattern, grouped in
 * folders. Every entity carries a `tagId` (faces and edges of a body can override the body's
 * tag). Tag visibility hides entities in the render adapter; "Color by Tag" paints faces and
 * edges with the tag color. The active tag (pencil) is runtime state on the `DisplayHost`:
 * creation commands give new entities the active tag.
 */

// ---------------------------------------------------------------------------------------------
// Params

const rgb = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);
const idSchema = z.number().int().nonnegative();

/** Dash pattern names of the Tags panel dropdown. `null` = default (solid). */
export const TAG_DASHES = ['solid', 'dash', 'dot', 'dashDot', 'longDash', 'shortDash'] as const;
export type TagDash = (typeof TAG_DASHES)[number];

/** Panel palette for new tags (cycled for new tags). */
export const TAG_COLORS: readonly Rgb[] = [
  [0.86, 0.25, 0.25],
  [0.25, 0.55, 0.9],
  [0.3, 0.7, 0.35],
  [0.95, 0.65, 0.2],
  [0.6, 0.35, 0.8],
  [0.2, 0.7, 0.7],
  [0.8, 0.4, 0.6],
  [0.55, 0.55, 0.25],
];

export interface TagInfo {
  readonly id: number;
  readonly name: string;
  readonly visible: boolean;
  readonly color: Rgb;
  readonly dashes: string | null;
  readonly folderId: number | null;
  /** Entities using the tag (bodies, instances, sketch edges/faces, guides, faces and edges of bodies). */
  readonly uses: number;
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** Tag `id` of a draft/state or throw `tag.missing`. */
export function tagOf(state: DocumentState, id: number): Tag {
  const t = state.tags.get(id as TagId);
  if (!t) throw new PushFormError('tag.missing', `Tag ${id} not found`);
  return t;
}

function folderOf(state: DocumentState, id: number): TagFolder {
  const f = state.tagFolders.get(id as TagFolderId);
  if (!f) throw new PushFormError('tag.folderMissing', `Tag folder ${id} not found`);
  return f;
}

/** `base`, else `base2`, `base3`, … not used by another tag. */
export function uniqueTagName(state: DocumentState, base: string): string {
  const taken = new Set<string>();
  for (const t of state.tags.values()) taken.add(t.name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

/** Next "Tag N" name. */
export function nextTagName(state: DocumentState): string {
  return uniqueTagName(state, `Tag${state.tags.size}`);
}

/** True when the tag and every folder above it are visible. Unknown tags count as visible. */
export function tagEffectivelyVisible(state: DocumentState, tagId: TagId): boolean {
  const tag = state.tags.get(tagId);
  if (!tag) return true;
  if (!tag.visible) return false;
  let folderId = tag.folderId;
  let guard = 0;
  while (folderId !== null && guard++ < 64) {
    const f = state.tagFolders.get(folderId);
    if (!f) break;
    if (!f.visible) return false;
    folderId = f.parentId;
  }
  return true;
}

/** Visit every tagged entity of the document (all definitions). `faces`/`edges` of bodies included. */
function* taggedEntities(state: DocumentState): Generator<{ tagId: TagId; set(id: TagId): void; kind: EntityRef['kind']; container: EntityContainer; id: Id }> {
  for (const def of state.definitions.values()) {
    const c = def.entities;
    for (const b of c.bodies.values()) {
      yield { tagId: b.tagId, set: (id) => void (b.tagId = id), kind: 'body', container: c, id: b.id };
      for (const f of b.faces.values()) yield { tagId: f.tagId, set: (id) => void (f.tagId = id), kind: 'face', container: c, id: b.id };
      for (const e of b.edges.values()) yield { tagId: e.tagId, set: (id) => void (e.tagId = id), kind: 'edge', container: c, id: b.id };
    }
    for (const i of c.instances.values()) yield { tagId: i.tagId, set: (id) => void (i.tagId = id), kind: 'instance', container: c, id: i.id };
    for (const e of c.sketch.edges.values()) yield { tagId: e.tagId, set: (id) => void (e.tagId = id), kind: 'sketchEdge', container: c, id: e.id };
    for (const f of c.sketch.faces.values()) yield { tagId: f.tagId, set: (id) => void (f.tagId = id), kind: 'sketchFace', container: c, id: f.id };
    for (const g of c.guides.values()) yield { tagId: g.tagId, set: (id) => void (g.tagId = id), kind: 'guide', container: c, id: g.id };
    for (const i of c.images.values()) yield { tagId: i.tagId, set: (id) => void (i.tagId = id), kind: 'image', container: c, id: i.id };
    for (const s of c.sectionPlanes.values()) yield { tagId: s.tagId, set: (id) => void (s.tagId = id), kind: 'sectionPlane', container: c, id: s.id };
    for (const t of c.texts.values()) yield { tagId: t.tagId, set: (id) => void (t.tagId = id), kind: 'text', container: c, id: t.id };
    for (const d of c.dimensions.values()) yield { tagId: d.tagId, set: (id) => void (d.tagId = id), kind: 'dimension', container: c, id: d.id };
  }
}

/** Entity counts per tag id (bodies, their faces/edges, instances, sketch, guides, …). */
export function tagUsage(state: DocumentState): Map<TagId, number> {
  const out = new Map<TagId, number>();
  // Counting is read-only: do not allocate the mutation wrappers/setter closures
  // that taggedEntities supplies to assignment and deletion commands.
  const count = (entities: Iterable<{ tagId: TagId }>): void => {
    for (const entity of entities) out.set(entity.tagId, (out.get(entity.tagId) ?? 0) + 1);
  };
  for (const def of state.definitions.values()) {
    const c = def.entities;
    for (const body of c.bodies.values()) {
      out.set(body.tagId, (out.get(body.tagId) ?? 0) + 1);
      count(body.faces.values()); count(body.edges.values());
    }
    count(c.instances.values()); count(c.sketch.edges.values()); count(c.sketch.faces.values());
    count(c.guides.values()); count(c.images.values()); count(c.sectionPlanes.values());
    count(c.texts.values()); count(c.dimensions.values());
  }
  return out;
}

/** Tags of the document in creation order with their usage counts. */
export function tagInfos(state: DocumentState): TagInfo[] {
  const uses = tagUsage(state);
  const out: TagInfo[] = [];
  for (const t of state.tags.values()) {
    out.push({ id: t.id, name: t.name, visible: t.visible, color: t.color, dashes: t.dashes, folderId: t.folderId, uses: uses.get(t.id) ?? 0 });
  }
  return out;
}

/** Refs (current context) whose tag is `tagId`: for "Select All" of the Tags panel. */
export function refsWithTag(host: DocumentHost, tagId: TagId): EntityRef[] {
  const c = containerAt(host.doc.state, host.context.path);
  return allContextRefs(host).filter((r) => {
    switch (r.kind) {
      case 'body':
        return c.bodies.get(r.id)?.tagId === tagId;
      case 'instance':
        return c.instances.get(r.id)?.tagId === tagId;
      case 'sketchEdge':
        return c.sketch.edges.get(r.id)?.tagId === tagId;
      case 'sketchFace':
        return c.sketch.faces.get(r.id)?.tagId === tagId;
      case 'guide':
        return c.guides.get(r.id)?.tagId === tagId;
      default:
        return false;
    }
  });
}

const draftState = (draft: DocumentDraft): DocumentState => draft as unknown as DocumentState;

/** Assign `tagId` to the entities of `refs` (in the draft). Returns the number assigned. */
export function assignTag(draft: DocumentDraft, refs: readonly EntityRef[], tagId: TagId): number {
  const state = draftState(draft);
  let n = 0;
  for (const r of refs) {
    const c = containerAt(state, r.path);
    switch (r.kind) {
      case 'body': {
        const b = c.bodies.get(r.id);
        if (!b) break;
        b.tagId = tagId;
        for (const f of b.faces.values()) f.tagId = tagId;
        for (const e of b.edges.values()) e.tagId = tagId;
        n++;
        break;
      }
      case 'face': {
        const f = c.bodies.get(r.id)?.faces.get(r.faceId);
        if (f) {
          f.tagId = tagId;
          n++;
        }
        break;
      }
      case 'edge': {
        const e = c.bodies.get(r.id)?.edges.get(r.edgeKey);
        if (e) {
          e.tagId = tagId;
          n++;
        }
        break;
      }
      case 'instance':
      case 'sketchEdge':
      case 'sketchFace':
      case 'guide':
      case 'image':
      case 'sectionPlane':
      case 'text':
      case 'dimension': {
        const map =
          r.kind === 'instance' ? c.instances
          : r.kind === 'sketchEdge' ? c.sketch.edges
          : r.kind === 'sketchFace' ? c.sketch.faces
          : r.kind === 'guide' ? c.guides
          : r.kind === 'image' ? c.images
          : r.kind === 'sectionPlane' ? c.sectionPlanes
          : r.kind === 'text' ? c.texts
          : c.dimensions;
        const e = (map as Map<Id, { tagId: TagId }>).get(r.id);
        if (e) {
          e.tagId = tagId;
          n++;
        }
        break;
      }
      default:
        break;
    }
  }
  return n;
}

function toRefs(refs: readonly z.infer<typeof EntityRefSchema>[]): EntityRef[] {
  return refs.map((r) => {
    const path = r.path as Id[], id = r.id as Id;
    switch (r.kind) {
      case 'face':
        return { kind: 'face', path, id, faceId: r.faceId as never, region: r.region ?? null };
      case 'edge':
        return { kind: 'edge', path, id, edgeKey: r.edgeKey as never };
      case 'imprintEdge':
        return { kind: 'imprintEdge', path, id, faceId: r.faceId as never, edgeId: r.edgeId ?? 0 };
      default:
        return { kind: r.kind, path, id };
    }
  });
}

/** Remove deleted entities from `container.order`. */
function dropFromOrder(c: EntityContainer, ids: Set<Id>): void {
  if (ids.size) c.order = c.order.filter((id) => !ids.has(id));
}

/** Active tag id (runtime), or null. */
export function activeTagId(ctx: CommandContext): TagId | null {
  const id = displayOf(ctx).get().activeTagId;
  return id === null ? null : (id as TagId);
}

// ---------------------------------------------------------------------------------------------
// Commands

export const tagCreate = defineCommand({
  id: 'tag.create',
  title: 'Add Tag',
  category: 'edit',
  params: z.object({ name: z.string().optional(), color: rgb.optional(), folderId: idSchema.nullable().optional(), dashes: z.string().nullable().optional() }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    return host.edit('Add Tag', (draft) => {
      const state = draftState(draft);
      if (p.folderId !== undefined && p.folderId !== null) folderOf(state, p.folderId);
      const id = allocId<TagId>(draft);
      const color = p.color ?? TAG_COLORS[(state.tags.size - 1) % TAG_COLORS.length]!;
      const tag: Tag = {
        id,
        name: uniqueTagName(state, p.name?.trim() || nextTagName(state)),
        visible: true,
        color: [color[0], color[1], color[2]],
        dashes: p.dashes ?? null,
        folderId: (p.folderId ?? null) as TagFolderId | null,
      };
      state.tags.set(id, tag);
      return id as number;
    });
  },
});

export const tagRename = defineCommand({
  id: 'tag.rename',
  title: 'Rename Tag',
  category: 'edit',
  params: z.object({ id: idSchema, name: z.string().min(1) }),
  undoable: true,
  run(ctx, p): void {
    hostOf(ctx).edit('Rename Tag', (draft) => {
      const state = draftState(draft);
      const tag = tagOf(state, p.id);
      const name = p.name.trim();
      if (!name) throw new PushFormError('tag.badName', 'Tag name cannot be empty');
      for (const t of state.tags.values()) if (t.id !== tag.id && t.name === name) throw new PushFormError('tag.duplicate', `A tag named "${name}" already exists`);
      tag.name = name;
    });
  },
});

export const tagSetVisible = defineCommand({
  id: 'tag.setVisible',
  title: 'Tag Visibility',
  category: 'view',
  params: z.object({ ids: z.array(idSchema), visible: z.boolean() }),
  undoable: true,
  run(ctx, p): void {
    hostOf(ctx).edit(p.visible ? 'Show Tag' : 'Hide Tag', (draft) => {
      for (const id of p.ids) tagOf(draftState(draft), id).visible = p.visible;
    });
  },
});

export const tagSetColor = defineCommand({
  id: 'tag.setColor',
  title: 'Tag Color',
  category: 'edit',
  params: z.object({ id: idSchema, color: rgb }),
  undoable: true,
  run(ctx, p): void {
    hostOf(ctx).edit('Tag Color', (draft) => {
      tagOf(draftState(draft), p.id).color = [p.color[0], p.color[1], p.color[2]];
    });
  },
});

export const tagSetDashes = defineCommand({
  id: 'tag.setDashes',
  title: 'Tag Dashes',
  category: 'edit',
  params: z.object({ id: idSchema, dashes: z.string().nullable() }),
  undoable: true,
  run(ctx, p): void {
    hostOf(ctx).edit('Tag Dashes', (draft) => {
      tagOf(draftState(draft), p.id).dashes = p.dashes === 'solid' ? null : p.dashes;
    });
  },
});

export interface TagDeleteResult {
  readonly reassigned: number;
  readonly deleted: number;
}

/**
 * Delete a tag. `contents`: `untagged` moves its entities to the default tag, `current` to the
 * active tag (default tag when none), `delete` erases them (faces/edges of a body are retagged
 * instead: a solid cannot lose faces). The tag is removed from every scene's hidden-tag list.
 */
export const tagDelete = defineCommand({
  id: 'tag.delete',
  title: 'Delete Tag',
  category: 'edit',
  params: z.object({ id: idSchema, contents: z.enum(['untagged', 'current', 'delete']).default('untagged') }),
  undoable: true,
  run(ctx, p): TagDeleteResult {
    const host = hostOf(ctx);
    const active = activeTagId(ctx);
    const display = displayOf(ctx);
    const result = host.edit('Delete Tag', (draft) => {
      const state = draftState(draft);
      const tag = tagOf(state, p.id);
      if (tag.id === state.defaultTagId) throw new PushFormError('tag.default', 'The Untagged tag cannot be deleted');
      let target = state.defaultTagId;
      if (p.contents === 'current' && active !== null && active !== tag.id && state.tags.has(active)) target = active;
      let reassigned = 0, deleted = 0;
      const toDelete = new Map<EntityContainer, Set<Id>>();
      for (const e of taggedEntities(state)) {
        if (e.tagId !== tag.id) continue;
        const erasable = p.contents === 'delete' && e.kind !== 'face' && e.kind !== 'edge';
        if (erasable) {
          let set = toDelete.get(e.container);
          if (!set) toDelete.set(e.container, (set = new Set()));
          set.add(e.id);
        } else {
          e.set(target);
          reassigned++;
        }
      }
      for (const [c, ids] of toDelete) {
        for (const id of ids) {
          if (c.bodies.delete(id) || c.instances.delete(id) || c.guides.delete(id) || c.images.delete(id) || c.sectionPlanes.delete(id) || c.texts.delete(id) || c.dimensions.delete(id)) deleted++;
          else if (c.sketch.edges.has(id)) {
            // drop the faces using the edge, then the edge and orphaned vertices
            for (const f of [...c.sketch.faces.values()]) if (f.loops.some((l) => l.some((r) => r.edgeId === id))) c.sketch.faces.delete(f.id);
            c.sketch.edges.delete(id);
            deleted++;
          } else if (c.sketch.faces.delete(id)) deleted++;
        }
        dropFromOrder(c, ids);
      }
      for (const s of state.scenes.values()) {
        if (s.hiddenTags.includes(tag.id)) s.hiddenTags = s.hiddenTags.filter((t) => t !== tag.id);
      }
      state.tags.delete(tag.id);
      return { reassigned, deleted };
    });
    if (active === p.id) display.set({ activeTagId: null });
    host.selection.clear();
    return result;
  },
});

export const tagSetActive = defineCommand({
  id: 'tag.setActive',
  title: 'Set Active Tag',
  category: 'edit',
  params: z.object({ id: idSchema.nullable() }),
  undoable: false,
  run(ctx, p): void {
    if (p.id !== null) tagOf(hostOf(ctx).doc.state, p.id);
    displayOf(ctx).set({ activeTagId: p.id });
  },
});

export const tagAssign = defineCommand({
  id: 'tag.assign',
  title: 'Assign Tag',
  category: 'edit',
  params: z.object({ refs: z.array(EntityRefSchema).optional(), tagId: idSchema }),
  undoable: true,
  run(ctx, p): number {
    const host = hostOf(ctx);
    tagOf(host.doc.state, p.tagId);
    const refs = refsInContext(host, p.refs ? toRefs(p.refs) : host.selection.refs);
    if (!refs.length) return 0;
    return host.edit('Assign Tag', (draft) => assignTag(draft, refs, p.tagId as TagId));
  },
});

/** Deletes, inside an edit, every tag without entities (never the default tag) and every empty folder; returns how many. */
export function purgeUnusedTags(state: DocumentState): number {
  const uses = tagUsage(state);
  let n = 0;
  for (const t of [...state.tags.values()]) {
    if (t.id === state.defaultTagId || (uses.get(t.id) ?? 0) > 0) continue;
    state.tags.delete(t.id);
    for (const s of state.scenes.values()) if (s.hiddenTags.includes(t.id)) s.hiddenTags = s.hiddenTags.filter((x) => x !== t.id);
    n++;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of [...state.tagFolders.values()]) {
      let used = false;
      for (const t of state.tags.values()) if (t.folderId === f.id) used = true;
      for (const g of state.tagFolders.values()) if (g.parentId === f.id) used = true;
      if (!used) {
        state.tagFolders.delete(f.id);
        changed = true;
        n++;
      }
    }
  }
  return n;
}

/** Delete every tag without entities (never the default tag) and every empty folder. */
export const tagPurge = defineCommand({
  id: 'tag.purge',
  title: 'Purge Unused Tags',
  category: 'edit',
  params: z.object({}),
  undoable: true,
  run(ctx): number {
    const display = displayOf(ctx);
    const active = display.get().activeTagId;
    let gone = false;
    const n = hostOf(ctx).edit('Purge Tags', (draft) => {
      const state = draftState(draft);
      const purged = purgeUnusedTags(state);
      // The command's own transaction commits after `run`, so check the edited state here.
      gone = active !== null && !state.tags.has(active as TagId);
      return purged;
    });
    if (gone) display.set({ activeTagId: null });
    return n;
  },
});

export const tagSelectAll = defineCommand({
  id: 'tag.selectAll',
  title: 'Select All With Tag',
  category: 'edit',
  params: z.object({ id: idSchema }),
  undoable: false,
  run(ctx, p): number {
    const host = hostOf(ctx);
    tagOf(host.doc.state, p.id);
    host.selection.set(refsWithTag(host, p.id as TagId));
    return host.selection.size;
  },
});

// --- folders ---------------------------------------------------------------------------------

export const tagFolderCreate = defineCommand({
  id: 'tag.folder.create',
  title: 'Add Tag Folder',
  category: 'edit',
  params: z.object({ name: z.string().optional(), parentId: idSchema.nullable().optional(), tagIds: z.array(idSchema).optional() }),
  undoable: true,
  run(ctx, p): number {
    return hostOf(ctx).edit('Add Tag Folder', (draft) => {
      const state = draftState(draft);
      if (p.parentId !== undefined && p.parentId !== null) folderOf(state, p.parentId);
      const id = allocId<TagFolderId>(draft);
      const folder: TagFolder = { id, name: p.name?.trim() || `Folder${state.tagFolders.size + 1}`, visible: true, parentId: (p.parentId ?? null) as TagFolderId | null };
      state.tagFolders.set(id, folder);
      for (const tid of p.tagIds ?? []) tagOf(state, tid).folderId = id;
      return id as number;
    });
  },
});

export const tagFolderRename = defineCommand({
  id: 'tag.folder.rename',
  title: 'Rename Tag Folder',
  category: 'edit',
  params: z.object({ id: idSchema, name: z.string().min(1) }),
  undoable: true,
  run(ctx, p): void {
    hostOf(ctx).edit('Rename Tag Folder', (draft) => {
      folderOf(draftState(draft), p.id).name = p.name.trim() || 'Folder';
    });
  },
});

export const tagFolderSetVisible = defineCommand({
  id: 'tag.folder.setVisible',
  title: 'Tag Folder Visibility',
  category: 'view',
  params: z.object({ id: idSchema, visible: z.boolean() }),
  undoable: true,
  run(ctx, p): void {
    hostOf(ctx).edit(p.visible ? 'Show Folder' : 'Hide Folder', (draft) => {
      folderOf(draftState(draft), p.id).visible = p.visible;
    });
  },
});

/** Delete a folder: its tags and sub-folders move to the parent (tags are never deleted). */
export const tagFolderDelete = defineCommand({
  id: 'tag.folder.delete',
  title: 'Delete Tag Folder',
  category: 'edit',
  params: z.object({ id: idSchema }),
  undoable: true,
  run(ctx, p): void {
    hostOf(ctx).edit('Delete Tag Folder', (draft) => {
      const state = draftState(draft);
      const folder = folderOf(state, p.id);
      for (const t of state.tags.values()) if (t.folderId === folder.id) t.folderId = folder.parentId;
      for (const f of state.tagFolders.values()) if (f.parentId === folder.id) f.parentId = folder.parentId;
      for (const s of state.scenes.values()) if (s.hiddenTagFolders.includes(folder.id)) s.hiddenTagFolders = s.hiddenTagFolders.filter((x) => x !== folder.id);
      state.tagFolders.delete(folder.id);
    });
  },
});

/** Move a tag into a folder (null = top level). */
export const tagSetFolder = defineCommand({
  id: 'tag.setFolder',
  title: 'Move Tag To Folder',
  category: 'edit',
  params: z.object({ id: idSchema, folderId: idSchema.nullable() }),
  undoable: true,
  run(ctx, p): void {
    hostOf(ctx).edit('Move Tag', (draft) => {
      const state = draftState(draft);
      if (p.folderId !== null) folderOf(state, p.folderId);
      tagOf(state, p.id).folderId = p.folderId as TagFolderId | null;
    });
  },
});

/** Styles › Modeling "Color by Tag" on the active style (toggles when `value` is omitted). */
export const viewColorByTag = defineCommand({
  id: 'view.colorByTag',
  title: 'Color by Tag',
  category: 'view',
  menu: 'View',
  params: z.object({ value: z.boolean().optional() }),
  undoable: false,
  run(ctx, p): boolean {
    const host = hostOf(ctx);
    const cur = host.doc.state.styles.get(host.doc.state.activeStyleId)?.modeling.colorByTag ?? false;
    const next = p.value ?? !cur;
    patchActiveStyle(host, 'Color by Tag', (style) => {
      style.modeling.colorByTag = next;
    });
    return next;
  },
});

export const tagCommands: readonly AnyCommand[] = [
  tagCreate,
  tagRename,
  tagSetVisible,
  tagSetColor,
  tagSetDashes,
  tagDelete,
  tagSetActive,
  tagAssign,
  tagPurge,
  tagSelectAll,
  tagFolderCreate,
  tagFolderRename,
  tagFolderSetVisible,
  tagFolderDelete,
  tagSetFolder,
  viewColorByTag,
];
