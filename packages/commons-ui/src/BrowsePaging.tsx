// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useCallback, useEffect, useRef, useState } from 'react';
import { commonsFileUrl, type CommonsBrowseFilters, type CommonsBrowseLoader, type CommonsBrowsePage, type CatalogModel } from '@pushform/cloud';

interface State { models: CatalogModel[]; total: number; categories: string[]; licenses: string[]; loading: boolean; more: boolean; loadingMore: boolean; error: Error | null }
const empty = (): State => ({ models: [], total: 0, categories: [], licenses: [], loading: true, more: false, loadingMore: false, error: null });
export function useBrowsePaging(loader: CommonsBrowseLoader | null, filters: CommonsBrowseFilters, revision: number, filesUrl?: string) {
  const [state, setState] = useState<State>(empty);
  const moreRef = useRef<() => void>(() => {});
  const query = filters.query, category = filters.category, license = filters.license, commercial = filters.commercial;
  useEffect(() => {
    const controller = new AbortController(); const signal = controller.signal;
    let next: CommonsBrowsePage['next'] = null, buffered: CommonsBrowsePage | null = null, pending: Promise<void> | null = null, wanted = false;
    const current = { query, category, license, commercial };
    const images = new Set<HTMLImageElement>();
    const seen = new Set<string>();
    setState(value => ({ ...empty(), categories: value.categories, licenses: value.licenses }));
    if (!loader) { moreRef.current = () => {}; return () => controller.abort(); }
    const warm = (models: CatalogModel[]) => {
      for (const model of models.slice(0, 6)) {
        const file = model.files.find(file => file.format !== 'ZIP');
        const url = (model.previewImage && commonsFileUrl(filesUrl, 'images', model.previewImage.id)) || model.imageUrl || (file && commonsFileUrl(filesUrl, 'thumbnails', file.id));
        if (url) { const image = new Image(); image.referrerPolicy = 'no-referrer'; images.add(image); image.onload = image.onerror = () => { images.delete(image); }; image.src = url; }
      }
    };
    const append = (page: CommonsBrowsePage) => {
      const fresh = page.models.filter(model => { if (seen.has(model.id)) return false; seen.add(model.id); return true; });
      next = page.next; buffered = null; wanted = false;
      setState(value => ({ models: [...value.models, ...fresh], total: page.total, categories: page.categories, licenses: page.licenses, loading: false, more: next !== null, loadingMore: false, error: null }));
    };
    const prefetch = () => {
      if (!next || pending || buffered || signal.aborted) return;
      let consumed = false;
      pending = loader(current, next, signal).then(page => {
        if (signal.aborted) return;
        buffered = page; warm(page.models);
        if (wanted) { append(page); consumed = true; }
      }, error => { if (!signal.aborted) setState(value => ({ ...value, loadingMore: false, error: error instanceof Error ? error : new Error('Could not load more results.') })); })
        .finally(() => { pending = null; if (!signal.aborted && consumed && next) prefetch(); });
    };
    moreRef.current = () => {
      if (signal.aborted || !next) return;
      if (buffered) { append(buffered); prefetch(); }
      else { wanted = true; setState(value => ({ ...value, loadingMore: true, error: null })); prefetch(); }
    };
    void loader(current, null, signal).then(page => { if (!signal.aborted) { append(page); prefetch(); } }, error => { if (!signal.aborted) setState(value => ({ ...value, loading: false, error: error instanceof Error ? error : new Error('Could not load results.') })); });
    return () => { controller.abort(); for (const image of images) image.removeAttribute('src'); moreRef.current = () => {}; };
  }, [loader, query, category, license, commercial, revision, filesUrl]);
  const loadMore = useCallback(() => moreRef.current(), []);
  return { ...state, loadMore };
}
export function MoreBrowseResults({ more, loading, error, onMore, count }: { count: number; more: boolean; loading: boolean; error: Error | null; onMore(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!more || loading || error || !ref.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) onMore(); }, { rootMargin: '600px 0px' });
    observer.observe(ref.current); return () => observer.disconnect();
  }, [more, loading, error, onMore, count]);
  if (!more) return null;
  return <div ref={ref} className="commons-load-more">{error && <p role="alert">{error.message}</p>}<button type="button" disabled={loading} onClick={onMore}>{loading ? 'Loading more models…' : error ? 'Retry loading more' : 'Load more models'}</button></div>;
}
