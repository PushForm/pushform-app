// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CloudSession, CommonsCollections, type AuthApi, type CommonsCollection, type CommonsFeaturedState } from '@pushform/cloud';
import type { CommonsAccount } from './account';
import { App } from './App';
import { exampleModel } from './catalog.fixture';

const collection: CommonsCollection = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Workshop essentials', description: 'Useful fittings for the workshop.', visibility: 'public', version: 1, modelIds: ['workshop-hinge'], curator: { handle: 'example-maker', displayName: 'Example Maker' }, updatedAt: '2026-11-04T00:00:00Z' };
const model = exampleModel();
const disposals: (() => void)[] = [];
beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); });
async function setup(role = 'none', own = true) {
  const user = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'maker@example.com' };
  const auth = { access_token: 'test-session', user, expires_at: Math.floor(Date.now() / 1000) + 3600 };
  const session = new CloudSession({ initialize: async () => ({ error: null }), getSession: async () => ({ data: { session: auth }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) } as unknown as AuthApi);
  disposals.push(() => session.dispose()); await session.start();
  let collections = own ? [collection] : [];
  let featured: CommonsFeaturedState['items'] = [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', type: 'model', targetId: model.id, title: model.title, available: true }];
  const rpc = vi.fn((name: string, args?: Record<string, unknown>) => {
    let data: unknown = null;
    if (name === 'admin_session') data = { role };
    if (name === 'commons_my_collections') data = collections;
    if (name === 'commons_collection') data = collection;
    if (name === 'commons_discovery') data = { version: 1, collections: [collection], featured: featured.map(({ id, type, targetId }) => ({ id, type, targetId })) };
    if (name === 'commons_save_collection') {
      const saved = { ...collection, title: args!.p_title, description: args!.p_description, visibility: args!.p_public ? 'public' : 'private', modelIds: args!.p_model_ids, version: 2 };
      collections = [saved as CommonsCollection]; data = saved;
    }
    if (name === 'admin_commons_feature') {
      featured = [...featured, { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', type: 'collection', targetId: collection.id, title: collection.title, available: true }];
      data = { version: 2, enabled: true, items: featured, models: [model], collections: [collection] };
    }
    const promise = Promise.resolve({ data, error: null });
    return Object.assign(promise, { abortSignal: () => promise });
  });
  const client = { rpc, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { first_name: 'Test', last_name: 'Maker', account_type: 'individual', company_name: null, company_size: null, industry: 'hobbyist', industry_other: null, terms_version: '2026-10-27', terms_accepted_at: '2026-10-31T00:00:00Z', completed_at: '2026-10-31T00:00:00Z', updated_at: '2026-10-31T00:00:00Z' }, error: null }) }) }) }) } as unknown as CommonsAccount['client'];
  const account = { session, client, profiles: { mine: async () => null } } as unknown as CommonsAccount;
  return { account, collections: new CommonsCollections(client), rpc };
}
it('places mixed featured content above filters and keeps it unchanged when browsing filters change', async () => {
  const auth = await setup();
  render(<App {...auth} loadCatalog={async () => [model]} />);
  const featured = await screen.findByRole('region', { name: 'Featured' });
  expect(within(featured).getByRole('link', { name: model.title })).toBeTruthy();
  expect(featured.compareDocumentPosition(screen.getByRole('search')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no results' } });
  expect(within(featured).getByRole('link', { name: model.title })).toBeTruthy();
  window.location.hash = '#collections'; fireEvent(window, new HashChangeEvent('hashchange'));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'workshop' } });
  expect(await screen.findByRole('link', { name: 'View collection Workshop essentials' })).toBeTruthy();
});
it('keeps longer featured lists in one three-card page and makes later entries reachable', async () => {
  const auth = await setup();
  const models = Array.from({ length: 4 }, (_, index) => exampleModel({ id: `featured-${index}`, title: `Featured project ${index}` }));
  vi.spyOn(auth.collections, 'discovery').mockResolvedValue({ version: 1, collections: [], featured: models.map((value, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, type: 'model', targetId: value.id })) });
  render(<App {...auth} loadCatalog={async () => models} />);
  const featured = within(await screen.findByRole('region', { name: 'Featured' }));
  await featured.findByRole('link', { name: 'Featured project 0' });
  expect(featured.queryByRole('link', { name: 'Featured project 3' })).toBeNull();
  fireEvent.click(featured.getByRole('button', { name: 'Next featured' }));
  expect(featured.getByRole('link', { name: 'Featured project 3' })).toBeTruthy();
  expect(featured.queryByRole('link', { name: 'Featured project 0' })).toBeNull();
  fireEvent.click(featured.getByRole('button', { name: 'Previous featured' }));
  expect(featured.getByRole('link', { name: 'Featured project 0' })).toBeTruthy();
});
it('preserves keyboard focus between browse tabs and excludes mixed-rights collections from commercial results', async () => {
  const auth = await setup();
  const restricted = exampleModel({ id: 'restricted-model', title: 'Restricted model', licenses: [{ ...model.licenses[0]!, commercialUse: 'restricted' }] });
  vi.spyOn(auth.collections, 'discovery').mockResolvedValue({ version: 1, collections: [{ ...collection, modelIds: [model.id, restricted.id] }], featured: [] });
  render(<App {...auth} loadCatalog={async () => [model, restricted]} />);
  const modelsTab = screen.getByRole('tab', { name: 'Models' }); modelsTab.focus();
  fireEvent.keyDown(modelsTab, { key: 'ArrowRight' });
  await screen.findByRole('heading', { name: 'Browse collections' });
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Collections' }));
  await screen.findByRole('link', { name: 'View collection Workshop essentials' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Commercial use permitted' }));
  expect(screen.queryByRole('link', { name: 'View collection Workshop essentials' })).toBeNull();
  screen.getByRole('tab', { name: 'Collections' }).focus();
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Collections' }), { key: 'ArrowLeft' });
  await screen.findByRole('heading', { name: 'Browse models' });
  expect(document.activeElement).toBe(modelsTab);
});
it('features a public collection in one action for admins and adds it to the homepage', async () => {
  const auth = await setup('admin'); window.location.hash = '#collections/' + collection.id;
  render(<App {...auth} loadCatalog={async () => [model]} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Feature' }));
  await screen.findByRole('link', { name: 'Featured · Manage' });
  expect(auth.rpc).toHaveBeenCalledWith('admin_commons_feature', { p_type: 'collection', p_target_id: collection.id });
  window.location.hash = '#browse'; fireEvent(window, new HashChangeEvent('hashchange'));
  expect(await screen.findByRole('link', { name: 'View collection Workshop essentials' })).toBeTruthy();
});
it('hides featuring from ordinary users and lets them edit their own collection with its original version', async () => {
  const auth = await setup(); window.location.hash = '#collections/' + collection.id;
  render(<App {...auth} loadCatalog={async () => [model]} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit collection' }));
  expect(screen.queryByRole('button', { name: 'Feature' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Collection title'), { target: { value: 'My private workshop' } });
  fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'private' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Edit collection' }));
  await waitFor(() => expect(auth.rpc).toHaveBeenCalledWith('commons_save_collection', { p_id: collection.id, p_title: 'My private workshop', p_description: collection.description, p_public: false, p_model_ids: [model.id], p_expected_version: 1 }));
});
it('creates a private collection directly from a model and preserves the selected model reference', async () => {
  const auth = await setup('none', false); window.location.hash = '#models/' + model.id;
  render(<App {...auth} loadCatalog={async () => [model]} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Save to collection' }));
  fireEvent.change(await screen.findByLabelText('New private collection'), { target: { value: 'Next project' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create and save' }));
  await waitFor(() => expect(auth.rpc).toHaveBeenCalledWith('commons_save_collection', { p_id: null, p_title: 'Next project', p_description: '', p_public: false, p_model_ids: [model.id], p_expected_version: null }));
});
