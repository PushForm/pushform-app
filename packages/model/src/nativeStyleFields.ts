// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { StyleId } from '@pushform/core';
import type { DocumentState } from './entities/document';

export function reconcileNativeStyleFields(state: DocumentState): void {
  const fields = state.nativeStyleUnknownFields;
  if (!fields) return;
  for (const [id, extra] of fields) {
    const style = state.styles.get(id as StyleId);
    if (!style) { fields.delete(id); continue; }
    for (const [owner, key, path] of [
      [style.faces, 'transparencyQuality', 'faces.transparencyQuality'],
      [style.modeling, 'colorByTag', 'modeling.colorByTag'],
    ] as const) {
      if (!Object.hasOwn(owner, key)) extra.extensions?.delete(path);
      if (!Object.hasOwn(owner, key) || (owner as unknown as Record<string, unknown>)[key] !== undefined) extra.extensions?.delete(`${path}.undefined`);
    }
    if (extra.extensions && !extra.extensions.size) delete extra.extensions;
    if (extra.required !== false && !extra.envelopeUnknown?.length && !extra.extensions) fields.delete(id);
  }
  if (!fields.size) delete state.nativeStyleUnknownFields;
}
