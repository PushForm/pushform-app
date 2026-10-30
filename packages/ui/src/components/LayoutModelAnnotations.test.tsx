// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createDocument, ImageStore } from '@pushform/model';
import type { Id } from '@pushform/core';
import { formatLinearDimension } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import type { LayoutViewportModel } from './layoutViewportRenders';
import type * as ViewportRenders from './layoutViewportRenders';

const loaded = vi.hoisted(() => ({ model: undefined as LayoutViewportModel | undefined }));
vi.mock('./layoutViewportRenders', async importOriginal => ({
  ...await importOriginal<typeof ViewportRenders>(),
  layoutViewportModel: async () => loaded.model!,
  peekLayoutViewportModel: () => loaded.model,
}));
afterEach(() => { cleanup(); loaded.model = undefined; vi.restoreAllMocks(); });

function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const model = createDocument();
  model.transact('Edge', state => {
    const sketch = state.definitions.get(state.rootDefinitionId)!.entities.sketch;
    sketch.vertices.set(100 as Id, { id: 100 as Id, p: [0, 0, 0] });
    sketch.vertices.set(101 as Id, { id: 101 as Id, p: [2, 0, 0] });
    sketch.edges.set(102 as Id, { id: 102 as Id, a: 100 as Id, b: 101 as Id, soft: false, smooth: false,
      curveId: null, hidden: false, locked: false, tagId: state.defaultTagId, castShadows: true, receiveShadows: true, attributes: {} });
  });
  loaded.model = { state: model.state, images: new ImageStore(), scenes: [], bounds: null, bodies: [], pictures: [],
    display: {} as LayoutViewportModel['display'], sketches: [{ id: '', path: [], version: 1, faces: [],
      edges: [{ id: 102, a: [0, 0, 0], b: [2, 0, 0], soft: false, smooth: false, hidden: false }] }] };
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.doc.undoStack.transact('View', state => {
    const id = state.meta.nextId++, page = state.pages.get(pageId)!;
    page.entities.set(id, { id, kind: 'image', layerId: state.activeLayerId, closed: true,
      points: [[0, 0], [100, 0], [100, 100], [0, 100]], image: { src: '', viewport: {
        source: { referenceId: 7 }, templateId: null, originalId: null, scene: null, background: null, cache: null,
        camera: { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], projection: 'parallel', scale: 0.02, fov: 30 },
      } } });
    page.entityOrder.push(id);
  });
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  const entities = () => [...tab.doc.state.pages.get(pageId)!.entities.values()];
  return { tab, click, entities, dispose: () => { session.dispose(); app.dispose(); } };
}

it('snaps model vertices and creates a scaled model dimension in one undo step', async () => {
  const { tab, click, entities, dispose } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Linear Dimension' }));
  await act(async () => {});
  click(50.5, 50.5); click(89.5, 50.5); click(70, 65);
  const dim = entities().find(e => e.dimension)!;
  expect(dim.modelAnnotation?.status).toBe('resolved');
  expect(dim.points.slice(0, 2)).toEqual([[50, 50], [90, 50]]);
  expect(formatLinearDimension(dim.dimension!)).toBe('2000.0 mm');
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entities().some(e => e.dimension)).toBe(false);
  dispose();
});

it('attaches a label tip to model geometry without creating a paper anchor', async () => {
  const { click, entities, dispose } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Label' }));
  await act(async () => {});
  click(50.5, 50.5); click(65, 65); click(85, 65);
  const label = entities().find(e => e.kind === 'label')!;
  expect(label.modelAnnotation?.attachments[0]?.anchor).toMatchObject({ kind: 'sketchVertex', id: 100 });
  expect(label.labelAnchor).toBeUndefined();
  expect(label.points[2]).toEqual([50, 50]);
  fireEvent.change(screen.getByLabelText('Auto-text field'), { target: { value: 'Coordinates(x)' } });
  expect(screen.getByText(/From the connected model:/)).toBeTruthy();
  expect(screen.queryByLabelText('Auto-text field value')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Insert auto-text' }));
  expect(entities().find(e => e.kind === 'label')!.text!.content).toBe('<Coordinates(x)>');
  dispose();
});

it('reconnects both dimension endpoints atomically and can undo an explicit disconnect', async () => {
  const { tab, click, entities, dispose } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Linear Dimension' }));
  await act(async () => {});
  click(50, 50); click(90, 50); click(70, 65);
  const dimension = () => entities().find(e => e.dimension)!;
  const original = dimension();
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect to model' }));
  click(90, 50);
  expect(dimension()).toBe(original);
  click(50, 50);
  expect(dimension().modelAnnotation!.attachments.map(a => a.anchor)).toMatchObject([
    { kind: 'sketchVertex', id: 101 }, { kind: 'sketchVertex', id: 100 },
  ]);
  expect(formatLinearDimension(dimension().dimension!)).toBe('2000.0 mm');
  act(() => { tab.commands.execute('edit.undo'); });
  expect(dimension().modelAnnotation).toEqual(original.modelAnnotation);
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect from model' }));
  expect(dimension().modelAnnotation).toBeUndefined();
  expect(formatLinearDimension(dimension().dimension!)).toBe('2000.0 mm');
  expect((screen.getByLabelText('Dimension scale') as HTMLSelectElement).disabled).toBe(false);
  act(() => { tab.commands.execute('edit.undo'); });
  expect(dimension().modelAnnotation).toEqual(original.modelAnnotation);
  dispose();
});

it('cancels a partial reconnection with Escape without editing or creating an annotation', async () => {
  const { click, entities, dispose } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Linear Dimension' }));
  await act(async () => {});
  click(50, 50); click(90, 50); click(70, 65);
  const original = entities().find(e => e.dimension)!;
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect to model' }));
  click(90, 50);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(entities().filter(e => e.dimension)).toEqual([original]);
  expect(screen.getByText('Connected to model geometry')).toBeTruthy();
  dispose();
});

it('does not turn a click on an unloaded model into a paper measurement', async () => {
  const { click, entities, dispose } = setup();
  const model = loaded.model;
  loaded.model = undefined;
  fireEvent.click(screen.getByRole('button', { name: 'Linear Dimension' }));
  await act(async () => {});
  click(50, 50); click(90, 50); click(70, 65);
  expect(entities().some(e => e.dimension)).toBe(false);
  expect(screen.getByText('Model geometry is unavailable. Wait for the model to load before measuring.')).toBeTruthy();
  loaded.model = model;
  click(50, 50); click(90, 50); click(70, 65);
  expect(entities().find(e => e.dimension)?.modelAnnotation?.status).toBe('resolved');
  dispose();
});
