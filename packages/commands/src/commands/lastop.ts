// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { PushFormError } from '@pushform/core';
import { defineCommand } from '../registry/Command';
import type { AnyCommand, CommandContext } from '../registry/Command';
import { DocumentHost } from '../host/DocumentHost';
import { hostOf, registryOf, SERVICE_DOCUMENT } from '../host/services';

/**
 * "Redo last with new params" (adjust-last-operation panel; also the "type a
 * value after finishing" VCB behaviour).
 */

export interface LastOperation {
  readonly label: string;
  /** Command that produced the top undo entry; null when it was not a registry command. */
  readonly commandId: string | null;
  readonly params: unknown;
  /** True when the entry can be re-executed with new params (`edit.redoWithParams`). */
  readonly editable: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Describe the top undo entry, or null when the stack is empty. */
export function lastOperationOf(host: DocumentHost): LastOperation | null {
  const top = host.undoStack.peek();
  if (!top) return null;
  return { label: top.label, commandId: top.commandId, params: top.params, editable: top.commandId !== null };
}

function hasRedoable(ctx: CommandContext): boolean {
  const h = ctx.services.get(SERVICE_DOCUMENT);
  return h instanceof DocumentHost && (lastOperationOf(h)?.editable ?? false);
}

/**
 * Undo the top entry and re-execute its command with `params` merged over the recorded ones.
 * The new entry replaces the old one (the stack does not grow); on failure the original edit
 * is restored and the error rethrown.
 */
export const redoWithParams = defineCommand({
  id: 'edit.redoWithParams',
  title: 'Redo With New Parameters',
  category: 'edit',
  params: z.object({ params: z.record(z.string(), z.unknown()) }),
  undoable: false,
  when: hasRedoable,
  run(ctx, { params }) {
    const host = hostOf(ctx);
    const registry = registryOf(ctx);
    const top = host.undoStack.peek();
    if (!top || top.commandId === null) throw new PushFormError('lastop.none', 'Nothing to re-execute');
    const merged = isRecord(top.params) ? { ...top.params, ...params } : params;
    if (!host.undo()) throw new PushFormError('lastop.undo', 'Could not undo the last operation');
    try {
      return registry.execute(top.commandId, merged);
    } catch (error) {
      host.redo();
      throw error;
    }
  },
});

/** Execute the top entry's command again with the same params (a new undo entry). */
export const repeatLast = defineCommand({
  id: 'edit.repeatLast',
  title: 'Repeat Last',
  category: 'edit',
  menu: 'Edit',
  params: z.object({}),
  undoable: false,
  when: hasRedoable,
  run(ctx) {
    const host = hostOf(ctx);
    const top = host.undoStack.peek();
    if (!top || top.commandId === null) throw new PushFormError('lastop.none', 'Nothing to repeat');
    return registryOf(ctx).execute(top.commandId, top.params);
  },
});

export const lastOpCommands: readonly AnyCommand[] = [redoWithParams, repeatLast];
