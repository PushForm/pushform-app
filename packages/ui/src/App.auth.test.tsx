// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloudSession, type AuthApi } from '@pushform/cloud';
import { App } from './App';
import { createApp } from './bootstrap';
vi.mock('./components/ViewportView', () => ({ ViewportView: () => <div aria-label="3D viewport" /> }));
vi.mock('./bootstrap', async importOriginal => {
  const original = await importOriginal<{ createApp: typeof createApp }>();
  return { ...original, createApp: vi.fn(original.createApp) };
});
const sessions: CloudSession[] = [];
afterEach(() => { cleanup(); sessions.splice(0).forEach(s => s.dispose()); vi.restoreAllMocks(); vi.clearAllMocks(); });
function setup(callbackError = false) {
  const session = { expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'artist@example.com' } };
  let event!: (event: string, value: unknown) => void;
  let restore!: (value: unknown) => void;
  const api = {
    initialize: vi.fn().mockImplementation(() => new Promise(resolve => { restore = resolve; })),
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    onAuthStateChange: vi.fn(callback => { event = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; }),
    signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
    verifyOtp: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  };
  const cloud = new CloudSession(api as unknown as AuthApi, '', callbackError ? { kind: 'error' } : null);
  sessions.push(cloud); render(<App initialScreen="workspace" cloud={cloud} />);
  return { cloud, api, session, restored: async () => { await act(async () => { restore({ error: null }); await cloud.start(); }); },
    emit: (name: string, value: unknown) => act(() => event(name, value)) };
}
function noWorkspace(): void {
  expect(screen.queryByRole('banner')).toBeNull(); expect(screen.queryByLabelText('3D viewport')).toBeNull();
  expect(screen.queryByLabelText('Layout workspace')).toBeNull(); expect(screen.queryByRole('button', { name: /Skip|Continue as guest|Close/ })).toBeNull();
}
it('requires sign-in when configuration is unavailable, without creating the document engine', () => {
  render(<App initialScreen="workspace" />); expect(screen.getByRole('alert').textContent).toContain('unavailable');
  noWorkspace(); expect(createApp).not.toHaveBeenCalled();
});
it('shows only the entry screen during restore and while signed out; Escape cannot dismiss it', async () => {
  const { restored } = setup(); expect(screen.getByRole('status').textContent).toContain('Restoring'); noWorkspace();
  expect(createApp).not.toHaveBeenCalled(); await restored();
  fireEvent.keyDown(window, { key: 'Escape' }); noWorkspace();
  expect(screen.getByRole('heading', { name: 'Sign in to PushForm' })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText('Email address')); expect(createApp).not.toHaveBeenCalled();
});
it('keeps access locked after sending an email or a failed code, then enters after verification', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const { restored, api } = setup(); await restored();
  const email = screen.getByLabelText('Email address'); fireEvent.change(email, { target: { value: 'artist@example.com' } });
  fireEvent.submit(email.closest('form')!); await screen.findByRole('heading', { name: 'Check your email' }); noWorkspace();
  expect(createApp).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: /Resend email/ }).hasAttribute('disabled')).toBe(true);
  const code = screen.getByLabelText('Email code') as HTMLInputElement; expect(document.activeElement).toBe(code);
  // The hosted project sends eight-digit codes; the input accepts the 6 to 10 digits Supabase allows.
  expect(code.maxLength).toBe(10); expect(code.pattern).toBe('[0-9]{6,10}');
  api.verifyOtp.mockResolvedValueOnce({ data: { session: null }, error: { code: 'otp_expired' } });
  fireEvent.change(code, { target: { value: '12345678' } }); fireEvent.submit(code.closest('form')!);
  await screen.findByRole('alert'); noWorkspace(); expect(createApp).not.toHaveBeenCalled();
  fireEvent.submit(code.closest('form')!); await screen.findByRole('banner');
  expect(screen.queryByRole('main', { name: 'Sign in' })).toBeNull(); expect(createApp).toHaveBeenCalledOnce();
});
it('restores a valid session without flashing workspace content early, then locks on cross-tab sign-out', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const { restored, api, session, emit } = setup(); api.getSession.mockResolvedValueOnce({ data: { session }, error: null });
  noWorkspace(); await restored(); expect(await screen.findByRole('banner')).toBeTruthy();
  emit('SIGNED_OUT', null); noWorkspace();
  expect((window as Window & { pushform?: unknown }).pushform).toBeUndefined();
  emit('SIGNED_IN', session); expect(screen.getByRole('banner')).toBeTruthy(); expect(createApp).toHaveBeenCalledOnce();
});
it('shows callback errors on the dedicated screen and never opens the workspace', async () => {
  const { restored } = setup(true); await restored(); noWorkspace();
  expect(screen.getByRole('alert').textContent).toContain('sign-in link'); expect(createApp).not.toHaveBeenCalled();
});

it('switches accounts without exposing the previous workspace or restoring its private cached content', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  sessionStorage.clear();
  const { restored, api, session, emit } = setup();
  api.getSession.mockResolvedValueOnce({ data: { session }, error: null }); await restored();
  await screen.findByRole('banner');
  const alice = (window as unknown as { pushform: { app: ReturnType<typeof createApp> } }).pushform.app;
  act(() => alice.document.doc.transact('Private edit', draft => { draft.definitions.get(draft.rootDefinitionId)!.name = 'Alice private work'; }));
  emit('SIGNED_OUT', null);
  emit('SIGNED_IN', { ...session, user: { id: 'user-2', email: 'bob@example.com' } });
  await screen.findByRole('banner');
  const bob = (window as unknown as { pushform: { app: ReturnType<typeof createApp> } }).pushform.app;
  expect(bob.document.doc.state.definitions.get(bob.document.doc.state.rootDefinitionId)!.name).not.toBe('Alice private work');
  emit('SIGNED_OUT', null); emit('SIGNED_IN', session);
  await screen.findByRole('banner');
  const aliceRestored = (window as unknown as { pushform: { app: ReturnType<typeof createApp> } }).pushform.app;
  expect(aliceRestored.document.doc.state.definitions.get(aliceRestored.document.doc.state.rootDefinitionId)!.name).toBe('Alice private work');
  sessionStorage.clear();
});
