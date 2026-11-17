// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { meshBounds, type Id, type Vec3 } from '@pushform/core';
import { AppContext } from '../AppContext';
import { createApp, type AppInstance } from '../bootstrap';
import { ViewportView } from './ViewportView';
import { useGlobalKeys } from '../useGlobalKeys';
import { useAppStore } from '../store';

let app: AppInstance | null = null;
afterEach(() => { cleanup(); app?.dispose(); app = null; useAppStore.getState().clearEntry(); });

function Input({ app: instance }: { app: AppInstance }) {
  useGlobalKeys(instance);
  return <AppContext.Provider value={instance}><ViewportView /></AppContext.Provider>;
}

function mount() {
  const a = app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
  // Render the real event adapter and controls; substitute only the WebGL canvas and camera mapping.
  vi.spyOn(a.viewport, 'mount').mockImplementation(() => {});
  vi.spyOn(a.viewport, 'unmount').mockImplementation(() => {});
  vi.spyOn(a.viewport, 'screenToRay').mockImplementation((x, y) => ({ origin: [x / 100, y / 100, 10], dir: [0, 0, -1] }));
  vi.spyOn(a.viewport, 'pixelSizeAlong').mockReturnValue(() => 0.01);
  vi.spyOn(a.viewport, 'project').mockImplementation((p: Vec3) => [p[0] * 100, p[1] * 100]);
  const id = a.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as Id;
  a.document.selection.set([{ kind: 'body', path: [], id }]);
  render(<Input app={a} />);
  const view = screen.getByLabelText('3D viewport');
  Object.assign(view, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
  act(() => a.toolManager.activate('move'));
  const point = (x: number, y: number, buttons = 0) => ({ clientX: x, clientY: y, button: 0, buttons, pointerId: 1 });
  return { a, id, view, point, body: () => a.document.doc.rootDefinition.entities.bodies.get(id)! };
}

it.each(['drag', 'clicks'] as const)('previews and commits a Move through actual %s pointer events', async (gesture) => {
  const { a, view, point, body } = mount();
  const before = a.document.doc.state;
  const entries = a.document.undoStack.length;
  fireEvent.pointerDown(view, point(50, 50, 1));
  if (gesture === 'clicks') fireEvent.pointerUp(view, point(50, 50));
  fireEvent.pointerMove(view, point(250, 250, gesture === 'drag' ? 1 : 0));
  const distance = screen.getByRole('textbox', { name: 'Distance' }) as HTMLInputElement;
  expect(distance.disabled).toBe(false);
  expect(distance.value).not.toBe('');
  expect((screen.getByRole('textbox', { name: 'ΔX' }) as HTMLInputElement).value).not.toMatch(/^0(?:\.0*)? /);
  expect(a.document.doc.state).toBe(before);
  const preview = a.toolManager.overlay();
  expect(preview.some((p) => p.kind === 'polyline' && p.points.some((v) => v[0] > 2))).toBe(true);
  if (gesture === 'drag') fireEvent.pointerUp(view, point(250, 250));
  else fireEvent.pointerDown(view, point(250, 250, 1));
  await act(async () => { await (a.toolManager.get('move') as unknown as { settled: Promise<void> }).settled; });
  expect(meshBounds(body().mesh).min[0]).toBeCloseTo(2);
  expect(meshBounds(body().mesh).min[1]).toBeCloseTo(2);
  expect(a.document.undoStack.length).toBe(entries + 1);
});

it('cancels a Move on pointer cancellation instead of committing the drag', () => {
  const { a, view, point } = mount();
  const before = a.document.doc.state;
  fireEvent.pointerDown(view, point(50, 50, 1));
  fireEvent.pointerMove(view, point(250, 250, 1));
  fireEvent.pointerCancel(view, point(250, 250));
  expect(a.toolManager.activeTool?.hasPendingWork?.()).toBe(false);
  expect(a.document.doc.state).toBe(before);
});

it('holds an axis rail through drag events across the source and commits its last preview', async () => {
  const { a, view, point, body } = mount();
  fireEvent.pointerDown(view, point(50, 50, 1));
  fireEvent.keyDown(view, { key: 'ArrowRight', code: 'ArrowRight' });
  for (const x of [250, 75, 50, 25, -150]) {
    fireEvent.pointerMove(view, point(x, 90, 1));
    const end = a.toolManager.overlay().filter((p) => p.kind === 'polyline').find((p) => p.kind === 'polyline' && p.points.length === 2 && p.points[0]?.[0] === 0.5 && p.width === 2);
    expect(end?.kind).toBe('polyline');
    if (end?.kind === 'polyline') {
      expect(end.points[1]![0]).toBeCloseTo(x / 100);
      expect(end.points[1]![1]).toBe(0.5);
      expect(end.points[1]![2]).toBe(1);
    }
  }
  fireEvent.pointerUp(view, point(-150, 90));
  await act(async () => { await (a.toolManager.get('move') as unknown as { settled: Promise<void> }).settled; });
  expect(meshBounds(body().mesh).min).toEqual([-2, 0, 0]);
});

it('holds toolbar offsets with Tab, previews the other axes, validates text and commits with Enter', async () => {
  const { a, view, point, body } = mount();
  for (const label of ['Distance', 'ΔX', 'ΔY', 'ΔZ']) expect((screen.getByRole('textbox', { name: label }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.pointerDown(view, point(50, 50, 1));
  fireEvent.pointerUp(view, point(50, 50));
  const x = screen.getByRole('textbox', { name: 'ΔX' });
  fireEvent.focus(x);
  fireEvent.change(x, { target: { value: '3 m' } });
  fireEvent.keyDown(x, { key: 'Tab' });
  expect(x.classList.contains('is-locked')).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'ΔY' }));
  fireEvent.pointerMove(view, point(250, 250));
  const z = screen.getByRole('textbox', { name: 'ΔZ' });
  fireEvent.change(z, { target: { value: 'bad value' } });
  fireEvent.keyDown(z, { key: 'Enter' });
  expect(z.getAttribute('aria-invalid')).toBe('true');
  expect(a.toolManager.activeTool?.hasPendingWork?.()).toBe(true);
  fireEvent.change(z, { target: { value: '4 m' } });
  fireEvent.keyDown(z, { key: 'Enter' });
  await act(async () => { await (a.toolManager.get('move') as unknown as { settled: Promise<void> }).settled; });
  expect(meshBounds(body().mesh).min).toEqual([3, 2, 4]);
});

it('Distance releases a held offset, and Enter can commit an entirely held preview', async () => {
  const { a, view, point, body } = mount();
  fireEvent.pointerDown(view, point(50, 50, 1));
  fireEvent.pointerUp(view, point(50, 50));
  fireEvent.keyDown(view, { key: 'ArrowRight', code: 'ArrowRight' });
  fireEvent.pointerMove(view, point(250, 90));
  const x = screen.getByRole('textbox', { name: 'ΔX' });
  fireEvent.change(x, { target: { value: '3 m' } });
  fireEvent.keyDown(x, { key: 'Tab' });
  const distance = screen.getByRole('textbox', { name: 'Distance' });
  fireEvent.focus(distance);
  fireEvent.change(distance, { target: { value: '5 m' } });
  fireEvent.keyDown(distance, { key: 'Tab' });
  expect(x.classList.contains('is-locked')).toBe(false);
  expect(distance.classList.contains('is-locked')).toBe(true);
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'ΔX' }), { key: 'Enter' });
  await act(async () => { await (a.toolManager.get('move') as unknown as { settled: Promise<void> }).settled; });
  expect(meshBounds(body().mesh).min[0]).toBeCloseTo(5);
});

it('Escape discards a drag even if the mouse is released afterwards', () => {
  const { a, view, point } = mount();
  const before = a.document.doc.state;
  fireEvent.pointerDown(view, point(50, 50, 1));
  fireEvent.pointerMove(view, point(250, 250, 1));
  fireEvent.keyDown(view, { key: 'Escape', code: 'Escape' });
  fireEvent.pointerUp(view, point(250, 250));
  expect(a.toolManager.activeTool?.hasPendingWork?.()).toBe(false);
  expect(a.document.doc.state).toBe(before);
});
