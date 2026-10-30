// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState, type JSX } from 'react';
import type { CloudAccountState, CloudAccountStore } from '@pushform/cloud';
import { formatAccountTime } from '../accountContext';

/**
 * The red banner shown above Home and the editors while the account is marked for deletion, with the time it
 * will be deleted and a Cancel deletion button. The app moves down by the banner's height while it is shown.
 */
export function DeletionBanner({ account, state }: { account: CloudAccountStore; state: CloudAccountState }): JSX.Element | null {
  const deletion = state.deletion;
  useEffect(() => {
    if (!deletion) return;
    document.documentElement.classList.add('pf-has-deletion-banner');
    return () => document.documentElement.classList.remove('pf-has-deletion-banner');
  }, [deletion]);
  if (!deletion) return null;
  return <div className="pf-deletion-banner" role="alert">
    <span>Your account is marked for deletion on <strong>{formatAccountTime(deletion.deleteAfter)}</strong>.
      Your documents and account information will be removed then.</span>
    <button type="button" disabled={state.busy !== null} onClick={() => { void account.cancelDeletion(); }}>
      {state.busy === 'cancel' ? 'Cancelling…' : 'Cancel deletion'}
    </button>
    {state.error ? <span className="pf-deletion-banner-error">{state.error}</span> : null}
  </div>;
}

/** The account dialog's export section. */
export function ExportSection({ account, state, email }: { account: CloudAccountStore; state: CloudAccountState; email: string }): JSX.Element {
  const latest = state.latestExport;
  const building = latest?.status === 'queued' || latest?.status === 'running';
  const status = !latest ? null
    : building ? `Preparing your export. We will email ${email} a download link when it is ready.`
    : latest.status === 'ready' ? `Sent to ${email}${latest.expiresAt ? `. The link works until ${formatAccountTime(latest.expiresAt)}` : ''}.`
    : latest.status === 'failed' ? latest.error ?? 'The export could not be completed. Try again later.'
    : 'Your last export link has expired.';
  return <section className="pf-account-section" aria-labelledby="pf-account-export-title">
    <h3 id="pf-account-export-title">Export your files</h3>
    <p>Get every saved document as native .pf and .pfl files in one zip, arranged by project and folder. We email you a
      download link that works for 24 hours.</p>
    {status ? <p className={latest?.status === 'failed' ? 'pf-account-error' : undefined} role="status">{status}</p> : null}
    <button type="button" disabled={state.busy !== null || building} onClick={() => { void account.requestExport(); }}>
      {state.busy === 'export' ? 'Requesting…' : 'Email me my files'}
    </button>
  </section>;
}

/** The account dialog's deletion section, with a confirmation step before the account is marked. */
export function DeletionSection({ account, state }: { account: CloudAccountStore; state: CloudAccountState }): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const deletion = state.deletion;
  return <section className="pf-account-section pf-account-delete" aria-labelledby="pf-account-delete-title">
    <h3 id="pf-account-delete-title">Delete account</h3>
    {deletion ? <>
      <p>Your account will be deleted on <strong>{formatAccountTime(deletion.deleteAfter)}</strong>. You can cancel until then.</p>
      <button type="button" disabled={state.busy !== null} onClick={() => { void account.cancelDeletion(); }}>
        {state.busy === 'cancel' ? 'Cancelling…' : 'Cancel deletion'}
      </button>
    </> : confirming ? <>
      <p role="alert"><strong>Delete your account?</strong> In 48 hours we permanently delete your documents, projects,
        folders, import history, profile and feature requests, and then your account. You can cancel until then. Export
        your files first if you want to keep them.</p>
      <div className="pf-account-secondary">
        <button type="button" className="pf-account-danger" disabled={state.busy !== null}
          onClick={() => { void account.requestDeletion().then(ok => { if (ok) setConfirming(false); }); }}>
          {state.busy === 'delete' ? 'Marking…' : 'Delete my account'}
        </button>
        <button type="button" onClick={() => setConfirming(false)}>Keep my account</button>
      </div>
    </> : <>
      <p>Deleting your account removes your documents and account information 48 hours after you confirm. You can cancel
        until then.</p>
      <button type="button" disabled={state.busy !== null} onClick={() => { account.clearError(); setConfirming(true); }}>Delete account…</button>
    </>}
  </section>;
}
