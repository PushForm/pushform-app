// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { importSketchUpLayoutInWorker } from './sketchupLayoutClient';
import { prepareSketchUpLayout } from './sketchupLayout';

class FakeWorker {
  static last: FakeWorker;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { FakeWorker.last = this; }
}
afterEach(() => vi.unstubAllGlobals());

const DOCUMENT = `<?xml version="1.0" ?>
<layoutDocument xmlns="http://sketchup.google.com/schemas/layout/1.0/layoutdocument" xmlns:ld="http://sketchup.google.com/schemas/layout/1.0/layoutdocument" xmlns:r="http://sketchup.google.com/schemas/layout/1.0/references">
  <ld:pageInfo width="11" height="8.5" />
  <ld:layerManager><ld:layerDefinition id="id10" name="Base" visible="1" locked="0" shared="0" /></ld:layerManager>
  <ld:pageManager><ld:pageRef r:id="id1" name="Plan" /></ld:pageManager>
</layoutDocument>`;
const REFERENCES = `<?xml version="1.0" ?><references xmlns="http://sketchup.google.com/schemas/layout/1.0/references" xmlns:r="http://sketchup.google.com/schemas/layout/1.0/references"><r:pageFileReference r:id="id1" internalTarget="pages/page1.xml" /></references>`;
const archive = (): Uint8Array => zipSync({
  'document.xml': strToU8(DOCUMENT), 'references.xml': strToU8(REFERENCES),
  'pages/page1.xml': strToU8('<?xml version="1.0" ?><page xmlns="http://sketchup.google.com/schemas/layout/1.0/page" />'),
});

describe('LayOut worker client', () => {
  it('rejects invalid numeric worker data before creating an editable document', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const pending = importSketchUpLayoutInWorker(archive(), 'Invalid.layout');
    const prepared = structuredClone(prepareSketchUpLayout(archive()));
    prepared.state.pages.values().next().value!.size[0] = Infinity;
    FakeWorker.last.onmessage?.({ data: { type: 'result', prepared } } as MessageEvent);
    await expect(pending).rejects.toThrow('nonfinite numeric data');
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
  });
  it('installs the prepared state a worker returns and terminates the worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const bytes = archive();
    const pending = importSketchUpLayoutInWorker(bytes, 'Plan.layout');
    const worker = FakeWorker.last;
    const [request, transfer] = worker.postMessage.mock.calls[0]! as [{ bytes: Uint8Array; fileName: string }, Transferable[]];
    expect(request.fileName).toBe('Plan.layout');
    expect(request.bytes).not.toBe(bytes);
    expect(transfer).toEqual([request.bytes.buffer]);
    expect([...bytes]).toEqual([...archive()]);
    const prepared = prepareSketchUpLayout(bytes, 'Plan.layout');
    worker.onmessage?.({ data: { type: 'result', prepared: structuredClone(prepared) } } as MessageEvent);
    const result = await pending;
    expect(result.doc.state.pages.size).toBe(1);
    expect(result.doc.state.customFields.get('FileName')).toBe('Plan');
    expect(result.warnings).toEqual(prepared.warnings);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates the worker on cancellation and ignores a late result', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const controller = new AbortController();
    const pending = importSketchUpLayoutInWorker(archive(), 'Plan.layout', { signal: controller.signal });
    const worker = FakeWorker.last;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.onmessage?.({ data: { type: 'error', message: 'late' } } as MessageEvent);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('rejects conversion errors and worker crashes, and pre-cancelled requests before starting a worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const failed = importSketchUpLayoutInWorker(archive(), 'Plan.layout');
    FakeWorker.last.onmessage?.({ data: { type: 'error', message: 'Invalid .layout archive' } } as MessageEvent);
    await expect(failed).rejects.toThrow('Invalid .layout archive');
    const crashed = importSketchUpLayoutInWorker(archive(), 'Plan.layout');
    FakeWorker.last.onerror?.({ message: 'Worker crashed' } as ErrorEvent);
    await expect(crashed).rejects.toThrow('Worker crashed');
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
    vi.stubGlobal('Worker', vi.fn());
    const controller = new AbortController(); controller.abort();
    await expect(importSketchUpLayoutInWorker(archive(), 'Plan.layout', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(Worker).not.toHaveBeenCalled();
  });

  it('converts inline where workers do not exist, so headless callers share the converter', async () => {
    const result = await importSketchUpLayoutInWorker(archive(), 'Plan.layout');
    expect(result.doc.state.pages.size).toBe(1);
    await expect(importSketchUpLayoutInWorker(new Uint8Array([1, 2, 3]), 'Bad.layout')).rejects.toThrow('Invalid .layout archive');
  });
});
