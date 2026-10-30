// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { FeatureBrief, ProblemReport } from './brief.ts';
import { runTurn } from './client.ts';
import { fakeAnthropic } from './fakeAnthropic.ts';
import { openAgent, openTools } from './open.ts';
import { MemoryConversationStore, frameRequesterText, type AgentContext } from './store.ts';

function ctx(over: Partial<AgentContext> = {}): AgentContext {
  return {
    host: 'pushform', accountEmail: 'a@b.io', roles: ['user'], filingAllowed: true,
    screen: { editor: 'model', documentType: 'model', browser: 'Chrome 141', os: 'macOS 15' }, build: { version: '0.3.0', commit: 'abc123' },
    now: '2026-10-24T10:00:00Z', path: 'open', brief: null, title: null, messageCount: 1, openRequests: [], openRequestCount: 0,
    limits: { openRequestsPerAccount: 5, messagesPerConversation: 30 }, openIssues: [],
    digest: [{ path: 'docs/help/modeling.md', heading: 'Inference locking', anchor: 'inference-locking', text: 'Holding Shift locks the current inference direction.' }],
    ...over,
  };
}
const names = (tools: Anthropic.Tool[]) => tools.map((t) => t.name);
const msgs = (text: string): Anthropic.MessageParam[] => [{ role: 'user', content: `${openAgent.context(ctx())}\n\n${frameRequesterText(text)}` }];
const results = (r: { appended: Anthropic.MessageParam[] }, round = 1): string[] => (r.appended[round]?.content as Anthropic.ToolResultBlockParam[]).map((b) => String(b.content));
const turn = (store: MemoryConversationStore, client: ReturnType<typeof fakeAnthropic>, text: string) => {
  const c = ctx();
  return runTurn({ client, model: 'm', system: openAgent.system(c), tools: openAgent.tools(c), handlers: openAgent.handlers(c, store), messages: msgs(text) });
};

describe('open agent (a typed first message settles the path)', () => {
  it('offers the three-way switch_path plus the brief tools, and the prompt says the path is not chosen yet', () => {
    const c = ctx();
    const tools = names(openTools(c));
    expect(tools).toContain('switch_path'); expect(tools).toContain('search_docs'); expect(tools).toContain('update_brief'); expect(tools).toContain('start_over'); expect(tools).not.toContain('request_file');
    const schema = openTools(c).find((t) => t.name === 'switch_path')!.input_schema as { properties: { to: { enum: string[] } } };
    expect(schema.properties.to.enum).toEqual(['help', 'problem', 'feature']);
    // At the message limit the brief tools shrink to decline; the first choice stays available.
    expect(names(openTools(ctx({ messageCount: 31 })))).toEqual(['switch_path', 'decline', 'start_over']);
    const system = openAgent.system(c);
    expect(system).toContain('has not chosen a path yet'); expect(system).toContain('without asking'); expect(system).toContain('afterwards this rule applies');
    expect(system).not.toContain('a@b.io'); expect(openAgent.context(c)).toContain('path: open');
  });
  it('switches to help from a how-do-I message and answers from the documentation in the same turn', async () => {
    const store = new MemoryConversationStore(null, null, 'open');
    const client = fakeAnthropic([
      { toolUses: [{ id: '1', name: 'switch_path', input: { to: 'help', reason: 'asks how to lock inference' } }] },
      { toolUses: [{ id: '2', name: 'search_docs', input: { query: 'lock inference' } }] },
      { text: ['Hold Shift to lock the inference direction. Did that answer your question?'] },
    ]);
    const r = await turn(store, client, 'How do I lock the inference direction?');
    expect(store.getPath()).toBe('help'); expect(store.getBrief()).toBeNull(); expect(store.ended()).toBeNull();
    expect(results(r)[0]).toContain('Path set to help'); expect(results(r)[0]).toContain('call search_docs');
    expect(results(r, 3)[0]).toContain('Inference locking');
    expect(r.text).not.toMatch(/MOD\d{4}/);
  });
  it('switches to problem from a bug-like message, records what was given and defaults Area from the known editor', async () => {
    const store = new MemoryConversationStore(null, null, 'open');
    const client = fakeAnthropic([
      { toolUses: [{ id: '1', name: 'switch_path', input: { to: 'problem', reason: 'push/pull crashes' } }] },
      { toolUses: [{ id: '2', name: 'update_brief', input: { section: 'happened', text: 'PushForm crashes when I push/pull a face' } }] },
      { text: ['Sorry about that. What did you do, step by step, before it crashed?'] },
    ]);
    const r = await turn(store, client, 'PushForm crashes when I push/pull a face');
    expect(store.getPath()).toBe('problem');
    const brief = store.getBrief() as ProblemReport;
    expect(brief.area).toBe('Modeling'); expect(brief.kind).toBe('problem'); expect(brief.happened).toBe('PushForm crashes when I push/pull a face'); expect(brief.environment.build).toBe('0.3.0 (abc123)');
    expect(results(r)[0]).toContain('Path set to problem'); expect(results(r)[0]).toContain('steps');
    expect(results(r, 3)[0]).toContain('## What happened'); expect(r.text).toContain('step by step');
    // A second switch in the same conversation is refused from now on.
    const again = await openAgent.handlers(ctx(), store)['switch_path']!({ to: 'feature', reason: 'r' });
    expect(again).toMatchObject({ isError: true, content: expect.stringContaining('needs the requester\'s agreement first') });
    expect(store.getPath()).toBe('problem');
  });
  it('switches to feature and starts the feature brief', async () => {
    const store = new MemoryConversationStore(null, null, 'open');
    const client = fakeAnthropic([
      { toolUses: [{ id: '1', name: 'switch_path', input: { to: 'feature', reason: 'wants a new capability' } }] },
      { toolUses: [{ id: '2', name: 'update_brief', input: { section: 'desired', text: 'A dark theme' } }] },
      { text: ['What are you trying to do that the current theme makes hard?'] },
    ]);
    await turn(store, client, 'I want a dark theme');
    expect(store.getPath()).toBe('feature');
    const brief = store.getBrief() as FeatureBrief;
    expect(brief.kind).toBe('feature'); expect(brief.desired).toBe('A dark theme');
  });
  it('asks the three-way question without switching when the message is ambiguous, and refuses brief tools before a path is set', async () => {
    const store = new MemoryConversationStore(null, null, 'open');
    const client = fakeAnthropic([{ text: ['Happy to help. Do you want help using Pushform, to report a problem, or to request a feature or change?'] }]);
    const r = await turn(store, client, 'tables');
    expect(store.getPath()).toBe('open'); expect(store.getBrief()).toBeNull(); expect(store.ended()).toBeNull();
    expect(r.text).toContain('report a problem'); expect(r.text).toContain('request a feature');
    expect(await openAgent.handlers(ctx(), store)['update_brief']!({ section: 'problem', text: 'x' })).toMatchObject({ isError: true });
    expect(openAgent.system(ctx())).toContain('do not call switch_path');
  });
});
