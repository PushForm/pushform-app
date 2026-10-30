// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { CommandRegistry } from '@pushform/commands';

export interface CommandTool {
  /** MCP tool name: the command id with `.` replaced by `_`. */
  name: string;
  commandId: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** `sketch.rectangle` → `sketch_rectangle`: tool names allow letters, digits, `_` and `-` only in many clients. */
export function toolName(commandId: string): string {
  return commandId.replace(/\./g, '_');
}

/** Internal commands an agent needs, since many commands act on the selection. */
export const EXPOSED_INTERNAL_COMMANDS: ReadonlySet<string> = new Set(['selection.set', 'selection.add', 'selection.remove', 'selection.toggle']);

/**
 * One tool per registered command that is not `internal`, plus the selection commands, with its JSON Schema generated
 * from the command's zod params (input side, so defaulted fields are optional). Types JSON Schema
 * cannot express (custom refinements, functions) are left unconstrained; the registry still
 * validates every call with the zod schema itself.
 */
export function commandTools(registry: CommandRegistry): CommandTool[] {
  let tools = cache.get(registry);
  if (!tools) cache.set(registry, (tools = buildTools(registry)));
  return tools;
}

/** A headless registry's commands do not change after it is built, so its tools are generated once. */
const cache = new WeakMap<CommandRegistry, CommandTool[]>();

function buildTools(registry: CommandRegistry): CommandTool[] {
  const tools: CommandTool[] = [];
  const seen = new Map<string, string>();
  for (const info of registry.list()) {
    if (info.category === 'internal' && !EXPOSED_INTERNAL_COMMANDS.has(info.id)) continue;
    const cmd = registry.get(info.id)!;
    const name = toolName(info.id);
    const clash = seen.get(name);
    if (clash) throw new Error(`Commands ${clash} and ${info.id} map to the same tool name ${name}`);
    seen.set(name, info.id);
    tools.push({
      name,
      commandId: info.id,
      description: `${info.title} (command ${info.id}${info.undoable ? ', undoable' : ''}${info.menu ? `, menu ${info.menu}` : ''}). Lengths are meters; Z is up.`,
      inputSchema: objectSchema(cmd.params),
    });
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

/** JSON Schema of a zod schema, always an object schema as MCP requires for tool input. */
export function objectSchema(schema: z.ZodType): Record<string, unknown> {
  let json: Record<string, unknown>;
  try {
    json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  } catch {
    json = {};
  }
  delete json['$schema'];
  if (json['type'] !== 'object') return { type: 'object', properties: {}, additionalProperties: true, description: 'Parameters are validated by the command.' };
  return json;
}
