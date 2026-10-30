// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutText } from './LayoutDocument';

/** Probe immutable state, or prune on the transaction draft after a positive probe. */
export function reconcileNativeTextFields(text: LayoutText, apply = false): boolean {
  let changed = false;
  const remove = (fields: Map<string, Uint8Array[]> | undefined, key: string, obsolete: boolean): void => {
    if (!obsolete || !fields?.has(key)) return;
    changed = true; if (apply) fields.delete(key);
  };
  const extra = text.nativeUnknownFields;
  for (const key of ['spans', 'lineSpacing', 'tabStopsPt', 'rotationDeg', 'leaderOffsetMm']) remove(extra?.extensions, key, !Object.hasOwn(text, key));
  for (const span of text.spans ?? []) {
    for (const key of ['fontFamily', 'fontSizePt', 'color']) remove(span.nativeUnknownFields, key, !Object.hasOwn(span, key));
    if (apply && span.nativeUnknownFields && !span.nativeUnknownFields.size) delete span.nativeUnknownFields;
  }
  if (apply && extra) {
    if (extra.extensions && !extra.extensions.size) delete extra.extensions;
    if (!extra.extensions && !extra.envelope?.length && !extra.outerEnvelope?.length) delete text.nativeUnknownFields;
  }
  return changed;
}
