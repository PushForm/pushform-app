// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useState, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { openLayoutFile } from '@pushform/io';
import { CloudSession, type AuthApi } from '@pushform/cloud';
import { guidanceFor } from '../guidance';
import { App } from '../App';
import { createApp, type AppInstance } from '../bootstrap';
import { DocumentSession } from '../session';
import { LayoutWorkspace } from './LayoutWorkspace';

vi.mock('./ViewportView', () => ({ ViewportView: () => <div aria-label="3D viewport" /> }));

const TEXT = { content: 'Note', fontFamily: 'Arial', fontSizePt: 12, color: '#222222', bold: false, italic: false,
  underline: false, align: 'left', vertical: 'middle', bounded: true, leader: 'none', endpoint: 'none' } as const;

let scrolled: ReturnType<typeof vi.fn>;
beforeEach(() => {
  scrolled = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrolled });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  document.body.innerHTML = '';
});

/**
 * A Layout tab with one object of every kind on page 1, a second page, and a shared layer holding one text. Unless
 * `defaults` is set, the browser opens with every layer expanded and only the active page expanded, so the tests below
 * see the objects; 's own defaults are tested with `defaults`.
 */
function setup(defaults = false) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630, x: 0, y: 0, toJSON: () => ({}),
  });
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const tab = session.newLayout(), pageId = tab.activePageId, base = tab.doc.state.activeLayerId;
  tab.doc.undoStack.transact('No grid snapping', (draft) => { draft.settings.grid.snap = false; });
  const run = <T,>(id: string, params: object = {}): T => tab.commands.execute(id, params) as T;
  const line = run<number>('layout.shape.add', { pageId, points: [[10, 150], [60, 150]], closed: false });
  const rect = run<number>('layout.rectangle.add', { pageId, kind: 'rectangle', first: [20, 20], second: [60, 40] });
  const text = run<number>('layout.text.add', { pageId, kind: 'text', points: [[160, 20], [200, 40]], text: TEXT });
  const label = run<number>('layout.text.add', { pageId, kind: 'label', points: [[160, 50], [200, 60], [150, 80]], text: { ...TEXT, leader: 'straight', endpoint: 'arrow' } });
  const dimension = run<number>('layout.dimension.add', { pageId, points: [[20, 100], [60, 100], [40, 110]] });
  const table = run<number>('layout.table.add', { pageId, first: [100, 120], second: [140, 140], rows: 1, columns: 2 });
  const [image] = run<number[]>('layout.clipboard.paste', { pageId, entities: [{ kind: 'image', points: [[220, 120], [240, 120], [240, 140], [220, 140]],
    closed: true, image: { src: 'data:image/png;base64,aGVsbG8=' } }] });
  const page2 = run<number>('layout.page.add');
  const notes = run<number>('layout.layer.add', { name: 'Notes', shared: true });
  const note = run<number>('layout.text.add', { pageId, kind: 'text', points: [[160, 160], [200, 180]], text: TEXT });
  if (!defaults) tab.workspace.browserView = {
    collapsedPages: new Set([page2]), collapsedGroups: new Set(), settingsOpen: true,
    expandedLayers: new Set(tab.doc.state.pageOrder.flatMap(pid => tab.doc.state.layerOrder.map(lid => `layer:${pid}:${lid}`))),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const onClose = vi.fn();
  let setOpen: (open: boolean) => void = () => {};
  function Harness() {
    useSyncExternalStore(session.subscribe, () => session.revision);
    const [open, setOpenState] = useState(true);
    setOpen = setOpenState;
    return <LayoutWorkspace tab={tab} session={session} objectBrowser={{ host, open, onClose }} />;
  }
  render(<Harness />);
  const tree = (): HTMLElement => within(host).getByRole('tree', { name: 'Object browser' });
  const label_ = (element: Element): string => document.getElementById(element.getAttribute('aria-labelledby')!)?.textContent
    ?? (document.getElementById(element.getAttribute('aria-labelledby')!) as HTMLInputElement | null)?.value ?? '';
  const items = (level?: number): HTMLElement[] => within(tree()).getAllByRole('treeitem')
    .filter(item => level === undefined || item.getAttribute('aria-level') === String(level));
  const names = (level?: number): string[] => items(level).map(label_);
  /** The tree item for a page, a layer under a page, or an object under a page. */
  const page = (id: number): HTMLElement => tree().querySelector<HTMLElement>(`[data-key="page:${id}"]`)!;
  const layer = (pid: number, lid: number): HTMLElement | null => tree().querySelector<HTMLElement>(`[data-key="layer:${pid}:${lid}"]`);
  const object = (pid: number, eid: number): HTMLElement | null => tree().querySelector<HTMLElement>(`[data-key="object:${pid}:${eid}"]`);
  const row = (item: HTMLElement): HTMLElement => item.querySelector<HTMLElement>(':scope > .pf-layout-browser-row')!;
  const name = (item: HTMLElement): HTMLElement => row(item).querySelector<HTMLElement>('.pf-layout-browser-name')!;
  const children = (item: HTMLElement): string[] => [...item.querySelectorAll(':scope > [role="group"] > [role="treeitem"]')].map(label_);
  const entity = (id: number) => tab.doc.state.pages.get(pageId)!.entities.get(id) ?? tab.doc.state.sharedEntities.get(id);
  const selectionTitle = (): string => document.querySelector(`[aria-controls="layout-selection-${tab.id}"]`)?.textContent ?? '';
  const dispose = (): void => { session.dispose(); app.dispose(); };
  /** Close and reopen the object browser, as its rail icon does. */
  const reopen = (): void => { act(() => setOpen(false)); act(() => setOpen(true)); };
  return { app, session, tab, pageId, page2, base, notes, line, rect, text, label, dimension, table, image: image!, note, host, onClose, reopen,
    tree, items, names, page, layer, object, row, name, children, entity, selectionTitle, dispose };
}

/** Drags one tree row over another, to its upper or lower half; `cancel` presses Escape before release. */
function dragRow(t: ReturnType<typeof setup>, from: HTMLElement, over: HTMLElement, lower: boolean, options: { cancel?: boolean; during?: () => void } = {}): void {
  const target = t.row(over), source = t.row(from), y = lower ? 115 : 105;
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 100, width: 200, height: 20, right: 200, bottom: 120, x: 0, y: 100, toJSON: () => ({}) });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => target) });
  fireEvent.pointerDown(source, { button: 0, pointerId: 7, clientX: 5, clientY: 0 });
  fireEvent.pointerMove(source, { pointerId: 7, clientX: 5, clientY: y });
  options.during?.();
  if (options.cancel) fireEvent.keyDown(from, { key: 'Escape' });
  fireEvent.pointerUp(source, { pointerId: 7, clientX: 5, clientY: y });
  // The click that ends a drag lands on the dragged item's row, wherever the drop put it, and never changes the selection.
  fireEvent.click(t.row(t.tree().querySelector<HTMLElement>(`[data-key="${from.dataset['key']}"]`) ?? from));
  delete (document as Partial<Document>).elementFromPoint;
}

describe('Layout object browser', () => {
  it('lists Document Settings, pages, layers top first and objects front-most first with kind names', () => {
    const t = setup();
    expect(t.names(1)).toEqual(['Document Settings', 'Page 1', 'Page 2']);
    expect(t.items(1)[0]!.querySelector('svg')).toBeTruthy();
    // The active page starts expanded with its layers; other pages start collapsed.
    expect(t.page(t.pageId).getAttribute('aria-expanded')).toBe('true');
    expect(t.page(t.page2).getAttribute('aria-expanded')).toBe('false');
    expect(t.page(t.pageId).getAttribute('aria-current')).toBe('page');
    expect(t.children(t.page(t.pageId))).toEqual(['Notes', 'Layer 1']);
    // Top layer first.
    expect(t.tab.doc.state.layerOrder).toEqual([t.base, t.notes]);
    expect(t.children(t.layer(t.pageId, t.base)!)).toEqual(['Image 1', 'Table 1', 'Dimension 1', 'Label 1', 'Text 1', 'Shape 1', 'Line 1']);
    expect(t.children(t.layer(t.pageId, t.notes)!)).toEqual(['Text 2']);
    expect(t.items(3).every(item => item.querySelector('.pf-layout-browser-icon svg'))).toBe(true);
    // Shared layers list their objects under every page; a layer not shown on every page is listed under the active
    // page and under other pages only where it has objects (user request 2026-10-26).
    fireEvent.click(t.row(t.page(t.page2)).querySelector('.pf-layout-browser-chevron')!);
    expect(t.page(t.page2).getAttribute('aria-expanded')).toBe('true');
    expect(t.tab.activePageId).toBe(t.pageId);
    expect(t.children(t.layer(t.page2, t.notes)!)).toEqual(['Text 2']);
    expect(t.layer(t.page2, t.base)).toBeNull();
    act(() => {
      t.tab.commands.execute('layout.layer.activate', { layerId: t.base });
      t.tab.commands.execute('layout.shape.add', { pageId: t.page2, points: [[10, 10], [60, 10]], closed: false });
    });
    expect(t.children(t.layer(t.page2, t.base)!)).toEqual(['Line 2']);
    act(() => { t.tab.commands.execute('edit.undo'); });
    expect(t.layer(t.page2, t.base)).toBeNull();
    // Without the Models group while no model is attached.
    expect(t.names(1)).toEqual(['Document Settings', 'Page 1', 'Page 2']);
    expect(within(t.tree()).getAllByRole('group').length).toBeGreaterThan(0);
    t.dispose();
  });

  it('lists attached models under a Models group below Document Settings, with a Pin Version button for cloud models', () => {
    const t = setup();
    const sha = 'a'.repeat(64);
    act(() => {
      t.tab.commands.execute('layout.reference.add', { displayName: 'House', documentId: 'doc-1', revisionId: 'rev-2', revisionNumber: 2, sha256: sha });
      t.tab.doc.undoStack.transact('Import', draft => {
        draft.modelArchives = new Map([['archive', { format: 'sketchup-layout', archiveBase64: 'UEs=',
          models: new Map([['idModel', { internalTarget: 'ref/1850444548_Shed_55.skp', externalTarget: null }]]),
          viewports: new Map([['id60', { modelReferenceId: 'idModel', entityIds: [] }]]) }]]);
      });
    });
    expect(t.names(1)).toEqual(['Document Settings', 'Models', 'Page 1', 'Page 2']);
    const models = t.items(1)[1]!;
    expect(t.children(models)).toEqual(['House', 'Shed']);
    const [house, shed] = [...models.querySelectorAll<HTMLElement>(':scope > [role="group"] > [role="treeitem"]')];
    expect(document.getElementById(house!.getAttribute('aria-describedby')!)?.textContent).toBe('Cloud model, revision 2');
    expect(document.getElementById(shed!.getAttribute('aria-describedby')!)?.textContent).toBe('Embedded SketchUp model');
    const pin = within(t.row(house!)).getByRole('button', { name: 'Pin Version of House' });
    expect(pin.getAttribute('title')).toBe('Pin Version');
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    expect(within(t.row(shed!)).queryByRole('button', { name: /Pin Version/ })).toBeNull();
    fireEvent.click(pin);
    const reference = [...t.tab.doc.state.references.values()][0]!;
    expect((reference.target as { pinned: boolean }).pinned).toBe(true);
    expect(within(t.row(house!)).getByRole('button', { name: 'Pin Version of House' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById(house!.getAttribute('aria-describedby')!)?.textContent).toBe('Cloud model, revision 2, pinned');
    // Pinning is undoable, and the row's click and double-click neither select nor rename.
    fireEvent.doubleClick(t.row(house!));
    expect(screen.queryByRole('textbox', { name: /Rename/ })).toBeNull();
    act(() => { t.tab.commands.execute('edit.undo'); });
    expect((t.tab.doc.state.references.get(reference.id)!.target as { pinned: boolean }).pinned).toBe(false);
    t.dispose();
  });

  it('dims hidden layers and their objects and shows lock and eye states', () => {
    const t = setup();
    const button = (item: HTMLElement, name: string): HTMLButtonElement => within(t.row(item)).getByRole('button', { name }) as HTMLButtonElement;
    act(() => {
      t.tab.commands.execute('layout.layer.setVisible', { pageId: t.pageId, layerId: t.notes, visible: false });
      t.tab.commands.execute('layout.layer.setLocked', { layerId: t.base, locked: true });
    });
    const hidden = t.layer(t.pageId, t.notes)!;
    expect(hidden.classList.contains('is-hidden')).toBe(true);
    expect(button(hidden, 'Show Notes').getAttribute('aria-pressed')).toBe('false');
    expect(t.children(hidden)).toEqual(['Text 2']);
    expect(t.object(t.pageId, t.note)!.classList.contains('is-hidden')).toBe(true);
    expect(button(t.layer(t.pageId, t.base)!, 'Lock Layer 1').getAttribute('aria-pressed')).toBe('true');
    // Object buttons wait for their layer to be shown on the page and unlocked.
    expect(button(t.object(t.pageId, t.line)!, 'Lock Line 1').disabled).toBe(true);
    expect(button(t.object(t.pageId, t.note)!, 'Show Text 2').disabled).toBe(true);
    act(() => {
      t.tab.commands.execute('layout.layer.setLocked', { layerId: t.base, locked: false });
      t.tab.commands.execute('layout.shape.setLocked', { pageId: t.pageId, entityIds: [t.rect], locked: true });
    });
    expect(button(t.layer(t.pageId, t.base)!, 'Lock Layer 1').getAttribute('aria-pressed')).toBe('false');
    expect(button(t.object(t.pageId, t.line)!, 'Lock Line 1').getAttribute('aria-pressed')).toBe('false');
    expect(button(t.object(t.pageId, t.rect)!, 'Lock Shape 1').getAttribute('aria-pressed')).toBe('true');
    // The drawing layer is marked by its name's style, with the mark read to assistive technology; an object's hidden state reaches it too.
    const drawing = t.layer(t.pageId, t.notes)!;
    expect(drawing.classList.contains('is-drawing')).toBe(true);
    expect(t.row(drawing).querySelector('[role="img"]')).toBeNull();
    expect(document.getElementById(drawing.getAttribute('aria-describedby')!)?.textContent).toBe('Drawing layer');
    const description = document.getElementById(t.object(t.pageId, t.note)!.getAttribute('aria-describedby')!);
    expect(description?.textContent).toBe('Hidden on this page');
    expect(t.object(t.pageId, t.rect)!.hasAttribute('aria-describedby')).toBe(false);
    t.dispose();
  });

  it('shows, hides, locks and unlocks layers and objects from their rows without selecting them, each undoable', () => {
    const t = setup();
    const button = (item: HTMLElement, name: string): HTMLButtonElement => within(t.row(item)).getByRole('button', { name }) as HTMLButtonElement;
    fireEvent.click(t.row(t.object(t.pageId, t.line)!));
    expect(t.selectionTitle()).toContain('Shape');
    // An object's eye hides just that object; the click leaves the selection alone apart from dropping the hidden object.
    fireEvent.click(button(t.object(t.pageId, t.rect)!, 'Show Shape 1'));
    expect(t.entity(t.rect)?.hidden).toBe(true);
    expect(t.object(t.pageId, t.rect)!.classList.contains('is-hidden')).toBe(true);
    expect(document.getElementById(t.object(t.pageId, t.rect)!.getAttribute('aria-describedby')!)?.textContent).toBe('Hidden');
    expect(t.selectionTitle()).toContain('Shape');
    // Hiding the selected object drops it from the selection.
    fireEvent.click(button(t.object(t.pageId, t.line)!, 'Show Line 1'));
    expect(t.entity(t.line)?.hidden).toBe(true);
    expect(t.object(t.pageId, t.line)!.getAttribute('aria-selected')).toBe('false');
    act(() => { t.tab.commands.execute('edit.undo'); });
    expect(t.entity(t.line)?.hidden).toBeUndefined();
    act(() => { t.tab.commands.execute('edit.undo'); });
    expect(t.entity(t.rect)?.hidden).toBeUndefined();
    // Redo hides again and drops the object from the selection once more.
    fireEvent.click(t.row(t.object(t.pageId, t.rect)!));
    act(() => { t.tab.commands.execute('edit.redo'); });
    expect(t.entity(t.rect)?.hidden).toBe(true);
    expect(t.object(t.pageId, t.rect)!.getAttribute('aria-selected')).toBe('false');
    // Object lock.
    fireEvent.click(button(t.object(t.pageId, t.text)!, 'Lock Text 1'));
    expect(t.entity(t.text)?.locked).toBe(true);
    fireEvent.click(button(t.object(t.pageId, t.text)!, 'Lock Text 1'));
    expect(t.entity(t.text)?.locked).toBe(false);
    // A layer's eye acts on the page it is listed under, and its lock on the whole document.
    fireEvent.click(button(t.layer(t.pageId, t.notes)!, 'Show Notes'));
    expect(t.tab.doc.state.pages.get(t.pageId)!.layerVisibility?.get(t.notes)).toBe(false);
    expect(t.tab.doc.state.layers.get(t.notes)!.visible).toBe(true);
    fireEvent.click(button(t.layer(t.pageId, t.base)!, 'Lock Layer 1'));
    expect(t.tab.doc.state.layers.get(t.base)!.locked).toBe(true);
    expect(t.tab.activePageId).toBe(t.pageId);
    t.dispose();
  });

  it('renames an object in place with double-click or F2; Enter or blur commits, Escape cancels, empty restores the default, with undo', async () => {
    const t = setup();
    const tool = t.tab.workspace.tool;
    fireEvent.doubleClick(t.name(t.object(t.pageId, t.line)!));
    let field = screen.getByRole('textbox', { name: 'Rename Line 1' }) as HTMLInputElement;
    expect(field.value).toBe('Line 1');
    expect(document.activeElement).toBe(field);
    expect(field.maxLength).toBe(100);
    // Keys typed in the field reach neither tools nor shortcuts.
    for (const [key, code] of [['l', 'KeyL'], ['r', 'KeyR'], ['Delete', 'Delete'], [' ', 'Space']] as const) fireEvent.keyDown(field, { key, code });
    expect(t.tab.workspace.tool).toBe(tool);
    expect(t.entity(t.line)).toBeTruthy();
    fireEvent.change(field, { target: { value: '  Ridge line  ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(t.entity(t.line)!.name).toBe('Ridge line');
    expect(t.name(t.object(t.pageId, t.line)!).textContent).toBe('Ridge line');
    expect(document.activeElement).toBe(t.object(t.pageId, t.line));
    // Undo and redo each take the whole rename.
    act(() => { t.tab.commands.execute('edit.undo'); });
    expect(t.entity(t.line)!.name).toBeUndefined();
    expect(t.name(t.object(t.pageId, t.line)!).textContent).toBe('Line 1');
    act(() => { t.tab.commands.execute('edit.redo'); });
    expect(t.name(t.object(t.pageId, t.line)!).textContent).toBe('Ridge line');
    // Escape cancels without a document change and keeps the panel open.
    const version = t.tab.doc.version;
    t.object(t.pageId, t.line)!.focus();
    fireEvent.keyDown(t.object(t.pageId, t.line)!, { key: 'F2' });
    field = screen.getByRole('textbox', { name: 'Rename Ridge line' }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Discarded' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: /^Rename/ })).toBeNull();
    expect(t.entity(t.line)!.name).toBe('Ridge line');
    expect(t.tab.doc.version).toBe(version);
    expect(t.onClose).not.toHaveBeenCalled();
    // An unchanged name records nothing; leaving the field commits.
    fireEvent.keyDown(t.object(t.pageId, t.line)!, { key: 'F2' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename Ridge line' }), { key: 'Enter' });
    expect(t.tab.doc.version).toBe(version);
    fireEvent.doubleClick(t.name(t.object(t.pageId, t.rect)!));
    fireEvent.change(screen.getByRole('textbox', { name: 'Rename Shape 1' }), { target: { value: 'Window' } });
    act(() => { screen.getByLabelText('Page 1 canvas').focus(); });
    expect(t.entity(t.rect)!.name).toBe('Window');
    // An unchanged default name is not stored as a custom name.
    fireEvent.doubleClick(t.name(t.object(t.pageId, t.text)!));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename Text 1' }), { key: 'Enter' });
    expect(t.entity(t.text)!.name).toBeUndefined();
    // An empty name restores the default; names persist with the document.
    fireEvent.doubleClick(t.name(t.object(t.pageId, t.line)!));
    fireEvent.change(screen.getByRole('textbox', { name: 'Rename Ridge line' }), { target: { value: '   ' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename Ridge line' }), { key: 'Enter' });
    expect(t.entity(t.line)!.name).toBeUndefined();
    expect(t.name(t.object(t.pageId, t.line)!).textContent).toBe('Line 1');
    const reopened = (await openLayoutFile((await t.session.saveLayoutBytes(t.tab.id))));
    expect(reopened.state.pages.get(t.pageId)!.entities.get(t.rect)!.name).toBe('Window');
    // Shared objects rename too, and the name follows them to every page.
    fireEvent.doubleClick(t.name(t.object(t.pageId, t.note)!));
    const shared = screen.getByRole('textbox', { name: 'Rename Text 2' });
    fireEvent.change(shared, { target: { value: 'Title block' } });
    fireEvent.keyDown(shared, { key: 'Enter' });
    expect(t.tab.doc.state.sharedEntities.get(t.note)!.name).toBe('Title block');
    // Shortcuts still work outside the browser.
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL' });
    expect(t.tab.workspace.tool).toBe('line');
    t.dispose();
  });

  it('renames pages and layers the same way and keeps the previous name when emptied', () => {
    const t = setup();
    fireEvent.doubleClick(t.name(t.page(t.page2)));
    let field = screen.getByRole('textbox', { name: 'Rename Page 2' }) as HTMLInputElement;
    expect(field.hasAttribute('maxLength')).toBe(false);
    fireEvent.change(field, { target: { value: 'Cover' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(t.tab.doc.state.pages.get(t.page2)!.name).toBe('Cover');
    expect(t.names(1)).toEqual(['Document Settings', 'Page 1', 'Cover']);
    const version = t.tab.doc.version;
    fireEvent.keyDown(t.page(t.page2), { key: 'F2' });
    field = screen.getByRole('textbox', { name: 'Rename Cover' }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: ' ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(t.tab.doc.state.pages.get(t.page2)!.name).toBe('Cover');
    expect(t.tab.doc.version).toBe(version);
    act(() => { t.tab.commands.execute('layout.layer.setLocked', { layerId: t.base, locked: true }); });
    fireEvent.keyDown(t.layer(t.pageId, t.base)!, { key: 'F2' });
    field = screen.getByRole('textbox', { name: 'Rename Layer 1' }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Base' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(t.tab.doc.state.layers.get(t.base)!.name).toBe('Base');
    expect(t.tab.doc.state.layers.get(t.base)!.name).toBe('Base');
    act(() => { t.tab.commands.execute('edit.undo'); });
    expect(t.name(t.layer(t.pageId, t.base)!).textContent).toBe('Layer 1');
    t.dispose();
  });

  it('selects a range of layers including their collapsed children', () => {
    const t = setup();
    // Collapse both layers so their descendants must be included without visible rows.
    for (const id of [t.base, t.notes]) {
      const layer = t.layer(t.pageId, id)!;
      if (layer.getAttribute('aria-expanded') === 'true')
        fireEvent.click(t.row(layer).querySelector('.pf-layout-browser-chevron')!);
    }
    fireEvent.click(t.row(t.layer(t.pageId, t.notes)!));
    fireEvent.click(t.row(t.layer(t.pageId, t.base)!), { shiftKey: true });
    for (const id of [t.line, t.rect, t.text, t.note])
      expect(t.object(t.pageId, id)!.getAttribute('aria-selected')).toBe('true');
    t.dispose();
  });

  it('selects objects like a canvas click, with the canvas modifiers, and switches pages', () => {
    const t = setup();
    fireEvent.click(t.row(t.object(t.pageId, t.rect)!));
    expect(t.selectionTitle()).toBe('Shape');
    expect(t.object(t.pageId, t.rect)!.getAttribute('aria-selected')).toBe('true');
    expect(t.object(t.pageId, t.line)!.getAttribute('aria-selected')).toBe('false');
    fireEvent.click(t.row(t.object(t.pageId, t.line)!), { ctrlKey: true });
    expect(t.selectionTitle()).toBe('2 Objects');
    expect(t.object(t.pageId, t.line)!.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(t.row(t.object(t.pageId, t.line)!), { shiftKey: true });
    expect(t.selectionTitle()).toBe('Shape');
    fireEvent.click(t.row(t.object(t.pageId, t.text)!), { metaKey: true });
    expect(t.selectionTitle()).toBe('2 Objects');
    // As on the canvas: Ctrl only adds, and Ctrl+Shift removes.
    fireEvent.click(t.row(t.object(t.pageId, t.text)!), { ctrlKey: true });
    expect(t.selectionTitle()).toBe('2 Objects');
    fireEvent.click(t.row(t.object(t.pageId, t.text)!), { ctrlKey: true, shiftKey: true });
    expect(t.selectionTitle()).toBe('Shape');
    fireEvent.click(t.row(t.object(t.pageId, t.text)!), { ctrlKey: true, shiftKey: true });
    expect(t.selectionTitle()).toBe('Shape');
    // A plain click on a member of a multiple selection selects only that object.
    fireEvent.click(t.row(t.object(t.pageId, t.text)!), { shiftKey: true });
    fireEvent.click(t.row(t.object(t.pageId, t.text)!));
    expect(t.selectionTitle()).toBe('Text');
    fireEvent.click(t.row(t.object(t.pageId, t.table)!));
    expect(t.selectionTitle()).toBe('Table');
    // An object inside a group selects just that object, unlike a canvas click; its group item does not show as selected.
    act(() => { t.tab.commands.execute('layout.shape.group', { pageId: t.pageId, entityIds: [t.rect, t.line] }); });
    fireEvent.click(t.row(t.object(t.pageId, t.rect)!));
    expect(t.selectionTitle()).toBe('Shape');
    expect(t.object(t.pageId, t.line)!.getAttribute('aria-selected')).toBe('false');
    expect(within(t.tree()).getByRole('treeitem', { name: 'Group 1' }).getAttribute('aria-selected')).toBe('false');
    fireEvent.click(t.row(t.object(t.pageId, t.line)!), { ctrlKey: true });
    expect(t.selectionTitle()).toBe('2 Objects');
    // A shared object under another page switches to that page and selects it there.
    fireEvent.click(t.row(t.page(t.page2)).querySelector('.pf-layout-browser-chevron')!);
    fireEvent.click(t.row(t.object(t.page2, t.note)!));
    expect(t.tab.activePageId).toBe(t.page2);
    expect(t.selectionTitle()).toBe('Text');
    expect(t.object(t.page2, t.note)!.getAttribute('aria-selected')).toBe('true');
    expect(t.object(t.pageId, t.note)!.getAttribute('aria-selected')).toBe('false');
    expect(t.page(t.page2).getAttribute('aria-current')).toBe('page');
    // A modified click on another page's object replaces the selection there.
    act(() => { t.session.setActivePage(t.pageId); });
    fireEvent.click(t.row(t.object(t.pageId, t.table)!));
    fireEvent.click(t.row(t.object(t.page2, t.note)!), { ctrlKey: true });
    expect(t.tab.activePageId).toBe(t.page2);
    expect(t.selectionTitle()).toBe('Text');
    // Objects on hidden layers only activate their page.
    act(() => { t.tab.commands.execute('layout.layer.setVisible', { pageId: t.pageId, layerId: t.notes, visible: false }); });
    fireEvent.click(t.row(t.object(t.pageId, t.note)!));
    expect(t.tab.activePageId).toBe(t.pageId);
    expect(t.selectionTitle()).toBe('Default Style');
    fireEvent.click(t.row(t.object(t.pageId, t.note)!));
    expect(t.selectionTitle()).toBe('Default Style');
    t.dispose();
  });

  it('switches to Select and ends an open drawing draft when an object is clicked', () => {
    const t = setup();
    const canvas = screen.getByLabelText('Page 1 canvas');
    const click = (x: number, y: number): void => {
      fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
      fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: x * 3, clientY: y * 3 });
    };
    fireEvent.click(screen.getByRole('button', { name: 'Line' }));
    click(250, 180);
    const count = t.tab.doc.state.pages.get(t.pageId)!.entities.size;
    fireEvent.click(t.row(t.object(t.pageId, t.rect)!));
    expect(t.tab.workspace.tool).toBe('select');
    expect(t.selectionTitle()).toBe('Shape');
    expect(screen.getByLabelText('Selected object bounds')).toBeTruthy();
    // The pending line is gone: the next canvas click selects rather than finishing it.
    click(270, 190);
    expect(t.tab.doc.state.pages.get(t.pageId)!.entities.size).toBe(count);
    // An object on a hidden layer selects nothing and keeps the tool.
    fireEvent.click(screen.getByRole('button', { name: 'Line' }));
    act(() => { t.tab.commands.execute('layout.layer.setVisible', { pageId: t.pageId, layerId: t.notes, visible: false }); });
    fireEvent.click(t.row(t.object(t.pageId, t.note)!));
    expect(t.tab.workspace.tool).toBe('line');
    t.dispose();
  });

  it('scrolls a canvas selection into view when its page and layer are already expanded', () => {
    const t = setup();
    expect(t.layer(t.pageId, t.base)!.getAttribute('aria-expanded')).toBe('true');
    scrolled.mockClear();
    const canvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 20 * 3, clientY: 30 * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 20 * 3, clientY: 30 * 3 });
    expect(t.selectionTitle()).toBe('Shape');
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(t.row(t.object(t.pageId, t.rect)!));
    // A later document edit that keeps the selection does not scroll again.
    act(() => { t.tab.commands.execute('layout.shape.rename', { pageId: t.pageId, entityId: t.line, name: 'Edge' }); });
    expect(scrolled).toHaveBeenCalledTimes(1);
    t.dispose();
  });

  it('mirrors canvas selection, expanding and revealing the object', () => {
    const t = setup();
    // Collapse the page, then select on the canvas: the page and layer open and the object scrolls into view.
    fireEvent.click(t.row(t.layer(t.pageId, t.base)!).querySelector('.pf-layout-browser-chevron')!);
    expect(t.layer(t.pageId, t.base)!.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(t.row(t.page(t.pageId)).querySelector('.pf-layout-browser-chevron')!);
    expect(t.object(t.pageId, t.rect)).toBeNull();
    scrolled.mockClear();
    const canvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 20 * 3, clientY: 30 * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 20 * 3, clientY: 30 * 3 });
    expect(t.selectionTitle()).toBe('Shape');
    expect(t.page(t.pageId).getAttribute('aria-expanded')).toBe('true');
    expect(t.layer(t.pageId, t.base)!.getAttribute('aria-expanded')).toBe('true');
    expect(t.object(t.pageId, t.rect)!.getAttribute('aria-selected')).toBe('true');
    expect(scrolled).toHaveBeenCalled();
    expect(within(t.tree()).getAllByRole('treeitem').filter(item => item.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    t.dispose();
  });

  it('activates pages and drawing layers', () => {
    const t = setup();
    expect(t.tab.doc.state.activeLayerId).toBe(t.notes);
    fireEvent.click(t.row(t.page(t.page2)));
    expect(t.tab.activePageId).toBe(t.page2);
    expect(t.page(t.page2).getAttribute('aria-expanded')).toBe('true');
    expect(t.page(t.page2).getAttribute('aria-current')).toBe('page');
    fireEvent.click(t.row(t.layer(t.pageId, t.base)!));
    expect(t.tab.activePageId).toBe(t.pageId);
    expect(t.tab.doc.state.activeLayerId).toBe(t.base);
    expect(t.layer(t.pageId, t.base)!.classList.contains('is-drawing')).toBe(true);
    expect(t.layer(t.pageId, t.notes)!.classList.contains('is-drawing')).toBe(false);
    // Locked or hidden layers cannot become the drawing layer; the click only activates the page.
    act(() => {
      t.tab.commands.execute('layout.layer.setLocked', { layerId: t.notes, locked: true });
      t.session.setActivePage(t.page2);
    });
    fireEvent.click(t.row(t.layer(t.pageId, t.notes)!));
    expect(t.tab.activePageId).toBe(t.pageId);
    expect(t.tab.doc.state.activeLayerId).toBe(t.base);
    act(() => {
      t.tab.commands.execute('layout.layer.setLocked', { layerId: t.notes, locked: false });
      t.tab.commands.execute('layout.layer.setVisible', { pageId: t.pageId, layerId: t.notes, visible: false });
    });
    fireEvent.click(t.row(t.layer(t.pageId, t.notes)!));
    expect(t.tab.doc.state.activeLayerId).toBe(t.base);
    t.dispose();
  });

  it('shows the page size under Document Settings and opens the document-wide Document Settings dialog from either item', () => {
    const t = setup();
    const settings = t.items(1)[0]!;
    expect(settings.getAttribute('aria-expanded')).toBe('true');
    expect(t.children(settings)).toEqual(['A4: 297 × 210 mm', 'Units: mm · Grid: 10 mm']);
    expect(screen.queryByRole('button', { name: 'Document Setup' })).toBeNull();
    const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Document Settings' });
    // A click focuses the item first, as in a browser.
    settings.focus();
    fireEvent.click(t.row(settings));
    expect(document.activeElement).toBe(within(dialog()).getByRole('combobox', { name: 'Paper size' }));
    // The paper belongs to the document: no page is named, and a change applies to every page at once.
    expect(within(dialog()).queryByText(/Page 1/)).toBeNull();
    fireEvent.change(within(dialog()).getByLabelText('Page width (mm)'), { target: { value: '420' } });
    expect(t.tab.doc.state.pages.get(t.pageId)!.size).toEqual([420, 210]);
    expect(t.tab.doc.state.pages.get(t.page2)!.size).toEqual([420, 210]);
    expect(t.children(t.items(1)[0]!)).toEqual(['Custom: 420 × 210 mm', 'Units: mm · Grid: 10 mm']);
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'Show grid' }));
    expect(t.tab.doc.state.settings.grid.show).toBe(false);
    act(() => { t.tab.commands.execute('edit.undo'); });
    expect(t.tab.doc.state.settings.grid.show).toBe(true);
    // Escape closes and returns focus to the tree.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(t.items(1)[0]);
    // Enter on the page-size item, and the command, open it too.
    const size = t.items(2).find(item => item.getAttribute('data-key') === 'settings:page-size')!;
    size.focus();
    fireEvent.keyDown(size, { key: 'Enter' });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { t.tab.commands.execute('layout.document.settings'); });
    expect(dialog()).toBeTruthy();
    // The item follows the document's size from any page.
    fireEvent.keyDown(window, { key: 'Escape' });
    act(() => { t.tab.commands.execute('layout.document.setup', { widthMm: 100, heightMm: 50 }); t.session.setActivePage(t.page2); });
    expect(t.children(t.items(1)[0]!)).toEqual(['Custom: 100 × 50 mm', 'Units: mm · Grid: 10 mm']);
    t.dispose();
  });

  it('offers US then international paper presets that fill in the size and units, and unit choices for paper and grid', () => {
    const t = setup();
    act(() => { t.tab.commands.execute('layout.document.settings'); });
    const dialog = screen.getByRole('dialog', { name: 'Document Settings' });
    const field = (name: string): HTMLInputElement => within(dialog).getByLabelText(name) as HTMLInputElement;
    const paper = within(dialog).getByRole('combobox', { name: 'Paper size' }) as HTMLSelectElement;
    expect(paper.value).toBe('A4');
    expect([...paper.querySelectorAll('optgroup')].map(group => group.label)).toEqual(['US', 'International']);
    expect(paper.querySelector('optgroup')!.querySelector('option')!.textContent).toBe('Letter (8.5 × 11 in)');
    // Letter: landscape Letter, with the page, the grid and drawing values in inches, as one undoable change.
    const newest = t.tab.doc.undoStack.peek();
    fireEvent.change(paper, { target: { value: 'letter' } });
    expect(t.tab.doc.state.pages.get(t.pageId)!.size).toEqual([279.4, 215.9]);
    expect(t.tab.doc.state.pages.get(t.page2)!.size).toEqual([279.4, 215.9]);
    expect(field('Page width (in)').value).toBe('11');
    expect(field('Page height (in)').value).toBe('8.5');
    expect(field('Margin (in)').value).toBe('0.394');
    expect((within(dialog).getByRole('combobox', { name: 'Page size units' }) as HTMLSelectElement).value).toBe('in');
    expect((within(dialog).getByRole('combobox', { name: 'Grid units' }) as HTMLSelectElement).value).toBe('in');
    expect(t.tab.doc.state.settings.units).toBe('inch');
    // The 10 mm grid rounds to the nearest usual size in inches.
    expect(t.children(t.items(1)[0]!)).toEqual(['Letter: 11 × 8.5 in', 'Units: in · Grid: 0.5 in']);
    // Typing in inches keeps partial input and stores millimeters.
    act(() => { field('Page width (in)').focus(); });
    fireEvent.change(field('Page width (in)'), { target: { value: '12.' } });
    expect(field('Page width (in)').value).toBe('12.');
    fireEvent.change(field('Page width (in)'), { target: { value: '12.5' } });
    expect(t.tab.doc.state.pages.get(t.pageId)!.size[0]).toBeCloseTo(317.5, 9);
    expect(paper.value).toBe('custom');
    // The units choice changes only how sizes are shown.
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Page size units' }), { target: { value: 'mm' } });
    expect(field('Page width (mm)').value).toBe('317.5');
    fireEvent.change(paper, { target: { value: 'A3' } });
    expect(t.tab.doc.state.pages.get(t.pageId)!.size).toEqual([420, 297]);
    expect(t.tab.doc.state.settings.paperUnits).toBe('mm');
    expect(t.tab.doc.state.settings.grid).toMatchObject({ units: 'mm', spacingMm: 10 });
    expect(t.tab.doc.state.settings.units).toBe('mm');
    // Letter, 12, 12.5, mm and A3 are five undoable steps.
    for (let i = 0; i < 5; i++) act(() => { t.tab.commands.execute('edit.undo'); });
    expect(t.tab.doc.undoStack.peek()).toBe(newest);
    // Grid size is shown in the grid's own units; changing them rounds it and sets the drawing units.
    expect(field('Grid size (mm)').value).toBe('10');
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Grid units' }), { target: { value: 'in' } });
    expect(field('Grid size (in)').value).toBe('0.5');
    expect(t.tab.doc.state.settings.units).toBe('inch');
    fireEvent.change(field('Grid size (in)'), { target: { value: '0.25' } });
    expect(t.tab.doc.state.settings.grid.spacingMm).toBeCloseTo(6.35, 9);
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Grid units' }), { target: { value: 'mm' } });
    expect(field('Grid size (mm)').value).toBe('5');
    expect(t.tab.doc.state.settings.units).toBe('mm');
    // Orientation turns the page; a preset chosen on a portrait page is landscape.
    const orientation = within(dialog).getByRole('combobox', { name: 'Orientation' }) as HTMLSelectElement;
    expect(orientation.value).toBe('landscape');
    fireEvent.change(orientation, { target: { value: 'portrait' } });
    expect(t.tab.doc.state.pages.get(t.pageId)!.size).toEqual([210, 297]);
    expect(paper.value).toBe('A4');
    fireEvent.change(paper, { target: { value: 'letter' } });
    expect(t.tab.doc.state.pages.get(t.pageId)!.size).toEqual([279.4, 215.9]);
    expect(orientation.value).toBe('landscape');
    t.dispose();
  });

  it('navigates with a roving tab stop and keeps other keys from Layout shortcuts', () => {
    const t = setup();
    const focused = (): string => document.activeElement?.getAttribute('data-key') ?? '';
    const key = (value: string, options: object = {}): void => { fireEvent.keyDown(document.activeElement!, { key: value, ...options }); };
    expect(within(t.tree()).getAllByRole('treeitem').filter(item => item.tabIndex === 0).map(item => item.getAttribute('data-key'))).toEqual(['settings']);
    t.items(1)[0]!.focus();
    key('ArrowDown'); expect(focused()).toBe('settings:page-size');
    key('ArrowLeft'); expect(focused()).toBe('settings');
    key('ArrowDown'); key('ArrowDown'); expect(focused()).toBe('settings:units');
    key('ArrowDown'); expect(focused()).toBe(`page:${t.pageId}`);
    key('ArrowRight'); expect(focused()).toBe(`layer:${t.pageId}:${t.notes}`);
    key('ArrowDown'); expect(focused()).toBe(`object:${t.pageId}:${t.note}`);
    key('ArrowLeft'); expect(focused()).toBe(`layer:${t.pageId}:${t.notes}`);
    key('ArrowLeft'); expect(t.layer(t.pageId, t.notes)!.getAttribute('aria-expanded')).toBe('false');
    key('ArrowLeft'); expect(focused()).toBe(`page:${t.pageId}`);
    key('ArrowLeft'); expect(t.page(t.pageId).getAttribute('aria-expanded')).toBe('false');
    key('ArrowRight'); expect(t.page(t.pageId).getAttribute('aria-expanded')).toBe('true');
    key('End'); expect(focused()).toBe(`page:${t.page2}`);
    expect(within(t.tree()).getAllByRole('treeitem').filter(item => item.tabIndex === 0)).toEqual([document.activeElement]);
    key('Home'); expect(focused()).toBe('settings');
    key('End'); key('Enter');
    expect(t.tab.activePageId).toBe(t.page2);
    // Tool letters, digits, arrows and Delete pressed in the tree do nothing in the workspace.
    act(() => { t.session.setActivePage(t.pageId); });
    fireEvent.click(t.row(t.object(t.pageId, t.rect)!));
    t.object(t.pageId, t.rect)!.focus();
    const points = structuredClone(t.entity(t.rect)!.points), version = t.tab.doc.version;
    for (const [value, code] of [['l', 'KeyL'], ['r', 'KeyR'], [' ', 'Space'], ['Delete', 'Delete'], ['5', 'Digit5']] as const) key(value, { code });
    key('ArrowUp', { code: 'ArrowUp' });
    t.object(t.pageId, t.rect)!.focus();
    key('ArrowRight');
    expect(t.tab.workspace.tool).toBe('select');
    expect(t.entity(t.rect)!.points).toEqual(points);
    expect(t.tab.doc.version).toBe(version);
    expect(t.onClose).not.toHaveBeenCalled();
    key('Escape');
    expect(t.onClose).toHaveBeenCalledTimes(1);
    t.dispose();
  });

  it('passes undo, redo and Print from a tree item but not from the rename field', () => {
    const t = setup();
    const item = (): HTMLElement => t.object(t.pageId, t.rect)!;
    item().focus();
    fireEvent.keyDown(item(), { key: 'F2' });
    const field = screen.getByRole('textbox', { name: 'Rename Shape 1' });
    fireEvent.change(field, { target: { value: 'Window' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(document.activeElement).toBe(item());
    fireEvent.keyDown(item(), { key: 'z', ctrlKey: true });
    expect(t.entity(t.rect)!.name).toBeUndefined();
    fireEvent.keyDown(item(), { key: 'y', ctrlKey: true });
    expect(t.entity(t.rect)!.name).toBe('Window');
    fireEvent.keyDown(item(), { key: 'z', metaKey: true });
    fireEvent.keyDown(item(), { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(t.entity(t.rect)!.name).toBe('Window');
    // In the rename field, Ctrl+Z stays the field's own text undo.
    fireEvent.keyDown(item(), { key: 'F2' });
    const version = t.tab.doc.version;
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename Window' }), { key: 'z', ctrlKey: true });
    expect(t.tab.doc.version).toBe(version);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename Window' }), { key: 'Escape' });
    // Ctrl+P opens Layout's print setup, not the browser's.
    const context = new Proxy({}, { get: (_, key) => key === 'measureText' ? () => ({ width: 5 }) : () => undefined, set: () => true });
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context as CanvasRenderingContext2D);
    expect(fireEvent.keyDown(item(), { key: 'p', ctrlKey: true })).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Print Layout' })).toBeTruthy();
    t.dispose();
  });

  it('keeps copy and paste on a tree item away from the canvas selection and the page', () => {
    const t = setup();
    const values: Record<string, string> = {};
    const clipboardData = { getData: (type: string) => values[type] ?? '', setData: (type: string, value: string) => { values[type] = value; }, files: [], items: [] };
    fireEvent.click(t.row(t.object(t.pageId, t.rect)!));
    fireEvent.copy(t.object(t.pageId, t.rect)!, { clipboardData });
    expect(values).toEqual({});
    // A clipboard holding Layout objects, as a canvas copy leaves it, is not pasted into the page from the tree.
    fireEvent.copy(window, { clipboardData });
    expect(Object.keys(values).length).toBeGreaterThan(0);
    const version = t.tab.doc.version;
    fireEvent.paste(t.object(t.pageId, t.rect)!, { clipboardData });
    expect(t.tab.doc.version).toBe(version);
    t.dispose();
  });

  it('leaves no focus request behind when Home is pressed on the item already focused', () => {
    const t = setup();
    t.items(1)[0]!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(t.items(1)[0]);
    const canvas = screen.getByLabelText('Page 1 canvas');
    act(() => { canvas.focus(); });
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 20 * 3, clientY: 30 * 3 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 20 * 3, clientY: 30 * 3 });
    expect(t.selectionTitle()).toBe('Shape');
    expect(t.tree().contains(document.activeElement)).toBe(false);
    t.dispose();
  });

  it('drags an object in front of or behind another in one undoable step without selecting it', () => {
    const t = setup();
    const base = (): string[] => t.children(t.layer(t.pageId, t.base)!);
    const newest = t.tab.doc.undoStack.peek();
    dragRow(t, t.object(t.pageId, t.line)!, t.object(t.pageId, t.table)!, false, {
      during: () => expect(t.row(t.object(t.pageId, t.table)!).classList.contains('drop-before')).toBe(true),
    });
    expect(base()).toEqual(['Image 1', 'Line 1', 'Table 1', 'Dimension 1', 'Label 1', 'Text 1', 'Shape 1']);
    expect(t.row(t.object(t.pageId, t.table)!).classList.contains('drop-before')).toBe(false);
    expect(t.object(t.pageId, t.line)!.getAttribute('aria-selected')).toBe('false');
    // The lower half of a row drops behind that object.
    dragRow(t, t.object(t.pageId, t.image)!, t.object(t.pageId, t.text)!, true);
    expect(base()).toEqual(['Line 1', 'Table 1', 'Dimension 1', 'Label 1', 'Text 1', 'Image 1', 'Shape 1']);
    act(() => { t.tab.commands.execute('edit.undo'); });
    act(() => { t.tab.commands.execute('edit.undo'); });
    expect(base()).toEqual(['Image 1', 'Table 1', 'Dimension 1', 'Label 1', 'Text 1', 'Shape 1', 'Line 1']);
    expect(t.tab.doc.undoStack.peek()).toBe(newest);
    t.dispose();
  });

  it('drags objects onto another layer, carrying the selection along, and refuses locked layers and objects', () => {
    const t = setup();
    // Dropping onto a layer row puts the object in front of that layer's objects, moving it to a shared layer if need be.
    dragRow(t, t.object(t.pageId, t.rect)!, t.layer(t.pageId, t.notes)!, false, {
      during: () => expect(t.row(t.layer(t.pageId, t.notes)!).classList.contains('drop-into')).toBe(true),
    });
    expect(t.children(t.layer(t.pageId, t.notes)!)).toEqual(['Shape 1', 'Text 2']);
    expect(t.tab.doc.state.sharedEntities.get(t.rect)?.layerId).toBe(t.notes);
    expect(t.tab.doc.state.pages.get(t.pageId)!.entities.has(t.rect)).toBe(false);
    act(() => { t.tab.commands.execute('edit.undo'); });
    // A dragged selected object brings the rest of the selection, keeping their stacking order.
    fireEvent.click(t.row(t.object(t.pageId, t.line)!));
    fireEvent.click(t.row(t.object(t.pageId, t.rect)!), { ctrlKey: true });
    dragRow(t, t.object(t.pageId, t.rect)!, t.object(t.pageId, t.image)!, true);
    expect(t.children(t.layer(t.pageId, t.base)!)).toEqual(['Image 1', 'Shape 1', 'Line 1', 'Table 1', 'Dimension 1', 'Label 1', 'Text 1']);
    // Locked layers refuse drops, and locked objects cannot be dragged.
    act(() => { t.tab.commands.execute('layout.layer.setLocked', { layerId: t.notes, locked: true }); });
    const before = t.tab.doc.version;
    dragRow(t, t.object(t.pageId, t.table)!, t.layer(t.pageId, t.notes)!, false, {
      during: () => expect(t.row(t.layer(t.pageId, t.notes)!).className).not.toMatch(/drop-/),
    });
    act(() => {
      t.tab.commands.execute('layout.layer.setLocked', { layerId: t.notes, locked: false });
      t.tab.commands.execute('layout.shape.setLocked', { pageId: t.pageId, entityIds: [t.table], locked: true });
    });
    const locked = t.tab.doc.version;
    dragRow(t, t.object(t.pageId, t.table)!, t.layer(t.pageId, t.notes)!, false);
    expect(t.tab.doc.version).toBe(locked);
    expect(before).toBeLessThan(locked);
    expect(t.children(t.layer(t.pageId, t.notes)!)).toEqual(['Text 2']);
    t.dispose();
  });

  it('drags layers to reorder them, and Escape cancels a drag', () => {
    const t = setup();
    const version = t.tab.doc.version;
    dragRow(t, t.layer(t.pageId, t.base)!, t.layer(t.pageId, t.notes)!, false, { cancel: true });
    expect(t.tab.doc.version).toBe(version);
    expect(t.onClose).not.toHaveBeenCalled();
    dragRow(t, t.layer(t.pageId, t.base)!, t.layer(t.pageId, t.notes)!, false);
    expect(t.children(t.page(t.pageId))).toEqual(['Layer 1', 'Notes']);
    expect(t.tab.doc.state.layerOrder).toEqual([t.notes, t.base]);
    t.dispose();
  });

  it('drags pages to reorder them, and moves a focused page with Alt+Up and Alt+Down', () => {
    const t = setup();
    act(() => { t.tab.commands.execute('layout.page.add'); });
    const pages = (): number[] => [...t.tab.doc.state.pageOrder];
    const [first, second, last] = pages() as [number, number, number];
    expect(last).not.toBe(second);
    const newest = t.tab.doc.undoStack.peek();
    dragRow(t, t.page(last), t.page(first), false, {
      during: () => expect(t.row(t.page(first)).classList.contains('drop-before')).toBe(true),
    });
    expect(pages()).toEqual([last, first, second]);
    expect(t.names(1)).toEqual(['Document Settings', 'Page 3', 'Page 1', 'Page 2']);
    // The lower half drops after that page; Document Settings and layers accept no page.
    dragRow(t, t.page(last), t.page(second), true);
    expect(pages()).toEqual([first, second, last]);
    dragRow(t, t.page(first), t.items(1)[0]!, false);
    dragRow(t, t.page(first), t.layer(t.pageId, t.base)!, false);
    expect(pages()).toEqual([first, second, last]);
    act(() => { t.tab.commands.execute('edit.undo'); });
    act(() => { t.tab.commands.execute('edit.undo'); });
    expect(pages()).toEqual([first, second, last]);
    expect(t.tab.doc.undoStack.peek()).toBe(newest);
    const page = t.page(second);
    page.focus();
    fireEvent.keyDown(page, { key: 'ArrowUp', altKey: true });
    expect(pages()).toEqual([second, first, last]);
    expect(document.activeElement).toBe(t.page(second));
    fireEvent.keyDown(t.page(second), { key: 'ArrowDown', altKey: true });
    expect(pages()).toEqual([first, second, last]);
    t.dispose();
  });

  it('moves the focused object or layer one step with Alt+Up and Alt+Down', () => {
    const t = setup();
    const line = t.object(t.pageId, t.line)!;
    line.focus();
    fireEvent.keyDown(line, { key: 'ArrowUp', altKey: true });
    expect(t.children(t.layer(t.pageId, t.base)!)).toEqual(['Image 1', 'Table 1', 'Dimension 1', 'Label 1', 'Text 1', 'Line 1', 'Shape 1']);
    expect(document.activeElement).toBe(t.object(t.pageId, t.line));
    fireEvent.keyDown(t.object(t.pageId, t.line)!, { key: 'ArrowDown', altKey: true });
    expect(t.children(t.layer(t.pageId, t.base)!).at(-1)).toBe('Line 1');
    const layer = t.layer(t.pageId, t.base)!;
    layer.focus();
    fireEvent.keyDown(layer, { key: 'ArrowUp', altKey: true });
    expect(t.children(t.page(t.pageId))).toEqual(['Layer 1', 'Notes']);
    expect(t.tab.workspace.tool).toBe('select');
    t.dispose();
  });

  it('offers a page context menu to add a page after it, add a layer and delete the page', () => {
    const t = setup();
    const menuItems = (): string[] => within(screen.getByRole('menu', { name: 'Page 1 menu' })).getAllByRole('menuitem').map(item => item.textContent ?? '');
    fireEvent.contextMenu(t.row(t.page(t.pageId)), { clientX: 40, clientY: 60 });
    expect(menuItems()).toEqual(['Add Page After', 'Duplicate Page', 'Add Layer', 'Rename', 'Delete Page']);
    // Add Page After inserts directly after this page and makes it active.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add Page After' }));
    expect(screen.queryByRole('menu')).toBeNull();
    const added = t.tab.doc.state.pageOrder[1]!;
    expect(added).not.toBe(t.page2);
    expect(t.tab.doc.state.pageOrder).toEqual([t.pageId, added, t.page2]);
    expect(t.tab.activePageId).toBe(added);
    expect(t.names(1)).toEqual(['Document Settings', 'Page 1', 'Page 3', 'Page 2']);
    // Add Layer makes the page active, adds a document layer and opens its name for editing under the page.
    fireEvent.contextMenu(t.row(t.page(t.pageId)), { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add Layer' }));
    expect(t.tab.activePageId).toBe(t.pageId);
    const layerId = t.tab.doc.state.layerOrder.at(-1)!;
    expect(t.tab.doc.state.layers.get(layerId)?.name).toBe('Layer 3');
    const field = screen.getByRole('textbox', { name: 'Rename Layer 3' }) as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: 'Dimensions' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(t.tab.doc.state.layers.get(layerId)?.name).toBe('Dimensions');
    expect(t.children(t.page(t.pageId))[0]).toBe('Dimensions');
    // Delete Page removes it; deleting the active page activates its neighbor.
    act(() => { t.session.setActivePage(added); });
    fireEvent.contextMenu(t.row(t.page(added)), { clientX: 40, clientY: 60 });
    fireEvent.click(within(screen.getByRole('menu', { name: 'Page 3 menu' })).getByRole('menuitem', { name: 'Delete Page' }));
    expect(t.tab.doc.state.pageOrder).toEqual([t.pageId, t.page2]);
    expect(t.tab.activePageId).toBe(t.page2);
    act(() => { t.tab.commands.execute('layout.page.delete', { pageId: t.page2 }); });
    fireEvent.contextMenu(t.row(t.page(t.pageId)), { clientX: 40, clientY: 60 });
    expect((screen.getByRole('menuitem', { name: 'Delete Page' }) as HTMLButtonElement).disabled).toBe(true);
    t.dispose();
  });

  it('offers layer and object context menus, opens them from the keyboard and returns focus on Escape', () => {
    const t = setup();
    const items = (name: string): string[] => [...screen.getByRole('menu', { name }).querySelectorAll('[role^="menuitem"]')].map(item => item.textContent?.replace('✓', '') ?? '');
    fireEvent.contextMenu(t.row(t.layer(t.pageId, t.notes)!), { clientX: 40, clientY: 60 });
    expect(items('Notes menu')).toEqual(['Rename', 'Duplicate Layer', 'Show on Every Page', 'Hide on This Page', 'Lock', 'Delete Layer']);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Show on Every Page' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide on This Page' }));
    expect(t.tab.doc.state.pages.get(t.pageId)!.layerVisibility?.get(t.notes)).toBe(false);
    // Object actions wait for their layer, as the row buttons do.
    fireEvent.contextMenu(t.row(t.object(t.pageId, t.note)!), { clientX: 40, clientY: 60 });
    expect(items('Text 2 menu')).toEqual(['Rename', 'Hide', 'Lock', 'Delete']);
    expect((screen.getByRole('menuitem', { name: 'Hide' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Text 2 menu' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(t.object(t.pageId, t.note));
    // Shift+F10 opens the focused item's menu; Rename edits it in place; right-clicking selects nothing.
    const line = t.object(t.pageId, t.line)!;
    line.focus();
    fireEvent.keyDown(line, { key: 'F10', shiftKey: true });
    expect(items('Line 1 menu')).toEqual(['Rename', 'Hide', 'Lock', 'Delete']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Lock' }));
    expect(t.entity(t.line)?.locked).toBe(true);
    fireEvent.contextMenu(t.row(t.object(t.pageId, t.line)!), { clientX: 40, clientY: 60 });
    expect(items('Line 1 menu')).toEqual(['Rename', 'Hide', 'Unlock', 'Delete']);
    expect((screen.getByRole('menuitem', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Rename Line 1' }));
    expect(t.object(t.pageId, t.line)!.getAttribute('aria-selected')).toBe('false');
    fireEvent.contextMenu(t.row(t.items(1)[0]!), { clientX: 40, clientY: 60 });
    expect(items('Document Settings menu')).toEqual(['Open Document Settings']);
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Document Settings menu' }), { key: 'Escape' });
    t.dispose();
  });

  it('starts with pages expanded and layers collapsed, and keeps its expansion when closed and reopened', () => {
    const t = setup(true);
    expect(t.page(t.pageId).getAttribute('aria-expanded')).toBe('true');
    expect(t.page(t.page2).getAttribute('aria-expanded')).toBe('true');
    expect(t.layer(t.pageId, t.base)!.getAttribute('aria-expanded')).toBe('false');
    expect(t.object(t.pageId, t.line)).toBeNull();
    fireEvent.click(t.row(t.layer(t.pageId, t.base)!).querySelector('.pf-layout-browser-chevron')!);
    fireEvent.click(t.row(t.page(t.page2)).querySelector('.pf-layout-browser-chevron')!);
    expect(t.object(t.pageId, t.line)).not.toBeNull();
    t.reopen();
    expect(t.layer(t.pageId, t.base)!.getAttribute('aria-expanded')).toBe('true');
    expect(t.page(t.page2).getAttribute('aria-expanded')).toBe('false');
    expect(t.object(t.pageId, t.line)).not.toBeNull();
    t.dispose();
  });

  it('deletes an object or a group from its item as one undoable action', () => {
    const t = setup();
    const remove = (item: HTMLElement): void => {
      fireEvent.contextMenu(t.row(item), { clientX: 40, clientY: 60 });
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    };
    fireEvent.click(t.row(t.object(t.pageId, t.dimension)!));
    expect(t.selectionTitle()).toMatch(/Dimension/);
    remove(t.object(t.pageId, t.dimension)!);
    expect(t.entity(t.dimension)).toBeUndefined();
    expect(t.object(t.pageId, t.dimension)).toBeNull();
    expect(t.selectionTitle()).not.toMatch(/Dimension/);
    act(() => { t.tab.commands.execute('edit.undo'); });
    expect(t.entity(t.dimension)).toBeDefined();
    // A group's item deletes its members together; one undo restores them.
    act(() => { t.tab.commands.execute('layout.shape.group', { pageId: t.pageId, entityIds: [t.line, t.rect] }); });
    remove(within(t.tree()).getByRole('treeitem', { name: 'Group 1' }));
    expect([t.entity(t.line), t.entity(t.rect)]).toEqual([undefined, undefined]);
    act(() => { t.tab.commands.execute('edit.undo'); });
    expect([t.entity(t.line), t.entity(t.rect)].every(Boolean)).toBe(true);
    t.dispose();
  });

  it('duplicates pages and layers, shares a layer on every page and deletes layers from the menus', () => {
    const t = setup();
    const open = (item: HTMLElement): void => { fireEvent.contextMenu(t.row(item), { clientX: 40, clientY: 60 }); };
    // Duplicate Page adds the copy after this page and makes it active.
    open(t.page(t.pageId));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate Page' }));
    const copy = t.tab.doc.state.pageOrder[1]!;
    expect(t.tab.doc.state.pages.get(copy)!.name).toBe('Page 1 Copy');
    expect(t.tab.activePageId).toBe(copy);
    // Duplicate Layer puts the copy above the original and focuses it.
    open(t.layer(copy, t.base)!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate Layer' }));
    const layerCopy = t.tab.doc.state.layerOrder[1]!;
    expect(t.tab.doc.state.layers.get(layerCopy)!.name).toBe('Layer 1 Copy');
    expect(t.children(t.page(copy))).toEqual(['Notes', 'Layer 1 Copy', 'Layer 1']);
    expect(document.activeElement).toBe(t.layer(copy, layerCopy));
    // Its objects are on other pages too, so sharing first asks which objects to share.
    open(t.layer(copy, layerCopy)!);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Show on Every Page' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(t.tab.doc.state.layers.get(layerCopy)!.shared).toBe(false);
    act(() => { t.tab.commands.execute('layout.layer.add', { name: 'Empty' }); });
    const empty = t.tab.doc.state.layerOrder.at(-1)!;
    open(t.layer(copy, empty)!);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Show on Every Page' }));
    // A layer with no objects elsewhere is shared at once.
    expect(t.tab.doc.state.layers.get(empty)!.shared).toBe(true);
    // Delete Layer removes the layer and its objects; it is unavailable for locked layers.
    open(t.layer(copy, layerCopy)!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Layer' }));
    expect(t.tab.doc.state.layers.has(layerCopy)).toBe(false);
    act(() => { t.tab.commands.execute('layout.layer.setLocked', { layerId: empty, locked: true }); });
    open(t.layer(copy, empty)!);
    expect((screen.getByRole('menuitem', { name: 'Delete Layer' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('menuitemcheckbox', { name: 'Show on Every Page' }) as HTMLButtonElement).disabled).toBe(true);
    t.dispose();
  });

  it('shows groups and nested groups as items holding their members, numbered Group N', () => {
    const t = setup();
    act(() => {
      t.tab.commands.execute('layout.shape.group', { pageId: t.pageId, entityIds: [t.line, t.rect] });
      t.tab.commands.execute('layout.shape.group', { pageId: t.pageId, entityIds: [t.line, t.rect, t.text] });
    });
    const group = (name: string): HTMLElement => within(t.tree()).getByRole('treeitem', { name });
    expect(t.children(t.layer(t.pageId, t.base)!)).toEqual(['Image 1', 'Table 1', 'Dimension 1', 'Label 1', 'Group 2']);
    expect(t.children(group('Group 2'))).toEqual(['Text 1', 'Group 1']);
    expect(t.children(group('Group 1'))).toEqual(['Shape 1', 'Line 1']);
    expect(group('Group 2').getAttribute('aria-level')).toBe('3');
    expect(group('Group 1').getAttribute('aria-level')).toBe('4');
    expect(t.object(t.pageId, t.line)!.getAttribute('aria-level')).toBe('5');
    expect(group('Group 1').getAttribute('aria-expanded')).toBe('true');
    // A group item selects exactly its members; a nested group selects only its own.
    fireEvent.click(t.row(group('Group 1')));
    expect(group('Group 1').getAttribute('aria-selected')).toBe('true');
    expect(group('Group 2').getAttribute('aria-selected')).toBe('false');
    expect(t.object(t.pageId, t.text)!.getAttribute('aria-selected')).toBe('false');
    fireEvent.click(t.row(group('Group 2')));
    expect(group('Group 2').getAttribute('aria-selected')).toBe('true');
    expect(t.selectionTitle()).toBe('3 Objects');
    // Groups have no name to edit.
    group('Group 1').focus();
    fireEvent.keyDown(group('Group 1'), { key: 'F2' });
    expect(screen.queryByRole('textbox', { name: /^Rename/ })).toBeNull();
    // Collapsing hides members; selecting a member on the canvas opens every group above it.
    fireEvent.click(t.row(group('Group 2')).querySelector('.pf-layout-browser-chevron')!);
    expect(t.object(t.pageId, t.line)).toBeNull();
    fireEvent.click(t.row(t.object(t.pageId, t.image)!));
    const canvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 4, clientX: 90, clientY: 450 });
    fireEvent.pointerUp(canvas, { pointerId: 4, clientX: 90, clientY: 450 });
    expect(group('Group 2').getAttribute('aria-expanded')).toBe('true');
    expect(t.object(t.pageId, t.line)!.getAttribute('aria-selected')).toBe('true');
    t.dispose();
  });

  it('hides, locks, drags and ungroups a group from its item', () => {
    const t = setup();
    act(() => {
      t.tab.commands.execute('layout.shape.group', { pageId: t.pageId, entityIds: [t.line, t.rect] });
      t.tab.commands.execute('layout.shape.group', { pageId: t.pageId, entityIds: [t.line, t.rect, t.text] });
    });
    const group = (name: string): HTMLElement => within(t.tree()).getByRole('treeitem', { name });
    const button = (item: HTMLElement, name: string): HTMLButtonElement => within(t.row(item)).getByRole('button', { name }) as HTMLButtonElement;
    fireEvent.click(button(group('Group 1'), 'Show Group 1'));
    expect([t.entity(t.line)?.hidden, t.entity(t.rect)?.hidden, t.entity(t.text)?.hidden]).toEqual([true, true, undefined]);
    expect(group('Group 1').classList.contains('is-hidden')).toBe(true);
    act(() => { t.tab.commands.execute('edit.undo'); });
    fireEvent.click(button(group('Group 2'), 'Lock Group 2'));
    expect([t.entity(t.line)?.locked, t.entity(t.rect)?.locked, t.entity(t.text)?.locked]).toEqual([true, true, true]);
    expect(button(group('Group 2'), 'Lock Group 2').getAttribute('aria-pressed')).toBe('true');
    act(() => { t.tab.commands.execute('edit.undo'); });
    // Dragging a group moves its members together, keeping their order: below Image is behind it.
    dragRow(t, group('Group 2'), t.object(t.pageId, t.image)!, true);
    expect(t.children(t.layer(t.pageId, t.base)!)).toEqual(['Image 1', 'Group 2', 'Table 1', 'Dimension 1', 'Label 1']);
    expect(t.children(group('Group 2'))).toEqual(['Text 1', 'Group 1']);
    // A group never lands inside itself.
    const version = t.tab.doc.version;
    dragRow(t, group('Group 2'), t.object(t.pageId, t.line)!, false);
    expect(t.tab.doc.version).toBe(version);
    // Only an outer group offers Ungroup, which removes that level.
    fireEvent.contextMenu(t.row(group('Group 1')), { clientX: 10, clientY: 10 });
    expect([...screen.getByRole('menu').querySelectorAll('[role^="menuitem"]')].map(item => item.textContent)).toEqual(['Hide', 'Lock', 'Delete']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.contextMenu(t.row(group('Group 2')), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ungroup' }));
    expect(t.children(t.layer(t.pageId, t.base)!)).toEqual(['Image 1', 'Text 1', 'Group 1', 'Table 1', 'Dimension 1', 'Label 1']);
    expect(t.entity(t.text)?.groupId).toBeUndefined();
    t.dispose();
  });

  it('reorders items inside a group by dragging or Alt+Up/Down, moving only that item and keeping it in the group', () => {
    const t = setup();
    act(() => {
      t.tab.commands.execute('layout.shape.group', { pageId: t.pageId, entityIds: [t.line, t.rect] });
      t.tab.commands.execute('layout.shape.group', { pageId: t.pageId, entityIds: [t.line, t.rect, t.text] });
    });
    const group = (name: string): HTMLElement => within(t.tree()).getByRole('treeitem', { name });
    const outside = ['Image 1', 'Table 1', 'Dimension 1', 'Label 1', 'Group 2'];
    // Even with the whole group selected, dragging a member moves only that member.
    fireEvent.click(t.row(group('Group 2')));
    expect(t.selectionTitle()).toBe('3 Objects');
    dragRow(t, t.object(t.pageId, t.text)!, group('Group 1'), true);
    expect(t.children(group('Group 2'))).toEqual(['Group 1', 'Text 1']);
    expect(t.children(t.layer(t.pageId, t.base)!)).toEqual(outside);
    expect(t.entity(t.text)?.groupId).toBe(t.entity(t.line)?.groupId);
    // A nested group moves as one among its siblings, and an item in it reorders within it.
    dragRow(t, t.object(t.pageId, t.line)!, t.object(t.pageId, t.rect)!, false);
    expect(t.children(group('Group 1'))).toEqual(['Line 1', 'Shape 1']);
    const line = t.object(t.pageId, t.line)!;
    line.focus();
    fireEvent.keyDown(line, { key: 'ArrowDown', altKey: true });
    expect(t.children(group('Group 1'))).toEqual(['Shape 1', 'Line 1']);
    fireEvent.keyDown(group('Group 1'), { key: 'ArrowDown', altKey: true });
    expect(t.children(group('Group 2'))).toEqual(['Text 1', 'Group 1']);
    // An item inside a group lands only among that group's items.
    const version = t.tab.doc.version;
    dragRow(t, t.object(t.pageId, t.text)!, t.object(t.pageId, t.image)!, false, {
      during: () => expect(t.row(t.object(t.pageId, t.image)!).className).not.toMatch(/drop-/),
    });
    dragRow(t, t.object(t.pageId, t.line)!, t.object(t.pageId, t.text)!, false);
    dragRow(t, t.object(t.pageId, t.text)!, t.layer(t.pageId, t.base)!, false);
    expect(t.tab.doc.version).toBe(version);
    t.dispose();
  });

  it('follows document changes live and browsing adds no undo entries', () => {
    const t = setup();
    const version = t.tab.doc.version, newest = t.tab.doc.undoStack.peek();
    fireEvent.click(t.row(t.page(t.page2)).querySelector('.pf-layout-browser-chevron')!);
    fireEvent.click(t.row(t.page(t.page2)).querySelector('.pf-layout-browser-chevron')!);
    fireEvent.click(t.row(t.object(t.pageId, t.rect)!));
    fireEvent.click(t.row(t.page(t.page2)));
    fireEvent.click(t.row(t.page(t.pageId)));
    expect(t.tab.doc.version).toBe(version);
    expect(t.tab.doc.undoStack.peek()).toBe(newest);
    let added = 0;
    act(() => { added = t.tab.commands.execute('layout.shape.add', { pageId: t.pageId, points: [[10, 190], [60, 190]], closed: false }) as number; });
    expect(t.children(t.layer(t.pageId, t.notes)!)).toEqual(['Line 2', 'Text 2']);
    act(() => { t.tab.commands.execute('edit.undo'); });
    expect(t.object(t.pageId, added)).toBeNull();
    act(() => { t.tab.commands.execute('layout.layer.move', { layerId: t.notes, toIndex: 0 }); });
    expect(t.children(t.page(t.pageId))).toEqual(['Layer 1', 'Notes']);
    let third = 0;
    act(() => { third = t.tab.commands.execute('layout.page.add') as number; });
    expect(t.names(1)).toEqual(['Document Settings', 'Page 1', 'Page 2', 'Page 3']);
    act(() => { t.tab.commands.execute('layout.page.move', { pageId: third, toIndex: 0 }); });
    expect(t.names(1)).toEqual(['Document Settings', 'Page 3', 'Page 1', 'Page 2']);
    act(() => { t.tab.commands.execute('layout.page.delete', { pageId: third }); });
    expect(t.names(1)).toEqual(['Document Settings', 'Page 1', 'Page 2']);
    act(() => { t.tab.commands.execute('layout.layer.delete', { layerId: t.notes }); });
    expect(t.children(t.page(t.pageId))).toEqual(['Layer 1']);
    // Deleting an earlier object renumbers later defaults of the same kind only.
    act(() => { t.tab.commands.execute('layout.shape.delete', { pageId: t.pageId, entityIds: [t.text] }); });
    expect(t.children(t.layer(t.pageId, t.base)!)).toContain('Label 1');
    t.dispose();
  });
});

describe('Object browser in the left menu bar', () => {
  let app: AppInstance, cloud: CloudSession;
  beforeEach(async () => {
    cloud = new CloudSession({
      initialize: async () => ({ error: null }),
      getSession: async () => ({ data: { session: { access_token: 'jwt', user: { id: 'user-1', email: 'artist@example.com' }, expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    } as unknown as AuthApi);
    await cloud.start();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    app = createApp({ demo: false, expose: false });
  });
  afterEach(() => { cloud.dispose(); app.dispose(); localStorage.clear(); });

  it('shows the tree in the dock from the Layout rail, one panel at a time, and Escape returns focus to the icon', () => {
    render(<App initialScreen="workspace" app={app} cloud={cloud} />);
    const rail = (): HTMLElement => screen.getByRole('navigation', { name: 'Left menu bar' });
    // The model's own Object browser starts closed; only a Layout document opens it by itself.
    expect(within(rail()).getByRole('button', { name: 'Object browser' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'New document' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Layout' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Layout' }));
    expect(within(rail()).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Files', 'AI Chat', 'Object browser']);
    const objects = within(rail()).getByRole('button', { name: 'Object browser' });
    // A new Layout document opens with the browser shown.
    expect(objects.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('tree', { name: 'Object browser' })).toBeTruthy();
    fireEvent.click(within(rail()).getByRole('button', { name: 'AI Chat' }));
    expect(objects.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('tree', { name: 'Object browser' })).toBeNull();
    expect(screen.getByRole('region', { name: 'AI Chat' }).hidden).toBe(false);
    fireEvent.click(objects);
    const tree = screen.getByRole('tree', { name: 'Object browser' });
    expect(tree.closest('.pf-side-dock')).toBeTruthy();
    expect(objects.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('region', { name: 'AI Chat' })).toBeNull();
    expect(within(tree).getAllByRole('treeitem').map(item => item.getAttribute('aria-level'))[0]).toBe('1');
    expect(within(tree).getByRole('treeitem', { name: 'Document Settings' })).toBeTruthy();
    expect(within(tree).getByRole('treeitem', { name: 'Page 1' })).toBeTruthy();
    // Escape on a tree item hides the panel and returns focus to its rail icon.
    const settings = within(tree).getByRole('treeitem', { name: 'Document Settings' });
    settings.focus();
    fireEvent.keyDown(settings, { key: 'Escape' });
    expect(screen.queryByRole('tree', { name: 'Object browser' })).toBeNull();
    expect(objects.getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(objects);
    fireEvent.click(objects);
    expect(screen.getByRole('tree', { name: 'Object browser' })).toBeTruthy();
    fireEvent.click(objects);
    expect(screen.queryByRole('tree', { name: 'Object browser' })).toBeNull();
  });
});


it('reveals a collapsed object for AI guidance without selecting it or adding undo history', async () => {
  const h = setup(true);
  const version = h.tab.doc.version;
  const guide = guidanceFor(h.session, h.tab, () => {});
  const abort = new AbortController();
  let pending: ReturnType<typeof guide>;
  try {
    expect(h.object(h.pageId, h.rect)).toBeNull();
    await act(async () => { pending = guide('ui_highlight', { targets: [`object:object:${h.pageId}:${h.rect}`] }, abort.signal); });
    await waitFor(() => expect(h.object(h.pageId, h.rect)?.classList.contains('pf-ai-guidance')).toBe(true));
    expect(h.tab.doc.version).toBe(version);
    expect(h.object(h.pageId, h.rect)?.getAttribute('aria-selected')).toBe('false');
    await act(async () => { abort.abort(); await pending; });
  } finally { abort.abort(); h.dispose(); }
});
