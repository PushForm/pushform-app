// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, Plane, Ray, Vec2, Vec3 } from '@pushform/core';
import type { EntityRef } from '@pushform/model';

export type Axis = 'x' | 'y' | 'z';

/** What the cursor is over, independent of snapping. */
export interface PickHit {
  readonly ref: EntityRef;
  readonly point: Vec3;
  /** Distance along the ray. */
  readonly t: number;
  /** Face normal for face hits. */
  readonly normal?: Vec3 | undefined;
  /** Screen distance in CSS px for edge/vertex hits (0 for face hits). */
  readonly screenDist: number;
  /**
   * What the Select tool should select: the entity itself when it lives in the current edit
   * context, otherwise the instance one level below the context on the entity's path (as seen
   * from the context). Always set by the engine; optional only so hand-built hits stay valid
   * (undefined = `ref`).
   */
  readonly selectable?: EntityRef | undefined;
  /** True when `ref.path` equals the edit context and the context is not inside a locked instance. */
  readonly inContext?: boolean | undefined;
}

/** `hit.selectable`, defaulting to the entity itself for hits that do not carry it. */
export function hitSelectable(hit: PickHit): EntityRef {
  return hit.selectable ?? hit.ref;
}
/** `hit.inContext`, defaulting to true for hits that do not carry it. */
export function hitInContext(hit: PickHit): boolean {
  return hit.inContext ?? true;
}

export type SnapKind =
  | 'endpoint'
  | 'midpoint'
  | 'onEdge'
  | 'intersection'
  | 'center'
  | 'onFace'
  | 'onPlane'
  | 'origin'
  | 'guide'
  | 'onAxis'
  | 'fromPoint'
  | 'perpendicular'
  | 'parallel'
  | 'tangent'
  /** Dashed extension of a referenced edge beyond its ends ("On Line"). */
  | 'extension'
  | 'free';

export interface Snap {
  readonly kind: SnapKind;
  readonly point: Vec3;
  readonly ref?: EntityRef | undefined;
  /** Direction for linear snaps (axis, parallel, perpendicular, fromPoint). */
  readonly dir?: Vec3 | undefined;
  /** Plane for onFace/onPlane snaps. */
  readonly plane?: Plane | undefined;
  readonly axis?: Axis | undefined;
  /** CSS color used for the glyph / inference line. */
  readonly color: string;
  /** Tooltip label, e.g. "Endpoint", "On Red Axis". */
  readonly label: string;
  /**
   * The snapped entity lives in another group/component than the edit context (magenta
   * glyph, label suffixed "in Group" / "in Component").
   */
  readonly inOtherContext?: boolean | undefined;
}

export interface InferenceLine {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly color: string;
  readonly dashed: boolean;
}

export interface InferenceResult {
  /** The resolved cursor point (after all snaps and locks). */
  readonly point: Vec3;
  readonly primary: Snap;
  readonly secondary: readonly Snap[];
  readonly lines: readonly InferenceLine[];
  readonly lockedAxis: Axis | null;
  /** Combined tooltip, e.g. "Endpoint" or "From Point · On Blue Axis". */
  readonly tooltip: string;
  /** Raw entity under the cursor (face/edge/vertex) regardless of snapping; null over empty space. */
  readonly hit: PickHit | null;
  /** The plane the free point was projected onto when nothing was hit. */
  readonly plane: Plane;
}

/** Inference modes the Line tool's Alt key cycles through. */
export type InferenceMode = 'all' | 'none' | 'directional';

/** What the active tool wants from inference for the current pointer event. */
export interface InferenceOptions {
  /** Start point of the current operation (enables axis / from-point / perpendicular lines). */
  readonly anchor?: Vec3 | undefined;
  /** Plane to project free points onto (default: ground, or the anchor's face plane). */
  readonly plane?: Plane | undefined;
  /** Hard axis lock (arrow keys). */
  readonly lockAxis?: Axis | null | undefined;
  /** Shift lock: freeze this snap's constraint (line or plane). */
  readonly lockSnap?: Snap | null | undefined;
  /** Restrict picking to these entity kinds (default: all). */
  readonly kinds?: readonly EntityRef['kind'][] | undefined;
  /** Ignore these entities (e.g. the geometry being dragged). */
  readonly ignore?: readonly EntityRef[] | undefined;
  /** When true, only pick, do not snap (Select / Eraser tools). */
  readonly pickOnly?: boolean | undefined;
  /**
   * Which inferences to offer (the Line tool's Alt modes): all of them (default); none, so points land on the
   * face under the cursor or the free plane; or only Parallel / Perpendicular to Edge through the anchor. Locks still apply.
   */
  readonly snapping?: InferenceMode | undefined;
  /**
   * The open edit context (instance path; default: the engine's context, root unless set).
   * Entities inside it pick as themselves; entities in other groups/components stay inference
   * targets but resolve to the containing instance for selection (`PickHit.selectable`).
   */
  readonly context?: readonly Id[] | undefined;
}

export interface InferenceInput {
  readonly ray: Ray;
  readonly screen: Vec2;
  /** Screen px → world radius conversion at depth t (provided by the camera). */
  readonly pixelSizeAt: (t: number) => number;
  /** World → screen (CSS px) projection; required by `PickService.pickBox`, optional elsewhere. */
  readonly project?: ((p: Vec3) => Vec2) | undefined;
  /** The view's right and up directions (world) and its size in CSS px, for picking texts. */
  readonly view?: { readonly right: Vec3; readonly up: Vec3; readonly width: number; readonly height: number } | undefined;
}

/** Screen-space rectangle in CSS px (normalized so that min <= max). */
export interface PickRect {
  readonly min: Vec2;
  readonly max: Vec2;
}
/** Window selection keeps entities fully inside the rect; crossing keeps any entity touching it. */
export type PickBoxMode = 'window' | 'crossing';

/** Snap indicator colors. */
export const SNAP_COLORS = {
  endpoint: '#1dbf3b',
  midpoint: '#2ec7d1',
  onEdge: '#e53935',
  intersection: '#222222',
  center: '#1dbf3b',
  onFace: '#2d5bd1',
  onPlane: '#2d5bd1',
  origin: '#222222',
  guide: '#8e24aa',
  axisX: '#d32f2f',
  axisY: '#2e7d32',
  axisZ: '#1565c0',
  parallel: '#d81bd8',
  perpendicular: '#d81bd8',
  tangent: '#2ec7d1',
  extension: '#e53935',
  fromPoint: '#555555',
  free: '#222222',
  /** Snaps to entities inside another group/component ("Endpoint in Group"). */
  otherContext: '#d81bd8',
} as const;

/**
 * The edge the user rested on (hover > delay) or that a tool set explicitly: reference for
 * "Parallel to Edge", "Perpendicular to Edge" and the dashed "On Line" extension.
 */
export interface ReferenceEdge {
  readonly ref: EntityRef;
  /** Full extent of the edge (first/last polyline point for body edges). */
  readonly a: Vec3;
  readonly b: Vec3;
  /** Unit direction a → b. */
  readonly dir: Vec3;
}

/** Snap for a Shift+Alt drawing-plane lock (pass as `InferenceOptions.lockSnap`). */
export function planeLockSnap(plane: Plane, point: Vec3, ref?: EntityRef, label = 'On Plane'): Snap {
  return { kind: 'onPlane', point, plane, ref, color: SNAP_COLORS.onPlane, label };
}

/** A minimal result for a free point (no engine available, or empty space). */
export function freeInference(point: Vec3, plane: Plane, hit: PickHit | null = null): InferenceResult {
  const primary: Snap = { kind: 'free', point, color: SNAP_COLORS.free, label: '' };
  return { point, primary, secondary: [], lines: [], lockedAxis: null, tooltip: '', hit, plane };
}
export const GROUND_PLANE: Plane = { n: [0, 0, 1], d: 0 };
