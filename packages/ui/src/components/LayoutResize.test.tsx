// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { layoutEntityBounds, layoutTextCenter, rotateLayoutPoint, type LayoutEntity } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
type Kind = 'path' | 'image' | 'text' | 'label';
function frame(entity: LayoutEntity) {
  const angle = entity.image ? Math.atan2(entity.points[1]![1] - entity.points[0]![1], entity.points[1]![0] - entity.points[0]![0]) * 180 / Math.PI
    : entity.text?.rotationDeg ?? 0;
  const bounds = layoutEntityBounds(entity)!;
  const width = entity.image ? Math.hypot(entity.points[1]![0] - entity.points[0]![0], entity.points[1]![1] - entity.points[0]![1])
    : entity.text ? entity.points[1]![0] - entity.points[0]![0] : bounds.maxX - bounds.minX;
  const height = entity.image ? Math.hypot(entity.points[3]![0] - entity.points[0]![0], entity.points[3]![1] - entity.points[0]![1])
    : entity.text ? entity.points[1]![1] - entity.points[0]![1] : bounds.maxY - bounds.minY;
  const center: [number, number] = entity.image ? [(entity.points[0]![0] + entity.points[2]![0]) / 2, (entity.points[0]![1] + entity.points[2]![1]) / 2]
    : entity.text ? layoutTextCenter(entity) : [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
  return { width, height, center, angle };
}
function setup(kind: Kind, angle = 0, scaleTool = false) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}) });
  const app = createApp({ demo: false, expose: false }), session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  let id: number;
  if (kind === 'image') {
    id = (tab.commands.execute('layout.clipboard.paste', { pageId, entities: [{ kind, points: [[0, 0], [50, 0], [50, 20], [0, 20]], closed: true,
      image: { src: 'data:image/png;base64,eA==' } }] }) as number[])[0]!;
  } else if (kind === 'path') {
    id = tab.commands.execute('layout.rectangle.add', { pageId, kind: 'rectangle', first: [70, 50], second: [120, 70] }) as number;
  } else {
    id = tab.commands.execute('layout.text.add', { pageId, kind,
      points: kind === 'label' ? [[70, 50], [120, 70], [10, 40], [40, 60]] : [[70, 50], [120, 70]],
      text: { content: 'Resize me', fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false, italic: false,
        underline: false, align: 'left', vertical: 'middle', bounded: true, leader: kind === 'label' ? 'elbow' : 'none', endpoint: 'arrow' },
    }) as number;
  }
  if (angle) tab.commands.execute('layout.shape.rotate', { pageId, entityId: id, angleDeg: angle });
  const entity = () => tab.doc.state.pages.get(pageId)!.entities.get(id)!;
  render(<LayoutWorkspace tab={tab} session={session} />);
  if (scaleTool) fireEvent.click(screen.getByRole('button', { name: 'Scale' }));
  const canvas = screen.getByLabelText('Page 1 canvas'), center = frame(entity()).center;
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: center[0] * 3, clientY: center[1] * 3 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: center[0] * 3, clientY: center[1] * 3 });
  const previewRatio = () => {
    const box = screen.getByLabelText('Selected object bounds');
    return parseFloat(box.style.width) * 297 / (parseFloat(box.style.height) * 210);
  };
  const handle = (side: string) => screen.getByRole('button', { name: `${kind === 'path' ? 'Scale' : kind === 'image' ? 'Resize image' : 'Resize text'} ${side}` });
  const pointer = (x: number, y: number, shiftKey = false) => ({ button: 0, pointerId: 2, clientX: x * 3, clientY: y * 3, shiftKey });
  return { tab, session, pageId, id, entity, previewRatio, handle, pointer,
    dispose: () => { cleanup(); session.dispose(); app.dispose(); } };
}

for (const kind of ['path', 'image', 'text', 'label'] as const) {
  it.each([0, 30])(`preserves ${kind} aspect ratio when Shift is held, including %s-degree rotation`, async angle => {
    const { tab, session, pageId, id, entity, previewRatio, handle, pointer, dispose } = setup(kind, angle);
    const original = entity(), f = frame(original), ratio = f.width / f.height, version = tab.doc.version;
    const corner = rotateLayoutPoint([f.center[0] + f.width / 2, f.center[1] + f.height / 2], f.center, f.angle);
    const delta = rotateLayoutPoint([20, 2], [0, 0], f.angle), end: [number, number] = [corner[0] + delta[0], corner[1] + delta[1]];
    const button = handle('bottom right');
    fireEvent.pointerDown(button, pointer(...corner)); fireEvent.pointerMove(button, pointer(...end));
    expect(previewRatio()).not.toBeCloseTo(ratio);
    // Modifier changes update the existing preview without another pointer move.
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true }); expect(previewRatio()).toBeCloseTo(ratio);
    fireEvent.keyUp(window, { key: 'Shift', shiftKey: false }); expect(previewRatio()).not.toBeCloseTo(ratio);
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true }); expect(previewRatio()).toBeCloseTo(ratio);
    expect(tab.doc.version).toBe(version); expect(entity()).toEqual(original);
    fireEvent.pointerUp(button, pointer(...end, true));
    expect(frame(entity()).width / frame(entity()).height).toBeCloseTo(ratio);
    if (original.text) expect(entity().text?.fontSizePt).toBe(original.text.fontSizePt);
    if (original.kind === 'label') {
      for (const index of [2, 3]) {
        const before = rotateLayoutPoint(original.points[index]!, layoutTextCenter(original), angle);
        const after = rotateLayoutPoint(entity().points[index]!, layoutTextCenter(entity()), angle);
        expect(after[0]).toBeCloseTo(before[0]); expect(after[1]).toBeCloseTo(before[1]);
      }
    }
    const resized = entity();
    expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)!.entities.get(id)).toEqual(resized);
    act(() => { tab.commands.execute('edit.undo'); }); expect(entity()).toEqual(original);
    act(() => { tab.commands.execute('edit.redo'); }); expect(entity()).toEqual(resized);
    dispose();
  });

  it(`preserves ${kind} proportions when shrinking with a side handle and resumes free resizing on Shift release`, () => {
    const { entity, previewRatio, handle, pointer, dispose } = setup(kind);
    const original = entity(), f = frame(original), right: [number, number] = [f.center[0] + f.width / 2, f.center[1]], end: [number, number] = [right[0] - 10, right[1]];
    const button = handle('right');
    fireEvent.pointerDown(button, pointer(...right, true)); fireEvent.pointerMove(button, pointer(...end, true));
    expect(previewRatio()).toBeCloseTo(f.width / f.height);
    fireEvent.pointerUp(button, pointer(...end, true));
    expect(frame(entity()).width).toBeCloseTo(f.width - 10);
    expect(frame(entity()).height).toBeCloseTo(f.height * (f.width - 10) / f.width);
    const next = frame(entity()), nextRight: [number, number] = [next.center[0] + next.width / 2, next.center[1]];
    const nextButton = handle('right');
    fireEvent.pointerDown(nextButton, pointer(...nextRight, true));
    fireEvent.pointerMove(nextButton, pointer(nextRight[0] + 10, nextRight[1], true));
    fireEvent.keyUp(window, { key: 'Shift', shiftKey: false });
    fireEvent.pointerUp(nextButton, pointer(nextRight[0] + 10, nextRight[1]));
    expect(frame(entity()).height).toBeCloseTo(next.height);
    expect(frame(entity()).width).toBeCloseTo(next.width + 10);
    dispose();
  });
}

it('does not revive a cancelled resize when Shift is released', () => {
  const { tab, entity, handle, pointer, dispose } = setup('label');
  const original = entity(), version = tab.doc.version;
  const button = handle('bottom right');
  fireEvent.pointerDown(button, pointer(120, 70));
  fireEvent.pointerMove(button, pointer(140, 72, true));
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.keyUp(window, { key: 'Shift', shiftKey: false });
  fireEvent.pointerUp(button, pointer(140, 72));
  expect(entity()).toEqual(original); expect(tab.doc.version).toBe(version);
  dispose();
});

it('tells the user Shift maintains aspect ratio and Alt keeps the center', () => {
  const { handle, pointer, dispose } = setup('path');
  expect(screen.getByText(/use the handles to resize \(hold Shift to maintain aspect ratio, Alt to keep the center\)/)).toBeTruthy();
  const button = handle('bottom right');
  fireEvent.pointerDown(button, pointer(120, 70)); fireEvent.pointerMove(button, pointer(140, 72));
  expect(screen.getByText('Resizing: hold Shift to maintain aspect ratio, Alt to keep the center. Release to finish.')).toBeTruthy();
  fireEvent.pointerUp(button, pointer(140, 72));
  expect(screen.queryByText(/^Resizing:/)).toBeNull();
  dispose();
});

for (const kind of ['path', 'image', 'text', 'label'] as const) {
  it.each([0, 30])(`Alt resizes ${kind} about its center, including %s-degree rotation`, angle => {
    const { entity, handle, pointer, dispose } = setup(kind, angle);
    const f = frame(entity());
    const corner = rotateLayoutPoint([f.center[0] + f.width / 2, f.center[1] + f.height / 2], f.center, f.angle);
    const delta = rotateLayoutPoint([10, 4], [0, 0], f.angle), end: [number, number] = [corner[0] + delta[0], corner[1] + delta[1]];
    const button = handle('bottom right');
    fireEvent.pointerDown(button, pointer(...corner)); fireEvent.pointerMove(button, pointer(...end));
    // Alt switches the stationary preview to the center pivot; releasing Alt switches it back.
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    const centered = screen.getByLabelText('Selected object bounds').style.width;
    fireEvent.keyUp(window, { key: 'Alt', altKey: false });
    expect(screen.getByLabelText('Selected object bounds').style.width).not.toBe(centered);
    fireEvent.pointerUp(button, { ...pointer(...end), altKey: true });
    const after = frame(entity());
    expect(after.width).toBeCloseTo(f.width + 20);
    if (kind !== 'label') expect(after.height).toBeCloseTo(f.height + 8);
    expect(after.center[0]).toBeCloseTo(f.center[0]); expect(after.center[1]).toBeCloseTo(f.center[1]);
    dispose();
  });
}
it('selects an object after activating Scale and resizes it without leaving the tool', () => {
  const { tab, entity, handle, pointer, dispose } = setup('path', 0, true);
  const original = entity();
  expect(screen.getByLabelText('Page 1 canvas').getAttribute('data-tool')).toBe('scale');
  const button = handle('bottom right');
  const version = tab.doc.version;
  fireEvent.pointerDown(button, pointer(120, 70));
  fireEvent.pointerMove(button, pointer(140, 80));
  expect(tab.doc.version).toBe(version);
  fireEvent.pointerUp(button, pointer(140, 80));
  expect(frame(entity()).width).toBeGreaterThan(frame(original).width);
  expect(screen.getByLabelText('Page 1 canvas').getAttribute('data-tool')).toBe('scale');
  act(() => { tab.commands.execute('edit.undo'); });
  expect(entity()).toEqual(original);
  dispose();
});
