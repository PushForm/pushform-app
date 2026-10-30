// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DocumentState } from './entities/document';

/** Drop unknown fields whose optional record was deleted, within the owning transaction.
 * Ordinary known-field edits preserve unknown bytes. Undo restores removed records and sidecars together. */
export function reconcileNativeSettingsFields(state: DocumentState): void {
  const ext = state.nativeSettingsUnknownFields;
  if (!ext) return;
  if (!Object.hasOwn(state, 'fog')) ext.records.delete('fog');
  if (!Object.hasOwn(state, 'fog') || state.fog !== undefined) ext.records.delete('fog.undefined');
  if (state.fog === undefined) delete ext.fog;
  if (!Object.hasOwn(state.meta, 'dimensions')) ext.meta.delete('dimensions');
  if (!Object.hasOwn(state.meta, 'dimensions') || state.meta.dimensions !== undefined) ext.meta.delete('dimensions.undefined');
  if (state.meta.dimensions === undefined) ext.meta.delete('dimensions.value');
  for (const key of ['lengthSnap', 'angleSnap'] as const) {
    if (state.meta.units[key] !== null) ext.meta.delete(`units.${key}.null`);
  }
  if (!ext.records.size && !ext.meta.size && !ext.shadows.size && !ext.fog?.size) delete state.nativeSettingsUnknownFields;
}
