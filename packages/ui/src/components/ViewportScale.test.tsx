// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import type { ScaleTool } from '@pushform/commands';
import { meshBounds, type Id, type Vec3 } from '@pushform/core';
import { worldToScreen } from '../../../commands/src/tools/impl/transformShared';
import { AppContext } from '../AppContext';
import { createApp, type AppInstance } from '../bootstrap';
import { useGlobalKeys } from '../useGlobalKeys';
import { useAppStore } from '../store';
import { ViewportView } from './ViewportView';

const SIZE = { width: 800, height: 600 };
const CAMERA = { eye: [10, -10, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 35, projection: 'parallel', orthoHeight: 6 } as const;
let app: AppInstance | null = null;
afterEach(() => { cleanup(); app?.dispose(); app = null; useAppStore.getState().clearEntry(); vi.restoreAllMocks(); });

function Input({ instance }: { instance: AppInstance }) {
  useGlobalKeys(instance);
  return <AppContext.Provider value={instance}><ViewportView /></AppContext.Provider>;
}

function mount(max: Vec3 = [1, 1, 1]) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const a = app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
  // Keep the real camera, inference, input adapter and controls; only omit the WebGL canvas.
  vi.spyOn(a.viewport, 'mount').mockImplementation(() => {});
  vi.spyOn(a.viewport, 'unmount').mockImplementation(() => {});
  const overlay = vi.spyOn(a.viewport, 'setOverlay');
  a.viewport.camera.setSize(SIZE.width, SIZE.height);
  a.viewport.camera.setState(CAMERA);
  vi.spyOn(a.viewport, 'project').mockImplementation((p) => worldToScreen(CAMERA, SIZE, p)!);
  vi.spyOn(a.viewport, 'pixelSizeAlong').mockReturnValue(() => 0.01);
  a.document.edit('Units', (draft) => { draft.meta.units.format = 'decimal'; draft.meta.units.lengthUnit = 'm'; });
  const id = a.commands.execute('model.addBox', { min: [0, 0, 0], max }) as Id;
  a.document.selection.set([{ kind: 'body', path: [], id }]);
  render(<Input instance={a} />);
  const view = screen.getByLabelText('3D viewport');
  Object.assign(view, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
  act(() => a.toolManager.activate('scale'));
  const tool = a.toolManager.get('scale') as ScaleTool;
  const point = (p: Vec3, buttons = 0, modifiers: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean } = {}) => {
    const at = worldToScreen(CAMERA, SIZE, p)!;
    return { clientX: at[0], clientY: at[1], button: 0, buttons, pointerId: 1, ...modifiers };
  };
  const body = () => a.document.doc.rootDefinition.entities.bodies.get(id)!;
  const size = () => { const b = meshBounds(body().mesh); return b.max.map((v, i) => +(v - b.min[i]!).toFixed(6)); };
  const corner = () => tool.scaleBox!.grips.find((g) => g.kind === 'corner' && g.pos.every((v, i) => v === max[i]))!;
  const finish = async () => { await act(async () => { await tool.settled; }); };
  return { a, view, id, tool, point, body, size, corner, finish, overlay };
}

it.each(['drag', 'clicks'] as const)('previews and commits Scale with real %s pointer events', async (gesture) => {
  const { a, view, tool, point, corner, size, finish, overlay } = mount();
  expect(screen.queryByRole('toolbar', { name: 'Scale options' })).toBeNull();
  const grip = corner();
  const before = a.document.doc.state, entries = a.document.undoStack.length;
  fireEvent.pointerDown(view, point(grip.pos, 1));
  if (gesture === 'clicks') fireEvent.pointerUp(view, point(grip.pos));
  fireEvent.pointerMove(view, point([2, 2, 2], gesture === 'drag' ? 1 : 0));
  expect(tool.dragFactors?.map((f) => +f.toFixed(6))).toEqual([2, 2, 2]);
  expect((screen.getByRole('textbox', { name: 'Scale' }) as HTMLInputElement).value).toBe('2.00');
  expect(a.document.doc.state).toBe(before);
  expect(tool.overlay().some((p) => p.kind === 'polyline' && p.points.some((v) => v[0] > 1.9))).toBe(true);
  if (gesture === 'drag') fireEvent.pointerUp(view, point([2, 2, 2]));
  else fireEvent.pointerDown(view, point([2, 2, 2], 1));
  await finish();
  expect(size()).toEqual([2, 2, 2]);
  // Verify the overlay actually sent to the renderer after the asynchronous kernel commit.
  expect(overlay.mock.calls.at(-1)![0].some((p) => p.kind === 'point' && p.size === 7 && p.position.every((v) => Math.abs(v - 2) < 1e-6))).toBe(true);
  expect(a.document.undoStack.length).toBe(entries + 1);
  act(() => { a.document.undo(); });
  expect(size()).toEqual([1, 1, 1]);
  expect(overlay.mock.calls.at(-1)![0].some((p) => p.kind === 'point' && p.size === 7 && p.position.every((v) => Math.abs(v - 1) < 1e-6))).toBe(true);
  act(() => { a.document.redo(); });
  expect(size()).toEqual([2, 2, 2]);
  expect(overlay.mock.calls.at(-1)![0].some((p) => p.kind === 'point' && p.size === 7 && p.position.every((v) => Math.abs(v - 2) < 1e-6))).toBe(true);
});

it('holds a typed uniform size with Tab, commits the held preview with Enter and adjusts the last size', async () => {
  const { a, view, point, corner, size, finish, tool } = mount([2, 1, 1]);
  fireEvent.pointerDown(view, point(corner().pos, 1));
  fireEvent.pointerUp(view, point(corner().pos));
  const entries = a.document.undoStack.length;
  const x = screen.getByRole('textbox', { name: 'Size X' });
  fireEvent.change(x, { target: { value: '6 m' } });
  fireEvent.keyDown(x, { key: 'Tab' });
  expect(x.classList.contains('is-locked')).toBe(true);
  fireEvent.pointerMove(view, point([10, 10, 10]));
  expect(tool.dragFactors).toEqual([3, 3, 3]);
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Size Y' }), { key: 'Enter' });
  await finish();
  expect(size()).toEqual([6, 3, 3]);
  const z = screen.getByRole('textbox', { name: 'Size Z' });
  fireEvent.change(z, { target: { value: '4 m' } });
  fireEvent.keyDown(z, { key: 'Enter' });
  await finish();
  expect(size()).toEqual([8, 4, 4]);
  expect(a.document.undoStack.length).toBe(entries + 1);
});

it('holds independent sizes with a free grip while the pointer changes the remaining axis', async () => {
  const { view, point, size, finish, tool } = mount();
  const grip = tool.scaleBox!.grips.find((g) => g.kind === 'face' && g.pos[0] === 1)!;
  fireEvent.pointerDown(view, point(grip.pos, 1));
  fireEvent.pointerUp(view, point(grip.pos));
  for (const [name, value] of [['Size Y', '3 m'], ['Size Z', '4 m']]) {
    const input = screen.getByRole('textbox', { name: name! });
    fireEvent.change(input, { target: { value } }); fireEvent.keyDown(input, { key: 'Tab' });
  }
  fireEvent.pointerMove(view, point([2, 0.5, 0.5]));
  expect(tool.dragFactors?.map((f) => +f.toFixed(6))).toEqual([2, 3, 4]);
  fireEvent.pointerDown(view, point([2, 0.5, 0.5], 1));
  await finish();
  expect(size()).toEqual([2, 3, 4]);
});

it('updates the preview immediately for held Alt and Shift and honors modifiers on release', async () => {
  const { a, view, point, tool, body, finish } = mount();
  const grip = tool.scaleBox!.grips.find((g) => g.kind === 'face' && g.pos[0] === 1)!;
  fireEvent.pointerDown(view, point(grip.pos, 1));
  fireEvent.pointerMove(view, point([2, 0.5, 0.5], 1));
  const before = a.document.doc.state;
  fireEvent.keyDown(view, { key: 'Alt', code: 'AltLeft', altKey: true });
  expect(tool.dragFactors?.map((f) => +f.toFixed(6))).toEqual([3, 1, 1]);
  fireEvent.keyDown(view, { key: 'Shift', code: 'ShiftLeft', altKey: true, shiftKey: true });
  expect(tool.dragFactors?.map((f) => +f.toFixed(6))).toEqual([3, 3, 3]);
  expect(a.document.doc.state).toBe(before);
  fireEvent.pointerUp(view, point([2, 0.5, 0.5], 0, { altKey: true, shiftKey: true }));
  await finish();
  const bounds = meshBounds(body().mesh);
  expect(bounds.min.map((v) => +v.toFixed(6))).toEqual([-1, -1, -1]);
  expect(bounds.max.map((v) => +v.toFixed(6))).toEqual([2, 2, 2]);
});

it('honors a modifier first seen on release at the same pointer position', async () => {
  const { view, point, tool, body, finish } = mount();
  const grip = tool.scaleBox!.grips.find((g) => g.kind === 'face' && g.pos[0] === 1)!;
  fireEvent.pointerDown(view, point(grip.pos, 1));
  fireEvent.pointerMove(view, point([2, 0.5, 0.5], 1));
  fireEvent.pointerUp(view, point([2, 0.5, 0.5], 0, { altKey: true }));
  await finish();
  expect(meshBounds(body().mesh).min[0]).toBeCloseTo(-1);
  expect(meshBounds(body().mesh).max[0]).toBeCloseTo(2);
});

it.each(['Escape', 'pointercancel'] as const)('discards a resize on %s', (event) => {
  const { a, view, point, corner, tool } = mount();
  const before = a.document.doc.state;
  fireEvent.pointerDown(view, point(corner().pos, 1));
  fireEvent.pointerMove(view, point([2, 2, 2], 1));
  if (event === 'Escape') fireEvent.keyDown(view, { key: 'Escape', code: 'Escape' });
  else fireEvent.pointerCancel(view, point([2, 2, 2]));
  fireEvent.pointerUp(view, point([2, 2, 2]));
  expect(tool.hasPendingWork()).toBe(false);
  expect(a.document.doc.state).toBe(before);
});

it('rejects malformed and zero sizes without ending the resize', () => {
  const { a, view, point, corner, tool } = mount();
  const before = a.document.doc.state;
  fireEvent.pointerDown(view, point(corner().pos, 1));
  fireEvent.pointerUp(view, point(corner().pos));
  const x = screen.getByRole('textbox', { name: 'Size X' });
  fireEvent.change(x, { target: { value: 'broken' } }); fireEvent.keyDown(x, { key: 'Enter' });
  expect(x.getAttribute('aria-invalid')).toBe('true');
  fireEvent.change(x, { target: { value: '0 m' } }); fireEvent.keyDown(x, { key: 'Enter' });
  expect(tool.hasPendingWork()).toBe(true);
  expect(tool.status().instructor).toContain('nonzero');
  expect(a.document.doc.state).toBe(before);
});

it('momentary modifier buttons hold only while pressed and also reflect the physical keys', () => {
  const { a, view, point, tool } = mount();
  const grip = tool.scaleBox!.grips.find((g) => g.kind === 'face' && g.pos[0] === 1)!;
  fireEvent.pointerDown(view, point(grip.pos, 1));
  fireEvent.pointerUp(view, point(grip.pos));
  fireEvent.pointerMove(view, point([2, 0.5, 0.5]));
  const before = a.document.doc.state;
  const center = screen.getByRole('button', { name: /About center/ });
  fireEvent.pointerDown(center, { button: 0 });
  expect(center.getAttribute('aria-pressed')).toBe('true');
  expect(tool.dragFactors?.map((f) => +f.toFixed(6))).toEqual([3, 1, 1]);
  fireEvent.pointerUp(window);
  expect(center.getAttribute('aria-pressed')).toBe('false');
  expect(tool.dragFactors?.map((f) => +f.toFixed(6))).toEqual([2, 1, 1]);
  // Releasing the button must not release a physical modifier still held down.
  fireEvent.keyDown(view, { key: 'Alt', code: 'AltLeft', altKey: true });
  fireEvent.pointerDown(center, { button: 0 }); fireEvent.pointerUp(window);
  expect(center.getAttribute('aria-pressed')).toBe('true');
  fireEvent.keyUp(view, { key: 'Alt', code: 'AltLeft' });
  expect(center.getAttribute('aria-pressed')).toBe('false');
  const uniform = screen.getByRole('button', { name: /Keep proportions/ });
  fireEvent.keyDown(uniform, { key: ' ', code: 'Space' });
  expect(tool.dragFactors?.map((f) => +f.toFixed(6))).toEqual([2, 2, 2]);
  fireEvent.keyUp(uniform, { key: ' ', code: 'Space' });
  expect(tool.dragFactors?.map((f) => +f.toFixed(6))).toEqual([2, 1, 1]);
  for (const event of ['pointercancel', 'blur']) {
    fireEvent.pointerDown(center, { button: 0 });
    fireEvent(window, new Event(event));
    expect(center.getAttribute('aria-pressed')).toBe('false');
  }
  expect(a.document.doc.state).toBe(before);
});
