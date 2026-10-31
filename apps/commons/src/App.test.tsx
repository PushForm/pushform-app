// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { exampleModel } from './catalog.fixture';
import type { CatalogLoader, CatalogModel } from './catalog';

beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(cleanup);
it('makes unavailable configuration and an empty published catalog distinct', async () => {
  const view = render(<App loadCatalog={null} />);
  expect(screen.getByRole('status').textContent).toContain('isn’t available yet');
  expect(screen.queryByText('0 models')).toBeNull();
  view.rerender(<App loadCatalog={async () => []} />);
  expect(await screen.findByText('The library is ready for its first models.')).toBeTruthy();
});
it('searches and combines filters, clears them and shows source attribution on cards', async () => {
  const first = exampleModel();
  const second = exampleModel({ id: 'garden-bench', title: 'Garden bench', category: 'Furniture', licenses: [{ ...first.licenses[0]!, name: 'Personal use', commercialUse: 'restricted' }] });
  render(<App loadCatalog={async () => [first, second]} />);
  await screen.findByRole('link', { name: 'View Workshop hinge' });
  expect(screen.getAllByText('From Example Library')).toHaveLength(2);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Commercial use permitted' }));
  expect(screen.queryByRole('link', { name: 'View Garden bench' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Furniture' } });
  expect(screen.getByText('No models match those filters.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(screen.getByRole('link', { name: 'View Garden bench' })).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'hinge' } });
  expect(screen.queryByRole('link', { name: 'View Garden bench' })).toBeNull();
});
it('opens a direct model link with original license notices and creator credits', async () => {
  window.history.replaceState(null, '', '/#models/workshop-hinge');
  render(<App loadCatalog={async () => [exampleModel()]} />);
  expect(await screen.findByRole('heading', { level: 1, name: 'Workshop hinge' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Attribution 3.0 ↗' }).getAttribute('href')).toBe('https://example.com/license');
  expect(screen.getByText('Credit Example Maker.')).toBeTruthy();
  expect(screen.getByText('Original model by Example Maker.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Example Library ↗' }).getAttribute('href')).toBe('https://example.com/model');
  window.history.replaceState(null, '', '/#browse'); fireEvent(window, new Event('hashchange'));
  expect(await screen.findByRole('heading', { name: 'Browse models' })).toBeTruthy();
});
it('shows an unavailable model instead of substituting another catalog item', async () => {
  window.history.replaceState(null, '', '/#models/removed-model');
  render(<App loadCatalog={async () => [exampleModel()]} />);
  expect(await screen.findByText('This model isn’t in the catalog.')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Workshop hinge' })).toBeNull();
});
it('retries a failed request and ignores an obsolete request after a loader change', async () => {
  const loader = vi.fn<CatalogLoader>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
  const view = render(<App loadCatalog={loader} />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('The library is ready for its first models.')).toBeTruthy();
  let resolveOld!: (models: CatalogModel[]) => void;
  const old: CatalogLoader = () => new Promise((resolve) => { resolveOld = resolve; });
  view.rerender(<App loadCatalog={old} />);
  await screen.findByText('Loading models…');
  view.rerender(<App loadCatalog={async () => []} />);
  await screen.findByText('The library is ready for its first models.');
  resolveOld([exampleModel()]);
  await waitFor(() => expect(screen.queryByRole('link', { name: 'View Workshop hinge' })).toBeNull());
});

it('replaces a broken preview with a labeled fallback', async () => {
  render(<App loadCatalog={async () => [exampleModel({ imageUrl: 'https://example.com/missing.jpg' })]} />);
  const image = await screen.findByRole('img', { name: 'Workshop hinge' });
  fireEvent.error(image);
  expect(screen.getByText('No preview image')).toBeTruthy();
  expect(screen.queryByRole('img', { name: 'Workshop hinge' })).toBeNull();
});

it('shows a disabled server catalog as unavailable rather than an empty catalog or generic failure', async () => {
  const { CommonsUnavailableError } = await import('@pushform/cloud');
  render(<App loadCatalog={async () => {throw new CommonsUnavailableError();}} />);
  await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('isn’t available yet'));
  expect(screen.queryByRole('alert')).toBeNull();
});
