// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { FILE_LIMITS, type ClipboardWriter, type FilePicker, type FileRequest } from '@pushform/extensions';
import { ExtensionError } from '@pushform/extension-protocol';

/**
 * Browser implementations of extension file pickers and clipboard writes. Extensions call these long after the
 * click that started them, so the host first shows its own prompt naming the extension and its purpose
 * (`confirm`); the user's choice there is the gesture the browser requires to open a picker or start a download.
 */

type Confirm = (request: FileRequest) => Promise<boolean>;

/** A file's bytes, through FileReader where Blob.arrayBuffer is missing (older engines). */
export function readFile(file: File, signal?: AbortSignal): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  if (typeof file.arrayBuffer === 'function') return waitFor(file.arrayBuffer(),signal);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal?.removeEventListener('abort',cancel);
    const cancel = () => { reader.abort(); cleanup(); reject(signal?.reason); };
    reader.onload = () => { cleanup(); resolve(reader.result as ArrayBuffer); };
    reader.onerror = () => { cleanup(); reject(reader.error); };
    reader.onabort = () => { cleanup(); reject(signal?.reason ?? new DOMException('File reading cancelled.','AbortError')); };
    signal?.addEventListener('abort',cancel,{ once:true });
    reader.readAsArrayBuffer(file);
  });
}

/** Native picker promises cannot dismiss their OS dialog. Ignore late results; clean up a stream opened late. */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal, disposeLate?: (value: T) => Promise<void>): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve,reject) => {
    let settled = false;
    const cancel = () => { if (!settled) { settled = true; signal.removeEventListener('abort',cancel); reject(signal.reason); } };
    signal.addEventListener('abort',cancel,{ once:true });
    if (signal.aborted) cancel();
    promise.then(value => {
      if (settled) { void disposeLate?.(value).catch(() => undefined); return; }
      settled = true; signal.removeEventListener('abort',cancel); resolve(value);
    },error => {
      if (!settled) { settled = true; signal.removeEventListener('abort',cancel); reject(error); }
    });
  });
}

const acceptAttribute = (request: FileRequest): string =>
  request.accept.flatMap((f) => f.extensions.map((e) => `.${e.toLowerCase()}`)).join(',');

interface FileWritable { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
interface SavePickerWindow {
  showSaveFilePicker?: (options: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) =>
    Promise<{ name: string; createWritable(): Promise<FileWritable> }>;
}

export function browserFilePicker(confirm: Confirm, doc: Document = document): FilePicker {
  return {
    async open(request,options) {
      const signal = options?.signal;
      signal?.throwIfAborted();
      if (!(await waitFor(confirm(request),signal))) return null;
      signal?.throwIfAborted();
      const input = doc.createElement('input');
      input.type = 'file';
      const accept = acceptAttribute(request);
      if (accept) input.accept = accept;
      const file = await new Promise<File | null>((resolve,reject) => {
        const cleanup = () => { input.removeEventListener('change',changed); input.removeEventListener('cancel',declined); signal?.removeEventListener('abort',cancel); input.remove(); };
        const changed = () => { const file = input.files?.[0] ?? null; cleanup(); resolve(file); };
        const declined = () => { cleanup(); resolve(null); };
        const cancel = () => { cleanup(); reject(signal?.reason); };
        input.addEventListener('change',changed,{ once:true });
        input.addEventListener('cancel',declined,{ once:true });
        signal?.addEventListener('abort',cancel,{ once:true });
        try { input.click(); } catch (error) { cleanup(); reject(error); }
      });
      signal?.throwIfAborted();
      if (!file) return null;
      if (file.size > Math.min(options?.maxBytes ?? FILE_LIMITS.bytes,FILE_LIMITS.bytes))
        throw new ExtensionError('limit.exceeded','The chosen file exceeds the allowed file size.');
      return { name: file.name, type: file.type, data: new Uint8Array(await readFile(file,signal)) };
    },
    async save(request, data, options) {
      const signal = options?.signal;
      signal?.throwIfAborted();
      if (data.length > Math.min(options?.maxBytes ?? FILE_LIMITS.bytes,FILE_LIMITS.bytes))
        throw new ExtensionError('limit.exceeded','The export exceeds the allowed file size.');
      if (!(await waitFor(confirm(request),signal))) return null;
      signal?.throwIfAborted();
      const win = doc.defaultView as (Window & SavePickerWindow) | null;
      const name = request.suggestedName ?? 'export';
      if (win?.showSaveFilePicker) {
        let writable: FileWritable | null = null;
        let closed = false;
        try {
          const handle = await waitFor(win.showSaveFilePicker({
            suggestedName: name,
            types: request.accept.map((f) => ({ description: f.description, accept: { 'application/octet-stream': f.extensions.map((e) => `.${e}`) } })),
          }),signal);
          signal?.throwIfAborted();
          writable = await waitFor(handle.createWritable(),signal,late => late.abort());
          signal?.throwIfAborted();
          await waitFor(writable.write(data),signal);
          signal?.throwIfAborted();
          // close publishes the completed file. A cancellation that arrives during/after close cannot undo it.
          await writable.close();
          closed = true;
          return { name: handle.name };
        } catch (error) {
          signal?.throwIfAborted();
          if ((error as { name?: string }).name === 'AbortError') return null;
          throw error;
        } finally {
          if (writable && !closed) await writable.abort().catch(() => undefined);
        }
      }
      signal?.throwIfAborted();
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
