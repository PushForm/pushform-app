// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  ExtensionError, UI_MOUNT_TARGETS, UiTreeError, uiCloseDialogSchema, uiDialogSchema, uiMountSchema, uiOpenSchema, uiUnmountSchema, validateUiTree,
  type ExtensionManifest, type UiEvent, type UiNode, type UiNodeOf, type UiTreeItem,
} from '@pushform/extension-protocol';
import type { ServiceCall, ServiceImplementations } from './host';

/**
 * The host's record of the interface trees one extension has mounted. A target is one of the extension's sidebar,
 * panel, inspector or settings contributions: a sidebar shows in the extension's side panel, a panel in a tab of its
 * own. `ui.mount` shows a tree for a target, `ui.update` replaces it with a newer one (a higher sequence number), and
 * `ui.unmount` removes it. A tree that fails validation or arrives out of order is refused with a structured error
 * and the previous tree stays on screen. Events from the user are checked against the tree currently shown before
 * they are sent, so the extension never hears about a component it did not show, or about a target that is no
 * longer mounted.
 *
 * A mounted target can show one modal dialog with its own tree (`ui.dialog`), replaced by a newer sequence number
 * and closed by `ui.closeDialog`, by the user (reported as `dialogClose`) or with the target. While it is open, the
 * dialog's components take precedence over the target's for events with the same component id.
 *
 * `ui.open` asks the host to open, or bring to the front, the tab of one of the extension's own panel contributions
 * for the document the call acts on. It is a gesture-gated request, like the clipboard: it works only right after
 * the user acted on the extension, so no extension can push a tab in front of the user by itself.
 */

const UI_TARGETS: ReadonlySet<string> = new Set(UI_MOUNT_TARGETS);

/** What `ui.open` asks the host for. */
export interface UiOpenRequest {
  readonly extensionId: string;
  /** A `model.panel` contribution of the extension. */
  readonly target: string;
  /** The document the tab is bound to: the one the calling invocation acts on. */
  readonly documentId: string;
}

export interface ExtensionUiHostOptions {
  /** Opens the panel's tab; without it `ui.open` answers `unavailable`. */
  readonly open?: (request: UiOpenRequest) => void;
}

export interface MountedUiDialog {
  readonly seq: number;
  readonly title: string;
  readonly tree: UiNode;
}

export interface MountedUi {
  readonly target: string;
  readonly seq: number;
  readonly tree: UiNode;
  /** The dialog open over the target, if any. */
  readonly dialog?: MountedUiDialog;
  /** The sequence number of the last dialog shown for this target, so a stale `ui.dialog` cannot reopen one. */
  readonly dialogSeq?: number;
}

export type UiEventMessage = { readonly target: string } & UiEvent;

export class ExtensionUiHost {
  private readonly targets: ReadonlySet<string>;
  private readonly panels: ReadonlySet<string>;
  private readonly mounted = new Map<string, MountedUi>();
  private readonly listeners = new Set<(target: string) => void>();

  constructor(manifest: ExtensionManifest, private readonly send: (event: UiEventMessage) => void, private readonly options: ExtensionUiHostOptions = {}) {
    this.targets = new Set(manifest.contributions.filter((c) => UI_TARGETS.has(c.target)).map((c) => c.id));
    this.panels = new Set(manifest.contributions.filter((c) => c.target === 'model.panel').map((c) => c.id));
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
      'ui.open': (input, call) => this.open(input, call),
      'ui.dialog': (input) => this.showDialog(input),
      'ui.closeDialog': (input) => {
        const parsed = uiCloseDialogSchema.safeParse(input);
        if (!parsed.success) throw new ExtensionError('validation.failed', 'ui.closeDialog needs a target.');
        this.removeDialog(parsed.data.target);
        return null;
      },
    };
  }

  /** The user dismissed the dialog of `target`: it is removed, then the extension hears `dialogClose`. */
  closeDialog(target: string): void {
    const dialog = this.mounted.get(target)?.dialog;
    if (!dialog) return;
    this.removeDialog(target);
    this.send({ target, component: dialog.tree.id, event: 'dialogClose' });
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
    if (event.event === 'dialogClose') {
      if (shown.dialog?.tree.id !== event.component) return false;
      this.closeDialog(target);
      return true;
    }
    const node = (shown.dialog && findNode(shown.dialog.tree, event.component)) || findNode(shown.tree, event.component);
    if (!node || !accepts(node, event)) return false;
    this.send({ target, ...event });
    return true;
  }

  private open(input: unknown, call: ServiceCall): null {
    const parsed = uiOpenSchema.safeParse(input);
    if (!parsed.success) throw new ExtensionError('validation.failed', 'ui.open needs a target.');
    const { target } = parsed.data;
    if (!this.panels.has(target)) throw new ExtensionError('validation.failed', `"${target}" is not a panel contribution of this extension.`);
    if (!call.userActivated()) throw new ExtensionError('permission.denied', 'A panel can be opened only right after the user acts on the extension.');
    if (!this.options.open) throw new ExtensionError('unavailable', 'Panels cannot be opened here.');
    this.options.open({ extensionId: call.extensionId, target, documentId: call.currentDocument() });
    return null;
  }

  private showDialog(input: unknown): { seq: number } {
    const parsed = uiDialogSchema.safeParse(input);
    if (!parsed.success) throw new ExtensionError('validation.failed', 'ui.dialog needs a target, a sequence number, a title and a tree.');
    const { target, seq, title } = parsed.data;
    const current = this.mounted.get(target);
    if (!current) throw new ExtensionError('validation.failed', `"${target}" is not mounted; call ui.mount first.`);
    if (seq <= (current.dialogSeq ?? -1))
      throw new ExtensionError('validation.failed', `Sequence ${seq} is not newer than the last dialog (${current.dialogSeq}); the dialog shown is kept.`);
    let tree: UiNode;
    try {
      tree = validateUiTree(parsed.data.tree);
    } catch (error) {
      if (error instanceof UiTreeError) throw new ExtensionError(error.code, `${error.message} The dialog shown is kept.`);
      throw error;
    }
    this.mounted.set(target, { ...current, dialog: { seq, title, tree }, dialogSeq: seq });
    this.notify(target);
    return { seq };
  }

  private removeDialog(target: string): void {
    const current = this.mounted.get(target);
    if (!current?.dialog) return;
    const { dialog: _gone, ...rest } = current;
    this.mounted.set(target, rest);
    this.notify(target);
  }

  private show(input: unknown, kind: 'mount' | 'update'): { seq: number } {
    const parsed = uiMountSchema.safeParse(input);
    if (!parsed.success) throw new ExtensionError('validation.failed', `ui.${kind} needs a target, a sequence number and a tree.`);
    const { target, seq } = parsed.data;
    if (!this.targets.has(target))
      throw new ExtensionError('validation.failed', `"${target}" is not a sidebar, panel, inspector or settings contribution of this extension.`);
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
    // A new tree does not touch the dialog open over it.
    this.mounted.set(target, { ...current, target, seq, tree });
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
  if (node.type === 'stack' || node.type === 'tabs' || node.type === 'section')
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
      if (node.type === 'section') return event.action !== undefined && (node.actions ?? []).some((a) => a.id === event.action && !a.disabled);
      return node.type === 'button' && !node.disabled && event.action === undefined;
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
      if (node.type === 'vector') return event.value === null || node.shapes.some((shape) => shape.item === event.value);
      if (node.type === 'tree') return event.value === null || hasItem(node.items, event.value);
      if (node.type === 'menu') return !node.disabled && node.items.some((item) => item.id === event.value && !item.disabled);
      return false;
    case 'toggle':
      return node.type === 'tree' && hasItem(node.items, event.item);
    case 'collapse':
      return node.type === 'section' && event.collapsed !== (node.collapsed ?? false);
    case 'dialogClose':
      return false;
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
    case 'hover':
      return node.type === 'vector' && (event.item === null || node.shapes.some((shape) => shape.item === event.item));
  }
}

export type { UiNodeOf };
