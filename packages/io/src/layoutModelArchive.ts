// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutDocumentState } from '@pushform/layout';
import { readNativeArchive } from './nativeArchive';

/** Recover the original imported package, including unknown settings and connection records. */
export function readOriginalLayoutArchive(state: LayoutDocumentState, archiveId: string): Uint8Array {
  const archive = state.modelArchives?.get(archiveId);
  if (!archive) throw new Error('Unknown preserved LayOut archive');
  const binary = atob(archive.archiveBase64);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Read only the embedded source. External reference paths are metadata and are never fetched. */
export function readPreservedSketchUpModel(state: LayoutDocumentState, archiveId: string, referenceId: string): Uint8Array | null {
  const archive = state.modelArchives?.get(archiveId);
  if (!archive) throw new Error('Unknown preserved LayOut archive');
  const source = archive.models.get(referenceId);
  if (!source) throw new Error('Unknown preserved SketchUp model reference');
  if (!source.internalTarget) return null;
  const files = readNativeArchive(readOriginalLayoutArchive(state, archiveId), {
    extension: '.layout', supported: name => name === source.internalTarget,
  });
  return files[source.internalTarget] ?? null;
}
