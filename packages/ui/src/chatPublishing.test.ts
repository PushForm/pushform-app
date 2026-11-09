// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, vi } from 'vitest';
import type { CloudFilesApi } from '@pushform/cloud';
import type { CommonsAccount } from '@pushform/commons-ui/account';
import { chatPublishing } from './chatPublishing';
import type { CloudAutosave } from './cloudAutosave';
import { commonsDesignId } from './components/PublishSnapshot';
import type { DocumentTab } from './session';

const FILE = 'file-1';
function modelTab(attributions: unknown[] = []): DocumentTab {
  return {
    id: 't1', type: 'model', name: 'Shaker base.pf', identity: `cloud:user-1:project-1:${FILE}:rev-4`,
    app: { document: { doc: { state: { meta: { attributions } } } },
      viewport: { camera: { getState: () => ({ position: [1, 1, 1] }) }, renderer: null, snapshotInto: () => false } },
  } as unknown as DocumentTab;
}
function fixture({ changed = true, collections = [] as { id: string; title: string }[], published = null as null | { title: string } } = {}) {
  const saves = { needsSave: vi.fn(() => changed), saveNow: vi.fn(async () => {}) } as unknown as CloudAutosave;
  const files = {
    head: vi.fn(async () => ({ file: { revision_number: 4 } })),
    openRevision: vi.fn(async () => ({ file: { id: FILE, revision_number: 4, name: 'Shaker base.pf' }, revision: { id: 'rev-4' }, bytes: new Uint8Array([1]) })),
  } as unknown as CloudFilesApi;
  const rpc = vi.fn((name: string) => {
    const run = async () => {
      if (name === 'commons_my_collections') return { data: collections.map(item => ({ id: item.id, title: item.title, description: '', visibility: 'private', version: 1, updatedAt: '2026-11-06T00:00:00Z', curator: null, modelIds: [] })), error: null };
      if (name === 'commons_my_models') {
        if (!published) return { data: { models: [], revisions: [], assets: [] }, error: null };
        const id = await commonsDesignId(FILE), revision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        return { data: { models: [{ id, latest_submission: revision, published_revision: revision }], assets: [], revisions: [{ id: revision, model_id: id, number: 1, status: 'published', asset_version: 0,
          rights_basis: 'x', creator_profile_id: null, self_service: true, details_version: 1, submitted_at: '2026-11-03T00:00:00Z',
          metadata: { title: published.title, description: 'Old description.', category: 'Cabinets and built-ins', creator: 'Me', tags: [], formats: ['pf'], imageUrl: null, source: null,
            licenses: [{ name: 'CC BY-NC 4.0', url: 'https://creativecommons.org/licenses/by-nc/4.0/', commercialUse: 'restricted', conditions: [] }], credits: [{ name: 'Me', url: null, text: 'Original model by Me.' }] } }] }, error: null };
      }
      throw new Error('unexpected ' + name);
    };
    const promise = run(); return Object.assign(promise, { abortSignal: () => promise });
  });
  const account = { client: { rpc }, profiles: { mine: vi.fn(async () => ({ active: true })) } } as unknown as CommonsAccount;
  const openPublishing = vi.fn(async () => ({ modelId: 'design-x', failures: [] as string[] }));
  return { saves, files, rpc, openPublishing, host: chatPublishing({ files, saves, commons: { account }, openPublishing }) };
}

describe('AI Chat saving and publishing in the editor', () => {
  it('saves a new version with notes, or keeps the current one without them', async () => {
    const changed = fixture();
    expect(await changed.host.save(modelTab(), ' Added drawer runners ')).toEqual({ revision: 4, saved: true });
    expect(changed.saves.saveNow).toHaveBeenCalledWith(expect.anything(), 'Added drawer runners');
    const same = fixture({ changed: false });
    expect(await same.host.save(modelTab(), 'ignored')).toEqual({ revision: 4, saved: false });
    expect(same.saves.saveNow).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('offers only saving without a Commons account', () => {
    const { files, saves } = fixture();
    const host = chatPublishing({ files, saves, openPublishing: vi.fn() });
    expect(host.prepare).toBeUndefined();
    expect(host.info).toBeUndefined();
  });

  it('prepares a new publication: suggested license, matched and new collections, a known category, the file name as title', async () => {
    const shaker = { id: '11111111-1111-4111-8111-111111111111', title: 'Shaker cabinets' };
    const { host, openPublishing } = fixture({ collections: [shaker] });
    const prepared = await host.prepare!(modelTab(), { description: 'A 30 in base cabinet.', category: 'cabinets and built-ins', collections: ['shaker CABINETS', 'Kitchens'] });
    expect(prepared).toMatchObject({ revision: 4, savedLine: 'Saved version 4.', update: false, title: 'Shaker base', description: 'A 30 in base cabinet.', category: 'Cabinets and built-ins',
      license: { name: 'CC BY 4.0' }, retained: null, collections: [{ name: 'Shaker cabinets', isNew: false }, { name: 'Kitchens', isNew: true }] });
    const made = await host.publish!(prepared, true);
    expect(openPublishing).toHaveBeenCalledWith(expect.objectContaining({ bytes: expect.any(Uint8Array) }),
      { details: expect.objectContaining({ title: 'Shaker base', license: 'CC BY 4.0', category: 'Cabinets and built-ins' }), collections: { ids: [shaker.id], names: ['Kitchens'] } }, true);
    expect(made).toEqual({ title: 'Shaker base', url: 'https://commons.pushform.io/#models/design-x', failedCollections: [] });
  });

  it('updates a published model from its current details, changing only what was proposed', async () => {
    const { host } = fixture({ published: { title: 'Shaker base cabinet' } });
    const prepared = await host.prepare!(modelTab(), { description: 'Now 36 in wide.' });
    expect(prepared).toMatchObject({ update: true, title: 'Shaker base cabinet', description: 'Now 36 in wide.', category: 'Cabinets and built-ins', license: { name: 'CC BY-NC 4.0' } });
  });

  it('keeps a copy\'s source licenses, and refuses one with a no-derivatives source', async () => {
    const source = (name: string) => ({ licenses: [{ name, url: null, commercialUse: 'allowed', conditions: [] }], credits: [], creator: 'Someone' });
    const kept = await fixture().host.prepare!(modelTab([source('CC BY 3.0')]), { license: 'CC0 1.0' });
    expect(kept).toMatchObject({ license: null, retained: ['CC BY 3.0'] });
    await expect(fixture().host.prepare!(modelTab([source('CC BY-ND 4.0')]), {})).rejects.toThrow('no-derivatives');
    expect(await fixture().host.info!(modelTab([source('CC BY-ND 4.0')]))).toMatchObject({ available: false });
  });
});
