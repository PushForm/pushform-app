// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('renders whole dashed paths in the workspace, presentation and print without affecting solid strokes', () => {
  const strokes: { canvas: HTMLCanvasElement; dash: number[]; points: number[][] }[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let dash: number[] = [], points: number[][] = [];
    const methods = new Map<string | symbol, unknown>([
      ['measureText', () => ({ width: 5 })],
      ['setLineDash', (value: number[]) => { dash = [...value]; }],
      ['beginPath', () => { points = []; }],
      ['moveTo', (x: number, y: number) => { points.push([x, y]); }],
      ['lineTo', (x: number, y: number) => { points.push([x, y]); }],
      ['stroke', () => { strokes.push({ canvas: this, dash: [...dash], points: [...points] }); }],
    ]);
    return new Proxy({}, {
      get: (_, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); },
      set: (_, key, value) => { methods.set(key, value); return true; },
    }) as CanvasRenderingContext2D;
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  const points = [[10, 20], [90, 20]], solid = [[10, 40], [90, 40]], dash = [4, 2, 1, 2];
  const entityId = tab.commands.execute('layout.shape.add', { pageId, points }) as number;
  tab.commands.execute('layout.shape.setStyle', { pageId, entityId, strokeDashMm: dash });
  tab.commands.execute('layout.shape.add', { pageId, points: solid });
  const view = render(<LayoutWorkspace tab={tab} session={session} />);
  const check = (canvas: HTMLCanvasElement) => {
    const painted = strokes.filter(stroke => stroke.canvas === canvas);
    expect(painted).toContainEqual({ canvas, dash, points });
    expect(painted).toContainEqual({ canvas, dash: [], points: solid });
  };
  check(screen.getByLabelText('Page 1 canvas') as HTMLCanvasElement);
  fireEvent.click(screen.getByRole('button', { name: 'Presentation mode' }));
  check(screen.getByLabelText('Page 1 presentation') as HTMLCanvasElement);
  fireEvent.keyDown(window, { key: 'Escape' });
  act(() => { tab.commands.execute('layout.print'); });
  check(screen.getByLabelText('Print preview: Page 1') as HTMLCanvasElement);
  view.unmount(); session.dispose(); app.dispose();
});
