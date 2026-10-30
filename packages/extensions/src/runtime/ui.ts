// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  ExtensionError, UiTreeError, uiMountSchema, uiUnmountSchema, validateUiTree, type ExtensionManifest, type UiEvent,
  type UiNode, type UiNodeOf, type UiTreeItem,
} from '@pushform/extension-protocol';
import type { ServiceImplementations } from './host';

/**
 * The host's record of the interface trees one extension has mounted. A target is one of the extension's panel,
 * inspector or settings contributions. `ui.mount` shows a tree for a target, `ui.update` replaces it with a newer
 * one (a higher sequence number), and `ui.unmount` removes it. A tree that fails validation or arrives out of order
 * is refused with a structured error and the previous tree stays on screen. Events from the user are checked
 * against the tree currently shown before they are sent, so the extension never hears about a component it did not
 * show, or about a target that is no longer mounted.
 */

const UI_TARGETS = new Set(['model.panel', 'model.inspector.block', 'app.settings.block']);

export interface MountedUi {
  readonly target: string;
  readonly seq: number;
  readonly tree: UiNode;
}

export type UiEventMessage = { readonly target: string } & UiEvent;

export class ExtensionUiHost {
  private readonly targets: ReadonlySet<string>;
  private readonly mounted = new Map<string, MountedUi>();
  private readonly listeners = new Set<(target: string) => void>();

  constructor(manifest: ExtensionManifest, private readonly send: (event: UiEventMessage) => void) {
    this.targets = new Set(manifest.contributions.filter((c) => UI_TARGETS.has(c.target)).map((c) => c.id));
  }

  /** The `ui` service methods, for an `ExtensionSession`. */
  services(): ServiceImplementations {
    return {
      'ui.mount': (input) => this.show(input, 'mount'),
      'ui.update': (input) => this.show(input, 'update'),
      'ui.unmount': (input) => {
        const parsed = uiUnmountSchema.safeParse(input);
        if (!parsed.success) throw new ExtensionError('validation.failed', 'ui.unmount needs a target.');
        if (this.mounted.delete(parsed.data.target)) this.notify(parsed.data.target);
        return null;
      },
    };
  }

  get(target: string): MountedUi | undefined {
    return this.mounted.get(target);
  }

  /** Calls `listener` with the target whenever a tree is shown, replaced or removed. */
  subscribe(listener: (target: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The host closed the target (its panel closed): the tree is dropped, and later events for it are not sent. */
  close(target: string): void {
    if (this.mounted.delete(target)) this.notify(target);
  }

  /** Removes everything, as when the extension stops. */
  clear(): void {
    const targets = [...this.mounted.keys()];
    this.mounted.clear();
    for (const target of targets) this.notify(target);
  }

  /**
   * Sends a user event to the extension if it fits the tree on screen: the component exists, accepts that event and
   * the payload is of the right kind. Returns whether it was sent.
   */
  dispatch(target: string, event: UiEvent): boolean {
    const shown = this.mounted.get(target);
    if (!shown) return false;
    const node = findNode(shown.tree, event.component);
    if (!node || !accepts(node, event)) return false;
    this.send({ target, ...event });
    return true;
  }

  private show(input: unknown, kind: 'mount' | 'update'): { seq: number } {
    const parsed = uiMountSchema.safeParse(input);
    if (!parsed.success) throw new ExtensionError('validation.failed', `ui.${kind} needs a target, a sequence number and a tree.`);
    const { target, seq } = parsed.data;
    if (!this.targets.has(target))
      throw new ExtensionError('validation.failed', `"${target}" is not a panel, inspector or settings contribution of this extension.`);
    const current = this.mounted.get(target);
    if (kind === 'update' && !current) throw new ExtensionError('validation.failed', `"${target}" is not mounted; call ui.mount first.`);
    if (current && seq <= current.seq)
      throw new ExtensionError('validation.failed', `Sequence ${seq} is not newer than the tree shown (${current.seq}); the shown tree is kept.`);
    let tree: UiNode;
    try {
      tree = validateUiTree(parsed.data.tree);
    } catch (error) {
      if (error instanceof UiTreeError) throw new ExtensionError(error.code, `${error.message} The previous interface is kept.`);
      throw error;
    }
    this.mounted.set(target, { target, seq, tree });
    this.notify(target);
    return { seq };
  }

  private notify(target: string): void {
    for (const listener of this.listeners) listener(target);
  }
}

/** The node with `id` in the tree, searching every child, including tabs that are not selected. */
export function findNode(node: UiNode, id: string): UiNode | undefined {
  if (node.id === id) return node;
  if (node.type === 'stack' || node.type === 'tabs')
    for (const child of node.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
  return undefined;
}

const hasItem = (items: readonly UiTreeItem[], id: string): boolean =>
  items.some((item) => item.id === id || (item.children !== undefined && hasItem(item.children, id)));

function accepts(node: UiNode, event: UiEvent): boolean {
  switch (event.event) {
    case 'press':
      return node.type === 'button' && !node.disabled;
    case 'change':
      switch (node.type) {
        case 'textField': return !node.disabled && typeof event.value === 'string' && event.value.length <= (node.maxLength ?? Infinity);
        case 'numberField': return !node.disabled && (event.value === null || (typeof event.value === 'number' && Number.isFinite(event.value)));
        case 'checkbox': return !node.disabled && typeof event.value === 'boolean';
        case 'choice': return !node.disabled && (event.value === null || node.options.some((o) => o.value === event.value));
        case 'colorField': return !node.disabled && typeof event.value === 'string' && /^#[0-9a-fA-F]{6}$/.test(event.value);
        default: return false;
      }
    case 'select':
      if (node.type === 'tabs') return node.tabs.some((t) => t.id === event.value);
      if (node.type === 'tree') return event.value === null || hasItem(node.items, event.value);
      return false;
    case 'toggle':
      return node.type === 'tree' && hasItem(node.items, event.item);
    case 'cellEdit': {
      if (node.type !== 'table') return false;
      const column = node.columns.find((c) => c.id === event.column);
      if (!column?.editable || !node.rows.some((r) => r.id === event.row && r.heading === undefined)) return false;
      const v = event.value;
      return v === null || (column.kind === 'number' ? typeof v === 'number' && Number.isFinite(v)
        : column.kind === 'boolean' ? typeof v === 'boolean'
          : column.kind === 'choice' ? typeof v === 'string' && (column.options ?? []).some((o) => o.value === v)
            : typeof v === 'string');
    }
    case 'sort':
      return node.type === 'table' && node.columns.some((c) => c.id === event.column && c.sortable);
    case 'rowSelect':
      return node.type === 'table' && (node.selection === 'multiple' || (node.selection === 'single' && event.rows.length <= 1))
        && event.rows.every((row) => node.rows.some((r) => r.id === row));
    case 'columns':
      return node.type === 'table' && event.hidden.every((col) => node.columns.some((c) => c.id === col && c.hideable));
  }
}

export type { UiNodeOf };
