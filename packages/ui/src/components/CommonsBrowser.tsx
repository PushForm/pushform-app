// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuLibrary } from 'react-icons/lu';
import { BrowseImagesProvider } from '@pushform/commons-ui/BrowseImages';
import { useBrowsePaging, MoreBrowseResults } from '@pushform/commons-ui/BrowsePaging';
import { UploadDialog } from '@pushform/commons-ui';
import { CommonsPublishing, deleteCommonsDraft, type CommonsOwnModels, createCommonsBrowseLoader, isCommonsOpenable, loadCommonsModel, type CatalogModel, type OpenedCommonsModel } from '@pushform/cloud';
import type { CommonsAccount } from '@pushform/commons-ui/account';
import { MESH_UNITS, probeMeshImport, type MeshImportOptions, type MeshUnit } from '@pushform/io';
import { openCommonsModel, placeCommonsModel } from '../commonsOpening';
import type { DocumentSession, ModelTab } from '../session';
import { CommonsModelDetail } from './CommonsModelDetail';
import { CommonsModelImage } from './CommonsModelImage';

interface PreparedModel { source: OpenedCommonsModel; insert: boolean; target: ModelTab | undefined; path: string | undefined }

export function CommonsBrowser({ account, filesUrl, session, target, onOpened, onClose }: {
  account: CommonsAccount | undefined; filesUrl: string | undefined; session: DocumentSession;
  target?: ModelTab | undefined; onOpened(): void; onClose(): void;
}) {
  const id = useId();
  const [own, setOwn] = useState<CommonsOwnModels | null>(null);
  const [mine, setMine] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; revision: string; kind: 'draft' | 'published' } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0); const [query, setQuery] = useState('');
  const [category, setCategory] = useState(''); const [license, setLicense] = useState(''); const [commercial, setCommercial] = useState(false);
  const [selected, setSelected] = useState<CatalogModel | null>(null); const [busy, setBusy] = useState(false);
  const [catalogTarget, setCatalogTarget] = useState('');
  const available = session.tabs.filter((tab): tab is ModelTab => tab.type === 'model' && (!!tab.identity || session.isDirty(tab) || !!tab.cloudDraft));
  const destination = target ?? available.find(tab => tab.id === catalogTarget);
  const [prepared, setPrepared] = useState<PreparedModel | null>(null);
  const meshProbe = useMemo(() => prepared ? probeMeshImport(prepared.source.bytes) : null, [prepared]);
  const [unit, setUnit] = useState<MeshUnit>('mm'); const [up, setUp] = useState<'z' | 'y'>('z');
  const root = useRef<HTMLElement>(null);
  const run = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!target) return;
    const app = document.querySelector<HTMLElement>('.pf-app'); const inert = app?.inert ?? false; const focus = document.activeElement as HTMLElement | null;
    if (app) app.inert = true; root.current?.querySelector<HTMLElement>('button')?.focus();
    return () => { if (app) app.inert = inert; if (focus?.isConnected) focus.focus(); };
  }, [target]);
  const browseLoader = useMemo(() => account ? createCommonsBrowseLoader(account.client) : null, [account]);
  const paging = useBrowsePaging(mine && !target ? null : browseLoader, { query, category, license, commercial }, attempt, filesUrl);
  const models = paging.loading ? null : paging.models;
  useEffect(() => () => run.current?.abort(), []);
  const installModel = async (model: PreparedModel, signal: AbortSignal, mesh?: MeshImportOptions) => {
    if (model.insert) {
      if (!model.target || !session.tabs.includes(model.target) || model.target.app.document.context.path.join('/') !== model.path) throw new Error('The target design or editing context changed. Choose it again.');
      await placeCommonsModel(session, model.target, model.source, signal, mesh);
    } else await openCommonsModel(session, model.source, signal, mesh);
  };
  const load = async (insert: boolean) => {
    if (!selected || !account || busy) return;
    const file = selected.files.find(f => /\.pf$/i.test(f.name)) ?? selected.files.find(f => isCommonsOpenable(f.name));
    if (!file) return;
    const capturedTarget = destination, path = destination?.app.document.context.path.join('/');
    const controller = new AbortController(); run.current = controller; setBusy(true); setError('');
    try {
      const token = await account.session.getAccessToken(); if (!token) throw new Error('Sign in to import Commons models.');
      const source = await loadCommonsModel(filesUrl ?? '', token, { modelId: selected.id, revision: selected.revision, assetId: file.id }, controller.signal);
      if (controller.signal.aborted) return;
      const model = { source, insert, target: capturedTarget, path };
      if (!probeMeshImport(source.bytes)) {
        await installModel(model, controller.signal);
        if (!controller.signal.aborted) onOpened();
      } else setPrepared(model);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The model could not be downloaded.'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const install = async () => {
    if (!prepared || busy) return;
    const controller = new AbortController(); run.current = controller; setBusy(true); setError('');
    try {
      const mesh = meshProbe ? { unit, up: meshProbe.kind === 'dxf' ? 'z' as const : up } : undefined;
      await installModel(prepared, controller.signal, mesh);
      if (!controller.signal.aborted) { setPrepared(null); onOpened(); }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The model could not be opened.'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  useEffect(() => { const refresh = () => setAttempt(value => value + 1); window.addEventListener('commons:catalog-changed', refresh); return () => window.removeEventListener('commons:catalog-changed', refresh); }, []);
  useEffect(() => {
    if (!mine || !account) return;
    const controller = new AbortController(); setOwn(null);
    void new CommonsPublishing(account.client).mine(controller.signal).then(setOwn, cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [mine, account, attempt]);
  useEffect(() => {
    if (!editing) return;
    const app = document.querySelector<HTMLElement>('.pf-app'); const inert = app?.inert ?? false;
    if (app) app.inert = true;
    return () => { if (app) app.inert = inert; };
  }, [editing]);
  const modifyOwn = async () => {
    if (!account || !confirm || busy) return;
    setBusy(true); setError('');
    try {
      if (confirm.kind === 'published') await new CommonsPublishing(account.client).withdraw(confirm.id, confirm.revision);
      else { const token = await account.session.getAccessToken(); if (!token) throw new Error('Sign in to delete a draft.'); await deleteCommonsDraft(filesUrl ?? '', token, confirm.id, confirm.revision, new AbortController().signal); }
      setConfirm(null); setAttempt(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The model could not be updated.'); }
    finally { setBusy(false); }
  };
  const choices = (values: string[]) => [...new Set(values)].sort().map(value => <option key={value}>{value}</option>);
  const shown = models ?? [];
  return <BrowseImagesProvider value={paging.images}><section ref={root} onKeyDown={event => { if (!target) return; if (event.key === 'Escape') { run.current?.abort(); onClose(); } if (event.key === 'Tab') { const controls = [...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href]')]; const index = controls.indexOf(document.activeElement as HTMLElement); if (controls.length && (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === controls.length - 1)) { event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0]?.focus(); } } }} className="pf-commons-browser" aria-label={target ? 'Import from Commons' : 'Commons catalog'}>
    <header><div><h2>{target ? 'Import from Commons' : <><LuLibrary aria-hidden="true"/>Commons</>}</h2>{target ? <p>Destination: {target.name}</p> : <p className="pf-commons-tagline">Good projects start with shared ideas.</p>}</div>{target && <button onClick={() => { run.current?.abort(); onClose(); }}>Close</button>}</header>
    {!target && <div className="pf-tabs pf-commons-tabs" role="tablist" aria-label="Commons sections">{['Browse', 'My models'].map((label, index) => {
      const selected = mine === (index === 1);
      return <button key={label} type="button" role="tab" className={`pf-tab${selected ? ' is-active' : ''}`}
        id={`${id}-tab-${index}`} aria-controls={`${id}-panel`} aria-selected={selected} tabIndex={selected ? 0 : -1}
        onClick={() => setMine(index === 1)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : mine ? 0 : 1;
          setMine(next === 1); document.getElementById(`${id}-tab-${next}`)?.focus();
        }}>{label}</button>;
    })}</div>}
    {editing && account && createPortal(<div className="pf-publishing-host"><UploadDialog account={account} filesUrl={filesUrl} modelId={editing} onClose={() => { setEditing(null); setAttempt(value => value + 1); }} onPublished={() => { setEditing(null); setAttempt(value => value + 1); }} /></div>, document.body)}
    {(error || !account || paging.error && !models?.length) && <p role="alert">{error || (!account ? 'Commons is not configured in this build.' : paging.error?.message)} <button onClick={() => setAttempt(value => value + 1)}>Try again</button></p>}
    <div role={!target ? 'tabpanel' : undefined} id={`${id}-panel`} aria-labelledby={!target ? `${id}-tab-${mine ? 1 : 0}` : undefined}>
    {mine && !target ? <section aria-label="My Commons models">
      {confirm && <section role="alertdialog" aria-label={confirm.kind === 'draft' ? 'Delete draft' : 'Withdraw model'}><p>{confirm.kind === 'draft' ? 'Delete this private draft? The working document and any published revision are retained.' : 'Withdraw the public model and stop new downloads? Existing copies keep their original rights.'}</p><button disabled={busy} onClick={() => setConfirm(null)}>Cancel</button><button disabled={busy} onClick={() => { void modifyOwn(); }}>Confirm</button></section>}
      {!own && <p role="status">Loading your Commons models...</p>}
      {own?.models.length === 0 && <p>Your publishing drafts and published models will appear here.</p>}
      {own?.models.map(model => { const latest = own.revisions.find(r => r.id === model.latest_submission); const published = own.revisions.find(r => r.id === model.published_revision); const draft = latest?.status === 'pending' ? latest : null; const current = draft ?? published ?? latest; return <article key={model.id}><h3>{current?.metadata.title ?? model.id}</h3><p>{draft ? 'Private draft' : published ? 'Published revision ' + published.number : 'Withdrawn'}</p>{(draft || published) && <button onClick={() => setEditing(model.id)}>{draft ? 'Continue draft' : 'Edit publication'}</button>}{draft && <button onClick={() => setConfirm({ id: model.id, revision: draft.id, kind: 'draft' })}>Delete draft</button>}{published && <button onClick={() => setConfirm({ id: model.id, revision: published.id, kind: 'published' })}>Withdraw</button>}</article>; })}
    </section> : prepared ? <><h3>{prepared.source.attribution.title}</h3>
      {meshProbe && <><p>This file does not record units. Choose how to read its dimensions.</p><label>Source units<select value={unit} onChange={event => setUnit(event.target.value as MeshUnit)}>{MESH_UNITS.map(item => <option key={item.unit} value={item.unit}>{item.label}</option>)}</select></label>{meshProbe.kind !== 'dxf' && <label>Up axis<select value={up} onChange={event => setUp(event.target.value as 'y' | 'z')}><option value="z">Z up</option><option value="y">Y up</option></select></label>}</>}
      <button disabled={busy} onClick={() => setPrepared(null)}>Back</button><button disabled={busy} onClick={() => { void install(); }}>{busy ? 'Preparing…' : prepared.insert ? 'Import model' : 'Open model'}</button>
    </> : selected ? <CommonsModelDetail model={selected} filesUrl={filesUrl} busy={busy} importing={!!target}
      destinationName={destination?.name} onBack={() => setSelected(null)} onOpen={() => { void load(false); }} onInsert={() => { void load(true); }}
      destinationPicker={!target && available.length > 0 && <label>Import into an open design<select value={catalogTarget} onChange={event => setCatalogTarget(event.target.value)}><option value="">Choose an open design</option>{available.map(tab => <option key={tab.id} value={tab.id}>{tab.name}</option>)}</select></label>}
    /> : <><div className="pf-commons-filters"><label>Search models<input maxLength={200} value={query} onChange={event => setQuery(event.target.value)} /></label><label>Category<select value={category} onChange={event => setCategory(event.target.value)}><option value="">All categories</option>{choices(paging.categories)}</select></label><label>License<select value={license} onChange={event => setLicense(event.target.value)}><option value="">All licenses</option>{choices(paging.licenses)}</select></label><label><input type="checkbox" checked={commercial} onChange={event => setCommercial(event.target.checked)} />Commercial use permitted</label></div>
      {account && !models && !error && !paging.error && <p role="status">Loading Commons…</p>}
      {models && !shown.length && !paging.error && <p>No matching models. <button onClick={() => { setQuery('');setCategory('');setLicense('');setCommercial(false); }}>Clear filters</button></p>}
      <p role="status">{paging.loading ? '' : `${shown.length} of ${paging.total} models`}</p>
      <div className="pf-commons-grid">{shown.map(model => <button key={model.id} onClick={() => setSelected(model)}><CommonsModelImage key={model.revision} model={model} filesUrl={filesUrl} decorative/><strong>{model.title}</strong><span>by {model.creator}</span><span>{[...new Set(model.licenses.map(l => l.name))].join(', ')}</span><span>{model.formats.join(', ')}</span></button>)}</div>
      <MoreBrowseResults count={shown.length} more={paging.more} loading={paging.loadingMore} error={paging.error} onMore={paging.loadMore}/>
    </>}
    </div>
  </section></BrowseImagesProvider>;
}
