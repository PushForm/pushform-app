// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { meshBox } from '@pushform/core';
import { bodyFromMesh } from '@pushform/model';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { TopBar } from './TopBar';

let session: DocumentSession;
afterEach(() => { cleanup(); session?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('STL export UI', () => {
  it('exports the model as STL from the Main menu with the chosen unit and format, and offers the command', async () => {
    session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
    const tab = session.active;
    if (tab.type !== 'model') throw new Error('Expected model');
    tab.app.document.edit('box', d => { bodyFromMesh(d, meshBox([0, 0, 0], [1, 1, 1]), { container: d.definitions.get(d.rootDefinitionId)!.entities }); });
    const write = vi.fn(), close = vi.fn();
    const savePicker = vi.fn(async () => ({ name: 'Model.stl', createWritable: async () => ({ write, close }) }));
    vi.stubGlobal('showSaveFilePicker', savePicker);
    render(<div className="pf-app"><TopBar session={session} /></div>);

    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
    const dialog = screen.getByRole('dialog', { name: 'Export' });
    expect((screen.getByLabelText('Units') as HTMLSelectElement).value).toBe('mm');
    expect((screen.getByLabelText('Export selected geometry only') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Units'), { target: { value: 'in' } });
    fireEvent.click(screen.getByLabelText('ASCII'));
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(dialog.isConnected).toBe(false);
    expect(savePicker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: tab.name.replace(/\.pf$/i, '') + '.stl' }));
    const text = new TextDecoder().decode(write.mock.calls[0]![0] as Uint8Array);
    expect(text.startsWith('solid ')).toBe(true);
    expect(text.match(/endfacet/g)).toHaveLength(12);
    // One meter is 39.37 inches.
    expect(text).toContain('3.93700787e+1');

    // Command search offers the export, and the dialog remembers the last unit and format.
    const search = screen.getByRole('combobox', { name: 'Search tools and commands' });
    fireEvent.focus(search); fireEvent.change(search, { target: { value: 'Export STL' } });
    fireEvent.click(screen.getByRole('option', { name: /Export STL/ }));
    expect((screen.getByLabelText('Units') as HTMLSelectElement).value).toBe('in');
    expect((screen.getByLabelText('ASCII') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Export' })).toBeNull();
  });

  it('reports an empty model instead of writing a file', async () => {
    session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
    const savePicker = vi.fn();
    vi.stubGlobal('showSaveFilePicker', savePicker);
    render(<div className="pf-app"><TopBar session={session} /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The model has no visible faces to export.');
    expect(savePicker).not.toHaveBeenCalled();
  });
});
