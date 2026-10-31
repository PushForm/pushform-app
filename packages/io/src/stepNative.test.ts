// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { readSketchUpInWorker } from './sketchupClient';
import { hasNativeStepReader, setNativeStepReader } from './step';
import { loadStepReader } from './stepModule';

const BOX = ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');", "FILE_NAME('t','',(''),(''),'','hand','');",
  "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", 'ENDSEC;', 'DATA;',
  "#1=APPLICATION_CONTEXT('automotive design');", 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');

/** A stand-in for the desktop's native reader: the wasm module driven outside the worker path. */
async function fakeNative(bytes: Uint8Array, mode: number, threshold: number): Promise<Uint8Array> {
  const m = await loadStepReader();
  const ptr = m.pf_alloc(bytes.length); new Uint8Array(m.memory.buffer, ptr, bytes.length).set(bytes);
  const handle = m.pf_step_open(ptr, bytes.length, mode, threshold); m.pf_free(ptr, bytes.length);
  if (!handle) throw new Error('open failed');
  while (m.pf_step_step(handle));
  m.pf_step_finish(handle); while (m.pf_step_mesh(handle));
  const len = m.pf_step_result(handle);
  const out = new Uint8Array(m.memory.buffer, m.pf_step_result_ptr(handle), len).slice();
  m.pf_step_close(handle);
  return out;
}

describe('a host-provided STEP reader', () => {
  afterEach(() => setNativeStepReader(null));
  it('is used instead of the module, reports its progress, and its failure is the import error', async () => {
    const calls: { mode: number; threshold: number }[] = [], stages: string[] = [];
    setNativeStepReader(async (bytes, mode, threshold, onProgress) => { calls.push({ mode, threshold }); onProgress?.({ stage: 'Converting parts', current: 1, total: 1 }); return fakeNative(bytes, mode, threshold); });
    expect(hasNativeStepReader()).toBe(true);
    await expect(readSketchUpInWorker(new TextEncoder().encode(BOX), { onProgress: p => { stages.push(p.stage); } })).rejects.toThrow();
    expect(calls).toEqual([{ mode: 7, threshold: 0 }]);
    expect(stages).toContain('Converting parts');
    setNativeStepReader(async () => { throw new Error('native reader down'); });
    await expect(readSketchUpInWorker(new TextEncoder().encode(BOX))).rejects.toThrow('native reader down');
  });
});
