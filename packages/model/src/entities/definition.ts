// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Box3, DefId, Guid, Id, Mat4, MaterialId, Plane } from '@pushform/core';
import type { Axes, CommonAttrs } from './common';
import type { NativeCatalogUnknownFields } from './document';
import type { Body } from './body';
import type { Sketch } from './sketch';
import { createSketch } from './sketch';
import type { Dimension, Guide, ImageEntity, SectionPlane, TextEntity } from './misc';

export interface ComponentBehaviors {
  /** Glue to faces: none, any, horizontal, vertical, sloped. */
  glueTo: 'none' | 'any' | 'horizontal' | 'vertical' | 'sloped';
  cutsOpening: boolean;
  alwaysFaceCamera: boolean;
  shadowsFaceSun: boolean;
}

/** Component definition; groups are definitions with `isGroup` and a single instance. */
export interface ComponentDefinition {
  /** Opaque definition record fields; no file-local geometry/order references. */
  nativeUnknownFields?: NativeCatalogUnknownFields;
  id: DefId;
  guid: Guid;
  name: string;
  description: string;
  isGroup: boolean;
  axes: Axes;
  behaviors: ComponentBehaviors;
  entities: EntityContainer;
  /** Cached local bounds, or null when dirty/empty. */
  bounds: Box3 | null;
}

/** All entities of a definition. `order` lists entity ids in creation order (stable iteration). */
export interface EntityContainer {
  bodies: Map<Id, Body>;
  sketch: Sketch;
  instances: Map<Id, ComponentInstance>;
  guides: Map<Id, Guide>;
  images: Map<Id, ImageEntity>;
  sectionPlanes: Map<Id, SectionPlane>;
  texts: Map<Id, TextEntity>;
  dimensions: Map<Id, Dimension>;
  activeSectionPlaneId: Id | null;
  order: Id[];
}

export interface ComponentInstance extends CommonAttrs {
  nativeUnknownFields?: NativeCatalogUnknownFields;
  id: Id;
  definitionId: DefId;
  /** Local-to-parent transform (column-major). */
  transform: Mat4;
  name: string;
  /** Instance material inherited by default-material faces of the definition. */
  materialId: MaterialId | null;
  /**
   * Plane of the face the placement is glued to, in the parent container's coordinates; absent = unglued.
   * Move keeps a glued placement in this plane.
   */
  gluedPlane?: Plane | undefined;
}

export function createEntityContainer(): EntityContainer {
  return {
    bodies: new Map(),
    sketch: createSketch(),
    instances: new Map(),
    guides: new Map(),
    images: new Map(),
    sectionPlanes: new Map(),
    texts: new Map(),
    dimensions: new Map(),
    activeSectionPlaneId: null,
    order: [],
  };
}

export const DEFAULT_BEHAVIORS: ComponentBehaviors = {
  glueTo: 'none',
  cutsOpening: false,
  alwaysFaceCamera: false,
  shadowsFaceSun: false,
};

export const DEFAULT_AXES: Axes = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
