// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { ConversationMessage } from '../domain/types.ts';
import { recentHistory, withOmittedNote } from './conversation.ts';

const user = (text: string): ConversationMessage => ({ role: 'user', text, at: 't' });
const assistant = (text: string): ConversationMessage => ({ role: 'assistant', text, at: 't' });
const tool = (output: string): ConversationMessage => ({ role: 'tool', name: 'model_get_document', toolUseId: 't', input: {}, output, at: 't' });

describe('recentHistory', () => {
  it('returns a short conversation whole', () => {
    const messages = [user('a'), assistant('b'), user('c')];
    expect(recentHistory(messages, 1000)).toEqual({ messages, omitted: false });
  });
  it('keeps the most recent messages that fit, starting at a requester message', () => {
    const messages: ConversationMessage[] = [];
    for (let i = 0; i < 100; i++) messages.push(user(`q${i} ${'x'.repeat(100)}`), assistant(`a${i} ${'y'.repeat(100)}`));
    const { messages: kept, omitted } = recentHistory(messages, 2000);
    expect(omitted).toBe(true);
    expect(kept[0]!.role).toBe('user');
    expect(kept.at(-1)).toBe(messages.at(-1));
    expect(kept.reduce((n, m) => n + (m.role === 'tool' ? 0 : m.text.length), 0)).toBeLessThanOrEqual(2000 + 220);
    expect(kept.length).toBeLessThan(messages.length);
  });
  it('never starts on a reply or a tool result whose question was cut off', () => {
    const messages = [user('old question'), tool('z'.repeat(500)), tool('z'.repeat(500)), assistant('old answer'), user('new question'), assistant('new answer')];
    const { messages: kept } = recentHistory(messages, 800);
    expect(kept[0]).toEqual(user('new question'));
  });
  it('always keeps the latest requester message and what followed, even when it alone exceeds the budget', () => {
    const messages = [user('early'), assistant('early reply'), user('x'.repeat(5000)), tool('t'.repeat(5000)), assistant('done')];
    const { messages: kept, omitted } = recentHistory(messages, 100);
    expect(omitted).toBe(true);
    expect(kept.map(m => m.role)).toEqual(['user', 'tool', 'assistant']);
  });
  it('handles an empty conversation and one with no requester message', () => {
    expect(recentHistory([], 100)).toEqual({ messages: [], omitted: false });
    expect(recentHistory([assistant('hi')], 1).messages).toEqual([]);
  });
});

describe('withOmittedNote', () => {
  it('adds the note only when messages were left out', () => {
    expect(withOmittedNote('<context>', false)).toBe('<context>');
    expect(withOmittedNote('<context>', true)).toContain('Earlier messages in this chat are not shown to you');
  });
});
