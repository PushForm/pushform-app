// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ConversationPath } from './client';

/**
 * The open conversation an account left behind in this browser, remembered for 7 days so the
 * panel can offer Continue or Start over. Storage is per account; every access tolerates a missing or
 * throwing `localStorage` (private windows, blocked site data).
 */
export interface DraftRecord {
  readonly conversationId: string;
  readonly path: ConversationPath;
  readonly title: string | null;
  readonly updatedAt: number;
  /** The document the conversation belongs to; absent in drafts written before scopes, which belong to Home. */
  readonly scope?: string | undefined;
}
/** The scope of Home's conversation. */
export const HOME_SCOPE = 'home';
export const draftScope = (draft: DraftRecord): string => draft.scope ?? HOME_SCOPE;
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (ownerId: string): string => `pushform:fr:drafts:${ownerId}`;
function defaultStorage(): DraftStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
function readAll(ownerId: string, storage: DraftStorage | null, now: number): DraftRecord[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key(ownerId)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is DraftRecord => typeof item === 'object' && item !== null
      && typeof (item as DraftRecord).conversationId === 'string' && typeof (item as DraftRecord).updatedAt === 'number'
      && now - (item as DraftRecord).updatedAt < DRAFT_TTL_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch { return []; }
}
function writeAll(ownerId: string, storage: DraftStorage | null, drafts: readonly DraftRecord[]): void {
  if (!storage) return;
  try { if (drafts.length) storage.setItem(key(ownerId), JSON.stringify(drafts)); else storage.removeItem(key(ownerId)); } catch { /* Storage unavailable. */ }
}

/** Unexpired drafts, most recent first; expired entries are pruned on read. */
export function readDrafts(ownerId: string, storage: DraftStorage | null = defaultStorage(), now = Date.now()): DraftRecord[] {
  const drafts = readAll(ownerId, storage, now);
  writeAll(ownerId, storage, drafts);
  return drafts;
}
export function rememberDraft(ownerId: string, draft: Omit<DraftRecord, 'updatedAt'>, storage: DraftStorage | null = defaultStorage(), now = Date.now()): void {
  const others = readAll(ownerId, storage, now).filter(item => item.conversationId !== draft.conversationId);
  writeAll(ownerId, storage, [{ ...draft, updatedAt: now }, ...others]);
}
export function forgetDraft(ownerId: string, conversationId: string, storage: DraftStorage | null = defaultStorage(), now = Date.now()): void {
  writeAll(ownerId, storage, readAll(ownerId, storage, now).filter(item => item.conversationId !== conversationId));
}
