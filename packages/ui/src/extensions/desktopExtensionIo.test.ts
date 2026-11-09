// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { beforeEach, expect, it, vi } from 'vitest';
import { browserFilePicker } from './browserExtensionIo';

const native = vi.hoisted(() => ({ save: vi.fn(), writeFile: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: native.save }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: native.writeFile }));
beforeEach(() => { vi.resetAllMocks(); });
const request = { extensionName: 'Cut List', kind: 'save' as const, purpose: 'Export parts', suggestedName: 'Parts.csv', accept: [{ description: 'CSV', extensions: ['csv'] }] };

it('writes bytes only to the native picker destination and exposes only its file name', async () => {
  native.save.mockResolvedValue('C:\\chosen\\Parts.csv'); native.writeFile.mockResolvedValue(undefined);
  const bytes = new Uint8Array([65, 44, 66]);
  expect(await browserFilePicker(async () => true).save(request, bytes)).toEqual({ name: 'Parts.csv' });
  expect(native.save).toHaveBeenCalledWith({ defaultPath: 'Parts.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
  expect(native.writeFile).toHaveBeenCalledWith('C:\\chosen\\Parts.csv', bytes);
});

it('never writes after declined consent, picker cancellation or cancellation while the picker was open', async () => {
  const picker = browserFilePicker(async () => false);
  expect(await picker.save(request, new Uint8Array())).toBeNull(); expect(native.save).not.toHaveBeenCalled();
  native.save.mockResolvedValueOnce(null);
  expect(await browserFilePicker(async () => true).save(request, new Uint8Array())).toBeNull();
  const controller = new AbortController(); let choose!: (path: string) => void;
  native.save.mockImplementationOnce(() => new Promise(resolve => { choose = resolve; }));
  const saving = browserFilePicker(async () => true).save(request, new Uint8Array(), { signal: controller.signal });
  await vi.waitFor(() => expect(choose).toBeTypeOf('function'));
  controller.abort(); await expect(saving).rejects.toMatchObject({ name: 'AbortError' });
  choose('C:\\chosen\\Late.csv'); await Promise.resolve(); expect(native.writeFile).not.toHaveBeenCalled();
});
