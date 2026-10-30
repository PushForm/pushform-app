// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { TagId } from '@pushform/core';
import type { DocumentState } from './entities';

/**
 * False when the entity's tag, or a folder above it, is switched off in the Tags panel (unknown
 * tags count as visible).
 */
export function tagVisible(state: DocumentState, tagId: TagId): boolean {
  const tag = state.tags.get(tagId);
  if (!tag) return true;
  if (!tag.visible) return false;
  let folderId = tag.folderId;
  let guard = 0;
  while (folderId !== null && guard++ < 64) {
    const f = state.tagFolders.get(folderId);
    if (!f) break;
    if (!f.visible) return false;
    folderId = f.parentId;
  }
  return true;
}
