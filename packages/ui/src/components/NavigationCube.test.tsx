// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { v3normalize, v3sub } from '@pushform/core';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { useAppStore } from '../store';
import { NavigationCube } from './NavigationCube';
import { DisplayPanel } from '../panels/DisplayPanel';

let app: AppInstance;
beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().setNavigationCube(true);
  app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
});
afterEach(() => {
  cleanup();
  app.dispose();
});

const mount = () => render(<AppContext.Provider value={app}><NavigationCube /></AppContext.Provider>);
const dir = () => { const s = app.viewport.camera.getState(); return v3normalize(v3sub(s.target, s.eye)); };

it('turns the camera to a clicked face, edge or corner and records the move for Previous', () => {
  mount();
  const before = app.viewport.camera.getState();
  fireEvent.click(screen.getByRole('button', { name: 'Front' }));
  expect(dir().map((x) => Math.round(x * 1e6) / 1e6)).toEqual([0, 1, 0]);
  expect(app.viewport.camera.getState().target).toEqual(before.target);
  // The picture follows the camera: straight on, only the Front face and its regions are drawn.
  expect(screen.getAllByRole('button').filter((b) => !b.getAttribute('aria-label')?.startsWith('Turn'))).toHaveLength(9);
  expect(screen.queryByRole('button', { name: 'Top' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Front Right Top' }));
  const d = dir();
  expect(d[0]).toBeCloseTo(-1 / Math.sqrt(3), 6);
  expect(d[2]).toBeCloseTo(-1 / Math.sqrt(3), 6);
  expect(app.commands.tryExecute('camera.previous').ok).toBe(true);
  expect(dir().map((x) => Math.round(x * 1e6) / 1e6)).toEqual([0, 1, 0]);
});

it('turns 45° from the arrows', () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Front' }));
  fireEvent.click(screen.getByRole('button', { name: 'Turn left' }));
  const d = dir();
  expect(d[2]).toBeCloseTo(0, 9);
  expect(Math.abs(Math.atan2(d[0], d[1]))).toBeCloseTo(Math.PI / 4, 6);
  fireEvent.click(screen.getByRole('button', { name: 'Turn up' }));
  expect(Math.asin(dir()[2])).toBeCloseTo(Math.PI / 4, 6);
});

it('orbits the model while the cube is dragged and does not then activate the region', async () => {
  mount();
  const camera = app.viewport.camera;
  const orbitStart = vi.spyOn(camera, 'orbitStart');
  const orbitEnd = vi.spyOn(camera, 'orbitEnd');
  const before = camera.getState();
  const front = screen.getByRole('button', { name: 'Front' });
  fireEvent.pointerDown(front, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 101, clientY: 101 });
  expect(orbitStart).not.toHaveBeenCalled();
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 140, clientY: 100 });
  expect(orbitStart).toHaveBeenCalledWith([100, 100], { pivot: camera.defaultPivot() });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 140, clientY: 100 });
  expect(orbitEnd).toHaveBeenCalledTimes(1);
  fireEvent.click(front);
  const after = camera.getState();
  expect(after.eye).not.toEqual(before.eye);
  // Still an orbit of the start view, not a snap to Front.
  expect(Math.abs(dir()[0])).toBeGreaterThan(0.01);
  await act(async () => { await new Promise((r) => setTimeout(r, 1)); });
});

it('is hidden by View › Navigation Cube and the Display panel box, and the choice is remembered', () => {
  render(<AppContext.Provider value={app}><NavigationCube /><DisplayPanel /></AppContext.Provider>);
  expect(screen.getByTestId('nav-cube')).toBeTruthy();
  act(() => { expect(app.commands.tryExecute('view.navigationCube')).toMatchObject({ ok: true, result: false }); });
  expect(screen.queryByTestId('nav-cube')).toBeNull();
  expect(localStorage.getItem('pushform:navigationCube')).toBe('hidden');
  const box = screen.getByLabelText('Navigation Cube') as HTMLInputElement;
  expect(box.checked).toBe(false);
  fireEvent.click(box);
  expect(screen.getByTestId('nav-cube')).toBeTruthy();
  expect(localStorage.getItem('pushform:navigationCube')).toBeNull();
});
