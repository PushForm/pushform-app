// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutDocumentState } from '@pushform/layout';
import type { NativeFileSource } from './container';
import { writeNativeLayout } from './layoutWriter';
import { readNativeLayout } from './layoutReader';
import { nativeLayoutState } from './layoutState';

/** Buffered boundary for uploads; the writer itself emits bounded chunks. */
export async function encodeNativeLayoutFile(state: LayoutDocumentState): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const result = await writeNativeLayout(state, { write: async bytes => { parts.push(bytes.slice()); } });
  const bytes = new Uint8Array(result.storedBytes);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

/** Install editable state only after complete container and document validation. */
export async function decodeNativeLayoutFile(source: NativeFileSource): Promise<LayoutDocumentState> {
  return nativeLayoutState(await readNativeLayout(source));
}
