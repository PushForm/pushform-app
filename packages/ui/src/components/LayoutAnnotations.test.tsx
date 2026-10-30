// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { resolveLayoutText } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('inserts angle-bracket page and custom tags through the Auto-Text controls', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  const id = tab.commands.execute('layout.text.add', { pageId: tab.activePageId, kind: 'text', points: [[10, 10], [70, 30]],
    text: { content: '', fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false, italic: false, underline: false,
      align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none' } }) as number;
  tab.workspace.selectedEntityId = id;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 60, clientY: 60 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 60, clientY: 60 });
  expect(screen.getByRole('option', { name: '<PageNumber>' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Insert auto-text' }));
  fireEvent.change(screen.getByLabelText('Auto-text field name'), { target: { value: 'ProjectName' } });
  fireEvent.change(screen.getByLabelText('Auto-text field value'), { target: { value: 'Library' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert auto-text' }));
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  const page = reopened.state.pages.get(tab.activePageId)!;
  expect(page.entities.get(id)?.text?.content).toBe('<PageNumber><ProjectName>');
  expect(resolveLayoutText(page.entities.get(id)!.text!.content, page, reopened.state)).toBe('1Library');
  expect(screen.getByRole('option', { name: '<ProjectName>' })).toBeTruthy();
  cleanup(); session.dispose(); app.dispose();
});
it('edits page-number fields in the Auto-Text controls', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  const cover = tab.activePageId;
  const sheet = tab.commands.execute('layout.page.add', { name: 'Sheet' }) as number;
  const id = tab.commands.execute('layout.text.add', { pageId: cover, kind: 'text', points: [[10, 10], [70, 30]],
    text: { content: '<PageNumber>', fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false, italic: false, underline: false,
      align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none' } }) as number;
  tab.workspace.selectedEntityId = id;
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 60, clientY: 60 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 60, clientY: 60 });
  const doc = async () => (await openLayoutFile((await session.saveLayoutBytes(tab.id)))).state;
  const shown = async () => { const state = await doc(); return state.pageOrder.map((pageId) => resolveLayoutText('<PageNumber>/<Folio>', state.pages.get(pageId)!, state)); };

  // <PageNumber> shows its numbering: start the sheets on the second page, two-digit.
  fireEvent.change(screen.getByLabelText('Start page'), { target: { value: String(sheet) } });
  fireEvent.change(screen.getByLabelText('Style'), { target: { value: 'two-digit' } });
  expect(await shown()).toEqual(['/<Folio>', '01/<Folio>']);

  // A new custom name made a page-number field starts at 1 on the first page.
  fireEvent.change(screen.getByLabelText('Auto-text field name'), { target: { value: 'Folio' } });
  fireEvent.change(screen.getByLabelText('Auto-text field type'), { target: { value: 'page-number' } });
  fireEvent.change(screen.getByLabelText('Start number'), { target: { value: '5' } });
  expect(await shown()).toEqual(['/5', '01/6']);
  expect(screen.getByRole('option', { name: '<Folio>' })).toBeTruthy();

  // Back to <PageNumber>, then reset it to its default numbering.
  fireEvent.change(screen.getByLabelText('Auto-text field name'), { target: { value: 'PageNumber' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset page numbering' }));
  expect(await shown()).toEqual(['1/5', '2/6']);
  cleanup(); session.dispose(); app.dispose();
});
it('creates, edits, saves, duplicates, and undoes text and paper labels', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630,
    x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout();
  render(<LayoutWorkspace tab={tab} session={session} />);
  const canvas = screen.getByLabelText('Page 1 canvas');
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 210, clientY: 90 });
  const pageText = screen.getByRole('textbox', { name: 'Edit text on page' });
  expect(document.activeElement).toBe(pageText);
  fireEvent.input(pageText, { target: { textContent: 'Draft' } });
  expect(tab.doc.state.pages.get(tab.activePageId)!.entities.values().next().value?.text?.content).toBe('Draft');
  fireEvent.change(screen.getByLabelText('Text content'), { target: { value: 'Sheet <PageNumber>' } });
  fireEvent.click(screen.getByLabelText('Bold', { exact: true }));
  const page = () => tab.doc.state.pages.get(tab.activePageId)!;
  const first = page().entities.get(page().entityOrder[0]!)!;
  expect(first).toMatchObject({ kind: 'text', points: [[10, 10], [70, 30]], text: { content: 'Sheet <PageNumber>', bold: true, bounded: true } });
  fireEvent.click(screen.getByRole('button', { name: 'Label' }));
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 60, clientY: 150 });
  fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 60, clientY: 150 });
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 3, clientX: 180, clientY: 150 });
  fireEvent.pointerUp(canvas, { pointerId: 3, clientX: 180, clientY: 150 });
  expect(screen.queryByRole('textbox', { name: 'Edit label on page' })).toBeNull();
  fireEvent.pointerDown(canvas, { button: 0, pointerId: 4, clientX: 300, clientY: 210 });
  fireEvent.pointerUp(canvas, { pointerId: 4, clientX: 300, clientY: 210 });
  const pageLabel = screen.getByRole('textbox', { name: 'Edit label on page' });
  expect(document.activeElement).toBe(pageLabel);
  fireEvent.input(pageLabel, { target: { textContent: 'Room A' } });
  fireEvent.keyDown(pageLabel, { key: 'Escape' });
  expect(screen.queryByRole('textbox', { name: 'Edit label on page' })).toBeNull();
  fireEvent.doubleClick(canvas, { clientX: 310, clientY: 140 });
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Edit label on page' }));
  const label = page().entities.get(page().entityOrder[1]!)!;
  expect(label).toMatchObject({ kind: 'label', points: [[100, 40], [150, 60], [20, 50], [60, 50]], text: { content: 'Room A', leader: 'elbow', endpoint: 'arrow', vertical: 'middle' } });
  const reopened = (await openLayoutFile((await session.saveLayoutBytes(tab.id))));
  expect(reopened.state.pages.get(page().id)?.entities.get(label.id)).toEqual(label);
  const duplicate = tab.commands.execute('layout.page.duplicate', { pageId: page().id }) as number;
  expect([...tab.doc.state.pages.get(duplicate)!.entities.values()].map((entity) => entity.kind)).toEqual(['text', 'label']);
  tab.commands.execute('edit.undo');
  tab.commands.execute('edit.undo');
  tab.commands.execute('edit.undo');
  expect(page().entities.has(label.id)).toBe(false);
  session.dispose(); app.dispose();
});
