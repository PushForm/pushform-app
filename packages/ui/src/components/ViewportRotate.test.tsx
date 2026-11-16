// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import type { RotateTool } from '@pushform/commands';
import { meshBounds, type Id, type Vec3 } from '@pushform/core';
import { worldToScreen } from '../../../commands/src/tools/impl/transformShared';
import { AppContext } from '../AppContext';
import { createApp, type AppInstance } from '../bootstrap';
import { useGlobalKeys } from '../useGlobalKeys';
import { useAppStore } from '../store';
import { ViewportView } from './ViewportView';

const SIZE = { width: 800, height: 600 };
const CAMERA = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 35, projection: 'parallel', orthoHeight: 6 } as const;
let app: AppInstance | null = null;
afterEach(() => { cleanup(); app?.dispose(); app = null; useAppStore.getState().clearEntry(); vi.restoreAllMocks(); });

function Input({ instance }: { instance: AppInstance }) {
  useGlobalKeys(instance);
  return <AppContext.Provider value={instance}><ViewportView /></AppContext.Provider>;
}

function mount(max: Vec3 = [2, 1, 1]) {
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
  act(() => a.toolManager.activate('rotate'));
  const tool = a.toolManager.get('rotate') as RotateTool;
  const point = (p: Vec3, buttons = 0, modifiers: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean } = {}) => {
    const at = worldToScreen(CAMERA, SIZE, p)!;
    return { clientX: at[0], clientY: at[1], button: 0, buttons, pointerId: 1, ...modifiers };
  };
  const body = () => a.document.doc.rootDefinition.entities.bodies.get(id)!;
  const size = () => { const b = meshBounds(body().mesh); return b.max.map((v, i) => +(v - b.min[i]!).toFixed(6)); };
  const finish = async () => { await act(async () => { await tool.settled; }); };
  return { a, view, id, tool, point, body, size, finish, overlay };
}


function chooseReference(view: HTMLElement, point: (p: Vec3, buttons?: number) => object) {
  for (const p of [[0, 0, 0], [1, 0, 0]] as const) {
    fireEvent.pointerDown(view, point(p, 1)); fireEvent.pointerUp(view, point(p));
  }
}

it('enables Angle after the reference, shows the signed preview, and adjusts the last turn in one undo step', async () => {
  const { a, view, point, tool, body, finish } = mount();
  const angle = screen.getByRole('textbox', { name: 'Angle' }) as HTMLInputElement;
  expect(angle.disabled).toBe(true);
  const copy = screen.getByRole('button', { name: /Copy/ });
  expect(copy.compareDocumentPosition(angle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  chooseReference(view, point);
  expect(angle.disabled).toBe(false);
  const before = a.document.doc.state, steps = a.document.undoStack.length;
  fireEvent.pointerMove(view, point([0, -1, 0]));
  expect(tool.dragAngleDeg).toBeCloseTo(-90);
  expect(angle.value).toBe('-90.0°');
  expect(a.document.doc.state).toBe(before);
  fireEvent.change(angle, { target: { value: '-90deg' } });
  fireEvent.keyDown(angle, { key: 'Enter' }); await finish();
  expect(meshBounds(body().mesh).min[1]).toBeCloseTo(-2);
  expect(meshBounds(body().mesh).max[0]).toBeCloseTo(1);
  fireEvent.change(angle, { target: { value: '180deg' } });
  fireEvent.keyDown(angle, { key: 'Enter' }); await finish();
  expect(meshBounds(body().mesh).min[0]).toBeCloseTo(-2);
  expect(meshBounds(body().mesh).min[1]).toBeCloseTo(-1);
  expect(a.document.undoStack.length).toBe(steps + 1);
  act(() => { a.document.undo(); });
  expect(meshBounds(body().mesh).max).toEqual([2, 1, 1]);
});

it('holds a typed angle with Tab, commits that preview with Enter, and rejects invalid input', async () => {
  const { a, view, point, tool, body, finish } = mount();
  chooseReference(view, point);
  const angle = screen.getByRole('textbox', { name: 'Angle' });
  const before = a.document.doc.state;
  fireEvent.change(angle, { target: { value: 'broken' } }); fireEvent.keyDown(angle, { key: 'Enter' });
  expect(angle.getAttribute('aria-invalid')).toBe('true');
  expect(a.document.doc.state).toBe(before);
  fireEvent.change(angle, { target: { value: '-45deg' } }); fireEvent.keyDown(angle, { key: 'Tab' });
  expect(angle.classList.contains('is-locked')).toBe(true);
  fireEvent.pointerMove(view, point([0, 2, 0]));
  expect(tool.dragAngleDeg).toBeCloseTo(-45);
  expect(a.document.doc.state).toBe(before);
  fireEvent.keyDown(angle, { key: 'Enter' }); await finish();
  expect(meshBounds(body().mesh).min[1]).toBeCloseTo(-Math.SQRT2);
});

it('previews a reference-point drag and commits exactly its displayed angle on release', async () => {
  const { a, view, point, tool, body, finish } = mount();
  fireEvent.pointerDown(view, point([0, 0, 0], 1)); fireEvent.pointerUp(view, point([0, 0, 0]));
  fireEvent.pointerDown(view, point([1, 0, 0], 1));
  const before = a.document.doc.state;
  fireEvent.pointerMove(view, point([0, -1, 0], 1));
  expect(tool.dragAngleDeg).toBeCloseTo(-90);
  expect(a.document.doc.state).toBe(before);
  fireEvent.pointerUp(view, point([0, -1, 0])); await finish();
  expect(meshBounds(body().mesh).min[1]).toBeCloseTo(-2);
});

it('cancels a pending angle without changing the document', () => {
  const { a, view, point, tool } = mount();
  const before = a.document.doc.state;
  chooseReference(view, point); fireEvent.pointerMove(view, point([0, 1, 0]));
  fireEvent.keyDown(view, { key: 'Escape' });
  expect(tool.hasPendingWork()).toBe(false);
  expect(a.document.doc.state).toBe(before);
  expect((screen.getByRole('textbox', { name: 'Angle' }) as HTMLInputElement).disabled).toBe(true);
});
