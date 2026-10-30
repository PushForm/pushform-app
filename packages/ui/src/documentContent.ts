// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutDocument, LayoutDocumentState } from '@pushform/layout';
import type { Document, DocumentState } from '@pushform/model';
import { layoutJson, layoutContentIdentity, modelContentIdentity, modelSessionJson } from '@pushform/io';

/**
 * Current immutable revision's saved-state key: a semantic digest for Modeling and Layout.
 * Repeated subscriber notifications reuse one slot. Modeling's digest implementation also
 * weakly caches immutable definitions, without retaining serialized geometry or per-row digests.
 */
export const contentSerializations = { modelIdentity: 0, layoutIdentity: 0, modelSessionJson: 0, layoutJson: 0 };

export function resetContentSerializations(): void {
  contentSerializations.modelIdentity = 0;
  contentSerializations.layoutIdentity = 0;
  contentSerializations.modelSessionJson = 0;
  contentSerializations.layoutJson = 0;
}

type Serializer<S extends object> = (state: S) => string;

interface CachedContent<D> {
  (doc: D): string;
  /** Seed the slot with the key computed off the UI thread for this exact state. */
  prime(doc: D, text: string): void;
}

function cachedForDocument<D extends { readonly state: S }, S extends object>(
  serialize: Serializer<S>, counter: keyof typeof contentSerializations,
): CachedContent<D> {
  const slots = new WeakMap<D, { state: S; text: string }>();
  const get = (doc: D): string => {
    const state = doc.state;
    const slot = slots.get(doc);
    if (slot && slot.state === state) return slot.text;
    contentSerializations[counter]++;
    const text = serialize(state);
    slots.set(doc, { state, text });
    return text;
  };
  return Object.assign(get, { prime: (doc: D, text: string) => { slots.set(doc, { state: doc.state, text }); } });
}

/** Compact semantic identity; geometry is never expanded into JSON for dirty checks. */
export const modelContentKey: CachedContent<Document> = cachedForDocument<Document, DocumentState>(modelContentIdentity, 'modelIdentity');
/** `modelSessionJson` of the document's current state: the browser refresh snapshot content. */
export const modelSessionContentJson: CachedContent<Document> = cachedForDocument<Document, DocumentState>(modelSessionJson, 'modelSessionJson');
/** `layoutJson` of the document's current state: the legacy refresh content only. */
export const layoutContentJson: CachedContent<LayoutDocument> = cachedForDocument<LayoutDocument, LayoutDocumentState>(layoutJson, 'layoutJson');

/** Compact Layout saved-state identity, independent of the refresh serialization. */
export const layoutContentKey: CachedContent<LayoutDocument> = cachedForDocument<LayoutDocument, LayoutDocumentState>(layoutContentIdentity, 'layoutIdentity');
