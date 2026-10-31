// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './App';
import { CloudSession, type AuthApi } from '@pushform/cloud';
import { createApp, type AppInstance } from './bootstrap';
import { openLayoutFile, openModelFile, encodeModelDocument, importSketchUpLayout } from '@pushform/io';

vi.mock('./components/ViewportView', () => ({
  ViewportView: () => <div aria-label="3D viewport" />,
}));

let app: AppInstance | null = null;
let signedInCloud: CloudSession;
beforeEach(async () => {
  signedInCloud = new CloudSession({
    initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session: { user: { id: 'user-1', email: 'artist@example.com' },
      expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  } as unknown as AuthApi);
  await signedInCloud.start();
});
afterEach(() => {
  cleanup();
  signedInCloud.dispose();
  app?.dispose();
  app = null;
  vi.unstubAllGlobals();
});

function createLayoutFromChooser(): void {
  fireEvent.click(screen.getByRole('button', { name: 'New document' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Layout' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create Layout' }));
}

/** The object browser's tree, opened from the left menu bar if needed; pages are managed there. */
function objectBrowser(): HTMLElement {
  if (!screen.queryByRole('tree', { name: 'Object browser' })) fireEvent.click(screen.getByRole('button', { name: 'Object browser' }));
  return screen.getByRole('tree', { name: 'Object browser' });
}

/** Chooses an action from a page item's context menu in the object browser. */
function pageMenu(page: string, action: string): void {
  const item = within(objectBrowser()).getByRole('treeitem', { name: page });
  fireEvent.contextMenu(item.querySelector('.pf-layout-browser-row')!, { clientX: 10, clientY: 10 });
  fireEvent.click(screen.getByRole('menuitem', { name: action }));
}

/** Page names listed in the object browser, in order. */
function browserPages(): string[] {
  return within(objectBrowser()).getAllByRole('treeitem').filter(item => item.getAttribute('aria-level') === '1')
    .map(item => item.querySelector(':scope > .pf-layout-browser-row .pf-layout-browser-name')?.textContent ?? '').slice(1);
}

describe('document tabs', () => {
  it('offers Model and Layout from a single + menu that closes on Escape, outside click, or a choice', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    app = createApp({ demo: false, expose: false }); render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
    expect(screen.queryByRole('button', { name: '+ Model' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Layout' })).toBeNull();
    const plus = screen.getByRole('button', { name: 'New document' });
    expect(plus.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(plus);
    expect(plus.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('menuitem', { name: /^(Model|Layout)$/ }).map(item => item.textContent)).toEqual(['Model', 'Layout']);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'New document' })).toBeNull();
    fireEvent.click(plus);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu', { name: 'New document' })).toBeNull();
    fireEvent.click(plus);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Model' }));
    expect(screen.queryByRole('menu', { name: 'New document' })).toBeNull();
    expect(screen.getByRole('button', { name: '3D model: Untitled 2' }).getAttribute('aria-current')).toBe('page');
    vi.restoreAllMocks();
  });

  it('opens a template chooser from the tab button and menu, cancels without a new tab, and creates the chosen paper', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    app = createApp({ demo: false, expose: false }); render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
    fireEvent.click(screen.getByRole('button', { name: 'New document' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Layout' }));
    expect(screen.getByRole('dialog', { name: 'Choose a Template' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '2D drawing: Untitled 2' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Graph Paper: A4 Landscape' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.getByLabelText('3D viewport')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Layout' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Plain Paper: A4 Portrait' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Layout' }));
    fireEvent.click(within(objectBrowser()).getByRole('treeitem', { name: 'Document Settings' }).querySelector('.pf-layout-browser-row')!);
    const settings = screen.getByRole('dialog', { name: 'Document Settings' });
    expect((within(settings).getByLabelText('Page width (mm)') as HTMLInputElement).value).toBe('210');
    expect((within(settings).getByLabelText('Page height (mm)') as HTMLInputElement).value).toBe('297');
    expect((within(settings).getByRole('checkbox', { name: 'Show grid' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(settings).getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: '2D drawing: Untitled 2' }).textContent).not.toContain('•');
    vi.restoreAllMocks();
  });

  it('switches between Modeling and Layout and adds a page', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    app = createApp({ demo: false, expose: false });
    render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
    expect(screen.getByLabelText('3D viewport')).toBeTruthy();
    const modelToolbar = screen.getByRole('navigation', { name: 'Tools' });
    expect(modelToolbar.getAttribute('data-orientation')).toBe('horizontal');
    expect(screen.getByRole('banner').nextElementSibling).toBe(modelToolbar);
    expect(modelToolbar.nextElementSibling?.contains(screen.getByLabelText('3D viewport'))).toBe(true);
    // The left menu bar opens the band below the tool row, opposite the right-hand panel strip.
    expect(screen.getByLabelText('3D viewport').parentElement?.firstElementChild).toBe(screen.getByRole('navigation', { name: 'Left menu bar' }));
    expect(screen.getByLabelText('3D viewport').parentElement?.lastElementChild).toBe(screen.getByRole('navigation', { name: 'Panels' }));
    expect(
      within(screen.getByRole('banner')).getByRole('navigation', { name: 'Open documents' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Redo' })).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();

    createLayoutFromChooser();
    expect(screen.getByLabelText('Layout workspace')).toBeTruthy();
    const layoutToolbar = screen.getByRole('navigation', { name: 'Layout tools' });
    expect(layoutToolbar.getAttribute('data-orientation')).toBe('horizontal');
    expect(screen.getByRole('banner').nextElementSibling).toBe(layoutToolbar);
    expect(layoutToolbar.nextElementSibling?.contains(screen.getByLabelText('Layout workspace'))).toBe(true);
    expect(layoutToolbar.nextElementSibling?.firstElementChild).toBe(screen.getByRole('navigation', { name: 'Left menu bar' }));
    expect(layoutToolbar.nextElementSibling?.contains(screen.getByRole('complementary', { name: 'Layout settings' }))).toBe(true);
    expect(screen.getAllByText('Untitled 2')).toHaveLength(1);
    expect(browserPages()).toEqual(['Page 1']);
    pageMenu('Page 1', 'Add Page After');
    expect(browserPages()).toEqual(['Page 1', 'Page 2']);

    expect(screen.getByRole('button', { name: '2D drawing: Untitled 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '3D model: Untitled' }));
    expect(screen.getByLabelText('3D viewport')).toBeTruthy();
    vi.restoreAllMocks();
  });

  it('has no Layers or Pages pane and manages pages from the object browser', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    app = createApp({ demo: false, expose: false });
    render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
    createLayoutFromChooser();
    const settings = screen.getByRole('complementary', { name: 'Layout settings' });
    expect(within(settings).queryByRole('button', { name: 'Pages' })).toBeNull();
    expect(within(settings).queryByRole('button', { name: 'Layers' })).toBeNull();
    expect(within(settings).queryByRole('navigation', { name: 'Pages' })).toBeNull();
    pageMenu('Page 1', 'Add Page After');
    pageMenu('Page 2', 'Duplicate Page');
    expect(browserPages()).toEqual(['Page 1', 'Page 2', 'Page 2 Copy']);
    pageMenu('Page 2', 'Delete Page');
    expect(browserPages()).toEqual(['Page 1', 'Page 2 Copy']);
    vi.restoreAllMocks();
  });

  it('draws a Layout line through the page canvas and marks the tab dirty', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 891,
      height: 630,
      right: 891,
      bottom: 630,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    app = createApp({ demo: false, expose: false });
    render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
    createLayoutFromChooser();
    fireEvent.click(screen.getByRole('button', { name: 'Line' }));
    const canvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 330, clientY: 30 });
    fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: 330, clientY: 30 });
    expect(screen.getByRole('button', { name: '2D drawing: Untitled 2' }).textContent).toContain(
      '•',
    );
    vi.restoreAllMocks();
  });

  it('keeps each Layout tab tool selection when switching tabs', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    app = createApp({ demo: false, expose: false });
    render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
    createLayoutFromChooser();
    fireEvent.click(screen.getByRole('button', { name: 'Line' }));
    createLayoutFromChooser();
    fireEvent.click(screen.getByRole('button', { name: 'Rectangle' }));
    fireEvent.click(screen.getByRole('button', { name: '2D drawing: Untitled 2' }));
    expect(screen.getByRole('button', { name: 'Line' }).className).toContain('is-active');
    fireEvent.click(screen.getByRole('button', { name: '2D drawing: Untitled 3' }));
    expect(screen.getByRole('button', { name: 'Rectangle' }).className).toContain('is-active');
    vi.restoreAllMocks();
  });

  it('clears the clicked Layout tool focus when a shortcut selects another tool', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    app = createApp({ demo: false, expose: false });
    render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
    createLayoutFromChooser();
    const line = screen.getByRole('button', { name: 'Line' });
    fireEvent.click(line);
    line.focus();
    expect(document.activeElement).toBe(line);
    fireEvent.keyDown(line, { code: 'KeyR', key: 'r' });
    expect(line.className).not.toContain('is-active');
    expect(document.activeElement).not.toBe(line);
    expect(screen.getByRole('button', { name: 'Rectangle' }).className).toContain('is-active');
    vi.restoreAllMocks();
  });

  it('cancels a held Layout drag when switching tabs', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 891, height: 630, right: 891, bottom: 630,
      x: 0, y: 0, toJSON: () => ({}),
    });
    app = createApp({ demo: false, expose: false });
    render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
    createLayoutFromChooser();
    fireEvent.click(screen.getByRole('button', { name: 'Line' }));
    const canvas = screen.getByLabelText('Page 1 canvas');
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 30, clientY: 30 });
    fireEvent.click(screen.getByRole('button', { name: '3D model: Untitled' }));
    fireEvent.click(screen.getByRole('button', { name: '2D drawing: Untitled 2' }));
    fireEvent.pointerUp(screen.getByLabelText('Page 1 canvas'), {
      button: 0, pointerId: 1, clientX: 330, clientY: 30,
    });
    expect(screen.getByRole('button', { name: '2D drawing: Untitled 2' }).textContent).not.toContain('•');
    vi.restoreAllMocks();
  });

  it('offers preset zoom and fitting actions without changing the document', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    app = createApp({ demo: false, expose: false });
    render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
    createLayoutFromChooser();
    fireEvent.click(screen.getByRole('button', { name: 'Layout zoom' }));
    expect(screen.getByRole('menuitem', { name: 'Fit Content' })).toBeTruthy();
    expect((screen.getByRole('menuitem', { name: 'Zoom Selection' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: '400%' }));
    expect(screen.getByLabelText('Page 1 canvas').parentElement?.style.width).toBe('3564px');
    expect(screen.getByRole('button', { name: 'Layout zoom' }).textContent).toContain('400%');
    expect(screen.getByRole('button', { name: '2D drawing: Untitled 2' }).textContent).not.toContain('•');
    vi.restoreAllMocks();
  });

  it('saves the active Modeling tab as a .pf file', async () => {
    let written: Uint8Array | null = null;
    vi.stubGlobal('showSaveFilePicker', vi.fn().mockResolvedValue({
      name: 'Building.pf',
      createWritable: async () => ({
        write: async (data: Uint8Array) => { written = data; },
        close: async () => {},
      }),
    }));
    app = createApp({ demo: false, expose: false });
    render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
    act(() => {
      app!.document.edit('Rename root', (draft) => {
        draft.definitions.get(draft.rootDefinitionId)!.name = 'Building';
      });
    });
    expect(screen.getByRole('button', { name: '3D model: Untitled' }).textContent).toContain('•');
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Save$/ }));
    await waitFor(() => expect(written).not.toBeNull());
    expect((await openModelFile(written!)).state.definitions.size).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '3D model: Building' }).textContent).not.toContain('•');
  });

  it('exports the active Layout tab as a SketchUp .layout copy without changing the tab', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    let written: Uint8Array | null = null;
    const savePicker = vi.fn().mockResolvedValue({
      name: 'Untitled 2.layout',
      createWritable: async () => ({ write: async (data: Uint8Array) => { written = data; }, close: async () => {} }),
    });
    vi.stubGlobal('showSaveFilePicker', savePicker);
    app = createApp({ demo: false, expose: false });
    render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    expect(screen.queryByRole('menuitem', { name: /Export SketchUp LayOut/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    createLayoutFromChooser();
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'layout' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(written).not.toBeNull());
    expect(savePicker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'Untitled 2.layout',
      types: [{ description: 'SketchUp LayOut', accept: { 'application/octet-stream': ['.layout'] } }] }));
    expect(importSketchUpLayout(written!, 'Untitled 2.layout').doc.state.pageOrder).toHaveLength(1);
    const tab = screen.getByRole('button', { name: '2D drawing: Untitled 2' });
    expect(tab.textContent).not.toContain('•');
    vi.restoreAllMocks();
  });

  it('activates an open Modeling tab when the same browser file is picked again', async () => {
    app = createApp({ demo: false, expose: false });
    const bytes = encodeModelDocument(app.document.doc);
    const handle = {
      name: 'Building.pf',
      getFile: async () => ({
        name: 'Building.pf',
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      }),
      isSameEntry: async (other: unknown) => other === handle,
    };
    vi.stubGlobal('showOpenFilePicker', vi.fn().mockResolvedValue([handle]));
    render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
    const open = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Open…' }));
    };
    open();
    await waitFor(() => expect(screen.getAllByRole('button', { name: '3D model: Building' })).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '3D model: Untitled' }));
    open();
    await waitFor(() => expect(screen.getByRole('button', { name: '3D model: Building' }).getAttribute('aria-current')).toBe('page'));
    expect(screen.getAllByRole('button', { name: '3D model: Building' })).toHaveLength(1);
  });

  it('keeps a dirty Modeling tab open when saving it fails', async () => {
    vi.stubGlobal('showSaveFilePicker', vi.fn().mockResolvedValue({
      name: 'Broken.pf',
      createWritable: async () => ({
        write: async () => { throw new Error('Disk full'); },
        close: async () => {},
      }),
    }));
    app = createApp({ demo: false, expose: false });
    render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
    fireEvent.click(screen.getByRole('button', { name: 'New document' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Model' }));
    fireEvent.click(screen.getByRole('button', { name: '3D model: Untitled' }));
    act(() => {
      app!.document.edit('Rename root', (draft) => {
        draft.definitions.get(draft.rootDefinitionId)!.name = 'Changed';
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close Untitled' }));
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Disk full'));
    expect(screen.getByRole('button', { name: '3D model: Untitled' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '3D model: Untitled 2' })).toBeTruthy();
  });
});

// Minimal ZIP-based SketchUp LayOut document: document.xml, references.xml, pages/page1.xml.
it('opens .layout without restrictive picker filters and saves a new native .pfl file', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const bytes = Uint8Array.from(atob('UEsDBBQAAAAIACeEVV30vBYElAAAAMwAAAAMAAAAZG9jdW1lbnQueG1sVY5LCoMwFEW3Et4CfHVQKGIcdeKgk+4gxGsiNR+SJ213X4sjJxcOnAO3X803bXJPdguIoj5hjbUrmrxI7pjrC2L9lhuXklvR2BS4Wo9gKh8pt82FC2YURItKQ5+NwxjnpN7LJF5T25LyWJwXTbfmSnwoDxP3LQc8MavSLZOmvNvRBGgaQ05FMKnqAflnfOr4/H34AVBLAwQUAAAACAAnhFVdvlb8MHcAAACbAAAADgAAAHJlZmVyZW5jZXMueG1sTY1LDgIhEAWvQjgALdsJw9IDGC9AsAUiv3T3JHp7cWF08xaVlypHeEfCHpHVs9XOG+06i8wNgB8oMR/TpDFSRRNHA44ZW2Co4TUOAWtO8DNo72ZIeC4VL1+oaCu3XU+rVemC1EO9Bkooi60vw2etWW0N3v3J/BtQSwMEFAAAAAgAJ4RVXdOgT2YJAAAABwAAAA8AAABwYWdlcy9wYWdlMS54bWyzKUhMT9W3AwBQSwECFAMUAAAACAAnhFVd9LwWBJQAAADMAAAADAAAAAAAAAAAAAAAgAEAAAAAZG9jdW1lbnQueG1sUEsBAhQDFAAAAAgAJ4RVXb5W/DB3AAAAmwAAAA4AAAAAAAAAAAAAAIABvgAAAHJlZmVyZW5jZXMueG1sUEsBAhQDFAAAAAgAJ4RVXdOgT2YJAAAABwAAAA8AAAAAAAAAAAAAAIABYQEAAHBhZ2VzL3BhZ2UxLnhtbFBLBQYAAAAAAwADALMAAACXAQAAAAA='), value => value.charCodeAt(0));
  const overwriteSource = vi.fn();
  const source = { name: 'Existing.layout', getFile: async () => ({ name: 'Existing.layout', arrayBuffer: async () => bytes.buffer }), createWritable: overwriteSource };
  const openPicker = vi.fn().mockResolvedValue([source]);
  vi.stubGlobal('showOpenFilePicker', openPicker);
  let written: Uint8Array | null = null;
  const savePicker = vi.fn().mockResolvedValue({ name: 'Existing.pfl', createWritable: async () => ({
    write: async (value: Uint8Array) => { written = value; }, close: async () => {},
  }) });
  vi.stubGlobal('showSaveFilePicker', savePicker);
  app = createApp({ demo: false, expose: false }); render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
  fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open…' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '2D drawing: Existing' })).toBeTruthy());
  expect(openPicker).toHaveBeenCalledWith({ multiple: false, excludeAcceptAllOption: false });
  expect(screen.getByLabelText('Open PushForm file').hasAttribute('accept')).toBe(false);
  expect(screen.getByLabelText('Imported sheet canvas')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /^Save$/ }));
  await waitFor(() => expect(written).not.toBeNull());
  expect(savePicker.mock.calls[0]![0].types).toEqual([{ description: 'PushForm Layout', accept: { 'application/octet-stream': ['.pfl'] } }]);
  expect((await openLayoutFile(written!)).state.pages.values().next().value?.name).toBe('Imported sheet');
  expect(overwriteSource).not.toHaveBeenCalled();
});

it('validates unsupported files after selection in the unrestricted Open picker', async () => {
  vi.stubGlobal('showOpenFilePicker', vi.fn().mockResolvedValue([{ name: 'Notes.txt' }]));
  app = createApp({ demo: false, expose: false }); render(<App initialScreen="workspace" app={app} cloud={signedInCloud} />);
  fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open…' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Choose a .pf, .pfl, .layout, .skp, .skb, .dae, .obj, .3ds, .stl, .dxf, .gltf, .glb, .step, .stp, .zip, or .kmz file'));
  expect(screen.getByLabelText('3D viewport')).toBeTruthy();
});

it('locks both workspaces on sign-out and preserves tabs, edits, and undo after reauthentication', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const signOut = vi.fn().mockResolvedValue({ error: null });
  let resume!: () => void;
  const cloud = new CloudSession({
    initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session: { user: { id: 'user-1', email: 'artist@example.com' },
      expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }),
    onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
      resume = () => callback('SIGNED_IN', { user: { id: 'user-1', email: 'artist@example.com' },
        expires_at: Math.floor(Date.now() / 1000) + 3600 });
      return { data: { subscription: { unsubscribe: () => {} } } };
    }, signOut,
  } as unknown as AuthApi);
  try {
    app = createApp({ demo: false, expose: false }); render(<App initialScreen="workspace" app={app} cloud={cloud} />);
    await screen.findByRole('button', { name: 'Account: artist@example.com' });
    createLayoutFromChooser(); pageMenu('Page 1', 'Add Page After');
    expect(screen.getByRole('treeitem', { name: 'Page 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Account: artist@example.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in to PushForm' });
    expect(screen.queryByLabelText('Layout workspace')).toBeNull();
    expect(screen.queryByRole('treeitem', { name: 'Page 2' })).toBeNull();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    act(() => resume());
    expect(screen.getByRole('treeitem', { name: 'Page 2' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(screen.queryByRole('treeitem', { name: 'Page 2' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '3D model: Untitled' }));
    expect(screen.getByLabelText('3D viewport')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Account: artist@example.com' })).toBeTruthy();
  } finally { cleanup(); cloud.dispose(); vi.restoreAllMocks(); }
});
