// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { defineCommand, type CommandRegistry, type ContextMenuItem } from '@pushform/commands';
import type { ContributionEntry, ExtensionPlatform } from '@pushform/extensions';

/**
 * Extension contributions as the editors show them. Commands and selection actions are registered in the document's
 * command registry under `extension:` ids, so they reach command search and context menus with the extension's name
 * beside them and can never take a built-in command's id. Registering runs no extension code; running one does.
 */

export const EXTENSION_COMMAND_PREFIX = 'extension:';
/** The menu path of selection actions, which the model's context menu groups by extension. */
export const EXTENSION_SELECTION_MENU = 'Extensions/Selection';

export type ExtensionEditor = 'modeling' | 'layout';

export const extensionCommandId = (contributionId: string): string => `${EXTENSION_COMMAND_PREFIX}${contributionId}`;

/** The side rail id of an extension panel. */
export const extensionPanelId = (contributionId: string): `extension:${string}` => `extension:${contributionId}`;

export const isExtensionPanelId = (id: string): id is `extension:${string}` => id.startsWith(EXTENSION_COMMAND_PREFIX);

/** The panels the active editor shows: only those of enabled extensions that support it. */
export function extensionPanels(platform: ExtensionPlatform, editor: ExtensionEditor): ContributionEntry[] {
  return platform.contributions(editor).filter((entry) => entry.target === 'model.panel');
}

/**
 * Keeps the registry's extension commands in step with what is installed and enabled for `editor`. `run` performs a
 * command or selection action the user started. Returns a function that removes them all.
 */
export function syncExtensionCommands(registry: CommandRegistry, platform: ExtensionPlatform, editor: ExtensionEditor,
  run: (entry: ContributionEntry) => void): () => void {
  let registered: (() => void)[] = [];
  const clear = (): void => { for (const remove of registered) remove(); registered = []; };
  const sync = (): void => {
    clear();
    for (const entry of platform.contributions(editor)) {
      if (entry.target !== 'model.command' && entry.target !== 'model.selection.action') continue;
      const id = extensionCommandId(entry.id);
      if (registry.has(id)) continue;
      registered.push(registry.register(defineCommand({
        id, title: entry.name, source: entry.extensionName, category: 'view', icon: 'extensions',
        menu: entry.target === 'model.selection.action' ? EXTENSION_SELECTION_MENU : 'Extensions',
        params: z.object({}), undoable: false,
        run: () => run(entry),
      })));
    }
  };
  // The platform notifies on run-state changes too; re-register only when the set of commands changed.
  let key = '';
  const update = (): void => {
    const next = platform.contributions(editor).map((e) => `${e.id}\u0000${e.name}\u0000${e.extensionName}`).join('\u0001');
    if (next === key) return;
    key = next;
    sync();
  };
  update();
  const unsubscribe = platform.subscribe(update);
  return () => { unsubscribe(); clear(); };
}

/** Selection actions for the context menu: one submenu per extension, labelled with its name. */
export function selectionActionGroups(registry: CommandRegistry): ContextMenuItem[] {
  const groups = new Map<string, ContextMenuItem[]>();
  for (const command of registry.list({ menu: EXTENSION_SELECTION_MENU })) {
    const source = command.source ?? 'Extension';
    const items = groups.get(source) ?? [];
    items.push({ label: command.title, command: command.id, disabled: !command.enabled });
    groups.set(source, items);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([source, children], i) => ({ label: source, command: '', separator: i === 0, children }));
}
