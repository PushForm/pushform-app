// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CLOUD_TERMS_VERSION, CloudProfiles, CloudSession, type AuthApi } from '@pushform/cloud';
import { layoutAccountFields } from '@pushform/layout';
import { App } from './App';
vi.mock('./components/ViewportView', () => ({ ViewportView: () => <div aria-label="3D viewport" /> }));

// The signup step after sign-in, its gate on the workspace, and editing from account details.
const cleanups: (() => void)[] = [];
afterEach(() => { cleanup(); cleanups.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); });
type Row = Record<string, string | null>;
const saved = (params: Record<string, string | null>, previous: Row | null): Row => ({
  first_name: params.p_first_name!, last_name: params.p_last_name!, account_type: params.p_account_type!,
  company_name: params.p_company_name ?? null, company_size: params.p_company_size ?? null, industry: params.p_industry!,
  industry_other: params.p_industry_other ?? null, terms_version: params.p_terms_version ?? previous?.terms_version ?? null,
  terms_accepted_at: '2026-10-26T00:00:00Z', completed_at: '2026-10-26T00:00:00Z', updated_at: '2026-10-26T00:00:00Z',
});
async function setup(stored: Row | null | 'error') {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const session = { expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'user-1', email: 'artist@example.com' } };
  const cloud = new CloudSession({
    initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    signOut: async () => ({ error: null }),
  } as unknown as AuthApi);
  let row = stored;
  const reads = vi.fn(async () => row === 'error' ? { data: null, error: { status: 0 } } : { data: row, error: null });
  const rpc = vi.fn(async (_: string, params: Record<string, string | null>) => {
    row = saved(params, row === 'error' ? null : row);
    return { data: row, error: null };
  });
  const client = { rpc, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: reads }) }) }) };
  const profiles = new CloudProfiles(client as never, cloud);
  cleanups.push(() => { profiles.dispose(); cloud.dispose(); });
  render(<App initialScreen="workspace" cloud={cloud} profiles={profiles} />);
  await act(async () => { await cloud.start(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return { rpc, reads, fail: (value: boolean) => { row = value ? 'error' : null; } };
}
const complete: Row = { first_name: 'Ada', last_name: 'Lovelace', account_type: 'company', company_name: 'Analytical Ltd',
  company_size: '11-50', industry: 'engineering', industry_other: null, terms_version: CLOUD_TERMS_VERSION,
  terms_accepted_at: '2026-10-26T00:00:00Z', completed_at: '2026-10-26T00:00:00Z', updated_at: '2026-10-26T00:00:00Z' };

it('holds a new account on the signup step, then opens the workspace once it is saved', async () => {
  const { rpc } = await setup(null);
  const step = screen.getByRole('main', { name: 'Set up your account' });
  expect(screen.getByRole('heading', { name: 'Tell us about yourself' })).toBeTruthy();
  expect(screen.queryByRole('banner')).toBeNull(); expect(screen.queryByLabelText('3D viewport')).toBeNull();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByRole('main', { name: 'Set up your account' })).toBe(step);
  expect(within(step).queryByRole('button', { name: /Skip|Close|Later/ })).toBeNull();

  const submit = within(step).getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect((within(step).getByRole('checkbox',{name:/Send me PushForm news/}) as HTMLInputElement).checked).toBe(false);
  expect(within(step).getByRole('link', { name: 'Terms of Use' }).getAttribute('href')).toBe('https://pushform.io/terms.html');
  fireEvent.click(within(step).getByRole('checkbox', { name: /I accept the Terms of Use/ }));
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  expect(within(step).getByText('Enter your first name.')).toBeTruthy();
  expect(within(step).getByText('Choose Company or Individual.')).toBeTruthy();
  expect(within(step).getByText('Choose your industry.')).toBeTruthy();
  expect(document.activeElement).toBe(within(step).getByLabelText(/First name/));
  expect(rpc).not.toHaveBeenCalled();

  expect(within(step).queryByLabelText(/Company name/)).toBeNull();
  fireEvent.click(within(step).getByRole('radio', { name: 'For a company' }));
  const size = within(step).getByLabelText(/Company size/) as HTMLSelectElement;
  expect([...size.options].map(o => o.textContent)).toEqual(['Choose a size', '1–10 people', '11–50 people', '51–200 people', '201–1,000 people', '1,001 or more people']);
  fireEvent.click(within(step).getByRole('radio', { name: 'As an individual' }));
  expect(within(step).queryByLabelText(/Company name/)).toBeNull(); expect(within(step).queryByLabelText(/Company size/)).toBeNull();
  fireEvent.click(within(step).getByRole('radio', { name: 'For a company' }));

  fireEvent.change(within(step).getByLabelText(/First name/), { target: { value: ' Ada ' } });
  fireEvent.change(within(step).getByLabelText(/Last name/), { target: { value: 'Lovelace' } });
  fireEvent.change(within(step).getByLabelText(/Company name/), { target: { value: 'Analytical Ltd' } });
  fireEvent.change(within(step).getByLabelText(/Company size/), { target: { value: '11-50' } });
  fireEvent.change(within(step).getByLabelText(/Industry/), { target: { value: 'other' } });
  fireEvent.click(submit);
  expect(within(step).getByText('Enter your industry.')).toBeTruthy();
  fireEvent.change(within(step).getByLabelText(/Your industry/), { target: { value: 'Theatre' } });
  await act(async () => { fireEvent.click(submit); });
  expect(rpc).toHaveBeenCalledWith('cloud_save_profile', { p_first_name: 'Ada', p_last_name: 'Lovelace', p_account_type: 'company',
    p_company_name: 'Analytical Ltd', p_company_size: '11-50', p_industry: 'other', p_industry_other: 'Theatre', p_terms_version: CLOUD_TERMS_VERSION });
  expect(await screen.findByRole('banner')).toBeTruthy();
  expect(screen.queryByRole('main', { name: 'Set up your account' })).toBeNull();
  // The profile fills the account auto-text.
  expect(layoutAccountFields().get('FullName')).toBe('Ada Lovelace');
  expect(layoutAccountFields().get('CompanyName')).toBe('Analytical Ltd');
});

it('opens the workspace directly for a completed profile and names the account in the header', async () => {
  const { reads } = await setup(complete);
  expect(await screen.findByRole('banner')).toBeTruthy();
  expect(screen.queryByRole('main', { name: 'Set up your account' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Account: Ada Lovelace, artist@example.com' }).textContent).toBe('Ada Lovelace');
  expect(reads).toHaveBeenCalledOnce();
});

it('asks again when the accepted terms are older than the current version', async () => {
  await setup({ ...complete, terms_version: '2020-01-01' });
  expect(screen.getByRole('heading', { name: 'Review the updated terms' })).toBeTruthy();
  expect((screen.getByLabelText(/First name/) as HTMLInputElement).value).toBe('Ada');
  expect((screen.getByRole('checkbox', { name: /I accept the Terms of Use/ }) as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByRole('banner')).toBeNull();
});

it('keeps the workspace locked when the profile cannot be loaded, and retries', async () => {
  const { reads, fail } = await setup('error');
  expect(screen.getByRole('alert').textContent).toContain('Could not load your profile');
  expect(screen.queryByRole('banner')).toBeNull();
  fail(false);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
  expect(reads).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('heading', { name: 'Tell us about yourself' })).toBeTruthy();
});

it('edits the profile from account details and updates the header and auto-text', async () => {
  const { rpc } = await setup(complete);
  fireEvent.click(await screen.findByRole('button', { name: 'Account: Ada Lovelace, artist@example.com' }));
  const dialog = screen.getByRole('dialog', { name: 'Your account' });
  expect(within(dialog).queryByRole('checkbox')).toBeNull();
  expect(within(dialog).getByText(/You accepted the/)).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText(/First name/), { target: { value: 'Augusta' } });
  fireEvent.click(within(dialog).getByRole('radio', { name: 'As an individual' }));
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save profile' })); });
  expect(rpc).toHaveBeenCalledWith('cloud_save_profile', expect.objectContaining({ p_first_name: 'Augusta', p_account_type: 'individual',
    p_company_name: null, p_company_size: null, p_terms_version: CLOUD_TERMS_VERSION }));
  expect(within(dialog).getByRole('status').textContent).toBe('Your profile was saved.');
  expect(screen.getByRole('button', { name: 'Account: Augusta Lovelace, artist@example.com' })).toBeTruthy();
  expect(layoutAccountFields().get('FullName')).toBe('Augusta Lovelace');
  expect(layoutAccountFields().get('CompanyName')).toBe('');
});
