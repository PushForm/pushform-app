// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { meshBox } from '@pushform/core';
import { openModelFile, readSketchUpInWorker, type SketchUpImport, type StepPreview } from '@pushform/io';
import type * as IoModule from '@pushform/io';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { TopBar } from './TopBar';

vi.mock('@pushform/io', async original => ({ ...await original<typeof IoModule>(), readSketchUpInWorker: vi.fn() }));
const readModel = vi.mocked(readSketchUpInWorker);
function scene(): SketchUpImport {
  return { version: '{26}', root: { key: -1, guid: 'ROOT', name: 'Model', image: false, group: false, alwaysFaceCamera: false, shadowsFaceSun: false,
    solids: [{ mesh: meshBox([0, 0, 0], [1, 2, 3]), faces: [] }], sheets: [], edges: [], curves: [], sectionPlanes: [], guides: [], dimensions: [], texts: [], instances: [] },
    definitions: new Map(), materials: new Map(), images: [], tags: [], scenes: [], units: null, warnings: ['Textures are not imported.'] };
}
let session: DocumentSession;
function setup(): DocumentSession {
  session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
  render(<div className="pf-app"><TopBar session={session} /></div>);
  return session;
}
function file(name: string): File {
  const f = new File([new Uint8Array([1, 2, 3, 4])], name);
  Object.defineProperty(f, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3, 4]).buffer });
  return f;
}
afterEach(() => { cleanup(); session?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); readModel.mockReset(); });

/** A file that begins like STEP, so the import draws its parts as they are read. */
function stepFile(name: string): File {
  const bytes = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\n');
  const f = new File([bytes], name);
  Object.defineProperty(f, 'arrayBuffer', { value: async () => bytes.slice().buffer });
  return f;
}
/** One cube part placed twice, 2 m apart, as a STEP read hands it out. */
const cubePreview = (): StepPreview => ({
  parts: [{ id: 0, color: [0, 0, 1], positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 1]), triangles: new Uint32Array([0, 1, 2]), edges: new Float32Array(0) }],
  placements: [{ part: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, { part: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1] }],
});
/** A read that hands out one preview, then waits to be finished (or cancelled through its signal). */
function pendingRead(): { finish: (scene: SketchUpImport) => void } {
  let finish: (scene: SketchUpImport) => void = () => {};
  readModel.mockImplementation((_bytes, options) => new Promise((resolve, reject) => {
    finish = resolve;
    options?.signal?.addEventListener('abort', () => reject(new DOMException('Import cancelled.', 'AbortError')));
    options?.onPreview?.(cubePreview());
  }));
  return { finish: scene => finish(scene) };
}

describe('Model import UI', () => {
  it('opens a STEP file in a tab named after it that draws the parts as they are read, then opens the model', async () => {
    const read = pendingRead(); setup();
    const original = session.active;
    fireEvent.change(screen.getByLabelText('Open PushForm file'), { target: { files: [stepFile('Bracket.step')] } });
    const panel = await screen.findByRole('region', { name: 'Importing STEP model' });
    expect(panel.textContent).toContain('Bracket.step');
    // No modal: the viewport stays usable while the parts come in.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector<HTMLElement>('.pf-app')!.inert).toBe(false);
    const drawing = session.active;
    if (drawing.type !== 'model') throw new Error('Expected model');
    expect(drawing).not.toBe(original);
    expect(drawing.name).toBe('Bracket.pf');
    expect(drawing.app.viewport.sceneBounds()).toEqual({ min: [0, 0, 0], max: [3, 1, 1] });
    expect(drawing.app.document.doc.rootDefinition.entities.instances.size).toBe(0);
    await act(async () => { read.finish(scene()); });
    await screen.findByRole('dialog', { name: 'STEP import report' });
    // The placeholder made way for the model's own tab.
    expect(session.tabs.includes(drawing)).toBe(false);
    expect(session.tabs).toHaveLength(2);
    const opened = session.active;
    if (opened.type !== 'model') throw new Error('Expected model');
    expect(opened.name).toBe('Bracket.pf');
    expect(opened.app.document.undoStack.length).toBe(0);
  });

  it('draws a STEP import in the current model, and Cancel removes it and leaves the model unchanged', async () => {
    pendingRead(); setup();
    const original = session.active;
    if (original.type !== 'model') throw new Error('Expected model');
    const before = original.app.viewport.sceneBounds();
    vi.spyOn(screen.getByLabelText('Import model file') as HTMLInputElement, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import...' }));
    fireEvent.change(screen.getByLabelText('Import model file'), { target: { files: [stepFile('Bracket.stp')] } });
    await screen.findByRole('region', { name: 'Importing STEP model' });
    expect(session.tabs).toHaveLength(1);
    expect(original.app.viewport.sceneBounds()!.max[0]).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Importing STEP model' })).toBeNull());
    expect(original.app.viewport.sceneBounds()).toEqual(before);
    expect(original.app.document.doc.rootDefinition.entities.instances.size).toBe(0);
    expect(original.app.document.undoStack.length).toBe(0);
  });

  it('imports into the current model through the menu and command search, reports limitations, and undoes once', async () => {
    readModel.mockResolvedValue(scene());
    setup();
    const original = session.active;
    if (original.type !== 'model') throw new Error('Expected model');
    const input = screen.getByLabelText('Import model file'), clicked = vi.spyOn(input as HTMLInputElement, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import...' }));
    expect(clicked).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { files: [file('Chair.SKP')] } });
    expect((await screen.findByRole('dialog', { name: 'SketchUp import report' })).textContent).toContain('Textures are not imported.');
    expect(session.tabs).toHaveLength(1);
    expect(original.app.document.doc.rootDefinition.entities.instances.size).toBe(1);
    expect(original.app.document.undoStack.length).toBe(1);
    expect(session.isDirty(original)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(document.querySelector<HTMLElement>('.pf-app')!.inert).toBe(false);
    const search = screen.getByRole('combobox', { name: 'Search tools and commands' });
    fireEvent.focus(search); fireEvent.change(search, { target: { value: 'Import Model' } });
    fireEvent.click(screen.getByRole('option', { name: /Import Model/ }));
    expect(clicked).toHaveBeenCalledTimes(2);
    act(() => { original.app.document.undo(); });
    expect(original.app.document.doc.rootDefinition.entities.instances.size).toBe(0);
  });

  it('counts imported section planes, guides and dimensions in the report only when there are any', async () => {
    const annotated = scene();
    annotated.root.sectionPlanes.push({ name: 'Cut', symbol: 'A', plane: { n: [1, 0, 0], d: 0 }, origin: [0, 0, 0], hidden: false, tag: '', active: true });
    annotated.root.guides.push({ kind: 'point', origin: [1, 1, 1], hidden: false, tag: '' });
    readModel.mockResolvedValue(annotated); setup();
    fireEvent.change(screen.getByLabelText('Open PushForm file'), { target: { files: [file('Plan.skp')] } });
    expect((await screen.findByRole('dialog', { name: 'SketchUp import report' })).textContent).toContain('1 section planes · 1 guides · 0 dimensions');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    readModel.mockResolvedValue(scene());
    fireEvent.change(screen.getByLabelText('Open PushForm file'), { target: { files: [file('Chair.skp')] } });
    expect((await screen.findByRole('dialog', { name: 'SketchUp import report' })).textContent).not.toContain('section planes');
  });

  it('reports the scenes and text it opens, keeping text in the model', async () => {
    const opened = scene();
    opened.root.texts.push({ text: 'Note', kind: 'leader', position: [1, 2, 3], offset: [0, 0, 0.5], leader: 'pushpin', hidden: false, tag: 'Layer0' });
    opened.scenes.push({ name: 'Plan', camera: null, hiddenTags: [], usesTags: false });
    readModel.mockResolvedValue(opened); setup();
    fireEvent.change(screen.getByLabelText('Open PushForm file'), { target: { files: [file('Notes.skp')] } });
    expect((await screen.findByRole('dialog', { name: 'SketchUp import report' })).textContent).toContain('1 scenes · 1 texts');
    const tab = session.active;
    if (tab.type !== 'model') throw new Error('Expected model');
    expect([...tab.app.document.doc.rootDefinition.entities.texts.values()].map(t => t.text)).toEqual(['Note']);
    const [plan] = tab.app.document.doc.state.scenes.values();
    expect(plan!.flags).toMatchObject({ useCamera: false, useTags: false });
  });

  it('places an imported picture as a selected image and picks it up with Move', async () => {
    setup();
    const original = session.active;
    if (original.type !== 'model') throw new Error('Expected model');
    vi.spyOn(screen.getByLabelText('Import model file') as HTMLInputElement, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import...' }));
    // A PNG's signature and header: 500 × 250 pixels.
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 500);
    new DataView(png.buffer).setUint32(20, 250);
    const picture = new File([png], 'Site photo.PNG');
    Object.defineProperty(picture, 'arrayBuffer', { value: async () => png.buffer });
    fireEvent.change(screen.getByLabelText('Import model file'), { target: { files: [picture] } });
    await waitFor(() => expect(original.app.document.doc.rootDefinition.entities.images.size).toBe(1));
    const [placed] = original.app.document.doc.rootDefinition.entities.images.values();
    expect(placed).toMatchObject({ widthM: 0.5, heightM: 0.25 });
    expect(original.app.document.selection.refs).toEqual([{ kind: 'image', path: [], id: placed!.id }]);
    expect(original.app.toolManager.activeTool?.id).toBe('move');
    expect(original.app.document.undoStack.length).toBe(1);
    expect(readModel).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens and imports COLLADA files through the same flow, named for their format', async () => {
    readModel.mockResolvedValue(scene()); setup();
    const original = session.active;
    if (original.type !== 'model') throw new Error('Expected model');
    vi.spyOn(screen.getByLabelText('Import model file') as HTMLInputElement, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import...' }));
    fireEvent.change(screen.getByLabelText('Import model file'), { target: { files: [file('Chair.dae')] } });
    await screen.findByRole('dialog', { name: 'COLLADA import report' });
    const [placed] = original.app.document.doc.rootDefinition.entities.instances.values();
    expect(original.app.document.doc.state.definitions.get(placed!.definitionId)!.name).toBe('Chair');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByLabelText('Open PushForm file'), { target: { files: [file('Table.DAE')] } });
    await screen.findByRole('dialog', { name: 'COLLADA import report' });
    expect(session.active).not.toBe(original);
    expect(session.active.name).toBe('Table.pf');
  });

  it('opens a backup as a new unsaved .pf with no source identity, and persists its geometry', async () => {
    readModel.mockResolvedValue(scene()); setup();
    const original = session.active;
    fireEvent.change(screen.getByLabelText('Open PushForm file'), { target: { files: [file('Building.skb')] } });
    await screen.findByRole('dialog', { name: 'SketchUp import report' });
    const tab = session.active;
    if (tab.type !== 'model') throw new Error('Expected model');
    expect(tab).not.toBe(original);
    expect(tab.name).toBe('Building.pf');
    expect(tab.identity).toBeUndefined();
    expect(session.isDirty(tab)).toBe(true);
    expect(tab.app.document.undoStack.length).toBe(0);
    const stored = (await openModelFile(await session.saveModelBytes(tab.id))).state;
    expect(stored.definitions.get(stored.rootDefinitionId)!.entities.bodies.size).toBe(1);
  });

  it('uses a new native save handle after opening .skp instead of writing to the source handle', async () => {
    readModel.mockResolvedValue(scene());
    const sourceWrite = vi.fn(), write = vi.fn(), close = vi.fn();
    vi.stubGlobal('showOpenFilePicker', vi.fn(async () => [{ name: 'House.skp', getFile: async () => file('House.skp'), createWritable: sourceWrite }]));
    const savePicker = vi.fn(async () => ({ name: 'House.pf', createWritable: async () => ({ write, close }) }));
    vi.stubGlobal('showSaveFilePicker', savePicker);
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open…' }));
    await screen.findByRole('dialog', { name: 'SketchUp import report' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(savePicker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'House.pf' }));
    expect(sourceWrite).not.toHaveBeenCalled();
    const state = (await openModelFile(write.mock.calls[0]![0] as Uint8Array)).state;
    expect(state.definitions.get(state.rootDefinitionId)!.entities.bodies.size).toBe(1);
  });

  it('cancels before commit even if a reader returns late, with no tab or document changes', async () => {
    let resolve!: (s: SketchUpImport) => void;
    readModel.mockImplementation(() => new Promise(r => { resolve = r; }));
    setup(); const original = session.active;
    fireEvent.change(screen.getByLabelText('Open PushForm file'), { target: { files: [file('House.skp')] } });
    await waitFor(() => expect(readModel).toHaveBeenCalledOnce());
    const signal = readModel.mock.calls[0]![1]!.signal!;
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(signal.aborted).toBe(true);
    await act(async () => { resolve(scene()); });
    expect(session.tabs).toHaveLength(1);
    expect(session.active).toBe(original);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows parser errors without creating a document', async () => {
    readModel.mockRejectedValue(new Error('This SketchUp version is unsupported.')); setup();
    fireEvent.change(screen.getByLabelText('Open PushForm file'), { target: { files: [file('Old.skp')] } });
    expect((await screen.findByRole('alert')).textContent).toContain('unsupported');
    expect(session.tabs).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
