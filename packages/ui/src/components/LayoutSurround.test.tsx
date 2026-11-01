// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

type Call = [string, unknown[]];
const contexts = new Map<HTMLCanvasElement, Call[]>();

function recordingContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const calls = contexts.get(canvas) ?? [];
  contexts.set(canvas, calls);
  const props: Record<string | symbol, unknown> = { canvas };
  return new Proxy(props, {
    get: (target, key) => key in target ? target[key]
      : key === 'measureText' ? () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 })
      : key === 'getLineDash' ? () => []
      : key === 'createPattern' || key === 'createLinearGradient' ? () => null
      : (...args: unknown[]) => { calls.push([String(key), args]); },
    set: (target, key, value) => { target[key] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

it('draws objects past the paper edge on the workspace around the page, without paper or guides', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return recordingContext(this) as never;
  });
  // The page sits 120 px from the workspace's left and 90 px from its top, at 3 px per millimetre.
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLCanvasElement) {
    const surround = this.classList.contains('pf-layout-surround');
    const [left, top, width, height] = surround ? [0, 0, 1200, 900] : [120, 90, 891, 630];
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
  });
  const app = createApp({ demo: false, expose: false }), session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [-30, 20], second: [40, 60] });
  render(<LayoutWorkspace tab={tab} session={session} />);
  const page = screen.getByLabelText('Page 1 canvas') as HTMLCanvasElement;
  const surround = document.querySelector<HTMLCanvasElement>('.pf-layout-surround')!;
  expect(surround).toBeTruthy();
  expect(surround.getAttribute('aria-hidden')).toBe('true');

  const pageCalls = contexts.get(page)!, surroundCalls = contexts.get(surround)!;
  // The surround's origin is the workspace's top-left corner, 40 mm left of and 30 mm above the page.
  const transform = surroundCalls.find(([name]) => name === 'setTransform')![1] as number[];
  const scale = transform[0]!;
  expect(transform[4]! / scale).toBeCloseTo(40);
  expect(transform[5]! / scale).toBeCloseTo(30);
  expect(surround.width).toBe(Math.round(400 * scale));
  expect(surround.height).toBe(Math.round(300 * scale));
  // The rectangle is drawn on both. The surround has only the paper's shadow, without the grid or margin guide.
  expect(surroundCalls.some(([name]) => name === 'stroke')).toBe(true);
  expect(pageCalls.some(([name, args]) => name === 'fillRect' && args[0] === 0 && args[1] === 0)).toBe(true);
  expect(pageCalls.some(([name]) => name === 'strokeRect')).toBe(true);
  const count = (name: string) => surroundCalls.filter(([call]) => call === name).length;
  expect(count('fillRect')).toBe(count('setTransform')); // One paper (for its shadow) per paint.
  expect(surroundCalls.find(([name]) => name === 'fillRect')![1]).toEqual([0, 0, 297, 210]);
  expect(surroundCalls.some(([name]) => name === 'strokeRect')).toBe(false);
  session.dispose(); app.dispose();
});

it('draws with a tool on the workspace beside the page, at paper positions past the edge', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  // The page starts 120 px right of and 90 px below the workspace's corner, at 3 px per millimetre.
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 120, top: 90, width: 891, height: 630, right: 1011, bottom: 720, x: 120, y: 90, toJSON: () => ({}) });
  const app = createApp({ demo: false, expose: false }), session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.commands.execute('layout.grid.set', { snap: false });
  render(<LayoutWorkspace tab={tab} session={session} />);
  const workspace = screen.getByRole('main', { name: 'Layout workspace' });
  const canvas = screen.getByLabelText('Page 1 canvas');
  expect(workspace.getAttribute('data-tool')).toBe('select');
  act(() => { tab.commands.execute('tool.rectangle'); });
  expect(workspace.getAttribute('data-tool')).toBe('rectangle');
  // Both corners lie off the paper: left of it and above it.
  const at = (x: number, y: number) => ({ pointerId: 1, button: 0, clientX: 120 + x * 3, clientY: 90 + y * 3 });
  fireEvent.pointerDown(workspace, at(-30, -20));
  fireEvent.pointerMove(workspace, at(-10, -5));
  fireEvent.pointerUp(workspace, at(-10, -5));
  const shapes = [...tab.doc.state.pages.get(pageId)!.entities.values()];
  expect(shapes).toHaveLength(1);
  const xs = shapes[0]!.points.map(([x]) => x), ys = shapes[0]!.points.map(([, y]) => y);
  expect(Math.min(...xs)).toBeCloseTo(-30); expect(Math.max(...xs)).toBeCloseTo(-10);
  expect(Math.min(...ys)).toBeCloseTo(-20); expect(Math.max(...ys)).toBeCloseTo(-5);
  // A press beside the page leaves the page focused for keyboard shortcuts.
  expect(document.activeElement).toBe(canvas);
  session.dispose(); app.dispose();
});
