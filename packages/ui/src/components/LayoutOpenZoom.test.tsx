// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { encodeLayoutSnapshot } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('pans with the middle button until %s without drawing or changing selection', (ending) => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  render(<LayoutWorkspace tab={tab} session={session} />);
  const workspace = screen.getByRole('main', { name: 'Layout workspace' });
  const canvas = workspace.querySelector('canvas')!;
  const capture = vi.fn(), release = vi.fn();
  Object.assign(workspace, { setPointerCapture: capture, hasPointerCapture: () => true, releasePointerCapture: release });
  fireEvent.keyDown(window, { key: 'r', code: 'KeyR' });
  const version = tab.doc.version, selection = tab.workspace.selectedEntityId;
  // Match a real browser when the page fits: scroll offsets cannot leave zero.
  Object.defineProperties(workspace, {
    scrollLeft: { configurable: true, get: () => 0, set: () => {} },
    scrollTop: { configurable: true, get: () => 0, set: () => {} },
  });
  expect(fireEvent.pointerDown(canvas, { button: 1, buttons: 4, pointerId: 7, clientX: 100, clientY: 100 })).toBe(false);
  expect(capture).toHaveBeenCalledWith(7);
  expect(workspace.classList.contains('is-panning')).toBe(true);
  fireEvent.pointerMove(workspace, { buttons: 4, pointerId: 7, clientX: 140, clientY: 120 });
  expect(workspace.style.getPropertyValue('--pf-layout-pan-x')).toBe('40px');
  expect(workspace.style.getPropertyValue('--pf-layout-pan-y')).toBe('20px');
  fireEvent(workspace, new PointerEvent(ending, { bubbles: true, button: 1, pointerId: 7 }));
  expect(release).toHaveBeenCalledWith(7);
  expect(workspace.classList.contains('is-panning')).toBe(false);
  fireEvent.pointerMove(canvas, { pointerId: 7, clientX: 190, clientY: 190 });
  expect(workspace.style.getPropertyValue('--pf-layout-pan-x')).toBe('40px');
  expect(workspace.style.getPropertyValue('--pf-layout-pan-y')).toBe('20px');
  expect(canvas.getAttribute('data-tool')).toBe('rectangle');
  expect(tab.workspace.selectedEntityId).toBe(selection);
  expect(tab.doc.version).toBe(version);
  expect(tab.doc.undoStack.canUndo).toBe(false);
  // Starting on the workspace background also pans.
  fireEvent.pointerDown(workspace, { button: 1, buttons: 4, pointerId: 8, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(workspace, { pointerId: 8, clientX: 20, clientY: 30 });
  expect(workspace.style.getPropertyValue('--pf-layout-pan-x')).toBe('-40px');
  expect(workspace.style.getPropertyValue('--pf-layout-pan-y')).toBe('-50px');
  fireEvent.pointerUp(workspace, { button: 1, pointerId: 8 });
  workspace.scrollTo = vi.fn();
  fireEvent.click(screen.getByRole('button', { name: 'Layout zoom' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Zoom To Page' }));
  expect(workspace.style.getPropertyValue('--pf-layout-pan-x')).toBe('0px');
  expect(workspace.style.getPropertyValue('--pf-layout-pan-y')).toBe('0px');
  cleanup(); session.dispose(); app.dispose();
});

it('zooms with plain wheel input around the pointer without editing the document or intercepting outside scrolling', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  render(<LayoutWorkspace tab={tab} session={session} />);
  const workspace = screen.getByRole('main', { name: 'Layout workspace' });
  const canvas = workspace.querySelector('canvas')!;
  const pageWrap = workspace.querySelector<HTMLElement>('.pf-layout-page-wrap')!;
  const initialWidth = parseFloat(pageWrap.style.width);
  vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(() => {
    const scale = parseFloat(pageWrap.style.width) / initialWidth;
    return {
      x: 20, y: 30, left: 20, top: 30,
      width: 400 * scale, height: 300 * scale,
      right: 20 + 400 * scale, bottom: 30 + 300 * scale,
      toJSON: () => ({}),
    };
  });
  const initialZoom = tab.workspace.zoom;
  const version = tab.doc.version;
  expect(fireEvent.wheel(canvas, { deltaY: -100, clientX: 120, clientY: 105 })).toBe(false);
  expect(tab.workspace.zoom).toBeGreaterThan(initialZoom);
  const ratio = tab.workspace.zoom / initialZoom;
  expect(workspace.scrollLeft).toBeCloseTo(100 * (ratio - 1));
  expect(workspace.scrollTop).toBeCloseTo(75 * (ratio - 1));
  fireEvent.wheel(canvas, { deltaY: 100, clientX: 120, clientY: 105 });
  expect(tab.workspace.zoom).toBeCloseTo(initialZoom);
  fireEvent.wheel(canvas, { deltaY: -100000, ctrlKey: true });
  expect(tab.workspace.zoom).toBe(8);
  fireEvent.wheel(canvas, { deltaY: 100000, metaKey: true });
  expect(tab.workspace.zoom).toBe(0.1);
  expect(fireEvent.wheel(screen.getByRole('button', { name: 'Layout zoom' }), { deltaY: -100 })).toBe(true);
  expect(tab.workspace.zoom).toBe(0.1);
  expect(tab.doc.version).toBe(version);
  expect(tab.doc.undoStack.canUndo).toBe(false);
  cleanup(); session.dispose(); app.dispose();
});

it('fits an opened document once workspace size is available and preserves later zoom across remounts', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  let width = 0, height = 0;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('pf-layout-workspace') ? width : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('pf-layout-workspace') ? height : 0;
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const source = session.newLayout();
  source.commands.execute('layout.page.setup', { pageId: source.activePageId, widthMm: 400, heightMm: 300 });
  const tab = (await session.openLayoutBytes((await encodeLayoutSnapshot(source.doc.state)), 'Existing.pfl'));
  const version = tab.doc.version;
  expect(tab.workspace.zoomToPageOnOpen).toBe(true);
  let view = render(<LayoutWorkspace tab={tab} session={session} />);
  expect(tab.workspace.zoomToPageOnOpen).toBe(true);
  width = 948; height = 648;
  fireEvent.resize(window);
  expect(tab.workspace.zoomToPageOnOpen).toBe(false);
  expect(tab.workspace.zoom).toBeCloseTo(2 / 3);
  expect(screen.getByRole('button', { name: 'Layout zoom' }).textContent).toContain('67%');
  expect(tab.doc.version).toBe(version);
  expect(tab.doc.undoStack.canUndo).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Layout zoom' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '200%' }));
  fireEvent.resize(window);
  expect(tab.workspace.zoom).toBe(2);
  view.unmount();
  view = render(<LayoutWorkspace tab={tab} session={session} />);
  expect(tab.workspace.zoom).toBe(2);
  view.unmount(); session.dispose(); app.dispose();
});
