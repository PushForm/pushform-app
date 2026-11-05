// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommonsRenderEvent, CommonsUpload, CommonsUploadProgress } from '@pushform/cloud';
import { UploadDialog, fileStatus } from './UploadDialog';
import { PublishPage, publishRoute } from './PublishPage';
import { detailsFromMetadata, detailsProblem, metadataFor, titleFromFileName } from './modelDetails';
import type { CommonsAccount } from './account';

const cloud = vi.hoisted(() => ({ upload: vi.fn(), stream: vi.fn(), thumbnail: vi.fn(), image: vi.fn(), remove: vi.fn(), deleteDraft: vi.fn() }));
vi.mock('@pushform/cloud', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  uploadCommonsFile: cloud.upload, streamCommonsRender: cloud.stream, fetchCommonsThumbnail: cloud.thumbnail,
  fetchCommonsImage: cloud.image, removeCommonsFile: cloud.remove, deleteCommonsDraft: cloud.deleteDraft,
}));
vi.mock('./CommonsAccess', () => ({ CommonsAccessGate: ({ children }: { children: unknown }) => children }));

const revisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assetId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', profileId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const profile = { id: profileId, handle: 'example-maker', displayName: 'Example Maker', bio: '', avatarUrl: null, links: [], active: true, version: 1 };
const snapshot = { user: { id: 'user-1' } };
const asset = (overrides: Partial<CommonsUpload> = {}): CommonsUpload => ({ id: assetId, revision_id: revisionId, filename: 'shop_bench.skb', format: 'skb', size_bytes: 2048, sha256: 'a'.repeat(64), status: 'ready', created_at: '2026-11-03T00:00:00Z', verified_at: '2026-11-03T00:00:01Z', ...overrides });

function setup({ models = [] as unknown[], revisions = [] as Record<string, unknown>[], assets = [] as CommonsUpload[], activeProfile = true } = {}) {
  const state = { models: [...models] as Record<string, unknown>[], revisions: [...revisions], assets: [...assets] };
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    const run = async () => {
      if (name === 'commons_my_models') return { data: structuredClone(state), error: null };
      if (name === 'commons_submit_model') {
        const revision = { id: revisionId, model_id: args.p_id, number: 1, metadata: args.p_metadata, status: 'pending', asset_version: 0, rights_basis: args.p_rights_basis, creator_profile_id: profileId, self_service: true, details_version: 1, submitted_at: '2026-11-03T00:00:00Z' };
        state.models = [{ id: args.p_id, latest_submission: revisionId, published_revision: args.p_expected_revision ?? null }];
        state.revisions = [revision]; return { data: revision, error: null };
      }
      if (name === 'commons_update_draft') {
        const current = state.revisions[0]!;
        if (current.details_version !== args.p_expected_version) return { data: null, error: { message: 'commons_conflict' } };
        const next = { ...current, metadata: args.p_metadata, details_version: (current.details_version as number) + 1 };
        state.revisions = [next]; return { data: next, error: null };
      }
      if (name === 'commons_publish_model') { state.revisions = [{ ...state.revisions[0]!, status: 'published' }]; state.models = [{ ...state.models[0]!, published_revision: revisionId }]; return { data: state.revisions[0], error: null }; }
      if (name === 'commons_withdraw_model') return { data: null, error: null };
      throw new Error('unexpected ' + name);
    };
    const promise = run(); return Object.assign(promise, { abortSignal: () => promise });
  });
  const account = {
    client: { rpc },
    session: { getAccessToken: async () => 'token', subscribe: () => () => {}, getSnapshot: () => snapshot },
    profiles: { mine: vi.fn(async () => activeProfile ? profile : null), save: vi.fn(async () => profile) },
  } as unknown as CommonsAccount;
  return { rpc, account, state };
}

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:preview'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  cloud.thumbnail.mockResolvedValue({ kind: 'image', blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }) });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); window.location.hash = ''; });

it('starts a private draft from a dropped file, shows upload and conversion progress, and publishes once confirmed', async () => {
  const f = setup();
  let progress: ((value: CommonsUploadProgress) => void) | undefined;
  let finishUpload: (value: CommonsUpload) => void = () => {};
  cloud.upload.mockImplementation((_base, _token, revision, _file, _signal, options) => { expect(revision).toBe(revisionId); progress = options.onProgress; return new Promise((resolve) => { finishUpload = resolve; }); });
  let emit: ((event: CommonsRenderEvent) => void) | undefined;
  let finishRender: (event: CommonsRenderEvent) => void = () => {};
  cloud.stream.mockImplementation((_base, _token, id, _signal, onEvent) => { expect(id).toBe(assetId); emit = onEvent; return new Promise((resolve) => { finishRender = resolve; }); });
  const published = vi.fn();
  render(<UploadDialog account={f.account} filesUrl="https://files.example.com" modelId={null} onClose={vi.fn()} onPublished={published}/>);
  expect(await screen.findByText('Drag a model file here')).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Choose a model file'), { target: { files: [new File(['model'], 'shop_bench.skb')] } });
  expect(await screen.findByDisplayValue('shop bench')).toBeTruthy();
  await waitFor(() => expect(f.rpc).toHaveBeenCalledWith('commons_submit_model', expect.objectContaining({ p_original_work: true, p_expected_revision: null,
    p_metadata: expect.objectContaining({ title: 'shop bench', category: 'Other', licenses: [expect.objectContaining({ name: 'CC BY 4.0' })] }) })));
  await waitFor(() => expect(progress).toBeDefined());
  act(() => progress!({ stage: 'uploading', loaded: 1024, total: 2048 }));
  expect(screen.getByText('Uploading 50%')).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
  await act(async () => { finishUpload(asset()); });
  await waitFor(() => expect(emit).toBeDefined());
  act(() => emit!({ state: 'converting' }));
  expect(screen.getByText('Converting preview')).toBeTruthy();

  const publish = screen.getByRole('button', { name: 'Publish model' }) as HTMLButtonElement;
  expect(publish.disabled).toBe(true);
  expect(screen.getByText('Confirm your right to share it.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Category/), { target: { value: 'Furniture' } });
  fireEvent.click(screen.getByRole('checkbox'));
  expect(publish.disabled).toBe(false);
  await act(async () => { emit!({ state: 'ready', triangles: 1200, durationMs: 40 }); finishRender({ state: 'ready', triangles: 1200, durationMs: 40 }); });
  expect(await screen.findByText('Preview ready')).toBeTruthy();
  expect(screen.getByText('1,200 triangles')).toBeTruthy();

  fireEvent.click(publish);
  await waitFor(() => expect(published).toHaveBeenCalledWith(expect.stringMatching(/^model-/)));
  expect(f.rpc).toHaveBeenCalledWith('commons_update_draft', expect.objectContaining({ p_revision: revisionId, p_metadata: expect.objectContaining({ category: 'Furniture', formats: ['SKB'] }) }));
  expect(f.rpc).toHaveBeenCalledWith('commons_publish_model', expect.objectContaining({ p_revision: revisionId, p_rights_confirmed: true }));
});

it('refuses files Commons cannot convert and asks for a public profile first', async () => {
  const f = setup();
  render(<UploadDialog account={f.account} filesUrl="https://files.example.com" modelId={null} onClose={vi.fn()} onPublished={vi.fn()}/>);
  await screen.findByText('Drag a model file here');
  fireEvent.change(screen.getByLabelText('Choose a model file'), { target: { files: [new File(['x'], 'scene.blend')] } });
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(f.rpc).not.toHaveBeenCalledWith('commons_submit_model', expect.anything());
  cleanup();
  const g = setup({ activeProfile: false });
  render(<UploadDialog account={g.account} filesUrl="https://files.example.com" modelId={null} onClose={vi.fn()} onPublished={vi.fn()}/>);
  fireEvent.change(await screen.findByLabelText('Public handle'), { target: { value: 'new-maker' } });
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'New Maker' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('Drag a model file here')).toBeTruthy();
  expect(g.account.profiles.save).toHaveBeenCalledWith(expect.objectContaining({ handle: 'new-maker', displayName: 'New Maker' }), null, true);
});

it('edits a published model without a new revision until something changes, then keeps its files', async () => {
  const published = { id: revisionId, model_id: 'model-bench', number: 1, status: 'published', asset_version: 2, rights_basis: 'x'.repeat(30), creator_profile_id: profileId, self_service: true, details_version: 3,
    metadata: metadataFor({ title: 'Bench', description: '', category: 'Furniture', license: 'CC0 1.0', terms: '' }, 'Example Maker', ['bench.skb']) };
  const f = setup({ models: [{ id: 'model-bench', latest_submission: revisionId, published_revision: revisionId }], revisions: [published], assets: [asset({ filename: 'bench.skb' })] });
  cloud.stream.mockResolvedValue({ state: 'ready', triangles: 10, durationMs: 1 });
  render(<UploadDialog account={f.account} filesUrl="https://files.example.com" modelId="model-bench" onClose={vi.fn()} onPublished={vi.fn()}/>);
  expect(await screen.findByDisplayValue('Bench')).toBeTruthy();
  expect(screen.getByText('bench.skb')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox'));
  expect((screen.getByRole('button', { name: 'Publish changes' }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.rpc).not.toHaveBeenCalledWith('commons_submit_model', expect.anything());
  fireEvent.change(screen.getByDisplayValue('Bench'), { target: { value: 'Garden bench' } });
  await waitFor(() => expect(f.rpc).toHaveBeenCalledWith('commons_submit_model', expect.objectContaining({ p_id: 'model-bench', p_expected_revision: revisionId,
    p_metadata: expect.objectContaining({ title: 'Garden bench' }) })), { timeout: 3000 });
  expect(cloud.upload).not.toHaveBeenCalled();
});

it('lists drafts and published models as cards and deletes a draft after confirming', async () => {
  const draft = { id: revisionId, model_id: 'model-draft', number: 1, status: 'pending', asset_version: 1, rights_basis: 'x'.repeat(30), creator_profile_id: profileId, self_service: true, details_version: 1, submitted_at: '2026-11-03T00:00:00Z',
    metadata: metadataFor({ title: 'Planter box', description: '', category: 'Outdoor and garden', license: 'CC BY 4.0', terms: '' }, 'Example Maker', ['box.stl']) };
  const f = setup({ models: [{ id: 'model-draft', latest_submission: revisionId, published_revision: null }], revisions: [draft], assets: [asset({ filename: 'box.stl', format: 'stl' })] });
  cloud.thumbnail.mockResolvedValue({ kind: 'status', status: 'rendering', error: null });
  render(<PublishPage account={f.account} filesUrl="https://files.example.com" route={{ kind: 'list' }} catalogReady={false}/>);
  expect(await screen.findByRole('heading', { name: 'Planter box' })).toBeTruthy();
  expect(screen.getByText('Draft')).toBeTruthy();
  expect(await screen.findByText('Converting preview')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'View' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Delete draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(cloud.deleteDraft).toHaveBeenCalledWith('https://files.example.com', 'token', 'model-draft', revisionId, expect.anything()));
  expect(await screen.findByText('Draft deleted.')).toBeTruthy();
});

it('maps routes, file states and details the way the dialog shows them', () => {
  expect(publishRoute('#upload')).toEqual({ kind: 'upload' });
  expect(publishRoute('#publish')).toEqual({ kind: 'upload' });
  expect(publishRoute('#edit/model-abc')).toEqual({ kind: 'edit', model: 'model-abc' });
  expect(publishRoute('#models/model-abc')).toBeNull();
  const file = { name: 'a.stl', size: 10, asset: null, upload: null, error: null, render: { state: 'idle' as const }, image: null };
  expect(fileStatus({ ...file, upload: { stage: 'verifying', loaded: 10, total: 10 } }).label).toBe('Checking file');
  expect(fileStatus({ ...file, asset: asset(), render: { state: 'waiting' } }).label).toBe('Waiting for converter');
  expect(fileStatus({ ...file, asset: asset(), render: { state: 'failed', error: 'Too many triangles.', code: 'triangle_limit', retry: false } })).toMatchObject({ label: 'Preview failed', tone: 'bad' });
  expect(fileStatus({ ...file, error: 'Network' }).label).toBe('Upload failed');
  expect(titleFromFileName('my_shop__bench.v2.skp')).toBe('my shop bench.v2');
  expect(detailsProblem({ title: '', description: '', category: 'Other', license: 'CC BY 4.0', terms: '' })).toBe('Add a title.');
  expect(detailsProblem({ title: 'A', description: '', category: 'Hardware', license: 'CC BY 4.0', terms: '' })).toBe('Choose a category.');
  expect(detailsProblem({ title: 'A', description: '', category: 'Other', license: 'other', terms: '  ' })).toBe('Describe your license terms.');
  const custom = metadataFor({ title: 'A', description: '', category: 'Other', license: 'other', terms: 'Personal use.\n\nNo resale.' }, 'Maker', ['a.dxf', 'cover.png']);
  expect(custom.licenses).toEqual([{ name: 'Custom license', url: null, commercialUse: 'unknown', conditions: ['Personal use.', 'No resale.'] }]);
  expect(custom.formats).toEqual(['DXF']);
  expect(detailsFromMetadata(custom)).toMatchObject({ license: 'other', terms: 'Personal use.\nNo resale.' });
});

it('takes a saved editor snapshot directly into details and requires a separate publication review', async () => {
  const f = setup(); const published = vi.fn();
  const file = new File(['saved snapshot bytes'], 'Garden bench.pf');
  cloud.upload.mockResolvedValue(asset({ filename: file.name, format: 'pf', size_bytes: file.size }));
  cloud.stream.mockResolvedValue({ state: 'pending' });
  render(<UploadDialog account={f.account} filesUrl="https://files.example.com" modelId={null} newModelId="design-snapshot" initialFile={file} snapshotLabel="Private cloud revision 12" onClose={vi.fn()} onPublished={published}/>);
  await waitFor(() => expect(cloud.upload).toHaveBeenCalledWith(expect.anything(), expect.anything(), revisionId, file, expect.anything(), expect.anything()));
  const review = await screen.findByRole('button', { name: 'Review publication' });
  await waitFor(() => expect((review as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(review);
  expect(screen.getByText('Review your public snapshot')).toBeTruthy();
  const back = screen.getByRole('button', { name: 'Back to details' });
  expect(back.closest('footer')).toBe(screen.getByRole('button', { name: 'Publish model' }).closest('footer'));
  expect(screen.queryByText('Draft saved')).toBeNull();
  fireEvent.click(back);
  expect(screen.getByDisplayValue('Garden bench')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Review publication' }));
  expect(f.rpc.mock.calls.some(([name]) => name === 'commons_publish_model')).toBe(false);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Publish model' }));
  await waitFor(() => expect(published).toHaveBeenCalledWith('design-snapshot'));
});

it('retains the original creator when publishing attributed editor content instead of assigning authorship to its uploader', async () => {
  const f = setup(); const file = new File(['snapshot'], 'Source bench.pf');
  cloud.upload.mockResolvedValue(asset({ filename: file.name, format: 'pf', size_bytes: file.size })); cloud.stream.mockResolvedValue({ state: 'pending' });
  const inherited = { creator: 'Original Maker', source: { name: 'Original source', url: 'https://models.example.com/bench' }, licenses: [{ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', commercialUse: 'allowed' as const, conditions: ['Retain creator credit'] }], credits: [{ name: 'Original Maker', url: null, text: 'Original design by Original Maker.' }] };
  render(<UploadDialog account={f.account} filesUrl="https://files.example.com" modelId={null} initialFile={file} inherited={inherited} snapshotLabel="Private cloud revision 12" onClose={vi.fn()} onPublished={vi.fn()}/>);
  await waitFor(() => expect(f.rpc).toHaveBeenCalledWith('commons_submit_model', expect.objectContaining({ p_original_work: false, p_metadata: expect.objectContaining({ creator: 'Original Maker', source: inherited.source, credits: expect.arrayContaining(inherited.credits) }) })));
  const submission = f.rpc.mock.calls.find(([name]) => name === 'commons_submit_model')![1].p_metadata as { credits: { text: string }[] };
  expect(submission.credits.some(credit => credit.text === 'Original model by Example Maker.')).toBe(false);
});

it('explains invalid handles inline without saving and clears errors when corrected', async () => {
  const f = setup({ activeProfile: false });
  render(<UploadDialog account={f.account} filesUrl="https://files.example.com" modelId={null} onClose={vi.fn()} onPublished={vi.fn()}/>);
  const handle = await screen.findByLabelText('Public handle');
  fireEvent.change(handle, { target: { value: '@maker' } });
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Maker' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect((await screen.findByRole('alert')).textContent).toContain('leave out the @');
  expect(handle.getAttribute('aria-invalid')).toBe('true');
  expect(f.account.profiles.save).not.toHaveBeenCalled();
  fireEvent.change(handle, { target: { value: 'new-maker' } });
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('Drag a model file here')).toBeTruthy();
});

it('keeps a copied source license exactly once through repeated draft saves without adding an original-work license', async () => {
  const f = setup();
  const license = { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/', commercialUse: 'allowed' as const, conditions: ['Retain original creator credit.'] };
  const inherited = { creator: 'Original Maker', source: { name: 'Source', url: 'https://models.example.com/chair' }, licenses: Array.from({ length: 5 }, () => ({ ...license })), credits: [{ name: 'Original Maker', url: null, text: 'Original chair.' }] };
  const file = new File(['snapshot'], 'Chair.pf');
  cloud.upload.mockResolvedValue(asset({ filename: file.name, format: 'pf', size_bytes: file.size }));
  cloud.stream.mockResolvedValue({ state: 'pending' });
  render(<UploadDialog account={f.account} filesUrl="https://files.example.com" modelId={null} initialFile={file} inherited={inherited} snapshotLabel="Private cloud revision 1" onClose={vi.fn()} onPublished={vi.fn()}/>);
  await waitFor(() => expect(cloud.upload).toHaveBeenCalled());
  expect(screen.queryByLabelText(/License \*/)).toBeNull();
  expect(screen.getByText('Source licenses retained')).toBeTruthy();
  for (const title of ['Textured chair', 'Finished chair']) {
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: title } });
    await waitFor(() => expect(f.rpc).toHaveBeenCalledWith('commons_update_draft', expect.objectContaining({ p_metadata: expect.objectContaining({ title, licenses: [license] }) })), { timeout: 2000 });
  }
  for (const [name, args] of f.rpc.mock.calls) if (name === 'commons_submit_model' || name === 'commons_update_draft') expect((args.p_metadata as { licenses: unknown[] }).licenses).toEqual([license]);
  fireEvent.click(screen.getByRole('button', { name: 'Review publication' }));
  expect(screen.getByText(/License: CC BY 3.0/)).toBeTruthy();
});

it('preserves source license versions and distinct terms on corrections', async () => {
  const { uniqueLicenses } = await import('./modelDetails');
  const first = { name: 'CC BY 3.0', url: 'https://creativecommons.org/licenses/by/3.0/', commercialUse: 'allowed' as const, conditions: ['Credit A.', 'Keep notice.'] };
  const second = { ...first, conditions: ['Credit B.'] };
  const previous = { ...metadataFor({ title: 'Chair', description: '', category: 'Furniture', license: 'CC BY 4.0', terms: '' }, 'Maker', ['chair.pf']), source: { name: 'Source', url: 'https://models.example.com/chair' }, licenses: [first, { ...first, conditions: [...first.conditions].reverse() }, second] };
  expect(uniqueLicenses(previous.licenses)).toEqual([first, second]);
  const details = detailsFromMetadata(previous);
  const corrected = metadataFor({ ...details, title: 'Textured chair' }, 'Maker', ['chair.pf'], previous);
  expect(corrected.licenses).toEqual([first, second]);
  expect(corrected.licenses.some(license => license.name === 'Custom license' || license.name === 'CC BY 4.0')).toBe(false);
});
