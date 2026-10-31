// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { modelContentIdentity } from '../../../io/src/native/modelIdentity';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { meshBox } from '@pushform/core';
import { bodyFromMesh } from '@pushform/model';
import { openModelFile } from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { TopBar } from './TopBar';

let session: DocumentSession;
afterEach(() => { cleanup(); session?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
  const tab = session.active;
  if (tab.type !== 'model') throw new Error('Expected model');
  tab.app.document.edit('box', d => { bodyFromMesh(d, meshBox([0, 0, 0], [1, 1, 1]), { container: d.definitions.get(d.rootDefinitionId)!.entities }); });
  const write = vi.fn(), close = vi.fn();
  const savePicker = vi.fn(async () => ({ name: 'Model', createWritable: async () => ({ write, close }) }));
  vi.stubGlobal('showSaveFilePicker', savePicker);
  render(<div className="pf-app"><TopBar session={session} /></div>);
  const base = tab.name.replace(/\.pf$/i, '');
  return { write, close, savePicker, base };
}

describe('glTF, OBJ and COLLADA export UI', () => {
  it('exports glTF and COLLADA from the Main menu', async () => {
    const { write, close, savePicker, base } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'gltf' } });
    expect(screen.queryByLabelText('Units')).toBeNull();
    expect((screen.getByLabelText('Export selected geometry only') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(savePicker).toHaveBeenLastCalledWith(expect.objectContaining({ suggestedName: `${base}.glb` }));
    expect(strFromU8((write.mock.calls[0]![0] as Uint8Array).subarray(0, 4))).toBe('glTF');

    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'collada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    expect(savePicker).toHaveBeenLastCalledWith(expect.objectContaining({ suggestedName: `${base}.dae` }));
    expect(strFromU8(write.mock.calls[1]![0] as Uint8Array)).toContain('<COLLADA');
  });

  it('exports STEP from the Main menu, asking for the file first and keeping the dialog until it is written', async () => {
    const { write, close, savePicker, base } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'step' } });
    expect(screen.queryByLabelText('Units')).toBeNull();
    screen.getByText(/STEP files are written in millimeters/);
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(savePicker).toHaveBeenLastCalledWith(expect.objectContaining({ suggestedName: `${base}.step` }));
    const text = strFromU8(write.mock.calls[0]![0] as Uint8Array);
    expect(text).toMatch(/^ISO-10303-21;/);
    expect(text).toContain('MANIFOLD_SOLID_BREP');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Export' })).toBeNull());
  });

  it('exports OBJ in the chosen unit and up axis from command search, remembering them', async () => {
    const { write, close, base } = setup();
    const search = screen.getByRole('combobox', { name: 'Search tools and commands' });
    fireEvent.focus(search); fireEvent.change(search, { target: { value: 'Export OBJ' } });
    fireEvent.click(screen.getByRole('option', { name: /Export OBJ/ }));
    screen.getByRole('dialog', { name: 'Export' });
    expect((screen.getByLabelText('Y up') as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Units'), { target: { value: 'mm' } });
    fireEvent.click(screen.getByLabelText('Z up'));
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    const files = unzipSync(write.mock.calls[0]![0] as Uint8Array);
    expect(Object.keys(files).sort()).toEqual([`${base}.mtl`, `${base}.obj`]);
    // The cube's far corner, 1 m, is at 1000 mm with Z up.
    expect(strFromU8(files[`${base}.obj`]!)).toContain('v 1000 1000 1000');
    fireEvent.focus(search); fireEvent.change(search, { target: { value: 'Export OBJ' } });
    fireEvent.click(screen.getByRole('option', { name: /Export OBJ/ }));
    expect((screen.getByLabelText('Units') as HTMLSelectElement).value).toBe('mm');
    expect((screen.getByLabelText('Z up') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Export' })).toBeNull();
  });
});

it('offers one Export menu item and switches formats inside the same dialog, retaining their choices', () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
  expect(screen.getAllByRole('menuitem').filter(item => item.textContent?.startsWith('Export'))).toHaveLength(1);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
  const dialog = screen.getByRole('dialog', { name: 'Export' });
  expect([...screen.getByLabelText<HTMLSelectElement>('Format').options].map(option => option.value)).toEqual(['pf', 'stl', 'gltf', 'obj', 'collada', 'step', 'png', 'jpeg']);
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'obj' } });
  fireEvent.change(screen.getByLabelText('Units'), { target: { value: 'cm' } });
  fireEvent.click(screen.getByLabelText('Z up'));
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'png' } });
  expect(screen.queryByLabelText('Units')).toBeNull();
  expect(screen.queryByLabelText('Export selected geometry only')).toBeNull();
  fireEvent.click(screen.getByLabelText('Use view size'));
  fireEvent.change(screen.getByLabelText('Width'), { target: { value: '1234' } });
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'obj' } });
  expect(screen.getByLabelText<HTMLSelectElement>('Units').value).toBe('cm');
  expect(screen.getByLabelText<HTMLInputElement>('Z up').checked).toBe(true);
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'png' } });
  expect(screen.getByLabelText<HTMLInputElement>('Width').value).toBe('1234');
  expect(screen.getByRole('dialog', { name: 'Export' })).toBe(dialog);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('exports a complete native model without changing its saved identity, and allows cancel and retry', async () => {
  const { write, savePicker, base } = setup();
  const tab = session.active;
  if (tab.type !== 'model') throw new Error('Expected model');
  tab.identity = 'cloud:test-account:test-project:test-file';
  const before = { name: tab.name, identity: tab.identity, savedContent: tab.savedContent };
  const state = tab.app.document.doc.state, version = tab.app.document.doc.version;
  fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
  fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'pf' } });
  expect(screen.queryByLabelText('Export selected geometry only')).toBeNull();
  expect(screen.queryByLabelText('Units')).toBeNull();
  savePicker.mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError'));
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Export…' }).disabled).toBe(false));
  expect(write).not.toHaveBeenCalled();
  write.mockRejectedValueOnce(new Error('Disk full'));
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Disk full');
  fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Export' })).toBeNull());
  expect(savePicker).toHaveBeenLastCalledWith({ suggestedName: `${base}.pf`, types: [{ description: 'PushForm Model', accept: { 'application/octet-stream': ['.pf'] } }] });
  expect(modelContentIdentity((await openModelFile(write.mock.calls[1]![0] as Uint8Array)).state)).toBe(modelContentIdentity(state));
  expect(tab).toMatchObject(before);
  expect(tab.app.document.doc.version).toBe(version);
  expect(session.isDirty(tab)).toBe(true);
});
