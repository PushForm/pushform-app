// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useBrowsePaging, MoreBrowseResults } from '@pushform/commons-ui/BrowsePaging';
import type { CommonsBrowseLoader, CommonsBrowsePage, CommonsCollections, CommonsDiscovery } from '@pushform/cloud';
import { exampleModel } from './catalog.fixture';
import { App } from './App';
const filters = { query: '', category: '', license: '', commercial: false };
const page = (id: string, next: boolean): CommonsBrowsePage => ({ models: [exampleModel({ id, title: id })], total: 3, categories: ['Hardware'], licenses: ['CC0'], next: next ? { id, publishedAt: '2026-01-01T00:00:00Z', asOf: '2026-11-05T00:00:00Z' } : null });
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); delete (Element.prototype as Partial<Element>).scrollIntoView; });
function Fixture({ loader, query = '' }: { loader: CommonsBrowseLoader; query?: string }) {
  const value = useBrowsePaging(loader, { ...filters, query }, 0);
  return <>{value.models.map(model => <p key={model.id}>{model.title}</p>)}<MoreBrowseResults count={value.models.length} more={value.more} loading={value.loadingMore} error={value.error} onMore={value.loadMore}/></>;
}
it('shows the first page immediately, buffers one next page and reveals it on demand', async () => {
  const loader = vi.fn<CommonsBrowseLoader>().mockResolvedValueOnce(page('first', true)).mockResolvedValueOnce(page('second', true)).mockResolvedValueOnce(page('third', true)).mockResolvedValueOnce(page('fourth', false));
  render(<Fixture loader={loader}/>);
  await screen.findByText('first'); await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  await new Promise(resolve => setTimeout(resolve, 20)); expect(loader).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('second')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Load more models' }));
  await screen.findByText('second'); await waitFor(() => expect(loader).toHaveBeenCalledTimes(3));
  expect(screen.queryByText('third')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Load more models' }));
  await screen.findByText('third'); await waitFor(() => expect(loader).toHaveBeenCalledTimes(4));
  expect(screen.queryByText('fourth')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Load more models' }));
  await screen.findByText('fourth'); expect(screen.queryByRole('button')).toBeNull();
});
it('preserves cards and retries a failed prefetch without an automatic retry loop', async () => {
  const loader = vi.fn<CommonsBrowseLoader>().mockResolvedValueOnce(page('first', true)).mockRejectedValueOnce(new Error('Try later')).mockResolvedValueOnce(page('last', false));
  render(<Fixture loader={loader}/>);
  await screen.findByText('Try later'); expect(loader).toHaveBeenCalledTimes(2); expect(screen.getByText('first')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading more' }));
  await screen.findByText('last'); expect(loader).toHaveBeenCalledTimes(3);
});
it('cancels stale filter requests and ignores their late completion', async () => {
  let complete!: (value: CommonsBrowsePage) => void;
  const loader = vi.fn<CommonsBrowseLoader>().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })).mockResolvedValue(page('filtered', false));
  const view = render(<Fixture loader={loader}/>); view.rerender(<Fixture loader={loader} query="cabinet"/>);
  await screen.findByText('filtered'); expect(loader.mock.calls[0]![2].aborted).toBe(true);
  complete(page('stale', false)); await waitFor(() => expect(screen.queryByText('stale')).toBeNull());
});
it('does not load the full catalog for website browse and keeps global filter choices', async () => {
  const browse = vi.fn<CommonsBrowseLoader>().mockResolvedValue(page('first', false));
  const load = Object.assign(vi.fn().mockResolvedValue([]), { browse });
  render(<App loadCatalog={load}/>);
  await screen.findByRole('link', { name: 'first' }); expect(load).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cabinet' } });
  await waitFor(() => expect(browse).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'cabinet' }), null, expect.any(AbortSignal)));
  expect(screen.getByRole('option', { name: 'Hardware' })).toBeTruthy();
});

it('keeps search focused after filtered results arrive on the browse route', async () => {
  window.history.replaceState(null, '', '/#browse');
  const browse = vi.fn<CommonsBrowseLoader>().mockResolvedValueOnce(page('first', false)).mockResolvedValue(page('filtered', false));
  render(<App loadCatalog={Object.assign(vi.fn().mockResolvedValue([]), { browse })}/>);
  await screen.findByRole('link', { name: 'first' });
  const search = screen.getByRole('searchbox'); search.focus();
  fireEvent.change(search, { target: { value: 'cabinet' } });
  await screen.findByRole('link', { name: 'filtered' });
  expect(document.activeElement).toBe(search);
});

/** Opens the browse route with Featured still loading, runs `beforeSettling`, then lets Featured answer and waits for the page to handle it. */
async function browseUntilFeaturedSettles(beforeSettling: () => void): Promise<void> {
  window.history.replaceState(null, '', '/#browse');
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  let answer!: (discovery: CommonsDiscovery) => void;
  const collections = { discovery: () => new Promise<CommonsDiscovery>((resolve) => { answer = resolve; }) } as unknown as CommonsCollections;
  const browse = vi.fn<CommonsBrowseLoader>().mockResolvedValue(page('first', false));
  render(<App loadCatalog={Object.assign(vi.fn().mockResolvedValue([]), { browse })} collections={collections}/>);
  await screen.findByRole('link', { name: 'first' });
  beforeSettling();
  answer({ version: 1, creditedCreators: [], creators: [], collections: [], featured: [] });
  await waitFor(() => expect(scrolled).toHaveBeenCalled());
}

it('leaves the search box focused when Featured finishes loading on the browse route', async () => {
  let search!: HTMLElement;
  await browseUntilFeaturedSettles(() => { search = screen.getByRole('searchbox'); search.focus(); });
  expect(document.activeElement).toBe(search);
});

it('moves focus to the page content when Featured finishes loading and no field holds it', async () => {
  await browseUntilFeaturedSettles(() => undefined);
  expect(document.activeElement).toBe(document.getElementById('main'));
});

it('uses the scroll sentinel to consume a prefetched page', async () => {
  let intersect!: IntersectionObserverCallback;
  const observer = { observe: vi.fn(), disconnect: vi.fn() };
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback) { intersect = callback; } observe = observer.observe; disconnect = observer.disconnect; });
  try {
    const loader = vi.fn<CommonsBrowseLoader>().mockResolvedValueOnce(page('first', true)).mockResolvedValueOnce(page('last', false));
    render(<Fixture loader={loader}/>);
    await screen.findByText('first'); await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    intersect([{ isIntersecting: true } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
    await screen.findByText('last'); expect(screen.queryByRole('button')).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});
