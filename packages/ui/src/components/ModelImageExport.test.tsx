// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { keepProportions, modelImageFileName, modelImageSize, modelImageSizeError, renderModelImage, type ModelImageChoice } from './modelImageExport';
import { TopBar } from './TopBar';

let session: DocumentSession | undefined;
afterEach(() => { cleanup(); session?.dispose(); session = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** A drawn picture whose encoding records the type and quality asked for. */
function fakeCanvas(width: number, height: number, encoded: { mime?: string; quality?: number }): HTMLCanvasElement {
  return { width, height, toBlob: (done: (blob: Blob | null) => void, mime: string, quality: number) => {
    // jsdom's Blob has no arrayBuffer(); browsers' does.
    encoded.mime = mime; encoded.quality = quality; done({ type: mime, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as unknown as Blob);
  } } as unknown as HTMLCanvasElement;
}
const view = { width: 800, height: 600 };
const choice = (over: Partial<ModelImageChoice> = {}): ModelImageChoice =>
  ({ format: 'png', useViewSize: true, width: 1600, height: 1200, antialias: true, transparent: false, ...over });

describe('2D graphic export', () => {
  it('sizes the picture from the view or a custom size kept in the view’s proportions, and refuses oversized pictures', () => {
    expect(modelImageSize(choice(), { width: 800.4, height: 599.6 })).toEqual([800, 600]);
    expect(modelImageSize(choice({ useViewSize: false }), view)).toEqual([1600, 1200]);
    expect(keepProportions('width', 2000, view)).toBe(1500);
    expect(keepProportions('height', 300, view)).toBe(400);
    expect(modelImageSizeError(16384, 6000)).toBeNull();
    expect(modelImageSizeError(16385, 10)).toMatch(/16385 × 10 pixels is too large/);
    expect(modelImageSizeError(12000, 9000)).toMatch(/too large/);
    expect(modelImageFileName('House plan.pf', 'jpeg')).toBe('House plan.jpg');
    expect(modelImageFileName('a/b:c.pf', 'png')).toBe('a-b-c.png');
  });
  it('draws at the chosen size with anti-aliasing and transparency for PNG only, and encodes JPEG at 92%', async () => {
    const encoded: { mime?: string; quality?: number } = {};
    const draw = vi.fn((w: number, h: number) => fakeCanvas(w, h, encoded));
    expect(await renderModelImage(draw, choice({ transparent: true }), view)).toEqual(new Uint8Array([1, 2, 3]));
    expect(draw).toHaveBeenLastCalledWith(800, 600, { antialias: true, transparent: true });
    expect(encoded.mime).toBe('image/png');
    await renderModelImage(draw, choice({ format: 'jpeg', transparent: true, antialias: false, useViewSize: false }), view);
    expect(draw).toHaveBeenLastCalledWith(1600, 1200, { antialias: false, transparent: false });
    expect(encoded).toEqual({ mime: 'image/jpeg', quality: 0.92 });
    await expect(renderModelImage(() => null, choice(), view)).rejects.toThrow('A picture of 800 × 600 pixels could not be drawn. Choose a smaller size.');
    await expect(renderModelImage(draw, choice({ useViewSize: false, width: 20000, height: 15000 }), view)).rejects.toThrow(/too large/);
  });

  it('exports from the Main menu after choosing where to save, keeps the view and the choices, and offers the command', async () => {
    session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
    const tab = session.active;
    if (tab.type !== 'model') throw new Error('Expected model');
    vi.spyOn(tab.app.viewport, 'size', 'get').mockReturnValue(view);
    const encoded: { mime?: string } = {};
    const renderImage = vi.spyOn(tab.app.viewport, 'renderImage').mockImplementation((w, h) => fakeCanvas(w, h, encoded));
    const write = vi.fn(), close = vi.fn();
    const savePicker = vi.fn(async () => ({ createWritable: async () => ({ write, close }) }));
    vi.stubGlobal('showSaveFilePicker', savePicker);
    const camera = tab.app.viewport.camera.getState();
    render(<div className="pf-app"><TopBar session={session} /></div>);

    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'png' } });
    const dialog = screen.getByRole('dialog', { name: 'Export' });
    expect((screen.getByLabelText('Use view size') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Width') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe(`800 × 600 px · ${tab.name.replace(/\.pf$/i, '')}.png`);
    fireEvent.click(screen.getByLabelText('Use view size'));
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '1200' } });
    expect((screen.getByLabelText('Height') as HTMLInputElement).value).toBe('900');
    fireEvent.change(screen.getByLabelText('Height'), { target: { value: '20000' } });
    expect(screen.getByRole('alert').textContent).toMatch(/26667 × 20000 pixels is too large/);
    expect((screen.getByRole('button', { name: 'Export…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Height'), { target: { value: '900' } });
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'jpeg' } });
    expect((screen.getByLabelText('Transparent background') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Anti-alias'));
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(dialog.isConnected).toBe(false);
    expect(savePicker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: `${tab.name.replace(/\.pf$/i, '')}.jpg` }));
    expect(renderImage).toHaveBeenCalledWith(1200, 900, { antialias: false, transparent: false });
    expect(write.mock.calls[0]![0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(encoded.mime).toBe('image/jpeg');
    expect(tab.app.viewport.camera.getState()).toEqual(camera);

    // Command search offers it, and the next export starts from the last choices.
    const search = screen.getByRole('combobox', { name: 'Search tools and commands' });
    fireEvent.focus(search); fireEvent.change(search, { target: { value: 'Export 2D' } });
    fireEvent.click(screen.getByRole('option', { name: /Export 2D Graphic/ }));
    expect((screen.getByLabelText('Format') as HTMLSelectElement).value).toBe('jpeg');
    expect((screen.getByLabelText('Use view size') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Width') as HTMLInputElement).value).toBe('1200');
    expect((screen.getByLabelText('Anti-alias') as HTMLInputElement).checked).toBe(false);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Export' })).toBeNull();
  });

  it('keeps the options open when the save location is cancelled, and shows a drawing failure there', async () => {
    session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
    const tab = session.active;
    if (tab.type !== 'model') throw new Error('Expected model');
    vi.spyOn(tab.app.viewport, 'size', 'get').mockReturnValue(view);
    const renderImage = vi.spyOn(tab.app.viewport, 'renderImage').mockReturnValue(null);
    const savePicker = vi.fn(async () => { throw Object.assign(new Error('cancel'), { name: 'AbortError' }); });
    vi.stubGlobal('showSaveFilePicker', savePicker);
    render(<div className="pf-app"><TopBar session={session} /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'png' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(savePicker).toHaveBeenCalledOnce());
    await waitFor(() => expect((screen.getByRole('button', { name: 'Export…' }) as HTMLButtonElement).disabled).toBe(false));
    expect(renderImage).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Export' })).toBeTruthy();
    savePicker.mockImplementation(async () => ({ createWritable: async () => ({ write: vi.fn(), close: vi.fn() }) }) as never);
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be drawn/);
    expect(screen.getByRole('dialog', { name: 'Export' })).toBeTruthy();
  });
});
