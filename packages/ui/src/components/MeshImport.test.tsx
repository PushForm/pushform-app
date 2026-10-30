// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { meshBox } from '@pushform/core';
import { OBJ_FORMAT, readSketchUpInWorker, type SketchUpImport } from '@pushform/io';
import type * as IoModule from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { TopBar } from './TopBar';

vi.mock('@pushform/io', async original => ({ ...await original<typeof IoModule>(), readSketchUpInWorker: vi.fn() }));
const readModel = vi.mocked(readSketchUpInWorker);
const scene = (): SketchUpImport => ({ version: 'OBJ', format: OBJ_FORMAT, root: { key: -1, guid: '', name: '', image: false, group: false, alwaysFaceCamera: false,
  shadowsFaceSun: false, solids: [{ mesh: meshBox([0, 0, 0], [1, 1, 1]), faces: [] }], sheets: [], edges: [], curves: [], sectionPlanes: [], guides: [],
  dimensions: [], texts: [], instances: [] }, definitions: new Map(), materials: new Map(), images: [], tags: [], scenes: [], units: null, warnings: [] });
// A box 2 units wide, 1 deep and 3 high when Y is up.
const OBJ = new TextEncoder().encode('# box\nv 0 0 0\nv 2 3 1\nf 1 2 1\n');
let session: DocumentSession;
afterEach(() => { cleanup(); session?.dispose(); vi.restoreAllMocks(); readModel.mockReset(); localStorage.clear(); });

function pick(name: string, bytes: Uint8Array<ArrayBuffer> = OBJ): void {
  const file = new File([bytes], name);
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer });
  fireEvent.change(screen.getByLabelText('Open PushForm file'), { target: { files: [file] } });
}

describe('OBJ and 3DS import options', () => {
  it('asks for units and up axis with a size preview, imports with the choice, and remembers it', async () => {
    readModel.mockResolvedValue(scene());
    session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
    render(<div className="pf-app"><TopBar session={session} /></div>);
    pick('Box.obj');
    const dialog = await screen.findByRole('dialog', { name: 'Import OBJ' });
    expect((screen.getByLabelText('Units') as HTMLSelectElement).value).toBe('m');
    expect((screen.getByLabelText('Y up') as HTMLInputElement).checked).toBe(true);
    const size = (): string => screen.getByRole('status').textContent!;
    expect(size()).toMatch(/^Size: .* wide × .* deep × .* high$/);
    const inMeters = size();
    fireEvent.change(screen.getByLabelText('Units'), { target: { value: 'cm' } });
    expect(size()).not.toBe(inMeters);
    fireEvent.click(screen.getByLabelText('Z up'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('dialog', { name: 'OBJ import report' })).toBeTruthy();
    expect(dialog.isConnected).toBe(false);
    expect(readModel).toHaveBeenCalledWith(expect.any(Uint8Array), expect.objectContaining({ mesh: { unit: 'cm', up: 'z' } }));
    expect(session.active.name).toBe('Box.pf');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // The next OBJ starts from the last choice; cancelling imports nothing.
    pick('Second.obj');
    await screen.findByRole('dialog', { name: 'Import OBJ' });
    expect((screen.getByLabelText('Units') as HTMLSelectElement).value).toBe('cm');
    expect((screen.getByLabelText('Z up') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(readModel).toHaveBeenCalledOnce();
  });

  it('asks a DXF without units for its units only, and imports one with units without asking', async () => {
    readModel.mockResolvedValue(scene());
    session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
    render(<div className="pf-app"><TopBar session={session} /></div>);
    const drawing = (header: string[]): Uint8Array<ArrayBuffer> => new TextEncoder().encode(
      ['0', 'SECTION', '2', 'HEADER', ...header, '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF', ''].join('\n'));
    pick('Plan.dxf', drawing(['9', '$EXTMIN', '10', '0', '20', '0', '30', '0', '9', '$EXTMAX', '10', '2000', '20', '1000', '30', '0']));
    await screen.findByRole('dialog', { name: 'Import DXF' });
    expect((screen.getByLabelText('Units') as HTMLSelectElement).value).toBe('mm');
    expect(screen.queryByLabelText('Y up')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('dialog', { name: 'OBJ import report' });
    expect(readModel).toHaveBeenLastCalledWith(expect.any(Uint8Array), expect.objectContaining({ mesh: { unit: 'mm', up: 'z' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    pick('Site.dxf', drawing(['9', '$INSUNITS', '70', '6']));
    await screen.findByRole('dialog', { name: 'OBJ import report' });
    expect(readModel).toHaveBeenLastCalledWith(expect.any(Uint8Array), expect.objectContaining({ mesh: undefined }));
  });

  it('asks an STL for units and up axis, starting from millimeters and Z up', async () => {
    readModel.mockResolvedValue(scene());
    session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
    render(<div className="pf-app"><TopBar session={session} /></div>);
    const stl = new TextEncoder().encode('solid part\n  facet normal 0 0 1\n    outer loop\n      vertex 0 0 0\n      vertex 20 0 0\n' +
      '      vertex 0 10 5\n    endloop\n  endfacet\nendsolid part\n');
    pick('Part.stl', stl);
    await screen.findByRole('dialog', { name: 'Import STL' });
    expect(screen.getByText('Part.stl does not record its units or which axis is up.')).toBeTruthy();
    expect((screen.getByLabelText('Units') as HTMLSelectElement).value).toBe('mm');
    expect((screen.getByLabelText('Z up') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText('Y up'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('dialog', { name: 'OBJ import report' });
    expect(readModel).toHaveBeenLastCalledWith(expect.any(Uint8Array), expect.objectContaining({ mesh: { unit: 'mm', up: 'y' } }));
  });
});
