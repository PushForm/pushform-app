// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CurveId, FaceLocalId, Id, ImageId, Mat4, Plane, Vec3 } from '@pushform/core';
import type { NativeCatalogUnknownFields } from './document';
import type { CommonAttrs } from './common';

/** Unknown placement fields travel with their editable owner, including copies and undo. */
export interface NativePlacementAttrs extends CommonAttrs {
  nativeUnknownFields?: { required?: boolean; envelopeUnknown?: Uint8Array[]; unknownFields: Uint8Array[] };
}

/** Inference-only construction geometry (Tape Measure / Protractor output). */
export type Guide =
  | (NativePlacementAttrs & { id: Id; kind: 'point'; origin: Vec3 })
  | (NativePlacementAttrs & { id: Id; kind: 'line'; origin: Vec3; dir: Vec3 })
  /** Finite guide line from `origin` to `end` (Tape Measure dragged from an edge endpoint). */
  | (NativePlacementAttrs & { id: Id; kind: 'segment'; origin: Vec3; end: Vec3 });

/** A placed image: a textured quad of widthM × heightM in its local xy plane. */
export interface ImageEntity extends NativePlacementAttrs {
  id: Id;
  imageId: ImageId;
  transform: Mat4;
  widthM: number;
  heightM: number;
}

export interface SectionPlane extends NativePlacementAttrs {
  id: Id;
  name: string;
  /** Short label drawn in the plane corner symbols. */
  symbol: string;
  plane: Plane;
  /** Anchor point used to draw the plane rectangle. */
  origin: Vec3;
}

export type TextLeader = 'none' | 'view' | 'pushpin';
export interface TextEntity extends NativePlacementAttrs {
  id: Id;
  text: string;
  /** Screen text has a normalized screen position; leader text anchors to a world point. */
  kind: 'screen' | 'leader';
  /** World anchor (leader) or normalized screen position [x, y, 0] (screen). */
  position: Vec3;
  /** Text box offset from the anchor in world units (pushpin leader) or null. */
  offset: Vec3 | null;
  leader: TextLeader;
  /**
   * A view-based leader's text box offset along the view's right and up directions, in meters, whether or not the
   * leader line is drawn: the box keeps that place on screen as the view turns.
   */
  viewOffset?: readonly [number, number] | undefined;
  fontFamily: string;
  fontSizePt: number;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
  /** 0–1 RGB. */
  color: readonly [number, number, number];
  /** The leader's arrow; absent is the default closed arrow. */
  arrow?: 'none' | 'slash' | 'dot' | 'closed' | 'open' | undefined;
}

export type DimensionKind = 'linear' | 'radial' | 'diametric';

/**
 * What a measured point is attached to, in the dimension's container; `path` is the chain of instances below
 * that container. A sketch vertex keeps its id; a body vertex has none, so it is the point its faces share (face ids
 * survive Push/Pull, booleans and moves).
 */
export type DimensionAnchor =
  | { nativeUnknownFields?: Uint8Array[]; kind: 'sketchVertex'; path: readonly Id[]; id: Id }
  | { nativeUnknownFields?: Uint8Array[]; kind: 'bodyVertex'; path: readonly Id[]; bodyId: Id; faceIds: readonly FaceLocalId[] };

/** The arc or circle a radial or diameter dimension measures: a body's curve, or the sketch's when `bodyId` is null. */
export interface DimensionCurveAnchor {
  nativeUnknownFields?: Uint8Array[];
  path: readonly Id[];
  bodyId: Id | null;
  curveId: CurveId;
}

/** A dimension's endpoints: arrow types. */
export type DimensionArrow = 'none' | 'slash' | 'dot' | 'closed' | 'open';
/** Where a dimension's text sits: facing the screen, or along the dimension line above it, on it or outside it. */
export type DimensionAlign = 'screen' | 'above' | 'centered' | 'outside';

/** Text size, endpoints and text alignment of a dimension, and the model's settings for new ones. */
export interface DimensionStyle {
  fontSizePt: number;
  arrow: DimensionArrow;
  align: DimensionAlign;
}

export interface Dimension extends CommonAttrs {
  nativeUnknownFields?: NativeCatalogUnknownFields;
  id: Id;
  kind: DimensionKind;
  /** Linear: the measured points. Radial: the arc's center and the point on the arc the leader starts from. Diameter: two opposite points on the circle. */
  start: Vec3;
  end: Vec3;
  /** Offset of the dimension line from the measured segment (world units along its plane normal direction); for radial and diameter dimensions, the leader's run beyond the arc. */
  offset: Vec3;
  /** Plane normal the dimension lies in. */
  normal: Vec3;
  /** Override text, or null for the formatted measurement. */
  text: string | null;
  fontSizePt: number;
  /** Attachments of `start` and `end`; absent or null ends stay where they are. */
  anchors?: readonly [DimensionAnchor | null, DimensionAnchor | null] | undefined;
  /** The measured arc or circle of a radial or diameter dimension. */
  curve?: DimensionCurveAnchor | undefined;
  /** Endpoints; absent = closed arrows. */
  arrow?: DimensionArrow | undefined;
  /** Text alignment; absent = facing the screen. Only linear dimensions align their text to the line. */
  align?: DimensionAlign | undefined;
}
