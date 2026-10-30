// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { layoutEntityBounds } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { Icon } from './Icon';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Shape A spans [20, 20]-[60, 40] without a fill; shape B spans [100, 100]-[140, 120]. Grid snapping is off. */
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.doc.undoStack.transact('No grid snapping', (draft) => { draft.settings.grid.snap = false; });
  const a = tab.commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [20, 20], second: [60, 40] }) as number;
  tab.commands.execute('layout.shape.setStyle', { pageId, entityId: a, fillColor: null });
  const b = tab.commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [100, 100], second: [140, 120] }) as number;
  const view = render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const at = (x: number, y: number) => ({ pointerId: 1, clientX: x * 3, clientY: y * 3 });
  const click = (x: number, y: number, options: { shiftKey?: boolean } = {}) => {
    fireEvent.pointerDown(canvas, { button: 0, ...at(x, y), ...options });
    fireEvent.pointerUp(canvas, { ...at(x, y), ...options });
  };
  const move = (x: number, y: number, options: { shiftKey?: boolean } = {}) => fireEvent.pointerMove(canvas, { ...at(x, y), ...options });
  const measure = (value: string) => {
    const input = screen.getByLabelText('Layout Measurements');
    fireEvent.change(input, { target: { value } }); fireEvent.keyDown(input, { key: 'Enter' });
  };
  const page = () => tab.doc.state.pages.get(tab.activePageId)!;
  const points = (id: number) => page().entities.get(id)!.points;
  const readout = () => screen.queryByLabelText('Move offset preview')?.textContent ?? null;
  const status = () => document.querySelector('.pf-layout-footer-spacer')!.textContent;
  const alert = () => screen.queryByRole('alert')?.textContent ?? null;
  const selected = () => tab.workspace.selectedEntityId;
  const useMove = () => fireEvent.keyDown(window, { key: 'm', code: 'KeyM' });
  const tap = (key: string, target: Element | Window = window) => { fireEvent.keyDown(target, { key }); fireEvent.keyUp(target, { key }); };
  const dispose = () => { cleanup(); session.dispose(); app.dispose(); };
  return { app, session, tab, view, pageId, a, b, canvas, click, move, measure, page, points, readout, status, alert, selected, useMove, tap, dispose };
}

const A = [[20, 20], [60, 20], [60, 40], [20, 40]];
const shifted = (shape: number[][], dx: number, dy: number) => shape.map(([x, y]) => [x! + dx, y! + dy]);
const expectPoints = (actual: number[][], expected: number[][]) => actual.forEach((point, index) => {
  expect(point[0]).toBeCloseTo(expected[index]![0]!); expect(point[1]).toBeCloseTo(expected[index]![1]!);
});

describe('Layout Move tool', () => {
  it('sits before Rotate with the move icon, answers M and tool.move, and shows a move cursor until a move is pending', () => {
    const { tab, canvas, click, useMove, dispose } = setup();
    const labels = [...document.querySelectorAll('[aria-label="Layout tools"] button')]
      .map((button) => button.getAttribute('aria-label'));
    expect(labels[labels.indexOf('Rotate') - 1]).toBe('Move');
    const button = screen.getByRole('button', { name: 'Move' });
    fireEvent.mouseEnter(button);
    expect(screen.getByRole('tooltip').textContent).toBe('Move (M)');
    fireEvent.mouseLeave(button);
    const icon = render(<Icon name="tool-move" size={24} />).container.innerHTML;
    expect(button.innerHTML).toBe(icon);
    useMove();
    expect(canvas.getAttribute('data-tool')).toBe('move');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(canvas.style.cursor).toBe('move');
    click(40, 30);
    expect(canvas.style.cursor).toBe('');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(canvas.style.cursor).toBe('move');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    act(() => { tab.commands.execute('tool.move'); });
    expect(canvas.getAttribute('data-tool')).toBe('move');
    expect(tab.commands.ctx.tools?.activeToolId).toBe('move');
    dispose();
  });

  it('picks an unselected object by its unfilled interior, selects it alone and moves it from a snapped base point', () => {
    const { tab, a, b, click, move, points, readout, selected, useMove, dispose } = setup();
    click(40, 30); // Select itself does not pick an unfilled interior.
    expect(selected()).toBeNull();
    click(120, 110); // Select B with the Select tool.
    expect(selected()).toBe(b);
    useMove();
    click(20.6, 20.6); // Inside A near its corner: the base point snaps to the corner.
    expect(selected()).toBe(a);
    expect(readout()).toBe('0.0 mm, 0.0 mm');
    move(77.7, 63.3);
    const version = tab.doc.version;
    click(77.7, 63.3);
    expect(tab.doc.version).not.toBe(version);
    expectPoints(points(a), shifted(A, 57.7, 43.3));
    expect(points(b)[0]).toEqual([100, 100]);
    expect(selected()).toBe(a);
    expect(readout()).toBeNull(); // The guide and readout disappear and Move waits for a new base point.
    dispose();
  });

  it('picks a grouped object with its group and keeps layer, group, sharing and rotation through a move', () => {
    const { tab, pageId, a, b, click, page, useMove, dispose } = setup();
    let text = 0;
    act(() => {
      tab.commands.execute('layout.shape.group', { pageId, entityIds: [a, b] });
      tab.commands.execute('layout.layer.add', { name: 'Shared', shared: true });
      text = tab.commands.execute('layout.text.add', { pageId, kind: 'text', points: [[160, 20], [200, 40]],
        text: { content: 'Note', fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false, italic: false,
          underline: false, align: 'left', vertical: 'middle', bounded: true, leader: 'none', endpoint: 'none' } }) as number;
      tab.commands.execute('layout.shape.rotate', { pageId, entityId: text, pivot: [180, 30], angleDeg: 30 });
    });
    const entity = (id: number) => tab.doc.state.pages.get(pageId)!.entities.get(id) ?? tab.doc.state.sharedEntities.get(id)!;
    const unmoved = ({ points: _points, handles: _handles, ...rest }: ReturnType<typeof entity>) => rest;
    const before = [a, b, text].map((id) => entity(id));
    expect(before[0]!.groupId).toBeDefined(); expect(before[1]!.groupId).toBe(before[0]!.groupId);
    expect(before[2]!.text!.rotationDeg).toBe(30);
    useMove();
    click(40, 30); click(50, 40); // Clicking A moves its whole group.
    expect(entity(a).points[0]).toEqual([30, 30]); expect(entity(b).points[0]).toEqual([110, 110]);
    expect(screen.getByText('2 objects selected')).toBeTruthy();
    click(180, 30); click(180, 40);
    expectPoints(entity(text).points, before[2]!.points.map(([x, y]) => [x, y + 10]));
    expect(tab.doc.state.sharedEntities.has(text)).toBe(true); expect(page().entities.has(text)).toBe(false);
    [a, b, text].forEach((id, index) => expect(unmoved(entity(id))).toEqual(unmoved(before[index]!)));
    dispose();
  });

  it('moves the whole selection from a selected object or from empty paper', () => {
    const { a, b, click, points, useMove, dispose } = setup();
    click(120, 110); click(40, 20, { shiftKey: true }); // B, then A by its stroke.
    expect(screen.getByText('2 objects selected')).toBeTruthy();
    useMove();
    click(120, 110); click(130, 115);
    expect(points(a)).toEqual(shifted(A, 10, 5)); expect(points(b)[0]).toEqual([110, 105]);
    click(200, 150); click(190, 150); // Empty paper with a selection moves the selection.
    expect(points(a)).toEqual(shifted(A, 0, 5)); expect(points(b)[0]).toEqual([100, 105]);
    expect(screen.getByText('2 objects selected')).toBeTruthy();
    dispose();
  });

  it('chooses nothing on empty paper when nothing is selected', () => {
    const { tab, click, move, readout, status, alert, useMove, dispose } = setup();
    useMove();
    const version = tab.doc.version;
    click(200, 150); move(220, 150);
    expect(readout()).toBeNull(); expect(alert()).toBeNull();
    expect(status()).toContain('choose the base point');
    click(220, 150);
    expect(tab.doc.version).toBe(version);
    dispose();
  });

  it('leaves locked and hidden objects in place and selected, and chooses nothing when none can move', () => {
    const { tab, pageId, a, b, click, points, readout, alert, useMove, dispose } = setup();
    let c = 0, layer = 0;
    act(() => {
      layer = tab.commands.execute('layout.layer.add', { name: 'Other' }) as number;
      c = tab.commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [100, 20], second: [140, 40] }) as number;
    });
    click(120, 110); click(40, 20, { shiftKey: true }); click(120, 30, { shiftKey: true });
    act(() => {
      tab.commands.execute('layout.shape.setLocked', { pageId, entityIds: [a], locked: true });
      tab.commands.execute('layout.layer.setVisible', { layerId: layer, visible: false });
    });
    useMove();
    click(120, 110); click(120, 130);
    expect(points(b)[0]).toEqual([100, 120]);
    expect(points(a)).toEqual(A); expect(points(c)[0]).toEqual([100, 20]);
    expect(screen.getByText('3 objects selected')).toBeTruthy();
    act(() => { tab.commands.execute('layout.layer.setLocked', { layerId: tab.doc.state.layerOrder[0]!, locked: true }); });
    const version = tab.doc.version;
    click(120, 130);
    expect(readout()).toBeNull(); expect(alert()).toContain('cannot be moved');
    click(130, 140);
    expect(tab.doc.version).toBe(version);
    dispose();
  });

  it('previews without touching the document, snaps only to objects that stay, and constrains with Shift', async () => {
    const { tab, session, pageId, a, click, move, points, readout, useMove, dispose } = setup();
    const lineTo = vi.fn(), setLineDash = vi.fn();
    const methods = new Map<string | symbol, unknown>([['lineTo', lineTo], ['setLineDash', setLineDash]]);
    const context = new Proxy({}, { get: (_target, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); },
      set: (_target, key, value) => { methods.set(key, value); return true; } });
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context as CanvasRenderingContext2D);
    useMove();
    const version = tab.doc.version, saved = (await session.saveLayoutBytes(tab.id));
    click(20.5, 20.5);
    move(60.6, 40.6); // A's own corner does not attract the destination.
    expect(readout()).toBe('40.6 mm, 20.6 mm');
    expect(lineTo).toHaveBeenCalledWith(expect.closeTo(60.6, 5), expect.closeTo(40.6, 5));
    expect(setLineDash.mock.calls.some(([dash]) => (dash as number[]).length > 0)).toBe(true);
    move(70.3, 33.3, { shiftKey: true });
    expect(readout()).toBe('50.3 mm, 0.0 mm');
    move(100.6, 100.6); // B's corner does.
    expect(readout()).toBe('80.0 mm, 80.0 mm');
    expect(tab.doc.version).toBe(version);
    expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state).toEqual((await openLayoutFile(saved)).state);
    click(100.6, 100.6);
    expect(points(a)).toEqual(shifted(A, 80, 80));
    act(() => { tab.commands.execute('edit.undo'); });
    expect(points(a)).toEqual(A);
    click(20.5, 20.5); click(70.3, 33.3, { shiftKey: true });
    expectPoints(points(a), shifted(A, 50.3, 0));
    act(() => { tab.commands.execute('edit.undo'); });
    expect(points(a)).toEqual(A);
    act(() => { tab.commands.execute('edit.redo'); });
    expectPoints(points(a), shifted(A, 50.3, 0));
    expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)!.entities.get(a)).toEqual(tab.doc.state.pages.get(pageId)!.entities.get(a));
    dispose();
  });

  it('does not snap to dimensions and labels that follow the moving objects', () => {
    const { tab, pageId, a, click, move, page, readout, useMove, dispose } = setup();
    let dimension = 0;
    act(() => {
      tab.commands.execute('layout.text.add', { pageId, kind: 'label', points: [[160, 50], [200, 60], [20, 20]],
        labelAnchor: { entityId: a, pointIndex: 0, pointCount: 4 },
        text: { content: 'Note', fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false, italic: false,
          underline: false, align: 'left', vertical: 'middle', bounded: true, leader: 'straight', endpoint: 'arrow' } });
      dimension = tab.commands.execute('layout.dimension.add', { pageId, points: [[20, 40], [60, 40], [40, 70]],
        anchors: [3, 2].map((pointIndex) => ({ entityId: a, pointIndex, pointCount: 4 })) }) as number;
    });
    const bounds = layoutEntityBounds(page().entities.get(dimension)!)!;
    const centre = [(bounds.minX + bounds.maxX) / 2 + 0.6, (bounds.minY + bounds.maxY) / 2 + 0.6] as const;
    useMove();
    click(40, 30);
    move(20.6, 20.6); // The attached label's tip follows A, so it does not attract the destination.
    expect(readout()).toBe('-19.4 mm, -9.4 mm');
    move(...centre); // Nor does the centre of A's associated dimension.
    expect(readout()).toBe(`${(centre[0] - 40).toFixed(1)} mm, ${(centre[1] - 30).toFixed(1)} mm`);
    dispose();
  });

  it('moves labels whole and keeps associated dimensions following their objects', () => {
    const { tab, pageId, a, click, page, points, useMove, dispose } = setup();
    let label = 0, dimension = 0;
    act(() => {
      label = tab.commands.execute('layout.text.add', { pageId, kind: 'label', points: [[160, 50], [200, 60], [150, 30], [160, 55]],
        text: { content: 'Note', fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false, italic: false,
          underline: false, align: 'left', vertical: 'middle', bounded: true, leader: 'elbow', endpoint: 'arrow' } }) as number;
      dimension = tab.commands.execute('layout.dimension.add', { pageId, points: [[20, 40], [60, 40], [40, 55]],
        anchors: [3, 2].map((pointIndex) => ({ entityId: a, pointIndex, pointCount: 4 })) }) as number;
    });
    useMove();
    click(180, 55); click(190, 75);
    expect(points(label)).toEqual([[170, 70], [210, 80], [160, 50], [170, 75]]);
    click(40, 30); click(40, 40);
    expect(points(dimension).slice(0, 2)).toEqual([[20, 50], [60, 50]]);
    expect(page().entities.get(dimension)!.dimension!.anchors[0]?.entityId).toBe(a);
    dispose();
  });

  it('toggles copying with Ctrl or Alt and places selected copies directly above their originals', () => {
    const { tab, a, b, canvas, click, move, measure, page, points, readout, status, selected, useMove, tap, dispose } = setup();
    useMove();
    click(40, 30);
    for (const key of ['Control', 'Alt']) {
      const event = createEvent.keyDown(window, { key });
      fireEvent(window, event);
      expect(event.defaultPrevented).toBe(true);
      expect(status()).toMatch(/^Move:/); // Pressing alone is not yet a tap.
      fireEvent.keyUp(window, { key });
      expect(status()).toMatch(/^Copy:/); expect(readout()).toMatch(/^Copy /);
      tap(key);
      expect(status()).toMatch(/^Move:/); expect(readout()).not.toMatch(/Copy/);
    }
    // Chords are not taps: Ctrl+wheel zoom and Ctrl+Z leave copy mode alone.
    fireEvent.keyDown(window, { key: 'Control' }); fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -100 }); fireEvent.keyUp(window, { key: 'Control' });
    expect(status()).toMatch(/^Move:/);
    fireEvent.keyDown(window, { key: 'Control' }); fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    fireEvent.keyUp(window, { key: 'z', ctrlKey: true }); fireEvent.keyUp(window, { key: 'Control' });
    expect(status()).toMatch(/^Move:/);
    act(() => { tab.commands.execute('edit.redo'); });
    // A tap still toggles while Measurements has focus after typing a length.
    move(40, 40);
    fireEvent.keyDown(window, { key: '5', code: 'Digit5' });
    const input = screen.getByLabelText('Layout Measurements');
    expect(document.activeElement).toBe(input);
    tap('Alt', input);
    expect(status()).toMatch(/^Copy:/);
    measure('50');
    const copy = page().entityOrder[1]!;
    expect(page().entityOrder).toEqual([a, copy, b]);
    expect(points(a)).toEqual(A); expect(points(copy)).toEqual(shifted(A, 0, 50));
    expect(page().entities.get(copy)!.style).toEqual(page().entities.get(a)!.style);
    expect(selected()).toBe(copy);
    act(() => { tab.commands.execute('edit.undo'); });
    expect(page().entityOrder).toEqual([a, b]);
    dispose();
  });

  it('commits exact distances and x, y offsets from Measurements, rejecting bad input while the move stays pending', () => {
    const { tab, a, click, move, measure, points, readout, alert, useMove, dispose } = setup();
    useMove();
    click(40, 30); move(43, 34);
    measure('25');
    expectPoints(points(a), shifted(A, 15, 20));
    click(40, 30); move(45, 33, { shiftKey: true });
    measure('10');
    expectPoints(points(a), shifted(A, 25, 20));
    click(50, 50); measure('10, -5');
    expectPoints(points(a), shifted(A, 35, 15));
    const version = tab.doc.version;
    click(50, 50); measure('abc');
    expect(alert()).toBeTruthy(); expect(readout()).not.toBeNull();
    measure('[1,2]');
    expect(alert()).toBeTruthy(); expect(readout()).not.toBeNull();
    measure('20'); // No direction yet: the pointer has not moved from the base point.
    expect(alert()).toBeTruthy(); expect(tab.doc.version).toBe(version);
    act(() => { tab.doc.undoStack.transact('Inches', (draft) => { draft.settings.units = 'inch'; }); });
    measure('1, 0');
    expectPoints(points(a), shifted(A, 60.4, 15));
    measure('5');
    expect(alert()).toContain('base point');
    dispose();
  });

  it('turns the latest copy into an array that one Undo removes, and rejects invalid or late arrays', () => {
    const { tab, view, session, pageId, a, b, click, measure, page, points, alert, useMove, tap, dispose } = setup();
    let second = 0;
    act(() => { second = tab.commands.execute('layout.page.add') as number; session.setActivePage(pageId); });
    view.rerender(<LayoutWorkspace tab={tab} session={session} />);
    const copyAcross = () => { click(20.5, 20.5); tap('Control'); click(50, 20); };
    const copiesX = () => page().entityOrder.filter((id) => id !== a && id !== b).map((id) => points(id)[0]![0]);
    useMove();
    copyAcross();
    measure('3x');
    expect(copiesX()).toEqual([50, 80, 110]);
    expect(page().entityOrder.slice(0, 4)).toEqual([a, ...page().entityOrder.slice(1, 4)]);
    expect(screen.getByText('3 objects selected')).toBeTruthy();
    act(() => { tab.commands.execute('edit.undo'); });
    expect(page().entityOrder).toEqual([a, b]);
    copyAcross(); measure('*2');
    expect(copiesX()).toEqual([50, 80]);
    act(() => { tab.commands.execute('edit.undo'); });
    copyAcross(); measure('/3');
    expect(copiesX()).toEqual([30, 40, 50]);
    expect(points(a)).toEqual(A);
    act(() => { tab.commands.execute('edit.undo'); });
    copyAcross();
    const version = tab.doc.version;
    for (const input of ['0x', '2.5x']) {
      measure(input);
      expect(alert()).toBeTruthy(); expect(tab.doc.version).toBe(version);
    }
    click(40, 30); fireEvent.keyDown(window, { key: 'Escape' }); // Choosing another base point ends the chance.
    measure('2x');
    expect(alert()).toContain('array'); expect(tab.doc.version).toBe(version);
    act(() => { tab.commands.execute('edit.undo'); });
    copyAcross();
    fireEvent.keyDown(window, { key: 'q', code: 'KeyQ' }); fireEvent.keyDown(window, { key: 'm', code: 'KeyM' });
    measure('2x');
    expect(alert()).toContain('array'); expect(copiesX()).toEqual([50]);
    act(() => { tab.commands.execute('edit.undo'); });
    // Changing pages ends the chance, even coming straight back with no edits.
    copyAcross();
    act(() => { session.setActivePage(second); });
    view.rerender(<LayoutWorkspace tab={tab} session={session} />);
    act(() => { session.setActivePage(pageId); });
    view.rerender(<LayoutWorkspace tab={tab} session={session} />);
    measure('2x');
    expect(alert()).toContain('array'); expect(copiesX()).toEqual([50]);
    act(() => { tab.commands.execute('edit.undo'); });
    // Any later edit ends it too, so an array never undoes that edit in place of the copy.
    copyAcross();
    const copy = page().entityOrder[1]!;
    act(() => { tab.commands.execute('layout.shape.setStyle', { pageId, entityId: copy, strokeColor: '#ff0000' }); });
    const edited = tab.doc.version, order = [...page().entityOrder];
    measure('2x');
    expect(alert()).toContain('array'); expect(tab.doc.version).toBe(edited); expect(page().entityOrder).toEqual(order);
    expect(page().entities.get(copy)!.style?.strokeColor).toBe('#ff0000');
    act(() => { tab.commands.execute('edit.undo'); tab.commands.execute('edit.undo'); });
    expect(page().entityOrder).toEqual([a, b]);
    // So does undoing the copy: the array does not bring it back.
    copyAcross();
    act(() => { tab.commands.execute('edit.undo'); });
    const undone = tab.doc.version;
    measure('2x');
    expect(alert()).toContain('array'); expect(tab.doc.version).toBe(undone); expect(page().entityOrder).toEqual([a, b]);
    dispose();
  });

  it('adds no undo step for a zero move and cancels on Escape, pointer cancel, tool and page changes, and lost objects', () => {
    const { tab, view, session, pageId, a, canvas, click, move, points, readout, selected, useMove, dispose } = setup();
    useMove();
    const version = tab.doc.version;
    click(40, 30); click(40, 30);
    expect(tab.doc.version).toBe(version); expect(readout()).toBeNull();
    const cancelled = (cancel: () => void) => {
      click(40, 30); move(70, 90);
      expect(readout()).not.toBeNull();
      cancel();
      expect(readout()).toBeNull();
      expect(points(a)).toEqual(A); expect(tab.doc.version).toBe(version);
    };
    cancelled(() => fireEvent.keyDown(window, { key: 'Escape' }));
    expect(selected()).toBe(a);
    cancelled(() => fireEvent.pointerCancel(canvas));
    cancelled(() => fireEvent.click(screen.getByRole('button', { name: 'Rotate' })));
    useMove();
    let second = 0;
    act(() => { second = tab.commands.execute('layout.page.add') as number; session.setActivePage(pageId); });
    const pageVersion = tab.doc.version;
    click(40, 30); move(70, 90);
    act(() => { session.setActivePage(second); });
    view.rerender(<LayoutWorkspace tab={tab} session={session} />);
    expect(readout()).toBeNull();
    act(() => { session.setActivePage(pageId); });
    view.rerender(<LayoutWorkspace tab={tab} session={session} />);
    click(40, 30); move(70, 90);
    act(() => { tab.commands.execute('layout.shape.setLocked', { pageId, entityIds: [a], locked: true }); });
    expect(readout()).toBeNull();
    expect(points(a)).toEqual(A); expect(tab.doc.version).toBe(pageVersion + 1);
    dispose();
  });
});
