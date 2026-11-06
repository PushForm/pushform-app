// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createApp } from '../bootstrap';
import { KernelClient, InlineBackend } from '@pushform/kernel';
import { AppContext } from '../AppContext';
import { StylesPanel } from './StylesPanel';
import { freeInference, GROUND_PLANE } from '@pushform/inference';
import type { ToolPointerEvent } from '@pushform/commands';
import type { Vec3 } from '@pushform/core';
afterEach(cleanup);
it('previews environments without editing the model until Update style, and saves a separate named style', () => {
  const app = createApp({
    demo: false,
    expose: false,
    kernel: new KernelClient(new InlineBackend()),
  });
  render(
    <AppContext.Provider value={app}>
      <StylesPanel environment />
    </AppContext.Provider>,
  );
  const before = app.document.doc.state.activeStyleId;
  fireEvent.change(screen.getByLabelText('Environment preset'), { target: { value: 'night' } });
  expect(app.document.doc.state.styles.get(before)?.environment?.preset).toBe('bright');
  expect(app.viewport.environmentLighting.settings?.preset).toBe('night');
  fireEvent.click(screen.getByRole('button', { name: 'Update style' }));
  expect(app.document.doc.state.styles.get(before)?.environment?.preset).toBe('night');
  fireEvent.change(screen.getByLabelText('Environment preset'), { target: { value: 'soft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save as…' }));
  fireEvent.change(screen.getByLabelText('New style name'), { target: { value: 'Soft workshop' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save style' }));
  const state = app.document.doc.state;
  expect(state.activeStyleId).not.toBe(before);
  expect(state.styles.get(before)?.environment?.preset).toBe('night');
  expect(state.styles.get(state.activeStyleId)?.name).toBe('Soft workshop');
  app.dispose();
});

it('places a point in one click, aims a spot in two clicks, and cancels without editing the model', () => {
  const app = createApp({
    demo: false,
    expose: false,
    kernel: new KernelClient(new InlineBackend()),
  });
  const at = (point: Vec3): ToolPointerEvent => ({
    screen: [100, 100],
    ray: { origin: [0, 0, 10], dir: [0, 0, -1] },
    button: 0,
    buttons: 1,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    inference: freeInference(point, GROUND_PLANE),
    camera: app.viewport.camera.getState(),
  });
  app.commands.execute('light.place', { type: 'point', name: 'Lamp' });
  app.toolManager.pointerDown(at([1, 2, 3]));
  expect(app.document.doc.state.sceneLights).toHaveLength(1);
  expect(app.document.doc.state.sceneLights?.[0]?.position).toEqual([1, 2, 3]);
  expect(app.toolManager.activeToolId).toBe('select');
  app.commands.execute('light.place', { type: 'spot', name: 'Spot' });
  app.toolManager.pointerDown(at([3, 2, 1]));
  expect(app.document.doc.state.sceneLights).toHaveLength(1);
  app.toolManager.cancel();
  expect(app.document.doc.state.sceneLights).toHaveLength(1);
  app.toolManager.pointerDown(at([3, 2, 1]));
  app.toolManager.pointerDown(at([0, 0, 0]));
  expect(app.document.doc.state.sceneLights?.[1]).toMatchObject({
    position: [3, 2, 1],
    target: [0, 0, 0],
    type: 'spot',
  });
  app.document.undo();
  expect(app.document.doc.state.sceneLights).toHaveLength(1);
  app.dispose();
});
