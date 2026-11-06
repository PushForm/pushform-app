// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommonsBrowseFilters, CommonsBrowseLoader, CommonsBrowsePage, CatalogModel } from '@pushform/cloud';
import { BrowseImageCache } from './BrowseImages';

interface State { models: CatalogModel[]; total: number; categories: string[]; licenses: string[]; loading: boolean; more: boolean; loadingMore: boolean; error: Error | null }
const empty = (): State => ({ models: [], total: 0, categories: [], licenses: [], loading: true, more: false, loadingMore: false, error: null });
/** `images: false` keeps results without downloading their thumbnails, for a view that does not show them. */
export function useBrowsePaging(loader: CommonsBrowseLoader | null, filters: CommonsBrowseFilters, revision: number, filesUrl?: string, { images: withImages = true }: { images?: boolean } = {}) {
  const [state, setState] = useState<State>(empty);
  const showImages = useRef(withImages); showImages.current = withImages;
  const [images, setImages] = useState<BrowseImageCache | null>(null);
  const moreRef = useRef<() => void>(() => {});
  const query = filters.query, category = filters.category, license = filters.license, commercial = filters.commercial;
  useEffect(() => {
    const controller = new AbortController(); const signal = controller.signal;
    const cache = new BrowseImageCache(); setImages(cache);
    let next: CommonsBrowsePage['next'] = null, pending = false, wanted = false;
    const buffered: CommonsBrowsePage[] = [];
    const current = { query, category, license, commercial };
    const seen = new Set<string>();
    setState(value => ({ ...empty(), categories: value.categories, licenses: value.licenses }));
    const cleanup = () => { controller.abort(); cache.dispose(); moreRef.current = () => {}; };
    if (!loader) { moreRef.current = () => {}; return cleanup; }
    const append = (page: CommonsBrowsePage) => {
      const fresh = page.models.filter(model => { if (seen.has(model.id)) return false; seen.add(model.id); return true; });
      wanted = false;
      // Thumbnails download when their page is shown, not while it waits in the buffer.
      if (showImages.current) cache.prefetch(fresh, filesUrl);
      setState(value => ({ models: [...value.models, ...fresh], total: page.total, categories: page.categories, licenses: page.licenses, loading: false, more: buffered.length > 0 || next !== null, loadingMore: false, error: null }));
    };
    const prefetch = () => {
      // One page waits ahead of the reader: enough to make scrolling seamless without loading pages nobody reaches.
      if (!next || pending || buffered.length >= 1 || signal.aborted) return;
      pending = true; let succeeded = false;
      void loader(current, next, signal).then(page => {
        if (signal.aborted) return;
        next = page.next; buffered.push(page); succeeded = true;
        if (wanted) append(buffered.shift()!);
      }, error => { if (!signal.aborted) setState(value => ({ ...value, loadingMore: false, error: error instanceof Error ? error : new Error('Could not load more results.') })); })
        .finally(() => { pending = false; if (!signal.aborted && succeeded) prefetch(); });
    };
    moreRef.current = () => {
      if (signal.aborted) return;
      if (buffered.length) { append(buffered.shift()!); prefetch(); }
      else if (next) { wanted = true; setState(value => ({ ...value, loadingMore: true, error: null })); prefetch(); }
    };
    void loader(current, null, signal).then(page => {
      if (!signal.aborted) { next = page.next; append(page); prefetch(); }
    }, error => { if (!signal.aborted) setState(value => ({ ...value, loading: false, error: error instanceof Error ? error : new Error('Could not load results.') })); });
    return cleanup;
  }, [loader, query, category, license, commercial, revision, filesUrl]);
  const loadMore = useCallback(() => moreRef.current(), []);
  return { ...state, loadMore, images };
}
export function MoreBrowseResults({ more, loading, error, onMore, count }: { count: number; more: boolean; loading: boolean; error: Error | null; onMore(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!more || loading || error || !ref.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) onMore(); }, { rootMargin: '1200px 0px' });
    observer.observe(ref.current); return () => observer.disconnect();
  }, [more, loading, error, onMore, count]);
  if (!more) return null;
  return <div ref={ref} className="commons-load-more">{error && <p role="alert">{error.message}</p>}<button type="button" disabled={loading} onClick={onMore}>{loading ? 'Loading more models…' : error ? 'Retry loading more' : 'Load more models'}</button></div>;
}
