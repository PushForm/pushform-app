// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { setNativeStepReader, type ImportProgress } from '@pushform/io';

/**
 * On the desktop, STEP files are converted natively by the app's own process on every core, instead of by the
 * WebAssembly reader in the import worker. The bytes go through a temporary file (the IPC carries JSON), the result
 * comes back as one binary response, and the native side removes the temporary file once it has read it. Cancelling
 * (the import's abort signal) tells the native side to stop the job at its next progress report.
 */
export function installDesktopStepReader(): void {
  if (!isTauri()) return;
  setNativeStepReader(async (bytes, mode, threshold, onProgress, signal) => {
    if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    const { tempDir, join } = await import('@tauri-apps/api/path');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const path = await join(await tempDir(), `pushform-step-${crypto.randomUUID()}.step`);
    await writeFile(path, bytes);
    const channel = new Channel<{ stage: string; current: number; total: number }>();
    channel.onmessage = p => onProgress?.({ stage: p.stage, current: p.current, total: p.total } satisfies ImportProgress);
    const job = crypto.randomUUID();
    const cancel = (): void => { void invoke('step_cancel', { job }); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const result = await invoke<ArrayBuffer>('step_convert', { path, job, mode, threshold, cleanup: true, onProgress: channel });
      if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
      return new Uint8Array(result);
    } catch (cause) {
      if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
      throw cause;
    } finally { signal?.removeEventListener('abort', cancel); }
  });
}
