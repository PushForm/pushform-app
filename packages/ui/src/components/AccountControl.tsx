// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useContext, useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react';
import { createPortal } from 'react-dom';
import {
  CloudSession, cloudProfileFullName, type CloudAccountState, type CloudAccountStore, type CloudProfileState, type CloudProfileStore, type CloudSessionState,
} from '@pushform/cloud';
import { AccountContext, useAccountState } from '../accountContext';
import { ProfileContext, useProfileState } from '../profileContext';
import { DeletionSection, ExportSection } from './AccountLifecycle';
import { ProfileForm } from './ProfileForm';
import { Icon } from './Icon';

export function AccountControl({ cloud: supplied }: { cloud?: CloudSession | undefined }): JSX.Element {
  const [unconfigured] = useState(() => new CloudSession(null));
  const cloud = supplied ?? unconfigured;
  const state = useSyncExternalStore(cloud.subscribe, cloud.getSnapshot);
  const profiles = useContext(ProfileContext);
  const profileState = useProfileState(profiles);
  const account = useContext(AccountContext);
  const accountState = useAccountState(account);
  const [open, setOpen] = useState(false);
  useEffect(() => { void cloud.start(); }, [cloud]);
  useEffect(() => { if (state.error) setOpen(true); }, [state.error]);
  if (state.status !== 'signedIn' || !state.user) return <></>;
  // The header names the account holder once their profile is known; the email stays in the tooltip.
  const profile = profileState.ownerId === state.user.id ? profileState.profile : null;
  const name = profile ? cloudProfileFullName(profile) : state.user.email;
  return <>
    <button type="button" className="pf-account-button"
      aria-label={`Account: ${profile ? `${name}, ${state.user.email}` : name}`}
      title={`Account: ${profile ? `${name} (${state.user.email})` : name}`} onClick={() => setOpen(true)}>
      <Icon name="account" /><span>{name}</span>
    </button>
    {open ? <AccountDialog cloud={cloud} state={state} profiles={profile ? profiles : null} profileState={profileState}
      account={account && accountState.ownerId === state.user.id && accountState.status === 'ready' ? account : null} accountState={accountState}
      onClose={() => { cloud.clearError(); profiles?.clearError(); account?.clearError(); setOpen(false); }} /> : null}
  </>;
}

function AccountDialog({ cloud, state, profiles, profileState, account, accountState, onClose }: {
  cloud: CloudSession; state: CloudSessionState; profiles: CloudProfileStore | null; profileState: CloudProfileState;
  /** Only while the account's deletion and export state has loaded. */
  account: CloudAccountStore | null; accountState: CloudAccountState; onClose: () => void;
}): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null), close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>('.pf-app'), wasInert = app?.inert ?? false;
    if (app) app.inert = true;
    (dialog.current?.querySelector<HTMLElement>('input:not(:disabled)') ?? dialog.current?.querySelector<HTMLElement>('button'))?.focus();
    const keydown = (event: KeyboardEvent): void => {
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key === 'Tab') {
        event.preventDefault();
        const targets = [...dialog.current!.querySelectorAll<HTMLElement>(':is(button, input, select, a[href], [tabindex="0"]):not(:disabled)')];
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
  return createPortal(<div className="pf-modal-backdrop">
    <div ref={dialog} className="pf-modal pf-account-dialog" role="dialog" aria-modal="true" aria-labelledby="pf-account-title">
      <div className="pf-account-heading"><h2 id="pf-account-title">Your account</h2>
        <button type="button" className="pf-iconbtn" aria-label="Close account dialog" onClick={onClose}><Icon name="close" /></button>
      </div>
      {state.error ? <p className="pf-account-error" role="alert">{state.error}</p> : null}
      <p>Signed in as <strong>{state.user?.email}</strong></p>
      {profiles ? <section className="pf-account-profile" aria-labelledby="pf-account-profile-title">
        <h3 id="pf-account-profile-title">Profile</h3>
        <p>Your name and company also fill the account auto-text in Layout documents.</p>
        <ProfileForm profiles={profiles} state={profileState} submitLabel="Save profile" savingLabel="Saving…" termsLocked />
      </section> : null}
      {account ? <>
        {accountState.error ? <p className="pf-account-error" role="alert">{accountState.error}</p> : null}
        <ExportSection account={account} state={accountState} email={state.user?.email ?? 'your email address'} />
        <DeletionSection account={account} state={accountState} />
      </> : null}
      <p>Signing out returns you to the sign-in screen. Your open documents will be available when you sign back in.</p>
      <button className="pf-account-primary" type="button" disabled={pending} onClick={() => {
          void cloud.signOut().then(ok => { if (ok) close.current(); });
      }}>{state.pending === 'signingOut' ? 'Signing out…' : 'Sign out'}</button>
    </div>
  </div>, document.body);
}
