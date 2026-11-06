// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

type Stroke = { color: string; width: number; dash: number[] };

/** Paints the page at a zoom with Line active and the pointer on empty paper, recording the editing aids. */
function paintAt(zoom: number): { strokes: Stroke[]; marker: string | null } {
  const strokes: Stroke[] = [];
  let dash: number[] = [];
  const methods = new Map<string | symbol, unknown>();
  const ctx = new Proxy({}, {
    get: (_, key) => {
      if (!methods.has(key)) methods.set(key, vi.fn());
      return methods.get(key);
    },
    set: (_, key, value) => { methods.set(key, value); return true; },
  }) as CanvasRenderingContext2D;
  methods.set('setTransform', () => { strokes.length = 0; });
  methods.set('setLineDash', (value: number[]) => { dash = value; });
  methods.set('stroke', () => strokes.push({ color: String(ctx.strokeStyle), width: ctx.lineWidth, dash }));
  methods.set('strokeRect', () => strokes.push({ color: String(ctx.strokeStyle), width: ctx.lineWidth, dash }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return this.getAttribute('aria-label') === 'Page 1 canvas' ? ctx : null;
  } as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  tab.commands.execute('layout.grid.set', { show: true, snap: false });
  tab.workspace.zoomToPageOnOpen = false;
  tab.workspace.zoom = zoom;
  render(<LayoutWorkspace tab={tab} session={session} />);
  fireEvent.click(screen.getByRole('button', { name: 'Line' }));
  fireEvent.pointerMove(screen.getByLabelText('Page 1 canvas'), { pointerId: 1, clientX: 301, clientY: 301 });
  const marker = document.querySelector('.pf-layout-placement-marker');
  const result = { strokes: [...strokes], marker: marker ? marker.outerHTML.replace(/style="[^"]*"/, '') : null };
  cleanup(); session.dispose(); app.dispose(); vi.restoreAllMocks();
  return result;
}

it('keeps the placement marker, grid lines and margin guide the same size on screen at any zoom', () => {
  const aids = (frame: { strokes: Stroke[]; marker: string | null }) => {
    const grid = frame.strokes.find(stroke => stroke.color === '#e5eaf0');
    const margin = frame.strokes.find(stroke => stroke.color === '#b5bdc7');
    const marker = frame.marker;
    if (!grid || !margin || marker === null) throw new Error('An editing aid was not painted.');
    return { grid, margin, marker };
  };
  const near = aids(paintAt(1)), far = aids(paintAt(4));
  // Page millimetres times zoom is the size on screen, so each aid shrinks on the page by the zoom factor.
  expect(far.grid.width * 4).toBeCloseTo(near.grid.width);
  expect(far.margin.width * 4).toBeCloseTo(near.margin.width);
  expect(far.margin.dash.map(value => value * 4)).toEqual(near.margin.dash);
  // The marker is an SVG overlay in CSS pixels: only its position depends on zoom.
  expect(far.marker).toBe(near.marker);
  expect(near.marker).toContain('<circle r="2.4"');
});

/** Paints a rectangle in vertex editing at a zoom, recording the circles drawn on its corners. */
function vertexCirclesAt(zoom: number): { radius: number; width: number }[] {
  let circles: { x: number; y: number; radius: number; width: number }[] = [];
  let pending: { x: number; y: number; radius: number } | null = null;
  const methods = new Map<string | symbol, unknown>();
  const ctx = new Proxy({}, {
    get: (_, key) => {
      if (!methods.has(key)) methods.set(key, vi.fn());
      return methods.get(key);
    },
    set: (_, key, value) => { methods.set(key, value); return true; },
  }) as CanvasRenderingContext2D;
  methods.set('setTransform', () => { circles = []; });
  methods.set('beginPath', () => { pending = null; });
  methods.set('arc', (x: number, y: number, radius: number) => { pending = { x, y, radius }; });
  methods.set('stroke', () => { if (pending) circles.push({ ...pending, width: ctx.lineWidth }); });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return this.getAttribute('aria-label') === 'Page 1 canvas' ? ctx : null;
  } as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  tab.commands.execute('layout.shape.add', { pageId: tab.activePageId, points: [[10, 10], [50, 10], [50, 40], [10, 40]], closed: true });
  tab.workspace.zoomToPageOnOpen = false;
  tab.workspace.zoom = zoom;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 90, clientY: 75 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 90, clientY: 75 });
  fireEvent.doubleClick(canvas, { clientX: 90, clientY: 75 });
  const corners = circles.filter(circle => circle.x === 10 && circle.y === 10);
  cleanup(); session.dispose(); app.dispose(); vi.restoreAllMocks();
  return corners;
}

it('keeps the vertex-editing circles the same size on screen at any zoom', () => {
  const near = vertexCirclesAt(1).at(-1), far = vertexCirclesAt(4).at(-1);
  if (!near || !far) throw new Error('The vertex circle was not painted.');
  // 3 CSS pixels per page millimetre at zoom 1: a 4 px radius and a 1 px outline, like the 9 px resize handles.
  expect(near.radius * 3).toBeCloseTo(4);
  expect(near.width * 3).toBeCloseTo(1);
  expect(far.radius * 4).toBeCloseTo(near.radius);
  expect(far.width * 4).toBeCloseTo(near.width);
});
