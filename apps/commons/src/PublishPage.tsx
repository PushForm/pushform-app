// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react';
import { CommonsPublishing, commonsFileKind, deleteCommonsDraft, fetchCommonsImage, fetchCommonsThumbnail, type CommonsOwnModels, type CommonsOwnRevision } from '@pushform/cloud';
import type { CommonsAccount } from './account';
import { CommonsAccessGate } from './CommonsAccess';
import { UploadDialog } from './UploadDialog';

/** `#my-models`, `#upload` (new model) and `#edit/<model>` all show My models; the last two open the dialog over it. */
export type PublishRoute = { kind: 'list' } | { kind: 'upload' } | { kind: 'edit'; model: string };
export function publishRoute(hash: string): PublishRoute | null {
  if (hash === '#my-models') return { kind: 'list' };
  if (hash === '#upload' || hash === '#publish') return { kind: 'upload' };
  const edit = /^#edit\/([a-z0-9][a-z0-9-]{0,95})$/.exec(hash);
  return edit ? { kind: 'edit', model: edit[1]! } : null;
}

export function PublishPage({ account, filesUrl, route, catalogReady }: { account: CommonsAccount; filesUrl?: string | undefined; route: PublishRoute; catalogReady: boolean }): JSX.Element {
  const user = useSyncExternalStore(account.session.subscribe, account.session.getSnapshot).user;
  return <CommonsAccessGate account={account}><MyModels key={user?.id ?? 'signed-out'} account={account} filesUrl={filesUrl} route={route} catalogReady={catalogReady}/></CommonsAccessGate>;
}

interface Card { id: string; revision: CommonsOwnRevision; draft: CommonsOwnRevision | null; published: string | null; modelAsset: string | null; coverAsset: string | null }

function MyModels({ account, filesUrl, route, catalogReady }: { account: CommonsAccount; filesUrl: string | undefined; route: PublishRoute; catalogReady: boolean }): JSX.Element {
  const api = useMemo(() => new CommonsPublishing(account.client), [account.client]);
  const [state, setState] = useState<CommonsOwnModels | null>(null);
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    void api.mine(abort.signal).then(setState, (failure) => { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : 'Your models could not be loaded.'); });
    return () => abort.abort();
  }, [api, attempt]);
  useEffect(() => { document.title = 'My models — PushForm Commons'; }, []);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const token = useCallback(async () => { const value = await account.session.getAccessToken(); if (!value) throw new Error('Sign in again to manage your models.'); return value; }, [account.session]);

  const cards: Card[] = (state?.models ?? []).flatMap((row) => {
    const latest = state!.revisions.find((item) => item.id === row.latest_submission);
    const published = state!.revisions.find((item) => item.id === row.published_revision) ?? null;
    const draft = latest?.status === 'pending' ? latest : null;
    const revision = draft ?? published;
    if (!revision) return [];
    const files = state!.assets.filter((asset) => asset.revision_id === revision.id && asset.status === 'ready');
    return [{ id: row.id, revision, draft, published: row.published_revision,
      modelAsset: files.find((asset) => commonsFileKind(asset.filename) !== 'image')?.id ?? null,
      coverAsset: files.find((asset) => commonsFileKind(asset.filename) === 'image')?.id ?? null }];
  });

  const close = () => { window.location.hash = '#my-models'; reload(); };
  const published = (model: string) => {
    if (catalogReady) { window.location.hash = `#models/${model}`; return; }
    setMessage('Model published. It will appear in the library when Commons opens.');
    close();
  };
  return <section className="publish-page my-models">
    <div className="section-heading">
      <div><p className="eyebrow">Your contributions</p><h1 ref={heading} tabIndex={-1}>My models</h1></div>
      <a className="button-link" href="#upload">Upload model</a>
    </div>
    {error && <section className="status-panel" role="alert"><p>{error}</p><button onClick={() => { setError(''); reload(); }}>Try again</button></section>}
    {message && <p role="status" className="page-message">{message}</p>}
    {!state && !error ? <p role="status">Loading your models…</p> : state && cards.length === 0 ? <section className="status-panel">
      <h3>You haven’t uploaded a model yet.</h3><p>Drop a model file to start. It stays private until you publish it.</p><a className="button-link" href="#upload">Upload model</a></section>
      : <div className="model-cards">{cards.map((card) => <ModelCard key={card.id + card.revision.id} card={card} filesUrl={filesUrl} token={token} api={api}
        onChanged={(note) => { setMessage(note); reload(); }}/>)}</div>}
    {route.kind !== 'list' && <UploadDialog key={route.kind === 'edit' ? route.model : 'new'} account={account} filesUrl={filesUrl}
      modelId={route.kind === 'edit' ? route.model : null} onClose={close} onPublished={published}/>}
  </section>;
}

function ModelCard({ card, filesUrl, token, api, onChanged }: { card: Card; filesUrl: string | undefined; token: () => Promise<string>; api: CommonsPublishing; onChanged(note: string): void }): JSX.Element {
  const [image, setImage] = useState<string | null>(null);
  const [preview, setPreview] = useState<'loading' | 'converting' | 'none'>('loading');
  const [confirm, setConfirm] = useState<'delete' | 'withdraw' | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    if (!filesUrl) { setPreview('none'); return; }
    const abort = new AbortController(); let url: string | null = null;
    void (async () => {
      try {
        if (card.coverAsset) { url = URL.createObjectURL(await fetchCommonsImage(filesUrl, await token(), card.coverAsset, abort.signal)); setImage(url); return; }
        if (!card.modelAsset) { setPreview('none'); return; }
        for (let attempt = 0; attempt < 60 && !abort.signal.aborted; attempt++) {
          const result = await fetchCommonsThumbnail(filesUrl, await token(), card.modelAsset, abort.signal);
          if (result.kind === 'image') { url = URL.createObjectURL(result.blob); setImage(url); return; }
          if (result.status !== 'queued' && result.status !== 'rendering') { setPreview('none'); return; }
          setPreview('converting');
          await new Promise((resolve) => setTimeout(resolve, 4000));
        }
      } catch { if (!abort.signal.aborted) setPreview('none'); }
    })();
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [card.coverAsset, card.modelAsset, filesUrl, token]);

  const run = async (work: () => Promise<void>, note: string) => {
    setBusy(true); setError('');
    try { await work(); onChanged(note); } catch (failure) { setError(failure instanceof Error ? failure.message : 'That did not work. Try again.'); setBusy(false); }
  };
  const remove = () => run(async () => { if (!filesUrl) throw new Error('Drafts cannot be deleted in this build.'); await deleteCommonsDraft(filesUrl, await token(), card.id, card.draft!.id, new AbortController().signal); },
    card.published ? 'Draft changes discarded.' : 'Draft deleted.');
  const withdraw = () => run(async () => { await api.withdraw(card.id, card.published!); window.dispatchEvent(new Event('commons:catalog-changed')); }, 'Model withdrawn. Copies people already downloaded keep their licenses.');
  const updated = card.revision.submitted_at ? new Date(card.revision.submitted_at).toLocaleDateString() : null;
  const title = card.revision.metadata.title;
  return <article className="model-card own-card">
    <a className="model-art" href={`#edit/${card.id}`} aria-label={`Edit ${title}`}>
      {image ? <img src={image} alt=""/> : <div className="missing-image"><span aria-hidden="true">◇</span><span>{preview === 'converting' ? 'Converting preview' : preview === 'loading' ? 'Loading preview' : 'No preview'}</span></div>}
    </a>
    <div className="card-body">
      <h3><a href={`#edit/${card.id}`}>{title}</a></h3>
      <p className="card-status"><span className={card.published ? 'chip chip-strong' : 'chip'}>{card.published ? 'Published' : 'Draft'}</span>
        {card.published && card.draft && <span className="chip">Unpublished changes</span>}</p>
      {updated && <p className="card-meta">Updated {updated}</p>}
      {error && <p role="alert">{error}</p>}
      {confirm ? <p className="card-actions">
        <span>{confirm === 'delete' ? (card.published ? 'Discard these changes?' : 'Delete this draft?') : 'Withdraw this model?'}</span>
        <button type="button" className="secondary" disabled={busy} onClick={() => void (confirm === 'delete' ? remove() : withdraw())}>{confirm === 'delete' ? (card.published ? 'Discard' : 'Delete') : 'Withdraw'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
      </p> : <p className="card-actions">
        <a href={`#edit/${card.id}`}>Edit</a>
        {card.draft && <a href={`#edit/${card.id}`}>Publish</a>}
        {card.published && <a href={`#models/${card.id}`}>View</a>}
        {card.draft && <button type="button" className="link-button" onClick={() => setConfirm('delete')}>{card.published ? 'Discard changes' : 'Delete draft'}</button>}
        {card.published && <button type="button" className="link-button" onClick={() => setConfirm('withdraw')}>Withdraw</button>}
      </p>}
    </div>
  </article>;
}
