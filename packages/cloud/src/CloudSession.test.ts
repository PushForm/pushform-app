// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { CloudSession, type AuthApi } from './CloudSession';

const sessions: CloudSession[] = [];
afterEach(() => { sessions.splice(0).forEach(s => s.dispose()); vi.useRealTimers(); });
function identity(expiresAt = Date.now() + 3_600_000): Session {
  return { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600,
    expires_at: Math.floor(expiresAt / 1000), token_type: 'bearer',
    user: { id: 'user-1', email: 'artist@example.com', app_metadata: {}, user_metadata: {},
      aud: 'authenticated', created_at: '' } };
}
function setup(initial: Session | null = null, callback: ConstructorParameters<typeof CloudSession>[2] = null) {
  let listener: (event: AuthChangeEvent, session: Session | null) => void = () => {};
  const unsubscribe = vi.fn();
  const api = {
    initialize: vi.fn().mockResolvedValue({ error: null }),
    getSession: vi.fn().mockResolvedValue({ data: { session: initial }, error: null }),
    onAuthStateChange: vi.fn(fn => { listener = fn; return { data: { subscription: { unsubscribe } } }; }),
    signInWithOtp: vi.fn().mockResolvedValue({ data: {}, error: null }),
    verifyOtp: vi.fn().mockResolvedValue({ data: { session: identity() }, error: null }),
    exchangeCodeForSession: vi.fn().mockResolvedValue({ data: { session: identity() }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  };
  const cloud = new CloudSession(api as unknown as AuthApi, 'http://localhost:5174/auth/callback', callback);
  sessions.push(cloud);
  return { cloud, api, unsubscribe, emit: (event: AuthChangeEvent, session: Session | null) => listener(event, session) };
}
it('keeps an unconfigured installation usable without requesting auth', async () => {
  const cloud = new CloudSession(null); sessions.push(cloud);
  await cloud.start(); expect(cloud.getSnapshot().status).toBe('unavailable');
  expect(await cloud.sendSignInEmail('artist@example.com')).toBe(false);
});
it('restores once across remounts and never exposes tokens in UI snapshots', async () => {
  const { cloud, api } = setup(identity()); await Promise.all([cloud.start(), cloud.start()]);
  expect(api.initialize).toHaveBeenCalledOnce(); expect(api.onAuthStateChange).toHaveBeenCalledOnce();
  expect(cloud.getSnapshot().user).toEqual({ id: 'user-1', email: 'artist@example.com' });
  expect(JSON.stringify(cloud.getSnapshot())).not.toContain('private-');
});
it('hands the access token to first-party backend callers only while signed in', async () => {
  const { cloud, api, emit } = setup(identity()); await cloud.start();
  expect(await cloud.getAccessToken()).toBe('private-access');
  expect(JSON.stringify(cloud.getSnapshot())).not.toContain('private-');
  emit('SIGNED_OUT', null);
  expect(await cloud.getAccessToken()).toBeNull();
  api.getSession.mockRejectedValueOnce(new Error('offline'));
  emit('SIGNED_IN', identity());
  expect(await cloud.getAccessToken()).toBeNull();
  const unconfigured = new CloudSession(null); sessions.push(unconfigured);
  expect(await unconfigured.getAccessToken()).toBeNull();
});
it('normalizes email and requests open passwordless signup with a fixed callback', async () => {
  const { cloud, api } = setup(); await cloud.start();
  expect(await cloud.sendSignInEmail(' Artist@Example.com ')).toBe(true);
  expect(api.signInWithOtp).toHaveBeenCalledWith({ email: 'artist@example.com', options: {
    shouldCreateUser: true, emailRedirectTo: 'http://localhost:5174/auth/callback' } });
  expect(cloud.getSnapshot().status).toBe('signedOut');
  expect(await cloud.sendSignInEmail('artist@example.com')).toBe(false);
  expect(api.signInWithOtp).toHaveBeenCalledOnce();
});
it('rejects invalid email without contacting the service', async () => {
  const { cloud, api } = setup(); await cloud.start();
  expect(await cloud.sendSignInEmail('not-an-email')).toBe(false);
  expect(api.signInWithOtp).not.toHaveBeenCalled();
});
it('suppresses duplicate in-flight email requests and ignores completion after disposal', async () => {
  const { cloud, api, unsubscribe } = setup(); await cloud.start();
  let finish!: (value: unknown) => void;
  api.signInWithOtp.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = cloud.sendSignInEmail('artist@example.com');
  expect(await cloud.sendSignInEmail('artist@example.com')).toBe(false);
  cloud.dispose(); finish({ error: null }); expect(await pending).toBe(false);
  expect(unsubscribe).toHaveBeenCalledOnce(); expect(cloud.getSnapshot().emailSentTo).toBeNull();
});
it('allows resending after the cooldown and changing email without keeping an old code', async () => {
  vi.useFakeTimers(); const { cloud, api } = setup(); await cloud.start();
  await cloud.sendSignInEmail('artist@example.com');
  vi.advanceTimersByTime(60_001); expect(await cloud.sendSignInEmail('artist@example.com')).toBe(true);
  cloud.changeEmail(); expect(cloud.getSnapshot().emailSentTo).toBeNull();
  expect(await cloud.verifyCode('123456')).toBe(false); expect(api.verifyOtp).not.toHaveBeenCalled();
});
it('verifies email OTP and clears the sent state only after a real session', async () => {
  const { cloud, api } = setup(); await cloud.start(); await cloud.sendSignInEmail('artist@example.com');
  expect(await cloud.verifyCode('bad')).toBe(false); expect(await cloud.verifyCode('12345')).toBe(false);
  expect(await cloud.verifyCode('12345678901')).toBe(false); expect(api.verifyOtp).not.toHaveBeenCalled();
  // Codes are 6 to 10 digits per project configuration; the hosted project sends 8.
  expect(await cloud.verifyCode('1234 5678')).toBe(true);
  expect(api.verifyOtp).toHaveBeenCalledWith({ email: 'artist@example.com', token: '12345678', type: 'email' });
  expect(cloud.getSnapshot().status).toBe('signedIn'); expect(cloud.getSnapshot().emailSentTo).toBeNull();
});
it('handles expired codes safely and allows a retry', async () => {
  const { cloud, api } = setup(); await cloud.start(); await cloud.sendSignInEmail('artist@example.com');
  api.verifyOtp.mockResolvedValueOnce({ data: { session: null }, error: { code: 'otp_expired', message: 'secret-url' } });
  expect(await cloud.verifyCode('123456')).toBe(false);
  expect(cloud.getSnapshot().error).toContain('expired'); expect(cloud.getSnapshot().error).not.toContain('secret-url');
  expect(cloud.getSnapshot().pending).toBeNull(); expect(await cloud.verifyCode('654321')).toBe(true);
});
it.each([{ status: 429 }, { name: 'AuthRetryableFetchError' }, { message: 'private raw provider text' }])('maps provider failures without echoing raw messages: %j', async error => {
  const { cloud, api } = setup(); await cloud.start(); api.signInWithOtp.mockResolvedValueOnce({ data: {}, error });
  expect(await cloud.sendSignInEmail('artist@example.com')).toBe(false);
  expect(cloud.getSnapshot().error).toBeTruthy(); expect(cloud.getSnapshot().error).not.toContain('private');
  expect(cloud.getSnapshot().pending).toBeNull();
});
it('applies refresh and cross-tab sign-out events', async () => {
  const { cloud, emit } = setup(identity()); await cloud.start();
  const refreshed = identity(Date.now() + 7_200_000); emit('TOKEN_REFRESHED', refreshed);
  expect(cloud.getSnapshot().expiresAt).toBe(refreshed.expires_at! * 1000);
  emit('SIGNED_OUT', null); expect(cloud.getSnapshot().user).toBeNull();
});
it('does not resurrect a session when a stale bootstrap resolves after sign-out', async () => {
  const { cloud, api, emit } = setup(); let finish!: (value: unknown) => void;
  api.getSession.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const started = cloud.start(); await vi.waitFor(() => expect(api.getSession).toHaveBeenCalled());
  emit('SIGNED_OUT', null); finish({ data: { session: identity() }, error: null }); await started;
  expect(cloud.getSnapshot().status).toBe('signedOut');
});
it('expires offline sessions and recovers when the SDK refreshes', async () => {
  vi.useFakeTimers(); const { cloud, emit } = setup(identity(Date.now() + 5000)); await cloud.start();
  vi.advanceTimersByTime(5001); expect(cloud.getSnapshot().status).toBe('signedOut');
  expect(cloud.getSnapshot().error).toContain('expired');
  emit('TOKEN_REFRESHED', identity()); expect(cloud.getSnapshot().status).toBe('signedIn');
  expect(cloud.getSnapshot().error).toBeNull();
});
it('preserves identity after failed sign-out and signs out only the current browser session', async () => {
  const { cloud, api } = setup(identity()); await cloud.start();
  api.signOut.mockResolvedValueOnce({ error: { name: 'AuthRetryableFetchError' } });
  expect(await cloud.signOut()).toBe(false); expect(cloud.getSnapshot().status).toBe('signedIn');
  expect(await cloud.signOut()).toBe(true); expect(api.signOut).toHaveBeenLastCalledWith({ scope: 'local' });
  expect(cloud.getSnapshot().user).toBeNull();
});
it('exchanges a PKCE callback exactly once with its SDK flow id', async () => {
  const { cloud, api } = setup(identity(), { kind: 'code', code: 'one-shot', flowId: 'flow-1' });
  await cloud.start(); await cloud.start();
  expect(api.exchangeCodeForSession).toHaveBeenCalledExactlyOnceWith('one-shot', { flowId: 'flow-1' });
});
it('verifies an email token-hash link exactly once and signs in with the session it yields', async () => {
  const { cloud, api } = setup(identity(), { kind: 'emailToken', tokenHash: 'hash-1' });
  await cloud.start(); await cloud.start();
  expect(api.verifyOtp).toHaveBeenCalledExactlyOnceWith({ token_hash: 'hash-1', type: 'email' });
  expect(api.exchangeCodeForSession).not.toHaveBeenCalled();
  expect(cloud.getSnapshot()).toMatchObject({ status: 'signedIn', error: null, user: { id: 'user-1', email: 'artist@example.com' } });
});
it('reports a token-hash link the service rejects, keeps the visitor signed out, and does not retry it', async () => {
  const { cloud, api } = setup(null, { kind: 'emailToken', tokenHash: 'used-hash' });
  api.verifyOtp.mockResolvedValueOnce({ data: { session: null }, error: { message: 'Email link is invalid or has expired', status: 403 } });
  await cloud.start(); await cloud.start();
  expect(api.verifyOtp).toHaveBeenCalledTimes(1);
  expect(cloud.getSnapshot().status).toBe('signedOut');
  expect(cloud.getSnapshot().error).toContain('sign-in link');
  expect(JSON.stringify(cloud.getSnapshot())).not.toContain('used-hash');
});
it('reports an invalid callback without discarding an existing account', async () => {
  const { cloud } = setup(identity(), { kind: 'error' }); await cloud.start();
  expect(cloud.getSnapshot().status).toBe('signedIn'); expect(cloud.getSnapshot().error).toContain('sign-in link');
});

it.each([null, identity(Date.now() - 1000)])('does not claim successful verification without a usable session', async session => {
  const { cloud, api } = setup(); await cloud.start(); await cloud.sendSignInEmail('artist@example.com');
  api.verifyOtp.mockResolvedValueOnce({ data: { session }, error: null });
  expect(await cloud.verifyCode('123456')).toBe(false);
  expect(cloud.getSnapshot().status).toBe('signedOut'); expect(cloud.getSnapshot().emailSentTo).toBe('artist@example.com');
});
