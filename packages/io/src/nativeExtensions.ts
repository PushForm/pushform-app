// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
export const MODEL_FILE_EXTENSION = '.pf';
export const LAYOUT_FILE_EXTENSION = '.pfl';

export type NativeDocumentType = 'model' | 'layout';

/** File-type recognition shared by Open dialogs, drag/drop, and future native IO. */
export function nativeDocumentType(filename: string): NativeDocumentType | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(LAYOUT_FILE_EXTENSION)) return 'layout';
  if (lower.endsWith(MODEL_FILE_EXTENSION)) return 'model';
  return null;
}
