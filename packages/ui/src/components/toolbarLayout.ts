// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CommandInfo } from '@pushform/commands';
import type { StackedTool } from './ToolStack';

/**
 * Toolbar layout: single buttons and stacked slots, in
 * order, with separators. A string entry names a tool id (the `tool.` prefix is implied); a
 * `{ command }` entry is a one-shot command such as Zoom Extents that sits in a stack next to
 * the tools it belongs with. A stack's entries are listed in flyout order; the first is the
 * default face.
 */
export type SlotEntry = string | { readonly command: string; readonly icon: string };
export type Slot =
  | { readonly kind: 'tool'; readonly id: string }
  | { readonly kind: 'stack'; readonly title: string; readonly entries: readonly SlotEntry[] }
  | { readonly kind: 'sep' };

const tool = (id: string): Slot => ({ kind: 'tool', id });
const stack = (title: string, ...entries: SlotEntry[]): Slot => ({ kind: 'stack', title, entries });
const command = (command: string, icon: string): SlotEntry => ({ command, icon });
const SEP: Slot = { kind: 'sep' };

export const TOOLBAR_GROUPS: readonly { title: string; slots: readonly Slot[] }[] = [
  {
    title: 'Transform',
    slots: [
      stack('Select', 'select', 'lasso'),
      tool('move'),
      tool('rotate'),
      tool('scale'),
      tool('eraser'),
    ],
  },
  {
    title: 'Draw',
    slots: [
      stack('Line', 'line', 'freehand'),
      stack('Shape', 'rectangle', 'rotrect', 'circle', 'polygon'),
      stack('Arc', 'arc', 'arc2', 'arc3', 'pie'),
    ],
  },
  {
    title: 'Modify',
    slots: [
      tool('pushpull'),
      tool('offset'),
      tool('followme'),
      stack('Edge', 'fillet', 'chamfer'),
      stack(
        'Solid',
        'solid.outerShell',
        'solid.union',
        'solid.subtract',
        'solid.trim',
        'solid.intersect',
        'solid.split',
      ),
    ],
  },
  {
    title: 'Measure',
    slots: [
      stack(
        'Measure',
        'tape',
        'dimension',
        'text',
        command('ui.text3d', 'tool-text3d'),
        'protractor',
        'axes',
      ),
    ],
  },
  { title: 'Organize', slots: [tool('paint'), tool('tag')] },
  {
    title: 'View',
    slots: [
      stack('Camera', 'orbit', 'pan'),
      stack('Zoom', 'zoom', 'zoomWindow', command('camera.zoomExtents', 'zoom-extents')),
    ],
  },
];

export const TOOLBAR_LAYOUT: readonly Slot[] = TOOLBAR_GROUPS.flatMap((group, index) =>
  index === 0 ? [...group.slots] : [SEP, ...group.slots],
);

/** Tools reachable only from elsewhere (context menus, panels); never shown as toolbar buttons. */
const NOT_IN_TOOLBAR: ReadonlySet<string> = new Set(['texturePosition']);

/** A toolbar item: what the stack shows (`StackedTool`) plus the command that runs on click. */
export interface ToolbarItem extends StackedTool {
  readonly commandId: string;
}

export type ResolvedSlot =
  | { readonly kind: 'tool'; readonly tool: ToolbarItem }
  | { readonly kind: 'stack'; readonly title: string; readonly tools: readonly ToolbarItem[] }
  | { readonly kind: 'sep' };

/**
 * Match the layout against the registered commands. Slots whose tools are not registered are
 * dropped (a stack keeps whichever of its entries exist); registered tools the layout does not
 * mention are appended as single buttons so nothing is unreachable. Adjacent separators collapse.
 * `keyOf` returns the shortcut label for a full command id.
 */
export function resolveSlots(
  layout: readonly Slot[],
  commands: readonly CommandInfo[],
  keyOf: (commandId: string) => string | null | undefined,
  appendUnlisted = true,
): ResolvedSlot[] {
  const byCommand = new Map<string, CommandInfo>(commands.map((c) => [c.id, c]));
  const tools = new Map<string, ToolbarItem>();
  for (const c of commands) {
    // ToolManager registers tools as `tool.<id>`; other commands in the category are not toolbar tools
    if (c.category !== 'tool' || !c.id.startsWith('tool.')) continue;
    const id = c.id.slice('tool.'.length);
    tools.set(id, {
      id,
      commandId: c.id,
      title: c.title,
      icon: c.icon ?? `tool-${id}`,
      key: keyOf(c.id) ?? undefined,
    });
  }
  const resolveEntry = (entry: SlotEntry): ToolbarItem | undefined => {
    if (typeof entry === 'string') return tools.get(entry);
    const c = byCommand.get(entry.command);
    if (!c) return undefined;
    return {
      id: c.id,
      commandId: c.id,
      title: c.title,
      icon: entry.icon,
      key: keyOf(c.id) ?? undefined,
    };
  };
  const used = new Set<string>();
  const out: ResolvedSlot[] = [];
  const pushSep = () => {
    if (out.length > 0 && out[out.length - 1]!.kind !== 'sep') out.push({ kind: 'sep' });
  };
  for (const slot of layout) {
    if (slot.kind === 'sep') {
      pushSep();
      continue;
    }
    const entries: readonly SlotEntry[] = slot.kind === 'tool' ? [slot.id] : slot.entries;
    const tools = entries.map(resolveEntry).filter((t): t is ToolbarItem => t !== undefined);
    for (const t of tools) used.add(t.id);
    if (tools.length === 0) continue;
    if (slot.kind === 'tool' || tools.length === 1) out.push({ kind: 'tool', tool: tools[0]! });
    else out.push({ kind: 'stack', title: slot.title, tools });
  }
  const leftovers = [...tools.values()].filter((t) => !used.has(t.id) && !NOT_IN_TOOLBAR.has(t.id));
  if (appendUnlisted && leftovers.length > 0) {
    pushSep();
    for (const t of leftovers) out.push({ kind: 'tool', tool: t });
  }
  while (out.length > 0 && out[out.length - 1]!.kind === 'sep') out.pop();
  return out;
}

/** Keep unlisted registered tools accessible in a final group. */
export function resolveGroups(
  commands: readonly CommandInfo[],
  keyOf: (id: string) => string | null | undefined,
): { title: string; slots: ResolvedSlot[] }[] {
  const remaining = new Set(commands.map((c) => c.id));
  const groups = TOOLBAR_GROUPS.map((group) => {
    const slots = resolveSlots(group.slots, commands, keyOf, false);
    for (const slot of slots) {
      if (slot.kind === 'sep') continue;
      for (const item of slot.kind === 'tool' ? [slot.tool] : slot.tools)
        remaining.delete(item.commandId);
    }
    return { title: group.title, slots };
  }).filter((group) => group.slots.length > 0);
  const extra = resolveSlots(
    [],
    commands.filter((c) => remaining.has(c.id)),
    keyOf,
  );
  if (extra.length > 0) groups.push({ title: 'More', slots: extra });
  return groups;
}
