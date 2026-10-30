// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { unzipSync, strFromU8 } from 'fflate';
import { decodeLayoutDocument, layoutJson } from '@pushform/io';
import type { LayoutDocumentState } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { chooseSaveTarget } from '../saveFile';
import { LayoutWorkspace } from './LayoutWorkspace';
import { exportLayoutImages } from './layoutImageExport';
import { encodeImage } from '../rasterizeImage';

vi.mock('../saveFile', () => ({ chooseSaveTarget: vi.fn() }));
const flags = vi.hoisted(() => ({ tauri: false }));
vi.mock('@tauri-apps/api/core', async importOriginal => ({ ...await importOriginal<object>(), isTauri: () => flags.tauri }));
vi.mock('../rasterizeImage', async importOriginal => ({ ...await importOriginal<object>(), encodeImage: vi.fn() }));
const choose = vi.mocked(chooseSaveTarget);
const written: Uint8Array[] = [];

beforeEach(() => {
  written.length = 0;
  flags.tauri = false;
  choose.mockReset();
  choose.mockResolvedValue({ write: async bytes => { written.push(bytes); } });
  vi.mocked(encodeImage).mockReset();
  // jsdom has no window.open; the PDF viewer tab is tested with a stand-in where it matters.
  vi.spyOn(window, 'open').mockReturnValue(null);
  const methods = new Map<string | symbol, unknown>([['measureText', () => ({ width: 5 })]]);
  const ctx = new Proxy({}, { get: (_, key) => { if (!methods.has(key)) methods.set(key, vi.fn()); return methods.get(key); },
    set: (_, key, value) => { methods.set(key, value); return true; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as CanvasRenderingContext2D);
  // Each picture records the canvas size and type it was made from.
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, done: BlobCallback, type?: string) {
    const bytes = new TextEncoder().encode(`${this.width}x${this.height} ${type}`);
    done({ arrayBuffer: async () => bytes.buffer } as unknown as Blob);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** The dialog's size and file name line. */
const summary = () => within(screen.getByRole('dialog', { name: 'Export' })).getByRole('status').textContent;

function setup() {
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  const view = render(<LayoutWorkspace tab={tab} session={session} />);
  return { tab, dispose: () => { view.unmount(); session.dispose(); app.dispose(); } };
}

it('exports the current page as a PNG or JPEG at the chosen resolution without changing the document', async () => {
  const { tab, dispose } = setup();
  const version = tab.doc.version, base = tab.name.replace(/\.(pfl|layout)$/i, '');
  act(() => { tab.commands.execute('layout.export.image'); });
  expect(screen.getByRole('dialog', { name: 'Export' })).toBeTruthy();
  // A4 landscape at the default 150 dpi.
  expect(summary()).toBe(`1754 × 1240 px · ${base}.png`);
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'jpeg' } });
  fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '300' } });
  expect(summary()).toBe(`3508 × 2480 px · ${base}.jpg`);
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Export' })).toBeNull());
  expect(choose).toHaveBeenCalledWith(`${base}.jpg`, { description: 'JPEG image', mime: 'image/jpeg', extension: 'jpg' });
  expect(strFromU8(written[0]!)).toBe('3508x2480 image/jpeg');
  expect(tab.doc.version).toBe(version); expect(tab.doc.undoStack.canUndo).toBe(false);
  dispose();
});

it('exports several pages as one zip of numbered pictures, and keeps setup open when saving is cancelled', async () => {
  const { tab, dispose } = setup();
  act(() => { tab.commands.execute('layout.page.add', {}); });
  const base = tab.name.replace(/\.(pfl|layout)$/i, ''), names = tab.doc.state.pageOrder.map(id => tab.doc.state.pages.get(id)!.name);
  act(() => { tab.commands.execute('layout.export.image'); });
  expect(summary()).toBe(`1754 × 1240 px per page · ${base}.zip`);
  choose.mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Export…' }) as HTMLButtonElement).disabled).toBe(false));
  expect(written).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  await waitFor(() => expect(written).toHaveLength(1));
  expect(choose).toHaveBeenLastCalledWith(`${base}.zip`, { description: 'ZIP archive', mime: 'application/zip', extension: 'zip' });
  const files = unzipSync(written[0]!);
  expect(Object.keys(files)).toEqual(names.map((name, index) => `${index + 1} ${name}.png`));
  expect(strFromU8(files[`1 ${names[0]}.png`]!)).toBe('1754x1240 image/png');
  // Current page only: the picture is named after the document and the page.
  act(() => { tab.commands.execute('layout.export.image'); });
  fireEvent.click(screen.getByLabelText(/Current page/));
  expect(summary()).toBe(`1754 × 1240 px · ${base} - ${tab.doc.state.pages.get(tab.activePageId)!.name}.png`);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Export' })).toBeNull();
  dispose();
});

it('refuses pages that would be too large a picture before painting anything', async () => {
  const state = { pageOrder: [1], layerOrder: [], pages: new Map([[1, { id: 1, name: 'Site plan', size: [2000, 1000] }]]) } as unknown as LayoutDocumentState;
  const paint = vi.fn();
  await expect(exportLayoutImages(state, [1], 'Plans', { format: 'png', dpi: 300 }, paint)).rejects.toThrow('Site plan would be 23622 × 11811 pixels at 300 dpi');
  expect(paint).not.toHaveBeenCalled();
});

it.each(['svg', 'dxf'] as const)('exports native paths as %s through the dialog without changing the document', async format => {
  const { tab, dispose } = setup();
  act(() => { tab.commands.execute('layout.shape.add', { pageId: tab.activePageId, points: [[10, 20], [30, 40]],
    handles: [{ out: [10, 30] }, { in: [30, 30] }] }); });
  const version = tab.doc.version, activePageId = tab.activePageId;
  act(() => { tab.commands.execute('layout.export.image'); });
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: format } });
  expect(screen.queryByLabelText('Resolution')).toBeNull();
  fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'drawing' } });
  if (format === 'dxf') fireEvent.change(screen.getByLabelText('Drawing scale denominator'), { target: { value: '50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  await waitFor(() => expect(written).toHaveLength(1));
  const text = strFromU8(written[0]!);
  if (format === 'svg') {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.querySelector('path')!.getAttribute('d')).toBe('M10 20 C10 30 30 30 30 40');
    expect(doc.querySelector('svg > rect')).toBeNull();
    expect(doc.documentElement.getAttribute('width')).toMatch(/mm$/);
  } else {
    const { parseDxf, parseDxfHeader } = await import('@pushform/io');
    expect(parseDxfHeader(written[0]!).units?.unit).toBe('mm');
    expect(parseDxf(written[0]!).items).toHaveLength(1);
    expect(text).toContain('\r\nSPLINE\r\n');
    expect(parseDxfHeader(written[0]!).extent!.max[0]).toBeCloseTo((20 + 0.5 * 25.4 / 72) * 50);
  }
  expect(choose.mock.calls[0]![1]?.extension).toBe(format);
  expect(tab.doc.version).toBe(version); expect(tab.activePageId).toBe(activePageId);
  dispose();
});

it.each(['svg', 'dxf'] as const)('packs multiple %s pages in document order and excludes hidden objects', async format => {
  const { tab, dispose } = setup();
  act(() => {
    const id = tab.commands.execute('layout.shape.add', { pageId: tab.activePageId, points: [[10, 20], [30, 40]] }) as number;
    tab.commands.execute('layout.shape.setHidden', { pageId: tab.activePageId, entityIds: [id], hidden: true });
    tab.commands.execute('layout.page.add', {});
  });
  act(() => { tab.commands.execute('layout.export.image'); });
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: format } });
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  await waitFor(() => expect(written).toHaveLength(1));
  const files = unzipSync(written[0]!);
  expect(Object.keys(files)).toEqual(tab.doc.state.pageOrder.map((id, i) => `${i + 1} ${tab.doc.state.pages.get(id)!.name}.${format}`));
  for (const bytes of Object.values(files)) {
    const text = strFromU8(bytes);
    if (format === 'svg') expect(new DOMParser().parseFromString(text, 'image/svg+xml').querySelector('path')).toBeNull();
    else expect(text).not.toContain('\r\nLWPOLYLINE\r\n');
  }
  dispose();
});

it('reports empty drawing bounds and invalid CAD scales without writing a file', async () => {
  const { tab, dispose } = setup();
  act(() => { tab.commands.execute('layout.export.image'); });
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'dxf' } });
  fireEvent.change(screen.getByLabelText('Drawing scale denominator'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Enter a positive drawing scale denominator.');
  expect(choose).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Drawing scale denominator'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'drawing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('There are no drawing elements to export.'));
  expect(written).toHaveLength(0);
  dispose();
});

it('records tables, rotated text and embedded pictures using the content painters, and reports CAD omissions', async () => {
  const { tab, dispose } = setup();
  const { exportLayoutVectors } = await import('./layoutVectorExport');
  const { setLayoutCanvasPicture, forgetLayoutImage } = await import('./layoutImage');
  const picture = document.createElement('canvas'), src = 'data:image/png;base64,dGVzdA==';
  vi.spyOn(picture, 'toDataURL').mockReturnValue(src);
  setLayoutCanvasPicture(src, picture);
  act(() => {
    const pageId = tab.activePageId;
    tab.commands.execute('layout.table.add', { pageId, first: [10, 10], second: [70, 40], rows: 2, columns: 2 });
    const textId = tab.commands.execute('layout.text.add', { pageId, kind: 'text', points: [[10, 50], [70, 70]],
      text: { content: '<A>', fontFamily: 'Arial', fontSizePt: 12, color: '#123456', bold: false, italic: false,
        underline: false, align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none' } }) as number;
    tab.commands.execute('layout.shape.rotate', { pageId, entityId: textId, angleDeg: 30 });
    tab.commands.execute('layout.clipboard.paste', { pageId, entities: [{ kind: 'image', closed: true,
      points: [[80, 10], [90, 10], [90, 20], [80, 20]], image: { src } }] });
  });
  const svg = await exportLayoutVectors(tab.doc.state, [tab.activePageId], tab.name, { format: 'svg', area: 'page', scale: 1 });
  const doc = new DOMParser().parseFromString(strFromU8(svg!.bytes), 'image/svg+xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  expect(doc.querySelectorAll('path').length).toBeGreaterThan(4);
  expect([...doc.querySelectorAll('text')].map(node => node.textContent).join('')).toBe('<A>');
  expect(doc.querySelector('text')!.getAttribute('transform')).not.toBe('matrix(1 0 0 1 0 0)');
  expect(doc.querySelector('clipPath')).toBeTruthy();
  expect(doc.querySelector('image')!.getAttribute('href')).toBe(src);
  act(() => { tab.commands.execute('layout.export.image'); });
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'dxf' } });
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  await waitFor(() => expect(screen.getByText('Export saved with notes:')).toBeTruthy());
  expect(screen.getByText('Pictures and raster model views are omitted from DXF.')).toBeTruthy();
  expect(strFromU8(written[0]!)).toContain('\r\nTEXT\r\n');
  forgetLayoutImage(src); dispose();
});

it('abandons a pending vector export when Escape closes setup', async () => {
  const { tab, dispose } = setup();
  let resolveTarget!: (value: Awaited<ReturnType<typeof chooseSaveTarget>>) => void;
  choose.mockReturnValueOnce(new Promise(resolve => { resolveTarget = resolve; }));
  act(() => { tab.commands.execute('layout.export.image'); });
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'svg' } });
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  fireEvent.keyDown(window, { key: 'Escape' });
  await act(async () => { resolveTarget({ write: async bytes => { written.push(bytes); } }); });
  expect(written).toHaveLength(0);
  expect(screen.queryByRole('dialog', { name: 'Export' })).toBeNull();
  dispose();
});

it('switches between document, raster and vector formats in one dialog, keeping format choices', () => {
  const { tab, dispose } = setup();
  act(() => { tab.commands.execute('layout.export.image'); });
  const dialog = screen.getByRole('dialog', { name: 'Export' });
  expect([...screen.getByLabelText<HTMLSelectElement>('Format').options].map(option => option.value)).toEqual(['pfl', 'pdf', 'layout', 'png', 'jpeg', 'svg', 'dxf']);
  fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '300' } });
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'dxf' } });
  fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'drawing' } });
  fireEvent.change(screen.getByLabelText('Drawing scale denominator'), { target: { value: '50' } });
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'layout' } });
  expect(screen.queryByLabelText('Resolution')).toBeNull();
  expect(screen.queryByLabelText('Area')).toBeNull();
  expect(screen.queryByLabelText(/Current page/)).toBeNull();
  expect(summary()).toContain('Entire document');
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'png' } });
  expect(screen.getByLabelText<HTMLSelectElement>('Resolution').value).toBe('300');
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'dxf' } });
  expect(screen.getByLabelText<HTMLSelectElement>('Area').value).toBe('drawing');
  expect(screen.getByLabelText<HTMLInputElement>('Drawing scale denominator').value).toBe('50');
  expect(screen.getByRole('dialog', { name: 'Export' })).toBe(dialog);
  dispose();
});


it('exports selected pages as one PDF with a 300 dpi default (–4430)', async () => {
  const { tab, dispose } = setup();
  act(() => { tab.commands.execute('layout.page.add', {}); tab.commands.execute('layout.export.image'); });
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'pdf' } });
  expect(screen.getByLabelText<HTMLSelectElement>('Resolution').value).toBe('300');
  fireEvent.change(screen.getByLabelText('Page range'), { target: { value: '0' } });
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Export…' }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Page range'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  // The first PDF export loads pdf-lib and encodes a 300 dpi page; a full-suite run can exceed the default 1 s.
  await waitFor(() => expect(written.length).toBe(1), { timeout: 10_000 });
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.load(written[0]!);
  expect(pdf.getPageCount()).toBe(1);
  expect(pdf.getPage(0).getWidth()).toBeCloseTo(297 * 72 / 25.4);
  expect(choose).toHaveBeenCalledWith(expect.stringMatching(/\.pdf$/), { description: 'PDF document', mime: 'application/pdf', extension: 'pdf' });
  dispose();
});

// A 1 × 1 pixel picture in each format, for embedding in a PDF.
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG_1PX = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='), c => c.charCodeAt(0));

/** A document with one placed picture and the Export dialog open on PDF; returns the PDF's image filters after export. */
async function pdfWithPicture(tab: ReturnType<typeof setup>['tab']) {
  const { setLayoutCanvasPicture } = await import('./layoutImage');
  const picture = document.createElement('canvas');
  vi.spyOn(picture, 'toDataURL').mockReturnValue(PNG_1PX);
  setLayoutCanvasPicture(PNG_1PX, picture);
  act(() => {
    tab.commands.execute('layout.clipboard.paste', { pageId: tab.activePageId, entities: [{ kind: 'image', closed: true,
      points: [[80, 10], [90, 10], [90, 20], [80, 20]], image: { src: PNG_1PX } }] });
    tab.commands.execute('layout.export.image');
  });
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'pdf' } });
}
async function imageFilters(bytes: Uint8Array): Promise<string[]> {
  const { PDFDocument, PDFName, PDFRawStream } = await import('pdf-lib');
  const pdf = await PDFDocument.load(bytes);
  return pdf.context.enumerateIndirectObjects().flatMap(([, object]) => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image'
    ? [String(object.dict.get(PDFName.of('Filter')))] : []);
}

it('compresses PDF images as JPEG at the chosen quality and shows the PDF in a new tab', async () => {
  const { tab, dispose } = setup();
  await pdfWithPicture(tab);
  const viewer = { location: { href: '' }, close: vi.fn() };
  vi.mocked(window.open).mockReturnValue(viewer as unknown as Window);
  const objectUrls: string[] = [];
  URL.createObjectURL = vi.fn((blob: Blob) => { objectUrls.push(blob.type); return 'blob:pdf'; });
  URL.revokeObjectURL = vi.fn();
  vi.mocked(encodeImage).mockResolvedValue(JPEG_1PX);
  expect(screen.getByLabelText<HTMLInputElement>('JPEG compression').checked).toBe(false);
  expect(screen.queryByLabelText('JPEG quality')).toBeNull();
  expect(screen.getByLabelText<HTMLInputElement>('Show the PDF after export').checked).toBe(true);
  fireEvent.click(screen.getByLabelText('JPEG compression'));
  expect(screen.getByLabelText<HTMLInputElement>('JPEG quality').value).toBe('0.8');
  fireEvent.change(screen.getByLabelText('JPEG quality'), { target: { value: '0.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  await waitFor(() => expect(written.length).toBe(1), { timeout: 10_000 });
  expect(encodeImage).toHaveBeenCalledWith(PNG_1PX, { mime: 'image/jpeg', quality: 0.5, fill: '#ffffff' });
  expect(await imageFilters(written[0]!)).toEqual(['/DCTDecode']);
  // The tab was opened by the click and shows the written bytes once they exist; the dialog closes.
  expect(window.open).toHaveBeenCalledWith('', '_blank');
  expect(viewer.location.href).toBe('blob:pdf');
  expect(objectUrls).toEqual(['application/pdf']);
  expect(viewer.close).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Export' })).toBeNull());
  dispose();
});

it('keeps PDF images lossless and opens nothing when the options are off, closing a tab opened for a cancelled export', async () => {
  const { tab, dispose } = setup();
  await pdfWithPicture(tab);
  // Cancelling the save closes the tab the click opened.
  const viewer = { location: { href: '' }, close: vi.fn() };
  vi.mocked(window.open).mockReturnValue(viewer as unknown as Window);
  choose.mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  await waitFor(() => expect(viewer.close).toHaveBeenCalled());
  expect(written).toEqual([]);
  // With showing off, no tab is opened; without compression the picture stays PNG.
  vi.mocked(window.open).mockClear();
  fireEvent.click(screen.getByLabelText('Show the PDF after export'));
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  await waitFor(() => expect(written.length).toBe(1), { timeout: 10_000 });
  expect(window.open).not.toHaveBeenCalled();
  expect(encodeImage).not.toHaveBeenCalled();
  // A PNG with transparency embeds as the image plus its soft mask, both lossless.
  expect(await imageFilters(written[0]!)).toEqual(['/FlateDecode', '/FlateDecode']);
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Export' })).toBeNull());
  dispose();
});

it('shows the PDF through the desktop save target instead of a browser tab', async () => {
  flags.tauri = true;
  const open = vi.fn(async () => {});
  choose.mockResolvedValue({ write: async bytes => { written.push(bytes); }, open });
  const { tab, dispose } = setup();
  act(() => { tab.commands.execute('layout.export.image'); });
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'pdf' } });
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  expect(window.open).not.toHaveBeenCalled();
  expect(written.length).toBe(1);
  dispose();
});

it('exports all pages in a native Layout copy and preserves saved state through cancellation and errors', async () => {
  const { tab, dispose } = setup();
  act(() => { tab.commands.execute('layout.page.add', {}); });
  tab.identity = 'cloud:test-account:test-project:test-file';
  const before = { name: tab.name, identity: tab.identity, savedContent: tab.savedContent, activePageId: tab.activePageId };
  const version = tab.doc.version, content = layoutJson(tab.doc.state);
  act(() => { tab.commands.execute('layout.export.image'); });
  fireEvent.click(screen.getByLabelText(/Current page/));
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'pfl' } });
  expect(screen.queryByLabelText(/Current page/)).toBeNull();
  expect(screen.queryByLabelText('Resolution')).toBeNull();
  expect(summary()).toBe(`Entire document · ${tab.name}`);
  choose.mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Export…' }).disabled).toBe(false));
  expect(written).toHaveLength(0);
  choose.mockResolvedValueOnce({ write: async () => { throw new Error('Disk full'); } });
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Disk full');
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Export' })).toBeNull());
  expect(choose).toHaveBeenLastCalledWith(tab.name, { description: 'PushForm Layout', mime: 'application/octet-stream', extension: 'pfl' });
  expect(layoutJson(decodeLayoutDocument(written[0]!).state)).toBe(content);
  expect(tab).toMatchObject(before);
  expect(tab.doc.version).toBe(version);
  expect(tab.doc.undoStack.canUndo).toBe(true);
  dispose();
});
