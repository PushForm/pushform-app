// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutLinearDimension, LayoutAngularDimension, LayoutDimensionAnchor } from './LayoutDocument';

export function reconcileNativeLayoutAnchorFields(anchor: LayoutDimensionAnchor, apply = false): boolean {
  const extra = anchor.nativeUnknownFields, changed = !Object.hasOwn(anchor, 't') && !!extra?.extensions?.has('t');
  if (apply && extra) {
    if (changed) extra.extensions!.delete('t');
    if (extra.extensions && !extra.extensions.size) delete extra.extensions;
    if (!extra.extensions && !extra.wrapper?.length && !extra.envelope?.length && !extra.outerEnvelope?.length) delete anchor.nativeUnknownFields;
  }
  return changed;
}

/** Null wrappers belong to fixed measurement slots; defined anchors carry their own fields. */
export function reconcileNativeLayoutDimensionFields(value: LayoutLinearDimension | LayoutAngularDimension, apply = false): boolean {
  let changed = false;
  const remove = (fields: Map<string, Uint8Array[]> | undefined, key: string, obsolete: boolean) => {
    if (obsolete && fields?.has(key)) { changed = true; if (apply) fields.delete(key); }
  };
  const anchors = (values: readonly (LayoutDimensionAnchor | null)[], fields: Map<string, Uint8Array[]> | undefined) => {
    for (const [i, anchor] of values.entries()) {
      remove(fields, `anchors/${i}`, anchor !== null);
      if (anchor && reconcileNativeLayoutAnchorFields(anchor, apply)) changed = true;
    }
  };
  const extra = value.nativeUnknownFields;
  for (const key of ['angleDeg', 'scale', 'edgeAnchors', 'rayDefinition']) remove(extra?.extensions, key, !Object.hasOwn(value, key));
  anchors(value.anchors, extra?.extensions);
  if ('cachedAngleDeg' in value && value.rayDefinition) {
    anchors(value.rayDefinition.anchors, value.rayDefinition.nativeUnknownFields);
    if (apply && value.rayDefinition.nativeUnknownFields && !value.rayDefinition.nativeUnknownFields.size) delete value.rayDefinition.nativeUnknownFields;
  }
  if (apply && extra) {
    if (extra.extensions && !extra.extensions.size) delete extra.extensions;
    if (!extra.extensions && !extra.envelope?.length && !extra.outerEnvelope?.length && !extra.wrapper?.length) delete value.nativeUnknownFields;
  }
  return changed;
}
