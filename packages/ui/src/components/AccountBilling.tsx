// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type JSX } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { billingHostedUrl, type CloudBillingState, type CloudBillingStore } from '@pushform/cloud';

/** Account billing opens provider destinations from the original user gesture. */
export function AccountBilling({ billing, state }: { billing: CloudBillingStore; state: CloudBillingState }): JSX.Element | null {
  const generation = useRef(0);
  const pending = useRef<{ popup: Window; kind: 'checkout' | 'portal' } | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subscription = state.summary?.subscription;
  const subscribed = Boolean(subscription && subscription.status !== 'canceled' && subscription.status !== 'incomplete_expired');
  const latest = useRef({ owner: state.ownerId, subscribed });
  latest.current = { owner: state.ownerId, subscribed };
  const closeBlank = (): void => {
    const current = pending.current; pending.current = null;
    try { current?.popup.close(); } catch { /* A closed browser window needs no further action. */ }
  };
  useEffect(() => {
    void billing.reload();
    const refresh = (): void => { void billing.reload(); };
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('focus', refresh); };
  }, [billing]);
  useEffect(() => {
    generation.current++;
    closeBlank(); setError(null); setOpening(false);
    return () => { generation.current++; closeBlank(); };
  }, [billing, state.ownerId]);
  useEffect(() => {
    if (!subscribed) return;
    if (pending.current?.kind === 'checkout') { generation.current++; closeBlank(); setOpening(false); }
  }, [subscribed]);
  useEffect(() => {
    if (state.returned !== 'success' || subscription?.status === 'active' || subscription?.status === 'trialing') return;
    let attempts = 0;
    const timer = setInterval(() => { void billing.reload(); if (++attempts >= 12) clearInterval(timer); }, 5000);
    return () => clearInterval(timer);
  }, [billing, state.returned, subscription?.status]);
  const summary = state.summary;
  const busy = opening || state.busy !== null;
  const ready = state.status === 'ready' && Boolean(state.ownerId && summary);
  const open = async (kind: 'checkout' | 'portal'): Promise<void> => {
    if (!ready || busy) return;
    const current = generation.current, owner = state.ownerId, desktop = isTauri();
    setError(null);
    let popup: Window | null = null;
    if (!desktop) {
      try {
        popup = window.open('about:blank', '_blank');
        if (!popup) { setError('Allow pop-ups to open billing, then try again.'); return; }
        popup.opener = null;
        pending.current = { popup, kind };
      } catch {
        try { popup?.close(); } catch { /* Nothing else to close. */ }
        setError('Could not open your browser. Please try again.'); return;
      }
    }
    setOpening(true);
    const currentAccount = (): boolean => current === generation.current && latest.current.owner === owner
      && !(kind === 'checkout' && latest.current.subscribed);
    try {
      const value = kind === 'checkout' ? await billing.checkout('month') : await billing.portal();
      if (!currentAccount()) return;
      if (!value) throw new Error('Billing destination unavailable');
      const url = billingHostedUrl({ url: value }, kind);
      if (desktop) {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        if (!currentAccount()) return;
        await openUrl(url);
      } else {
        if (!popup || popup.closed) throw new Error('Billing window was closed');
        popup.location.assign(url);
        pending.current = null;
      }
    } catch {
      if (currentAccount()) setError('Could not open billing. Please try again.');
    } finally {
      if (pending.current?.popup === popup) closeBlank();
      if (current === generation.current) setOpening(false);
    }
  };
  if (state.status === 'signedOut') return null;
  return <section className="pf-account-section" aria-labelledby="pf-account-billing-title">
    <h3 id="pf-account-billing-title">Plan and billing</h3>
    <p>Current plan: <strong>{summary ? (subscribed ? 'Individual' : 'Community') : state.status === 'loading' ? 'Loading…' : 'Unavailable'}</strong></p>
    <button type="button" className={subscribed ? undefined : 'pf-account-subscribe'} disabled={busy || (!ready && state.status !== 'error') || (ready && subscribed && !summary?.canManageBilling) || (ready && !subscribed && !summary?.available)} onClick={() => {
      if (state.status === 'error') {
        const current = generation.current; setError(null); setOpening(true);
        void billing.reload().catch(() => { if (current === generation.current) setError('Could not load billing. Please try again.'); })
          .finally(() => { if (current === generation.current) setOpening(false); });
        return;
      }
      if (subscribed) void open('portal');
      else void open('checkout');
    }}>{subscribed ? 'Manage account' : 'Subscribe now'}</button>
    {state.status === 'loading' ? <p role="status">Loading billing…</p> : busy ? <p role="status">Opening secure billing…</p> : null}
    {error || state.error ? <p className="pf-account-error" role="alert">{error ?? state.error}</p> : null}
  </section>;
}
