// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import type { CloudSession, CloudSessionState } from '@pushform/cloud';

/** The product entry screen has no workspace or dismiss/guest action. */
export function SignInScreen({ cloud, state }: { cloud: CloudSession; state: CloudSessionState }): JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (state.status !== 'signedOut') heading.current?.focus(); }, [state.status]);
  return <main className="pf-signin-screen" aria-label="Sign in">
    <section className="pf-signin-card" aria-labelledby="pf-signin-title">
      <div className="pf-signin-brand"><img src="/pf-logo-mark.svg" alt="" width={32} height={32} /><span>PushForm</span></div>
      <h1 id="pf-signin-title" ref={heading} tabIndex={-1}>{state.status === 'restoring' ? 'Welcome to PushForm' : 'Sign in to PushForm'}</h1>
      {state.error ? <p className="pf-account-error" role="alert">{state.error}</p> : null}
      {state.status === 'restoring' ? <p role="status">Restoring your session…</p>
        : state.status === 'unavailable' ? <p role="alert">Sign-in is currently unavailable. Please contact the administrator or try again later.</p>
        : <EmailSignIn cloud={cloud} state={state} />}
    </section>
  </main>;
}

function EmailSignIn({ cloud, state }: { cloud: CloudSession; state: CloudSessionState }): JSX.Element {
  const formArea = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState(state.emailSentTo ?? '');
  const [code, setCode] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!state.resendAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.resendAt]);
  useEffect(() => {
    if (!state.pending) formArea.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [state.emailSentTo, state.pending]);
  const pending = state.pending !== null;
  const cooldown = Math.max(0, Math.ceil((state.resendAt - now) / 1000));
  const sendEmail = (event: FormEvent): void => { event.preventDefault(); void cloud.sendSignInEmail(email); };
  const verify = (event: FormEvent): void => { event.preventDefault(); void cloud.verifyCode(code); };
  return <div ref={formArea}>
    {state.emailSentTo ? <>
      <h2>Check your email</h2>
      <p role="status">A sign-in email was sent to <strong>{state.emailSentTo}</strong>.</p>
      <p>Open the link in the browser where you requested it. If your email includes a code, enter it below instead.</p>
      <form onSubmit={verify}>
        <label htmlFor="pf-account-code">Email code</label>
        <input id="pf-account-code" name="code" value={code} onChange={event => setCode(event.target.value.replace(/\s/g, ''))}
          inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,10}" maxLength={10} required disabled={pending} />
        <button className="pf-account-primary" type="submit" disabled={pending}>{state.pending === 'verifying' ? 'Verifying…' : 'Verify code'}</button>
      </form>
      <div className="pf-account-secondary">
        <button type="button" disabled={pending || cooldown > 0} onClick={() => { void cloud.sendSignInEmail(state.emailSentTo!); }}>
          {state.pending === 'sending' ? 'Sending…' : cooldown ? `Resend email (${cooldown}s)` : 'Resend email'}
        </button>
        <button type="button" disabled={pending} onClick={() => { cloud.changeEmail(); setCode(''); }}>Use a different email</button>
      </div>
    </> : <>
      <p>Sign in or create an account to continue. No password required.</p>
      <form onSubmit={sendEmail}>
        <label htmlFor="pf-account-email">Email address</label>
        <input id="pf-account-email" name="email" type="email" autoComplete="email" value={email}
          onChange={event => setEmail(event.target.value)} required disabled={pending} />
        <button className="pf-account-primary" type="submit" disabled={pending}>
          {state.pending === 'sending' ? 'Sending…' : 'Send sign-in email'}
        </button>
      </form>
    </>}
  </div>;
}
