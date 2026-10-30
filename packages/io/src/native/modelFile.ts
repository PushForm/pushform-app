// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DocumentState } from '@pushform/model';
import type { ModelImageSource, DecodedModelFile } from '../modelFile';
import { writeNativeModel } from './modelWriter';
import { readNativeModel } from './modelReader';
import { nativeModelState } from './modelState';
import type { NativeFileSource } from './container';

/** Buffered boundary for APIs requiring a single upload buffer. The streaming writer is used underneath. */
export async function encodeNativeModelFile(state: DocumentState, images?: ModelImageSource | null): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const result = await writeNativeModel(state, { write: async bytes => { parts.push(bytes.slice()); } }, { imageBlob: id => images?.get(id) });
  const bytes = new Uint8Array(result.storedBytes); let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return bytes;
}
export function isNativeModelFile(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && [80, 85, 83, 72, 70, 82, 77, 50].every((value, i) => bytes[i] === value);
}
/** Validation completes before any editable state is returned to the caller. */
export async function decodeNativeModelFile(source: NativeFileSource): Promise<DecodedModelFile> {
  const model = await readNativeModel(source);
  return { state: nativeModelState(model), images: model.imageBlobs };
}
