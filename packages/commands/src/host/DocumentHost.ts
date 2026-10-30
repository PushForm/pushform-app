// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { TransactionHost, TransactionMeta } from '../registry/Command';
import { Emitter } from '@pushform/core';
import type { Id } from '@pushform/core';
import { ImageStore, Selection, UndoStack, contextAt, createDocument } from '@pushform/model';
import type { DocumentDraft, Document, EditContext } from '@pushform/model';

export type DocumentHostEvents = { contextChanged: { context: EditContext; previous: EditContext } };

/**
 * Real TransactionHost over the model Document + UndoStack + Selection.
 * Commands mutate the document by calling `host.edit(draft => ...)` inside a transaction; nested
 * calls run on the outer draft, so a command's mutations merge into the registry's transaction.
 */
export class DocumentHost implements TransactionHost {
  readonly doc: Document;
  readonly selection: Selection;
  readonly undoStack: UndoStack;
  readonly events = new Emitter<DocumentHostEvents>();
  /** Runtime image bytes (texture images); the document state only holds `ImageAsset` descriptors. */
  readonly images = new ImageStore();
  private _context: EditContext;

  constructor(doc: Document = createDocument()) {
    this.doc = doc;
    this.selection = new Selection();
    this.undoStack = new UndoStack(doc, this.selection);
    this._context = { path: [], definitionId: doc.state.rootDefinitionId };
    // undo/redo may delete the instance being edited: fall back to the nearest valid ancestor
    this.doc.events.on('change', () => this.revalidateContext());
  }

  /** The open edit context (the group/component you double-clicked into). Runtime state, not undoable. */
  get context(): EditContext {
    return this._context;
  }
  /** Enter the context at `path` (empty = root). Clears the selection. */
  setContext(path: readonly Id[]): void {
    const previous = this._context;
    const next = contextAt(this.doc.state, path);
    if (next.path.length === previous.path.length && next.path.every((id, i) => id === previous.path[i])) return;
    this._context = next;
    this.selection.clear();
    this.events.emit('contextChanged', { context: next, previous });
  }
  private revalidateContext(): void {
    const path = this._context.path;
    if (path.length === 0) return;
    for (let n = path.length; n >= 0; n--) {
      try {
        const ctx = contextAt(this.doc.state, path.slice(0, n));
        if (n !== path.length || ctx.definitionId !== this._context.definitionId) {
          const previous = this._context;
          this._context = ctx;
          this.selection.clear();
          this.events.emit('contextChanged', { context: ctx, previous });
        }
        return;
      } catch {
        // step missing: try the parent
      }
    }
  }

  transact<T>(label: string, fn: () => T, meta?: TransactionMeta): T {
    return this.undoStack.transact(label, () => fn(), meta ? { commandId: meta.commandId, params: meta.params } : {});
  }
  /** Mutate the document. Inside a `transact` this merges into it; outside it records its own entry. */
  edit<T>(label: string, fn: (draft: DocumentDraft) => T): T {
    return this.undoStack.transact(label, fn);
  }
  undo(): boolean {
    return this.undoStack.undo();
  }
  redo(): boolean {
    return this.undoStack.redo();
  }
  canUndo(): boolean {
    return this.undoStack.canUndo;
  }
  canRedo(): boolean {
    return this.undoStack.canRedo;
  }
  onChange(fn: () => void): () => void {
    return this.undoStack.events.on('change', () => fn());
  }
}
