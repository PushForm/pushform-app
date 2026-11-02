// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type Anthropic from '@anthropic-ai/sdk';
import type { AnthropicLike } from './client.ts';

/** One scripted assistant message: text deltas, tool calls and how the message stopped. */
export interface ScriptedTurn {
  /** Thinking deltas streamed before the text, as a progress note (or empty reasoning) arrives. */
  thinking?: string[];
  text?: string[];
  /** `raw`: the input as streamed, in chunks, instead of `input` serialized (to script invalid JSON). */
  toolUses?: { id: string; name: string; input: unknown; raw?: string[] }[];
  stopReason?: Anthropic.StopReason;
  usage?: Partial<Anthropic.Usage>;
}
export interface FakeAnthropic extends AnthropicLike { calls: Anthropic.MessageCreateParamsStreaming[]; headers: (Record<string, string> | undefined)[] }

/** A client whose `messages.create` stream yields the scripted events in order, so tool loops are tested without the network. */
export function fakeAnthropic(turns: ScriptedTurn[]): FakeAnthropic {
  const queue = [...turns];
  const calls: Anthropic.MessageCreateParamsStreaming[] = [];
  const headers: (Record<string, string> | undefined)[] = [];
  return {
    calls,
    headers,
    messages: {
      async create(params, options) {
        calls.push(params); headers.push(options?.headers);
        const turn = queue.shift();
        if (!turn) throw new Error('fakeAnthropic: no scripted turn left');
        return scriptedStream(turn);
      },
    },
  };
}
function scriptedStream(turn: ScriptedTurn): AsyncIterable<Anthropic.RawMessageStreamEvent> {
  const content: Anthropic.ContentBlock[] = [];
  const text = (turn.text ?? []).join('');
  if (turn.thinking) content.push({ type: 'thinking', thinking: turn.thinking.join(''), signature: 'sig' });
  if (turn.text?.length) content.push({ type: 'text', text, citations: null });
  for (const t of turn.toolUses ?? []) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input, caller: { type: 'direct' } });
  const stopReason: Anthropic.StopReason = turn.stopReason ?? (turn.toolUses?.length ? 'tool_use' : 'end_turn');
  const usage: Anthropic.Usage = {
    input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null,
    server_tool_use: null, service_tier: null, inference_geo: null, speed: null, iterations: null, ...turn.usage,
  } as Anthropic.Usage;
  const message: Anthropic.Message = {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', content, stop_reason: stopReason, stop_sequence: null, usage,
    stop_details: stopReason === 'refusal' ? { type: 'refusal', category: null, explanation: 'scripted' } : null,
  } as Anthropic.Message;
  const events: Anthropic.MessageStreamEvent[] = [];
  events.push({ type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  let index = 0;
  if (turn.thinking) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    for (const d of turn.thinking) events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: d } });
    events.push({ type: 'content_block_stop', index }); index += 1;
  }
  if (turn.text?.length) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } });
    for (const d of turn.text) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: d } });
    events.push({ type: 'content_block_stop', index }); index += 1;
  }
  for (const t of turn.toolUses ?? []) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: t.id, name: t.name, input: {}, caller: { type: 'direct' } } });
    for (const chunk of t.raw ?? [JSON.stringify(t.input)]) events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: chunk } });
    events.push({ type: 'content_block_stop', index }); index += 1;
  }
  events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null, stop_details: message.stop_details, container: null, context_management: null }, usage: { output_tokens: usage.output_tokens, input_tokens: usage.input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, server_tool_use: null, output_tokens_details: null } } as Anthropic.MessageStreamEvent);
  events.push({ type: 'message_stop' });
  return { async *[Symbol.asyncIterator]() { for (const e of events) yield e; } };
}
