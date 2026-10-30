// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('renders cutouts and page visibility consistently, selects only filled regions, and edits the whole compound path', async () => {
  const fills: { canvas: HTMLCanvasElement; rule: string | undefined; starts: number[][] }[] = [];
  const strokes: { canvas: HTMLCanvasElement; starts: number[][] }[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let starts: number[][] = [];
    const methods = new Map<string | symbol, unknown>([
      ['measureText', () => ({ width: 5 })], ['beginPath', () => { starts = []; }],
      ['moveTo', (x: number, y: number) => { starts.push([x, y]); }],
      ['stroke', () => { strokes.push({ canvas: this, starts: [...starts] }); }],
      ['fill', (rule?: string) => { fills.push({ canvas: this, rule, starts: [...starts] }); }],
    ]);
    return new Proxy({}, { get: (_, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); },
      set: (_, key, value) => { methods.set(key, value); return true; } }) as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 891, height: 630,
    right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}) });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.doc.undoStack.transact('Fixture', draft => {
    const page = draft.pages.get(pageId)!;
    page.entities.set(3, { id: 3, layerId: 1, kind: 'path', closed: true, contourStarts: [0, 4],
      points: [[10, 10], [90, 10], [90, 90], [10, 90], [30, 30], [70, 30], [70, 70], [30, 70]],
      style: { fillColor: '#ff0000', strokeColor: '#000000', strokeWeightPt: 1 } });
    page.entityOrder.push(3); page.layerVisibility = new Map([[4, false]]);
    draft.layers.set(4, { id: 4, name: 'Shared', visible: true, locked: false, shared: true }); draft.layerOrder.push(4);
    draft.sharedEntities.set(5, { id: 5, layerId: 4, kind: 'path', closed: false, points: [[120, 20], [180, 20]] });
    draft.sharedEntityOrder.push(5); draft.meta.nextId = 6;
  });
  tab.doc.addPage('Page 2');
  const view = render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas') as HTMLCanvasElement;
  const checkRing = (canvas: HTMLCanvasElement) => expect(fills).toContainEqual({ canvas, rule: 'evenodd', starts: [[10, 10], [30, 30]] });
  const sharedDrawn = (canvas: HTMLCanvasElement) => strokes.some(stroke => stroke.canvas === canvas &&
    stroke.starts.some(point => point[0] === 120 && point[1] === 20));
  checkRing(canvas); expect(sharedDrawn(canvas)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Presentation mode' }));
  const presentation = screen.getByLabelText('Page 1 presentation') as HTMLCanvasElement;
  checkRing(presentation); expect(sharedDrawn(presentation)).toBe(false);
  fireEvent.keyDown(window, { key: 'Escape' });
  act(() => { tab.commands.execute('layout.print'); });
  const print = screen.getByLabelText('Print preview: Page 1') as HTMLCanvasElement;
  checkRing(print); expect(sharedDrawn(print)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  click(50, 50); expect(screen.queryByLabelText('Selected object bounds')).toBeNull();
  click(20, 20); expect(screen.getByLabelText('Selected object bounds')).toBeTruthy();
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 60, clientY: 60 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 90, clientY: 90 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 90, clientY: 90 });
  const moved = tab.doc.state.pages.get(pageId)!.entities.get(3)!;
  expect(moved.points[0]).toEqual([20, 20]); expect(moved.points[4]).toEqual([40, 40]);
  expect(moved.contourStarts).toEqual([0, 4]);
  // Page 2 has no override, so the shared layer is drawn there.
  const page2 = tab.doc.state.pageOrder[1]!;
  act(() => { session.setActivePage(page2); });
  view.rerender(<LayoutWorkspace tab={tab} session={session} />);
  expect(sharedDrawn(screen.getByLabelText('Page 2 canvas') as HTMLCanvasElement)).toBe(true);
  act(() => { session.setActivePage(pageId); });
  view.rerender(<LayoutWorkspace tab={tab} session={session} />);
  act(() => { tab.commands.execute('layout.layer.setVisible', { pageId, layerId: 4, visible: true }); });
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(reopened.state.pages.get(pageId)!.entities.get(3)?.contourStarts).toEqual([0, 4]);
  expect(reopened.state.pages.get(pageId)!.layerVisibility?.get(4)).toBe(true);
  view.unmount(); session.dispose(); app.dispose();
});

it('fills an open contour of a compound path as if closed but strokes only its drawn segments', () => {
  const fills: { rule: string | undefined; closes: number }[] = [], strokes: { starts: number[][]; closes: number }[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    let starts: number[][] = [], closes = 0;
    const methods = new Map<string | symbol, unknown>([
      ['measureText', () => ({ width: 5 })], ['beginPath', () => { starts = []; closes = 0; }],
      ['moveTo', (x: number, y: number) => { starts.push([x, y]); }], ['closePath', () => { closes++; }],
      ['stroke', () => { strokes.push({ starts: [...starts], closes }); }],
      ['fill', (rule?: string) => { fills.push({ rule, closes }); }],
    ]);
    return new Proxy({}, { get: (_, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); },
      set: (_, key, value) => { methods.set(key, value); return true; } }) as CanvasRenderingContext2D;
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.doc.undoStack.transact('Fixture', draft => {
    const page = draft.pages.get(pageId)!;
    page.entities.set(3, { id: 3, layerId: 1, kind: 'path', closed: true, contourStarts: [0, 4], openContours: [1],
      points: [[10, 10], [90, 10], [90, 90], [10, 90], [30, 30], [70, 30], [70, 70]],
      style: { fillColor: '#ff0000', strokeColor: '#000000', strokeWeightPt: 1 } });
    page.entityOrder.push(3); draft.meta.nextId = 4;
  });
  const view = render(<LayoutWorkspace tab={tab} session={session} />);
  expect(fills).toContainEqual({ rule: 'evenodd', closes: 2 });
  expect(strokes).toContainEqual({ starts: [[10, 10], [30, 30]], closes: 1 });
  view.unmount(); session.dispose(); app.dispose();
});
