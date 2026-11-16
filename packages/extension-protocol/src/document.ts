// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { modelRefSchema } from './model.ts';

/**
 * What extensions learn about the document they act on, beyond the model operations: its name and the units PushForm
 * shows its quantities in, the selection as model references, and the events that tell a running extension about
 * changes. A call names its document with the `document` handle of an invocation; without one it acts on the document
 * of the extension's latest invocation that acts on one.
 */

export const DOCUMENT_LENGTH_UNITS = ['mm', 'cm', 'm', 'in', 'ft'] as const;
export const DOCUMENT_LENGTH_FORMATS = ['decimal', 'architectural', 'fractional', 'engineering'] as const;

/**
 * The units PushForm formats a document's lengths in. Every number in the API stays meters; these say how to show
 * them. `lengthPrecision` counts decimals for decimal and engineering formats, and is the power of two of the smallest
 * fraction (3 for 1/8) for architectural and fractional ones.
 */
export interface DocumentUnits {
  system: 'metric' | 'imperial';
  lengthUnit: (typeof DOCUMENT_LENGTH_UNITS)[number];
  format: (typeof DOCUMENT_LENGTH_FORMATS)[number];
  lengthPrecision: number;
}

/** What `document.info` answers: the document as the user sees it. */
export interface DocumentInfo {
  /** The document's name as its tab shows it: the file name without its extension, or an untitled name. */
  name: string;
  units: DocumentUnits;
}

/** Bounds on the document services' inputs. */
export const DOCUMENT_SERVICE_LIMITS = { refsPerSelection: 1000 } as const;

/** A host-issued document handle, as an invocation receives it. */
export const documentHandleSchema = z.string().min(1).max(100);

/** Input of calls that need nothing but the document: `model.read`, `model.subscribe`, `selection.get`, `document.units`, `document.info`. */
export const documentTargetSchema = z.strictObject({ document: documentHandleSchema.optional() });

/**
 * `selection.set` replaces the selection (an empty list clears it); `selection.frame` frames the camera on refs. A
 * ref with a `path` names an entity inside a group or component; it is selected or framed in place, without opening
 * its container.
 */
export const selectionSetSchema = z.strictObject({
  document: documentHandleSchema.optional(),
  refs: z.array(modelRefSchema).max(DOCUMENT_SERVICE_LIMITS.refsPerSelection),
});
export const selectionFrameSchema = z.strictObject({
  document: documentHandleSchema.optional(),
  refs: z.array(modelRefSchema).min(1).max(DOCUMENT_SERVICE_LIMITS.refsPerSelection),
});

/** What the host sends on `HOST_EVENT_TARGET`: the component names the service, the event what happened. */
export const HOST_EVENTS = {
  /** The units of a document changed, or the extension started acting on another document. */
  units: { component: 'document', event: 'units' },
  /** The name or units of a document changed, or the extension started acting on another document. */
  documentInfo: { component: 'document', event: 'change' },
  /** A document the extension subscribed to with `model.subscribe` changed. */
  modelChange: { component: 'model', event: 'change' },
} as const;

export interface DocumentUnitsEvent {
  /** The handle of the document whose units these are. */
  document: string;
  units: DocumentUnits;
}

/** The document's name or units now, after either changed or the extension started acting on another document. */
export interface DocumentInfoEvent extends DocumentInfo {
  /** The handle of the document this describes. */
  document: string;
}

export interface ModelChangeEvent {
  /** The handle of the document that changed. */
  document: string;
  /** Its revision now. */
  revision: number;
  /** What changed: the model itself, or the selection (only with `selection.read`). */
  changes: ('model' | 'selection')[];
}
