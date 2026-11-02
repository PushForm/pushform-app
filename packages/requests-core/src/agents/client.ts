// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/**
 * The slice of the SDK client `runTurn` uses, so tests inject scripted events and never reach the
 * network. Turns read the raw event stream: `runTurn` builds the message itself (see `readMessage`), because the SDK's
 * own message builder throws on a tool input that streamed as invalid JSON and drops the rest of the message.
 */
export interface AnthropicLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsStreaming, options?: { headers?: Record<string, string> }): PromiseLike<AsyncIterable<Anthropic.RawMessageStreamEvent>>;
  };
}
/** The slice of the SDK client `warmPrompt` uses: one non-streaming request. */
export interface WarmClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { headers?: Record<string, string> }): PromiseLike<Anthropic.Message> };
}

/**
 * With `log`, every API response is logged with its status, time to headers and retry count, so a request that waited
 * through a rate limit or overload retry shows up in the function logs instead of as unexplained model time.
 */
export function createAnthropic(apiKey: string, log?: (message: string) => void): Anthropic {
  if (!log) return new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  const line = (message: string) => log(`anthropic ${message}`);
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000, logLevel: 'info', logger: { error: line, warn: line, info: line, debug: () => {} } });
}

/** `images` (base64) follow the text in the tool result the model sees; only browser answers carry them. */
export interface ToolResult { content: string; isError?: boolean; images?: readonly { mime: string; data: string }[] | undefined }
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
 * Rewrite fixed-length tuples (`prefixItems`, which tool schemas reject) as plain arrays: one `items` schema, or an
 * `anyOf` when the positions differ. Length bounds stay for the caller to keep or strip; zod still checks the tuple.
 */
export function flattenTuples(node: unknown, propertyMap = false): unknown {
  if (Array.isArray(node)) return node.map((n) => flattenTuples(n));
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = flattenTuples(value, !propertyMap && key === 'properties');
  if (!propertyMap && Array.isArray(out['prefixItems'])) {
    const positions = out['prefixItems'] as unknown[];
    delete out['prefixItems'];
    const distinct = positions.filter((p, i) => positions.findIndex(q => JSON.stringify(q) === JSON.stringify(p)) === i);
    out['items'] = distinct.length === 1 ? distinct[0] : { anyOf: distinct };
  }
  return out;
}
/**
 * A tool definition for Haiku 5.5: strict schema from zod with `additionalProperties: false` and every key required.
 * `z.int()`, `.min()`, `.max()` and friends emit `minimum`/`maximum`/`maxLength`, which the API rejects on a strict
 * schema, so they are stripped here and enforced client-side by `withSchema`.
 */
export function defineTool<S extends z.ZodObject>(name: string, description: string, schema: S): Anthropic.Tool {
  const json = stripUnsupportedKeywords(flattenTuples(z.toJSONSchema(schema))) as Record<string, unknown>;
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
  const json = flattenTuples(z.toJSONSchema(schema)) as Record<string, unknown>;
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

/** `invalidInput`: the call's input streamed as invalid JSON; it holds the start of the raw input, for diagnosis. */
export interface ToolCallEvent { id: string; name: string; input: unknown; result: ToolResult; invalidInput?: string }
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
  /**
   * Stream the short notes the model writes between tool calls as visible text. Models that return those notes as
   * thinking blocks keep them empty unless asked, which leaves a multi-round turn silent until its final answer.
   * Ignored for models that do not support it (see `supportsProgressUpdates`).
   */
  progressUpdates?: boolean;
  /** Tools the browser runs: a round that calls any of them suspends the turn instead of running a handler. */
  clientTools?: ReadonlySet<string> | undefined;
  /**
   * Answer a browser tool call here instead of sending it to the browser (a call past a limit, say): a result is
   * treated as a server tool's; null sends the call on as usual.
   */
  interceptClientCall?: ((call: ClientToolCall) => ToolResult | null) | undefined;
  /**
   * Resume a suspended turn: `appended` is everything the turn appended so far, unchanged (thinking blocks included),
   * ending with the user message that answers the suspended round; `rounds` counts the rounds already used.
   */
  resume?: { appended: Anthropic.MessageParam[]; rounds: number } | undefined;
}
/** Timing and token use of one model request, for the per-turn latency log. */
export interface RoundStat {
  /** Until the response started (message_start): queueing, retries and prompt reading. */
  startMs: number;
  /** Until the first content arrived (thinking, text or a tool call), or null when none did. */
  firstMs: number | null;
  ms: number; input: number; output: number; cacheRead: number; cacheWrite: number;
}
export interface RunTurnResult { appended: Anthropic.MessageParam[]; text: string; usage: TurnUsage; stop: TurnStop; rounds: number; pending: PendingClientTools | null; roundStats: RoundStat[] }


/** The beta that returns between-tool progress notes as thinking text while reasoning stays hidden. */
export const PROGRESS_UPDATES_BETA = 'thinking-display-updates-2026-08-18';
/** Models that write between-tool notes as thinking blocks and accept the progress-update display. */
export function supportsProgressUpdates(model: string): boolean { return /^claude-(sonnet-5-5|opus-5-5|fable-5|mythos-5)/.test(model); }

export const REFUSAL_TEXT = 'I cannot help with that in this conversation.';
export const TRUNCATED_TEXT = '\n\n(My reply was cut short. Ask me to continue.)';
export const ROUNDS_TEXT = '\n\n(I stopped looking things up for this turn. Ask me to continue.)';

/** What decides a turn's cached prefix besides its messages: the same for a turn and for its warm-up. */
export interface TurnPrompt { model: string; system: string; tools: Anthropic.Tool[]; effort?: 'low' | 'medium' | 'high' | undefined; progress?: boolean | undefined }
/**
 * The request of one model round. Tools, system prompt, `tool_choice`, effort and thinking all shape the cached prefix,
 * so turns and `warmPrompt` both build their requests here.
 */
export function turnRequest(p: TurnPrompt & { messages: Anthropic.MessageParam[]; maxTokens?: number | undefined }): { params: Anthropic.MessageStreamParams; headers: Record<string, string> | undefined } {
  const params: Anthropic.MessageStreamParams = {
    model: p.model, max_tokens: p.maxTokens ?? 4096,
    // The tools and system prompt are the same for every requester with the same open document; an hour keeps them
    // warm between conversations, and every read restarts the hour.
    system: [{ type: 'text', text: p.system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: p.messages,
    // A rolling breakpoint on the last block: the next round, and the request that resumes the turn after the editor
    // answers, read the whole transcript so far from the prompt cache instead of the model reading it again.
    cache_control: { type: 'ephemeral' },
    output_config: { effort: p.effort ?? 'low' },
  };
  if (p.tools.length) { params.tools = p.tools; params.tool_choice = { type: 'auto' }; }
  // `updates` is a beta display value the stable parameter type does not list yet.
  if (p.progress) params.thinking = { type: 'adaptive', display: 'updates' } as unknown as Anthropic.ThinkingConfigParam;
  return { params, headers: p.progress ? { 'anthropic-beta': PROGRESS_UPDATES_BETA } : undefined };
}

/** What a warm-up wrote to (or read from) the prompt cache. */
export interface WarmUsage { cacheWrite: number; cacheRead: number; input: number }
/**
 * Write a turn's tools and system prompt to the prompt cache before anyone asks, so the first message of a
 * conversation reads them instead of waiting for them to be processed. `max_tokens: 0` runs only the prompt: no
 * output is generated or billed. The breakpoint stays on the system prompt only (no rolling breakpoint), so nothing
 * is cached for the placeholder message. On an entry that is already warm this is a cheap read that restarts its hour.
 */
export async function warmPrompt(client: WarmClient, prompt: TurnPrompt): Promise<WarmUsage> {
  const { params, headers } = turnRequest({ ...prompt, messages: [{ role: 'user', content: 'warmup' }], maxTokens: 0 });
  const { cache_control: _rolling, stream: _stream, ...rest } = params as Anthropic.MessageStreamParams & { stream?: unknown };
  const message = await client.messages.create({ ...rest, stream: false } as Anthropic.MessageCreateParamsNonStreaming, headers ? { headers } : undefined);
  return { cacheWrite: message.usage.cache_creation_input_tokens ?? 0, cacheRead: message.usage.cache_read_input_tokens ?? 0, input: message.usage.input_tokens };
}

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
  const roundStats: RoundStat[] = [];
  const emit = (delta: string) => { text += delta; onText?.(delta); };
  const progress = options.progressUpdates === true && supportsProgressUpdates(model);
  for (;;) {
    const { params, headers } = turnRequest({ model, system, tools, messages: [...options.messages, ...appended], effort: options.effort, maxTokens: options.maxTokens, progress });
    const roundStarted = performance.now();
    let startMs: number | null = null, firstMs: number | null = null;
    // Each visible block (a progress note or reply text) starts a new paragraph after text already shown.
    let blockStarted = false;
    const visible = (delta: string) => {
      if (!delta) return;
      if (!blockStarted) { blockStarted = true; if (text && !text.endsWith('\n\n')) emit(text.endsWith('\n') ? '\n' : '\n\n'); }
      emit(delta);
    };
    const events = await client.messages.create({ ...params, stream: true } as Anthropic.MessageCreateParamsStreaming, headers ? { headers } : undefined);
    const { message, invalid } = await readMessage(events, (event) => {
      if (event.type === 'message_start') startMs ??= Math.round(performance.now() - roundStarted);
      else if (event.type === 'content_block_delta' || event.type === 'content_block_start') firstMs ??= Math.round(performance.now() - roundStarted);
      if (event.type === 'content_block_start') blockStarted = false;
      else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') visible(event.delta.text);
      else if (progress && event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') visible(event.delta.thinking);
    });
    usage.inputTokens += message.usage.input_tokens; usage.outputTokens += message.usage.output_tokens;
    usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0; usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
    roundStats.push({ startMs: startMs ?? 0, firstMs, ms: Math.round(performance.now() - roundStarted), input: message.usage.input_tokens, output: message.usage.output_tokens,
      cacheRead: message.usage.cache_read_input_tokens ?? 0, cacheWrite: message.usage.cache_creation_input_tokens ?? 0 });
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
    const clientCalls: Anthropic.ToolUseBlock[] = [];
    for (const use of toolUses) {
      const bad = invalid.get(use.id);
      if (bad) {
        // Never run, on the server or in the browser: the model gets the parse error and sends the call again.
        const result: ToolResult = { content: `Not run: the tool input was not valid JSON (${bad.error}). Send the call again with valid JSON.`, isError: true };
        onToolCall?.({ id: use.id, name: use.name, input: use.input, result, invalidInput: bad.raw.slice(0, INVALID_INPUT_LOG_CHARS) });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: result.content, is_error: true });
        continue;
      }
      let result: ToolResult;
      if (options.clientTools?.has(use.name)) {
        const intercepted = options.interceptClientCall?.({ id: use.id, name: use.name, input: use.input }) ?? null;
        if (!intercepted) { clientCalls.push(use); continue; }
        result = intercepted;
      } else {
        const handler = handlers[use.name];
        try {
          const raw = handler ? await handler(use.input) : { content: `Unknown tool "${use.name}".`, isError: true };
          result = typeof raw === 'string' ? { content: raw } : raw;
        } catch (error) {
          result = { content: `Tool failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
        }
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
  return { appended, text, usage, stop, rounds, pending, roundStats };
}

/** How much of an invalid tool input `onToolCall` reports. */
const INVALID_INPUT_LOG_CHARS = 2000;
/** A tool call whose input streamed as invalid JSON: `raw` is the input as streamed, `error` the parser's message. */
export interface InvalidToolInput { raw: string; error: string }

function parseToolInput(raw: string): { input: Record<string, unknown> } | { error: string } {
  if (!raw.trim()) return { input: {} };
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return { input: value as Record<string, unknown> };
    return { error: 'the input is not a JSON object' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Build the assistant message from raw stream events, calling `onEvent` for each as it arrives. Tool inputs stream as
 * they are generated (`eager_input_streaming`), so one can arrive as invalid JSON. Each input is parsed once, when its
 * block ends; an invalid one is kept in the message with an empty input and reported in `invalid` by tool_use id, so
 * the rest of the message (other calls, the stop reason, usage) is still read.
 */
export async function readMessage(events: AsyncIterable<Anthropic.RawMessageStreamEvent>, onEvent?: (event: Anthropic.RawMessageStreamEvent) => void): Promise<{ message: Anthropic.Message; invalid: Map<string, InvalidToolInput> }> {
  let message: Anthropic.Message | null = null;
  let stopped = false;
  const buffers = new Map<number, string>();
  const invalid = new Map<string, InvalidToolInput>();
  const finish = (index: number) => {
    const block = message?.content[index]; const raw = buffers.get(index);
    if (raw === undefined || !block || (block.type !== 'tool_use' && block.type !== 'server_tool_use')) return;
    buffers.delete(index);
    const parsed = parseToolInput(raw);
    if ('input' in parsed) block.input = parsed.input;
    else { block.input = {}; invalid.set(block.id, { raw, error: parsed.error }); }
  };
  for await (const event of events) {
    onEvent?.(event);
    switch (event.type) {
      case 'message_start':
        message = { ...event.message, content: [], usage: { ...event.message.usage } };
        break;
      case 'content_block_start':
        if (!message) break;
        message.content[event.index] = { ...event.content_block };
        if (event.content_block.type === 'tool_use' || event.content_block.type === 'server_tool_use') buffers.set(event.index, '');
        break;
      case 'content_block_delta': {
        const block = message?.content[event.index];
        if (!block) break;
        const delta = event.delta;
        if (delta.type === 'text_delta' && block.type === 'text') block.text += delta.text;
        else if (delta.type === 'citations_delta' && block.type === 'text') block.citations = [...(block.citations ?? []), delta.citation];
        else if (delta.type === 'thinking_delta' && block.type === 'thinking') block.thinking += delta.thinking;
        else if (delta.type === 'signature_delta' && block.type === 'thinking') block.signature = delta.signature;
        else if (delta.type === 'input_json_delta' && buffers.has(event.index)) buffers.set(event.index, buffers.get(event.index)! + delta.partial_json);
        break;
      }
      case 'content_block_stop':
        finish(event.index);
        break;
      case 'message_delta': {
        if (!message) break;
        message.stop_reason = event.delta.stop_reason; message.stop_sequence = event.delta.stop_sequence; message.stop_details = event.delta.stop_details;
        if (event.delta.container != null) message.container = event.delta.container;
        // Output tokens are always sent; the other counters are whole-message totals, sent only when they apply.
        const u = event.usage; message.usage.output_tokens = u.output_tokens;
        if (u.input_tokens != null) message.usage.input_tokens = u.input_tokens;
        if (u.cache_creation_input_tokens != null) message.usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
        if (u.cache_read_input_tokens != null) message.usage.cache_read_input_tokens = u.cache_read_input_tokens;
        if (u.server_tool_use != null) message.usage.server_tool_use = u.server_tool_use;
        break;
      }
      case 'message_stop':
        stopped = true;
        break;
    }
  }
  if (!message || !stopped) throw new Error('The model stream ended before the message was complete.');
  for (const index of [...buffers.keys()]) finish(index);
  return { message, invalid };
}

/**
 * The user message that answers a suspended round: the server results kept in `pending` plus the browser's answers,
 * in the assistant's tool_use order. A call the browser did not answer gets an error result, so the transcript stays valid.
 */
export function answerPending(pending: PendingClientTools, answers: ReadonlyMap<string, ToolResult>): Anthropic.MessageParam {
  const byId = new Map(pending.results.map((r) => [r.tool_use_id, r]));
  for (const call of pending.calls) {
    const answer = answers.get(call.id) ?? { content: 'Not run: the editor did not return a result.', isError: true };
    // Pictures follow the text as image blocks, in the order the browser returned them.
    const content: Anthropic.ToolResultBlockParam['content'] = answer.images?.length
      ? [{ type: 'text', text: answer.content }, ...answer.images.map(image => ({ type: 'image' as const,
        source: { type: 'base64' as const, media_type: image.mime as 'image/jpeg' | 'image/png', data: image.data } }))]
      : answer.content;
    const block: Anthropic.ToolResultBlockParam = { type: 'tool_result', tool_use_id: call.id, content };
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
