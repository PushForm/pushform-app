// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { DRAFT_TTL_MS, forgetDraft, readDrafts, rememberDraft } from './drafts';

function memory(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: key => { map.delete(key); } };
}

describe('drafts', () => {
  it('remembers drafts per account, most recent first, and forgets them individually', () => {
    const storage = memory();
    rememberDraft('alice', { conversationId: 'c1', path: 'feature', title: null }, storage, 1_000);
    rememberDraft('alice', { conversationId: 'c2', path: 'problem', title: 'Crash' }, storage, 2_000);
    rememberDraft('bob', { conversationId: 'c3', path: 'help', title: null }, storage, 3_000);
    expect(readDrafts('alice', storage, 3_000).map(draft => draft.conversationId)).toEqual(['c2', 'c1']);
    expect(readDrafts('bob', storage, 3_000)).toHaveLength(1);
    rememberDraft('alice', { conversationId: 'c1', path: 'feature', title: 'Mirror' }, storage, 4_000);
    expect(readDrafts('alice', storage, 4_000)[0]).toEqual({ conversationId: 'c1', path: 'feature', title: 'Mirror', updatedAt: 4_000 });
    forgetDraft('alice', 'c1', storage, 4_000);
    expect(readDrafts('alice', storage, 4_000).map(draft => draft.conversationId)).toEqual(['c2']);
    forgetDraft('alice', 'c2', storage, 4_000);
    expect(storage.map.has('pushform:fr:drafts:alice')).toBe(false);
  });
  it('expires drafts after 7 days and prunes them from storage on read', () => {
    const storage = memory();
    rememberDraft('alice', { conversationId: 'old', path: 'feature', title: null }, storage, 0);
    rememberDraft('alice', { conversationId: 'fresh', path: 'feature', title: null }, storage, DRAFT_TTL_MS / 2);
    expect(readDrafts('alice', storage, DRAFT_TTL_MS - 1).map(draft => draft.conversationId)).toEqual(['fresh', 'old']);
    expect(readDrafts('alice', storage, DRAFT_TTL_MS).map(draft => draft.conversationId)).toEqual(['fresh']);
    expect(JSON.parse(storage.map.get('pushform:fr:drafts:alice')!)).toHaveLength(1);
  });
  it('tolerates missing, corrupt and throwing storage', () => {
    expect(readDrafts('alice', null)).toEqual([]);
    rememberDraft('alice', { conversationId: 'c', path: 'help', title: null }, null);
    const corrupt = memory(); corrupt.setItem('pushform:fr:drafts:alice', '{not json');
    expect(readDrafts('alice', corrupt)).toEqual([]);
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(readDrafts('alice', throwing)).toEqual([]);
    expect(() => rememberDraft('alice', { conversationId: 'c', path: 'help', title: null }, throwing)).not.toThrow();
    expect(() => forgetDraft('alice', 'c', throwing)).not.toThrow();
  });
});
