// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { ImageId } from '@pushform/core';
import type { DocumentState } from './entities/document';

/** Image metadata belongs to its persistent asset, not any of its texture/placement references. */
export function reconcileNativeImageFields(state: DocumentState): void {
  const fields = state.nativeImageUnknownFields;
  if (!fields) return;
  for (const [id, extra] of fields) {
    if (!state.images.has(id as ImageId) || (extra.required !== false && !extra.envelopeUnknown?.length && !extra.unknownFields.length)) fields.delete(id);
  }
  if (!fields.size) delete state.nativeImageUnknownFields;
}
