// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Layout Measurements', () => {
  it('chains line segments from the last endpoint until Escape', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630,
      x: 0, y: 0, toJSON: () => ({}),
    });
    const app = createApp({ demo: false, expose: false });
    const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
    const tab = session.newLayout();
    render(<LayoutWorkspace tab={tab} session={session} />);
    expect(screen.queryByRole('button', { name: 'Freehand' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Line tools' }));
    expect(screen.getAllByRole('menuitemradio').map(item => item.getAttribute('aria-label'))).toEqual(['Line', 'Bézier Curve', 'Freehand']);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Freehand' }));
    expect(screen.getByLabelText('Page 1 canvas').getAttribute('data-tool')).toBe('freehand');
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Freehand' }));
    expect(screen.getByLabelText('Page 1 canvas').getAttribute('data-tool')).toBe('freehand');
    fireEvent.keyDown(window, { key: 'a', code: 'KeyA' });
    expect(screen.getByLabelText('Page 1 canvas').getAttribute('data-tool')).toBe('arc2'); // A is 2 Point Arc
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL' });
    expect(screen.getByLabelText('Page 1 canvas').getAttribute('data-tool')).toBe('line');
    const canvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 30, clientY: 30 });
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 90, clientY: 30 });
    fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 90, clientY: 30 });
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 3, clientX: 90, clientY: 30 });
    fireEvent.pointerMove(canvas, { pointerId: 3, clientX: 90, clientY: 90 });
    fireEvent.pointerUp(canvas, { pointerId: 3, clientX: 90, clientY: 90 });
    const page = tab.doc.state.pages.get(tab.activePageId)!;
    expect(page.entityOrder.map((id) => page.entities.get(id)!.points)).toEqual([
      [[10, 10], [30, 10], [30, 30]],
    ]);
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 4, clientX: 150, clientY: 90 });
    fireEvent.pointerUp(canvas, { pointerId: 4, clientX: 150, clientY: 90 });
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 5, clientX: 180, clientY: 90 });
    fireEvent.pointerUp(canvas, { pointerId: 5, clientX: 180, clientY: 90 });
    const updatedPage = tab.doc.state.pages.get(tab.activePageId)!;
    expect(updatedPage.entities.get(updatedPage.entityOrder[1]!)?.points).toEqual([[50, 30], [60, 30]]);
    session.dispose(); app.dispose();
  });

  it('creates editable Bézier handles and preserves them through undo and save', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630,
      x: 0, y: 0, toJSON: () => ({}),
    });
    const app = createApp({ demo: false, expose: false });
    const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
    const tab = session.newLayout();
    const pageId = tab.activePageId;
    const entityId = tab.commands.execute('layout.shape.add', {
      pageId, points: [[10, 20], [70, 20]], closed: false,
    }) as number;
    render(<LayoutWorkspace tab={tab} session={session} />);
    const canvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 30, clientY: 60 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 30, clientY: 60 });
    fireEvent.click(screen.getByRole('button', { name: 'Edit path' }));
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 30, clientY: 60 });
    fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 30, clientY: 60 });
    fireEvent.click(screen.getByRole('button', { name: 'Curve next segment' }));
    const shape = () => tab.doc.state.pages.get(pageId)!.entities.get(entityId)!;
    expect(shape().handles).toEqual([{ out: [30, 20] }, { in: [50, 20] }]);
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 3, clientX: 90, clientY: 60 });
    fireEvent.pointerMove(canvas, { pointerId: 3, clientX: 90, clientY: 120 });
    fireEvent.pointerUp(canvas, { pointerId: 3, clientX: 90, clientY: 120 });
    expect(shape().handles?.[0]?.out).toEqual([30, 40]);
    tab.commands.execute('edit.undo');
    expect(shape().handles?.[0]?.out).toEqual([30, 20]);
    tab.commands.execute('edit.redo');
    expect(shape().handles?.[0]?.out).toEqual([30, 40]);
    expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)
      ?.entities.get(entityId)?.handles?.[0]?.out).toEqual([30, 40]);
    session.dispose(); app.dispose();
  });

  it('edits path anchors with a drag, segment insertion, deletion, undo, and save', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630,
      x: 0, y: 0, toJSON: () => ({}),
    });
    const app = createApp({ demo: false, expose: false });
    const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
    const tab = session.newLayout();
    const pageId = tab.activePageId;
    const entityId = tab.commands.execute('layout.shape.add', {
      pageId, points: [[10, 20], [50, 20], [50, 40], [10, 40]], closed: true,
    }) as number;
    render(<LayoutWorkspace tab={tab} session={session} />);
    const canvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 90, clientY: 60 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 90, clientY: 60 });
    fireEvent.click(screen.getByRole('button', { name: 'Edit path' }));
    expect(screen.getByText(/Drag anchors or curve handles/)).toBeTruthy();
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 150, clientY: 60 });
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 180, clientY: 90 });
    const points = () => tab.doc.state.pages.get(pageId)!.entities.get(entityId)!.points;
    expect(points()[1]).toEqual([50, 20]);
    fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 180, clientY: 90 });
    expect(points()[1]).toEqual([60, 30]);
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 4, clientX: 150, clientY: 120 });
    fireEvent.pointerMove(canvas, { pointerId: 4, clientX: 180, clientY: 150 });
    fireEvent.pointerCancel(canvas, { pointerId: 4 });
    expect(points()[2]).toEqual([50, 40]);
    fireEvent.doubleClick(canvas, { clientX: 105, clientY: 75 });
    expect(points()[1]).toEqual([35, 25]);
    expect(points()).toHaveLength(5);
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 3, clientX: 105, clientY: 75 });
    fireEvent.pointerUp(canvas, { pointerId: 3, clientX: 105, clientY: 75 });
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(points()).toHaveLength(4);
    tab.commands.execute('edit.undo');
    expect(points()).toHaveLength(5);
    const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
    expect(reopened.state.pages.get(pageId)?.entities.get(entityId)?.points).toEqual(points());
    session.dispose();
    app.dispose();
  });

  it('draws one shared title-block path and edits it from another page', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630,
      x: 0, y: 0, toJSON: () => ({}),
    });
    vi.spyOn(window, 'prompt').mockReturnValue('Title block');
    const app = createApp({ demo: false, expose: false });
    const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
    const tab = session.newLayout();
    const firstPageId = tab.activePageId;
    render(<LayoutWorkspace tab={tab} session={session} />);
    act(() => { tab.commands.execute('layout.layer.add', { name: 'Title block', shared: true }); });
    const sharedLayerId = tab.doc.state.activeLayerId;
    expect(tab.doc.state.layers.get(sharedLayerId)?.shared).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Line' }));
    const firstCanvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(firstCanvas, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
    fireEvent.pointerMove(firstCanvas, { pointerId: 1, clientX: 330, clientY: 30 });
    fireEvent.pointerUp(firstCanvas, { pointerId: 1, clientX: 330, clientY: 30 });
    const entityId = tab.doc.state.sharedEntityOrder[0]!;
    expect(tab.doc.state.pages.get(firstPageId)?.entities.size).toBe(0);
    expect(tab.doc.state.sharedEntities.get(entityId)?.points).toEqual([[10, 10], [110, 10]]);

    act(() => { session.setActivePage(tab.commands.execute('layout.page.add') as number); });
    const secondPageId = tab.activePageId;
    expect(tab.doc.state.pages.get(secondPageId)?.entities.size).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    const secondCanvas = screen.getByLabelText('Page 2 canvas');
    fireEvent.pointerDown(secondCanvas, { button: 0, pointerId: 2, clientX: 60, clientY: 30 });
    fireEvent.pointerMove(secondCanvas, { pointerId: 2, clientX: 90, clientY: 60 });
    fireEvent.pointerUp(secondCanvas, { pointerId: 2, clientX: 90, clientY: 60 });
    expect(tab.doc.state.sharedEntities.get(entityId)?.points).toEqual([[20, 20], [120, 20]]);
    expect(tab.doc.state.pages.get(firstPageId)?.entities.size).toBe(0);
    const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
    expect(reopened.state.sharedEntities.size).toBe(1);
    expect(reopened.state.pages.get(firstPageId)?.entities.size).toBe(0);
    expect(reopened.state.pages.get(secondPageId)?.entities.size).toBe(0);
    expect(reopened.state.sharedEntities.get(entityId)?.points).toEqual([[20, 20], [120, 20]]);
    session.dispose();
    app.dispose();
  });

  it('picks the visible top layer and persists layer assignment and drawing order', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630,
      x: 0, y: 0, toJSON: () => ({}),
    });
    const app = createApp({ demo: false, expose: false });
    const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
    const tab = session.newLayout();
    const pageId = tab.activePageId;
    const lowerLayerId = tab.doc.state.activeLayerId;
    const lowerId = tab.commands.execute('layout.shape.add', {
      pageId, points: [[10, 20], [50, 20]], closed: false,
    }) as number;
    const upperLayerId = tab.commands.execute('layout.layer.add', { name: 'Upper' }) as number;
    const upperId = tab.commands.execute('layout.shape.add', {
      pageId, points: [[10, 20], [50, 20]], closed: false,
    }) as number;
    render(<LayoutWorkspace tab={tab} session={session} />);
    act(() => { tab.commands.execute('layout.layer.move', { layerId: lowerLayerId, toIndex: 1 }); });
    expect(tab.doc.state.layerOrder).toEqual([upperLayerId, lowerLayerId]);
    const canvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 60, clientY: 60 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 90, clientY: 90 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 90, clientY: 90 });
    expect(tab.doc.state.pages.get(pageId)?.entities.get(lowerId)?.points).toEqual([[20, 30], [60, 30]]);
    expect(tab.doc.state.pages.get(pageId)?.entities.get(upperId)?.points).toEqual([[10, 20], [50, 20]]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Shape layer' }),
      { target: { value: String(upperLayerId) } });
    expect(tab.doc.state.pages.get(pageId)?.entities.get(lowerId)?.layerId).toBe(upperLayerId);
    fireEvent.click(screen.getByRole('button', { name: 'Send to back' }));
    expect(tab.doc.state.pages.get(pageId)?.entityOrder).toEqual([lowerId, upperId]);
    tab.commands.execute('layout.layer.setLocked', { layerId: upperLayerId, locked: true });
    tab.commands.execute('layout.layer.setVisible', { layerId: upperLayerId, visible: false });
    const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
    expect(reopened.state.layerOrder).toEqual([upperLayerId, lowerLayerId]);
    expect(reopened.state.pages.get(pageId)?.entityOrder).toEqual([lowerId, upperId]);
    expect(reopened.state.pages.get(pageId)?.entities.get(lowerId)?.layerId).toBe(upperLayerId);
    expect(reopened.state.layers.get(upperLayerId)?.locked).toBe(true);
    expect(reopened.state.layers.get(upperLayerId)?.visible).toBe(false);
    session.dispose();
    app.dispose();
  });

  it('applies numeric rotate, scale, and flip controls to the selected path', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630,
      x: 0, y: 0, toJSON: () => ({}),
    });
    const app = createApp({ demo: false, expose: false });
    const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
    const tab = session.newLayout();
    const pageId = tab.activePageId;
    const entityId = tab.commands.execute('layout.shape.add', {
      pageId, points: [[10, 20], [50, 20]], closed: false,
    }) as number;
    render(<LayoutWorkspace tab={tab} session={session} />);
    // Arrange belongs to the selection panel, so it is absent until something is selected.
    expect(screen.queryByRole('button', { name: 'Rotate clockwise' })).toBeNull();
    const canvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 60, clientY: 60 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 60, clientY: 60 });
    const rotate = screen.getByRole('button', { name: 'Rotate clockwise' });
    fireEvent.click(rotate);
    const points = () => tab.doc.state.pages.get(pageId)!.entities.get(entityId)!.points;
    expect(points()[0]![0]).toBeCloseTo(30);
    expect(points()[0]![1]).toBeCloseTo(0);
    expect(points()[1]![0]).toBeCloseTo(30);
    expect(points()[1]![1]).toBeCloseTo(40);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Scale percent' }),
      { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply scale' }));
    expect(points()[0]![1]).toBeCloseTo(-20);
    expect(points()[1]![1]).toBeCloseTo(60);
    fireEvent.click(screen.getByRole('button', { name: 'Flip vertically' }));
    expect(points()[0]![1]).toBeCloseTo(60);
    expect(points()[1]![1]).toBeCloseTo(-20);
    const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
    expect(reopened.state.pages.get(pageId)?.entities.get(entityId)?.points).toEqual(points());
    tab.commands.execute('edit.undo');
    expect(points()[0]![1]).toBeCloseTo(-20);
    session.dispose();
    app.dispose();
  });

  it('moves a selected path by dragging, copies it with Ctrl-drag, and Alt selects without moving', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630,
      x: 0, y: 0, toJSON: () => ({}),
    });
    const app = createApp({ demo: false, expose: false });
    const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
    const tab = session.newLayout();
    const pageId = tab.activePageId;
    const entityId = tab.commands.execute('layout.shape.add', {
      pageId, points: [[10, 20], [50, 20]], closed: false,
    }) as number;
    render(<LayoutWorkspace tab={tab} session={session} />);
    const canvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 60, clientY: 60 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 90, clientY: 90 });
    expect(tab.doc.state.pages.get(pageId)?.entities.get(entityId)?.points).toEqual([[10, 20], [50, 20]]);
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 90, clientY: 90 });
    expect(tab.doc.state.pages.get(pageId)?.entities.get(entityId)?.points).toEqual([[20, 30], [60, 30]]);
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 90, clientY: 90 });
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 120, clientY: 90, ctrlKey: true });
    fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 120, clientY: 90, ctrlKey: true });
    const page = tab.doc.state.pages.get(pageId)!;
    expect(page.entityOrder).toHaveLength(2);
    expect(page.entities.get(page.entityOrder[1]!)?.points).toEqual([[30, 30], [70, 30]]);
    expect(page.entities.get(entityId)?.points).toEqual([[20, 30], [60, 30]]);
    // Cmd behaves like Ctrl: a Cmd-drag of the copy drops a third object.
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 5, clientX: 150, clientY: 90 });
    fireEvent.pointerMove(canvas, { pointerId: 5, clientX: 150, clientY: 150, metaKey: true });
    fireEvent.pointerUp(canvas, { pointerId: 5, clientX: 150, clientY: 150, metaKey: true });
    const current = () => tab.doc.state.pages.get(pageId)!; // state is immutable: re-read after each change
    expect(current().entityOrder).toHaveLength(3);
    expect(current().entities.get(current().entityOrder[2]!)?.points).toEqual([[30, 50], [70, 50]]);
    // Alt no longer copies: an Alt-drag selects the object under the pointer and moves nothing at all.
    const allPoints = () => current().entityOrder.map((id) => current().entities.get(id)!.points);
    const before = allPoints();
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 4, clientX: 90, clientY: 90, altKey: true });
    fireEvent.pointerMove(canvas, { pointerId: 4, clientX: 150, clientY: 180, altKey: true });
    fireEvent.pointerUp(canvas, { pointerId: 4, clientX: 150, clientY: 180, altKey: true });
    expect(current().entityOrder).toHaveLength(3);
    expect(allPoints()).toEqual(before);
    expect(screen.getByLabelText('Selected object bounds')).toBeTruthy();
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 3, clientX: 90, clientY: 90 });
    fireEvent.pointerMove(canvas, { pointerId: 3, clientX: 120, clientY: 120 });
    fireEvent.pointerCancel(canvas, { pointerId: 3 });
    expect(tab.doc.state.pages.get(pageId)?.entities.get(entityId)?.points).toEqual([[20, 30], [60, 30]]);
    session.dispose();
    app.dispose();
  });

  it('draws a 100 mm line from a snapped midpoint and round-trips the coordinates', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630,
      x: 0, y: 0, toJSON: () => ({}),
    });
    const app = createApp({ demo: false, expose: false });
    const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
    const tab = session.newLayout();
    render(<LayoutWorkspace tab={tab} session={session} />);
    fireEvent.click(screen.getByRole('button', { name: 'Line' }));
    const canvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 330, clientY: 30 });
    fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: 330, clientY: 30 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 181, clientY: 31 });
    fireEvent.pointerUp(canvas, { button: 0, pointerId: 2, clientX: 181, clientY: 31 });
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 180, clientY: 90 });
    const measurements = screen.getByRole('textbox', { name: 'Layout Measurements' });
    fireEvent.change(measurements, { target: { value: '100' } });
    fireEvent.keyDown(measurements, { key: 'Enter' });

    const page = tab.doc.state.pages.get(tab.activePageId)!;
    const measured = page.entities.get(page.entityOrder[1]!)!;
    expect(measured.points[0]).toEqual([60, 10]);
    expect(measured.points[1]![0]).toBeCloseTo(60);
    expect(measured.points[1]![1]).toBeCloseTo(110);
    const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
    const reopenedPage = reopened.state.pages.get(reopened.state.pageOrder[0]!)!;
    expect(reopenedPage.entities.get(reopenedPage.entityOrder[1]!)?.points).toEqual(measured.points);
    expect(tab.commands.execute('edit.undo')).toBe(true);
    expect(tab.doc.state.pages.get(tab.activePageId)?.entityOrder).toHaveLength(1);
    expect(app.document.doc.version).toBe(0);
    session.dispose();
    app.dispose();
  });

  it('accepts a line length and angle and reports invalid measurements', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630,
      x: 0, y: 0, toJSON: () => ({}),
    });
    const app = createApp({ demo: false, expose: false });
    const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
    const tab = session.newLayout();
    render(<LayoutWorkspace tab={tab} session={session} />);
    fireEvent.click(screen.getByRole('button', { name: 'Line' }));
    const canvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
    fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
    const input = screen.getByRole('textbox', { name: 'Layout Measurements' });
    fireEvent.change(input, { target: { value: 'oops' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toContain('Cannot parse');
    expect(tab.doc.state.pages.get(tab.activePageId)?.entityOrder).toHaveLength(0);
    fireEvent.change(input, { target: { value: '100mm,90deg' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('alert')).toBeNull();
    const page = tab.doc.state.pages.get(tab.activePageId)!;
    expect(page.entities.get(page.entityOrder[0]!)?.points[0]).toEqual([10, 10]);
    expect(page.entities.get(page.entityOrder[0]!)?.points[1]![0]).toBeCloseTo(10);
    expect(page.entities.get(page.entityOrder[0]!)?.points[1]![1]).toBeCloseTo(110);
    session.dispose();
    app.dispose();
  });

  it('draws in the page margin while keeping the grid inside the margins', () => {
    const moveTo = vi.fn();
    const lineTo = vi.fn();
    const clip = vi.fn();
    const context = {
      setTransform: vi.fn(), fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), rect: vi.fn(), clip, moveTo, lineTo, stroke: vi.fn(),
      strokeRect: vi.fn(), setLineDash: vi.fn(), arc: vi.fn(), fill: vi.fn(),
      fillText: vi.fn(), closePath: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630,
      x: 0, y: 0, toJSON: () => ({}),
    });
    const app = createApp({ demo: false, expose: false });
    const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
    const tab = session.newLayout();
    render(<LayoutWorkspace tab={tab} session={session} />);
    act(() => { tab.commands.execute('layout.document.settings'); });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show grid' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Snap to grid' }));
    expect(clip).toHaveBeenCalled();
    const gridEnds = [...moveTo.mock.calls, ...lineTo.mock.calls];
    expect(gridEnds.length).toBeGreaterThan(0);
    for (const [x, y] of gridEnds) {
      expect(x).toBeGreaterThanOrEqual(10);
      expect(x).toBeLessThanOrEqual(287);
      expect(y).toBeGreaterThanOrEqual(10);
      expect(y).toBeLessThanOrEqual(200);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Line' }));
    const canvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 15, clientY: 15 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 90, clientY: 15 });
    fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: 90, clientY: 15 });
    const page = tab.doc.state.pages.get(tab.activePageId)!;
    expect(page.entities.get(page.entityOrder[0]!)?.points).toEqual([[5, 5], [30, 5]]);
    session.dispose();
    app.dispose();
  });
});
