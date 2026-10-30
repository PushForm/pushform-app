// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it, vi } from 'vitest';
import {
  CLOUD_TERMS_VERSION, CloudProfiles, cloudProfileComplete, cloudProfileErrors, cloudProfileInput, cloudProfileParams,
  type CloudProfile, type CloudProfileInput,
} from './CloudProfile';
import type { CloudSessionState } from './CloudSession';

const row = { first_name: 'Ada', last_name: 'Lovelace', account_type: 'company', company_name: 'Analytical Ltd', company_size: '11-50',
  industry: 'engineering', industry_other: null, terms_version: CLOUD_TERMS_VERSION, terms_accepted_at: '2026-10-26T00:00:00Z',
  completed_at: '2026-10-26T00:00:00Z', updated_at: '2026-10-26T00:00:00Z' };
const input: CloudProfileInput = { firstName: 'Ada', lastName: 'Lovelace', accountType: 'company', companyName: 'Analytical Ltd',
  companySize: '11-50', industry: 'engineering', industryOther: '', acceptTerms: true };

function fakeSession(user: string | null) {
  const listeners = new Set<() => void>();
  let state = { status: user ? 'signedIn' : 'signedOut', user: user ? { id: user, email: `${user}@example.com` } : null } as CloudSessionState;
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    switchTo(next: string | null) {
      state = { ...state, status: next ? 'signedIn' : 'signedOut', user: next ? { id: next, email: `${next}@example.com` } : null };
      for (const listener of listeners) listener();
    },
  };
}
function fakeClient(rows: Record<string, typeof row | null>, rpc = vi.fn(async () => ({ data: row, error: null }))) {
  const reads: string[] = [];
  return {
    reads, rpc,
    from: () => ({ select: () => ({ eq: (_: string, owner: string) => ({ maybeSingle: async () => {
      reads.push(owner);
      return owner in rows ? { data: rows[owner], error: null } : { data: null, error: { code: 'PGRST205' } };
    } }) }) }),
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it('treats a missing profile or outdated terms as incomplete', () => {
  expect(cloudProfileComplete(null)).toBe(false);
  const profile = { termsVersion: CLOUD_TERMS_VERSION } as CloudProfile;
  expect(cloudProfileComplete(profile)).toBe(true);
  expect(cloudProfileComplete({ ...profile, termsVersion: '2020-01-01' })).toBe(false);
  expect(cloudProfileInput({ ...profile, termsVersion: '2020-01-01', companyName: null, industryOther: null } as CloudProfile).acceptTerms).toBe(false);
});
it('requires names, a type, company details for a company, an industry, and the terms', () => {
  expect(Object.keys(cloudProfileErrors(cloudProfileInput(null))).sort())
    .toEqual(['acceptTerms', 'accountType', 'firstName', 'industry', 'lastName']);
  expect(Object.keys(cloudProfileErrors({ ...input, companyName: ' ', companySize: null }))).toEqual(['companyName', 'companySize']);
  expect(cloudProfileErrors({ ...input, accountType: 'individual', companyName: '', companySize: null })).toEqual({});
  expect(Object.keys(cloudProfileErrors({ ...input, industry: 'other', industryOther: '' }))).toEqual(['industryOther']);
  expect(cloudProfileErrors({ ...input, firstName: 'x'.repeat(101) }).firstName).toMatch(/100 characters/);
  expect(cloudProfileErrors(input)).toEqual({});
});
it('sends no company fields for an Individual and no description unless the industry is Other', () => {
  expect(cloudProfileParams({ ...input, accountType: 'individual', firstName: ' Ada ' })).toEqual({ p_first_name: 'Ada', p_last_name: 'Lovelace',
    p_account_type: 'individual', p_company_name: null, p_company_size: null, p_industry: 'engineering', p_industry_other: null,
    p_terms_version: CLOUD_TERMS_VERSION });
  expect(cloudProfileParams({ ...input, industry: 'other', industryOther: ' Theatre ', acceptTerms: false }))
    .toMatchObject({ p_company_name: 'Analytical Ltd', p_industry_other: 'Theatre', p_terms_version: null });
});
it('loads the signed-in account\'s profile and follows account changes', async () => {
  const session = fakeSession('alice'), client = fakeClient({ alice: row, bob: null });
  const profiles = new CloudProfiles(client as never, session);
  expect(profiles.getSnapshot()).toMatchObject({ status: 'loading', ownerId: 'alice' });
  await settle();
  expect(profiles.getSnapshot()).toMatchObject({ status: 'ready', profile: { firstName: 'Ada', companySize: '11-50' } });
  session.switchTo('bob'); await settle();
  expect(profiles.getSnapshot()).toMatchObject({ status: 'ready', ownerId: 'bob', profile: null });
  session.switchTo(null);
  expect(profiles.getSnapshot()).toMatchObject({ status: 'signedOut', ownerId: null, profile: null });
  expect(client.reads).toEqual(['alice', 'bob']);
  profiles.dispose();
});
it('reports a load failure and retries', async () => {
  const session = fakeSession('carol'), client = fakeClient({});
  const profiles = new CloudProfiles(client as never, session);
  await settle();
  expect(profiles.getSnapshot()).toMatchObject({ status: 'error', error: 'Account profiles are not set up for this installation yet.' });
  await profiles.reload();
  expect(client.reads).toEqual(['carol', 'carol']);
  profiles.dispose();
});
it('saves through cloud_save_profile and refuses invalid input without a request', async () => {
  const session = fakeSession('bob'), client = fakeClient({ bob: null });
  const profiles = new CloudProfiles(client as never, session);
  await settle();
  expect(await profiles.save({ ...input, acceptTerms: false })).toBe(false);
  expect(client.rpc).not.toHaveBeenCalled();
  expect(profiles.getSnapshot().error).toMatch(/highlighted/);
  expect(await profiles.save(input)).toBe(true);
  expect(client.rpc).toHaveBeenCalledWith('cloud_save_profile', cloudProfileParams(input));
  expect(profiles.getSnapshot()).toMatchObject({ status: 'ready', saving: false, error: null, profile: { lastName: 'Lovelace' } });
  client.rpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'cloud_invalid' } } as never);
  expect(await profiles.save(input)).toBe(false);
  expect(profiles.getSnapshot()).toMatchObject({ status: 'ready', saving: false, error: 'Check the highlighted fields and try again.' });
  profiles.dispose();
});
it('drops a save that finishes after the account changed', async () => {
  const session = fakeSession('bob');
  let resolve: (value: unknown) => void = () => {};
  const client = fakeClient({ bob: null, dan: null }, vi.fn(() => new Promise(r => { resolve = r; })) as never);
  const profiles = new CloudProfiles(client as never, session);
  await settle();
  const saving = profiles.save(input);
  session.switchTo('dan'); await settle();
  resolve({ data: row, error: null });
  expect(await saving).toBe(false);
  expect(profiles.getSnapshot()).toMatchObject({ ownerId: 'dan', profile: null });
  profiles.dispose();
});
