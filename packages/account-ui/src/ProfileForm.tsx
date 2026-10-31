// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useId, useRef, useState, type FormEvent, type JSX } from 'react';
import {
  CLOUD_COMPANY_SIZES, CLOUD_INDUSTRIES, CLOUD_TERMS_URL, cloudProfileErrors, cloudProfileInput,
  type CloudCompanySize, type CloudIndustry, type CloudProfileField, type CloudProfileInput, type CloudProfileState,
  type CloudProfileStore, type CloudSession, type CloudSessionState,
} from '@pushform/cloud';

/**
 * The profile fields shared by the signup step and account details. Company reveals the company name and
 * size; Other reveals a short description. Field messages appear once a save has been attempted.
 */
export function ProfileForm({ profiles, state, submitLabel, savingLabel, termsLocked, onSaved }: {
  profiles: CloudProfileStore; state: CloudProfileState; submitLabel: string; savingLabel: string;
  /** Account details shows accepted terms as read-only: acceptance cannot be withdrawn. */
  termsLocked: boolean; onSaved?: (() => void) | undefined;
}): JSX.Element {
  const id = useId();
  const [input, setInput] = useState<CloudProfileInput>(() => cloudProfileInput(state.profile));
  const [attempted, setAttempted] = useState(false);
  const [saved, setSaved] = useState(false);
  /** Bumped by a refused submit; focus moves to the first invalid field once its message has rendered. */
  const [refused, setRefused] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (refused) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); }, [refused]);
  const errors = cloudProfileErrors(input);
  const shown = attempted ? errors : {};
  const set = (patch: Partial<CloudProfileInput>): void => { setInput(current => ({ ...current, ...patch })); setSaved(false); };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (Object.keys(errors).length) { setRefused(count => count + 1); return; }
    void profiles.save(input).then(ok => { if (ok) { setSaved(true); onSaved?.(); } });
  };
  const field = (name: CloudProfileField): { 'aria-invalid': boolean; 'aria-describedby'?: string } =>
    shown[name] ? { 'aria-invalid': true, 'aria-describedby': `${id}-${name}-error` } : { 'aria-invalid': false };
  const message = (name: CloudProfileField): JSX.Element | null =>
    shown[name] ? <span id={`${id}-${name}-error`} className="pf-profile-field-error">{shown[name]}</span> : null;
  return <form ref={form} className="pf-profile-form" noValidate onSubmit={submit}>
    <div className="pf-profile-names">
      <label>First name
        <input name="firstName" autoComplete="given-name" value={input.firstName} disabled={state.saving}
          onChange={event => set({ firstName: event.target.value })} {...field('firstName')} />
        {message('firstName')}
      </label>
      <label>Last name
        <input name="lastName" autoComplete="family-name" value={input.lastName} disabled={state.saving}
          onChange={event => set({ lastName: event.target.value })} {...field('lastName')} />
        {message('lastName')}
      </label>
    </div>
    <fieldset className="pf-profile-choice" aria-describedby={shown.accountType ? `${id}-accountType-error` : undefined}>
      <legend>I use PushForm</legend>
      <label><input type="radio" name={`${id}-type`} checked={input.accountType === 'company'} disabled={state.saving}
        onChange={() => set({ accountType: 'company' })} {...field('accountType')} />For a company</label>
      <label><input type="radio" name={`${id}-type`} checked={input.accountType === 'individual'} disabled={state.saving}
        onChange={() => set({ accountType: 'individual' })} aria-invalid={Boolean(shown.accountType)} />As an individual</label>
      {message('accountType')}
    </fieldset>
    {input.accountType === 'company' ? <>
      <label>Company name
        <input name="companyName" autoComplete="organization" value={input.companyName} disabled={state.saving}
          onChange={event => set({ companyName: event.target.value })} {...field('companyName')} />
        {message('companyName')}
      </label>
      <label>Company size
        <select name="companySize" value={input.companySize ?? ''} disabled={state.saving}
          onChange={event => set({ companySize: (event.target.value || null) as CloudCompanySize | null })} {...field('companySize')}>
          <option value="">Choose a size</option>
          {CLOUD_COMPANY_SIZES.map(size => <option key={size.id} value={size.id}>{size.label}</option>)}
        </select>
        {message('companySize')}
      </label>
    </> : null}
    <label>Industry
      <select name="industry" value={input.industry ?? ''} disabled={state.saving}
        onChange={event => set({ industry: (event.target.value || null) as CloudIndustry | null })} {...field('industry')}>
        <option value="">Choose an industry</option>
        {CLOUD_INDUSTRIES.map(industry => <option key={industry.id} value={industry.id}>{industry.label}</option>)}
      </select>
      {message('industry')}
    </label>
    {input.industry === 'other' ? <label>Your industry
      <input name="industryOther" value={input.industryOther} disabled={state.saving}
        onChange={event => set({ industryOther: event.target.value })} {...field('industryOther')} />
      {message('industryOther')}
    </label> : null}
    {termsLocked && input.acceptTerms ? <p className="pf-profile-terms">You accepted the <a href={CLOUD_TERMS_URL} target="_blank" rel="noreferrer">Terms of Use</a>.</p>
      : <label className="pf-profile-check">
        <input type="checkbox" name="acceptTerms" checked={input.acceptTerms} disabled={state.saving}
          onChange={event => set({ acceptTerms: event.target.checked })} {...field('acceptTerms')} />
        <span>I accept the <a href={CLOUD_TERMS_URL} target="_blank" rel="noreferrer">Terms of Use</a></span>
      </label>}
    {state.profile === null ? <label className="pf-profile-check">
      <input type="checkbox" name="mailingOptIn" checked={input.mailingOptIn ?? false} disabled={state.saving}
        onChange={event => set({ mailingOptIn: event.target.checked })} />
      <span>Send me PushForm news and updates by email (optional)</span>
    </label> : null}
    {state.error ? <p className="pf-account-error" role="alert">{state.error}</p> : null}
    {saved && !state.error ? <p role="status">Your profile was saved.</p> : null}
    <button className="pf-account-primary" type="submit" disabled={state.saving || !input.acceptTerms}>
      {state.saving ? savingLabel : submitLabel}
    </button>
  </form>;
}

/**
 * The one-time signup step after authentication: no workspace, dismiss, or skip until a profile with the
 * current terms is saved. Signing out returns to the sign-in screen.
 */
export function ProfileScreen({ cloud, session, profiles, state }: {
  cloud: CloudSession; session: CloudSessionState; profiles: CloudProfileStore; state: CloudProfileState;
}): JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);
  const loading = state.status === 'loading' || state.status === 'signedOut';
  useEffect(() => { if (!loading) heading.current?.focus(); }, [loading]);
  const returning = state.profile !== null;
  return <main className="pf-signin-screen" aria-label="Set up your account">
    <section className="pf-signin-card pf-profile-card" aria-labelledby="pf-profile-title">
      <div className="pf-signin-brand"><img src="/pf-logo-mark.svg" alt="" width={32} height={32} /><span>PushForm</span></div>
      {loading ? <p role="status">Loading your account…</p>
        : state.status === 'error' ? <>
          <h1 id="pf-profile-title" ref={heading} tabIndex={-1}>Your account could not be loaded</h1>
          <p className="pf-account-error" role="alert">{state.error}</p>
          <div className="pf-account-secondary">
            <button type="button" className="pf-account-primary" onClick={() => { void profiles.reload(); }}>Try again</button>
          </div>
        </> : <>
          <h1 id="pf-profile-title" ref={heading} tabIndex={-1}>{returning ? 'Review the updated terms' : 'Tell us about yourself'}</h1>
          <p>{returning ? 'The Terms of Use have changed. Check your details and accept the new terms to continue.'
            : <>Signed in as <strong>{session.user?.email}</strong>. You can change these details later from your account.</>}</p>
          <ProfileForm profiles={profiles} state={state} submitLabel="Continue" savingLabel="Saving…" termsLocked={false} />
        </>}
      <div className="pf-account-secondary">
        <button type="button" disabled={session.pending !== null} onClick={() => { void cloud.signOut(); }}>
          {session.pending === 'signingOut' ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </section>
  </main>;
}
