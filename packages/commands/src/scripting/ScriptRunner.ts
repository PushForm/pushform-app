// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { CommandRegistry } from '../registry/CommandRegistry';

export const ScriptStepSchema = z.object({ cmd: z.string(), params: z.unknown().optional() });
export const ScriptSchema = z.array(ScriptStepSchema);
export type ScriptStep = z.infer<typeof ScriptStepSchema>;
export type Script = z.infer<typeof ScriptSchema>;

export interface ScriptStepResult {
  readonly cmd: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

export interface ScriptRunOptions {
  /** Stop at the first failing step (default true). */
  readonly stopOnError?: boolean;
  /** Wrap the whole script in one transaction labelled with this name. */
  readonly transactionLabel?: string;
}

/** Runs `[{cmd, params}]` sequentially through the registry. Backs e2e tests and MCP. */
export class ScriptRunner {
  constructor(private readonly commands: CommandRegistry | (() => CommandRegistry)) {}

  private registry(): CommandRegistry {
    return typeof this.commands === 'function' ? this.commands() : this.commands;
  }

  run(script: unknown, opts: ScriptRunOptions = {}): ScriptStepResult[] {
    const steps = ScriptSchema.parse(script);
    const commands = this.registry();
    const exec = () => this.runSteps(commands, steps, opts.stopOnError ?? true);
    if (opts.transactionLabel) return commands.ctx.tx.transact(opts.transactionLabel, exec);
    return exec();
  }

  /** Like `run`, but awaits async command results (kernel-backed commands). Not transactional. */
  async runAsync(script: unknown, opts: Pick<ScriptRunOptions, 'stopOnError'> = {}): Promise<ScriptStepResult[]> {
    const steps = ScriptSchema.parse(script);
    const commands = this.registry();
    const stopOnError = opts.stopOnError ?? true;
    const out: ScriptStepResult[] = [];
    for (const step of steps) {
      try {
        const result = await commands.execute(step.cmd, step.params);
        out.push({ cmd: step.cmd, ok: true, result });
      } catch (error) {
        out.push({ cmd: step.cmd, ok: false, error: error instanceof Error ? error.message : String(error) });
        if (stopOnError) break;
      }
    }
    return out;
  }

  private runSteps(commands: CommandRegistry, steps: Script, stopOnError: boolean): ScriptStepResult[] {
    const out: ScriptStepResult[] = [];
    for (const step of steps) {
      const r = commands.tryExecute(step.cmd, step.params);
      if (r.ok) out.push({ cmd: step.cmd, ok: true, result: r.result });
      else {
        out.push({ cmd: step.cmd, ok: false, error: r.error instanceof Error ? r.error.message : String(r.error) });
        if (stopOnError) break;
      }
    }
    return out;
  }
}
