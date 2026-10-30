// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { LAYOUT_DIMENSION_SCALES, linearDimensionGeometry } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  const pageId = tab.activePageId;
  const sourceId = tab.commands.execute('layout.shape.add', { pageId, points: [[10, 10], [110, 10]] }) as number;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const click = (x: number, y: number): void => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3 });
  };
  const dispose = (): void => { session.dispose(); app.dispose(); };
  return { tab, session, pageId, sourceId, click, dispose };
}

it('places an associated dimension in three clicks, edits styles, and preserves its detached cache across save/reopen', async () => {
  const { tab, session, pageId, sourceId, click, dispose } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Linear Dimension' }));
  click(10, 10); click(110, 10);
  expect(screen.getByText('Click to place the dimension line.')).toBeTruthy();
  click(60, 25);
  const entities = () => [...tab.doc.state.pages.get(pageId)!.entities.values()];
  const dimension = () => entities().find((entity) => entity.dimension)!;
  expect(dimension().dimension).toMatchObject({ cachedValueMm: 100, detached: false });
  expect(dimension().dimension!.anchors[0]).toMatchObject({ entityId: sourceId, pointIndex: 0 });
  fireEvent.change(screen.getByLabelText('Dimension units'), { target: { value: 'cm' } });
  fireEvent.change(screen.getByLabelText('Dimension precision'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Dimension text'), { target: { value: 'Overall <>' } });
  expect(screen.getByText('Overall 10.00 cm')).toBeTruthy();
  act(() => { tab.commands.execute('layout.shape.setPath', { pageId, entityId: sourceId, points: [[10, 10], [160, 10]] }); });
  expect(screen.getByText('Overall 15.00 cm')).toBeTruthy();
  act(() => { tab.commands.execute('layout.shape.delete', { pageId, entityId: sourceId }); });
  expect(screen.getByText('Detached — showing the last measured value.')).toBeTruthy();
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(reopened.state.pages.get(pageId)!.entities.get(dimension().id)).toEqual(dimension());
  act(() => { tab.commands.execute('edit.undo'); });
  expect(screen.getByText('Associated with path vertices')).toBeTruthy();
  // Select the actual dimension line, then drag it.
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  click(80, 25);
  expect(screen.getByLabelText('Dimension units')).toBeTruthy();
  const canvas = screen.getByLabelText('Page 1 canvas');
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 4, clientX: 240, clientY: 75 });
  fireEvent.pointerMove(canvas, { pointerId: 4, clientX: 240, clientY: 105 });
  fireEvent.pointerUp(canvas, { pointerId: 4, clientX: 240, clientY: 105 });
  expect(dimension().points).toEqual([[10, 10], [160, 10], [60, 35]]);
  expect(dimension().dimension!.cachedValueMm).toBe(150);
  dispose();
});

it('chooses drawing scale, feet-and-inch formats, fraction precision, and dashes in the properties panel', () => {
  const { tab, pageId, click, dispose } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Linear Dimension' }));
  click(10, 10); click(110, 10); click(60, 25);
  const dimension = () => [...tab.doc.state.pages.get(pageId)!.entities.values()].find((entity) => entity.dimension)!.dimension!;
  expect(screen.getByText('100.0 mm')).toBeTruthy();
  expect((screen.getByLabelText('Dimension scale') as HTMLSelectElement).selectedOptions[0]!.text).toBe('1:1');
  fireEvent.change(screen.getByLabelText('Dimension scale'), { target: { value: String(LAYOUT_DIMENSION_SCALES.findIndex(s => s.label === '1:50')) } });
  expect(screen.getByText('5000.0 mm')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Dimension units'), { target: { value: 'architectural' } });
  expect(dimension()).toMatchObject({ format: 'architectural', units: 'inch' });
  const precision = screen.getByLabelText('Dimension precision') as HTMLSelectElement;
  expect([...precision.options].map(option => option.text)).toEqual(['1"', '1/2"', '1/4"', '1/8"', '1/16"', '1/32"', '1/64"']);
  fireEvent.change(precision, { target: { value: '4' } });
  fireEvent.change(screen.getByLabelText('Dimension scale'), { target: { value: String(LAYOUT_DIMENSION_SCALES.findIndex(s => s.label === `1/4" = 1'-0"`)) } });
  // 100 mm of paper at 1/4" = 1'-0" is 188.976", to the nearest 1/16".
  expect(screen.getByText(`15'-9"`)).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Dash between feet, inches, and fractions'));
  expect(screen.getByText(`15' 9"`)).toBeTruthy();
  // The custom ratio is a draft until Enter or blur, so typing it is one undoable edit.
  const ratio = screen.getByLabelText('Custom scale 1:');
  const before = dimension().scale;
  for (const value of ['', '7', '75']) fireEvent.change(ratio, { target: { value } });
  expect(dimension().scale).toBe(before);
  fireEvent.keyDown(ratio, { key: 'Enter' });
  expect(dimension().scale).toBeCloseTo(1 / 75, 12);
  expect((screen.getByLabelText('Dimension scale') as HTMLSelectElement).selectedOptions[0]!.text).toBe('1:75');
  act(() => { tab.commands.execute('edit.undo'); });
  expect(dimension().scale).toBe(before);
  fireEvent.change(ratio, { target: { value: '0.5' } });
  fireEvent.blur(ratio);
  expect(dimension().scale).toBe(2);
  expect((screen.getByLabelText('Dimension scale') as HTMLSelectElement).selectedOptions[0]!.text).toBe('2:1');
  fireEvent.change(ratio, { target: { value: '0' } });
  fireEvent.blur(ratio);
  expect(dimension().scale).toBe(2);
  expect((ratio as HTMLInputElement).value).toBe('0.5');
  fireEvent.change(screen.getByLabelText('Dimension units'), { target: { value: 'engineering' } });
  expect(dimension()).toMatchObject({ format: 'engineering', units: 'ft' });
  expect(screen.queryByLabelText('Dash between feet, inches, and fractions')).toBeNull();
  expect([...(screen.getByLabelText('Dimension precision') as HTMLSelectElement).options].map(option => option.text)[2]).toBe('0.00');
  fireEvent.change(screen.getByLabelText('Dimension units'), { target: { value: 'cm' } });
  expect(dimension()).toMatchObject({ format: 'decimal', units: 'cm' });
  act(() => { tab.commands.execute('edit.undo'); });
  expect(dimension()).toMatchObject({ format: 'engineering', units: 'ft' });
  // Points show at most one decimal place, so switching to them clamps a finer precision.
  fireEvent.change(screen.getByLabelText('Dimension precision'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('Dimension units'), { target: { value: 'pt' } });
  expect(dimension()).toMatchObject({ format: 'decimal', units: 'pt', precision: 1 });
  expect([...(screen.getByLabelText('Dimension precision') as HTMLSelectElement).options].map(option => option.text)).toEqual(['0', '0.0']);
  dispose();
});

it('cancels incomplete placement and rejects a coincident second point', () => {
  const { tab, pageId, click, dispose } = setup();
  fireEvent.keyDown(window, { code: 'KeyD', key: 'd' });
  click(10, 10); click(10, 10);
  expect(screen.getByText('Choose a different second point.')).toBeTruthy();
  fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' });
  expect([...tab.doc.state.pages.get(pageId)!.entities.values()].some((entity) => entity.dimension)).toBe(false);
  click(10, 10); click(110, 10); click(60, 25);
  expect([...tab.doc.state.pages.get(pageId)!.entities.values()].some((entity) => entity.dimension)).toBe(true);
  expect(screen.getByLabelText('Page 1 canvas').getAttribute('data-tool')).toBe('dimension');
  expect(screen.getByText('Click the first measurement point, or Ctrl-click a line to measure its full length.')).toBeTruthy();
  click(20, 60); click(120, 60); click(70, 80);
  expect([...tab.doc.state.pages.get(pageId)!.entities.values()].filter(entity => entity.dimension)).toHaveLength(2);
  expect(screen.getByLabelText('Page 1 canvas').getAttribute('data-tool')).toBe('dimension');
  dispose();
});

it('snaps near-axis dimension previews and placement while retaining exact associated measurement points', async () => {
  const { tab, session, pageId, sourceId, click, dispose } = setup();
  act(() => { tab.commands.execute('layout.shape.setPath', { pageId, entityId: sourceId, points: [[10, 10], [110, 11.5]] }); });
  const lineTo = vi.fn(), methods = new Map<string | symbol, unknown>([['lineTo', lineTo]]);
  const context = new Proxy({}, { get: (_target, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); },
    set: (_target, key, value) => { methods.set(key, value); return true; } });
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context as CanvasRenderingContext2D);
  fireEvent.click(screen.getByRole('button', { name: 'Linear Dimension' }));
  click(10, 10);
  const canvas = screen.getByLabelText('Page 1 canvas');
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 330, clientY: 34.5 });
  expect(lineTo).toHaveBeenCalledWith(110, 10);
  click(110, 11.5);
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 180, clientY: 90 });
  expect(lineTo).toHaveBeenCalledWith(110, 30);
  click(60, 30);
  const dimension = () => [...tab.doc.state.pages.get(pageId)!.entities.values()].find(entity => entity.dimension)!;
  expect(dimension().dimension!.alignment).toBe('horizontal');
  expect(dimension().points.slice(0, 2)).toEqual([[10, 10], [110, 11.5]]);
  expect(dimension().dimension!.anchors[1]).toMatchObject({ entityId: sourceId, pointIndex: 1 });
  expect(dimension().dimension!.cachedValueMm).toBe(100);
  act(() => { tab.commands.execute('layout.shape.setPath', { pageId, entityId: sourceId, points: [[10, 10], [130, 12]] }); });
  expect(dimension().points[1]).toEqual([130, 12]);
  expect(dimension().dimension!.cachedValueMm).toBe(120);
  const geometry = linearDimensionGeometry(dimension());
  expect(geometry.start[1]).toBe(geometry.end[1]);
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(reopened.state.pages.get(pageId)!.entities.get(dimension().id)).toEqual(dimension());
  dispose();
});

it('captures near-vertical dimensions but preserves deliberately angled dimensions', () => {
  const { tab, pageId, click, dispose } = setup();
  // Free paper points: grid snap is on by default and would pull the 2 mm offset onto the grid line.
  act(() => { tab.commands.execute('layout.grid.set', { snap: false }); });
  fireEvent.click(screen.getByRole('button', { name: 'Linear Dimension' }));
  click(140, 70); click(142, 170); click(165, 120);
  const dimensions = () => [...tab.doc.state.pages.get(pageId)!.entities.values()].filter(entity => entity.dimension);
  expect(dimensions()[0]!.dimension!.alignment).toBe('vertical');
  expect(dimensions()[0]!.points.slice(0, 2)).toEqual([[140, 70], [142, 170]]);
  expect(dimensions()[0]!.dimension!.cachedValueMm).toBe(100);
  const geometry = linearDimensionGeometry(dimensions()[0]!);
  expect(geometry.start[0]).toBe(geometry.end[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Linear Dimension' }));
  click(20, 120); click(100, 150); click(45, 170);
  expect(dimensions()[1]!.dimension!.alignment).toBe('aligned');
  dispose();
});

it('follows an associated path live while its scale handle is dragged, committing only on release', () => {
  const { tab, pageId, sourceId, click, dispose } = setup();
  const fillText = vi.fn<(text: string, x: number, y: number) => void>();
  const methods = new Map<string | symbol, unknown>([['fillText', fillText], ['measureText', (value: string) => ({ width: value.length * 2 })]]);
  const context = new Proxy({}, { get: (_target, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); },
    set: (_target, key, value) => { methods.set(key, value); return true; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D);
  fireEvent.keyDown(window, { code: 'KeyD', key: 'd' });
  click(10, 10); click(110, 10); click(60, 25);
  const dimension = () => [...tab.doc.state.pages.get(pageId)!.entities.values()].find((entity) => entity.dimension)!;
  expect(dimension().dimension).toMatchObject({ cachedValueMm: 100, detached: false });
  expect(dimension().dimension!.anchors[1]).toMatchObject({ entityId: sourceId, pointIndex: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
  click(60, 10);
  const handle = screen.getByRole('button', { name: 'Scale right' });
  const version = tab.doc.version;
  fillText.mockClear();
  fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 330, clientY: 30 });
  fireEvent.pointerMove(handle, { pointerId: 2, clientX: 480, clientY: 30 });
  // The canvas already reads the dragged length while the document still holds the old one.
  expect(fillText.mock.calls.map(([text]) => text)).toContain('150.0 mm');
  expect(tab.doc.version).toBe(version);
  expect(dimension().points[1]).toEqual([110, 10]);
  expect(dimension().dimension!.cachedValueMm).toBe(100);
  fireEvent.pointerUp(handle, { pointerId: 2, clientX: 480, clientY: 30 });
  expect(dimension().points[1]).toEqual([160, 10]);
  expect(dimension().dimension!.cachedValueMm).toBe(150);
  dispose();
});

it('measures the whole coincident straight run on a modifier click, then places the line with the next click', () => {
  const { tab, pageId, sourceId, click, dispose } = setup();
  const touchingId = tab.commands.execute('layout.shape.add', { pageId, points: [[110, 10], [160, 10]] }) as number;
  tab.commands.execute('layout.shape.add', { pageId, points: [[60, 10], [60, 60]] });
  const canvas = screen.getByLabelText('Page 1 canvas');
  const modifierClick = (x: number, y: number, modifier: 'metaKey' | 'ctrlKey'): void => {
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3, [modifier]: true });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: x * 3, clientY: y * 3, [modifier]: true });
  };
  fireEvent.keyDown(window, { code: 'KeyD', key: 'd' });
  // Away from every segment the draft stays empty and the user is told what the modifier does.
  modifierClick(150, 120, 'metaKey');
  expect(screen.getByText('Ctrl-click a straight line to measure its full length.')).toBeTruthy();
  modifierClick(30, 10, 'metaKey');
  expect(screen.getByText('Click to place the dimension line.')).toBeTruthy();
  click(80, 30);
  const dimensions = () => [...tab.doc.state.pages.get(pageId)!.entities.values()].filter((entity) => entity.dimension);
  expect(dimensions()).toHaveLength(1);
  expect(dimensions()[0]!.points.slice(0, 2)).toEqual([[10, 10], [160, 10]]);
  expect(dimensions()[0]!.dimension).toMatchObject({ cachedValueMm: 150, detached: false,
    anchors: [{ entityId: sourceId, pointIndex: 0 }, { entityId: touchingId, pointIndex: 1 }] });
  // Ctrl works the same way, and a modifier still held while placing the line is ignored.
  modifierClick(60, 40, 'ctrlKey');
  expect(screen.getByText('Click to place the dimension line.')).toBeTruthy();
  modifierClick(90, 40, 'ctrlKey');
  expect(dimensions()).toHaveLength(2);
  expect(dimensions()[1]!.points).toEqual([[60, 10], [60, 60], [90, 40]]);
  expect(dimensions()[1]!.dimension!.cachedValueMm).toBe(50);
  // With a first point already pending, a modifier click is just the second measurement point.
  click(20, 80);
  modifierClick(60, 40, 'metaKey');
  expect(screen.getByText('Click to place the dimension line.')).toBeTruthy();
  click(40, 100);
  expect(dimensions()).toHaveLength(3);
  expect(dimensions()[2]!.points.slice(0, 2)).toEqual([[20, 80], [60, 40]]);
  dispose();
});

it('attaches measured points clicked along a line to those points, which follow the line', () => {
  const { tab, pageId, sourceId, click, dispose } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Linear Dimension' }));
  click(35, 10); click(85, 10); click(60, 25);
  const dimension = () => [...tab.doc.state.pages.get(pageId)!.entities.values()].find((entity) => entity.dimension)!;
  expect(dimension().dimension!.anchors).toEqual([
    { entityId: sourceId, pointIndex: 0, pointCount: 2, t: 0.25 }, { entityId: sourceId, pointIndex: 0, pointCount: 2, t: 0.75 }]);
  expect(screen.getByText('Associated with paths')).toBeTruthy();
  act(() => { tab.commands.execute('layout.shape.setPath', { pageId, entityId: sourceId, points: [[10, 10], [210, 10]] }); });
  expect(dimension().points.slice(0, 2)).toEqual([[60, 10], [160, 10]]);
  expect(dimension().dimension!.cachedValueMm).toBe(100);
  dispose();
});
