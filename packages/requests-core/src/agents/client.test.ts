// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { REFUSAL_TEXT, ROUNDS_TEXT, TRUNCATED_TEXT, answerPending, defineLooseTool, defineTool, messageText, runTurn, stripUnsupportedKeywords, withSchema } from './client.ts';
import { fakeAnthropic } from './fakeAnthropic.ts';

const echoTool = defineTool('echo', 'Echo the input.', z.object({ value: z.string() }));
const user = (text: string): Anthropic.MessageParam => ({ role: 'user', content: text });

describe('defineTool and withSchema', () => {
  it('produces a strict schema with additionalProperties false and all keys required', () => {
    const tool = defineTool('t', 'd', z.object({ a: z.string(), b: z.number().nullable() }));
    expect(tool.strict).toBe(true);
    expect(tool.input_schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['a', 'b'] });
    expect(tool.input_schema).not.toHaveProperty('$schema');
  });
  it('strips numerical, string and array constraints strict schemas reject, keeping them for client-side validation', () => {
    const schema = z.object({ index: z.number().int().min(1), count: z.number().int().nullable(), text: z.string().max(4000), items: z.array(z.string().max(10)).max(5), minimum: z.string() });
    const tool = defineTool('t', 'd', schema);
    expect(JSON.stringify(tool.input_schema)).not.toMatch(/"(minimum|maximum|maxLength|minLength|maxItems|multipleOf)":-?\d/);
    const props = (tool.input_schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props['index']).toEqual({ type: 'integer' }); expect(props['text']).toEqual({ type: 'string' });
    expect(props['items']).toEqual({ type: 'array', items: { type: 'string' } });
    expect(props['minimum']).toEqual({ type: 'string' }); // a property named like a keyword survives
    expect(stripUnsupportedKeywords({ anyOf: [{ type: 'number', minimum: 1 }, { type: 'null' }] })).toEqual({ anyOf: [{ type: 'number' }, { type: 'null' }] });
    const h = withSchema(schema, (v) => String(v.index));
    expect(h({ index: 0, count: null, text: 'x', items: [], minimum: '' })).toMatchObject({ isError: true });
  });
  it('returns an error result for invalid input instead of throwing', async () => {
    const h = withSchema(z.object({ a: z.string() }), ({ a }) => a.toUpperCase());
    expect(await h({ a: 'x' })).toBe('X');
    expect(await h({ a: 1 })).toMatchObject({ isError: true });
  });
});

describe('runTurn', () => {
  it('streams text, runs tools, answers them in one user message and loops until end_turn', async () => {
    const client = fakeAnthropic([
      { text: ['Let me ', 'check.'], toolUses: [{ id: 'tu1', name: 'echo', input: { value: 'a' } }, { id: 'tu2', name: 'echo', input: { value: 'b' } }] },
      { text: ['Done.'] },
    ]);
    const deltas: string[] = []; const calls: string[] = [];
    const r = await runTurn({
      client, model: 'claude-haiku-5-5', system: 'sys', tools: [echoTool], messages: [user('hi')],
      handlers: { echo: withSchema(z.object({ value: z.string() }), ({ value }) => `echo:${value}`) },
      onText: (d) => deltas.push(d), onToolCall: (c) => calls.push(`${c.name}:${c.result.content}`),
    });
    expect(deltas).toEqual(['Let me ', 'check.', 'Done.']);
    expect(r.text).toBe('Let me check.Done.');
    expect(r.stop).toBe('end_turn'); expect(r.rounds).toBe(1);
    expect(calls).toEqual(['echo:echo:a', 'echo:echo:b']);
    expect(r.appended.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
    const results = r.appended[1]?.content as Anthropic.ToolResultBlockParam[];
    expect(results.map((b) => b.tool_use_id)).toEqual(['tu1', 'tu2']);
    expect(results[0]?.is_error).toBeUndefined();
    expect(r.usage.inputTokens).toBe(200);
    // Second request carries the whole history
    expect(client.calls[1]?.messages).toHaveLength(3);
  });
  it('sends Haiku 5.5 settings: cached system block, effort low, tool_choice auto, no thinking parameter', async () => {
    const client = fakeAnthropic([{ text: ['ok'] }]);
    await runTurn({ client, model: 'claude-haiku-5-5', system: 'stable', tools: [echoTool], handlers: {}, messages: [user('hi')] });
    const p = client.calls[0]!;
    expect(p.system).toEqual([{ type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } }]);
    expect(p.output_config).toEqual({ effort: 'low' });
    expect(p.tool_choice).toEqual({ type: 'auto' });
    expect(p).not.toHaveProperty('thinking');
    expect(p.tools?.[0]).toMatchObject({ strict: true });
  });
  it('omits tools and tool_choice when the agent has none', async () => {
    const client = fakeAnthropic([{ text: ['ok'] }]);
    await runTurn({ client, model: 'm', system: 's', tools: [], handlers: {}, messages: [user('hi')] });
    expect(client.calls[0]).not.toHaveProperty('tools'); expect(client.calls[0]).not.toHaveProperty('tool_choice');
  });
  it('reports unknown tools and handler exceptions as error results', async () => {
    const client = fakeAnthropic([{ toolUses: [{ id: 'a', name: 'nope', input: {} }, { id: 'b', name: 'boom', input: {} }] }, { text: ['fine'] }]);
    const r = await runTurn({ client, model: 'm', system: 's', tools: [echoTool], messages: [user('hi')], handlers: { boom: () => { throw new Error('kaput'); } } });
    const results = r.appended[1]?.content as Anthropic.ToolResultBlockParam[];
    expect(results[0]).toMatchObject({ is_error: true, content: 'Unknown tool "nope".' });
    expect(results[1]).toMatchObject({ is_error: true, content: 'Tool failed: kaput' });
    expect(r.stop).toBe('end_turn');
  });
  it('does not run tools after max_tokens; answers them with errors and notes the cut', async () => {
    let ran = 0;
    const client = fakeAnthropic([{ text: ['partial'], toolUses: [{ id: 'a', name: 'echo', input: { value: 'x' } }], stopReason: 'max_tokens' }]);
    const r = await runTurn({ client, model: 'm', system: 's', tools: [echoTool], messages: [user('hi')], handlers: { echo: () => { ran += 1; return 'no'; } } });
    expect(ran).toBe(0); expect(r.stop).toBe('max_tokens'); expect(r.text).toBe(`partial${TRUNCATED_TEXT}`);
    expect((r.appended[1]?.content as Anthropic.ToolResultBlockParam[])[0]).toMatchObject({ is_error: true, tool_use_id: 'a' });
    expect(client.calls).toHaveLength(1);
  });
  it('ends a refusal with a fallback sentence and runs nothing', async () => {
    const client = fakeAnthropic([{ stopReason: 'refusal' }]);
    const r = await runTurn({ client, model: 'm', system: 's', tools: [echoTool], messages: [user('hi')], handlers: {} });
    expect(r.stop).toBe('refusal'); expect(r.text).toBe(REFUSAL_TEXT); expect(r.appended).toHaveLength(1);
  });
  it('stops after maxToolRounds and answers the pending tool calls', async () => {
    const client = fakeAnthropic([
      { toolUses: [{ id: '1', name: 'echo', input: { value: 'a' } }] },
      { toolUses: [{ id: '2', name: 'echo', input: { value: 'b' } }] },
      { toolUses: [{ id: '3', name: 'echo', input: { value: 'c' } }] },
    ]);
    const r = await runTurn({ client, model: 'm', system: 's', tools: [echoTool], messages: [user('hi')], handlers: { echo: () => 'ok' }, maxToolRounds: 2 });
    expect(r.rounds).toBe(2); expect(r.stop).toBe('tool_rounds'); expect(r.text).toBe(ROUNDS_TEXT);
    expect(client.calls).toHaveLength(3);
    expect((r.appended.at(-1)?.content as Anthropic.ToolResultBlockParam[])[0]).toMatchObject({ tool_use_id: '3', is_error: true });
  });
  it('extracts the visible text of stored messages', () => {
    expect(messageText({ role: 'user', content: 'plain' })).toBe('plain');
    expect(messageText({ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'x', name: 'n', input: {} }, { type: 'text', text: 'b' }] })).toBe('ab');
  });
});

describe('client tools', () => {
  const echo = { echo: withSchema(z.object({ value: z.string() }), ({ value }) => `echo:${value}`) };
  const editTool = defineLooseTool('edit', 'Edit the document.', z.object({ ops: z.array(z.string()).min(1) }));
  it('declares a loose tool with its full schema, constraints included, streaming its input', () => {
    expect(editTool.strict).toBeUndefined();
    expect(editTool.eager_input_streaming).toBe(true);
    expect(editTool.input_schema).toMatchObject({ type: 'object', properties: { ops: { type: 'array', minItems: 1 } } });
    expect(editTool.input_schema).not.toHaveProperty('$schema');
  });
  it('suspends on a round that calls a client tool, running only the server tools of that round', async () => {
    const client = fakeAnthropic([{ text: ['Adding it.'], toolUses: [{ id: 's1', name: 'echo', input: { value: 'a' } }, { id: 'c1', name: 'edit', input: { ops: ['x'] } }] }]);
    const calls: string[] = [];
    const r = await runTurn({ client, model: 'm', system: 's', tools: [echoTool, editTool], messages: [user('hi')], handlers: echo, clientTools: new Set(['edit']), onToolCall: (c) => calls.push(c.name) });
    expect(r.stop).toBe('client_tools');
    expect(r.rounds).toBe(1);
    expect(r.text).toBe('Adding it.');
    expect(calls).toEqual(['echo']);
    expect(r.appended.map((m) => m.role)).toEqual(['assistant']);
    expect(r.pending).toEqual({ calls: [{ id: 'c1', name: 'edit', input: { ops: ['x'] } }], results: [{ type: 'tool_result', tool_use_id: 's1', content: 'echo:a' }], order: ['s1', 'c1'] });
  });
  it('answers a suspended round in tool_use order, with an error for a call the editor did not answer', () => {
    const pending = { calls: [{ id: 'c1', name: 'edit', input: {} }, { id: 'c2', name: 'edit', input: {} }], results: [{ type: 'tool_result' as const, tool_use_id: 's1', content: 'ok' }], order: ['c1', 's1', 'c2'] };
    const answer = answerPending(pending, new Map([['c1', { content: 'done', isError: false }]]));
    expect(answer).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'c1', content: 'done' },
      { type: 'tool_result', tool_use_id: 's1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'c2', content: 'Not run: the editor did not return a result.', is_error: true },
    ] });
  });
  it('resumes with the appended messages of the turn unchanged and keeps counting rounds', async () => {
    const first = await runTurn({ client: fakeAnthropic([{ toolUses: [{ id: 'c1', name: 'edit', input: { ops: ['x'] } }] }]), model: 'm', system: 's', tools: [editTool], messages: [user('hi')], handlers: {}, clientTools: new Set(['edit']) });
    const client = fakeAnthropic([{ text: ['Done.'] }]);
    const answer = answerPending(first.pending!, new Map([['c1', { content: '{"ok":true}', isError: false }]]));
    const r = await runTurn({ client, model: 'm', system: 's', tools: [editTool], messages: [user('hi')], handlers: {}, clientTools: new Set(['edit']), resume: { appended: [...first.appended, answer], rounds: first.rounds }, maxToolRounds: 1 });
    expect(r.stop).toBe('end_turn');
    expect(r.text).toBe('Done.');
    expect(r.rounds).toBe(1);
    expect(client.calls[0]!.messages).toEqual([user('hi'), ...first.appended, answer]);
    expect(r.appended.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
  });
});
