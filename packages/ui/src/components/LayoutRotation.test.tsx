// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { rotateLayoutEntity, rotateLayoutPath } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { enterLayoutValue } from './layoutEntryTesting';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  const sourceId = tab.commands.execute('layout.rectangle.add', { pageId: tab.activePageId, kind: 'rectangle', first: [20, 20], second: [60, 40] }) as number;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  const move = (x: number, y: number) => fireEvent.pointerMove(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  return { app, session, tab, canvas, click, move, sourceId, page: () => tab.doc.state.pages.get(tab.activePageId)! };
}

it('rotates about an interior pivot with a fixed reference and realtime angle, then removes every guide', async () => {
  const { app, session, tab, click, move, sourceId, page } = setup();
  const moveTo = vi.fn(), lineTo = vi.fn();
  const methods = new Map<string | symbol, unknown>([['moveTo', moveTo], ['lineTo', lineTo]]);
  const context = new Proxy({}, { get: (_target, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); },
    set: (_target, key, value) => { methods.set(key, value); return true; } });
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context as CanvasRenderingContext2D);
  const source = page().entities.get(sourceId)!, version = tab.doc.version;
  fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
  click(40, 30); move(60, 30);
  expect(screen.queryByLabelText('Rotation angle preview')).toBeNull();
  click(60, 30); move(40, 50);
  expect(screen.getByLabelText('Rotation angle preview').textContent).toBe('90.0°');
  expect(moveTo).toHaveBeenCalledWith(50, 10); // The previewed first corner has rotated.
  expect(lineTo).toHaveBeenCalledWith(60, 30); // The original reference direction stays visible.
  expect(tab.doc.version).toBe(version); expect(page().entities.get(sourceId)).toEqual(source);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(page().id)!.entities.get(sourceId)).toEqual(source);
  lineTo.mockClear(); click(40, 50);
  expect(page().entities.get(sourceId)!.points).toEqual([[50, 10], [50, 50], [30, 50], [30, 10]]);
  expect(screen.queryByLabelText('Rotation angle preview')).toBeNull();
  expect(lineTo).not.toHaveBeenCalledWith(60, 30);
  act(() => { tab.commands.execute('edit.undo'); }); expect(page().entities.get(sourceId)).toEqual(source);
  act(() => { tab.commands.execute('edit.redo'); });
  expect(screen.queryByLabelText('Rotation angle preview')).toBeNull();
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(page().id)!.entities.get(sourceId)).toEqual(page().entities.get(sourceId));
  session.dispose(); app.dispose();
});

it('rotates a line about a point on it, tracks either direction continuously, and accepts exact degree values', () => {
  const { app, session, tab, click, move, page } = setup();
  let lineId = 0;
  act(() => { lineId = tab.commands.execute('layout.shape.add', { pageId: tab.activePageId, points: [[10, 70], [50, 70]], closed: false }) as number; });
  fireEvent.keyDown(window, { key: 'q', code: 'KeyQ' });
  click(30, 70); click(50, 70);
  move(30, 90); move(10, 70); move(30, 50);
  expect(screen.getByLabelText('Rotation angle preview').textContent).toBe('270.0°');
  enterLayoutValue('-90deg');
  expect(page().entities.get(lineId)!.points[0]![0]).toBeCloseTo(30);
  expect(page().entities.get(lineId)!.points[0]![1]).toBeCloseTo(90);
  expect(page().entities.get(lineId)!.points[1]![1]).toBeCloseTo(50);
  expect(screen.queryByLabelText('Rotation angle preview')).toBeNull();
  session.dispose(); app.dispose();
});

it('rejects degenerate directions and cancels drafts without committing geometry', () => {
  const { app, session, tab, canvas, click, move, sourceId, page } = setup();
  const source = page().entities.get(sourceId)!;
  fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
  click(100, 100); expect(screen.getByRole('alert').textContent).toContain('within a shape');
  click(40, 30); click(40, 30); expect(screen.getByRole('alert').textContent).toContain('away');
  click(60, 30); move(40, 50); click(40, 30);
  expect(page().entities.get(sourceId)).toEqual(source);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByLabelText('Rotation angle preview')).toBeNull();
  click(40, 30); click(60, 30); move(40, 50); fireEvent.pointerCancel(canvas);
  expect(screen.queryByLabelText('Rotation angle preview')).toBeNull();
  click(40, 30); click(60, 30); move(40, 50); fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  expect(screen.queryByLabelText('Rotation angle preview')).toBeNull(); expect(page().entities.get(sourceId)).toEqual(source);
  fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
  click(40, 30); click(60, 30); move(40, 50);
  act(() => { tab.commands.execute('layout.layer.add', { name: 'Editable' }); tab.commands.execute('layout.layer.setLocked', { layerId: source.layerId, locked: true }); });
  expect(screen.queryByLabelText('Rotation angle preview')).toBeNull(); expect(page().entities.get(sourceId)).toEqual(source);
  session.dispose(); app.dispose();
});

it('previews the same native curve geometry that will be committed about an off-center pivot', () => {
  const { app, session, tab, click, move, page } = setup();
  let id = 0;
  act(() => { id = tab.commands.execute('layout.rectangle.add', { pageId: tab.activePageId, kind: 'rounded-rectangle', first: [90, 20], second: [150, 60], amountMm: 5 }) as number; });
  const source = page().entities.get(id)!;
  fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
  click(100, 30); click(120, 50); move(80, 50);
  expect(screen.getByLabelText('Rotation angle preview').textContent).toBe('90.0°');
  click(80, 50);
  const expected = rotateLayoutPath(source, [100, 30], 90);
  expect(page().entities.get(id)).toEqual({ ...source, ...expected });
  session.dispose(); app.dispose();
});

it('retains corner, midpoint, and edge snapping and colored markers through every rotation stage', () => {
  const { app, session, tab, click, move, sourceId, page } = setup();
  act(() => { tab.commands.execute('layout.shape.add', { pageId: tab.activePageId, points: [[0, 60], [40, 60]], closed: false }); });
  // The placement marker is an SVG overlay centered on the snapped point, in CSS pixels.
  const marker = (color: string, shape: string, x: number, y: number) => {
    const svg = document.querySelector<SVGSVGElement>('.pf-layout-placement-marker')!;
    const mark = svg.firstElementChild!;
    expect(mark.getAttribute('fill')).toBe(color); expect(mark.tagName).toBe(shape);
    expect(parseFloat(svg.style.left) + 6).toBeCloseTo(x * 3); expect(parseFloat(svg.style.top) + 6).toBeCloseTo(y * 3);
  };
  fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
  move(19.3, 19.4); marker('#16a34a', 'circle', 20, 20);
  move(39.7, 19.4); marker('#9333ea', 'polygon', 40, 20);
  move(31.2, 19.4); marker('#dc2626', 'rect', 31.2, 20);
  click(19.3, 19.4); // The pivot snaps to the exact corner, not the nearby click.
  move(59.6, 39.6); marker('#16a34a', 'circle', 60, 40);
  move(31.2, 19.4); marker('#dc2626', 'rect', 31.2, 20);
  move(39.7, 19.4); marker('#9333ea', 'polygon', 40, 20);
  click(39.7, 19.4); // Reference snaps to the midpoint of the top edge.
  move(0.4, 59.4); marker('#16a34a', 'circle', 0, 60);
  move(11.3, 59.4); marker('#dc2626', 'rect', 11.3, 60);
  move(19.6, 59.4); marker('#9333ea', 'polygon', 20, 60);
  expect(screen.getByLabelText('Rotation angle preview').textContent).toBe('90.0°');
  click(19.6, 59.4);
  const points = page().entities.get(sourceId)!.points;
  expect(points[0]).toEqual([20, 20]);
  expect(points[1]![0]).toBeCloseTo(20); expect(points[1]![1]).toBeCloseTo(60);
  expect(points[2]![0]).toBeCloseTo(0); expect(points[2]![1]).toBeCloseTo(60);
  expect(screen.queryByLabelText('Rotation angle preview')).toBeNull();
  session.dispose(); app.dispose();
});

it('holds pointer rotation at quarter-turn detents relative to a diagonal reference, keeps other angles, and commits the preview', () => {
  const { app, session, tab, click, move, sourceId, page } = setup();
  const source = page().entities.get(sourceId)!;
  fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
  click(40, 30); click(80, 70);
  move(12, 60); // About +88°, relative to the 45° reference.
  expect(screen.getByLabelText('Rotation angle preview').textContent).toBe('90.0°');
  expect(page().entities.get(sourceId)).toEqual(source);
  move(20, 65); // 74.7°: away from a detent, the pointer's own angle is kept.
  expect(screen.getByLabelText('Rotation angle preview').textContent).toBe('74.7°');
  move(70, 2); // About -88°.
  expect(screen.getByLabelText('Rotation angle preview').textContent).toBe('-90.0°');
  move(12, 60); click(12, 60);
  expect(page().entities.get(sourceId)).toEqual({ ...source, ...rotateLayoutPath(source, [40, 30], 90) });
  act(() => { tab.commands.execute('edit.undo'); });
  expect(page().entities.get(sourceId)).toEqual(source);
  click(40, 30); click(80, 70); click(20, 65);
  const free = (Math.atan2(35, -20) - Math.PI / 4) * 180 / Math.PI;
  expect(page().entities.get(sourceId)!.points).toEqual(rotateLayoutPath(source, [40, 30], free).points);
  act(() => { tab.commands.execute('edit.undo'); });
  // A typed angle bypasses the pointer's detents.
  click(40, 30); click(80, 70);
  enterLayoutValue('88deg');
  expect(page().entities.get(sourceId)).toEqual({ ...source, ...rotateLayoutPath(source, [40, 30], 88) });
  session.dispose(); app.dispose();
});

it.each(['label', 'text', 'image'] as const)('holds %s pointer rotation at 90-degree detents for preview and commit', async kind => {
  const { app, session, tab, click, move, page } = setup();
  let id = 0;
  act(() => {
    if (kind === 'image') {
      id = (tab.commands.execute('layout.clipboard.paste', { pageId: page().id, entities: [{
        kind: 'image', points: [[0, 0], [50, 0], [50, 20], [0, 20]], closed: true,
        image: { src: 'data:image/png;base64,aGVsbG8=' },
      }] }) as number[])[0]!;
    } else {
      id = tab.commands.execute('layout.text.add', { pageId: page().id, kind,
        points: kind === 'label' ? [[100, 70], [150, 90], [80, 60], [90, 80]] : [[100, 70], [150, 90]],
        text: { content: 'Rotate me', fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false, italic: false,
          underline: false, align: 'left', vertical: 'middle', bounded: true, leader: kind === 'label' ? 'elbow' : 'none', endpoint: 'arrow' },
      }) as number;
    }
  });
  const source = page().entities.get(id)!, pivot: [number, number] = kind === 'image' ? [148.5, 105] : [125, 80];
  const version = tab.doc.version;
  fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
  click(...pivot); click(pivot[0] + 30, pivot[1]);
  move(pivot[0] + 10, pivot[1] + 30); // 71.6 degrees: away from a detent, kept as it is.
  expect(screen.getByLabelText('Rotation angle preview').textContent).toBe('71.6°');
  move(pivot[0] + 1, pivot[1] + 30); // 88.1 degrees, 1 mm from the quarter turn: held at 90.
  expect(screen.getByLabelText('Rotation angle preview').textContent).toBe('90.0°');
  expect(tab.doc.version).toBe(version); expect(page().entities.get(id)).toEqual(source);
  click(pivot[0] + 1, pivot[1] + 30);
  expect(page().entities.get(id)).toEqual(rotateLayoutEntity(source, pivot, 90));
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(page().id)!.entities.get(id)).toEqual(page().entities.get(id));
  act(() => { tab.commands.execute('edit.undo'); }); expect(page().entities.get(id)).toEqual(source);
  click(...pivot); click(pivot[0] + 30, pivot[1]); move(pivot[0] + 1, pivot[1] - 30);
  expect(screen.getByLabelText('Rotation angle preview').textContent).toBe('-90.0°');
  click(pivot[0] + 1, pivot[1] - 30);
  expect(page().entities.get(id)).toEqual(rotateLayoutEntity(source, pivot, -90));
  session.dispose(); app.dispose();
});
