// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommonsCollection, CommonsRenderEvent, CommonsUpload, CommonsUploadProgress } from '@pushform/cloud';
import { UploadDialog, collectionChanges, collectionChosen, fileStatus } from './UploadDialog';
import { publishRoute } from './PublishPage';
import { OwnModelsProvider, OwnModelGrid, OwnedDraftDetail, useOwnModels } from './OwnModels';
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

const collection = (overrides: Partial<CommonsCollection> = {}): CommonsCollection => ({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', title: 'Shop jigs', description: 'Jigs I use.', visibility: 'public', version: 4,
  updatedAt: '2026-11-03T00:00:00Z', curator: { handle: 'example-maker', displayName: 'Example Maker' }, modelIds: ['model-other'], ...overrides });

function setup({ models = [] as unknown[], revisions = [] as Record<string, unknown>[], assets = [] as CommonsUpload[], activeProfile = true, collections = [] as CommonsCollection[], failCollection = null as string | null } = {}) {
  const state = { models: [...models] as Record<string, unknown>[], revisions: [...revisions], assets: [...assets], collections: structuredClone(collections) };
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
      if (name === 'commons_my_collections') return { data: structuredClone(state.collections), error: null };
      if (name === 'commons_save_collection') {
        if (args.p_id && args.p_id === failCollection) return { data: null, error: { message: 'commons_collection_conflict' } };
        const current = state.collections.find((item) => item.id === args.p_id);
        const saved = { ...(current ?? collection({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', version: 0 })), title: args.p_title as string, description: args.p_description as string,
          visibility: (args.p_public ? 'public' : 'private') as CommonsCollection['visibility'], modelIds: args.p_model_ids as string[], version: (current?.version ?? 0) + 1 };
        state.collections = [...state.collections.filter((item) => item.id !== saved.id), saved]; return { data: saved, error: null };
      }
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
afterEach(() => { cleanup(); vi.clearAllMocks(); window.history.replaceState(null, '', '/'); });

it('starts a private draft from a dropped file, shows upload and conversion progress, and publishes directly from details', async () => {
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
  expect(publish.disabled).toBe(false);
  expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.change(screen.getByLabelText(/Title/), { target: { value: '' } });
  expect(publish.disabled).toBe(true);
  expect(screen.getByText('Add a title.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'shop bench' } });
  fireEvent.change(screen.getByLabelText(/Category/), { target: { value: 'Furniture' } });
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
  expect((screen.getByRole('button', { name: 'Publish changes' }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.rpc).not.toHaveBeenCalledWith('commons_submit_model', expect.anything());
  fireEvent.change(screen.getByDisplayValue('Bench'), { target: { value: 'Garden bench' } });
  await waitFor(() => expect(f.rpc).toHaveBeenCalledWith('commons_submit_model', expect.objectContaining({ p_id: 'model-bench', p_expected_revision: revisionId,
    p_metadata: expect.objectContaining({ title: 'Garden bench' }) })), { timeout: 3000 });
  expect(cloud.upload).not.toHaveBeenCalled();
});

it('opens a saved draft from the profile and deletes it from its detail page after confirming', async () => {
  const draft = { id: revisionId, model_id: 'model-draft', number: 1, status: 'pending', asset_version: 1, rights_basis: 'x'.repeat(30), creator_profile_id: profileId, self_service: true, details_version: 1, submitted_at: '2026-11-03T00:00:00Z',
    metadata: metadataFor({ title: 'Planter box', description: '', category: 'Outdoor and garden', license: 'CC BY 4.0', terms: '' }, 'Example Maker', ['box.stl']) };
  const f = setup({ models: [{ id: 'model-draft', latest_submission: revisionId, published_revision: null }], revisions: [draft], assets: [asset({ filename: 'box.stl', format: 'stl' })] });
  cloud.thumbnail.mockResolvedValue({ kind: 'status', status: 'rendering', error: null });
  function DraftPage() {
    const model = useOwnModels().models?.[0];
    return model ? <OwnedDraftDetail model={model} filesUrl="https://files.example.com"/> : null;
  }
  const view = render(<OwnModelsProvider account={f.account}><OwnModelGrid filesUrl="https://files.example.com"/></OwnModelsProvider>);
  expect(await screen.findByRole('heading', { name: 'Planter box' })).toBeTruthy();
  expect(screen.getByText('Draft')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Planter box' }).getAttribute('href')).toBe('/models/model-draft');
  expect(screen.queryByRole('button', { name: 'Delete model' })).toBeNull();
  view.rerender(<OwnModelsProvider account={f.account}><DraftPage/></OwnModelsProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete this model' }));
  await waitFor(() => expect(cloud.deleteDraft).toHaveBeenCalledWith('https://files.example.com', 'token', 'model-draft', revisionId, expect.anything()));
  await waitFor(() => expect(window.location.pathname).toBe('/u/example-maker'));
});

it('maps routes, file states and details the way the dialog shows them', () => {
  expect(publishRoute('#upload')).toEqual({ kind: 'upload' });
  expect(publishRoute('#publish')).toEqual({ kind: 'upload' });
  expect(publishRoute('#edit/model-abc')).toEqual({ kind: 'edit', model: 'model-abc' });
  expect(publishRoute('#models/model-abc')).toBeNull();
  expect(publishRoute('#my-models')).toBeNull();
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

it('publishes a saved editor snapshot directly from details without a review step or rights checkbox', async () => {
  const f = setup(); const published = vi.fn();
  const file = new File(['saved snapshot bytes'], 'Garden bench.pf');
  cloud.upload.mockResolvedValue(asset({ filename: file.name, format: 'pf', size_bytes: file.size }));
  cloud.stream.mockResolvedValue({ state: 'pending' });
  render(<UploadDialog account={f.account} filesUrl="https://files.example.com" modelId={null} newModelId="design-snapshot" initialFile={file} snapshotLabel="Private cloud revision 12" onClose={vi.fn()} onPublished={published}/>);
  await waitFor(() => expect(cloud.upload).toHaveBeenCalledWith(expect.anything(), expect.anything(), revisionId, file, expect.anything(), expect.anything()));
  const publish = await screen.findByRole('button', { name: 'Publish model' });
  await waitFor(() => expect((publish as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByDisplayValue('Garden bench')).toBeTruthy();
  expect(screen.getByText(/Private cloud revision 12/)).toBeTruthy();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Review publication' })).toBeNull();
  expect(screen.queryByText('2 Review')).toBeNull();
  expect(f.rpc.mock.calls.some(([name]) => name === 'commons_publish_model')).toBe(false);
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
  expect(screen.getByText('CC BY 3.0')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Publish model' }));
  await waitFor(() => expect(f.rpc).toHaveBeenCalledWith('commons_publish_model', expect.objectContaining({ p_rights_confirmed: true })));
  expect((f.state.revisions[0]!.metadata as { licenses: unknown[] }).licenses).toEqual([license]);
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

it('saves an editor snapshot draft without publishing', async () => {
  const f = setup(); const closed = vi.fn(); const published = vi.fn();
  const file = new File(['saved snapshot bytes'], 'Private bench.pf');
  cloud.upload.mockResolvedValue(asset({ filename: file.name, format: 'pf', size_bytes: file.size }));
  cloud.stream.mockResolvedValue({ state: 'pending' });
  render(<UploadDialog account={f.account} filesUrl="https://files.example.com" modelId={null} initialFile={file} snapshotLabel="Private cloud revision 3" onClose={closed} onPublished={published}/>);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Publish model' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
  await waitFor(() => expect(closed).toHaveBeenCalledOnce());
  expect(published).not.toHaveBeenCalled();
  expect(f.rpc.mock.calls.some(([name]) => name === 'commons_publish_model')).toBe(false);
});

it('uses the editor-rendered current view and uploads it without waiting for server rendering', async () => {
  const f = setup();
  const file = new File(['snapshot'], 'cabinet.pf');
  const image = new File(['png'], 'current-view.png', { type: 'image/png' });
  cloud.upload.mockImplementation(async (_url, _token, _revision, source) => asset({ filename: source.name, format: source === file ? 'pf' : 'png', size_bytes: source.size, id: source === file ? assetId : 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }));
  render(<UploadDialog account={f.account} filesUrl="https://files.example.com" modelId={null} initialFile={file} initialImage={image} snapshotLabel="Private cloud revision 12" onClose={vi.fn()} onPublished={vi.fn()} />);
  await waitFor(() => expect(cloud.upload).toHaveBeenCalledWith(expect.anything(), expect.anything(), revisionId, image, expect.anything(), expect.anything()));
  expect(cloud.stream).not.toHaveBeenCalled();
  expect(screen.getByRole('img', { name: 'Preview of cabinet' }).getAttribute('src')).toBe('blob:preview');
  expect(screen.queryByRole('button', { name: 'Replace file' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  await waitFor(() => expect((screen.getByRole('button', { name: 'Add a cover photo' }) as HTMLButtonElement).disabled).toBe(false));
  const cover = new File(['photo'], 'cover.png', { type: 'image/png' });
  fireEvent.change(screen.getByLabelText('Choose a cover photo'), { target: { files: [cover] } });
  await screen.findByRole('img', { name: 'Cover photo' });
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(cloud.upload.mock.calls.filter(call => call[3] === image)).toHaveLength(2));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Publish model' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByRole('img', { name: 'Cover photo' })).toBeNull();
});

it('lets the publisher retry a failed current-view upload before publication', async () => {
  const f = setup();
  const file = new File(['snapshot'], 'cabinet.pf');
  const image = new File(['png'], 'current-view.png', { type: 'image/png' });
  let failed = false;
  cloud.upload.mockImplementation(async (_url, _token, _revision, source) => {
    if (source === image && !failed) { failed = true; throw new Error('Preview upload interrupted.'); }
    return asset({ filename: source.name, format: source === file ? 'pf' : 'png', size_bytes: source.size });
  });
  render(<UploadDialog account={f.account} filesUrl="https://files.example.com" modelId={null} initialFile={file} initialImage={image} snapshotLabel="Private cloud revision 12" onClose={vi.fn()} onPublished={vi.fn()} />);
  const retry = await screen.findByRole('button', { name: 'Retry preview upload' });
  expect((screen.getByRole('button', { name: 'Publish model' }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.rpc.mock.calls.some(([name]) => name === 'commons_publish_model')).toBe(false);
  fireEvent.click(retry);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Publish model' }) as HTMLButtonElement).disabled).toBe(false));
  expect(cloud.upload.mock.calls.filter(call => call[3] === image)).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Publish model' }));
  await waitFor(() => expect(f.rpc).toHaveBeenCalledWith('commons_publish_model', expect.objectContaining({ p_rights_confirmed: true })));
});

it('adds a new model to chosen and newly named collections once it is published', async () => {
  const jigs = collection(), full = collection({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', title: 'Everything', modelIds: Array.from({ length: 100 }, (_, index) => `model-${index}`) });
  const f = setup({ collections: [jigs, full] }); const published = vi.fn(); const changed = vi.fn();
  window.addEventListener('commons:catalog-changed', changed);
  const file = new File(['saved snapshot bytes'], 'Garden bench.pf');
  cloud.upload.mockResolvedValue(asset({ filename: file.name, format: 'pf', size_bytes: file.size }));
  cloud.stream.mockResolvedValue({ state: 'pending' });
  const close = vi.fn();
  render(<UploadDialog account={f.account} filesUrl="https://files.example.com" modelId={null} newModelId="design-snapshot" initialFile={file} snapshotLabel="Private cloud revision 12" onClose={close} onPublished={published}/>);
  // A closed dropdown keeps the form short: it summarizes the choice and lists nothing until opened.
  const trigger = await screen.findByRole('button', { name: 'Collections None' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('checkbox', { name: /Shop jigs/ })).toBeNull();
  fireEvent.click(trigger);
  const shopJigs = screen.getByRole('checkbox', { name: /Shop jigs/ }) as HTMLInputElement;
  expect(shopJigs.checked).toBe(false);
  expect((screen.getByRole('checkbox', { name: /Everything · full/ }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(shopJigs);
  fireEvent.change(screen.getByLabelText('New collection name'), { target: { value: 'Garden projects' } });
  fireEvent.keyDown(screen.getByLabelText('New collection name'), { key: 'Enter' });
  expect((screen.getByRole('checkbox', { name: /Garden projects · new, private/ }) as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByLabelText('New collection name'), { target: { value: 'shop JIGS' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add new collection' }));
  expect(screen.getByText(/already have a collection called/)).toBeTruthy();
  // Escape closes only the dropdown, which then summarizes what will be applied.
  fireEvent.keyDown(shopJigs, { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByRole('checkbox', { name: /Shop jigs/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Collections Shop jigs, Garden projects' }).getAttribute('aria-expanded')).toBe('false');
  // Nothing is saved to a collection before the model is public.
  expect(f.rpc.mock.calls.some(([name]) => name === 'commons_save_collection')).toBe(false);

  const publish = await screen.findByRole('button', { name: 'Publish model' });
  await waitFor(() => expect((publish as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(publish);
  await waitFor(() => expect(published).toHaveBeenCalledWith('design-snapshot'));
  const names = f.rpc.mock.calls.map(([name]) => name);
  expect(names.lastIndexOf('commons_publish_model')).toBeLessThan(names.indexOf('commons_save_collection'));
  expect(f.rpc).toHaveBeenCalledWith('commons_save_collection', expect.objectContaining({ p_id: jigs.id, p_title: 'Shop jigs', p_description: 'Jigs I use.', p_public: true,
    p_model_ids: ['model-other', 'design-snapshot'], p_expected_version: 4 }));
  expect(f.rpc).toHaveBeenCalledWith('commons_save_collection', expect.objectContaining({ p_id: null, p_title: 'Garden projects', p_public: false, p_model_ids: ['design-snapshot'], p_expected_version: null }));
  expect(f.rpc.mock.calls.filter(([name]) => name === 'commons_save_collection')).toHaveLength(2);
  expect(changed).toHaveBeenCalled();
  window.removeEventListener('commons:catalog-changed', changed);
});

it('changes only the collections of a published model without republishing it', async () => {
  const published = { id: revisionId, model_id: 'model-bench', number: 1, status: 'published', asset_version: 2, rights_basis: 'x'.repeat(30), creator_profile_id: profileId, self_service: true, details_version: 3,
    metadata: metadataFor({ title: 'Bench', description: '', category: 'Furniture', license: 'CC0 1.0', terms: '' }, 'Example Maker', ['bench.skb']) };
  const jigs = collection({ modelIds: ['model-other', 'model-bench', 'model-last'] });
  const f = setup({ models: [{ id: 'model-bench', latest_submission: revisionId, published_revision: revisionId }], revisions: [published], assets: [asset({ filename: 'bench.skb' })], collections: [jigs] });
  cloud.stream.mockResolvedValue({ state: 'ready', triangles: 10, durationMs: 1 });
  const done = vi.fn();
  render(<UploadDialog account={f.account} filesUrl="https://files.example.com" modelId="model-bench" onClose={vi.fn()} onPublished={done}/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Collections Shop jigs' }));
  const member = screen.getByRole('checkbox', { name: /Shop jigs/ }) as HTMLInputElement;
  expect(member.checked).toBe(true);
  expect((screen.getByRole('button', { name: 'Publish changes' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(member);
  fireEvent.click(screen.getByRole('button', { name: 'Save collections' }));
  await waitFor(() => expect(done).toHaveBeenCalledWith('model-bench'));
  expect(f.rpc).toHaveBeenCalledWith('commons_save_collection', expect.objectContaining({ p_id: jigs.id, p_model_ids: ['model-other', 'model-last'], p_expected_version: 4 }));
  expect(f.rpc.mock.calls.some(([name]) => name === 'commons_submit_model' || name === 'commons_publish_model')).toBe(false);
});

it('keeps the publication and explains a collection that could not be updated', async () => {
  const jigs = collection();
  const f = setup({ collections: [jigs], failCollection: jigs.id }); const published = vi.fn();
  const file = new File(['saved snapshot bytes'], 'Garden bench.pf');
  cloud.upload.mockResolvedValue(asset({ filename: file.name, format: 'pf', size_bytes: file.size }));
  cloud.stream.mockResolvedValue({ state: 'pending' });
  render(<UploadDialog account={f.account} filesUrl="https://files.example.com" modelId={null} newModelId="design-snapshot" initialFile={file} snapshotLabel="Private cloud revision 12" onClose={vi.fn()} onPublished={published}/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Collections None' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Shop jigs/ }));
  const publish = await screen.findByRole('button', { name: 'Publish model' });
  await waitFor(() => expect((publish as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(publish);
  expect(await screen.findByText(/Published, but some collections were not updated\. “Shop jigs”: This collection changed in another tab/)).toBeTruthy();
  expect(f.rpc).toHaveBeenCalledWith('commons_publish_model', expect.objectContaining({ p_rights_confirmed: true }));
  expect(published).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Publish model' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(published).toHaveBeenCalledWith('design-snapshot');
});

it('computes collection saves only for collections whose membership the publisher changed', () => {
  const a = collection({ id: '11111111-1111-4111-8111-111111111111', modelIds: ['x', 'm'] }), b = collection({ id: '22222222-2222-4222-8222-222222222222', modelIds: [] }), c = collection({ id: '33333333-3333-4333-8333-333333333333', modelIds: ['y'] });
  expect(collectionChosen(a, 'm', {})).toBe(true);
  expect(collectionChosen(a, null, {})).toBe(false);
  expect(collectionChosen(a, 'm', { [a.id]: false })).toBe(false);
  // b is already a member in fresh state (added in another tab), so it needs no save; c was not touched.
  const changes = collectionChanges([a, { ...b, modelIds: ['m'] }, c], 'm', { [a.id]: false, [b.id]: true });
  expect(changes).toEqual([{ collection: a, fields: { title: a.title, description: a.description, visibility: a.visibility, modelIds: ['x'] } }]);
});
