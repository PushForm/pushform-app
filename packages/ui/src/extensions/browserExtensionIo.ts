// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ClipboardWriter, FilePicker, FileRequest } from '@pushform/extensions';

/**
 * Browser implementations of extension file pickers and clipboard writes. Extensions call these long after the
 * click that started them, so the host first shows its own prompt naming the extension and its purpose
 * (`confirm`); the user's choice there is the gesture the browser requires to open a picker or start a download.
 */

type Confirm = (request: FileRequest) => Promise<boolean>;

/** A file's bytes, through FileReader where Blob.arrayBuffer is missing (older engines). */
export function readFile(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

const acceptAttribute = (request: FileRequest): string =>
  request.accept.flatMap((f) => f.extensions.map((e) => `.${e.toLowerCase()}`)).join(',');

interface SavePickerWindow {
  showSaveFilePicker?: (options: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) =>
    Promise<{ name: string; createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }> }>;
}

export function browserFilePicker(confirm: Confirm, doc: Document = document): FilePicker {
  return {
    async open(request) {
      if (!(await confirm(request))) return null;
      const input = doc.createElement('input');
      input.type = 'file';
      const accept = acceptAttribute(request);
      if (accept) input.accept = accept;
      const file = await new Promise<File | null>((resolve) => {
        input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
        input.addEventListener('cancel', () => resolve(null), { once: true });
        input.click();
      });
      if (!file) return null;
      return { name: file.name, type: file.type, data: new Uint8Array(await readFile(file)) };
    },
    async save(request, data) {
      if (!(await confirm(request))) return null;
      const win = doc.defaultView as (Window & SavePickerWindow) | null;
      const name = request.suggestedName ?? 'export';
      if (win?.showSaveFilePicker) {
        try {
          const handle = await win.showSaveFilePicker({
            suggestedName: name,
            types: request.accept.map((f) => ({ description: f.description, accept: { 'application/octet-stream': f.extensions.map((e) => `.${e}`) } })),
          });
          const writable = await handle.createWritable();
          await writable.write(data);
          await writable.close();
          return { name: handle.name };
        } catch (error) {
          if ((error as { name?: string }).name === 'AbortError') return null;
          throw error;
        }
      }
      const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>]));
      try {
        const link = doc.createElement('a');
        link.href = url;
        link.download = name;
        link.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      return { name };
    },
  };
}

export function browserClipboardWriter(clipboard: Clipboard = navigator.clipboard): ClipboardWriter {
  return {
    async write({ text, html, png }) {
      if (html === undefined && png === undefined && text !== undefined) {
        await clipboard.writeText(text);
        return;
      }
      const parts: Record<string, Blob> = {};
      if (text !== undefined) parts['text/plain'] = new Blob([text], { type: 'text/plain' });
      if (html !== undefined) parts['text/html'] = new Blob([html], { type: 'text/html' });
      if (png !== undefined) parts['image/png'] = new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' });
      await clipboard.write([new ClipboardItem(parts)]);
    },
  };
}
