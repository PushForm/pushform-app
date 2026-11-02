// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { defineCommand, type CommandRegistry, type ContextMenuItem } from '@pushform/commands';
import type { ContributionEntry, ExtensionEntry, ExtensionPlatform } from '@pushform/extensions';

/**
 * Extension contributions as the editors show them. Commands, selection actions, toolbar buttons and panels are
 * registered in the document's command registry under `extension:` ids, so they reach command search and context
 * menus with the extension's name beside them and can never take a built-in command's id. Registering runs no
 * extension code; running one does.
 */

export const EXTENSION_COMMAND_PREFIX = 'extension:';
/** The menu path of selection actions, which the model's context menu groups by extension. */
export const EXTENSION_SELECTION_MENU = 'Extensions/Selection';

export type ExtensionEditor = 'modeling' | 'layout';

export const extensionCommandId = (contributionId: string): string => `${EXTENSION_COMMAND_PREFIX}${contributionId}`;

/** The side rail (activity bar) id of an extension. */
export const extensionRailId = (extensionId: string): `extension:${string}` => `extension:${extensionId}`;

export const isExtensionRailId = (id: string): id is `extension:${string}` => id.startsWith(EXTENSION_COMMAND_PREFIX);

/** The extension id behind a rail id. */
export const railExtensionId = (railId: `extension:${string}`): string => railId.slice(EXTENSION_COMMAND_PREFIX.length);

/** The contributions of an extension that show in its side panel. */
export const extensionSidebars = (extension: ExtensionEntry): ContributionEntry[] => extension.contributions.filter((c) => c.target === 'model.sidebar');

/** The contributions of an extension that open as tabs of their own. */
export const extensionPanels = (extension: ExtensionEntry): ContributionEntry[] => extension.contributions.filter((c) => c.target === 'model.panel');

/**
 * The extensions the activity bar lists for `editor`: enabled ones that support it and have a side panel or a tab to
 * open, in name order. Runs no extension code.
 */
export function activityExtensions(platform: ExtensionPlatform, editor: ExtensionEditor): ExtensionEntry[] {
  return platform.extensions(editor).filter((e) => extensionSidebars(e).length > 0 || extensionPanels(e).length > 0);
}

/** The toolbar buttons enabled extensions add to the modeling toolbar, in extension and manifest order. */
export function extensionToolbarButtons(platform: ExtensionPlatform, editor: ExtensionEditor): ContributionEntry[] {
  return platform.extensions(editor).flatMap((e) => e.contributions.filter((c) => c.target === 'model.toolbar'));
}

/** Contribution targets registered as commands: the user starts them from command search or a menu. */
const COMMAND_TARGETS = new Set(['model.command', 'model.selection.action', 'model.toolbar', 'model.panel']);

/**
 * Keeps the registry's extension commands in step with what is installed and enabled for `editor`: commands,
 * selection actions, toolbar buttons and panels (whose command opens the panel's tab). `run` performs one the user
 * started. Returns a function that removes them all.
 */
export function syncExtensionCommands(registry: CommandRegistry, platform: ExtensionPlatform, editor: ExtensionEditor,
  run: (entry: ContributionEntry) => void): () => void {
  let registered: (() => void)[] = [];
  const clear = (): void => { for (const remove of registered) remove(); registered = []; };
  const sync = (): void => {
    clear();
    for (const entry of platform.contributions(editor)) {
      if (!COMMAND_TARGETS.has(entry.target)) continue;
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
