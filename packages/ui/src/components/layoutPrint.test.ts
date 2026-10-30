// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import { createLayoutRegistry } from '@pushform/commands';
import { buildLayoutPrintDocument, printLayoutDocument } from './layoutPrint';
import * as images from './layoutImage';
import * as fonts from './layoutFonts';

afterEach(() => { vi.restoreAllMocks(); document.querySelectorAll('iframe').forEach(frame => frame.remove()); });

it('builds ordered sheets with distinct physical paper sizes and no application markup', () => {
  const doc = createLayoutDocument();
  const { commands } = createLayoutRegistry(doc);
  const first = doc.state.pageOrder[0]!;
  const second = commands.execute('layout.page.add', {}) as number;
  commands.execute('layout.page.setup', { pageId: second, widthMm: 210, heightMm: 297 });
  const target = document.implementation.createHTMLDocument();
  const paint = vi.fn();
  buildLayoutPrintDocument(target, doc.state, [second, first], 'Drawing <test>', paint, 300);
  expect(target.title).toBe('Drawing <test>');
  expect([...target.querySelectorAll('section')].map(section => section.getAttribute('aria-label'))).toEqual(['Page 2', 'Page 1']);
  expect(target.head.textContent).toContain('@page layoutSheet0 { size: 210mm 297mm; margin: 0; }');
  expect(target.head.textContent).toContain('@page layoutSheet1 { size: 297mm 210mm; margin: 0; }');
  expect(target.querySelector('canvas')?.style.width).toBe('210mm');
  expect(target.querySelector('canvas')?.style.height).toBe('297mm');
  expect(target.querySelectorAll('button, nav, input')).toHaveLength(0);
  expect(paint.mock.calls.map(call => [call[1].id, call[3]])).toEqual([[second, 300], [first, 300]]);
});

it('waits for images, honors cancellation, and cleans the print frame after preview closes', async () => {
  const doc = createLayoutDocument();
  let ready!: () => void;
  const prepare = vi.spyOn(images, 'prepareLayoutImages').mockImplementation(() => new Promise<void>(resolve => { ready = resolve; }));
  const controller = new AbortController();
  const cancelled = printLayoutDocument(doc.state, doc.state.pageOrder, 'Cancelled', vi.fn(), 150, controller.signal);
  expect(document.querySelector('iframe')).toBeNull();
  controller.abort(); ready(); await cancelled;
  expect(document.querySelector('iframe')).toBeNull();
  prepare.mockResolvedValue();
  let print = vi.fn();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const frame = document.querySelector('iframe')!;
    print = vi.spyOn(frame.contentWindow!, 'print').mockImplementation(() => {});
    vi.spyOn(frame.contentWindow!, 'focus').mockImplementation(() => {});
    callback(0); return 0;
  });
  await printLayoutDocument(doc.state, doc.state.pageOrder, 'Printed', vi.fn(), 150, new AbortController().signal);
  expect(print).toHaveBeenCalledOnce();
  const frame = document.querySelector('iframe')!;
  expect(frame.contentDocument?.title).toBe('Printed');
  expect(frame.contentDocument?.querySelectorAll('.sheet')).toHaveLength(1);
  frame.contentWindow!.dispatchEvent(new Event('afterprint'));
  expect(document.querySelector('iframe')).toBeNull();
});

it('waits for webfonts and rasterizes in the document containing their loaded faces', async () => {
  const doc = createLayoutDocument();
  let ready!: () => void;
  vi.spyOn(fonts, 'prepareLayoutFonts').mockImplementation(() => new Promise<void>(resolve => { ready = resolve; }));
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const frame = document.querySelector('iframe')!;
    vi.spyOn(frame.contentWindow!, 'print').mockImplementation(() => {});
    vi.spyOn(frame.contentWindow!, 'focus').mockImplementation(() => {});
    callback(0); return 0;
  });
  const paint = vi.fn((canvas: HTMLCanvasElement) => { expect(canvas.ownerDocument).toBe(document); });
  const pending = printLayoutDocument(doc.state, doc.state.pageOrder, 'Webfonts', paint, 150, new AbortController().signal);
  await Promise.resolve(); expect(paint).not.toHaveBeenCalled(); expect(document.querySelector('iframe')).toBeNull();
  ready(); await pending;
  expect(paint).toHaveBeenCalledOnce();
});
