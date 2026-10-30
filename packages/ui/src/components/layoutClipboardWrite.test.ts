// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
import { createLayoutDocument } from '@pushform/layout';
import { createLayoutClipboardPayload, writeLayoutClipboardEvent, writeLayoutSystemClipboard, readLayoutSystemClipboard } from './layoutClipboardWrite';
import { readLayoutClipboard } from './layoutClipboard';
import { layoutClipboardSvg } from './layoutClipboard';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(isTauri).mockReturnValue(false); });
function fixture() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const doc = createLayoutDocument();
  doc.transact('Fixture', state => {
    const page = state.pages.values().next().value!;
    page.entities.set(3, { id: 3, layerId: state.activeLayerId, kind: 'path', closed: false,
      points: [[10, 10], [60, 30]], handles: [{ out: [20, 5] }, { in: [40, 40] }],
      style: { fillColor: null, strokeColor: '#123456', strokeWeightPt: 2, strokeDashMm: [2, 1] } });
    page.entities.set(4, { id: 4, layerId: state.activeLayerId, kind: 'path', closed: true,
      points: [[80, 10], [100, 10], [100, 30], [80, 30]],
      style: { fillColor: '#ff0000', strokeColor: '#000000', strokeWeightPt: 1 } });
    page.entityOrder = [3, 4]; state.meta.nextId = 5;
  });
  const page = doc.state.pages.values().next().value!;
  return { doc, page, payload: createLayoutClipboardPayload(doc.state, page, [page.entities.get(3)!]) };
}
it('copies only the selection as physical-size editable SVG and retains exact native data through HTML', async () => {
  const { doc, page, payload } = fixture();
  const before = doc.state;
  const root = new DOMParser().parseFromString(payload.svg, 'image/svg+xml');
  expect(root.querySelectorAll('path')).toHaveLength(1);
  expect(root.querySelector('path')!.getAttribute('d')).toContain('C');
  expect(root.querySelector('path')!.getAttribute('d')).not.toContain('Z');
  expect(root.querySelector('rect')).toBeNull();
  expect(root.documentElement.getAttribute('width')).toMatch(/mm$/);
  const values: Record<string, string> = {};
  writeLayoutClipboardEvent({ setData: (type, value) => { values[type] = value; } } as DataTransfer, payload);
  expect(values['image/svg+xml']).toBe(payload.svg);
  // Native custom formats may not survive the browser-to-OS boundary; the standard HTML carrier does.
  expect(readLayoutClipboard({ getData: (type: string) => type === 'text/html' ? payload.html : '', files: [], items: [] } as unknown as DataTransfer))
    .toEqual({ kind: 'object', entities: [page.entities.get(3)] });
  const pasted = await layoutClipboardSvg(payload.svg, page);
  expect(pasted).toHaveLength(1); expect(pasted[0]!.closed).toBe(false);
  expect(pasted[0]!.style!.strokeWeightPt).toBeCloseTo(2);
  expect(pasted[0]!.style!.strokeDashMm![0]).toBeCloseTo(2);
  expect(doc.state).toBe(before);
});
it('publishes native SVG, HTML and text together and surfaces rejected writes', async () => {
  const { payload } = fixture();
  const write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { write } });
  vi.stubGlobal('ClipboardItem', class {
    static supports = (type: string) => type === 'image/svg+xml';
    constructor(readonly data: Record<string, Blob>) {}
  });
  const completion = writeLayoutSystemClipboard(payload);
  expect(write).not.toHaveBeenCalled(); // The copy event must commit before native publishing.
  await completion;
  expect(Object.keys(write.mock.calls[0]![0][0].data)).toEqual(['image/svg+xml', 'text/html', 'text/plain']);
  write.mockRejectedValueOnce(new Error('Permission denied'));
  await expect(writeLayoutSystemClipboard(payload)).rejects.toThrow('Permission denied');
});
it('does not pretend unsupported browsers can publish native vector clipboard data', () => {
  const { payload } = fixture();
  vi.stubGlobal('ClipboardItem', class { static supports = () => false; });
  const write = vi.fn(); vi.stubGlobal('navigator', { clipboard: { write } });
  expect(writeLayoutSystemClipboard(payload)).toBeNull(); expect(write).not.toHaveBeenCalled();
});
it('prefers SVG over bitmap previews and recognizes Inkscape clipboard data', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 10"/></svg>';
  for (const type of ['image/svg+xml', 'image/x-inkscape-svg']) {
    const file = new File(['preview'], 'preview.png', { type: 'image/png' });
    expect(readLayoutClipboard({ getData: (key: string) => key === type ? svg : '', files: [file], items: [] } as unknown as DataTransfer))
      .toEqual({ kind: 'svg', source: svg });
  }
});

it('uses the native desktop bridge to write all formats together and read native SVG', async () => {
  const { payload } = fixture();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockResolvedValue(undefined);
  await writeLayoutSystemClipboard(payload);
  expect(invoke).toHaveBeenCalledWith('layout_clipboard_write', { payload });
  vi.mocked(invoke).mockResolvedValue({ 'image/svg+xml': payload.svg });
  await expect(readLayoutSystemClipboard()).resolves.toEqual({ 'image/svg+xml': payload.svg });
});

it('reads native browser SVG when paste events expose only a preview, and tolerates denied reads', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 10"/></svg>';
  const read = vi.fn().mockResolvedValue([{ types: ['image/png', 'image/svg+xml'], getType: async () => ({ text: async () => svg }) }]);
  vi.stubGlobal('navigator', { clipboard: { read } });
  await expect(readLayoutSystemClipboard()).resolves.toEqual({ 'image/svg+xml': svg });
  read.mockRejectedValueOnce(new Error('Permission denied'));
  await expect(readLayoutSystemClipboard()).resolves.toEqual({});
});
