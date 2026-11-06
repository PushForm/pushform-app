// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './App';
import { exampleModel } from './catalog.fixture';

let notify: ((bottom: number, intersecting: boolean) => void) | undefined;
const disconnect = vi.fn();
beforeEach(() => {
  notify = undefined; disconnect.mockClear(); window.history.replaceState(null, '', '/');
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(element: Element) {
      if (element.classList.contains('browse-filter-marker')) notify = (bottom, isIntersecting) => this.callback([{ isIntersecting, boundingClientRect: { bottom } } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    disconnect = disconnect;
    unobserve() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const scroll = (bottom: number, intersecting: boolean) => act(() => { notify?.(bottom, intersecting); });

it('slides the existing site links into view after passing the filters without duplicating search controls', async () => {
  render(<App loadCatalog={async () => [exampleModel()]} />);
  await screen.findByRole('link', { name: 'View Workshop hinge' });
  const footer = screen.getByRole('contentinfo');
  scroll(1000, false);
  expect(footer.parentElement!.classList.contains('is-floating')).toBe(false);
  scroll(20, true);
  expect(footer.parentElement!.classList.contains('is-floating')).toBe(false);
  scroll(-1, false);
  expect(footer.parentElement!.classList.contains('is-visible')).toBe(true);
  for (const name of ['PushForm', 'Terms', 'Privacy']) expect(within(footer).getByRole('link', { name })).toBeTruthy();
  expect(within(footer).queryByRole('searchbox')).toBeNull();
  expect(screen.getAllByRole('searchbox')).toHaveLength(1);
  expect(screen.getAllByRole('contentinfo')).toEqual([footer]);
  scroll(100, true);
  expect(footer.parentElement!.classList.contains('is-visible')).toBe(false);
  await waitFor(() => expect(footer.parentElement!.classList.contains('is-floating')).toBe(false));
});

it('preserves the same focused search input and filters as the footer opens and closes', async () => {
  render(<App loadCatalog={async () => [exampleModel()]} />);
  await screen.findByRole('link', { name: 'View Workshop hinge' });
  const search = screen.getByRole('searchbox') as HTMLInputElement;
  fireEvent.change(search, { target: { value: 'hinge' } });
  search.focus(); search.setSelectionRange(2, 4);
  scroll(-1, false);
  expect(document.activeElement).toBe(search); expect(search.selectionStart).toBe(2); expect(search.selectionEnd).toBe(4);
  scroll(40, true);
  expect(document.activeElement).toBe(search); expect(search.value).toBe('hinge');
  expect(screen.getByRole('link', { name: 'View Workshop hinge' })).toBeTruthy();
});

it('restores the natural footer position when leaving browse for a model page', async () => {
  render(<App loadCatalog={async () => [exampleModel()]} />);
  await screen.findByRole('link', { name: 'View Workshop hinge' });
  scroll(-1, false);
  window.history.replaceState(null, '', '/#models/workshop-hinge');
  fireEvent(window, new Event('hashchange'));
  await screen.findByRole('heading', { level: 1, name: 'Workshop hinge' });
  expect(disconnect).toHaveBeenCalled();
  await waitFor(() => expect(document.querySelector('.site-footer-shell.is-floating')).toBeNull());
});
