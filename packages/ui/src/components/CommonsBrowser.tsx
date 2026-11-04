// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UploadDialog } from '@pushform/commons-ui';
import { CommonsPublishing, deleteCommonsDraft, type CommonsOwnModels, readCommonsCatalog, isCommonsOpenable, loadCommonsModel, commonsFileUrl, type CatalogModel, type OpenedCommonsModel } from '@pushform/cloud';
import type { CommonsAccount } from '@pushform/commons-ui/account';
import { MESH_UNITS, probeMeshImport, type MeshUnit } from '@pushform/io';
import { openCommonsModel, placeCommonsModel } from '../commonsOpening';
import type { DocumentSession, ModelTab } from '../session';

export function CommonsBrowser({ account, filesUrl, session, target, onOpened, onClose }: {
  account: CommonsAccount | undefined; filesUrl: string | undefined; session: DocumentSession;
  target?: ModelTab | undefined; onOpened(): void; onClose(): void;
}) {
  const [own, setOwn] = useState<CommonsOwnModels | null>(null);
  const [mine, setMine] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; revision: string; kind: 'draft' | 'published' } | null>(null);
  const [models, setModels] = useState<CatalogModel[] | null>(null); const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0); const [query, setQuery] = useState('');
  const [category, setCategory] = useState(''); const [license, setLicense] = useState(''); const [commercial, setCommercial] = useState(false);
  const [selected, setSelected] = useState<CatalogModel | null>(null); const [busy, setBusy] = useState(false);
  const [catalogTarget, setCatalogTarget] = useState('');
  const available = session.tabs.filter((tab): tab is ModelTab => tab.type === 'model' && (!!tab.identity || session.isDirty(tab) || !!tab.cloudDraft));
  const destination = target ?? available.find(tab => tab.id === catalogTarget);
  const [prepared, setPrepared] = useState<{ source: OpenedCommonsModel; insert: boolean; target: ModelTab | undefined; path: string | undefined } | null>(null);
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
  useEffect(() => {
    const controller = new AbortController(); setModels(null); setError('');
    if (!account) { setError('Commons is not configured in this build.'); return; }
    void readCommonsCatalog(account.client, controller.signal).then(items => { setModels(items); setSelected(current => current ? items.find(item => item.id === current.id) ?? null : null); }, cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => { controller.abort(); run.current?.abort(); };
  }, [account, attempt]);
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
      if (!insert && !probeMeshImport(source.bytes)) {
        await openCommonsModel(session, source, controller.signal);
        if (!controller.signal.aborted) onOpened();
      } else setPrepared({ source, insert, target: capturedTarget, path });
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The model could not be downloaded.'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const install = async () => {
    if (!prepared || busy) return;
    const controller = new AbortController(); run.current = controller; setBusy(true); setError('');
    try {
      const mesh = meshProbe ? { unit, up: meshProbe.kind === 'dxf' ? 'z' as const : up } : undefined;
      if (prepared.insert) { if (!prepared.target || !session.tabs.includes(prepared.target) || prepared.target.app.document.context.path.join('/') !== prepared.path) throw new Error('The target design or editing context changed. Choose it again.'); await placeCommonsModel(session, prepared.target, prepared.source, controller.signal, mesh); }
      else await openCommonsModel(session, prepared.source, controller.signal, mesh);
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
  const shown = (models ?? []).filter(m => `${m.title} ${m.description} ${m.creator}`.toLowerCase().includes(query.toLowerCase()) && (!category || m.category === category) && (!license || m.licenses.some(l => l.name === license)) && (!commercial || m.licenses.every(l => l.commercialUse === 'allowed'))).sort((a,b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
  return <section ref={root} onKeyDown={event => { if (!target) return; if (event.key === 'Escape') { run.current?.abort(); onClose(); } if (event.key === 'Tab') { const controls = [...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href]')]; const index = controls.indexOf(document.activeElement as HTMLElement); if (controls.length && (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === controls.length - 1)) { event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0]?.focus(); } } }} className="pf-commons-browser" aria-label={target ? 'Import from Commons' : 'Commons catalog'}>
    <header><div><h2>{target ? 'Import from Commons' : 'Commons'}</h2>{target && <p>Destination: {target.name}</p>}</div><div><button onClick={() => setAttempt(value => value + 1)}>Refresh</button><button onClick={() => { run.current?.abort(); onClose(); }}>Close</button></div></header>
    {!target && <nav aria-label="Commons sections"><button aria-pressed={!mine} onClick={() => setMine(false)}>Browse</button><button aria-pressed={mine} onClick={() => setMine(true)}>My models</button></nav>}
    {editing && account && createPortal(<div className="pf-publishing-host"><UploadDialog account={account} filesUrl={filesUrl} modelId={editing} onClose={() => { setEditing(null); setAttempt(value => value + 1); }} onPublished={() => { setEditing(null); setAttempt(value => value + 1); }} /></div>, document.body)}
    {error && <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Try again</button></p>}
    {mine && !target ? <section aria-label="My Commons models">
      {confirm && <section role="alertdialog" aria-label={confirm.kind === 'draft' ? 'Delete draft' : 'Withdraw model'}><p>{confirm.kind === 'draft' ? 'Delete this private draft? The working document and any published revision are retained.' : 'Withdraw the public model and stop new downloads? Existing copies keep their original rights.'}</p><button disabled={busy} onClick={() => setConfirm(null)}>Cancel</button><button disabled={busy} onClick={() => { void modifyOwn(); }}>Confirm</button></section>}
      {!own && <p role="status">Loading your Commons models...</p>}
      {own?.models.length === 0 && <p>Your publishing drafts and published models will appear here.</p>}
      {own?.models.map(model => { const latest = own.revisions.find(r => r.id === model.latest_submission); const published = own.revisions.find(r => r.id === model.published_revision); const draft = latest?.status === 'pending' ? latest : null; const current = draft ?? published ?? latest; return <article key={model.id}><h3>{current?.metadata.title ?? model.id}</h3><p>{draft ? 'Private draft' : published ? 'Published revision ' + published.number : 'Withdrawn'}</p>{(draft || published) && <button onClick={() => setEditing(model.id)}>{draft ? 'Continue draft' : 'Edit publication'}</button>}{draft && <button onClick={() => setConfirm({ id: model.id, revision: draft.id, kind: 'draft' })}>Delete draft</button>}{published && <button onClick={() => setConfirm({ id: model.id, revision: published.id, kind: 'published' })}>Withdraw</button>}</article>; })}
    </section> : prepared ? <><h3>{prepared.source.attribution.title}</h3><p>{prepared.source.attribution.creator} · Original licenses and credits retained.</p>
      {meshProbe && <><p>This file does not record units. Choose how to read its dimensions.</p><label>Source units<select value={unit} onChange={event => setUnit(event.target.value as MeshUnit)}>{MESH_UNITS.map(item => <option key={item.unit} value={item.unit}>{item.label}</option>)}</select></label>{meshProbe.kind !== 'dxf' && <label>Up axis<select value={up} onChange={event => setUp(event.target.value as 'y' | 'z')}><option value="z">Z up</option><option value="y">Y up</option></select></label>}</>}
      <p>{prepared.insert ? 'Preview placement in the current design. Escape cancels; click to commit one undoable insertion.' : 'Open a separate local copy in a new model tab. The catalog keeps your search.'}</p>
      <button disabled={busy} onClick={() => setPrepared(null)}>Back</button><button disabled={busy} onClick={() => { void install(); }}>{busy ? 'Preparing…' : prepared.insert ? 'Continue to placement' : 'Open copy in new tab'}</button>
    </> : selected ? <><button onClick={() => setSelected(null)}>Back to results</button><h3>{selected.title}</h3><p>by {selected.creator}</p><p>{selected.description}</p>
      <img crossOrigin="anonymous" referrerPolicy="no-referrer" alt={selected.title} src={selected.imageUrl ?? commonsFileUrl(filesUrl, 'thumbnails', selected.files[0]?.id ?? '') ?? undefined} />
      <p>Formats: {selected.formats.join(', ')}</p><h3>Licenses & credits</h3>{selected.licenses.map((l,i) => <p key={i}>{l.url ? <a href={l.url} target="_blank" rel="noreferrer">{l.name}</a> : l.name}: {l.conditions.join('; ')}</p>)}{selected.credits.map((c,i) => <p key={i}>{c.name}: {c.text}</p>)}
      {selected.source && <a href={selected.source.url} target="_blank" rel="noreferrer">Original source: {selected.source.name}</a>}
      {!target && available.length > 0 && <label>Insert into an open design<select value={catalogTarget} onChange={event => setCatalogTarget(event.target.value)}><option value="">Choose an open design</option>{available.map(tab => <option key={tab.id} value={tab.id}>{tab.name}</option>)}</select></label>}
      <div><button disabled={busy || !selected.files.some(f => isCommonsOpenable(f.name))} onClick={() => { void load(false); }}>Open in new tab</button>{destination && <button disabled={busy || !selected.files.some(f => isCommonsOpenable(f.name))} onClick={() => { void load(true); }}>Insert into {destination!.name}</button>}</div>
      {busy && <p role="status">Preparing model…</p>}
      {!selected.files.some(f => isCommonsOpenable(f.name)) && <p>A supported representation is required before this model can be opened or inserted.</p>}
    </> : <><div className="pf-commons-filters"><label>Search models<input value={query} onChange={event => setQuery(event.target.value)} /></label><label>Category<select value={category} onChange={event => setCategory(event.target.value)}><option value="">All categories</option>{choices((models ?? []).map(m => m.category))}</select></label><label>License<select value={license} onChange={event => setLicense(event.target.value)}><option value="">All licenses</option>{choices((models ?? []).flatMap(m => m.licenses.map(l => l.name)))}</select></label><label><input type="checkbox" checked={commercial} onChange={event => setCommercial(event.target.checked)} />Commercial use permitted</label></div>
      {!models && !error && <p role="status">Loading Commons…</p>}
      {models && !shown.length && <p>No matching models. <button onClick={() => { setQuery('');setCategory('');setLicense('');setCommercial(false); }}>Clear filters</button></p>}
      <div className="pf-commons-grid">{shown.map(model => <button key={model.id} onClick={() => setSelected(model)}><img crossOrigin="anonymous" referrerPolicy="no-referrer" alt="" src={model.imageUrl ?? commonsFileUrl(filesUrl, 'thumbnails', model.files[0]?.id ?? '') ?? undefined}/><strong>{model.title}</strong><span>by {model.creator}</span><span>{model.licenses.map(l => l.name).join(', ')}</span><span>{model.formats.join(', ')}</span></button>)}</div>
    </>}
  </section>;
}
