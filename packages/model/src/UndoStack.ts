// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { Emitter, PushFormError } from '@pushform/core';
import type { Patch } from 'immer';
import type { Document, DocumentDraft } from './Document';
import type { EntityRef } from './entities/common';
import type { Selection } from './Selection';

export interface UndoEntry {
  label: string;
  /** Command that produced the entry, for "redo last with new params". */
  commandId: string | null;
  params: unknown;
  patches: Patch[];
  inverse: Patch[];
  selectionBefore: EntityRef[];
  selectionAfter: EntityRef[];
}

export type UndoEvents = { change: { canUndo: boolean; canRedo: boolean } };

/** An open exclusive group: the patches of every entry recorded by its owner, oldest first. */
interface UndoGroup {
  label: string;
  patches: Patch[][];
  inverse: Patch[][];
  selectionBefore: EntityRef[];
}

/**
 * Linear undo/redo over document patches.
 *
 * Not the stack's concern: camera changes, tool state, selection-only changes and anything else
 * that never produces document patches. Those are runtime state and are never recorded here
 * (selection is only snapshotted alongside document edits so undo restores what was selected).
 */
export class UndoStack {
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private group: UndoGroup | null = null;
  private groupOwner = false;
  readonly events = new Emitter<UndoEvents>();

  constructor(
    private readonly doc: Document,
    private readonly selection: Selection | null = null,
    readonly cap = 200,
  ) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get length(): number {
    return this.undoStack.length;
  }
  /** Top undo entry (the last applied edit) or null. */
  peek(): UndoEntry | null {
    return this.undoStack[this.undoStack.length - 1] ?? null;
  }
  get entries(): readonly UndoEntry[] {
    return this.undoStack;
  }

  /** Record an already-applied transaction. Entries without patches are ignored. Clears redo. */
  push(entry: UndoEntry): void {
    if (entry.patches.length === 0) return;
    if (this.group) {
      this.requireGroupOwner();
      this.group.patches.push(entry.patches);
      this.group.inverse.push(entry.inverse);
      return;
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > this.cap) this.undoStack.splice(0, this.undoStack.length - this.cap);
    this.redoStack = [];
    this.emit();
  }

  /**
   * Run a document transaction and record it with selection snapshots. Returns the callback value.
   * Nested inside another `transact` the entry merges into the outer one (no separate entry).
   */
  transact<T>(
    label: string,
    fn: (draft: DocumentDraft) => T,
    opts: { commandId?: string; params?: unknown } = {},
  ): T {
    if (this.group && !this.doc.inTransaction) this.requireGroupOwner();
    const selectionBefore = this.selection?.snapshot() ?? [];
    const tx = this.doc.transact(label, fn);
    if (!tx.nested) {
      this.push({
        label,
        commandId: opts.commandId ?? null,
        params: opts.params ?? null,
        patches: tx.patches,
        inverse: tx.inversePatches,
        selectionBefore,
        selectionAfter: this.selection?.snapshot() ?? [],
      });
    }
    return tx.value;
  }

  undo(): boolean {
    if (this.group) return false;
    const e = this.undoStack.pop();
    if (!e) return false;
    this.doc.applyPatches(e.inverse, e.patches, 'undo', e.label);
    this.selection?.restore(e.selectionBefore);
    this.redoStack.push(e);
    this.emit();
    return true;
  }

  redo(): boolean {
    if (this.group) return false;
    const e = this.redoStack.pop();
    if (!e) return false;
    this.doc.applyPatches(e.patches, e.inverse, 'redo', e.label);
    this.selection?.restore(e.selectionAfter);
    this.undoStack.push(e);
    this.emit();
    return true;
  }

  /**
   * Mutate the top entry in place (e.g. merge a follow-up edit's patches, or update `params`
   * before a redo-with-new-params re-execution). No-op when the stack is empty.
   */
  amendLast(fn: (entry: UndoEntry) => void): void {
    const e = this.peek();
    if (!e) return;
    fn(e);
    this.emit();
  }

  /** True while an exclusive group is open (`beginGroup`). */
  get grouped(): boolean {
    return this.group !== null;
  }

  /**
   * Open an exclusive group. Edits made inside `withinGroup` collect into one entry labelled `label`, recorded when
   * the group commits. Until it ends, every other edit is refused with `document.busy`, and undo and redo do
   * nothing, so asynchronous work between the owner's edits never interleaves with anyone else's.
   */
  beginGroup(label: string): void {
    if (this.group) throw new PushFormError('document.busy', 'Another change is still being applied');
    this.group = { label, patches: [], inverse: [], selectionBefore: this.selection?.snapshot() ?? [] };
  }

  /** Run the group owner's synchronous edits; only edits made inside `fn` may join the open group. */
  withinGroup<T>(fn: () => T): T {
    if (!this.group) throw new Error('withinGroup() requires an open group');
    const outer = this.groupOwner;
    this.groupOwner = true;
    try {
      return fn();
    } finally {
      this.groupOwner = outer;
    }
  }

  /**
   * Close the open group. Committing records its edits as one entry (none when nothing changed) and clears redo;
   * otherwise its edits are reverted and the selection restored, leaving the document as it was before the group.
   */
  endGroup(commit: boolean): void {
    const group = this.group;
    if (!group) return;
    this.group = null;
    if (!group.patches.length) return;
    const patches = group.patches.flat(), inverse = [...group.inverse].reverse().flat();
    if (commit) {
      this.push({ label: group.label, commandId: null, params: null, patches, inverse, selectionBefore: group.selectionBefore, selectionAfter: this.selection?.snapshot() ?? [] });
      return;
    }
    this.doc.applyPatches(inverse, patches, 'undo', group.label);
    this.selection?.restore(group.selectionBefore);
  }

  private requireGroupOwner(): void {
    if (!this.groupOwner) throw new PushFormError('document.busy', 'Wait until the change being applied finishes');
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  private emit(): void {
    this.events.emit('change', { canUndo: this.canUndo, canRedo: this.canRedo });
  }
}
