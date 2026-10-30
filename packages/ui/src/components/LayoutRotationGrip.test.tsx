// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { layoutEntityBounds } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** A 50 × 20 mm rectangle (70–120, 50–70 mm, center 95, 60), or a label, selected with Select; the page shows 3 px per mm. */
function setup(kind: 'rectangle' | 'label' | 'text' = 'rectangle') {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}) });
  const app = createApp({ demo: false, expose: false }), session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  const id = kind === 'rectangle'
    ? tab.commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [70, 50], second: [120, 70] }) as number
    : tab.commands.execute('layout.text.add', { pageId, kind,
      points: kind === 'label' ? [[70, 50], [120, 70], [10, 40], [40, 60]] : [[70, 50], [120, 70]],
      text: { content: 'Turn me', fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false, italic: false,
        underline: false, align: 'left', vertical: 'middle', bounded: true, leader: kind === 'label' ? 'elbow' : 'none', endpoint: 'arrow' },
    }) as number;
  const entity = () => tab.doc.state.pages.get(pageId)!.entities.get(id)!;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  const at = (x: number, y: number, pointerId = 1) => ({ button: 0, pointerId, clientX: x * 3, clientY: y * 3 });
  const click = (x: number, y: number) => { fireEvent.pointerDown(canvas, at(x, y)); fireEvent.pointerUp(canvas, at(x, y)); };
  click(95, 60);
  const grip = () => screen.getByLabelText('Center of rotation').parentElement!;
  const bounds = () => layoutEntityBounds(entity())!;
  /** Drags the rotation handle to the page point (x, y), and releases it there unless `release` is false. */
  const turn = (x: number, y: number, release = true) => {
    const handle = screen.getByRole('button', { name: 'Rotation handle' });
    fireEvent.pointerDown(handle, at(0, 0, 2)); fireEvent.pointerMove(handle, at(x, y, 2));
    if (release) fireEvent.pointerUp(handle, at(x, y, 2));
  };
  const moveCenter = (x: number, y: number) => {
    const center = screen.getByLabelText('Center of rotation');
    fireEvent.pointerDown(center, at(0, 0, 3)); fireEvent.pointerMove(center, at(x, y, 3)); fireEvent.pointerUp(center, at(x, y, 3));
  };
  return { tab, entity, bounds, grip, turn, moveCenter, click, dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}
const close = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 6);

describe('Layout rotation grip', () => {
  it('shows a center of rotation in the middle of the selected object with a rotation handle, but not on labels', () => {
    const { grip, dispose } = setup();
    expect(grip().style.left).toBe('50%');
    expect(grip().style.top).toBe('50%');
    expect(screen.getByRole('button', { name: 'Rotation handle' })).toBeTruthy();
    dispose();
    setup('label');
    expect(screen.queryByLabelText('Center of rotation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rotation handle' })).toBeNull();
  });

  it('rotates the object about its center as the handle is dragged, in one undoable step', () => {
    const { tab, entity, bounds, turn, dispose } = setup();
    const before = entity(), version = tab.doc.version;
    // The handle starts to the right of the center; straight below it is a quarter turn clockwise.
    turn(95, 90, false);
    expect(screen.getByLabelText('Rotation angle preview').textContent).toBe('90.0°');
    expect(tab.doc.version).toBe(version);
    expect(entity()).toEqual(before);
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Rotation handle' }), { button: 0, pointerId: 2, clientX: 95 * 3, clientY: 90 * 3 });
    close(bounds().minX, 85); close(bounds().maxX, 105); close(bounds().minY, 35); close(bounds().maxY, 85);
    expect(screen.queryByLabelText('Rotation angle preview')).toBeNull();
    // Still selected, with the center where it was on the page.
    expect(screen.getByLabelText('Center of rotation').parentElement!.style.left).toBe('50%');
    tab.commands.execute('edit.undo');
    expect(entity()).toEqual(before);
    dispose();
  });

  it('holds the angle at quarter turns near them, as the Rotate tool does', () => {
    const { bounds, turn, dispose } = setup();
    // 1 mm off a quarter turn, 30 mm out, is within 8 screen pixels (2.7 mm).
    turn(96, 90);
    close(bounds().minX, 85); close(bounds().maxX, 105);
    dispose();
  });

  it('moves the center within the box, snaps it back to the middle, and rotates about it', () => {
    const { bounds, grip, moveCenter, turn, dispose } = setup();
    moveCenter(110, 65);
    expect(parseFloat(grip().style.left)).toBeCloseTo(80);
    expect(parseFloat(grip().style.top)).toBeCloseTo(75);
    // Dragged outside, it stays on the box's edge; dropped near the middle, it goes back to it.
    moveCenter(200, 10);
    expect(grip().style.left).toBe('100%'); expect(grip().style.top).toBe('0%');
    moveCenter(96, 61);
    expect(grip().style.left).toBe('50%'); expect(grip().style.top).toBe('50%');
    moveCenter(120, 70);
    // A quarter turn clockwise about the corner (120, 70): the rectangle now spans x 120–140, y 20–70.
    turn(120, 100);
    close(bounds().minX, 120); close(bounds().maxX, 140); close(bounds().minY, 20); close(bounds().maxY, 70);
    dispose();
  });

  it('leaves the document alone when Escape cancels the drag or it ends at 0°', () => {
    const { tab, entity, turn, dispose } = setup();
    const before = entity(), version = tab.doc.version;
    turn(95, 90, false);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByLabelText('Rotation angle preview')).toBeNull();
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Rotation handle' }), { button: 0, pointerId: 2, clientX: 95 * 3, clientY: 90 * 3 });
    expect(entity()).toEqual(before);
    turn(130, 60);
    expect(tab.doc.version).toBe(version);
    dispose();
  });

  it('puts the center back in the middle once the object is selected again', () => {
    const { grip, moveCenter, click, dispose } = setup();
    moveCenter(110, 65);
    expect(grip().style.left).not.toBe('50%');
    click(5, 5);
    expect(screen.queryByLabelText('Center of rotation')).toBeNull();
    click(95, 60);
    expect(grip().style.left).toBe('50%');
    dispose();
  });

  it('turns a text box with its text', () => {
    const { entity, turn, dispose } = setup('text');
    turn(95, 90);
    expect(entity().text?.rotationDeg).toBeCloseTo(90);
    dispose();
  });
});
