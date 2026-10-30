// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { defineCommand } from './Command';
import type { AnyCommand } from './Command';

const NoParams = z.object({});

/** Undo/Redo commands routed to the TransactionHost. */
export const editCommands: readonly AnyCommand[] = [
  defineCommand({
    id: 'edit.undo',
    title: 'Undo',
    category: 'edit',
    icon: 'undo',
    menu: 'Edit',
    keybinding: 'Mod+Z',
    params: NoParams,
    undoable: false,
    when: (ctx) => ctx.tx.canUndo(),
    run: (ctx) => ctx.tx.undo(),
  }),
  defineCommand({
    id: 'edit.redo',
    title: 'Redo',
    category: 'edit',
    icon: 'redo',
    menu: 'Edit',
    keybinding: 'Mod+Shift+Z',
    params: NoParams,
    undoable: false,
    when: (ctx) => ctx.tx.canRedo(),
    run: (ctx) => ctx.tx.redo(),
  }),
];
