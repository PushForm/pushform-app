// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import type { CollectionFields, CommonsCollection, CommonsCollections, CommonsDiscovery } from '@pushform/cloud';
import type { CommonsAccount } from './account';
import { CommonsAccessGate } from './CommonsAccess';
import { CommonsThumbnail } from './CommonsPreview';
import { ModelCard, ModelGrid, ProfileLink } from './ModelCard';
import { filterModels, type CatalogFilters, type CatalogModel } from './catalog';

const noSubscribe = () => () => {};
const message = (error: unknown) => error instanceof Error ? error.message : 'This request failed. Try again.';
const adminUrl = (import.meta.env.VITE_PUSHFORM_ADMIN_URL || 'https://pushform-oregon.pages.dev').replace(/\/$/, '') + '/#/commons/featured';
interface CollectionContext {
  service: CommonsCollections | null; account: CommonsAccount | null; userId: string | null;
  discovery: CommonsDiscovery | null; error: string | null; own: CommonsCollection[] | null; ownError: string | null;
  canFeature: boolean; revision: number; refresh: () => void;
}
const Context = createContext<CollectionContext | null>(null);
function useCollections(): CollectionContext {
  const value = useContext(Context);
  if (!value) throw new Error('Missing collections context.');
  return value;
}
function useCollectionsAfterSetup(): CollectionContext {
  const context = useCollections();
  // Account setup can finish after the initial owner request was denied. Retry once when the gate opens.
  const [retryOnMount] = useState(context.ownError !== null);
  const refresh = context.refresh;
  useEffect(() => { if (retryOnMount) refresh(); }, [retryOnMount, refresh]);
  return context;
}
export function CollectionsProvider({ service, account, children }: { service: CommonsCollections | null; account: CommonsAccount | null; children: ReactNode }) {
  const session = account?.session;
  const userId = useSyncExternalStore(session?.subscribe ?? noSubscribe, () => session?.getSnapshot().user?.id ?? null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const [publicState, setPublicState] = useState<{ service: CommonsCollections | null; discovery: CommonsDiscovery | null; error: string | null }>({ service: null, discovery: null, error: null });
  const [privateState, setPrivateState] = useState<{ userId: string | null; own: CommonsCollection[] | null; error: string | null; canFeature: boolean }>({ userId: null, own: null, error: null, canFeature: false });
  useEffect(() => {
    window.addEventListener('commons:catalog-changed', refresh);
    return () => window.removeEventListener('commons:catalog-changed', refresh);
  }, [refresh]);
  useEffect(() => {
    if (!service) { setPublicState({ service, discovery: null, error: null }); return; }
    const controller = new AbortController();
    void service.discovery(controller.signal).then(discovery => {
      if (!controller.signal.aborted) setPublicState({ service, discovery, error: null });
    }, error => { if (!controller.signal.aborted) setPublicState({ service, discovery: null, error: message(error) }); });
    return () => controller.abort();
  }, [service, revision]);
  useEffect(() => {
    setPrivateState({ userId, own: null, error: null, canFeature: false });
    if (!service || !userId) return;
    const controller = new AbortController();
    void service.mine(controller.signal).then(own => {
      if (!controller.signal.aborted) setPrivateState(current => ({ ...current, own }));
    }, error => { if (!controller.signal.aborted) setPrivateState(current => ({ ...current, error: message(error) })); });
    void service.canFeature(controller.signal).then(canFeature => {
      if (!controller.signal.aborted) setPrivateState(current => ({ ...current, canFeature }));
    });
    return () => controller.abort();
  }, [service, userId, revision]);
  const ownSession = privateState.userId === userId;
  return <Context.Provider value={{ service, account, userId, revision, refresh,
    discovery: publicState.service === service ? publicState.discovery : null, error: publicState.service === service ? publicState.error : null,
    own: ownSession ? privateState.own : null, ownError: ownSession ? privateState.error : null, canFeature: ownSession && privateState.canFeature,
  }}>{children}</Context.Provider>;
}

export function CollectionCurator({ collection }: { collection: CommonsCollection }) {
  return <span>Curated by {collection.curator ? <ProfileLink handle={collection.curator.handle}>{collection.curator.displayName}</ProfileLink> : 'a Commons member'}</span>;
}
export function CommonsAdminLink() {
  return useCollections().canFeature ? <a href={adminUrl}>Admin</a> : null;
}
export function CollectionMosaic({ collection, models, filesUrl }: { collection: CommonsCollection; models: CatalogModel[]; filesUrl: string | undefined }) {
  const visible = collection.modelIds.map(id => models.find(model => model.id === id)).filter((model): model is CatalogModel => Boolean(model));
  return <div className="collection-mosaic" role="img" aria-label={`${collection.title}, ${visible.length} available models`}>
    {Array.from({ length: 4 }, (_, index) => {
      const model = visible[index];
      return <div key={index} className="mosaic-tile" aria-hidden="true">{model ? <CommonsThumbnail model={model} filesUrl={filesUrl} /> : index === 3 ? <span>{visible.length} {visible.length === 1 ? 'model' : 'models'}</span> : null}</div>;
    })}
  </div>;
}
export function CollectionCard({ collection, models, filesUrl, privateLabel = false }: { collection: CommonsCollection; models: CatalogModel[]; filesUrl: string | undefined; privateLabel?: boolean }) {
  const count = collection.modelIds.filter(id => models.some(model => model.id === id)).length;
  return <article className="model-card collection-card">
    <a href={`#collections/${collection.id}`} aria-label={`View collection ${collection.title}`}><CollectionMosaic collection={collection} models={models} filesUrl={filesUrl} /></a>
    <div className="card-body"><p className="eyebrow">Collection · {count} {count === 1 ? 'model' : 'models'}{privateLabel ? ` · ${collection.visibility}` : ''}</p>
      <h3><a href={`#collections/${collection.id}`}>{collection.title}</a></h3><p className="creator"><CollectionCurator collection={collection} /></p>
    </div>
  </article>;
}
export function FeaturedSection({ models, filesUrl }: { models: CatalogModel[]; filesUrl: string | undefined }) {
  const { service, discovery, error, refresh, canFeature } = useCollections();
  const [page, setPage] = useState(0);
  const items = discovery?.featured.filter(item => item.type === 'model' ? models.some(model => model.id === item.targetId) : discovery.collections.some(collection => collection.id === item.targetId)) ?? [];
  const pages = Math.ceil(items.length / 3);
  const currentPage = Math.min(page, Math.max(0, pages - 1));
  if (!service) return null;
  return <section className="featured-section" aria-labelledby="featured-title">
    <div className="section-heading"><div><h2 id="featured-title">Featured</h2><p className="section-description">Useful models and collections, picked for makers.</p></div>{canFeature && <a href={adminUrl}>Manage featured</a>}</div>
    {error ? <div role="alert"><p>{error}</p><button onClick={refresh}>Retry featured</button></div> : !discovery ? <p role="status">Loading featured models and collections…</p> : <>
      <ModelGrid className="featured-grid">{items.slice(currentPage * 3, currentPage * 3 + 3).map(item => {
        if (item.type === 'collection') {
          const collection = discovery.collections.find(value => value.id === item.targetId);
          return collection ? <CollectionCard key={item.id} collection={collection} models={models} filesUrl={filesUrl} /> : null;
        }
        const model = models.find(value => value.id === item.targetId);
        return model ? <ModelCard key={item.id} model={model} filesUrl={filesUrl} typeLabel="Model" /> : null;
      })}</ModelGrid>
      {pages > 1 && <div className="featured-pagination" aria-label="Featured pages"><button className="secondary-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous featured</button><span role="status">{currentPage * 3 + 1}–{Math.min(items.length, currentPage * 3 + 3)} of {items.length}</span><button className="secondary-button" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>Next featured</button></div>}
      {items.length === 0 && <p className="section-description">Featured projects will appear here.</p>}
    </>}
  </section>;
}
export function FeatureAction({ type, targetId, eligible = true }: { type: 'model' | 'collection'; targetId: string; eligible?: boolean }) {
  const { service, discovery, canFeature, refresh } = useCollections();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [added, setAdded] = useState(false);
  if (!canFeature || !service) return null;
  const featured = added || discovery?.featured.some(item => item.type === type && item.targetId === targetId);
  return <div className="feature-action">
    {featured ? <a className="secondary-button" href={adminUrl}>Featured · Manage</a> : <button type="button" className="secondary-button" disabled={busy || !eligible} onClick={() => {
      setBusy(true); setError(null);
      void service.feature(type, targetId).then(() => { setAdded(true); refresh(); }, error => setError(message(error))).finally(() => setBusy(false));
    }}>{busy ? 'Featuring…' : 'Feature'}</button>}
    {!eligible && !featured && <p className="section-description">Only nonempty public collections can be featured.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
export function PublicCollectionResults({ models, filesUrl, filters }: { models: CatalogModel[]; filesUrl: string | undefined; filters: CatalogFilters }) {
  const { discovery, error, refresh, service } = useCollections();
  if (!service) return <p>Collections are unavailable in this build.</p>;
  if (error) return <div role="alert"><p>{error}</p><button onClick={refresh}>Retry collections</button></div>;
  if (!discovery) return <p role="status">Loading collections…</p>;
  const words = filters.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const shown = discovery.collections.filter(collection => {
    const members = models.filter(model => collection.modelIds.includes(model.id));
    const searchable = [collection.title, collection.description, collection.curator?.displayName ?? '', ...members.map(model => model.title + ' ' + model.creator)].join(' ').toLocaleLowerCase();
    if (filters.commercial && (!members.length || !members.every(model => model.licenses.every(license => license.commercialUse === 'allowed')))) return false;
    return words.every(word => searchable.includes(word)) && (!(filters.category || filters.license) || filterModels(members, { ...filters, query: '', commercial: false }).length > 0);
  });
  return <><p className="result-count" role="status">{shown.length} {shown.length === 1 ? 'collection' : 'collections'}</p>
    {shown.length ? <ModelGrid>{shown.map(collection => <CollectionCard key={collection.id} collection={collection} models={models} filesUrl={filesUrl} />)}</ModelGrid> : <p>No public collections match those filters.</p>}
  </>;
}
function OwnedCollections({ models, filesUrl }: { models: CatalogModel[]; filesUrl: string | undefined }) {
  const { own, ownError, refresh } = useCollectionsAfterSetup();
  if (ownError) return <div role="alert"><p>{ownError}</p><button onClick={refresh}>Reload my collections</button></div>;
  if (!own) return <p role="status">Loading your collections…</p>;
  return <>{own.length ? <ModelGrid>{own.map(collection => <CollectionCard key={collection.id} collection={collection} models={models} filesUrl={filesUrl} privateLabel />)}</ModelGrid> : <p>You haven’t made a collection yet. Gather models for a project or share useful finds.</p>}</>;
}
export function CollectionsRoute({ route, models, filesUrl }: { route: string; models: CatalogModel[]; filesUrl: string | undefined }) {
  const { service, account, userId } = useCollections();
  useEffect(() => { if (route === '#my-collections' || route === '#collections/new') document.title = `${route === '#my-collections' ? 'My collections' : 'New collection'} — PushForm Commons`; }, [route]);
  if (!service) return <section className="status-panel"><h1>Collections are unavailable in this build.</h1></section>;
  if (route === '#my-collections' || route === '#collections/new') {
    if (!account) return <p>Sign-in is unavailable in this build.</p>;
    return <CommonsAccessGate account={account}><section className="collection-page" key={userId}>
      <a className="back-link" href="#collections">← All collections</a>
      {route === '#collections/new' ? <><h1>New collection</h1><CollectionEditor models={models} filesUrl={filesUrl} collection={null} onCancel={() => { window.location.hash = '#my-collections'; }} /></> : <>
        <div className="section-heading"><h1>My collections</h1><a className="primary-button" href="#collections/new">New collection</a></div>
        <OwnedCollections models={models} filesUrl={filesUrl} />
      </>}
    </section></CommonsAccessGate>;
  }
  const id = /^#collections\/([a-f0-9-]{36})$/.exec(route)?.[1];
  return id ? <CollectionDetail key={id + ':' + userId} id={id} models={models} filesUrl={filesUrl} /> : null;
}
function CollectionDetail({ id, models, filesUrl }: { id: string; models: CatalogModel[]; filesUrl: string | undefined }) {
  const { service, own, revision, refresh } = useCollections();
  const [data, setData] = useState<CommonsCollection | null | undefined>(undefined); const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setError(null);
    void service!.get(id, controller.signal).then(value => { if (!controller.signal.aborted) setData(value); }, error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [service, id, revision]);
  useEffect(() => { if (data) document.title = `${data.title} — PushForm Commons`; }, [data]);
  if (error) return <section className="status-panel" role="alert"><p>{error}</p><button onClick={refresh}>Reload collection</button></section>;
  if (data === undefined) return <p className="status-panel" role="status">Loading collection…</p>;
  if (!data) return <section className="status-panel"><h1>This collection isn’t available.</h1><p>It may be private or have been removed.</p><a href="#collections">Browse public collections</a></section>;
  const editable = own?.some(value => value.id === id);
  const members = data.modelIds.map(memberId => models.find(model => model.id === memberId)).filter((model): model is CatalogModel => Boolean(model));
  return <section className="collection-page"><a className="back-link" href="#collections">← All collections</a>
    {editing && editable ? <CollectionEditor collection={data} models={models} filesUrl={filesUrl} onCancel={() => setEditing(false)} onSaved={value => { setData(value); setEditing(false); }} /> : <>
      <div className="collection-hero"><CollectionMosaic collection={data} models={models} filesUrl={filesUrl} />
        <div><p className="eyebrow">{data.visibility} collection · {members.length} {members.length === 1 ? 'model' : 'models'}</p><h1>{data.title}</h1>
          <p className="creator"><CollectionCurator collection={data} /></p><p className="description">{data.description}</p>
          <div className="collection-actions">{editable && <button className="secondary-button" onClick={() => setEditing(true)}>Edit collection</button>}<FeatureAction key={data.id + data.version} type="collection" targetId={id} eligible={data.visibility === 'public' && members.length > 0} /></div>
        </div>
      </div>
      <section className="collection-members" aria-labelledby="collection-members-title"><div className="section-heading"><h2 id="collection-members-title">Models in this collection</h2><p className="section-description">Each model retains its own license and credits.</p></div>
        <ModelGrid>{members.map(model => <ModelCard key={model.id} model={model} filesUrl={filesUrl} />)}</ModelGrid>
        {!members.length && <p>No published models are available in this collection.</p>}
      </section>
    </>}
  </section>;
}
function CollectionEditor({ collection, models, filesUrl, onCancel, onSaved }: { collection: CommonsCollection | null; models: CatalogModel[]; filesUrl: string | undefined; onCancel: () => void; onSaved?: (value: CommonsCollection) => void }) {
  const { service, refresh } = useCollections();
  const [fields, setFields] = useState<CollectionFields>(() => collection ? { title: collection.title, description: collection.description, visibility: collection.visibility, modelIds: [...collection.modelIds] } : { title: '', description: '', visibility: 'private', modelIds: [] });
  // Keep the version the editor opened with. A refresh must never silently rebase a stale draft.
  const [expectedVersion] = useState(collection?.version ?? null);
  const [query, setQuery] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [confirmDelete, setConfirmDelete] = useState(false);
  const patch = (value: Partial<CollectionFields>) => setFields(current => ({ ...current, ...value }));
  const move = (index: number, offset: number) => { const ids = [...fields.modelIds]; [ids[index], ids[index + offset]] = [ids[index + offset]!, ids[index]!]; patch({ modelIds: ids }); };
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError(null);
    void service!.save(collection?.id ?? null, fields, expectedVersion).then(value => {
      refresh(); if (onSaved) onSaved(value); else window.location.hash = `#collections/${value.id}`;
    }, error => setError(message(error))).finally(() => setBusy(false));
  };
  const available = filterModels(models, { query, category: '', license: '', commercial: false }).filter(model => !fields.modelIds.includes(model.id));
  return <form className="collection-editor" aria-label={collection ? 'Edit collection' : 'Create collection'} onSubmit={submit}>
    <div className="collection-form-fields"><label>Collection title<input required maxLength={100} value={fields.title} onChange={event => patch({ title: event.target.value })} disabled={busy} /></label>
      <label>Visibility<select value={fields.visibility} onChange={event => patch({ visibility: event.target.value as CollectionFields['visibility'] })} disabled={busy}><option value="private">Private — only you</option><option value="public">Public — visible in Commons</option></select></label>
      <label className="collection-description-field">Description<textarea maxLength={2000} rows={3} value={fields.description} onChange={event => patch({ description: event.target.value })} disabled={busy} /></label>
    </div><p className="section-description">Public collections can be featured by Commons admins. Each model keeps its own license and credits.</p>
    <h2>Models in this collection</h2><p className="section-description">{fields.modelIds.length} of 100 models. The first four available models form the collection cover.</p>
    <ol className="collection-edit-members">{fields.modelIds.map((id, index) => {
      const model = models.find(value => value.id === id);
      return <li key={id}><div className="collection-edit-thumb">{model && <CommonsThumbnail model={model} filesUrl={filesUrl} />}</div><span>{model?.title ?? 'Unavailable model'}</span><div className="member-actions">
        <button type="button" className="secondary-button" disabled={busy || index === 0} aria-label={`Move ${model?.title ?? 'unavailable model'} up`} onClick={() => move(index, -1)}>Move up</button>
        <button type="button" className="secondary-button" disabled={busy || index === fields.modelIds.length - 1} aria-label={`Move ${model?.title ?? 'unavailable model'} down`} onClick={() => move(index, 1)}>Move down</button>
        <button type="button" className="secondary-button" disabled={busy} aria-label={`Remove ${model?.title ?? 'unavailable model'} from collection`} onClick={() => patch({ modelIds: fields.modelIds.filter(value => value !== id) })}>Remove</button>
      </div></li>;
    })}</ol>
    <label className="collection-search">Find models to add<input type="search" placeholder="Search published models" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="collection-add-results">{available.slice(0, 12).map(model => <button key={model.id} className="secondary-button" type="button" disabled={busy || fields.modelIds.length >= 100} onClick={() => patch({ modelIds: [...fields.modelIds, model.id] })}>Add {model.title}</button>)}{available.length === 0 && <p>No more published models match.</p>}</div>
    {error && <div role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={() => { refresh(); onCancel(); }}>Close editor and reload</button></div>}
    <div className="collection-actions"><button type="submit" disabled={busy || !fields.title.trim()}>{busy ? 'Saving…' : 'Save collection'}</button><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>Cancel</button>
      {collection && <button type="button" className="text-button" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete collection</button>}</div>
    {confirmDelete && collection && <div className="collection-delete" role="group" aria-label="Delete collection confirmation"><p>Delete “{collection.title}”? Its models stay in Commons.</p><button type="button" disabled={busy} onClick={() => {
      setBusy(true); setError(null); void service!.delete(collection.id, expectedVersion!).then(() => { refresh(); window.location.hash = '#my-collections'; }, error => setError(message(error))).finally(() => setBusy(false));
    }}>Delete this collection</button> <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep collection</button></div>}
  </form>;
}

export function ModelCollectionAction({ model }: { model: CatalogModel }) {
  const { service, account, userId } = useCollections();
  const [open, setOpen] = useState(false);
  if (!service || !account) return null;
  return <div className="model-collection-action"><button type="button" className="secondary-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>Save to collection</button>
    {open && <section className="collection-save-picker" aria-label="Save to collection"><CommonsAccessGate account={account}><SaveModelPicker key={userId + ':' + model.id} model={model} /></CommonsAccessGate><button type="button" className="text-button" onClick={() => setOpen(false)}>Done</button></section>}
  </div>;
}
function SaveModelPicker({ model }: { model: CatalogModel }) {
  const { service, own, ownError, refresh } = useCollectionsAfterSetup();
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [saved, setSaved] = useState<string | null>(null);
  const save = (collection: CommonsCollection | null, checked: boolean) => {
    if (busy) return;
    setBusy(true); setError(null); setSaved(null);
    const fields: CollectionFields = collection ? { ...collection, modelIds: checked ? [...collection.modelIds, model.id] : collection.modelIds.filter(id => id !== model.id) } : { title: name, description: '', visibility: 'private', modelIds: [model.id] };
    void service!.save(collection?.id ?? null, fields, collection?.version ?? null).then(value => {
      setSaved(checked ? `Saved to ${value.title}.` : `Removed from ${value.title}.`); setName(''); refresh();
    }, error => setError(message(error))).finally(() => setBusy(false));
  };
  return <><h2>Save to collection</h2>{ownError ? <div role="alert"><p>{ownError}</p><button className="secondary-button" onClick={refresh}>Reload collections</button></div> : !own ? <p role="status">Loading your collections…</p> : <>
    {own.map(collection => <label key={collection.id} className="collection-check"><input type="checkbox" checked={collection.modelIds.includes(model.id)} disabled={busy || (!collection.modelIds.includes(model.id) && collection.modelIds.length >= 100)} onChange={event => save(collection, event.target.checked)} /><span>{collection.title} <small>· {collection.visibility}</small></span></label>)}
    <div className="collection-create-inline"><label>New private collection<input maxLength={100} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label><button type="button" disabled={busy || !name.trim()} onClick={() => save(null, true)}>Create and save</button></div>
  </>}{error && <div role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={refresh}>Reload collections</button></div>}{saved && <p role="status">{saved}</p>}</>;
}
