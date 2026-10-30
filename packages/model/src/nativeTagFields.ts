// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { TagId, TagFolderId } from '@pushform/core';
import type { DocumentState, NativeCatalogUnknownFields } from './entities/document';

function empty(value: NativeCatalogUnknownFields): boolean {
  if (value.extensions && !value.extensions.size) delete value.extensions;
  return value.required !== false && !value.envelopeUnknown?.length && !value.extensions?.size;
}

/** Reconcile only sidecar-bearing owners, never scan the whole tag catalog on every edit. */
export function reconcileNativeTagFields(state: DocumentState): void {
  const fields = state.nativeTagUnknownFields;
  if (!fields) return;
  for (const [id, extra] of fields.tags) {
    const tag = state.tags.get(id as TagId);
    if (!tag) { fields.tags.delete(id); continue; }
    if (tag.folderId !== null) extra.extensions?.delete('folderId.null');
    if (tag.dashes !== null) extra.extensions?.delete('dashes.null');
    if (empty(extra)) fields.tags.delete(id);
  }
  for (const [id, extra] of fields.folders) {
    const folder = state.tagFolders.get(id as TagFolderId);
    if (!folder) { fields.folders.delete(id); continue; }
    if (folder.parentId !== null) extra.extensions?.delete('parentId.null');
    if (empty(extra)) fields.folders.delete(id);
  }
  if (!fields.tags.size && !fields.folders.size) delete state.nativeTagUnknownFields;
}
