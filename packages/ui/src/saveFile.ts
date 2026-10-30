// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { isTauri } from '@tauri-apps/api/core';

export interface SaveFileType { description: string; mime: string; extension: string }
export interface SaveTarget {
  write(bytes: Uint8Array): Promise<void>;
  /** Opens the written file with the system's viewer, where the target knows its path (the desktop app). */
  open?(): Promise<void>;
}

interface SavePickerWindow {
  showSaveFilePicker?: (options: object) => Promise<{ createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }> }>;
}

function download(bytes: Uint8Array, name: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Asks where to save a file before it is made: the desktop save dialog, the browser's save picker, or else a
 * download once the file is written. Ask from a click, since browsers open their save picker only right after one.
 * Null when the person cancels.
 */
export async function chooseSaveTarget(name: string, type: SaveFileType): Promise<SaveTarget | null> {
  const withExtension = (path: string): string => path.toLowerCase().endsWith(`.${type.extension}`) ? path : `${path}.${type.extension}`;
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const chosen = await save({ defaultPath: name, filters: [{ name: type.description, extensions: [type.extension] }] });
    if (!chosen) return null;
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    return {
      write: bytes => writeFile(withExtension(chosen), bytes),
      open: async () => { const { openPath } = await import('@tauri-apps/plugin-opener'); await openPath(withExtension(chosen)); },
    };
  }
  const picker = (window as unknown as SavePickerWindow).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName: name, types: [{ description: type.description, accept: { [type.mime]: [`.${type.extension}`] } }] });
      return { write: async bytes => { const writable = await handle.createWritable(); await writable.write(bytes); await writable.close(); } };
    } catch (cause) {
      if ((cause as Error).name === 'AbortError') return null;
      throw cause;
    }
  }
  return { write: async bytes => download(bytes, name, type.mime) };
}
