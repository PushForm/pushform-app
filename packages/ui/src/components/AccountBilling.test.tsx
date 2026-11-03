// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { isTauri } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { CloudBillingState, CloudBillingStore } from '@pushform/cloud';
import { AccountBilling } from './AccountBilling';
vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(() => false) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(isTauri).mockReturnValue(false); vi.mocked(openUrl).mockClear(); });
function fake(patch: Partial<CloudBillingState> = {}) {
  const state: CloudBillingState = { status: 'ready', ownerId: 'user-1', summary: { available: true,
    offers: [{ interval: 'month', amount: 1500, currency: 'usd' }, { interval: 'year', amount: 15000, currency: 'usd' }], subscription: null, canManageBilling: false }, busy: null, returned: null, error: null, ...patch };
  const billing: CloudBillingStore = { getSnapshot: () => state, subscribe: () => () => {}, reload: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue('https://checkout.stripe.com/c/pay/test'), portal: vi.fn().mockResolvedValue('https://billing.stripe.com/p/session/test'), clearReturn: vi.fn() };
  return { billing, state };
}
function subscribed(status = 'active') {
  return fake({ summary: { available: true, offers: [], canManageBilling: true,
    subscription: { status, interval: 'year', currentPeriodEnd: '2027-11-03T00:00:00Z', cancelAtPeriodEnd: false } } });
}
function popup() {
  const value = { opener: {}, closed: false, location: { assign: vi.fn() }, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(value as unknown as Window);
  return value;
}
const choose = (): void => { fireEvent.click(screen.getByRole('button', { name: /^(Manage account|Subscribe now)$/ })); };

it('keeps account billing to current plan and exactly one orange Subscribe now button', () => {
  const { billing, state } = fake(); render(<AccountBilling billing={billing} state={state} />);
  expect(screen.getByText('Community')).toBeTruthy();
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Subscribe now']);
  expect(screen.getByRole('button', { name: 'Subscribe now' }).classList.contains('pf-account-subscribe')).toBe(true);
  expect(screen.queryByRole('radio')).toBeNull(); expect(screen.queryByRole('link')).toBeNull();
  expect(screen.queryByText(/\$15|\$150|\$12.50/)).toBeNull();
});
it('reserves a blank tab in the Subscribe now gesture then directly navigates only after a validated response', async () => {
  const { billing, state } = fake(), tab = popup();
  let finish!: (url: string) => void;
  vi.mocked(billing.checkout).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<AccountBilling billing={billing} state={state} />); choose();
  expect(window.open).toHaveBeenCalledWith('about:blank', '_blank'); expect(tab.opener).toBeNull();
  expect(billing.checkout).toHaveBeenCalledWith('month'); expect(tab.location.assign).not.toHaveBeenCalled();
  finish('https://checkout.stripe.com/c/pay/test');
  await vi.waitFor(() => expect(tab.location.assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/test'));
  expect(tab.close).not.toHaveBeenCalled(); expect(screen.queryByRole('link')).toBeNull();
});
it.each(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'])('opens the portal directly for an existing %s subscription', async status => {
  const { billing, state } = subscribed(status), tab = popup(); render(<AccountBilling billing={billing} state={state} />);
  expect(screen.getByText('Individual')).toBeTruthy();
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Manage account']);
  expect(screen.getByRole('button', { name: 'Manage account' }).classList.contains('pf-account-subscribe')).toBe(false); choose();
  await vi.waitFor(() => expect(tab.location.assign).toHaveBeenCalledWith('https://billing.stripe.com/p/session/test'));
  expect(billing.portal).toHaveBeenCalledOnce(); expect(billing.checkout).not.toHaveBeenCalled();
  expect(screen.queryByRole('heading', { name: 'Choose your subscription' })).toBeNull();
});
it.each(['canceled', 'incomplete_expired'])('opens hosted checkout directly for an existing customer whose subscription is %s', async status => {
  const { billing, state } = subscribed(status), tab = popup(); state.summary!.available = true;
  render(<AccountBilling billing={billing} state={state} />);
  expect(screen.getByRole('button', { name: 'Subscribe now' }).classList.contains('pf-account-subscribe')).toBe(true); choose();
  await vi.waitFor(() => expect(tab.location.assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/test'));
  expect(billing.checkout).toHaveBeenCalledWith('month'); expect(billing.portal).not.toHaveBeenCalled();
});
it('opens checkout for a customer with billing history but no current subscription', async () => {
  const f = fake(), tab = popup(); f.state.summary!.canManageBilling = true;
  render(<AccountBilling billing={f.billing} state={f.state} />); choose();
  await vi.waitFor(() => expect(tab.location.assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/test'));
  expect(f.billing.portal).not.toHaveBeenCalled();
});
it.each([false, true])('does not call the provider when a browser blocks the billing popup (paid=%s)', paid => {
  const f = paid ? subscribed() : fake(); vi.spyOn(window, 'open').mockReturnValue(null);
  render(<AccountBilling billing={f.billing} state={f.state} />); choose();
  expect(screen.getByRole('alert').textContent).toContain('Allow pop-ups'); expect(f.billing.checkout).not.toHaveBeenCalled(); expect(f.billing.portal).not.toHaveBeenCalled();
});
it.each(['invalid', 'failed'])('closes the blank tab after an %s destination response', async kind => {
  const { billing, state } = subscribed(), tab = popup();
  if (kind === 'invalid') vi.mocked(billing.portal).mockResolvedValue('https://billing.stripe.com.evil.example/test');
  else vi.mocked(billing.portal).mockRejectedValue(new Error('Provider unavailable'));
  render(<AccountBilling billing={billing} state={state} />); choose();
  await screen.findByRole('alert'); expect(tab.close).toHaveBeenCalled(); expect(tab.location.assign).not.toHaveBeenCalled();
});
it.each(['owner', 'unmount', 'confirmed'])('closes an in-flight blank checkout tab on %s and rejects its late response', async reason => {
  const { billing, state } = fake(), tab = popup(); let finish!: (url: string) => void;
  vi.mocked(billing.checkout).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<AccountBilling billing={billing} state={state} />); choose();
  if (reason === 'owner') view.rerender(<AccountBilling billing={billing} state={{ ...state, ownerId: 'another-user' }} />);
  else if (reason === 'unmount') view.unmount();
  else view.rerender(<AccountBilling billing={billing} state={{ ...state, summary: { ...state.summary!, subscription: subscribed().state.summary!.subscription, canManageBilling: true } }} />);
  expect(tab.close).toHaveBeenCalled(); finish('https://checkout.stripe.com/c/pay/late');
  await Promise.resolve(); await Promise.resolve(); expect(tab.location.assign).not.toHaveBeenCalled();
});
it('uses the system browser on desktop without opening a browser popup', async () => {
  vi.mocked(isTauri).mockReturnValue(true); const open = vi.spyOn(window, 'open');
  const { billing, state } = subscribed(); render(<AccountBilling billing={billing} state={state} />); choose();
  await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://billing.stripe.com/p/session/test')); expect(open).not.toHaveBeenCalled();
});
it('disables purchase before configuration and never invents a Community plan while loading', () => {
  const f = fake({ summary: { available: false, offers: [], subscription: null, canManageBilling: false } });
  const view = render(<AccountBilling billing={f.billing} state={f.state} />);
  expect((screen.getByRole('button', { name: /^(Manage account|Subscribe now)$/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('radio')).toBeNull(); expect(f.billing.checkout).not.toHaveBeenCalled();
  view.rerender(<AccountBilling billing={f.billing} state={{ ...f.state, ownerId: 'another', status: 'loading', summary: null }} />);
  expect(screen.queryByText('Community')).toBeNull(); expect(screen.getByText('Loading…')).toBeTruthy();
});
it('retries a status error using the sole Subscribe now button', async () => {
  const { billing, state } = fake({ status: 'error', summary: null, error: 'Could not load billing.' });
  render(<AccountBilling billing={billing} state={state} />);
  expect(screen.getByText('Unavailable')).toBeTruthy(); choose();
  await vi.waitFor(() => expect(billing.reload).toHaveBeenCalledTimes(2)); expect(billing.checkout).not.toHaveBeenCalled();
});
it('keeps focus/return refresh and pending confirmation polling without a Refresh button or URL-based activation', async () => {
  vi.useFakeTimers(); const { billing, state } = fake({ returned: 'success' });
  const view = render(<AccountBilling billing={billing} state={state} />);
  expect(screen.getByText('Community')).toBeTruthy(); expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull();
  await vi.advanceTimersByTimeAsync(5000); expect(billing.reload).toHaveBeenCalledTimes(2);
  fireEvent.focus(window); expect(billing.reload).toHaveBeenCalledTimes(3);
  view.unmount(); await vi.advanceTimersByTimeAsync(10000); expect(billing.reload).toHaveBeenCalledTimes(3);
});
