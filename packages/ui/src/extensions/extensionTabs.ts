// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ContributionEntry, ExtensionPlatform, UiOpenRequest } from '@pushform/extensions';

/**
 * The extension tabs open in the tab strip: each shows one `model.panel` contribution, bound to the document it was
 * opened from, and fills the editor area while it is the active tab. There is one tab per panel and document;
 * opening it again brings it to the front. The tabs last for the session only: nothing of them is stored, and a
 * reload starts without them. The bound document stays the editor's active document while its tab is in front, so
 * the toolbar, the side rail and the extension's own calls all act on it; choosing a document tab puts the editor
 * back in front and leaves the extension tab open.
 */
export interface ExtensionTab {
  readonly id: string;
  readonly entry: ContributionEntry;
  readonly documentId: string;
}

export const extensionTabId = (contributionId: string, documentId: string): string => `extension-tab:${contributionId}:${documentId}`;

export class ExtensionTabs {
  private list: readonly ExtensionTab[] = [];
  private active: string | null = null;
  private changes = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: {
    /** Makes a document the editor's active one, as the tab strip does. */
    readonly activateDocument: (documentId: string) => void;
    /** Whether a document is open. */
    readonly isOpen: (documentId: string) => boolean;
  }) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Increases on every change, for `useSyncExternalStore`. */
  get revision(): number {
    return this.changes;
  }

  get tabs(): readonly ExtensionTab[] {
    return this.list;
  }

  get activeId(): string | null {
    return this.active;
  }

  /** The tab in front, if an extension tab is. */
  get activeTab(): ExtensionTab | null {
    return this.active ? this.list.find((t) => t.id === this.active) ?? null : null;
  }

  /** Opens the tab of a panel contribution for `documentId`, or brings it to the front; its document becomes active. */
  open(entry: ContributionEntry, documentId: string): void {
    if (!this.options.isOpen(documentId)) return;
    const id = extensionTabId(entry.id, documentId);
    if (!this.list.some((t) => t.id === id)) this.list = [...this.list, { id, entry, documentId }];
    this.active = id;
    this.options.activateDocument(documentId);
    this.notify();
  }

  /** What `ui.open` asks for: the extension's own panel, for the document its invocation acts on. */
  openRequest(platform: ExtensionPlatform, request: UiOpenRequest): void {
    const entry = platform.contributions().find((c) => c.extensionId === request.extensionId && c.id === request.target && c.target === 'model.panel');
    if (entry) this.open(entry, request.documentId);
  }

  /** Puts a tab in front (its document becomes active), or, with null, the active document's editor. */
  activate(id: string | null): void {
    const tab = id ? this.list.find((t) => t.id === id) : null;
    if (id && !tab) return;
    if (this.active === (tab?.id ?? null)) return;
    this.active = tab?.id ?? null;
    if (tab) this.options.activateDocument(tab.documentId);
    this.notify();
  }

  /** The user switched to a document: an extension tab in front for another document goes behind it. */
  documentActivated(documentId: string): void {
    const tab = this.activeTab;
    if (tab && tab.documentId !== documentId) this.activate(null);
  }

  /**
   * The extension set or framed the selection of a document: when its own tab for that document is in front, the
   * document's editor comes to the front, so the user sees what the extension points at.
   */
  selectionShown(extensionId: string, documentId: string): void {
    const tab = this.activeTab;
    if (tab && tab.entry.extensionId === extensionId && tab.documentId === documentId) this.activate(null);
  }

  close(id: string): void {
    if (!this.list.some((t) => t.id === id)) return;
    this.list = this.list.filter((t) => t.id !== id);
    if (this.active === id) this.active = null;
    this.notify();
  }

  /** A document closed: its tabs close with it. */
  closeDocument(documentId: string): void {
    this.prune((t) => t.documentId !== documentId);
  }

  /** Closes every tab `keep` rejects, as when an extension is turned off or uninstalled. */
  prune(keep: (tab: ExtensionTab) => boolean): void {
    const kept = this.list.filter(keep);
    if (kept.length === this.list.length) return;
    this.list = kept;
    if (this.active && !kept.some((t) => t.id === this.active)) this.active = null;
    this.notify();
  }

  private notify(): void {
    this.changes++;
    for (const listener of this.listeners) listener();
  }
}
