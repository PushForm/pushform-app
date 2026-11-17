// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { commonsFileUrl, type CatalogModel } from '@pushform/cloud';
import { commonsImageSources, commonsPreviewFile as geometryFile } from '@pushform/commons-ui/modelImages';
import { usePrefetchedImage } from '@pushform/commons-ui/BrowseImages';

export function CommonsThumbnail({ model, filesUrl }: { model: CatalogModel; filesUrl: string | undefined }) {
  const generated = geometryFile(model);
  const target = useRef<HTMLElement|null>(null);
  const [visible,setVisible] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(()=>{if(typeof IntersectionObserver === 'undefined')return;const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:'1200px'});if(target.current)observer.observe(target.current);return()=>observer.disconnect();},[]);
  const observe=(node:HTMLElement|null)=>{target.current=node;};
  const sources = commonsImageSources(model, filesUrl);
  const [failed, setFailed] = useState<string[]>([]);
  const candidate = sources.find(url => !failed.includes(url));
  const prefetched = usePrefetchedImage(candidate);
  const generatedUrl = generated ? commonsFileUrl(filesUrl, 'thumbnails', generated.id) : null;
  // A rendered thumbnail is requested directly. Its render status is checked only after the image itself fails, which is
  // the uncommon case of a model whose preview is still rendering.
  const retries = failed.filter(value => value === candidate + ':retry').length;
  const checking = candidate === generatedUrl && (retries > 0 || prefetched?.status === 'error');
  const status = usePreviewStatus(generated ? commonsFileUrl(filesUrl, 'preview-status', generated.id) : null, checking && visible);
  const src = prefetched?.status === 'ready' ? prefetched.src : prefetched?.status === 'loading' ? null : checking && status.status !== 'ready' ? null : candidate;
  return src ? <img ref={observe} src={src} alt={model.title} loading="lazy" referrerPolicy="no-referrer" onError={() => { if (src === generatedUrl && retries < 2) { setFailed(values => [...values, candidate + ':retry']); status.refresh(); } else if (candidate) setFailed(values => [...values, candidate]); }}/>
    : <div ref={observe} className="missing-image"><span aria-hidden="true">◇</span><span>{prefetched?.status === 'loading' ? 'Loading preview…' : checking && ['queued','rendering','loading'].includes(status.status) ? 'Rendering preview…' : 'Preview unavailable'}</span></div>;
}

// The 3D viewer and its renderer download only when someone opens it.
const InteractivePreview = lazy(() => import('./InteractivePreview').then(module => ({ default: module.InteractivePreview })));

export function CommonsModelPreview({ model, filesUrl }: { model: CatalogModel; filesUrl: string | undefined }) {
  const [active, setActive] = useState(false);
  const file = geometryFile(model);
  const url = file ? commonsFileUrl(filesUrl, 'previews', file.id) : null;
  return <section className="model-preview" aria-label="Model preview">
    {active && url ? <Suspense fallback={<div className="preview-loading" role="status">Loading the 3D viewer…</div>}><InteractivePreview url={url} model={model}/></Suspense> : <CommonsThumbnail model={model} filesUrl={filesUrl}/>}
    <div className="preview-actions">{url ? <button onClick={() => setActive(value => !value)}>{active ? 'Show thumbnail' : 'Explore in 3D'}</button> : <p>A 3D preview is not available for this format.</p>}</div>
  </section>;
}

export interface PreviewStatus { status: 'loading'|'queued'|'rendering'|'ready'|'failed'|'unsupported'; error: string|null }
const LOADING: PreviewStatus = { status: 'loading', error: null };

/** One status check per file, shared by every card and viewer that shows it: a model can appear in Featured, the
 * library and a collection at once. Polling stops when nothing shows the file or the render finishes, and a ready
 * result is kept for the rest of the visit. */
class PreviewStatusPoller {
  state: PreviewStatus = LOADING;
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly url: string) {}
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener); this.start();
    return () => { this.listeners.delete(listener); if (!this.listeners.size) this.stop(); };
  };
  /** Checks again, unless a check is already under way: several cards can report the same failed image at once. */
  readonly refresh = () => { if (this.abort) return; this.stop(); this.set(LOADING); if (this.listeners.size) this.start(); };
  private set(state: PreviewStatus) { this.state = state; for (const listener of [...this.listeners]) listener(); }
  private start() {
    if (this.abort || this.state.status === 'ready' || this.state.status === 'unsupported') return;
    if (this.state.status !== 'loading') this.set(LOADING);
    const abort = this.abort = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch(this.url,{signal:abort.signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
        if (!response.ok) throw new Error('Preview is unavailable.');
        if (!response.body) throw new Error('Invalid preview status.');
        const reader=response.body.getReader();let text='',size=0;const decoder=new TextDecoder();
        try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>4096){await reader.cancel();throw new Error('Invalid preview status.');}text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
        const result = JSON.parse(text) as PreviewStatus;
        if (!['queued','rendering','ready','failed','unsupported'].includes(result.status)) throw new Error('Invalid preview status.');
        if (abort.signal.aborted) return;
        const pending = result.status==='queued'||result.status==='rendering';
        if (pending) this.timer=setTimeout(()=>void poll(),2000); else this.abort=null;
        this.set({status:result.status,error:typeof result.error==='string'?result.error.slice(0,300):null});
      } catch { if(!abort.signal.aborted){ this.abort=null; this.set({status:'failed',error:'Preview is unavailable. Refresh the model page to try again.'}); } }
    };
    void poll();
  }
  private stop() {
    this.abort?.abort(); this.abort = null; clearTimeout(this.timer);
    // An unfinished or failed check starts over the next time the file is shown.
    if (this.state.status !== 'ready' && this.state.status !== 'unsupported') this.state = LOADING;
  }
}
const pollers = new Map<string, PreviewStatusPoller>();
const noSubscription = () => () => {};
export function usePreviewStatus(url: string|null, enabled: boolean): PreviewStatus & {refresh:()=>void} {
  let poller = url ? pollers.get(url) : undefined;
  if (url && !poller) { poller = new PreviewStatusPoller(url); pollers.set(url, poller); }
  const subscribe = useCallback((listener: () => void) => enabled && poller ? poller.subscribe(listener) : () => {}, [poller, enabled]);
  const state = useSyncExternalStore(poller ? subscribe : noSubscription, () => poller?.state ?? LOADING);
  return {...state,refresh:poller?.refresh??(()=>{})};
}
