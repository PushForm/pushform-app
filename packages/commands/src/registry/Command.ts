// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { z } from 'zod';
import type { CameraHost } from '../camera/CameraHost';

/** Command categories drive toolbar/menu generation. `tool` commands activate a Tool. */
export type CommandCategory =
  | 'file'
  | 'edit'
  | 'view'
  | 'camera'
  | 'draw'
  | 'layout'
  | 'tool'
  | 'window'
  | 'help'
  | 'internal';

/**
 * Host for undoable mutations. The model package provides the real implementation later;
 * for M0 an in-memory stub is used (see `MemoryTransactionHost`).
 */
export interface TransactionMeta {
  readonly commandId: string;
  readonly params: unknown;
}

export interface TransactionHost {
  /** Run `fn` inside a transaction labelled `label`. Returns `fn`'s result. `meta` is recorded on the undo entry. */
  transact<T>(label: string, fn: () => T, meta?: TransactionMeta): T;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Subscribe to undo/redo availability changes. */
  onChange(fn: () => void): () => void;
}

/** Minimal view of the ToolManager that commands need (avoids an import cycle). */
export interface ToolHost {
  activate(id: string): void;
  readonly activeToolId: string | null;
}

/** Services commands may use. Fields are filled in by the app bootstrap; absent until then. */
export interface CommandContext {
  readonly tx: TransactionHost;
  camera?: CameraHost | undefined;
  tools?: ToolHost | undefined;
  /** Extension point for later packages (model document, selection, …). */
  readonly services: Map<string, unknown>;
}

export interface Command<P = unknown> {
  readonly id: string;
  readonly title: string;
  readonly category: CommandCategory;
  /** Icon name (resolved by the UI). */
  readonly icon?: string | undefined;
  /** Menu path, e.g. `Camera/Standard Views`. */
  readonly menu?: string | undefined;
  /** Default keybinding hint for display; the Keymap is authoritative. */
  readonly keybinding?: string | undefined;
  readonly params: z.ZodType<P>;
  readonly undoable: boolean;
  when?(ctx: CommandContext): boolean;
  run(ctx: CommandContext, params: P): unknown;
}

/** A command of any param type (for heterogeneous lists). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommand = Command<any>;

/** Identity helper that preserves the param type inference from the zod schema. */
export function defineCommand<P>(cmd: Command<P>): Command<P> {
  return cmd;
}

/** Simple in-memory transaction host for M0: counts transactions so Undo/Redo buttons respond. */
export class MemoryTransactionHost implements TransactionHost {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<() => void>();
  transact<T>(label: string, fn: () => T, _meta?: TransactionMeta): T {
    const result = fn();
    this.undoStack.push(label);
    this.redoStack = [];
    this.notify();
    return result;
  }
  undo(): boolean {
    const l = this.undoStack.pop();
    if (l === undefined) return false;
    this.redoStack.push(l);
    this.notify();
    return true;
  }
  redo(): boolean {
    const l = this.redoStack.pop();
    if (l === undefined) return false;
    this.undoStack.push(l);
    this.notify();
    return true;
  }
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify(): void {
    for (const fn of [...this.listeners]) fn();
  }
}
