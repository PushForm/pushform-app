// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { Emitter, PushFormError } from '@pushform/core';
import type { AnyCommand, Command, CommandCategory, CommandContext } from './Command';

export interface CommandRegistryEvents extends Record<string, unknown> {
  registered: { id: string };
  executed: { id: string; params: unknown; result: unknown };
  failed: { id: string; params: unknown; error: unknown };
}

/** Key under which a registry publishes itself in `ctx.services` (commands that run other commands). */
export const SERVICE_COMMANDS = 'commands';

export interface CommandInfo {
  readonly id: string;
  readonly title: string;
  readonly category: CommandCategory;
  readonly icon: string | undefined;
  readonly menu: string | undefined;
  readonly keybinding: string | undefined;
  readonly source?: string | undefined;
  readonly undoable: boolean;
  readonly enabled: boolean;
}

/**
 * Central command registry. Everything the UI, scripts and MCP can do goes through `execute`.
 * `execute` validates params with the command's zod schema, checks `when`, and wraps undoable
 * commands in a transaction on the injected `TransactionHost`.
 */
export class CommandRegistry {
  readonly events = new Emitter<CommandRegistryEvents>();
  private commands = new Map<string, Command<unknown>>();

  constructor(readonly ctx: CommandContext) {
    if (!ctx.services.has(SERVICE_COMMANDS)) ctx.services.set(SERVICE_COMMANDS, this);
  }

  /** Remove a command (tests, extensions). Returns false when it was not registered. */
  unregister(id: string): boolean {
    return this.commands.delete(id);
  }
  /** Register, replacing any command with the same id (tests, extension overrides). */
  replace<P>(cmd: Command<P>): () => void {
    this.commands.delete(cmd.id);
    return this.register(cmd);
  }
  register<P>(cmd: Command<P>): () => void {
    if (this.commands.has(cmd.id)) throw new PushFormError('command.duplicate', `Command already registered: ${cmd.id}`);
    this.commands.set(cmd.id, cmd as Command<unknown>);
    this.events.emit('registered', { id: cmd.id });
    return () => {
      this.commands.delete(cmd.id);
    };
  }

  registerAll(cmds: readonly AnyCommand[]): void {
    for (const c of cmds) this.register(c);
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  get(id: string): Command<unknown> | undefined {
    return this.commands.get(id);
  }

  isEnabled(id: string): boolean {
    const cmd = this.commands.get(id);
    if (!cmd) return false;
    return cmd.when ? cmd.when(this.ctx) : true;
  }

  /** Metadata list for toolbars/menus/MCP tool generation. */
  list(filter?: { category?: CommandCategory; menu?: string }): CommandInfo[] {
    const out: CommandInfo[] = [];
    for (const c of this.commands.values()) {
      if (filter?.category && c.category !== filter.category) continue;
      if (filter?.menu && c.menu !== filter.menu) continue;
      out.push({
        id: c.id,
        title: c.title,
        category: c.category,
        icon: c.icon,
        menu: c.menu,
        keybinding: c.keybinding,
        source: c.source,
        undoable: c.undoable,
        enabled: this.isEnabled(c.id),
      });
    }
    return out;
  }

  /**
   * Validate and run a command. Returns the command's result. Throws `PushFormError` with codes
   * `command.unknown`, `command.params`, or `command.disabled`.
   */
  execute(id: string, params?: unknown): unknown {
    const cmd = this.commands.get(id);
    if (!cmd) return this.fail(id, params, new PushFormError('command.unknown', `Unknown command: ${id}`));
    const parsed = cmd.params.safeParse(params === undefined ? {} : params);
    if (!parsed.success) {
      return this.fail(id, params, new PushFormError('command.params', `Invalid params for ${id}: ${parsed.error.message}`, parsed.error.issues));
    }
    if (cmd.when && !cmd.when(this.ctx)) {
      return this.fail(id, parsed.data, new PushFormError('command.disabled', `Command is not enabled: ${id}`));
    }
    try {
      const result = cmd.undoable
        ? this.ctx.tx.transact(cmd.title, () => cmd.run(this.ctx, parsed.data), { commandId: id, params: parsed.data })
        : cmd.run(this.ctx, parsed.data);
      this.events.emit('executed', { id, params: parsed.data, result });
      return result;
    } catch (error) {
      return this.fail(id, parsed.data, error);
    }
  }

  /** Every failure (unknown id, bad params, disabled, or thrown by `run`) emits `failed` before throwing. */
  private fail(id: string, params: unknown, error: unknown): never {
    this.events.emit('failed', { id, params, error });
    throw error;
  }

  /** `execute` that returns a Result-like tuple instead of throwing. */
  tryExecute(id: string, params?: unknown): { ok: true; result: unknown } | { ok: false; error: unknown } {
    try {
      return { ok: true, result: this.execute(id, params) };
    } catch (error) {
      return { ok: false, error };
    }
  }
}
