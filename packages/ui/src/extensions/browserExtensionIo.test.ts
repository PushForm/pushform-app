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
});

describe('browserClipboardWriter', () => {
  it('writes plain text directly', async () => {
    const clipboard = { writeText: vi.fn(async () => {}), write: vi.fn(async () => {}) } as unknown as Clipboard;
    await browserClipboardWriter(clipboard).write({ text: 'A 720 x 400' });
    expect(clipboard.writeText).toHaveBeenCalledWith('A 720 x 400');
  });
});
