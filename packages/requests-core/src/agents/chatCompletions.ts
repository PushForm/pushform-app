// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type Anthropic from '@anthropic-ai/sdk';
import type { AnthropicLike } from './client.ts';

/**
 * A model client for providers that offer only an OpenAI-style chat completions API. It accepts the same streaming
 * Messages requests the turn loop sends and turns the provider's streamed reply back into Messages stream events, so
 * the rest of the backend works unchanged. Text streams through as it arrives; tool calls are emitted once complete.
 * Pictures are replaced by a short note: these models read text only.
 */
export interface ChatCompletionsOptions { baseURL: string; apiKey: string; fetch?: typeof fetch }

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

const PICTURE_NOTE = '[A picture was attached here; this assistant cannot see pictures.]';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c: { type?: string; text?: string }) => (c.type === 'text' ? c.text ?? '' : c.type === 'image' ? PICTURE_NOTE : '')).filter(Boolean).join('\n');
}

/** A Messages request as a chat completions body. */
export function toChatCompletions(params: Anthropic.MessageCreateParamsStreaming, model: string): Record<string, unknown> {
  const system = typeof params.system === 'string' ? params.system : (params.system ?? []).map((b) => b.text).join('\n\n');
  const messages: ChatMessage[] = system ? [{ role: 'system', content: system }] : [];
  for (const m of params.messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content } as Anthropic.TextBlockParam] : m.content;
    if (m.role === 'assistant') {
      const text = blocks.filter((b): b is Anthropic.TextBlockParam => b.type === 'text').map((b) => b.text).join('');
      const calls = blocks.filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const content = textOf(b.content);
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${content}` : content });
      }
    }
    const rest = blocks.filter((b) => b.type !== 'tool_result').map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? PICTURE_NOTE : '')).filter(Boolean);
    if (rest.length) messages.push({ role: 'user', content: rest.join('\n\n') });
  }
  const tools = (params.tools ?? []).filter((t): t is Anthropic.Tool => 'input_schema' in t)
    .map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema } }));
  return { model, messages, max_tokens: params.max_tokens, stream: true, stream_options: { include_usage: true }, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) };
}

const STOP: Record<string, Anthropic.StopReason> = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

interface Chunk {
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
}

/** Messages stream events from a chat completions server-sent event stream. */
export async function* messageEvents(body: ReadableStream<Uint8Array>, model: string): AsyncGenerator<Anthropic.RawMessageStreamEvent> {
  yield { type: 'message_start', message: { id: 'msg_chat', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } as unknown as Anthropic.RawMessageStreamEvent;
  let index = 0, textOpen = false, finish: string | null = null;
  let usage: Chunk['usage'] = undefined;
  const calls = new Map<number, { id?: string; name: string; args: string }>();
  const slots = new Map<number, number>();
  let nextKey = 1_000;
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk: Chunk;
      try { chunk = JSON.parse(data) as Chunk; } catch { continue; }
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.delta?.content) {
        if (!textOpen) { yield { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } } as Anthropic.RawMessageStreamEvent; textOpen = true; }
        yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: choice.delta.content } } as Anthropic.RawMessageStreamEvent;
      }
      for (const tc of choice.delta?.tool_calls ?? []) {
        // Some providers stream several calls under one index: a new id always starts a new call.
        let key = slots.get(tc.index) ?? tc.index;
        const current = calls.get(key);
        if (tc.id && current?.id && current.id !== tc.id) { key = nextKey++; slots.set(tc.index, key); }
        const c = calls.get(key) ?? { name: '', args: '' };
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
        calls.set(key, c);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (done) break;
  }
  if (textOpen) { yield { type: 'content_block_stop', index } as Anthropic.RawMessageStreamEvent; index++; }
  for (const key of [...calls.keys()].sort((a, b) => a - b)) {
    const c = calls.get(key)!;
    yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: c.id ?? `call_${index}`, name: c.name, input: {} } } as Anthropic.RawMessageStreamEvent;
    yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: c.args || '{}' } } as Anthropic.RawMessageStreamEvent;
    yield { type: 'content_block_stop', index } as Anthropic.RawMessageStreamEvent;
    index++;
  }
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  yield { type: 'message_delta', delta: { stop_reason: calls.size ? 'tool_use' : (STOP[finish ?? ''] ?? 'end_turn'), stop_sequence: null },
    usage: { output_tokens: usage?.completion_tokens ?? 0, input_tokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached), cache_read_input_tokens: cached, cache_creation_input_tokens: 0 } } as unknown as Anthropic.RawMessageStreamEvent;
  yield { type: 'message_stop' } as Anthropic.RawMessageStreamEvent;
}

/** An `AnthropicLike` over a chat completions endpoint. */
export function chatCompletionsClient(options: ChatCompletionsOptions): AnthropicLike {
  const send = options.fetch ?? fetch;
  return { messages: {
    async create(params) {
      const response = await send(`${options.baseURL}/chat/completions`, { method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(toChatCompletions(params, params.model)) });
      if (!response.ok || !response.body) throw new Error(`Model provider answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
      return messageEvents(response.body, params.model);
    },
  } };
}

/**
 * Sends each request to the client registered for its model's prefix (`inception/mercury-3` goes to the `inception/`
 * client as `mercury-3`); any other model goes to `primary`.
 */
export function routeModels(primary: AnthropicLike, routes: Readonly<Record<string, AnthropicLike>>): AnthropicLike {
  return { messages: {
    create(params, options) {
      const prefix = Object.keys(routes).find((p) => params.model.startsWith(p));
      return prefix ? routes[prefix]!.messages.create({ ...params, model: params.model.slice(prefix.length) }, options) : primary.messages.create(params, options);
    },
  } };
}
