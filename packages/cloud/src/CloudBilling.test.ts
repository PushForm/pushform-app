// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import { CloudBilling, billingHostedUrl, billingReturnFromUrl } from './CloudBilling';
import type { CloudSessionState } from './CloudSession';

const summary = { available: true, offers: [{ interval: 'month', amount: 1500, currency: 'usd' }], subscription: null, canManageBilling: false };
const settle = async (): Promise<void> => { await vi.waitFor(() => {}); await Promise.resolve(); };
function session(initial: string | null = 'a') {
  let state = { status: initial ? 'signedIn' : 'signedOut', user: initial ? { id: initial, email: `${initial}@example.com` } : null } as CloudSessionState;
  const listeners = new Set<() => void>();
  return { getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    switchTo(id: string | null) { state = { ...state, status: id ? 'signedIn' : 'signedOut', user: id ? { id, email: `${id}@example.com` } : null }; for (const fn of listeners) fn(); } };
}
function client(invoke = vi.fn().mockResolvedValue({ data: summary, error: null })) { return { functions: { invoke } } as never; }
it('reads configured offers, clears account billing on identity loss, and never infers payment from return URL', async () => {
  const auth = session();
  const store = new CloudBilling(client(), auth, 'success');
  await settle();
  expect(store.getSnapshot()).toMatchObject({ status: 'ready', ownerId: 'a', returned: 'success', summary: { subscription: null } });
  auth.switchTo(null);
  expect(store.getSnapshot()).toMatchObject({ status: 'signedOut', summary: null, returned: null });
  expect(await store.checkout('month')).toBeNull();
  auth.switchTo('b'); await settle();
  expect(store.getSnapshot()).toMatchObject({ ownerId: 'b', returned: null });
  store.dispose();
});
it('discards reads and checkout destinations from a previous account', async () => {
  let finishStatus!: (result: unknown) => void, finishCheckout!: (result: unknown) => void;
  const invoke = vi.fn((name: string) => new Promise(resolve => {
    if (name === 'billing-status') finishStatus = resolve; else finishCheckout = resolve;
  }));
  const auth = session(), store = new CloudBilling(client(invoke), auth);
  const checkout = store.checkout('year');
  auth.switchTo(null);
  finishStatus({ data: summary, error: null });
  finishCheckout({ data: { url: 'https://checkout.stripe.com/c/pay/test' }, error: null });
  expect(await checkout).toBeNull(); await settle();
  expect(store.getSnapshot()).toMatchObject({ status: 'signedOut', summary: null, busy: null });
  store.dispose();
});
it('uses authenticated function calls and rejects an untrusted payment redirect', async () => {
  const invoke = vi.fn().mockResolvedValueOnce({ data: summary, error: null })
    .mockResolvedValueOnce({ data: { url: 'https://checkout.stripe.com.evil.example/pay' }, error: null })
    .mockResolvedValueOnce({ data: { url: 'https://checkout.stripe.com/c/pay/test' }, error: null });
  const store = new CloudBilling(client(invoke), session()); await settle();
  expect(await store.checkout('month')).toBeNull();
  expect(store.getSnapshot().error).toContain('Could not open billing');
  expect(await store.checkout('year')).toBe('https://checkout.stripe.com/c/pay/test');
  expect(invoke).toHaveBeenLastCalledWith('billing-checkout', { body: { interval: 'year' } });
  store.dispose();
});
it('rejects malformed status responses and allows a retry', async () => {
  const invoke = vi.fn().mockResolvedValueOnce({ data: { ...summary, offers: [{ interval: 'month', amount: -1, currency: 'usd' }] }, error: null })
    .mockResolvedValueOnce({ data: { ...summary, available: false, offers: [] }, error: null });
  const store = new CloudBilling(client(invoke), session()); await settle();
  expect(store.getSnapshot().status).toBe('error');
  await store.reload();
  expect(store.getSnapshot()).toMatchObject({ status: 'ready', error: null, summary: { available: false } });
  store.dispose();
});
it('keeps the newest billing read when concurrent responses arrive out of order', async () => {
  const responses: ((result: unknown) => void)[] = [];
  const store = new CloudBilling(client(vi.fn(() => new Promise(resolve => { responses.push(resolve); }))), session());
  const newest = store.reload();
  responses[1]!({ data: { ...summary, canManageBilling: true }, error: null }); await newest;
  responses[0]!({ data: summary, error: null }); await settle();
  expect(store.getSnapshot().summary?.canManageBilling).toBe(true);
  store.dispose();
});
it.each(['http://checkout.stripe.com/test', 'https://user@checkout.stripe.com/test', 'https://checkout.stripe.com:444/test', 'javascript:alert(1)'])('rejects unsafe checkout destination %s', url => {
  expect(() => billingHostedUrl({ url }, 'checkout')).toThrow();
});
it('parses only recognized billing returns and distinguishes portal from checkout hosts', () => {
  expect(billingReturnFromUrl(new URL('https://app.example/?billing=success'))).toBe('success');
  expect(billingReturnFromUrl(new URL('https://app.example/?billing=paid'))).toBeNull();
  expect(() => billingHostedUrl({ url: 'https://checkout.stripe.com/test' }, 'portal')).toThrow();
});
