// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { DocumentLoading as Loading } from '../documentLoading';
import { DocumentLoading } from './DocumentLoading';

afterEach(cleanup);

it('shows the file, stage and indeterminate progress, and restores the cursor on success', async () => {
  const loading = new Loading(async () => {});
  render(<DocumentLoading loading={loading} />);
  let finish!: () => void;
  let operation!: Promise<void>;
  await act(async () => { operation = loading.run('Garage.pf', 'Downloading file…', () => new Promise<void>(resolve => { finish = resolve; })); });
  expect(screen.getByRole('status').textContent).toContain('Opening Garage.pf');
  expect(screen.getByRole('status').textContent).toContain('Downloading file…');
  expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false);
  expect(document.documentElement.classList.contains('pf-document-loading')).toBe(true);
  await act(async () => { finish(); await operation; });
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(document.documentElement.classList.contains('pf-document-loading')).toBe(false);
});

it('clears its busy cursor when its account workspace unmounts during a pending open', async () => {
  const loading = new Loading(async () => {});
  const view = render(<DocumentLoading loading={loading} />);
  let finish!: () => void;
  let operation!: Promise<void>;
  await act(async () => { operation = loading.run('Garage.pf', 'Downloading file…', () => new Promise<void>(resolve => { finish = resolve; })); });
  view.unmount();
  expect(document.documentElement.classList.contains('pf-document-loading')).toBe(false);
  finish(); await operation;
});
