// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { commonsFileUrl, CommonsUnavailableError, type CommonsProfile } from '@pushform/cloud';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { CommonsProfileEditor, CommonsProfilePageView, CreatorCredit, ProfileLink, type ProfileLookup } from './CommonsProfile';
import { ModelCard, ModelGrid } from './ModelCard';
import { currentCommonsLocation, profileHandleFromPath } from './route';
import { publishRoute, type PublishRoute } from './PublishPage';
import { CommonsAccessGate, CommonsDownloadButton, CommonsMailingPreference } from './CommonsAccess';
import type { CommonsAccount } from './account';
import { CommonsModelPreview } from './CommonsPreview';
import { CommonsOpenAction } from './CommonsOpenAction';
import { filterModels, type CatalogFilters, type CatalogLoader, type CatalogModel } from './catalog';

type CatalogState = { kind: 'unconfigured' | 'loading' | 'error' } | { kind: 'ready'; models: CatalogModel[] };
const emptyFilters: CatalogFilters = { query: '', category: '', license: '', commercial: false };
function modelFromHash(hash:string): string | null {
  const match = /^#models\/([a-z0-9][a-z0-9-]{0,95})$/.exec(hash);
  return match?.[1] ?? null;
}
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
  return <>
    <a className="back-link" href="#browse">← All models</a>
    <article className="model-detail">
      <div className="detail-image"><CommonsModelPreview key={model.id + model.revision} model={model} filesUrl={filesUrl} /></div>
      <div>
        <p className="eyebrow">{model.category}</p>
        <h1>{model.title}</h1><p className="creator"><CreatorCredit model={model}/></p>
        <p className="description">{model.description}</p>
        <dl className="metadata"><div><dt>Formats</dt><dd>{model.formats.join(', ')}</dd></div>
          <div><dt>Revision</dt><dd>{model.revision}</dd></div>
          <div><dt>Published</dt><dd>{new Date(model.publishedAt).toLocaleDateString()}</dd></div></dl>
        {model.source && <p className="source">Sourced from <a href={model.source.url} rel="noreferrer" target="_blank">{model.source.name} ↗</a></p>}
        <CommonsOpenAction model={model} editorUrl={editorUrl} />
        {model.files.length > 0 && <section className="downloads" aria-label="Model files"><h2>Model files</h2>
          <p>Each ZIP download includes the original file, licenses and creator credits.</p>
          <ul>{model.files.map((file) => <li key={file.id}><span>{file.name} · {(file.sizeBytes / 1024).toFixed(1)} KiB</span>
            {commonsFileUrl(filesUrl, 'downloads', file.id) ? <CommonsDownloadButton account={account??undefined} filesUrl={filesUrl} file={file}/> : <span>Downloads are unavailable in this build.</span>}
          </li>)}</ul>
        </section>}
        <section className="rights" aria-label="Licenses and attribution"><h2>Licenses & attribution</h2>
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

export function App({ loadCatalog, filesUrl, account=null, publishPage, editorUrl }: { loadCatalog: CatalogLoader | null; filesUrl?: string | undefined; account?:CommonsAccount|null; publishPage?:((route:PublishRoute,catalogReady:boolean)=>ReactNode)|undefined;editorUrl?:string|undefined }) {
  const [state, setState] = useState<CatalogState>({ kind: loadCatalog ? 'loading' : 'unconfigured' });
  const [attempt, setAttempt] = useState(0);
  useEffect(()=>{const refresh=()=>setAttempt(value=>value+1);window.addEventListener('commons:catalog-changed',refresh);return()=>window.removeEventListener('commons:catalog-changed',refresh);},[]);
  const [filters, setFilters] = useState<CatalogFilters>(emptyFilters);
  const [location,setLocation]=useState(currentCommonsLocation);
  const hash=location.hash;
  const selectedId=modelFromHash(hash);
  const profileHandle=hash===''||hash==='#main'?profileHandleFromPath(location.path):null;
  const legacyPersonId=/^#people\/([a-f0-9-]{36})$/.exec(hash)?.[1]??null;
  const profileLookup:ProfileLookup|null=profileHandle!==null?{handle:profileHandle}:legacyPersonId!==null?{id:legacyPersonId}:null;
  const onProfile=profileLookup!==null;
  const heading = useRef<HTMLDivElement>(null);
  const own=useOwnProfile(account);
  useEffect(() => {
    const update = () => {const next=currentCommonsLocation();setLocation(current=>next.path===current.path&&next.hash===current.hash?current:next);};
    window.addEventListener('hashchange', update);window.addEventListener('popstate', update);
    return () => {window.removeEventListener('hashchange', update);window.removeEventListener('popstate', update);};
  }, []);
  useEffect(() => {
    if (!loadCatalog) { setState({ kind: 'unconfigured' }); return; }
    const controller = new AbortController();
    setState({ kind: 'loading' });
    void loadCatalog(controller.signal).then((models) => {
      if (!controller.signal.aborted) setState({ kind: 'ready', models });
    }).catch((error: unknown) => { if (!controller.signal.aborted) setState({ kind: error instanceof CommonsUnavailableError ? 'unconfigured' : 'error' }); });
    return () => controller.abort();
  }, [loadCatalog, attempt]);
  const models = state.kind === 'ready' ? state.models : [];
  const shown = filterModels(models, filters);
  const selected = selectedId ? models.find((model) => model.id === selectedId) : null;
  useEffect(() => {
    if(onProfile)return;
    if(hash==='#account'||publishRoute(hash)){document.title=hash==='#account'?'Your profile — PushForm Commons':'My models — PushForm Commons';heading.current?.focus({preventScroll:true});return;}
    document.title = selected ? `${selected.title} — PushForm Commons` : 'PushForm Commons — Models for your next project';
    if (state.kind !== 'ready' || !window.location.hash) return;
    heading.current?.focus({ preventScroll: true });
    const target = selectedId ? heading.current : document.getElementById('browse');
    target?.scrollIntoView?.({ block: 'start' });
  }, [selected, selectedId, state.kind,onProfile,hash]);
  const options = (values: string[]) => [...new Set(values)].sort().map((value) => <option key={value} value={value}>{value}</option>);
  const update = (patch: Partial<CatalogFilters>) => setFilters((current) => ({ ...current, ...patch }));
  return <div className="commons">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><a className="brand" href="#browse" aria-label="PushForm Commons home">
      <img src="/pf-logo-mark.svg" alt="" width="30" height="30" /><span>PushForm <strong>Commons</strong></span>
    </a><nav aria-label="Commons">{account&&<><a className="nav-upload" href="#upload">Upload model</a><a href="#my-models">My models</a><MyProfileLink own={own}/></>}<a className="editor-link" href="https://app.pushform.io">Open PushForm <span aria-hidden="true">↗</span></a></nav></header>
    <main id="main" ref={heading} tabIndex={-1}>
      {profileLookup?<CommonsProfilePageView lookup={profileLookup} profiles={account?.profiles??null} filesUrl={filesUrl} ownProfileId={own?.id??null}/>:hash==='#account'?account?<AccountPage account={account} filesUrl={filesUrl}/>:<section className="status-panel"><h1>Accounts are unavailable in this build.</h1></section>:publishRoute(hash)?publishPage?.(publishRoute(hash)!,state.kind==='ready')??<section className="status-panel"><h1>Publishing is unavailable in this build.</h1></section>:state.kind === 'ready' && selectedId ? selected ? <ModelDetail model={selected} filesUrl={filesUrl} account={account} editorUrl={editorUrl} /> :
        <section className="status-panel"><p className="eyebrow">Model unavailable</p><h1>This model isn’t in the catalog.</h1>
          <p>It may have been removed or the link may be out of date.</p><a href="#browse">Browse models</a></section> : <>
        <section className="hero"><p className="eyebrow">A shared place to start</p>
          <h1>Your next project<br />starts with <em>an idea.</em></h1>
          <p>Find community-built models for the things you want to make.<br className="desktop-break" /> From the smallest fitting to the whole workshop.</p>
          <div className="hero-rule"><span>Models for makers</span><span>PushForm Commons</span></div>
        </section>
        <section id="browse" aria-labelledby="browse-title" className="browse">
          <div className="section-heading"><div><p className="eyebrow">Find your starting point</p><h2 id="browse-title">Browse models</h2></div>
            {state.kind === 'ready' && <span className="catalog-count">{models.length} {models.length === 1 ? 'model' : 'models'}</span>}</div>
          <div className="filters" role="search" aria-label="Search models">
            <label className="search-field"><span>Search models</span><input type="search" placeholder="Try a chair, hinge or garden bench…" value={filters.query} onChange={(event) => update({ query: event.target.value })} /></label>
            <label><span>Category</span><select value={filters.category} onChange={(event) => update({ category: event.target.value })}><option value="">All categories</option>{options(models.map((model) => model.category))}</select></label>
            <label><span>License</span><select value={filters.license} onChange={(event) => update({ license: event.target.value })}><option value="">All licenses</option>{options(models.flatMap((model) => model.licenses.map((license) => license.name)))}</select></label>
            <label className="commercial"><input type="checkbox" checked={filters.commercial} onChange={(event) => update({ commercial: event.target.checked })} />Commercial use permitted</label>
          </div>
          {state.kind === 'unconfigured' && <section className="status-panel" role="status"><span className="status-icon" aria-hidden="true">◇</span><h3>A place for what you’ll make next.</h3><p>The Commons catalog isn’t available yet. Check back as the library takes shape.</p></section>}
          {state.kind === 'loading' && <p className="status-panel" role="status">Loading models…</p>}
          {state.kind === 'error' && <section className="status-panel" role="alert"><h3>We couldn’t load the catalog.</h3><p>Please try again in a moment.</p><button onClick={() => setAttempt((value) => value + 1)}>Try again</button></section>}
          {state.kind === 'ready' && <>
            <p className="result-count" role="status">{shown.length} {shown.length === 1 ? 'model' : 'models'}{filters.query && ` matching “${filters.query}”`}</p>
            {shown.length ? <ModelGrid>{shown.map((model) => <ModelCard key={model.id} model={model} filesUrl={filesUrl} />)}</ModelGrid> : <section className="status-panel"><h3>{models.length ? 'No models match those filters.' : 'The library is ready for its first models.'}</h3>
              <p>{models.length ? 'Try a different search or broaden your filters.' : 'Published models will appear here.'}</p>
              {models.length > 0 && <button onClick={() => setFilters(emptyFilters)}>Clear filters</button>}</section>}
          </>}
        </section>
      </>}
    </main>
    <footer className="site-footer"><span>Good projects start with shared ideas.</span><div><a href="https://pushform.io">PushForm</a><a href="https://pushform.io/terms">Terms</a><a href="https://pushform.io/privacy">Privacy</a></div></footer>
  </div>;
}

function AccountPage({account,filesUrl}:{account:CommonsAccount;filesUrl:string|undefined}){
  const state=useSyncExternalStore(account.session.subscribe,account.session.getSnapshot);
  return <CommonsAccessGate account={account}><div key={state.user?.id??'signed-out'}>
    <CommonsProfileEditor profiles={account.profiles} images={filesUrl?{filesUrl,token:async()=>{const value=await account.session.getAccessToken();if(!value)throw new Error('Sign in to change your profile images.');return value;}}:undefined}/><CommonsMailingPreference account={account}/>
    <button onClick={()=>void account.session.signOut()} disabled={state.pending!==null}>Sign out</button>
  </div></CommonsAccessGate>;
}
