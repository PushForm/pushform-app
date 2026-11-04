// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { chatCompletionsClient, routeModels, toChatCompletions } from './chatCompletions.ts';
import type { AnthropicLike } from './client.ts';

const sse = (lines: unknown[]) => new Response(new ReadableStream({ start(c) {
  for (const l of lines) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(l)}\n\n`));
  c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close();
} }));

describe('chat completions client', () => {
  it('translates system, text, tool calls, tool results and pictures', () => {
    const body = toChatCompletions({ model: 'mercury-3', max_tokens: 100, stream: true, system: [{ type: 'text', text: 'Be brief.' }],
      tools: [{ name: 'search', description: 'Search the help', input_schema: { type: 'object', properties: {} } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'How do I drill a hole?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search', input: { q: 'hole' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Use Subtract.' }] },
      ] } as Anthropic.MessageCreateParamsStreaming, 'mercury-3') as { messages: unknown[]; tools: unknown[] };
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'How do I drill a hole?\n\n[A picture was attached here; this assistant cannot see pictures.]' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"hole"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'Use Subtract.' },
    ]);
    expect(body.tools).toHaveLength(1);
  });

  it('streams text and complete tool calls back as message events', async () => {
    const client = chatCompletionsClient({ baseURL: 'http://x', apiKey: 'k', fetch: async () => sse([
      { choices: [{ delta: { content: 'Look' } }] }, { choices: [{ delta: { content: 'ing.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '{"q":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hole"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 40 } } },
    ]) });
    const events = [];
    for await (const e of await client.messages.create({ model: 'mercury-3', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] })) events.push(e);
    expect(events.map((e) => e.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(events.find((e) => e.type === 'message_delta')).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9, input_tokens: 60, cache_read_input_tokens: 40 } });
    expect(events[6]).toMatchObject({ delta: { type: 'input_json_delta', partial_json: '{"q":"hole"}' } });
  });

  it('routes by model prefix and strips it', async () => {
    const seen: string[] = [];
    const fake = (name: string): AnthropicLike => ({ messages: { async create(p) { seen.push(`${name}:${p.model}`); return (async function* () {})(); } } });
    const router = routeModels(fake('anthropic'), { 'inception/': fake('inception') });
    await router.messages.create({ model: 'inception/mercury-3', max_tokens: 1, stream: true, messages: [] });
    await router.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 1, stream: true, messages: [] });
    expect(seen).toEqual(['inception:mercury-3', 'anthropic:claude-sonnet-5-5']);
  });
});
