// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { exampleModel } from './catalog.fixture';
import { CatalogModelStore, CatalogModelsProvider, useCatalogModels } from './catalogModels';
import type { CatalogLoader } from './catalog';

afterEach(cleanup);
const models = Array.from({ length: 150 }, (_, index) => exampleModel({ id: `model-${index}`, title: `Model ${index}` }));
function Titles({ ids }: { ids: string[] }) {
  const value = useCatalogModels(ids);
  return <p>{value.loading ? 'loading' : value.models.map(model => model.title).join(', ') || 'none'}</p>;
}
function loader(byIds = vi.fn(async (ids: string[]) => models.filter(model => ids.includes(model.id)))) {
  return { full: vi.fn(async () => models), byIds };
}

it('combines the models several cards ask for into requests of at most 100', async () => {
  const { full, byIds } = loader();
  const store = new CatalogModelStore(Object.assign(full, { byIds }) as CatalogLoader);
  render(<CatalogModelsProvider store={store}><Titles ids={['model-0', 'model-1']}/><Titles ids={['model-1', 'model-2']}/><Titles ids={models.slice(3).map(model => model.id)}/></CatalogModelsProvider>);
  expect(await screen.findByText('Model 0, Model 1')).toBeTruthy();
  expect(screen.getByText('Model 1, Model 2')).toBeTruthy();
  expect(byIds).toHaveBeenCalledTimes(2);
  expect(byIds.mock.calls.map(call => call[0].length)).toEqual([100, 50]);
  expect(new Set(byIds.mock.calls.flatMap(call => call[0])).size).toBe(150);
  expect(full).not.toHaveBeenCalled();
});

it('leaves out models that are no longer published and counts them', async () => {
  const { full, byIds } = loader();
  const store = new CatalogModelStore(Object.assign(full, { byIds }) as CatalogLoader);
  let seen: ReturnType<typeof useCatalogModels> | undefined;
  function Probe() { seen = useCatalogModels(['model-0', 'withdrawn']); return null; }
  render(<CatalogModelsProvider store={store}><Probe/></CatalogModelsProvider>);
  await waitFor(() => expect(seen?.loading).toBe(false));
  expect(seen?.models.map(model => model.id)).toEqual(['model-0']);
  expect(seen?.missing).toBe(1);
});

it('reads a catalog snapshot once when the catalog cannot be read by ID', async () => {
  const full = vi.fn(async () => models);
  render(<CatalogModelsProvider store={new CatalogModelStore(full as CatalogLoader)}><Titles ids={['model-4']}/><Titles ids={['model-5']}/></CatalogModelsProvider>);
  expect(await screen.findByText('Model 4')).toBeTruthy();
  expect(screen.getByText('Model 5')).toBeTruthy();
  expect(full).toHaveBeenCalledTimes(1);
});

it('reads models again after the catalog changes', async () => {
  const { full, byIds } = loader();
  const store = new CatalogModelStore(Object.assign(full, { byIds }) as CatalogLoader);
  render(<CatalogModelsProvider store={store}><Titles ids={['model-7']}/></CatalogModelsProvider>);
  expect(await screen.findByText('Model 7')).toBeTruthy();
  act(() => { window.dispatchEvent(new Event('commons:catalog-changed')); });
  await waitFor(() => expect(byIds).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('Model 7')).toBeTruthy();
});

it('reports a failed read and retries only when asked', async () => {
  const byIds = vi.fn().mockRejectedValueOnce(new Error('Try later')).mockImplementation(async (ids: string[]) => models.filter(model => ids.includes(model.id)));
  const store = new CatalogModelStore(Object.assign(vi.fn(), { byIds }) as CatalogLoader);
  let seen: ReturnType<typeof useCatalogModels> | undefined;
  function Probe() { seen = useCatalogModels(['model-9']); return null; }
  render(<CatalogModelsProvider store={store}><Probe/></CatalogModelsProvider>);
  await waitFor(() => expect(seen?.error).toBe('Try later'));
  expect(byIds).toHaveBeenCalledTimes(1);
  act(() => seen!.retry());
  await waitFor(() => expect(seen?.models.map(model => model.id)).toEqual(['model-9']));
  expect(byIds).toHaveBeenCalledTimes(2);
});
