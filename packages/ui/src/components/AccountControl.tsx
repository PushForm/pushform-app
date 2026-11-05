// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useContext, useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react';
import { createPortal } from 'react-dom';
import {
  CloudSession, cloudProfileFullName, type CloudAccountState, type CloudAccountStore, type CloudProfileState, type CloudProfileStore, type CloudSessionState,
} from '@pushform/cloud';
import { AccountContext, useAccountState } from '../accountContext';
import { BillingContext, useBillingState } from '../billingContext';
import { AccountBilling } from './AccountBilling';
import { ProfileContext, useProfileState } from '../profileContext';
import { DeletionSection, ExportSection } from './AccountLifecycle';
import { ProfileForm } from './ProfileForm';
import { Icon } from './Icon';

/** Native details hides its contents without layout information in jsdom. Inspect ancestry explicitly. */
function accountFocusTargets(root: HTMLElement): HTMLElement[] {
  const targets = root.querySelectorAll<HTMLElement>('button, input:not([type="hidden"]), select, textarea, a[href], summary, [tabindex]');
  return [...targets].filter(target => {
    if (target.matches(':disabled') || (target.hasAttribute('tabindex') && target.tabIndex < 0)) return false;
    for (let element: HTMLElement | null = target; element && root.contains(element); element = element.parentElement) {
      if (element.hidden || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (element.tagName === 'DETAILS' && !element.hasAttribute('open')) {
        const summary = [...element.children].find(child => child.tagName === 'SUMMARY');
        if (!summary?.contains(target)) return false;
      }
    }
    return true;
  });
}

export function AccountControl({ cloud: supplied, onExtensions, compact = false }: { cloud?: CloudSession | undefined; compact?: boolean;
  /** Opens the extension manager; the account dialog offers it when given. */
  onExtensions?: (() => void) | undefined }): JSX.Element {
  const [unconfigured] = useState(() => new CloudSession(null));
  const cloud = supplied ?? unconfigured;
  const state = useSyncExternalStore(cloud.subscribe, cloud.getSnapshot);
  const profiles = useContext(ProfileContext);
  const profileState = useProfileState(profiles);
  const account = useContext(AccountContext);
  const accountState = useAccountState(account);
  const billing = useContext(BillingContext);
  const billingState = useBillingState(billing);
  const [open, setOpen] = useState(false);
  useEffect(() => { void cloud.start(); }, [cloud]);
  useEffect(() => { if (state.error || billingState.returned) setOpen(true); }, [state.error, billingState.returned]);
  if (state.status !== 'signedIn' || !state.user) return <></>;
  // The header names the account holder once their profile is known; the email stays in the tooltip.
  const profile = profileState.ownerId === state.user.id ? profileState.profile : null;
  const name = profile ? cloudProfileFullName(profile) : state.user.email;
  return <>
    <button type="button" className={`pf-account-button${compact ? ' is-compact' : ''}`}
      aria-label={`Account: ${profile ? `${name}, ${state.user.email}` : name}`}
      title={`Account: ${profile ? `${name} (${state.user.email})` : name}`} onClick={() => setOpen(true)}>
      <Icon name="account" />{!compact && <span>{name}</span>}
    </button>
    {open ? <AccountDialog cloud={cloud} state={state} profiles={profile ? profiles : null} profileState={profileState}
      account={account && accountState.ownerId === state.user.id && accountState.status === 'ready' ? account : null} accountState={accountState}
      onClose={() => { billing?.clearReturn(); cloud.clearError(); profiles?.clearError(); account?.clearError(); setOpen(false); }}
      onExtensions={onExtensions ? () => { setOpen(false); onExtensions(); } : undefined} /> : null}
  </>;
}

function AccountDialog({ cloud, state, profiles, profileState, account, accountState, onClose, onExtensions }: {
  cloud: CloudSession; state: CloudSessionState; profiles: CloudProfileStore | null; profileState: CloudProfileState;
  /** Only while the account's deletion and export state has loaded. */
  account: CloudAccountStore | null; accountState: CloudAccountState; onClose: () => void; onExtensions?: (() => void) | undefined;
}): JSX.Element {
  const billing = useContext(BillingContext);
  const billingState = useBillingState(billing);
  const dialog = useRef<HTMLDivElement>(null), close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>('.pf-app'), wasInert = app?.inert ?? false;
    if (app) app.inert = true;
    const initial = dialog.current ? accountFocusTargets(dialog.current) : [];
    (initial.find(target => target.tagName === 'INPUT') ?? initial[0])?.focus();
    const keydown = (event: KeyboardEvent): void => {
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key === 'Tab') {
        event.preventDefault();
        const targets = dialog.current ? accountFocusTargets(dialog.current) : [];
        if (!targets.length) return;
        const index = targets.indexOf(document.activeElement as HTMLElement);
        const next = index < 0 ? (event.shiftKey ? targets.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length;
        targets[next]?.focus();
      }
    };
    const keyup = (event: KeyboardEvent): void => event.stopImmediatePropagation();
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', keyup, true);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('keyup', keyup, true);
      if (app) app.inert = wasInert;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const pending = state.pending !== null;
  const pro = billingState.status === 'ready' && billingState.ownerId === state.user?.id
    && (billingState.summary?.subscription?.status === 'active' || billingState.summary?.subscription?.status === 'trialing');
  return createPortal(<div className="pf-modal-backdrop">
    <div ref={dialog} className="pf-modal pf-account-dialog" role="dialog" aria-modal="true" aria-labelledby="pf-account-title">
      <div className="pf-account-heading"><div className="pf-account-title-row"><h2 id="pf-account-title">Your account</h2>
        {pro ? <span className="pf-account-pro">Pro</span> : null}</div>
        <button type="button" className="pf-iconbtn" aria-label="Close account dialog" onClick={onClose}><Icon name="close" /></button>
      </div>
      {state.error ? <p className="pf-account-error" role="alert">{state.error}</p> : null}
      <div className="pf-account-session-row">
        <p>Signed in as <strong>{state.user?.email}</strong></p>
        <button className="pf-btn" type="button" disabled={pending} onClick={() => {
          void cloud.signOut().then(ok => { if (ok) close.current(); });
        }}>{state.pending === 'signingOut' ? 'Signing out…' : 'Sign out'}</button>
      </div>
      {profiles ? <section className="pf-account-profile" aria-labelledby="pf-account-profile-title">
        <h3 id="pf-account-profile-title">Profile</h3>
        <p>Your name and company also fill the account auto-text in Layout documents.</p>
        <ProfileForm profiles={profiles} state={profileState} submitLabel="Save profile" savingLabel="Saving…" termsLocked
          mailingPreference={<MailingPreference key={profileState.ownerId} profiles={profiles} />} />
      </section> : null}
      {billing && billingState.ownerId === state.user?.id ? <AccountBilling key={billingState.ownerId} billing={billing} state={billingState} /> : null}
      {accountState.ownerId === state.user?.id && accountState.error ? <p className="pf-account-error" role="alert">{accountState.error}</p> : null}
      {onExtensions ? <section className="pf-account-extensions" aria-labelledby="pf-account-extensions-title">
        <h3 id="pf-account-extensions-title">Extensions</h3>
        <p>Add features to PushForm, and see what your extensions can do.</p>
        <button type="button" className="pf-btn" onClick={onExtensions}>Manage extensions…</button>
      </section> : null}
      <details className="pf-account-danger-zone">
        <summary tabIndex={0}>Danger Zone</summary>
        <div className="pf-account-danger-content">
          {account ? <>
            <ExportSection account={account} state={accountState} email={state.user?.email ?? 'your email address'} />
            <DeletionSection account={account} state={accountState} />
          </> : null}
        </div>
      </details>
    </div>
  </div>, document.body);
}

export function MailingPreference({ profiles }: { profiles: CloudProfileStore }): JSX.Element | null {
  const [choice, setChoice] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    void profiles.readMailingPreference?.().then(value => { if (active) setChoice(value); })
      .catch(() => { if (active) setError('Could not load your mailing preference.'); });
    return () => { active = false; };
  }, [profiles, retry]);
  if (!profiles.readMailingPreference || !profiles.saveMailingPreference) return null;
  return <section aria-label="Mailing list">
    <label className="pf-profile-check"><input type="checkbox" checked={choice ?? false}
      disabled={choice === null || pending} onChange={event => {
        const next = event.target.checked;
        setPending(true); setError(null); setSaved(false);
        void profiles.saveMailingPreference!(next).then(value => { setChoice(value); setSaved(true); })
          .catch(() => setError('Could not save your mailing preference. Please try again.'))
          .finally(() => setPending(false));
      }} /><span>Join the mailing list (optional)</span></label>
    <p>PushForm news and updates. You can leave at any time. Email unsubscribe links are handled separately.</p>
    {error ? <p role="alert">{error} {choice === null ? <button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button> : null}</p> : null}
    {pending ? <p role="status">Saving mailing preference…</p> : saved ? <p role="status">Your mailing preference was saved.</p> : null}
  </section>;
}
