// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ModelDescription } from './ModelDescription';
import { WhereToBuy } from './WhereToBuy';
import { BrowseImagesProvider } from '@pushform/commons-ui/BrowseImages';
import { useBrowsePaging, MoreBrowseResults } from '@pushform/commons-ui/BrowsePaging';
import { commonsFileUrl, CommonsUnavailableError, type CommonsProfile, type CommonsCollections } from '@pushform/cloud';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { CommonsProfileEditor, CommonsProfilePageView, CreatorCredit, ProfileLink, type ProfileLookup } from './CommonsProfile';
import { ModelCard, ModelGrid, SkeletonGrid } from './ModelCard';
import { browseSearchFromUrl, clearBrowseSearch, collectionIdFromPath, currentCommonsLocation, modelIdFromPath, navigateCommons, openInApp, profileHandleFromPath, profilePath, publishRoute, type PublishRoute } from './route';
import { applySeo, homeSeo, modelSeo, normalizeSiteUrl, utilitySeo } from './seo';
import { OwnModelsProvider, OwnModelGrid, OwnedDraftDetail, OwnerModelActions, useOwnModels } from './OwnModels';
import { CommonsAccessGate, CommonsDownloadButton, CommonsMailingPreference } from './CommonsAccess';
import { sortedModelFiles } from './modelFiles';
import type { CommonsAccount } from './account';
import { CommonsModelPreview } from './CommonsPreview';
import { CommonsOpenAction } from './CommonsOpenAction';
import { BrowseFilters } from './BrowseFilters';
import { SiteFooter } from './SiteFooter';
import { filterModels, type CatalogFilters, type CatalogLoader, type CatalogModel } from './catalog';
import { CatalogModelStore, CatalogModelsProvider } from './catalogModels';
import { ProfileCollections, CreditedCreatorPage, CollectionsProvider, CollectionsRoute, FeaturedSection, FeatureAction, ModelCollectionAction, PublicCollectionResults } from './Collections';

type CatalogState = { kind: 'unconfigured' | 'loading' | 'error' } | { kind: 'ready'; models: CatalogModel[] };
const emptyFilters: CatalogFilters = { query: '', category: '', license: '', commercial: false };
const noSubscription=()=>()=>{};
/** The signed-in user's own profile: `undefined` while loading, `null` when signed out, absent or unreadable. Reloads after a profile save. */
function useOwnProfile(account:CommonsAccount|null):CommonsProfile|null|undefined{
  const session=account?.session;
  const userId=useSyncExternalStore(session?.subscribe??noSubscription,()=>session?.getSnapshot().user?.id??null);
  const [own,setOwn]=useState<CommonsProfile|null|undefined>(undefined);const [revision,setRevision]=useState(0);
  useEffect(()=>{const refresh=()=>setRevision(value=>value+1);window.addEventListener('commons:catalog-changed',refresh);return()=>window.removeEventListener('commons:catalog-changed',refresh);},[]);
  useEffect(()=>{
    if(!account||userId===null){setOwn(null);return;}
    const controller=new AbortController();setOwn(undefined);
    void account.profiles.mine(controller.signal).then(value=>{if(!controller.signal.aborted)setOwn(value);},()=>{if(!controller.signal.aborted)setOwn(null);});
    return()=>controller.abort();
  },[account,userId,revision]);
  return own;
}
/** Opens the user's public profile; signed out, still loading, or without a visible profile it opens the profile editor. */
function MyProfileLink({own}:{own:CommonsProfile|null|undefined}){
  return own?.active?<ProfileLink handle={own.handle}>My profile</ProfileLink>:<a href="#account">My profile</a>;
}
function ModelDetail({ model, filesUrl, account, editorUrl }: { model: CatalogModel; filesUrl: string | undefined; account:CommonsAccount|null; editorUrl:string|undefined }) {
  const owned = useOwnModels().models?.find(value => value.id === model.id);
  return <>
    <a className="back-link" href="/#browse" onClick={event=>openInApp(event,'/#browse')}>← All models</a>
    <article className="model-detail">
      <div className="detail-image"><CommonsModelPreview key={model.id + model.revision} model={model} filesUrl={filesUrl} /></div>
      <div>
        <p className="eyebrow">{model.category}</p>
        <h1>{model.title}</h1><p className="creator"><CreatorCredit model={model}/></p>
        <ModelDescription text={model.description}/>
        <dl className="metadata"><div><dt>Formats</dt><dd>{model.formats.join(', ')}</dd></div>
          <div><dt>Revision</dt><dd title={model.revision}>{model.revision.slice(-6)}</dd></div>
          <div><dt>Published</dt><dd>{new Date(model.publishedAt).toLocaleDateString()}</dd></div></dl>
        {owned && <OwnerModelActions key={owned.id} model={owned} filesUrl={filesUrl} />}
        <CommonsOpenAction model={model} editorUrl={editorUrl} />
        <div className="collection-actions"><ModelCollectionAction model={model} /><FeatureAction key={model.id} type="model" targetId={model.id} eligible={model.files.length > 0} /></div>
        <WhereToBuy key={'purchase:'+model.id} modelId={model.id} account={account}/>
        {model.files.length > 0 && <section className="downloads" aria-label="Model files"><h2>Model files</h2>
          <p>Each ZIP download includes the original file, licenses and creator credits.</p>
          <ul>{sortedModelFiles(model.files).map((file) => <li key={file.id}><span>{file.name} · {(file.sizeBytes / 1024).toFixed(1)} KiB</span>
            {commonsFileUrl(filesUrl, 'downloads', file.id) ? <CommonsDownloadButton account={account??undefined} filesUrl={filesUrl} file={file}/> : <span>Downloads are unavailable in this build.</span>}
          </li>)}</ul>
        </section>}
        <section className="rights" aria-label="Licenses and attribution"><h2>Licenses & attribution</h2>
          {model.source && <p className="source">Source: <a href={model.source.url} rel="noreferrer" target="_blank">{model.source.name} ↗</a></p>}
          {model.licenses.map((license, index) => <div key={index}>
            <h3>{license.url?<a href={license.url} rel="noreferrer" target="_blank">{license.name} ↗</a>:license.name}</h3>
            <p>{license.commercialUse === 'allowed' ? 'Commercial use permitted under this license.' :
              license.commercialUse === 'restricted' ? 'Commercial use is restricted by this license.' : 'Commercial-use permission has not been established.'}</p>
            {license.conditions.length > 0 && <ul>{license.conditions.map((condition, i) => <li key={i}>{condition}</li>)}</ul>}
          </div>)}
          {model.credits.map((credit, index) => <div className="credit" key={index}>
            <strong>{credit.url ? <a href={credit.url} rel="noreferrer" target="_blank">{credit.name} ↗</a> : credit.name}</strong>
            {credit.text && <p>{credit.text}</p>}
          </div>)}
        </section>
      </div>
    </article>
  </>;
}

function CommonsApp({ loadCatalog, filesUrl, account=null, publishPage, editorUrl, collections=null }: { loadCatalog: CatalogLoader | null; filesUrl?: string | undefined; account?:CommonsAccount|null; publishPage?:((route:PublishRoute,catalogReady:boolean)=>ReactNode)|undefined;editorUrl?:string|undefined;collections?:CommonsCollections|null }) {
  const [fullState, setState] = useState<CatalogState>({ kind: loadCatalog ? 'loading' : 'unconfigured' });
  const [attempt, setAttempt] = useState(0);
  useEffect(()=>{const refresh=()=>setAttempt(value=>value+1);window.addEventListener('commons:catalog-changed',refresh);return()=>window.removeEventListener('commons:catalog-changed',refresh);},[]);
  const [filters, setFilters] = useState<CatalogFilters>(() => { const query = browseSearchFromUrl(); return query === null ? emptyFilters : { ...emptyFilters, query }; });
  const [footerDocked, setFooterDocked] = useState(false);
  const [location,setLocation]=useState(currentCommonsLocation);
  const hash=location.hash;
  const onCollections=hash==='#collections';
  const collectionId=collectionIdFromPath(location.path);
  const collectionRoute=collectionId!==null||hash==='#collections/new';
  const legacyOwnRoute=hash==='#my-models'||hash==='#my-collections';
  const ownedModels=useOwnModels();
  const selectedId=modelIdFromPath(location.path);
  const profileHandle=hash===''||hash==='#main'?profileHandleFromPath(location.path):null;
  const legacyPersonId=/^#people\/([a-f0-9-]{36})$/.exec(hash)?.[1]??null;
  const profileLookup:ProfileLookup|null=profileHandle!==null?{handle:profileHandle}:legacyPersonId!==null?{id:legacyPersonId}:null;
  const creditedCreatorId=/^#creators\/(credited-[a-f0-9]{32})$/.exec(hash)?.[1]??null;
  const onProfile=profileLookup!==null||creditedCreatorId!==null;
  // The Collections tab shares the library page, its filter choices and its model count. It shows no models, so it
  // neither downloads their thumbnails nor searches models as the reader types.
  const listing = location.path === '/' && ['', '#browse', '#main', '#collections'].includes(hash);
  const paged = Boolean(loadCatalog?.browse && listing);
  const paging = useBrowsePaging(paged ? loadCatalog?.browse ?? null : null, onCollections ? emptyFilters : filters, attempt, filesUrl, { images: !onCollections });
  const state: CatalogState = paged ? paging.loading ? { kind: 'loading' } : paging.error && !paging.models.length ? { kind: paging.error instanceof CommonsUnavailableError ? 'unconfigured' : 'error' } : { kind: 'ready', models: paging.models } : fullState;
  const heading = useRef<HTMLDivElement>(null);
  const [featuredSettled, setFeaturedSettled] = useState(false);
  const settleFeatured = useCallback(() => setFeaturedSettled(true), []);
  const focusedRoute = useRef<{ key: string; done: boolean }>({ key: '', done: false });
  const own=useOwnProfile(account);
  useEffect(() => {
    if (!legacyOwnRoute || own === undefined) return;
    if (own?.active) navigateCommons(profilePath(own.handle), true);
    else window.location.hash = '#account';
  }, [legacyOwnRoute, own]);
  useEffect(() => {
    clearBrowseSearch();
    const update = () => {
      const query=browseSearchFromUrl();
      if(query!==null){clearBrowseSearch();setFilters({...emptyFilters,query});}
      const next=currentCommonsLocation();setLocation(current=>next.path===current.path&&next.hash===current.hash?current:next);};
    window.addEventListener('hashchange', update);window.addEventListener('popstate', update);
    return () => {window.removeEventListener('hashchange', update);window.removeEventListener('popstate', update);};
  }, []);
  useEffect(() => {
    if (paged) return;
    if (!loadCatalog) { setState({ kind: 'unconfigured' }); return; }
    // Profiles, collections and creator pages load just the models they show (see CatalogModelsProvider).
    if (!selectedId && !listing && loadCatalog.byIds) { setState({ kind: 'ready', models: [] }); return; }
    const controller = new AbortController();
    setState({ kind: 'loading' });
    const request = selectedId && loadCatalog.byIds ? loadCatalog.byIds([selectedId], controller.signal) : loadCatalog(controller.signal);
    void request.then((models) => {
      if (!controller.signal.aborted) setState({ kind: 'ready', models });
    }).catch((error: unknown) => { if (!controller.signal.aborted) setState({ kind: error instanceof CommonsUnavailableError ? 'unconfigured' : 'error' }); });
    return () => controller.abort();
  }, [loadCatalog, attempt, paged, selectedId, listing]);
  const models = state.kind === 'ready' ? state.models : [];
  // A static catalog snapshot read for the library also answers the model lookups of featured and collection cards.
  const catalogModels = useMemo(() => new CatalogModelStore(loadCatalog), [loadCatalog]);
  useEffect(() => { if (!paged && !selectedId && !loadCatalog?.byIds && fullState.kind === 'ready') catalogModels.seed(fullState.models); }, [catalogModels, fullState, paged, selectedId, loadCatalog]);
  const shown = paged ? models : filterModels(models, filters);
  const selected = selectedId ? models.find((model) => model.id === selectedId) : null;
  const seoContext = useMemo(() => ({ siteUrl: normalizeSiteUrl(import.meta.env.VITE_COMMONS_SITE_URL), filesUrl }), [filesUrl]);
  // Search and social tags follow the route. Until the catalog is ready the tags the edge worker wrote stay in place.
  useEffect(() => {
    // Profile and collection pages write their own tags once their content arrives.
    if (onProfile || collectionId) return;
    if (collectionRoute || legacyOwnRoute || hash === '#account' || publishRoute(hash)) { applySeo({ ...utilitySeo('Commons', seoContext), title: document.title }); return; }
    if (selectedId) {
      if (selected) applySeo(modelSeo(selected, seoContext));
      else if (state.kind === 'ready') applySeo(utilitySeo(ownedModels.models?.some(model => model.id === selectedId) ? 'Your model' : 'Model not found', seoContext));
      return;
    }
    if (state.kind === 'ready') applySeo(homeSeo(state.models, seoContext));
    else if (state.kind === 'unconfigured') applySeo(utilitySeo('Models', seoContext));
  }, [onProfile, collectionId, collectionRoute, legacyOwnRoute, hash, selectedId, selected, state, seoContext, ownedModels.models]);
  useEffect(() => {
    const key = location.path + hash;
    if (focusedRoute.current.key !== key) focusedRoute.current = { key, done: false };
    const focusHeading = () => { if (!focusedRoute.current.done) heading.current?.focus({ preventScroll: true }); };
    if(onProfile){focusedRoute.current.done=true;return;}
    if(collectionRoute){if(!focusedRoute.current.done){focusHeading();heading.current?.scrollIntoView?.({block:'start'});}focusedRoute.current.done=true;return;}
    if(hash==='#account'||publishRoute(hash)){document.title=hash==='#account'?'Your profile — PushForm Commons':`${publishRoute(hash)?.kind==='edit'?'Edit model':'Upload model'} — PushForm Commons`;focusHeading();focusedRoute.current.done=true;return;}
    if (state.kind !== 'ready' || (!window.location.hash && !selectedId) || focusedRoute.current.done) return;
    // Featured sits above the library; scrolling before it fills in would move the library under the reader.
    if (!selectedId && !featuredSettled) return;
    // Someone moving along the tabs, or already typing or choosing in a field, keeps their place.
    if (!document.activeElement?.closest('.catalog-tabs, input, textarea, select, [contenteditable="true"]')) focusHeading();
    const target = selectedId ? heading.current : document.getElementById('browse');
    target?.scrollIntoView?.({ block: 'start' });
    focusedRoute.current.done = true;
  }, [selected, selectedId, state.kind,onProfile,hash,collectionRoute,location.path,featuredSettled]);
  const update = (patch: Partial<CatalogFilters>) => setFilters((current) => ({ ...current, ...patch }));
  return <CatalogModelsProvider store={catalogModels}><CollectionsProvider service={collections} account={account}><BrowseImagesProvider value={paged ? paging.images : null}><div className="commons">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><a className="brand" href="/" onClick={event=>openInApp(event,'/')} aria-label="PushForm Commons home">
      <img src="/pf-logo-mark.svg" alt="" width="30" height="30" /><span>PushForm <strong>Commons</strong></span>
    </a><nav aria-label="Commons">{account&&<a className="nav-upload" href="#upload">Upload model</a>}<a href="#collections">Collections</a>{account&&<><MyProfileLink own={own}/></>}<a className="editor-link" href="https://app.pushform.io">Open PushForm <span aria-hidden="true">↗</span></a></nav></header>
    <main id="main" ref={heading} tabIndex={-1}>
      {creditedCreatorId?<CreditedCreatorPage key={creditedCreatorId} id={creditedCreatorId} filesUrl={filesUrl}/>:legacyOwnRoute?<p className="status-panel" role="status">Opening your profile...</p>:collectionRoute?<CollectionsRoute id={collectionId ?? 'new'} filesUrl={filesUrl}/>:profileLookup?<CommonsProfilePageView lookup={profileLookup} profiles={account?.profiles??null} filesUrl={filesUrl} ownProfileId={own?.id??null} renderCollections={(handle,owner,profileId)=><ProfileCollections handle={handle} owner={owner} profileId={profileId} filesUrl={filesUrl}/>} renderOwnModels={()=><OwnModelGrid filesUrl={filesUrl}/>}/>:hash==='#account'?account?<AccountPage account={account} filesUrl={filesUrl}/>:<section className="status-panel"><h1>Accounts are unavailable in this build.</h1></section>:publishRoute(hash)?publishPage?.(publishRoute(hash)!,state.kind==='ready')??<section className="status-panel"><h1>Publishing is unavailable in this build.</h1></section>:selectedId && (state.kind === 'ready' || ownedModels.models?.some(model=>model.id===selectedId)) ? selected ? <ModelDetail model={selected} filesUrl={filesUrl} account={account} editorUrl={editorUrl} /> :
        ownedModels.models?.find(model=>model.id===selectedId) ? <OwnedDraftDetail key={selectedId} model={ownedModels.models.find(model=>model.id===selectedId)!} filesUrl={filesUrl}/> : account && ownedModels.userId && !ownedModels.models && !ownedModels.error ? <p role="status">Loading your model...</p> : <section className="status-panel"><p className="eyebrow">Model unavailable</p><h1>This model isn’t in the catalog.</h1>
          <p>It may have been removed or the link may be out of date.</p><a href="/#browse" onClick={event=>openInApp(event,'/#browse')}>Browse models</a></section> : <>
        <section className="hero"><p className="eyebrow">A shared place to start</p>
          <h1>Good projects start<br />with <em>shared ideas.</em></h1>
          <p>Find a model. Explore a collection. Make it your own.</p>
        </section>
        <FeaturedSection filesUrl={filesUrl} onSettled={settleFeatured}/>
        <section id="browse" aria-labelledby="browse-title" className="browse">
          <div className="section-heading"><div><p className="eyebrow">Find your starting point</p><h2 id="browse-title">{onCollections?'Browse collections':'Browse models'}</h2></div>
            {!account && state.kind === 'ready' && <span className="catalog-count">{paged ? paging.total : models.length} {(paged ? paging.total : models.length) === 1 ? 'model' : 'models'}</span>}</div>
          <div className="catalog-tabs" role="tablist" aria-label="Browse Commons" onKeyDown={event=>{
            const keys=['ArrowLeft','ArrowRight','Home','End'];if(!keys.includes(event.key))return;event.preventDefault();
            const next=event.key==='Home'?false:event.key==='End'?true:!onCollections;
            window.location.hash=next?'#collections':'#browse';document.getElementById(next?'browse-collections-tab':'browse-models-tab')?.focus();
          }}><a role="tab" id="browse-models-tab" aria-selected={!onCollections} aria-controls="catalog-results" href="#browse">Models</a><a role="tab" id="browse-collections-tab" aria-selected={onCollections} aria-controls="catalog-results" href="#collections">Collections</a></div>
          <BrowseFilters onDockChange={setFooterDocked} filters={filters} update={update} collections={onCollections}
            categories={paged ? paging.categories : models.map(model => model.category)}
            licenses={paged ? paging.licenses : models.flatMap(model => model.licenses.map(license => license.name))}>
          {state.kind === 'unconfigured' && <section className="status-panel" role="status"><span className="status-icon" aria-hidden="true">◇</span><h3>A place for what you’ll make next.</h3><p>The Commons catalog isn’t available yet. Check back as the library takes shape.</p></section>}
          {state.kind === 'loading' && !onCollections && <SkeletonGrid count={6} label="Loading models…"/>}
          {state.kind === 'error' && <section className="status-panel" role="alert"><h3>We couldn’t load the catalog.</h3><p>Please try again in a moment.</p><button onClick={() => setAttempt((value) => value + 1)}>Try again</button></section>}
          <div id="catalog-results" role="tabpanel" aria-labelledby={onCollections?'browse-collections-tab':'browse-models-tab'}>{onCollections?<PublicCollectionResults filesUrl={filesUrl} filters={filters}/>:state.kind === 'ready' && <>
            <p className="result-count" role="status">{paged && paging.more ? `${shown.length} of ${paging.total}` : shown.length} {(paged ? paging.total : shown.length) === 1 ? 'model' : 'models'}{filters.query.trim() && (/["“”„]/.test(filters.query) ? ` matching ${filters.query.trim()}` : ` matching “${filters.query.trim()}”`)}</p>
            {shown.length ? <ModelGrid>{shown.map((model) => <ModelCard key={model.id} model={model} filesUrl={filesUrl} />)}</ModelGrid> : <section className="status-panel"><h3>{(models.length || paged && (filters.query || filters.category || filters.license || filters.commercial)) ? 'No models match those filters.' : 'The library is ready for its first models.'}</h3>
              <p>{(models.length || paged && (filters.query || filters.category || filters.license || filters.commercial)) ? 'Try a different search or broaden your filters.' : 'Published models will appear here.'}</p>
              {(models.length > 0 || paged && (filters.query || filters.category || filters.license || filters.commercial)) && <button onClick={() => setFilters(emptyFilters)}>Clear filters</button>}</section>}
            {paged && <MoreBrowseResults count={shown.length} more={paging.more} loading={paging.loadingMore} error={paging.error} onMore={paging.loadMore}/>}
          </>}</div>
          </BrowseFilters>
        </section>
      </>}
    </main>
    <SiteFooter docked={footerDocked} />
  </div></BrowseImagesProvider></CollectionsProvider></CatalogModelsProvider>;
}

function AccountPage({account,filesUrl}:{account:CommonsAccount;filesUrl:string|undefined}){
  const state=useSyncExternalStore(account.session.subscribe,account.session.getSnapshot);
  return <CommonsAccessGate account={account}><div key={state.user?.id??'signed-out'}>
    <CommonsProfileEditor profiles={account.profiles} images={filesUrl?{filesUrl,token:async()=>{const value=await account.session.getAccessToken();if(!value)throw new Error('Sign in to change your profile images.');return value;}}:undefined}/><CommonsMailingPreference account={account}/>
    <button onClick={()=>void account.session.signOut()} disabled={state.pending!==null}>Sign out</button>
  </div></CommonsAccessGate>;
}

export function App(props: Parameters<typeof CommonsApp>[0]) {
  return <OwnModelsProvider account={props.account ?? null}><CommonsApp {...props}/></OwnModelsProvider>;
}
