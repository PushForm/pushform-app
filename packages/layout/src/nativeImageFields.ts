// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutImage } from './LayoutDocument';

export function reconcileNativeImageFields(image: LayoutImage, apply = false): boolean {
  let changed = false;
  const remove = (fields: Map<string, Uint8Array[]> | undefined, key: string, obsolete: boolean) => {
    if (obsolete && fields?.has(key)) { changed = true; if (apply) fields.delete(key); }
  };
  const extra = image.nativeUnknownFields;
  for (const key of ['clip', 'viewport']) remove(extra?.extensions, key, !Object.hasOwn(image, key));
  if (image.clip) {
    remove(image.clip.nativeUnknownFields, 'handleFlags', !Object.hasOwn(image.clip, 'handles'));
    remove(image.clip.nativeUnknownFields, 'handleValues', image.clip.handles === undefined);
    if (apply && image.clip.nativeUnknownFields && !image.clip.nativeUnknownFields.size) delete image.clip.nativeUnknownFields;
  }
  const view = image.viewport;
  if (view) {
    remove(view.nativeUnknownFields, 'display', !Object.hasOwn(view, 'display'));
    if (view.cache) {
      remove(view.cache.nativeUnknownFields, 'sha256', !Object.hasOwn(view.cache, 'sha256'));
      if (apply && view.cache.nativeUnknownFields && !view.cache.nativeUnknownFields.size) delete view.cache.nativeUnknownFields;
    }
    if (view.display) {
      remove(view.display.nativeUnknownFields, 'shadows', !Object.hasOwn(view.display, 'shadows'));
      if (apply && view.display.nativeUnknownFields && !view.display.nativeUnknownFields.size) delete view.display.nativeUnknownFields;
    }
    if (apply && view.nativeUnknownFields && !view.nativeUnknownFields.size) delete view.nativeUnknownFields;
  }
  if (apply && extra) {
    if (extra.extensions && !extra.extensions.size) delete extra.extensions;
    if (!extra.extensions && !extra.envelope?.length && !extra.outerEnvelope?.length) delete image.nativeUnknownFields;
  }
  return changed;
}
