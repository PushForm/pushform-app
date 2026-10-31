// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { DefId, FaceLocalId, Id, TagId, Vec3 } from '@pushform/core';
import type { EdgeKey } from './body';

/** JSON-compatible attribute values. */
export type AttrValue = string | number | boolean | null | AttrValue[] | { [k: string]: AttrValue };
export type AttributeDictionaries = Record<string, Record<string, AttrValue>>;

/** Attributes shared by every entity in an EntityContainer. */
export interface CommonAttrs {
  /** Shared immutable native property metadata; independent of entity-specific fields. */
  nativePropertyUnknownFields?: {
    required?: boolean;
    envelopeUnknown?: Uint8Array[];
    unknownFields?: Uint8Array[];
    fields?: Uint8Array[];
    /** Unknown attribute fields keyed by exact named codec scope; no duplicate known values. */
    attributes?: Map<string, Uint8Array[]>;
  };
  tagId: TagId;
  hidden: boolean;
  locked: boolean;
  castShadows: boolean;
  receiveShadows: boolean;
  attributes: AttributeDictionaries;
}

/** Local coordinate axes of a definition or the model (origin + unit x/y/z). */
export interface Axes {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

/**
 * Runtime reference to an entity. `path` is the chain of ComponentInstance ids from the root
 * definition down to the container that owns the entity (empty = root container).
 */
export type EntityRef =
  | { kind: 'instance'; path: readonly Id[]; id: Id }
  | { kind: 'body'; path: readonly Id[]; id: Id }
  /** A whole mesh part (MOD3830); it has no face or edge references until made editable. */
  | { kind: 'meshPart'; path: readonly Id[]; id: Id }
  /** A body face, optionally narrowed to one region of it (index into `computeRegions`). */
  | { kind: 'face'; path: readonly Id[]; id: Id; faceId: FaceLocalId; region: number | null }
  | { kind: 'edge'; path: readonly Id[]; id: Id; edgeKey: EdgeKey }
  | { kind: 'imprintEdge'; path: readonly Id[]; id: Id; faceId: FaceLocalId; edgeId: number }
  | { kind: 'sketchVertex'; path: readonly Id[]; id: Id }
  | { kind: 'sketchEdge'; path: readonly Id[]; id: Id }
  | { kind: 'sketchFace'; path: readonly Id[]; id: Id }
  | { kind: 'guide'; path: readonly Id[]; id: Id }
  | { kind: 'image'; path: readonly Id[]; id: Id }
  | { kind: 'sectionPlane'; path: readonly Id[]; id: Id }
  | { kind: 'text'; path: readonly Id[]; id: Id }
  | { kind: 'dimension'; path: readonly Id[]; id: Id };

export type EntityKind = EntityRef['kind'];

/** Stable string key for an EntityRef (used by Selection and undo snapshots). */
export function entityRefKey(ref: EntityRef): string {
  const base = `${ref.kind}/${ref.path.join('.')}/${ref.id}`;
  switch (ref.kind) {
    case 'face':
      return ref.region === null ? `${base}#${ref.faceId}` : `${base}#${ref.faceId}@${ref.region}`;
    case 'edge':
      return `${base}#${ref.edgeKey}`;
    case 'imprintEdge':
      return `${base}#${ref.faceId}:${ref.edgeId}`;
    default:
      return base;
  }
}

/** Where editing happens: the instance path opened with "Edit Group/Component" and its definition. */
export interface EditContext {
  /** Instance ids from the root; empty = editing the root definition. */
  path: readonly Id[];
  definitionId: DefId;
}
