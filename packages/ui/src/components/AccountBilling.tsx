// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type JSX } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { billingHostedUrl, type BillingInterval, type BillingSummary, type CloudBillingState, type CloudBillingStore } from '@pushform/cloud';
import { formatAccountTime } from '../accountContext';

function formatBillingAmount(offer: BillingSummary['offers'][number]): string {
  // Stripe charge units differ from ISO currency digits for ISK and UGX.
  // https://docs.stripe.com/currencies#special-cases
  const currency = offer.currency.toLowerCase();
  const zeroDecimal = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
  const threeDecimal = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);
  const digits = zeroDecimal.has(currency) ? 0 : threeDecimal.has(currency) ? 3 : 2;
  const displayDigits = currency === 'isk' || currency === 'ugx' ? 0 : digits;
  const format = new Intl.NumberFormat(undefined, { style: 'currency', currency: offer.currency, minimumFractionDigits: displayDigits, maximumFractionDigits: displayDigits });
  return format.format(offer.amount / 10 ** digits);
}

export function formatBillingPrice(offer: BillingSummary['offers'][number]): string {
  return `${formatBillingAmount(offer)} / ${offer.interval === 'month' ? 'month' : 'year'}`;
}

export function annualBillingComparison(annual: BillingSummary['offers'][number], monthly: BillingSummary['offers'][number] | undefined): { monthlyEquivalent: string; yearlyTotal: string; savingsPercent: number | null } {
  const savings = monthly && monthly.currency.toLowerCase() === annual.currency.toLowerCase() && monthly.amount > 0
    ? Math.round((1 - annual.amount / (monthly.amount * 12)) * 100) : null;
  return { monthlyEquivalent: formatBillingAmount({ ...annual, amount: annual.amount / 12 }), yearlyTotal: formatBillingAmount(annual), savingsPercent: savings !== null && savings > 0 ? savings : null };
}

/** Use the system browser on desktop; browser checkout opens a separate tab to preserve document edits. */
async function openBilling(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
    return;
  }
  const link = document.createElement('a');
  link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.click();
}

export function AccountBilling({ billing, state }: { billing: CloudBillingStore; state: CloudBillingState }): JSX.Element | null {
  const generation = useRef(0);
  const [selectedInterval, setSelectedInterval] = useState<BillingInterval>('year');
  const [destination, setDestination] = useState<{ url: string; kind: 'checkout' | 'portal' } | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void billing.reload();
    const refresh = (): void => { void billing.reload(); };
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('focus', refresh); };
  }, [billing]);
  useEffect(() => {
    generation.current++;
    setDestination(null); setError(null); setOpening(false);
    return () => { generation.current++; };
  }, [billing, state.ownerId]);
  useEffect(() => {
    if (state.returned !== 'success' || state.summary?.subscription?.status === 'active' || state.summary?.subscription?.status === 'trialing') return;
    // A successful browser return may reach the app before the payment webhook.
    let attempts = 0;
    const timer = setInterval(() => { void billing.reload(); if (++attempts >= 12) clearInterval(timer); }, 5000);
    return () => clearInterval(timer);
  }, [billing, state.returned, state.summary?.subscription?.status]);
  const summary = state.summary;
  if (state.status === 'signedOut') return null;
  const subscription = summary?.subscription;
  const active = subscription?.status === 'active' || subscription?.status === 'trialing';
  const subscribed = subscription && subscription.status !== 'canceled' && subscription.status !== 'incomplete_expired';
  const busy = opening || state.busy !== null;
  const selectedOffer = summary?.offers.find(offer => offer.interval === selectedInterval) ?? summary?.offers.find(offer => offer.interval === 'year') ?? summary?.offers[0];
  const prepare = async (kind: 'checkout' | 'portal', interval: BillingInterval = 'month'): Promise<void> => {
    const current = generation.current;
    setDestination(null); setError(null); setOpening(true);
    try {
      const value = kind === 'checkout' ? await billing.checkout(interval) : await billing.portal();
      if (!value || current !== generation.current) return;
      const url = billingHostedUrl({ url: value }, kind);
      // A direct link opens the payment tab from a user gesture and preserves the editor.
      setDestination({ url, kind });
    } catch { if (current === generation.current) setError('Could not open billing. Please try again.'); }
    finally { if (current === generation.current) setOpening(false); }
  };
  return <section className="pf-account-section" aria-labelledby="pf-account-billing-title">
    <h3 id="pf-account-billing-title">Plan and billing</h3>
    {state.status === 'loading' ? <p role="status">Loading billing…</p> : null}
    {summary ? <>
      <p>Current plan: <strong>{active ? 'Individual' : 'Community'}</strong></p>
      {subscription ? <>
        <p>{subscription.status === 'past_due' || subscription.status === 'unpaid' ? 'Your payment needs attention. Manage billing to update your payment method.'
          : subscription.status === 'incomplete' ? 'Your subscription is waiting for payment.'
          : subscription.status === 'canceled' ? 'Your subscription has ended.'
          : subscription.status === 'paused' ? 'Your subscription is paused.'
          : null}</p>
        {subscription.currentPeriodEnd && active ? <p>{subscription.cancelAtPeriodEnd ? 'Scheduled to end' : 'Current billing period ends'} on {formatAccountTime(subscription.currentPeriodEnd)}.</p> : null}
      </> : null}
      {summary.canManageBilling ? <button type="button" disabled={busy} onClick={() => { void prepare('portal'); }}>Manage billing…</button> : null}
      {summary.available && !subscribed && selectedOffer ? <fieldset className="pf-billing-options" disabled={busy}>
        <legend>Individual billing</legend>
        {[...summary.offers].sort((a, b) => a.interval === b.interval ? 0 : a.interval === 'year' ? -1 : 1).map(offer => {
          const annual = offer.interval === 'year' ? annualBillingComparison(offer, summary.offers.find(item => item.interval === 'month')) : null;
          return <label className="pf-billing-choice" key={offer.interval}>
            <input type="radio" name="individual-billing-interval" value={offer.interval} checked={selectedOffer.interval === offer.interval}
              onChange={() => { setSelectedInterval(offer.interval); setDestination(null); }} />
            <span>{annual ? <>Annual — {annual.monthlyEquivalent} / month. Billed {annual.yearlyTotal} yearly.{annual.savingsPercent ? <> Save {annual.savingsPercent}%.</> : null}</>
              : <>Monthly — {formatBillingPrice(offer)}</>}</span>
          </label>;
        })}
        <button type="button" disabled={busy} onClick={() => { void prepare('checkout', selectedOffer.interval); }}>
          Continue with {selectedOffer.interval === 'year' ? 'annual' : 'monthly'} Individual…
        </button>
      </fieldset> : null}
      {!summary.available && !summary.canManageBilling ? <p>Individual subscriptions are not available for purchase yet.</p> : null}
    </> : null}
    {state.returned === 'success' ? <p role="status">{active ? 'Your Individual subscription is active.' : 'Checkout returned. Waiting for payment confirmation; this can take a moment.'}</p>
      : state.returned === 'cancelled' ? <p role="status">Checkout was cancelled. No subscription change has been confirmed.</p>
      : state.returned === 'returned' ? <p role="status">Billing details refreshed.</p> : null}
    {destination ? <p><a href={destination.url} target="_blank" rel="noopener noreferrer" onClick={event => {
      if (!isTauri()) return;
      event.preventDefault();
      void openBilling(destination.url).catch(() => setError('Could not open your browser. Please try again.'));
    }}>Continue to {destination.kind === 'checkout' ? 'secure checkout' : 'billing management'} ↗</a></p> : null}
    {busy ? <p role="status">Preparing secure billing…</p> : null}
    {state.error || error ? <p className="pf-account-error" role="alert">{state.error ?? error}</p> : null}
    <button type="button" disabled={busy} onClick={() => { void billing.reload(); }}>Refresh billing</button>
  </section>;
}
