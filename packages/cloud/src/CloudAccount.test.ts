// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { CloudAccount } from './CloudAccount';
import type { CloudSessionState } from './CloudSession';

afterEach(() => { vi.useRealTimers(); });

function fakeSession(user: string | null) {
  const listeners = new Set<() => void>();
  let state = { status: user ? 'signedIn' : 'signedOut', user: user ? { id: user, email: `${user}@example.com` } : null } as CloudSessionState;
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    switchTo(next: string | null) {
      state = { ...state, status: next ? 'signedIn' : 'signedOut', user: next ? { id: next, email: `${next}@example.com` } : null };
      for (const listener of listeners) listener();
    },
  };
}
type Result = { data: unknown; error: unknown };
/** Answers reads of the two tables and the three functions; `missing` makes every call fail as before the migration. */
function fakeClient(tables: { deletion?: unknown; export?: unknown; missing?: boolean }, rpc: Record<string, () => Result> = {}) {
  const reads: string[] = [], calls: string[] = [];
  const answer = (table: string): Result => tables.missing ? { data: null, error: { code: 'PGRST205' } }
    : { data: (table === 'cloud_account_deletions' ? tables.deletion : tables.export) ?? null, error: null };
  const query = (table: string) => {
    const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => { reads.push(table); return answer(table); } };
    return chain;
  };
  return {
    reads, calls,
    client: {
      from: (table: string) => query(table),
      rpc: async (fn: string) => { calls.push(fn); return rpc[fn]?.() ?? { data: null, error: { message: 'unexpected' } }; },
    } as never,
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const queuedRow = { id: 'e1', status: 'queued', requested_at: '2026-10-27T10:00:00Z', finished_at: null, document_count: null, size_bytes: null, expires_at: null, error: null };

it('loads the signed-in account\'s deletion mark and latest export, and forgets them on sign-out', async () => {
  const session = fakeSession('u1');
  const fake = fakeClient({ deletion: { requested_at: '2026-10-27T10:00:00Z', delete_after: '2026-10-29T10:00:00Z' } });
  const store = new CloudAccount(fake.client, session);
  expect(store.getSnapshot().status).toBe('loading');
  await settle();
  expect(store.getSnapshot()).toMatchObject({ status: 'ready', ownerId: 'u1', deletion: { deleteAfter: '2026-10-29T10:00:00Z' }, latestExport: null });
  session.switchTo(null);
  expect(store.getSnapshot()).toMatchObject({ status: 'signedOut', deletion: null });
  store.dispose();
});

it('offers nothing where the installation has no account functions yet', async () => {
  const store = new CloudAccount(fakeClient({ missing: true }).client, fakeSession('u1'));
  await settle();
  expect(store.getSnapshot()).toMatchObject({ status: 'unavailable', error: null });
  store.dispose();
});

it('marks the account for deletion and cancels it, reporting a cancellation that came too late', async () => {
  let cancelled = true;
  const fake = fakeClient({}, {
    cloud_request_account_deletion: () => ({ data: { requested_at: '2026-10-27T10:00:00Z', delete_after: '2026-10-29T10:00:00Z' }, error: null }),
    cloud_cancel_account_deletion: () => ({ data: cancelled, error: null }),
  });
  const store = new CloudAccount(fake.client, fakeSession('u1'));
  await settle();
  expect(await store.requestDeletion()).toBe(true);
  expect(store.getSnapshot().deletion).toEqual({ requestedAt: '2026-10-27T10:00:00Z', deleteAfter: '2026-10-29T10:00:00Z' });
  expect(await store.cancelDeletion()).toBe(true);
  expect(store.getSnapshot().deletion).toBeNull();
  await store.requestDeletion();
  cancelled = false;
  expect(await store.cancelDeletion()).toBe(false);
  expect(store.getSnapshot()).toMatchObject({ error: 'The deletion can no longer be cancelled.', busy: null });
  store.dispose();
});

it('requests an export, reads its status again while it is built, and explains the daily limit', async () => {
  vi.useFakeTimers();
  let limited = false;
  const tables: { export?: unknown } = {};
  const fake = fakeClient(tables, {
    cloud_request_export: () => limited ? { data: null, error: { code: '54000', message: 'cloud_rate_limited' } } : { data: queuedRow, error: null },
  });
  const store = new CloudAccount(fake.client, fakeSession('u1'), 1000);
  await vi.advanceTimersByTimeAsync(0);
  expect(await store.requestExport()).toBe(true);
  expect(store.getSnapshot().latestExport).toMatchObject({ id: 'e1', status: 'queued' });
  tables.export = { ...queuedRow, status: 'ready', document_count: 3, size_bytes: '2048', expires_at: '2026-10-28T10:00:00Z' };
  const reads = fake.reads.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(fake.reads.length).toBe(reads + 2);
  expect(store.getSnapshot().latestExport).toMatchObject({ status: 'ready', documentCount: 3, sizeBytes: 2048 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(fake.reads.length).toBe(reads + 2); // a finished export is not read again
  limited = true;
  expect(await store.requestExport()).toBe(false);
  expect(store.getSnapshot().error).toBe('You have asked for five exports in the last 24 hours. Try again later.');
  store.dispose();
});
