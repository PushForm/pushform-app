// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/** The slice of the SDK client `runTurn` uses, so tests inject a scripted stream and never reach the network. */
export interface MessageStreamLike extends AsyncIterable<Anthropic.MessageStreamEvent> { finalMessage(): Promise<Anthropic.Message> }
export interface AnthropicLike { messages: { stream(params: Anthropic.MessageStreamParams): MessageStreamLike } }

export function createAnthropic(apiKey: string): Anthropic { return new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 }); }

export interface ToolResult { content: string; isError?: boolean }
export type ToolHandler = (input: unknown) => Promise<ToolResult | string> | ToolResult | string;
/** Keywords strict tool schemas reject (numerical, string and array constraints); zod keeps checking them in `withSchema`. */
const UNSUPPORTED_STRICT_KEYWORDS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems']);
/** Drop unsupported keywords everywhere in a schema; keys under `properties` are property names, never keywords. */
export function stripUnsupportedKeywords(node: unknown, propertyMap = false): unknown {
  if (Array.isArray(node)) return node.map((n) => stripUnsupportedKeywords(n));
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!propertyMap && UNSUPPORTED_STRICT_KEYWORDS.has(key)) continue;
    out[key] = stripUnsupportedKeywords(value, !propertyMap && key === 'properties');
  }
  return out;
}
/**
 * A tool definition for Haiku 5.5: strict schema from zod with `additionalProperties: false` and every key required.
 * `z.int()`, `.min()`, `.max()` and friends emit `minimum`/`maximum`/`maxLength`, which the API rejects on a strict
 * schema, so they are stripped here and enforced client-side by `withSchema`.
 */
export function defineTool<S extends z.ZodObject>(name: string, description: string, schema: S): Anthropic.Tool {
  const json = stripUnsupportedKeywords(z.toJSONSchema(schema)) as Record<string, unknown>;
  delete json['$schema'];
  const { type: _type, ...rest } = json;
  return { name, description, input_schema: { type: 'object', ...rest }, strict: true };
}
/**
 * A non-strict tool for an input too large for strict grammars (a union of document operations): the full JSON schema,
 * constraints included, guides the model and the executing side validates with zod. Its input streams as it is
 * generated; nothing here runs it, since `runTurn` never runs tools from a `max_tokens` or `refusal` stop.
 */
export function defineLooseTool<S extends z.ZodObject>(name: string, description: string, schema: S): Anthropic.Tool {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json['$schema'];
  const { type: _type, ...rest } = json;
  return { name, description, input_schema: { type: 'object', ...rest }, eager_input_streaming: true };
}
/** Wrap a handler so its input is validated against the schema; invalid input returns an error result the model can fix. */
export function withSchema<S extends z.ZodType>(schema: S, run: (input: z.output<S>) => Promise<ToolResult | string> | ToolResult | string): ToolHandler {
  return (input) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return { content: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`, isError: true };
    return run(parsed.data);
  };
}

export interface ToolCallEvent { id: string; name: string; input: unknown; result: ToolResult }
export interface TurnUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
/** `client_tools`: the turn is suspended until the browser answers the calls in `pending`. */
export type TurnStop = 'end_turn' | 'max_tokens' | 'refusal' | 'tool_rounds' | 'client_tools' | 'other';
/** A tool call the browser runs against its open document. */
export interface ClientToolCall { id: string; name: string; input: unknown }
/**
 * The round a turn suspended on: the calls the browser must answer, and the results of server tools from the same
 * round, which are sent back together with the browser's answers in one user message (tool_use order kept).
 */
export interface PendingClientTools { calls: ClientToolCall[]; results: Anthropic.ToolResultBlockParam[]; order: string[] }
export interface RunTurnOptions {
  client: AnthropicLike;
  model: string;
  system: string;
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
  /** The conversation so far, ending with the requester's framed message. */
  messages: Anthropic.MessageParam[];
  onText?: (delta: string) => void;
  onToolCall?: (call: ToolCallEvent) => void;
  maxToolRounds?: number;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  /** Tools the browser runs: a round that calls any of them suspends the turn instead of running a handler. */
  clientTools?: ReadonlySet<string> | undefined;
  /**
   * Resume a suspended turn: `appended` is everything the turn appended so far, unchanged (thinking blocks included),
   * ending with the user message that answers the suspended round; `rounds` counts the rounds already used.
   */
  resume?: { appended: Anthropic.MessageParam[]; rounds: number } | undefined;
}
export interface RunTurnResult { appended: Anthropic.MessageParam[]; text: string; usage: TurnUsage; stop: TurnStop; rounds: number; pending: PendingClientTools | null }

export const REFUSAL_TEXT = 'I cannot help with that in this conversation.';
export const TRUNCATED_TEXT = '\n\n(My reply was cut short. Ask me to continue.)';
export const ROUNDS_TEXT = '\n\n(I stopped looking things up for this turn. Ask me to continue.)';

/**
 * One assistant turn with a hand-written streaming tool loop (brief §Decisions): stream the assistant message, emit text
 * deltas, run every tool_use through its handler, answer them all in one user message, and loop until `end_turn`.
 * `max_tokens` and `refusal` never run tools: their tool_use blocks are answered with error results so the transcript
 * stays valid, and the turn ends with a short note. Haiku 5.5: adaptive thinking by default, `effort: low`, `tool_choice: auto`.
 */
export async function runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
  const { client, model, system, tools, handlers, onText, onToolCall } = options;
  const maxRounds = options.maxToolRounds ?? 8;
  const appended: Anthropic.MessageParam[] = [...(options.resume?.appended ?? [])];
  const usage: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let text = ''; let rounds = options.resume?.rounds ?? 0; let stop: TurnStop = 'other';
  let pending: PendingClientTools | null = null;
  const emit = (delta: string) => { text += delta; onText?.(delta); };
  for (;;) {
    const params: Anthropic.MessageStreamParams = {
      model, max_tokens: options.maxTokens ?? 4096,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [...options.messages, ...appended],
      output_config: { effort: options.effort ?? 'low' },
    };
    if (tools.length) { params.tools = tools; params.tool_choice = { type: 'auto' }; }
    const stream = client.messages.stream(params);
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') emit(event.delta.text);
    }
    const message = await stream.finalMessage();
    usage.inputTokens += message.usage.input_tokens; usage.outputTokens += message.usage.output_tokens;
    usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0; usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
    appended.push({ role: 'assistant', content: message.content });
    const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const reason = message.stop_reason;
    if (reason === 'refusal' || reason === 'max_tokens' || (reason !== 'tool_use' && toolUses.length === 0) || rounds >= maxRounds) {
      if (toolUses.length) {
        const note = reason === 'refusal' ? 'Not run: the turn was refused.' : reason === 'max_tokens' ? 'Not run: the reply was cut off at the token limit.' : 'Not run: the tool round limit for this turn was reached.';
        appended.push({ role: 'user', content: toolUses.map((t) => ({ type: 'tool_result' as const, tool_use_id: t.id, content: note, is_error: true })) });
      }
      if (reason === 'refusal') { stop = 'refusal'; if (!text.trim()) emit(REFUSAL_TEXT); }
      else if (reason === 'max_tokens') { stop = 'max_tokens'; emit(TRUNCATED_TEXT); }
      else if (toolUses.length) { stop = 'tool_rounds'; emit(ROUNDS_TEXT); }
      else stop = reason === 'end_turn' ? 'end_turn' : 'other';
      break;
    }
    rounds += 1;
    const results: Anthropic.ToolResultBlockParam[] = [];
    const clientCalls = toolUses.filter((t) => options.clientTools?.has(t.name));
    for (const use of toolUses) {
      if (options.clientTools?.has(use.name)) continue;
      const handler = handlers[use.name];
      let result: ToolResult;
      try {
        const raw = handler ? await handler(use.input) : { content: `Unknown tool "${use.name}".`, isError: true };
        result = typeof raw === 'string' ? { content: raw } : raw;
      } catch (error) {
        result = { content: `Tool failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
      onToolCall?.({ id: use.id, name: use.name, input: use.input, result });
      const block: Anthropic.ToolResultBlockParam = { type: 'tool_result', tool_use_id: use.id, content: result.content };
      if (result.isError) block.is_error = true;
      results.push(block);
    }
    if (clientCalls.length) {
      // The assistant message stays last in `appended`, exactly as streamed, so a resume replays it unchanged.
      pending = { calls: clientCalls.map((t) => ({ id: t.id, name: t.name, input: t.input })), results, order: toolUses.map((t) => t.id) };
      stop = 'client_tools';
      break;
    }
    appended.push({ role: 'user', content: results });
  }
  return { appended, text, usage, stop, rounds, pending };
}

/**
 * The user message that answers a suspended round: the server results kept in `pending` plus the browser's answers,
 * in the assistant's tool_use order. A call the browser did not answer gets an error result, so the transcript stays valid.
 */
export function answerPending(pending: PendingClientTools, answers: ReadonlyMap<string, ToolResult>): Anthropic.MessageParam {
  const byId = new Map(pending.results.map((r) => [r.tool_use_id, r]));
  for (const call of pending.calls) {
    const answer = answers.get(call.id) ?? { content: 'Not run: the editor did not return a result.', isError: true };
    const block: Anthropic.ToolResultBlockParam = { type: 'tool_result', tool_use_id: call.id, content: answer.content };
    if (answer.isError) block.is_error = true;
    byId.set(call.id, block);
  }
  return { role: 'user', content: pending.order.flatMap((id) => byId.get(id) ?? []) };
}

/** Plain text of a stored message, for the transcript the UI shows (tool blocks are hidden). */
export function messageText(message: Anthropic.MessageParam): string {
  if (typeof message.content === 'string') return message.content;
  let out = '';
  for (const block of message.content) if (block.type === 'text') out += block.text;
  return out;
}
