// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, vi } from 'vitest';
import type { FileRequest } from '@pushform/extensions';
import { browserClipboardWriter, browserFilePicker } from './browserExtensionIo';

const request: FileRequest = { extensionName: 'Cut List', kind: 'open', purpose: 'Import a parts list', accept: [{ description: 'CSV', extensions: ['csv', 'TXT'] }] };

describe('browserFilePicker', () => {
  it('opens nothing when the user declines the prompt', async () => {
    const confirm = vi.fn(async () => false);
    const create = vi.spyOn(document, 'createElement');
    expect(await browserFilePicker(confirm).open(request)).toBeNull();
    expect(confirm).toHaveBeenCalledWith(request);
    expect(create).not.toHaveBeenCalledWith('input');
    create.mockRestore();
  });

  /** A document whose created elements are real, with click replaced by `onClick`. */
  function fakeDocument(onClick: (element: HTMLElement) => void): Document {
    return {
      defaultView: null,
      createElement: (tag: string) => {
        const element = document.createElement(tag);
        element.click = () => onClick(element);
        return element;
      },
    } as unknown as Document;
  }

  it('reads the chosen file through a file input filtered to the accepted types', async () => {
    let accept = '';
    const doc = fakeDocument((element) => {
      const input = element as HTMLInputElement;
      accept = input.accept;
      Object.defineProperty(input, 'files', { value: [new File(['a,b'], 'parts.csv', { type: 'text/csv' })] });
      input.dispatchEvent(new Event('change'));
    });
    const chosen = await browserFilePicker(async () => true, doc).open(request);
    expect(accept).toBe('.csv,.txt');
    expect(chosen).toMatchObject({ name: 'parts.csv', type: 'text/csv' });
    expect(new TextDecoder().decode(chosen!.data)).toBe('a,b');
  });

  it('reports a cancelled file input as nothing chosen', async () => {
    const doc = fakeDocument((element) => element.dispatchEvent(new Event('cancel')));
    expect(await browserFilePicker(async () => true, doc).open(request)).toBeNull();
  });

  it('downloads the bytes under the suggested name where no save picker exists', async () => {
    const downloads: string[] = [];
    const doc = fakeDocument((element) => downloads.push((element as HTMLAnchorElement).download));
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    expect(await browserFilePicker(async () => true, doc).save({ ...request, kind: 'save', suggestedName: 'cut-list.csv' }, new Uint8Array([1]))).toEqual({ name: 'cut-list.csv' });
    expect(downloads).toEqual(['cut-list.csv']);
  });

  it('checks the selected size before reading bytes', async () => {
    const file = new File(['x'],'large.zip');
    Object.defineProperty(file,'size',{ value:65 * 1024 * 1024 });
    const read = vi.fn(async () => new ArrayBuffer(1));
    Object.defineProperty(file,'arrayBuffer',{ value:read });
    const doc = fakeDocument(element => {
      Object.defineProperty(element,'files',{ value:[file] }); element.dispatchEvent(new Event('change'));
    });
    await expect(browserFilePicker(async () => true,doc).open(request)).rejects.toMatchObject({ code:'limit.exceeded' });
    expect(read).not.toHaveBeenCalled();
  });

  it('cancels a pending file choice and ignores its eventual input event', async () => {
    const controller = new AbortController(); let input: HTMLElement | null = null;
    let clicked!: () => void; const ready = new Promise<void>(resolve => { clicked = resolve; });
    const doc = fakeDocument(element => { input = element; clicked(); });
    const chosen = browserFilePicker(async () => true,doc).open(request,{ signal:controller.signal });
    await ready; controller.abort();
    await expect(chosen).rejects.toMatchObject({ name:'AbortError' });
    const file = new File(['x'],'late.zip'), read = vi.fn(async () => new ArrayBuffer(1));
    Object.defineProperty(file,'arrayBuffer',{ value:read });
    Object.defineProperty(input!,'files',{ value:[file] }); input!.dispatchEvent(new Event('change'));
    expect(read).not.toHaveBeenCalled();
  });

  it('does not open a writable for a native save picker resolved after cancellation', async () => {
    let choose!: (value: { name:string;createWritable:ReturnType<typeof vi.fn> }) => void;
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const picker = vi.fn(() => { entered(); return new Promise(resolve => { choose = resolve; }); });
    const doc = { defaultView:{ showSaveFilePicker:picker } } as unknown as Document;
    const controller = new AbortController(), createWritable = vi.fn();
    const save = browserFilePicker(async () => true,doc).save({ ...request,kind:'save' },new Uint8Array([1]),{ signal:controller.signal });
    await ready; controller.abort();
    await expect(save).rejects.toMatchObject({ name:'AbortError' });
    choose({ name:'late.zip',createWritable }); await Promise.resolve();
    expect(createWritable).not.toHaveBeenCalled();
  });

  it('aborts a writable created after cancellation and never writes it', async () => {
    let create!: (value: unknown) => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const stream = { write:vi.fn(),close:vi.fn(),abort:vi.fn(async () => {}) };
    const handle = { name:'late.zip',createWritable:() => { entered(); return new Promise(resolve => { create = resolve; }); } };
    const doc = { defaultView:{ showSaveFilePicker:async () => handle } } as unknown as Document;
    const controller = new AbortController();
    const save = browserFilePicker(async () => true,doc).save({ ...request,kind:'save' },new Uint8Array([1]),{ signal:controller.signal });
    await ready; controller.abort(); await expect(save).rejects.toMatchObject({ name:'AbortError' });
    create(stream); await Promise.resolve();
    expect(stream.abort).toHaveBeenCalledOnce(); expect(stream.write).not.toHaveBeenCalled(); expect(stream.close).not.toHaveBeenCalled();
  });

  it('aborts a pending write before close, preserving the original file', async () => {
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const stream = { write:vi.fn(() => { entered(); return new Promise<void>(() => {}); }),close:vi.fn(),abort:vi.fn(async () => {}) };
    const doc = { defaultView:{ showSaveFilePicker:async () => ({ name:'library.zip',createWritable:async () => stream }) } } as unknown as Document;
    const controller = new AbortController();
    const save = browserFilePicker(async () => true,doc).save({ ...request,kind:'save' },new Uint8Array([1]),{ signal:controller.signal });
    await ready; controller.abort(); await expect(save).rejects.toMatchObject({ name:'AbortError' });
    expect(stream.abort).toHaveBeenCalledOnce(); expect(stream.close).not.toHaveBeenCalled();
  });

  it('retains a successful save when cancellation arrives during its final close', async () => {
    const controller = new AbortController();
    const stream = { write:vi.fn(async () => {}),close:vi.fn(async () => { controller.abort(); }),abort:vi.fn() };
    const doc = { defaultView:{ showSaveFilePicker:async () => ({ name:'saved.zip',createWritable:async () => stream }) } } as unknown as Document;
    expect(await browserFilePicker(async () => true,doc).save({ ...request,kind:'save' },new Uint8Array([1]),{ signal:controller.signal })).toEqual({ name:'saved.zip' });
    expect(stream.close).toHaveBeenCalledOnce(); expect(stream.abort).not.toHaveBeenCalled();
  });
});

describe('browserClipboardWriter', () => {
  it('writes plain text directly', async () => {
    const clipboard = { writeText: vi.fn(async () => {}), write: vi.fn(async () => {}) } as unknown as Clipboard;
    await browserClipboardWriter(clipboard).write({ text: 'A 720 x 400' });
    expect(clipboard.writeText).toHaveBeenCalledWith('A 720 x 400');
  });
});
