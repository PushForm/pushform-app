// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CommonsOwnModels, CommonsOwnRevision, CommonsSubmission } from '@pushform/cloud';
import type { CommonsAccount } from './account';
import { App } from './App';
import { exampleModel } from './catalog.fixture';

const cloud = vi.hoisted(() => ({ deleteDraft: vi.fn() }));
vi.mock('@pushform/cloud', async original => ({
  ...(await original<Record<string, unknown>>()),
  deleteCommonsDraft: cloud.deleteDraft,
}));

const ownerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const publishedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const draftId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const profile = { id: ownerId, handle: 'example-maker', displayName: 'Example Maker', bio: '', avatarUrl: null, links: [], active: true, version: 1 };
const model = exampleModel({ revision: publishedId, creator: 'Independent source author', creatorProfile: null });
const metadata: CommonsSubmission = {
  title: model.title, description: model.description, creator: model.creator, category: model.category,
  tags: model.tags, formats: model.formats, imageUrl: model.imageUrl, source: model.source,
  licenses: model.licenses, credits: model.credits,
};
function revision(id: string, status: CommonsOwnRevision['status']): CommonsOwnRevision {
  return { id, model_id: model.id, number: status === 'pending' ? 2 : 1, metadata, status, asset_version: 0,
    rights_basis: 'Supplied source attribution retained.', creator_profile_id: null, self_service: false, details_version: 1 };
}
function ownState(draft = false, published = true): CommonsOwnModels {
  return {
    models: [{ id: model.id, latest_submission: draft ? draftId : publishedId, published_revision: published ? publishedId : null }],
    revisions: [...(published ? [revision(publishedId, 'published')] : []), ...(draft ? [revision(draftId, 'pending')] : [])],
    assets: [],
  };
}
function setup(initial = ownState()) {
  let snapshot = { user: { id: ownerId, email: 'owner@example.com' } };
  const listeners = new Set<() => void>();
  const state = { own: initial, withdrawError: false };
  const rpc = vi.fn((name: string) => {
    const run = async () => {
      if (name === 'commons_my_models') return { data: snapshot.user.id === ownerId ? structuredClone(state.own) : { models: [], revisions: [], assets: [] }, error: null };
      if (name === 'commons_withdraw_model') {
        if (state.withdrawError) return { data: null, error: { message: 'commons_conflict' } };
        state.own = { models: [], revisions: [], assets: [] };
        return { data: null, error: null };
      }
      throw new Error('Unexpected operation: ' + name);
    };
    const promise = run();
    return Object.assign(promise, { abortSignal: () => promise });
  });
  const account = {
    client: { rpc },
    session: {
      getAccessToken: async () => 'test-token', getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    profiles: { mine: vi.fn(async () => snapshot.user.id === ownerId ? profile : { ...profile, id: snapshot.user.id, handle: 'other-maker' }), getByHandle: vi.fn(async () => ({ profile, models: [] })) },
  } as unknown as CommonsAccount;
  return { account, state, rpc, switchAccount: () => {
    snapshot = { user: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', email: 'other@example.com' } };
    listeners.forEach(listener => listener());
  } };
}

beforeEach(() => { window.history.replaceState(null, '', '/'); cloud.deleteDraft.mockReset(); });
afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); });

it('offers owner actions for an authenticated owned import despite unrelated creator credit', async () => {
  const f = setup(); window.location.hash = '#models/' + model.id;
  render(<App account={f.account} loadCatalog={async () => [model]} />);
  expect(await screen.findByRole('link', { name: 'Edit model' })).toHaveProperty('hash', '#edit/' + model.id);
  expect(screen.getByRole('button', { name: 'Delete model' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Independent source author' }).getAttribute('href')).toBe('/?q=Independent+source+author#browse');
  expect(f.rpc).toHaveBeenCalledWith('commons_my_models', {});
});

it('does not infer management rights from a matching credited creator profile', async () => {
  const f = setup({ models: [], revisions: [], assets: [] }); window.location.hash = '#models/' + model.id;
  const credited = { ...model, creator: profile.displayName, creatorProfile: { id: ownerId, handle: profile.handle, displayName: profile.displayName } };
  render(<App account={f.account} loadCatalog={async () => [credited]} />);
  await screen.findByRole('heading', { name: model.title, level: 1 });
  await waitFor(() => expect(f.rpc).toHaveBeenCalledWith('commons_my_models', {}));
  expect(screen.queryByRole('link', { name: 'Edit model' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete model' })).toBeNull();
});

it('opens a private draft from the owner profile grid without public catalog membership', async () => {
  const f = setup(ownState(true, false)); window.history.replaceState(null, '', '/u/example-maker');
  render(<App account={f.account} loadCatalog={async () => []} />);
  const grid = within(await screen.findByRole('region', { name: 'My Models' }));
  const link = await grid.findByRole('link', { name: model.title });
  expect(grid.getByText('Draft')).toBeTruthy();
  expect(link.getAttribute('href')).toBe('/models/' + model.id);
  window.history.pushState(null, '', link.getAttribute('href')!); fireEvent(window, new PopStateEvent('popstate'));
  expect(await screen.findByRole('heading', { name: model.title, level: 1 })).toBeTruthy();
  expect(screen.getByText(/Private draft/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Edit model' })).toBeTruthy();
});

it('requires delete confirmation and lets the owner keep the model', async () => {
  const f = setup(); window.location.hash = '#models/' + model.id;
  render(<App account={f.account} loadCatalog={async () => [model]} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete model' }));
  const confirmation = within(screen.getByRole('group', { name: 'Delete model confirmation' }));
  expect(confirmation.getByRole('button', { name: 'Delete this model' })).toBeTruthy();
  expect(f.rpc).not.toHaveBeenCalledWith('commons_withdraw_model', expect.anything());
  fireEvent.click(confirmation.getByRole('button', { name: 'Keep model' }));
  expect(screen.queryByRole('group', { name: 'Delete model confirmation' })).toBeNull();
  expect(f.rpc).not.toHaveBeenCalledWith('commons_withdraw_model', expect.anything());
});

it('retains a failed deletion for retry and returns successful withdrawal to the owner profile', async () => {
  const f = setup(); f.state.withdrawError = true; window.location.hash = '#models/' + model.id;
  render(<App account={f.account} loadCatalog={async () => [model]} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete this model' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This model changed. Refresh and confirm the current files again.');
  expect(window.location.pathname).toBe('/models/' + model.id);
  expect((screen.getByRole('button', { name: 'Delete this model' }) as HTMLButtonElement).disabled).toBe(false);
  f.state.withdrawError = false; fireEvent.click(screen.getByRole('button', { name: 'Delete this model' }));
  await waitFor(() => expect(window.location.pathname).toBe('/u/example-maker'));
  expect(window.location.hash).toBe('');
  expect(f.rpc).toHaveBeenCalledWith('commons_withdraw_model', { p_id: model.id, p_expected_published: publishedId });
  expect(await screen.findByText('You haven’t uploaded a model yet.')).toBeTruthy();
});

it('deletes private draft files before withdrawing an existing publication', async () => {
  const f = setup(ownState(true, true)); window.location.hash = '#models/' + model.id;
  cloud.deleteDraft.mockImplementation(async () => { expect(f.rpc).not.toHaveBeenCalledWith('commons_withdraw_model', expect.anything()); });
  render(<App account={f.account} filesUrl="https://files.example.com" loadCatalog={async () => [model]} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete model' }));
  expect(screen.getByText('Unpublished changes are saved for this model.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Delete this model' }));
  await waitFor(() => expect(cloud.deleteDraft).toHaveBeenCalledWith('https://files.example.com', 'test-token', model.id, draftId, expect.any(AbortSignal)));
  await waitFor(() => expect(f.rpc).toHaveBeenCalledWith('commons_withdraw_model', { p_id: model.id, p_expected_published: publishedId }));
  await waitFor(() => expect(window.location.pathname).toBe('/u/example-maker'));
});

it('does not withdraw a publication when deleting its draft fails', async () => {
  const f = setup(ownState(true, true)); window.location.hash = '#models/' + model.id;
  cloud.deleteDraft.mockRejectedValue(new Error('Draft files could not be removed.'));
  render(<App account={f.account} filesUrl="https://files.example.com" loadCatalog={async () => [model]} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete this model' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Draft files could not be removed.');
  expect(f.rpc).not.toHaveBeenCalledWith('commons_withdraw_model', expect.anything());
  expect(window.location.pathname).toBe('/models/' + model.id);
  expect((screen.getByRole('button', { name: 'Delete this model' }) as HTMLButtonElement).disabled).toBe(false);
});

it('does not delete draft files twice when withdrawal fails and is retried', async () => {
  const f = setup(ownState(true, true)); f.state.withdrawError = true;
  window.location.hash = '#models/' + model.id;
  cloud.deleteDraft.mockResolvedValue(undefined);
  render(<App account={f.account} filesUrl="https://files.example.com" loadCatalog={async () => [model]} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete this model' }));
  await screen.findByRole('alert');
  expect(cloud.deleteDraft).toHaveBeenCalledTimes(1);
  expect(f.rpc.mock.calls.filter(([name]) => name === 'commons_withdraw_model')).toHaveLength(1);
  expect(window.location.pathname).toBe('/models/' + model.id);
  f.state.withdrawError = false;
  fireEvent.click(screen.getByRole('button', { name: 'Delete this model' }));
  await waitFor(() => expect(window.location.pathname).toBe('/u/example-maker'));
  expect(cloud.deleteDraft).toHaveBeenCalledTimes(1);
  expect(f.rpc.mock.calls.filter(([name]) => name === 'commons_withdraw_model')).toHaveLength(2);
  expect(await screen.findByText('You haven’t uploaded a model yet.')).toBeTruthy();
});

it('hides the prior account’s ownership immediately when the session changes', async () => {
  const f = setup(); window.location.hash = '#models/' + model.id;
  render(<App account={f.account} loadCatalog={async () => [model]} />);
  await screen.findByRole('link', { name: 'Edit model' });
  act(() => f.switchAccount());
  expect(screen.queryByRole('link', { name: 'Edit model' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete model' })).toBeNull();
  await waitFor(() => expect(f.rpc.mock.calls.filter(([name]) => name === 'commons_my_models')).toHaveLength(2));
  expect(screen.queryByRole('region', { name: 'Manage your model' })).toBeNull();
});

it('removes private draft cards from the prior owner profile when accounts switch', async () => {
  const f = setup(ownState(true, false)); window.history.replaceState(null, '', '/u/example-maker');
  render(<App account={f.account} loadCatalog={async () => []} />);
  await screen.findByRole('link', { name: model.title });
  act(() => f.switchAccount());
  expect(screen.queryByRole('link', { name: model.title })).toBeNull();
  expect(await screen.findByRole('heading', { name: 'Published models' })).toBeTruthy();
  expect(screen.queryByText('Draft')).toBeNull();
  expect(screen.queryByRole('region', { name: 'My Models' })).toBeNull();
});
