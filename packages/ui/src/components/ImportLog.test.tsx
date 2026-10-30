// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { meshBox } from '@pushform/core';
import type { CloudFilesApi, CloudImportReport } from '@pushform/cloud';
import { importSketchUpLayoutInWorker, readSketchUpInWorker, type SketchUpImport } from '@pushform/io';
import type * as IoModule from '@pushform/io';
import { createLayoutDocument } from '@pushform/layout';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { TopBar } from './TopBar';

vi.mock('@pushform/io', async original => ({ ...await original<typeof IoModule>(), readSketchUpInWorker: vi.fn(), importSketchUpLayoutInWorker: vi.fn() }));
const readModel = vi.mocked(readSketchUpInWorker), readLayout = vi.mocked(importSketchUpLayoutInWorker);
const build = { version: '0.1.0', commit: 'abc1234', date: '2026-10-22T00:00:00Z' };
function scene(): SketchUpImport {
  return { version: '{26.2.242}', root: { key: -1, guid: 'ROOT', name: 'Model', image: false, group: false, alwaysFaceCamera: false, shadowsFaceSun: false,
    solids: [{ mesh: meshBox([0, 0, 0], [1, 2, 3]), faces: [] }], sheets: [], edges: [], curves: [], sectionPlanes: [], guides: [], dimensions: [], texts: [], instances: [] },
    definitions: new Map(), materials: new Map(), images: [], tags: [], scenes: [], units: null, warnings: ['Textures are not imported.'] };
}
let session: DocumentSession;
function setup(): { recordImport: ReturnType<typeof vi.fn> } {
  session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
  const recordImport = vi.fn().mockResolvedValue({ id: 'report' });
  render(<div className="pf-app"><TopBar session={session} cloudFiles={{ recordImport } as unknown as CloudFilesApi} buildInfo={build} /></div>);
  return { recordImport };
}
function file(name: string): File {
  const f = new File([new Uint8Array([1, 2, 3, 4])], name, { lastModified: Date.UTC(2026, 9, 20, 12) });
  Object.defineProperty(f, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3, 4]).buffer });
  return f;
}
function open(name: string): void { fireEvent.change(screen.getByLabelText('Open PushForm file'), { target: { files: [file(name)] } }); }
async function logged(recordImport: ReturnType<typeof vi.fn>): Promise<CloudImportReport> {
  await waitFor(() => expect(recordImport).toHaveBeenCalledOnce());
  return recordImport.mock.calls[0]![0] as CloudImportReport;
}
afterEach(() => { cleanup(); session?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); readModel.mockReset(); readLayout.mockReset(); });

describe('import reports', () => {
  it('records a successful SketchUp model import with file size, version, counts, warnings, and build', async () => {
    readModel.mockResolvedValue(scene());
    const { recordImport } = setup(); open('Chair.skp');
    const entry = await logged(recordImport);
    expect(entry).toMatchObject({ source: 'sketchup_model', status: 'imported', fileName: 'Chair.skp', sizeBytes: 4, sourceVersion: '26.2.242',
      fileModifiedAt: '2026-10-20T12:00:00.000Z', counts: { bodies: 1, instances: 0 }, issues: ['Textures are not imported.'], error: null,
      appVersion: '0.1.0', appBuild: 'abc1234' });
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });
  it('records a failed model import with its error and a cancelled one without an error', async () => {
    readModel.mockRejectedValueOnce(new Error('Could not read this SketchUp file.'));
    const { recordImport } = setup(); open('Broken.skp');
    expect((await logged(recordImport)).status).toBe('failed');
    expect(recordImport.mock.calls[0]![0]).toMatchObject({ error: 'Could not read this SketchUp file.', sourceVersion: null, counts: {} });
    expect(screen.getByRole('alert').textContent).toContain('Could not read');
    readModel.mockRejectedValueOnce(new DOMException('Import cancelled.', 'AbortError'));
    open('Slow.skp');
    await waitFor(() => expect(recordImport).toHaveBeenCalledTimes(2));
    expect(recordImport.mock.calls[1]![0]).toMatchObject({ status: 'cancelled', error: null });
  });
  it('records LayOut imports with document properties, page count, and limitations, and failures with their error', async () => {
    const properties = { version: '16.1.1449', created: '2011-12-08T21:20:31.000Z', modified: '2016-08-04T15:24:06.000Z', revision: 251, pageCount: 1 };
    readLayout.mockResolvedValueOnce({ doc: createLayoutDocument(), warnings: ['Viewports are placeholders (2×)'], properties });
    const { recordImport } = setup(); open('Plan.layout');
    expect(await logged(recordImport)).toMatchObject({ source: 'sketchup_layout', status: 'imported', fileName: 'Plan.layout', sizeBytes: 4,
      sourceVersion: '16.1.1449', sourceCreatedAt: properties.created, sourceModifiedAt: properties.modified, fileModifiedAt: '2026-10-20T12:00:00.000Z',
      counts: { pages: 1, sourceRevision: 251 }, issues: ['Viewports are placeholders (2×)'] });
    expect(screen.getByRole('dialog', { name: 'LayOut import notes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    readLayout.mockRejectedValueOnce(new Error('Invalid .layout archive'));
    open('Broken.layout');
    await waitFor(() => expect(recordImport).toHaveBeenCalledTimes(2));
    expect(recordImport.mock.calls[1]![0]).toMatchObject({ source: 'sketchup_layout', status: 'failed', error: 'Invalid .layout archive', counts: {}, issues: [] });
    expect(screen.getByRole('alert').textContent).toContain('Invalid .layout archive');
  });
  it('keeps the import when the report cannot be stored', async () => {
    readModel.mockResolvedValue(scene());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { recordImport } = setup(); recordImport.mockRejectedValue(new Error('offline'));
    open('Chair.skp');
    await screen.findByRole('dialog', { name: 'SketchUp import report' });
    await waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(session.tabs).toHaveLength(2); expect(screen.queryByRole('alert')).toBeNull();
  });
});
