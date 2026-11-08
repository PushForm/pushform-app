// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LayoutEntity } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { enterLayoutValue, layoutEntryField } from './layoutEntryTesting';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const TEXT = { content: 'Note', fontFamily: 'Arial', fontSizePt: 10, color: '#222222', bold: false, italic: false,
  underline: false, align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none' } as const;

/** Two filled squares and a text box below the first, on a page drawn at 3 screen pixels per millimeter, with snapping off. */
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  tab.commands.execute('layout.grid.set', { snap: false });
  tab.commands.execute('layout.snap.set', { enabled: false });
  tab.commands.execute('layout.style.setDefault', { fillColor: '#ffffff' });
  const a = tab.commands.execute('layout.shape.add', { pageId, points: [[10, 10], [30, 10], [30, 30], [10, 30]], closed: true }) as number;
  const b = tab.commands.execute('layout.shape.add', { pageId, points: [[50, 10], [70, 10], [70, 30], [50, 30]], closed: true }) as number;
  const t = tab.commands.execute('layout.text.add', { pageId, kind: 'text', points: [[10, 40], [30, 50]], text: TEXT }) as number;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const at = (x: number, y: number, init: Record<string, unknown> = {}) => ({ button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3, ...init });
  const click = (x: number, y: number): void => {
    fireEvent.pointerDown(canvas, at(x, y, { buttons: 1 }));
    fireEvent.pointerUp(canvas, at(x, y));
  };
  const hover = (x: number, y: number): void => { fireEvent.pointerMove(canvas, at(x, y, { buttons: 0 })); };
  const entity = (id: number): LayoutEntity => tab.doc.state.pages.get(pageId)!.entities.get(id)!;
  const points = (id: number) => entity(id).points;
  const expectPoints = (id: number, expected: [number, number][]): void => {
    expect(points(id)).toHaveLength(expected.length);
    points(id).forEach((point, index) => {
      expect(point[0]).toBeCloseTo(expected[index]![0], 9);
      expect(point[1]).toBeCloseTo(expected[index]![1], 9);
    });
  };
  const status = (): string => document.querySelector('.pf-layout-footer-spacer')?.textContent ?? '';
  const error = (): string | null => document.querySelector('.pf-layout-vcb-error')?.textContent ?? null;
  const run = (id: string, params?: Record<string, unknown>): void => { act(() => { tab.commands.execute(id, params); }); };
  const dispose = (): void => { session.dispose(); app.dispose(); };
  return { tab, pageId, a, b, t, canvas, click, hover, entity, points, expectPoints, status, error, run, dispose };
}

const A: [number, number][] = [[10, 10], [30, 10], [30, 30], [10, 30]];

it('scales what its first click picks up by reference, about a fixed base point, as one undoable step', () => {
  const { tab, pageId, a, b, t, canvas, click, hover, points, expectPoints, status, run, dispose } = setup();
  run('layout.shape.group', { pageId, entityIds: [a, b] });
  run('tool.scale');
  expect(status()).toContain('to choose the base point');
  // A click on a member picks up its whole group; the base point is the square's corner.
  click(10, 10);
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  expect(status()).toContain('Click a reference point');
  // Scale shows no resize handles or rotation grip.
  expect(screen.queryByLabelText('Selected objects bounds')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Rotation handle' })).toBeNull();
  click(30, 10);
  // The pointer 40 mm from the base point, against a 20 mm reference, previews double the size.
  const version = tab.doc.version;
  hover(50, 10);
  expect(tab.doc.version).toBe(version);
  expect(layoutEntryField('Scale').value).toBe('200%');
  expect(status()).toContain('Scale: 200%');
  click(50, 10);
  expectPoints(a, [[10, 10], [50, 10], [50, 50], [10, 50]]);
  expectPoints(b, [[90, 10], [130, 10], [130, 50], [90, 50]]);
  expect(points(t)).toEqual([[10, 40], [30, 50]]);
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  expect(canvas.getAttribute('data-tool')).toBe('scale');
  expect(status()).toContain('to choose the base point');
  run('edit.undo');
  expect(points(a)).toEqual(A);
  expect(points(b)).toEqual([[50, 10], [70, 10], [70, 30], [50, 30]]);
  dispose();
});

it('shows Scale, Length, Width and Height in the tool options bar, waiting until the base point and then focusing Scale', () => {
  const { click, hover, status, run, dispose } = setup();
  run('tool.scale');
  const bar = screen.getByRole('toolbar', { name: 'Scale options' });
  for (const label of ['Scale', 'Length', 'Width', 'Height']) expect(layoutEntryField(label).disabled).toBe(true);
  click(10, 10);
  expect(document.activeElement).toBe(layoutEntryField('Scale'));
  expect(layoutEntryField('Scale').value).toBe('100%');
  // The square is 20 mm wide and high; the new length waits for the reference point.
  expect(layoutEntryField('Width').value).toBe('20.0 mm'); expect(layoutEntryField('Height').value).toBe('20.0 mm');
  expect(layoutEntryField('Length').disabled).toBe(true);
  click(30, 10); hover(40, 10);
  expect(layoutEntryField('Length').disabled).toBe(false);
  expect(layoutEntryField('Length').value).toBe('30.0 mm');
  expect(layoutEntryField('Width').value).toBe('30.0 mm');
  // Beside the pointer only the percentage shows, and the bar stays solid between the clicks.
  expect(screen.getByLabelText('Scale preview').textContent).toBe('150%');
  expect(bar.className).not.toContain('is-placing');
  expect(status()).toContain('Scale: 150%');
  dispose();
});

it('scales to a typed width or height, keeping proportions, and a value left with Tab is committed by the next click', () => {
  const { tab, a, click, hover, expectPoints, run, dispose } = setup();
  const typeIn = (label: string, value: string, key: 'Enter' | 'Tab' = 'Enter') => {
    const input = layoutEntryField(label);
    act(() => { input.focus(); });
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key });
  };
  run('tool.scale');
  // No reference point is needed: the base point and a width are enough.
  click(10, 10);
  typeIn('Width', '50');
  expectPoints(a, [[10, 10], [60, 10], [60, 60], [10, 60]]);
  run('edit.undo');
  click(10, 10);
  typeIn('Height', '10', 'Tab');
  expect(layoutEntryField('Height').className).toContain('is-locked');
  expect(screen.getByLabelText('Scale preview').textContent).toBe('50%');
  // The pointer no longer changes a locked scale; the next click commits it.
  const version = tab.doc.version;
  click(30, 10); hover(70, 10);
  expectPoints(a, [[10, 10], [20, 10], [20, 20], [10, 20]]);
  expect(tab.doc.version).not.toBe(version);
  run('edit.undo');
  // Typing in another field releases the lock.
  click(10, 10);
  typeIn('Height', '10', 'Tab');
  typeIn('Scale', '300%', 'Tab');
  expect(layoutEntryField('Height').className).not.toContain('is-locked');
  expect(layoutEntryField('Width').value).toBe('60.0 mm');
  dispose();
});

it('takes a typed factor or percentage after the base point, and a length with its unit after the reference point', () => {
  const { a, click, expectPoints, error, run, dispose } = setup();
  run('tool.scale');
  click(10, 10);
  enterLayoutValue('50%');
  expectPoints(a, [[10, 10], [20, 10], [20, 20], [10, 20]]);
  run('edit.undo');
  click(10, 10);
  enterLayoutValue('2');
  expectPoints(a, [[10, 10], [50, 10], [50, 50], [10, 50]]);
  run('edit.undo');
  // A length is the reference's new length, so it waits for the reference point.
  click(10, 10);
  enterLayoutValue('40mm');
  expect(error()).toContain('Click a reference point');
  expectPoints(a, A);
  click(30, 10);
  enterLayoutValue('60mm');
  expectPoints(a, [[10, 10], [70, 10], [70, 70], [10, 70]]);
  run('edit.undo');
  // Nothing scales by zero, and other input is refused; the scale stays pending.
  click(10, 10);
  enterLayoutValue('0');
  expect(error()).toContain('greater than zero');
  enterLayoutValue('45°');
  expect(error()).toContain('Enter a scale factor');
  enterLayoutValue('300%');
  expectPoints(a, [[10, 10], [70, 10], [70, 70], [10, 70]]);
  dispose();
});

it('refuses the base point as a reference, changes nothing at 100%, and Esc cancels while keeping the selection', () => {
  const { tab, a, b, click, hover, points, error, status, run, dispose } = setup();
  // Select both squares with a selection box, then scale them.
  const canvas = screen.getByLabelText('Page 1 canvas');
  fireEvent.pointerDown(canvas, { button: 0, buttons: 1, pointerId: 1, clientX: 15, clientY: 15 });
  fireEvent.pointerMove(canvas, { buttons: 1, pointerId: 1, clientX: 225, clientY: 105 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 225, clientY: 105 });
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  run('tool.scale');
  // Empty paper keeps the selection and becomes the base point.
  click(40, 20);
  click(40, 20);
  expect(error()).toContain('away from the base point');
  click(50, 20);
  const version = tab.doc.version;
  click(50, 20);
  expect(tab.doc.version).toBe(version);
  click(40, 20); click(50, 20); hover(60, 20);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(points(a)).toEqual(A);
  expect(points(b)).toEqual([[50, 10], [70, 10], [70, 30], [50, 30]]);
  expect(status()).toContain('to choose the base point');
  expect(screen.getByText('2 objects selected')).toBeTruthy();
  dispose();
});

it('scales one text box with its type, and refuses locked objects', () => {
  const { pageId, b, t, click, entity, expectPoints, error, run, dispose } = setup();
  click(20, 45);
  run('tool.scale');
  click(10, 40);
  enterLayoutValue('200%');
  expectPoints(t, [[10, 40], [50, 60]]);
  expect(entity(t).text!.fontSizePt).toBe(20);
  run('layout.shape.setLocked', { pageId, entityIds: [b], locked: true });
  run('tool.select'); click(150, 150); run('tool.scale');
  click(60, 20);
  expect(error()).toBe('Locked or hidden objects cannot be scaled.');
  dispose();
});

it('snaps the base and reference points to the objects being scaled, and the target only to other objects', () => {
  const { a, click, hover, expectPoints, status, run, dispose } = setup();
  run('layout.snap.set', { enabled: true });
  run('tool.scale');
  click(10.5, 10.4);
  click(30.4, 10.3);
  // The square's own midpoint is not a target, so the factor follows the pointer.
  hover(20.3, 10.2);
  expect(status()).not.toContain('Scale: 50%');
  // The other square's corner is: the marker shows it and the factor is exact.
  hover(50.4, 10.3);
  expect(document.querySelector('.pf-layout-placement-marker')?.getAttribute('data-snap')).toBe('endpoint');
  expect(layoutEntryField('Scale').value).toBe('200%');
  click(50.4, 10.3);
  expectPoints(a, [[10, 10], [50, 10], [50, 50], [10, 50]]);
  dispose();
});
