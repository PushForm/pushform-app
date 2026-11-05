// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { CommonsPublishing, commonsFileKind, deleteCommonsDraft, fetchCommonsImage, fetchCommonsThumbnail, type CommonsOwnModels, type CommonsOwnRevision } from '@pushform/cloud';
import type { CommonsAccount } from './account';
import { ModelCard, ModelGrid } from './ModelCard';
import { navigateCommons, profilePath } from './route';

export interface OwnedModel {
  id: string;
  revision: CommonsOwnRevision;
  draft: CommonsOwnRevision | null;
  published: string | null;
  modelAsset: string | null;
  coverAsset: string | null;
}
interface OwnState {
  account: CommonsAccount | null;
  api: CommonsPublishing | null;
  userId: string | null;
  models: OwnedModel[] | null;
  error: string | null;
  reload(): void;
}
const noop = () => {};
const noSubscription = () => noop;
const OwnContext = createContext<OwnState>({ account: null, api: null, userId: null, models: null, error: null, reload: noop });

/** Ownership comes from the authenticated model list, independently of public creator credits. */
export function OwnModelsProvider({ account, children }: { account: CommonsAccount | null; children: ReactNode }) {
  const userId = useSyncExternalStore(account?.session?.subscribe ?? noSubscription, () => account?.session?.getSnapshot().user?.id ?? null);
  const api = useMemo(() => account?.client ? new CommonsPublishing(account.client) : null, [account?.client]);
  const [loaded, setLoaded] = useState<{ userId: string; api: CommonsPublishing; state: CommonsOwnModels } | null>(null);
  const [failure, setFailure] = useState<{ userId: string; api: CommonsPublishing; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    window.addEventListener('commons:catalog-changed', reload);
    return () => window.removeEventListener('commons:catalog-changed', reload);
  }, [reload]);
  useEffect(() => {
    if (!api || !userId) return;
    const controller = new AbortController();
    setFailure(null);
    void api.mine(controller.signal).then(state => {
      if (!controller.signal.aborted) setLoaded({ userId, api, state });
    }, error => {
      if (!controller.signal.aborted) setFailure({ userId, api, message: error instanceof Error ? error.message : 'Your models could not be loaded.' });
    });
    return () => controller.abort();
  }, [api, userId, attempt]);
  const state = loaded?.userId === userId && loaded.api === api ? loaded.state : null;
  const models: OwnedModel[] | null = state ? state.models.flatMap(row => {
    const latest = state.revisions.find(revision => revision.id === row.latest_submission);
    const published = state.revisions.find(revision => revision.id === row.published_revision) ?? null;
    const draft = latest?.status === 'pending' ? latest : null;
    const revision = draft ?? published;
    if (!revision) return [];
    const assets = state.assets.filter(asset => asset.revision_id === revision.id && asset.status === 'ready');
    return [{ id: row.id, revision, draft, published: row.published_revision,
      modelAsset: assets.find(asset => commonsFileKind(asset.filename) !== 'image')?.id ?? null,
      coverAsset: assets.find(asset => commonsFileKind(asset.filename) === 'image')?.id ?? null }];
  }) : null;
  return <OwnContext.Provider value={{ account, api, userId, models, error: failure?.userId === userId && failure.api === api ? failure.message : null, reload }}>{children}</OwnContext.Provider>;
}
export const useOwnModels = () => useContext(OwnContext);

export async function openOwnProfile(account: CommonsAccount): Promise<void> {
  const userId = account.session.getSnapshot().user?.id;
  const profile = await account.profiles.mine().catch(() => null);
  if (account.session.getSnapshot().user?.id !== userId) return;
  if (profile?.active) navigateCommons(profilePath(profile.handle));
  else window.location.hash = '#account';
}

export function OwnerModelActions({ model, filesUrl }: { model: OwnedModel; filesUrl: string | undefined }) {
  const { account, api, userId } = useOwnModels();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draftRemoved, setDraftRemoved] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    if (!account || !api || !userId || busy) return;
    const checkSession = () => {
      if (account.session.getSnapshot().user?.id !== userId) throw new Error('Your account changed. Reload before deleting a model.');
    };
    setBusy(true); setError('');
    try {
      checkSession();
      if (model.draft && !draftRemoved) {
        if (!filesUrl) throw new Error('Model deletion is unavailable in this build.');
        const token = await account.session.getAccessToken();
        checkSession();
        if (!token) throw new Error('Sign in again to delete your model.');
        await deleteCommonsDraft(filesUrl, token, model.id, model.draft.id, new AbortController().signal);
        setDraftRemoved(true);
      }
      checkSession();
      if (model.published) await api.withdraw(model.id, model.published);
      checkSession();
      window.dispatchEvent(new Event('commons:catalog-changed'));
      await openOwnProfile(account);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Your model could not be deleted.');
      setBusy(false);
    }
  };
  return <section className="owner-model-actions" aria-label="Manage your model">
    <div className="collection-actions"><a className="secondary-button" href={`#edit/${model.id}`}>Edit model</a>
      <button type="button" className="text-button" disabled={busy} onClick={() => setConfirm(true)}>Delete model</button></div>
    {model.published && model.draft && <p>Unpublished changes are saved for this model.</p>}
    {confirm && <div role="group" aria-label="Delete model confirmation"><p>Delete “{model.revision.metadata.title}”{model.published ? ' from Commons, including its unpublished changes' : ''}?{model.published && ' Copies already downloaded keep their licenses.'}</p>
      <button type="button" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete this model'}</button>{' '}
      <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirm(false)}>Keep model</button></div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

function OwnPreview({ model, filesUrl }: { model: OwnedModel; filesUrl: string | undefined }) {
  const { account } = useOwnModels();
  const [image, setImage] = useState<string | null>(null);
  const [preview, setPreview] = useState('Loading preview');
  useEffect(() => {
    setImage(null);
    if (!account || !filesUrl) { setPreview('No preview'); return; }
    const controller = new AbortController(); let objectURL: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finishWait: (() => void) | undefined;
    void (async () => {
      const token = await account.session.getAccessToken();
      if (!token || controller.signal.aborted) return;
      const show = (blob: Blob) => { if (!controller.signal.aborted) { objectURL = URL.createObjectURL(blob); setImage(objectURL); } };
      if (model.coverAsset) { show(await fetchCommonsImage(filesUrl, token, model.coverAsset, controller.signal)); return; }
      if (!model.modelAsset) { setPreview('No preview'); return; }
      for (let attempt = 0; attempt < 60 && !controller.signal.aborted; attempt++) {
        const result = await fetchCommonsThumbnail(filesUrl, token, model.modelAsset, controller.signal);
        if (controller.signal.aborted) return;
        if (result.kind === 'image') { show(result.blob); return; }
        if (result.status !== 'queued' && result.status !== 'rendering') { setPreview('No preview'); return; }
        setPreview('Converting preview');
        await new Promise<void>(resolve => { finishWait = resolve; timer = setTimeout(resolve, 4000); });
      }
    })().catch(() => { if (!controller.signal.aborted) setPreview('No preview'); });
    return () => { controller.abort(); clearTimeout(timer); finishWait?.(); if (objectURL) URL.revokeObjectURL(objectURL); };
  }, [account, filesUrl, model.coverAsset, model.modelAsset]);
  return image ? <img src={image} alt="" /> : <div className="missing-image"><span aria-hidden="true">◇</span><span>{preview}</span></div>;
}

export function OwnModelGrid({ filesUrl }: { filesUrl: string | undefined }) {
  const { models, error, reload } = useOwnModels();
  return <section aria-labelledby="own-models-title"><h2 id="own-models-title">My Models</h2>
    {error ? <div role="alert"><p>{error}</p><button onClick={reload}>Reload models</button></div> : !models ? <p role="status">Loading your models…</p> : !models.length ? <p>You haven’t uploaded a model yet.</p> :
      <ModelGrid>{models.map(model => <ModelCard key={model.id + model.revision.id} model={{ ...model.revision.metadata, id: model.id, revision: model.revision.id }} filesUrl={filesUrl}
        art={<OwnPreview model={model} filesUrl={filesUrl} />} footer={<p>{model.published ? 'Published' : 'Draft'}{model.published && model.draft ? ' · Unpublished changes' : ''}</p>} />)}</ModelGrid>}
  </section>;
}

export function OwnedDraftDetail({ model, filesUrl }: { model: OwnedModel; filesUrl: string | undefined }) {
  const metadata = model.revision.metadata;
  return <article className="model-detail"><div className="detail-image"><OwnPreview model={model} filesUrl={filesUrl} /></div><div>
    <p className="eyebrow">{model.published ? 'Published model' : 'Private draft'} · {metadata.category}</p><h1>{metadata.title}</h1><p>{metadata.description}</p>
    <OwnerModelActions key={model.id} model={model} filesUrl={filesUrl} />
  </div></article>;
}
