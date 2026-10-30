// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { MaterialId } from '@pushform/core';
import type { DocumentState } from './entities/document';

/** Maintain ownership of unknown material/texture fields inside the authored transaction. */
export function reconcileNativeMaterialFields(state: DocumentState): void {
  const fields = state.nativeMaterialUnknownFields;
  if (!fields) return;
  for (const [id, extra] of fields) {
    const material = state.materials.get(id as MaterialId);
    if (!material) { fields.delete(id); continue; }
    const ext = extra.extensions;
    if (ext) {
      const texture = material.texture;
      if (texture === null) ext.delete('texture.value');
      else ext.delete('texture.null');
      if (texture === null || !Object.hasOwn(texture, 'colorizeType')) ext.delete('texture.colorizeType');
      if (texture === null || !Object.hasOwn(texture, 'colorizeType') || texture.colorizeType !== undefined) ext.delete('texture.colorizeType.undefined');
      if (!ext.size) delete extra.extensions;
    }
    if (extra.required !== false && !extra.envelopeUnknown?.length && !extra.extensions?.size) fields.delete(id);
  }
  if (!fields.size) delete state.nativeMaterialUnknownFields;
}
