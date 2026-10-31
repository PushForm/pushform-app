// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { EntityRefSchema, defineCommand, hostOf } from '@pushform/commands';
import type { AnyCommand, CommandContext, CommandRegistry } from '@pushform/commands';
import type { EdgeKey, EntityRef } from '@pushform/model';
import type { FaceLocalId, Id } from '@pushform/core';
import { PANEL_IDS, useAppStore } from '../store';
import { writeNavigationCubePreference } from '../navCubePreference';

function selectionOf(ctx: CommandContext): EntityRef[] {
  try {
    return hostOf(ctx).selection.refs;
  } catch {
    return [];
  }
}
const hasSelection = (ctx: CommandContext): boolean => selectionOf(ctx).length > 0;

/** Validated ref params → runtime refs (id brands and per-kind narrowing only). */
export function toEntityRef(r: z.infer<typeof EntityRefSchema>): EntityRef {
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
}

const store = () => useAppStore.getState();

/**
 * UI-layer commands: they only touch the zustand shell state (dialogs, panels, context menus),
 * never the document. Registered by the bootstrap (and lazily by the components that need them,
 * see `installUiCommands`). Ids are referenced by the keymap (`G` → `ui.makeComponent`) and by
 * `contextMenu.itemsFor` in `@pushform/commands`.
 */
export const uiCommands: readonly AnyCommand[] = [
  defineCommand({
    id: 'view.navigationCube',
    title: 'Navigation Cube',
    category: 'view',
    menu: 'View',
    params: z.object({ value: z.boolean().optional() }),
    undoable: false,
    run: (_ctx, p): boolean => {
      const visible = p.value ?? !store().navigationCube;
      store().setNavigationCube(visible);
      writeNavigationCubePreference(visible);
      return visible;
    },
  }),
  defineCommand({
    id: 'ui.makeComponent',
    title: 'Make Component…',
    category: 'edit',
    menu: 'Edit',
    keybinding: 'G',
    params: z.object({}),
    undoable: false,
    when: hasSelection,
    run: () => store().openDialog('makeComponent'),
  }),
  defineCommand({
    id: 'ui.text3d',
    title: '3D Text',
    category: 'tool',
    menu: 'Tools',
    params: z.object({}),
    undoable: false,
    run: () => store().openDialog('text3d'),
  }),
  defineCommand({
    id: 'ui.editText',
    title: 'Edit Text',
    category: 'edit',
    params: z.object({ ref: EntityRefSchema }),
    undoable: false,
    run: (_ctx, p) => store().openDialog('editText', toEntityRef(p.ref)),
  }),
  defineCommand({
    id: 'ui.renameInstance',
    title: 'Rename…',
    category: 'edit',
    params: z.object({ ref: EntityRefSchema }),
    undoable: false,
    run: (_ctx, p) => store().openDialog('renameInstance', toEntityRef(p.ref)),
  }),
  defineCommand({
    id: 'ui.dialog.close',
    title: 'Close Dialog',
    category: 'internal',
    params: z.object({}),
    undoable: false,
    run: () => store().closeDialog(),
  }),
  defineCommand({
    id: 'view.search',
    title: 'Search',
    category: 'view',
    params: z.object({}),
    undoable: false,
    run: () => {
      const input = document.getElementById('pf-command-search') as HTMLInputElement | null;
      input?.focus();
      input?.select();
    },
  }),
  defineCommand({
    id: 'ui.panel.open',
    title: 'Open Panel',
    category: 'window',
    params: z.object({ id: z.enum(PANEL_IDS) }),
    undoable: false,
    run: (_ctx, p) => store().showPanel(p.id),
  }),
  defineCommand({
    id: 'ui.contextMenu.open',
    title: 'Context Menu',
    category: 'internal',
    params: z.object({ x: z.number(), y: z.number(), refs: z.array(EntityRefSchema).default([]) }),
    undoable: false,
    run: (ctx, p) => {
      const refs = p.refs.map(toEntityRef);
      // Right-clicking an entity outside the selection selects it first; inside keeps the selection.
      try {
        const sel = hostOf(ctx).selection;
        if (refs.length && !refs.every((r) => sel.has(r))) sel.set(refs);
        store().openContextMenu({ x: p.x, y: p.y, refs: refs.length ? sel.refs : [] });
      } catch {
        store().openContextMenu({ x: p.x, y: p.y, refs });
      }
    },
  }),
  defineCommand({
    id: 'ui.contextMenu.close',
    title: 'Close Context Menu',
    category: 'internal',
    params: z.object({}),
    undoable: false,
    run: () => store().closeContextMenu(),
  }),
];

/** Register the UI commands that are not registered yet (idempotent; safe from component mounts). */
export function installUiCommands(commands: CommandRegistry): void {
  for (const c of uiCommands) if (!commands.has(c.id)) commands.register(c);
}
