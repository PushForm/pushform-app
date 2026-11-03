// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CloudBillingState, CloudBillingStore } from '@pushform/cloud';
import { AccountBilling, annualBillingComparison, formatBillingPrice } from './AccountBilling';

afterEach(() => { cleanup(); vi.useRealTimers(); });
function fake(patch: Partial<CloudBillingState> = {}) {
  const state: CloudBillingState = { status: 'ready', ownerId: 'user-1', summary: { available: true,
    offers: [{ interval: 'month', amount: 1500, currency: 'usd' }, { interval: 'year', amount: 15000, currency: 'usd' }], subscription: null, canManageBilling: false }, busy: null, returned: null, error: null, ...patch };
  const billing: CloudBillingStore = { getSnapshot: () => state, subscribe: () => () => {}, reload: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue('https://checkout.stripe.com/c/pay/test'), portal: vi.fn().mockResolvedValue('https://billing.stripe.com/p/session/test'), clearReturn: vi.fn() };
  return { billing, state };
}
it('shows server prices for each interval and prepares an explicit secure checkout link', async () => {
  const { billing, state } = fake();
  render(<AccountBilling billing={billing} state={state} />);
  expect((screen.getByRole('radio', { name: /Annual.*12.50.*Billed.*150.00.*Save 17%/ }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /Continue with annual Individual/ }));
  const link = await screen.findByRole('link', { name: /Continue to secure checkout/ });
  expect(billing.checkout).toHaveBeenCalledWith('year');
  expect(link.getAttribute('href')).toBe('https://checkout.stripe.com/c/pay/test');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(screen.queryByText(/private files/i)).toBeNull();
});
it('does not offer purchase before billing is configured', () => {
  const { billing, state } = fake({ summary: { available: false, offers: [], subscription: null, canManageBilling: false } });
  render(<AccountBilling billing={billing} state={state} />);
  expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull();
  expect(screen.getByText('Individual subscriptions are not available for purchase yet.')).toBeTruthy();
});
it('shows cancellation date and management for a subscriber without offering duplicate checkout', async () => {
  const { billing, state } = fake({ summary: { available: true, offers: [{ interval: 'month', amount: 1200, currency: 'usd' }], canManageBilling: true,
    subscription: { status: 'active', interval: 'month', currentPeriodEnd: '2026-12-02T00:00:00Z', cancelAtPeriodEnd: true } } });
  const view = render(<AccountBilling billing={billing} state={state} />);
  expect(screen.getByText(/Scheduled to end/)).toBeTruthy();
  expect(screen.getByText('Update payment details, view invoices, or cancel your subscription in Stripe.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Manage or cancel subscription…' }));
  expect(await screen.findByRole('link', { name: /Continue to manage or cancel subscription/ })).toBeTruthy();
  expect(billing.portal).toHaveBeenCalledOnce();
  view.rerender(<AccountBilling billing={billing} state={{ ...state, summary: { ...state.summary!, subscription: { ...state.summary!.subscription!, status: 'past_due' } } }} />);
  expect(screen.getByRole('link', { name: /Continue to manage or cancel subscription/ })).toBeTruthy();
  expect(screen.getByText(/Your payment needs attention/)).toBeTruthy();
});
it.each(['active', 'past_due'])('discards prepared checkout after confirmation of a %s subscription', async status => {
  const { billing, state } = fake({ returned: 'success' });
  const view = render(<AccountBilling billing={billing} state={state} />);
  fireEvent.click(screen.getByRole('button', { name: /Continue with annual Individual/ }));
  await screen.findByRole('link', { name: /Continue to secure checkout/ });
  const confirmed: CloudBillingState = { ...state, summary: { ...state.summary!, canManageBilling: true,
    subscription: { status, interval: 'year', currentPeriodEnd: '2027-11-03T00:00:00Z', cancelAtPeriodEnd: false } } };
  view.rerender(<AccountBilling billing={billing} state={confirmed} />);
  expect(screen.queryByRole('link', { name: /Continue to secure checkout/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Manage or cancel subscription…' })).toBeTruthy();
  view.rerender(<AccountBilling billing={billing} state={{ ...confirmed, summary: { ...confirmed.summary!, subscription: { ...confirmed.summary!.subscription!, status: 'canceled' } } }} />);
  expect(screen.queryByRole('link', { name: /Continue to secure checkout/ })).toBeNull();
});
it('discards an in-flight checkout response after the subscription has been confirmed', async () => {
  const { billing, state } = fake();
  let finish!: (url: string) => void;
  vi.mocked(billing.checkout).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<AccountBilling billing={billing} state={state} />);
  fireEvent.click(screen.getByRole('button', { name: /Continue with annual Individual/ }));
  const confirmed: CloudBillingState = { ...state, summary: { ...state.summary!, canManageBilling: true,
    subscription: { status: 'active', interval: 'year', currentPeriodEnd: '2027-11-03T00:00:00Z', cancelAtPeriodEnd: false } } };
  view.rerender(<AccountBilling billing={billing} state={confirmed} />);
  finish('https://checkout.stripe.com/c/pay/completed');
  await vi.waitFor(() => expect(screen.queryByText('Preparing secure billing…')).toBeNull());
  expect(screen.queryByRole('link', { name: /Continue to secure checkout/ })).toBeNull();
  view.rerender(<AccountBilling billing={billing} state={state} />);
  expect(screen.queryByRole('link', { name: /Continue to secure checkout/ })).toBeNull();
});
it('refreshes pending payment confirmation without treating checkout return as activation', async () => {
  vi.useFakeTimers();
  const { billing, state } = fake({ returned: 'success' });
  const view = render(<AccountBilling billing={billing} state={state} />);
  expect(screen.getByText(/Waiting for payment confirmation/)).toBeTruthy();
  expect(screen.queryByText('Your Individual subscription is active.')).toBeNull();
  await vi.advanceTimersByTimeAsync(5000);
  expect(billing.reload).toHaveBeenCalledTimes(2);
  view.unmount(); await vi.advanceTimersByTimeAsync(10000);
  expect(billing.reload).toHaveBeenCalledTimes(2);
});
it('formats both fractional and zero-decimal currency prices', () => {
  expect(formatBillingPrice({ interval: 'month', amount: 1250, currency: 'usd' })).toMatch(/12.50.*month/);
  expect(formatBillingPrice({ interval: 'year', amount: 1200, currency: 'jpy' })).toMatch(/1,200.*year/);
  expect(formatBillingPrice({ interval: 'month', amount: 120000, currency: 'isk' })).toMatch(/1,200.*month/);
  expect(formatBillingPrice({ interval: 'month', amount: 120000, currency: 'ugx' })).toMatch(/1,200.*month/);
  expect(formatBillingPrice({ interval: 'month', amount: 120050, currency: 'huf' })).toMatch(/1,200.50.*month/);
  expect(formatBillingPrice({ interval: 'month', amount: 12345, currency: 'kwd' })).toMatch(/12.345.*month/);
});

it('drops a checkout link prepared for an account that has since changed', async () => {
  const { billing, state } = fake();
  let finish!: (url: string) => void;
  vi.mocked(billing.checkout).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<AccountBilling billing={billing} state={state} />);
  fireEvent.click(screen.getByRole('button', { name: /Continue with annual Individual/ }));
  view.rerender(<AccountBilling billing={billing} state={{ ...state, ownerId: 'other-user' }} />);
  finish('https://checkout.stripe.com/c/pay/old-account');
  await vi.waitFor(() => expect(screen.queryByText('Preparing secure billing…')).toBeNull());
  expect(screen.queryByRole('link', { name: /Continue to secure checkout/ })).toBeNull();
});

it('compares annual prices only with compatible monthly prices and does not advertise negative savings', () => {
  const annual = { interval: 'year', amount: 15000, currency: 'usd' } as const;
  expect(annualBillingComparison(annual, { interval: 'month', amount: 1500, currency: 'USD' })).toEqual({ monthlyEquivalent: '$12.50', yearlyTotal: '$150.00', savingsPercent: 17 });
  expect(annualBillingComparison(annual, { interval: 'month', amount: 1500, currency: 'eur' }).savingsPercent).toBeNull();
  expect(annualBillingComparison(annual, { interval: 'month', amount: 1000, currency: 'usd' }).savingsPercent).toBeNull();
  expect(annualBillingComparison(annual, undefined).savingsPercent).toBeNull();
});
it('allows switching to monthly checkout while keeping annual as the initial choice', async () => {
  const { billing, state } = fake();
  render(<AccountBilling billing={billing} state={state} />);
  fireEvent.click(screen.getByRole('radio', { name: /Monthly/ }));
  fireEvent.click(screen.getByRole('button', { name: /Continue with monthly Individual/ }));
  await screen.findByRole('link', { name: /Continue to secure checkout/ });
  expect(billing.checkout).toHaveBeenCalledWith('month');
});
