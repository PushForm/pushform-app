// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js';

/** Only identity and UI state leave this layer; access/refresh tokens remain with the SDK. */
export interface CloudUser { readonly id: string; readonly email: string }
export interface CloudSessionState {
  readonly status: 'unavailable' | 'restoring' | 'signedOut' | 'signedIn';
  readonly user: CloudUser | null;
  readonly expiresAt: number | null;
  readonly pending: 'sending' | 'verifying' | 'signingOut' | null;
  readonly emailSentTo: string | null;
  readonly resendAt: number;
  readonly error: string | null;
}
export type AuthCallback = { kind: 'code'; code: string; flowId?: string } |
  { kind: 'emailToken'; tokenHash: string } | { kind: 'error' };
export type AuthApi = Pick<SupabaseClient['auth'],
  'initialize' | 'getSession' | 'onAuthStateChange' | 'signInWithOtp' | 'verifyOtp' |
  'exchangeCodeForSession' | 'signOut'>;

const LINK_ERROR = 'This sign-in link is invalid or expired. Open it in the browser where you requested it, enter the email code, or request a new email.';
const EXPIRED = 'Your session expired. Sign in again to continue.';
const empty: CloudSessionState = { status: 'signedOut', user: null, expiresAt: null,
  pending: null, emailSentTo: null, resendAt: 0, error: null };

function errorMessage(error: unknown, fallback: string): string {
  const e = error as { code?: string; status?: number; name?: string } | null;
  if (e?.status === 429 || e?.code === 'over_email_send_rate_limit' || e?.code === 'over_request_rate_limit')
    return 'Too many sign-in attempts. Please wait a minute and try again.';
  if (e?.code === 'otp_expired') return 'This code has expired or was already used. Request a new sign-in email.';
  if (e?.status === 0 || e?.name === 'AuthRetryableFetchError' || e?.name === 'TypeError')
    return 'Could not reach the sign-in service. Check your connection and try again.';
  // Provider errors can contain callback URLs. Do not echo raw messages or credentials into the UI.
  return fallback;
}

/** One app-wide account session, independent of document tabs and their undo/recovery state. */
export class CloudSession {
  private state: CloudSessionState;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private started: Promise<void> | null = null;
  private disposed = false;
  private authRevision = 0;
  private operation = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly auth: AuthApi | null,
    private readonly redirectTo = '',
    private callback: AuthCallback | null = null,
    private readonly shutdown?: () => void,
  ) {
    this.state = { ...empty, status: auth ? 'restoring' : 'unavailable' };
  }

  getSnapshot = (): CloudSessionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<CloudSessionState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Idempotent, including React remounts. Auth callbacks never await other auth calls. */
  start(): Promise<void> {
    if (!this.auth || this.disposed) return Promise.resolve();
    if (this.started) return this.started;
    const { data } = this.auth.onAuthStateChange((event, session) => this.onAuthEvent(event, session));
    this.unsubscribe = () => data.subscription.unsubscribe();
    this.started = this.initialize();
    return this.started;
  }

  private async initialize(): Promise<void> {
    const auth = this.auth!;
    let failure: string | null = null;
    try {
      const initialized = await auth.initialize();
      if (this.disposed) return;
      if (initialized.error) failure = errorMessage(initialized.error, 'Could not restore your account session. Try signing in again.');
      const callback = this.callback;
      this.callback = null; // A link can only be exchanged once, even across UI remounts.
      if (callback) {
        if (callback.kind === 'error') failure = LINK_ERROR;
        else {
          const response = callback.kind === 'code'
            ? await auth.exchangeCodeForSession(callback.code, callback.flowId ? { flowId: callback.flowId } : undefined)
            : await auth.verifyOtp({ token_hash: callback.tokenHash, type: 'email' });
          if (response.error) failure = LINK_ERROR;
        }
      }
      const revision = this.authRevision;
      const { data, error } = await auth.getSession();
      if (this.disposed) return;
      // A sign-out or refresh event wins over an older session read.
      if (revision === this.authRevision) this.setIdentity(error ? null : data.session);
      if (error) failure = errorMessage(error, 'Could not restore your account session. Try signing in again.');
      if (failure) this.update({ error: failure });
    } catch (error) {
      this.update({ status: this.state.user ? 'signedIn' : 'signedOut',
        error: errorMessage(error, 'Could not restore your account session. Try signing in again.') });
    }
  }

  private onAuthEvent(event: AuthChangeEvent, session: Session | null): void {
    if (this.disposed) return;
    this.authRevision++;
    this.setIdentity(session);
    if (event === 'SIGNED_IN') this.update({ error: null, emailSentTo: null, resendAt: 0 });
    if (event === 'SIGNED_OUT') this.update({ emailSentTo: null, resendAt: 0 });
  }

  private setIdentity(session: Session | null): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const expiresAt = session?.expires_at ? session.expires_at * 1000 : null;
    const expired = expiresAt !== null && expiresAt <= Date.now();
    const user = !expired && session?.user?.id && session.user.email
      ? { id: session.user.id, email: session.user.email } : null;
    this.update({ status: user ? 'signedIn' : 'signedOut', user, expiresAt: user ? expiresAt : null,
      ...(expired ? { error: EXPIRED } : user && this.state.error === EXPIRED ? { error: null } : {}) });
    if (user && expiresAt) {
      this.expiryTimer = setTimeout(() => this.setIdentity(session), Math.min(expiresAt - Date.now() + 1, 2_147_483_647));
      // Node tests/CLI should not stay alive solely to watch an auth expiry.
      (this.expiryTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  /**
   * The current access token for first-party backend calls (the pipeline backend receives the
   * Supabase session token). Read on demand from the SDK, never stored in the UI snapshot; null when
   * signed out, unconfigured or disposed.
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.auth || this.disposed || this.state.status !== 'signedIn') return null;
    try {
      const { data, error } = await this.auth.getSession();
      return !error && data.session?.access_token && this.state.status === 'signedIn' ? data.session.access_token : null;
    } catch { return null; }
  }

  clearError(): void { this.update({ error: null }); }
  changeEmail(): void {
    if (!this.state.pending) this.update({ emailSentTo: null, resendAt: 0, error: null });
  }

  async sendSignInEmail(value: string): Promise<boolean> {
    if (!this.auth || this.disposed || this.state.pending || this.state.status !== 'signedOut') return false;
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
      this.update({ error: 'Enter a valid email address.' }); return false;
    }
    if (Date.now() < this.state.resendAt) {
      this.update({ error: 'Please wait before requesting another sign-in email.' }); return false;
    }
    const request = ++this.operation;
    this.update({ pending: 'sending', error: null });
    try {
      const { error } = await this.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: this.redirectTo } });
      if (this.disposed || request !== this.operation) return false;
      if (error) throw error;
      if (this.state.status === 'signedOut') this.update({ emailSentTo: email, resendAt: Date.now() + 60_000 });
      return true;
    } catch (error) {
      if (request === this.operation) this.update({ error: errorMessage(error, 'Could not send a sign-in email. Please try again.') });
      return false;
    } finally { if (request === this.operation) this.update({ pending: null }); }
  }

  async verifyCode(value: string): Promise<boolean> {
    if (!this.auth || this.disposed || this.state.pending || this.state.status !== 'signedOut' || !this.state.emailSentTo) return false;
    const token = value.replace(/\s/g, '');
    // Supabase email OTPs are 6 to 10 digits, set per project; accept the whole range so a hosted change cannot lock users out.
    if (!/^\d{6,10}$/.test(token)) { this.update({ error: 'Enter the code from your email (6 to 10 digits).' }); return false; }
    const request = ++this.operation;
    this.update({ pending: 'verifying', error: null });
    try {
      const { data, error } = await this.auth.verifyOtp({ email: this.state.emailSentTo, token, type: 'email' });
      if (this.disposed || request !== this.operation) return false;
      if (error) throw error;
      if (!data.session) throw new Error('Missing session');
      this.setIdentity(data.session);
      if (this.getSnapshot().status !== 'signedIn') throw new Error('Invalid session');
      this.update({ emailSentTo: null, resendAt: 0 });
      return true;
    } catch (error) {
      if (request === this.operation) this.update({ error: errorMessage(error, 'This code could not be verified. Check the code or request a new email.') });
      return false;
    } finally { if (request === this.operation) this.update({ pending: null }); }
  }

  async signOut(): Promise<boolean> {
    if (!this.auth || this.disposed || this.state.pending || this.state.status !== 'signedIn') return false;
    const request = ++this.operation;
    this.update({ pending: 'signingOut', error: null });
    try {
      const { error } = await this.auth.signOut({ scope: 'local' });
      if (this.disposed || request !== this.operation) return false;
      if (error) throw error;
      this.setIdentity(null);
      this.update({ emailSentTo: null, resendAt: 0 });
      return true;
    } catch (error) {
      if (request === this.operation) this.update({ error: errorMessage(error, 'Could not sign out. Check your connection and try again.') });
      return false;
    } finally { if (request === this.operation) this.update({ pending: null }); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.operation++;
    this.unsubscribe?.(); this.unsubscribe = null;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.listeners.clear();
    this.shutdown?.();
  }
}
