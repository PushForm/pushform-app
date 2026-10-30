// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { LAYOUT_FILE_EXTENSION, MODEL_FILE_EXTENSION } from '@pushform/io';
import type { DocumentTab } from './session';

/** Keep the native extension in the file identity, but omit it from workspace chrome. */
export function displayDocumentName(tab: Pick<DocumentTab, 'name' | 'type'>): string {
  const extension = tab.type === 'model' ? MODEL_FILE_EXTENSION : LAYOUT_FILE_EXTENSION;
  return tab.name.toLowerCase().endsWith(extension)
    ? tab.name.slice(0, -extension.length)
    : tab.name;
}
