// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';
import { TopBar } from './TopBar';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const app = createApp({ demo: false, expose: false }), session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId;
  const view = render(<><TopBar session={session} /><LayoutWorkspace tab={tab} session={session} /></>);
  const input = screen.getByLabelText('Import image or DXF file') as HTMLInputElement;
  return { tab, pageId, session, input, view, entities: () => [...tab.doc.state.pages.get(pageId)!.entities.values()],
    dispose: () => { view.unmount(); session.dispose(); app.dispose(); } };
}
function mockImage(fail = false) {
  vi.stubGlobal('Image', class {
    naturalWidth = 160; naturalHeight = 80; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => fail ? this.onerror?.() : this.onload?.()); }
  });
}

it('opens the same image picker from Import after Table, the Layout menu, and command search', () => {
  const { tab, input, view, dispose } = setup();
  const picker = vi.spyOn(input, 'click').mockImplementation(() => {});
  const buttons = within(screen.getByRole('navigation', { name: 'Layout tools' })).getAllByRole('button');
  const labels = buttons.map(button => button.getAttribute('aria-label'));
  expect(labels[labels.indexOf('Table') + 1]).toBe('Import');
  expect(screen.getByRole('button', { name: 'Import' }).querySelector('svg')).toBeTruthy();
  const version = tab.doc.version;
  fireEvent.click(screen.getByRole('button', { name: 'Import' }));
  expect(picker).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Import...' }));
  expect(picker).toHaveBeenCalledTimes(2);
  const search = screen.getByRole('combobox', { name: 'Search tools and commands' });
  fireEvent.focus(search); fireEvent.change(search, { target: { value: 'Import' } });
  expect(screen.getByRole('option', { name: 'Import' }).getAttribute('aria-disabled')).not.toBe('true');
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(picker).toHaveBeenCalledTimes(3);
  fireEvent.change(input, { target: { files: [] } });
  expect(tab.doc.version).toBe(version);
  view.unmount(); expect(tab.commands.isEnabled('layout.import')).toBe(false);
  dispose();
});

it.each(['png', 'jpg', 'svg'])('embeds an imported %s centered, selected, editable, undoable, and persistent', async extension => {
  mockImage();
  const { tab, pageId, session, input, entities, dispose } = setup();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="red"/></svg>';
  const file = new File([extension === 'svg' ? svg : 'bytes'], `picture.${extension}`, { type: extension === 'jpg' ? 'image/jpeg' : extension === 'svg' ? 'image/svg+xml' : 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(entities()).toHaveLength(1));
  const entity = entities()[0]!;
  expect(entity.image?.src).toMatch(/^data:image\//);
  const [a, b, c] = entity.points;
  expect((a![0] + c![0]) / 2).toBeCloseTo(148.5); expect((a![1] + c![1]) / 2).toBeCloseTo(105);
  expect((b![0] - a![0]) / (c![1] - a![1])).toBeCloseTo(2);
  expect(screen.getByRole('button', { name: 'Resize image bottom right' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Rotate clockwise' }));
  expect(entities()[0]!.points[1]![0]).toBeCloseTo(entities()[0]!.points[0]![0]);
  expect((await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state.pages.get(pageId)?.entities.get(entity.id)).toEqual(entities()[0]);
  act(() => { tab.commands.execute('edit.undo'); tab.commands.execute('edit.undo'); }); expect(entities()).toHaveLength(0);
  act(() => { tab.commands.execute('edit.redo'); }); expect(entities()).toHaveLength(1);
  dispose();
});

it('reports an unreadable image without document changes', async () => {
  mockImage(true);
  const { tab, input, entities, dispose } = setup();
  const version = tab.doc.version;
  fireEvent.change(input, { target: { files: [new File(['bad'], 'bad.png', { type: 'image/png' })] } });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be loaded'));
  expect(tab.doc.version).toBe(version); expect(entities()).toHaveLength(0);
  dispose();
});

it('cancels pending imports on a page change', async () => {
  let finish: (() => void) | undefined;
  vi.stubGlobal('Image', class {
    naturalWidth = 160; naturalHeight = 80; onload: (() => void) | null = null;
    set src(_value: string) { finish = () => this.onload?.(); }
  });
  const { tab, session, input, entities, dispose } = setup();
  fireEvent.change(input, { target: { files: [new File(['image'], 'picture.png', { type: 'image/png' })] } });
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  act(() => { session.setActivePage(tab.commands.execute('layout.page.add', {}) as number); });
  await act(async () => { finish?.(); });
  expect(entities()).toHaveLength(0);
  expect(tab.doc.state.pages.get(tab.activePageId)!.entities.size).toBe(0);
  dispose();
});

/** A file whose bytes jsdom can read. */
function textFile(text: string, name: string): File {
  const file = new File([text], name), bytes = new TextEncoder().encode(text);
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer });
  return file;
}

/** A DXF in millimeters with a 10 m line on layer A and a circle: 1:50 on the default page. */
const DXF = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '8', 'A', '10', '0', '20', '0', '30', '0', '11', '10000', '21', '0', '31', '0',
  '0', 'CIRCLE', '8', '0', '10', '5000', '20', '2000', '30', '0', '40', '500',
  '0', 'POINT', '8', '0', '10', '0', '20', '0', '30', '0', '0', 'ENDSEC', '0', 'EOF'].join('\n');

it('imports a DXF drawing as one selected, undoable group of native objects at a standard scale', async () => {
  const { tab, input, entities, dispose } = setup();
  fireEvent.change(input, { target: { files: [textFile(DXF, 'Plan.dxf')] } });
  await waitFor(() => expect(entities()).toHaveLength(2));
  const [wall, round] = entities();
  expect(wall).toMatchObject({ kind: 'path', closed: false });
  expect(round).toMatchObject({ kind: 'path', closed: true });
  expect(wall!.groupId).toBe(round!.groupId);
  expect(wall!.points[1]![0] - wall!.points[0]![0]).toBeCloseTo(200);
  expect(screen.getByRole('status').textContent).toBe('Imported Plan.dxf at 1:50. 1 entity is not imported: 1 POINT.');
  expect((tab.doc.undoStack.peek() as { label: string } | undefined)?.label).toBe('Import DXF');
  act(() => { tab.commands.execute('edit.undo'); }); expect(entities()).toHaveLength(0);
  dispose();
});

it('reports a DXF without importable content without document changes', async () => {
  const { tab, input, entities, dispose } = setup();
  const version = tab.doc.version;
  fireEvent.change(input, { target: { files: [textFile('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n', 'Empty.dxf')] } });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('no lines, curves, fills or text'));
  expect(tab.doc.version).toBe(version); expect(entities()).toHaveLength(0);
  dispose();
});
