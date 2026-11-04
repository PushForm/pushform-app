// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommonsAccount } from '@pushform/commons-ui/account';
import * as cloud from '@pushform/cloud';
import { encodeModelDocument } from '@pushform/io';
import { createDocument } from '@pushform/model';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { CommonsBrowser } from './CommonsBrowser';

let session: DocumentSession;
afterEach(() => { cleanup(); session?.dispose(); vi.restoreAllMocks(); });
function setup() {
  session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
  const revision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const metadata = { title: 'Garden bench', description: 'A community bench', creator: 'Original maker', category: 'Furniture', tags: [], formats: ['PF'], imageUrl: null, source: null,
    licenses: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', commercialUse: 'allowed' as const, conditions: ['Credit the maker'] }], credits: [{ name: 'Original maker', url: null, text: 'Original creator' }] };
  const files = [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'bench.pf', format: 'PF', sizeBytes: 100, sha256: 'a'.repeat(64) }];
  const models = [{ ...metadata, files, id: 'bench', revision, publishedAt: '2026-11-04T00:00:00Z' }, { ...metadata, id: 'unknown', title: 'Unknown permission', revision, publishedAt: '2026-11-03T00:00:00Z', licenses: [{ ...metadata.licenses[0], commercialUse: 'unknown' }] }];
  let published: string | null = revision;
  const rpc = vi.fn((name: string) => {
    const data = name === 'commons_catalog' ? { version: 1, models } : name === 'commons_my_models' ? { models: [{ id: 'bench', latest_submission: revision, published_revision: published }], revisions: [{ id: revision, model_id: 'bench', number: 2, metadata, status: 'published', asset_version: 1, rights_basis: 'Original work created by me', creator_profile_id: null, self_service: true }], assets: [] } : null;
    if (name === 'commons_withdraw_model') published = null;
    const promise = Promise.resolve({ data, error: null }); return Object.assign(promise, { abortSignal: () => promise });
  });
  const account = { client: { rpc }, session: { getAccessToken: async () => 'test-token' } } as unknown as CommonsAccount;
  const props = { account, filesUrl: undefined, session, onOpened: vi.fn(), onClose: vi.fn() };
  const source: cloud.OpenedCommonsModel = { name: 'bench.pf', bytes: new Uint8Array(), attribution: {
    modelId: 'bench', revision, assetId: files[0]!.id, title: metadata.title, creator: metadata.creator,
    source: metadata.source, licenses: metadata.licenses, credits: metadata.credits,
    file: { name: files[0]!.name, sizeBytes: files[0]!.sizeBytes, sha256: files[0]!.sha256 },
  } };
  return { props, rpc, source };
}
it('opens a model with recorded units in a new tab from one action and preserves its credits', async () => {
  const f = setup(); const original = session.active;
  vi.spyOn(cloud, 'loadCommonsModel').mockResolvedValue({ ...f.source, bytes: await encodeModelDocument(createDocument()) });
  render(<CommonsBrowser {...f.props}/>);
  fireEvent.click(await screen.findByText('Garden bench'));
  fireEvent.click(screen.getByRole('button', { name: 'Open in new tab' }));
  await waitFor(() => expect(f.props.onOpened).toHaveBeenCalledOnce());
  expect(session.tabs).toHaveLength(2);
  expect(session.tabs).toContain(original);
  if (session.active.type !== 'model') throw new Error('Expected a model tab');
  expect(session.active.app.document.doc.state.meta.attributions).toEqual([f.source.attribution]);
  expect(screen.queryByRole('button', { name: 'Open copy in new tab' })).toBeNull();
});
it('still asks for units and up axis before opening a unitless model', async () => {
  const f = setup();
  vi.spyOn(cloud, 'loadCommonsModel').mockResolvedValue({ ...f.source, name: 'bench.obj', bytes: new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n') });
  render(<CommonsBrowser {...f.props}/>);
  fireEvent.click(await screen.findByText('Garden bench'));
  fireEvent.click(screen.getByRole('button', { name: 'Open in new tab' }));
  await screen.findByLabelText('Source units');
  expect(screen.getByLabelText('Up axis')).toBeTruthy();
  expect(session.tabs).toHaveLength(1);
  expect(f.props.onOpened).not.toHaveBeenCalled();
});
it('keeps the catalog and current documents when direct opening fails', async () => {
  const f = setup(); const original = session.active;
  vi.spyOn(cloud, 'loadCommonsModel').mockResolvedValue({ ...f.source, bytes: new Uint8Array([1, 2, 3]) });
  render(<CommonsBrowser {...f.props}/>);
  fireEvent.click(await screen.findByText('Garden bench'));
  fireEvent.click(screen.getByRole('button', { name: 'Open in new tab' }));
  await screen.findByRole('alert');
  expect(session.tabs).toEqual([original]);
  expect(f.props.onOpened).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Open in new tab' })).toBeTruthy();
});
it('requests catalog and detail thumbnails with anonymous CORS for the isolated editor', async () => {
  const f = setup(); const view = render(<CommonsBrowser {...f.props} filesUrl="https://files.example.com"/>);
  await screen.findByText('Garden bench');
  const assertImage = (image: HTMLImageElement) => {
    expect(image.src).toBe('https://files.example.com/thumbnails/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(image.crossOrigin).toBe('anonymous');
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
  };
  assertImage(view.container.querySelector('img')!);
  fireEvent.click(screen.getByText('Garden bench'));
  assertImage(screen.getByRole('img', { name: 'Garden bench' }));
  fireEvent.error(screen.getByRole('img', { name: 'Garden bench' }));
  expect(screen.getByText('Preview unavailable')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open in new tab' })).toBeTruthy();
});
it('retains browsing state when hidden and excludes unknown permissions from commercial-use results', async () => {
  const f = setup(); const view = render(<div><CommonsBrowser {...f.props}/></div>);
  await screen.findByText('Unknown permission');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Commercial use permitted' }));
  expect(screen.queryByText('Unknown permission')).toBeNull();
  fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'Garden' } });
  view.rerender(<div hidden><CommonsBrowser {...f.props}/></div>);
  view.rerender(<div><CommonsBrowser {...f.props}/></div>);
  expect((screen.getByLabelText('Search models') as HTMLInputElement).value).toBe('Garden');
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
});
it('switches between Commons sections with the shared tabs and keyboard navigation', async () => {
  const f = setup(); render(<CommonsBrowser {...f.props}/>);
  const browse = screen.getByRole('tab', { name: 'Browse', selected: true });
  fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'Garden' } });
  fireEvent.keyDown(browse, { key: 'ArrowRight' });
  const mine = screen.getByRole('tab', { name: 'My models', selected: true });
  expect(document.activeElement).toBe(mine);
  await screen.findByText('Published revision 2');
  expect(screen.getByRole('tabpanel', { name: 'My models' })).toBeTruthy();
  fireEvent.keyDown(mine, { key: 'Home' });
  expect(document.activeElement).toBe(browse);
  expect(screen.getByRole('tabpanel', { name: 'Browse' })).toBeTruthy();
  expect((screen.getByLabelText('Search models') as HTMLInputElement).value).toBe('Garden');
});
it('shows the owned publication and requires confirmation before withdrawing its exact public revision', async () => {
  const f = setup(); render(<CommonsBrowser {...f.props}/>);
  fireEvent.click(screen.getByRole('tab', { name: 'My models' }));
  await screen.findByText('Published revision 2');
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
  expect(f.rpc.mock.calls.some(([name]) => name === 'commons_withdraw_model')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(f.rpc).toHaveBeenCalledWith('commons_withdraw_model', { p_id: 'bench', p_expected_published: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
  await screen.findByText('Withdrawn');
});
