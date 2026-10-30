// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Vec2, Vec3 } from '@pushform/core';

export type PointGlyphShape = 'square' | 'circle' | 'diamond' | 'cross' | 'x';

/** Screen-space-sized point glyph at a world position (inference points, endpoints, grips). */
export interface OverlayPoint {
  readonly kind: 'point';
  readonly position: Vec3;
  readonly color: string;
  readonly shape: PointGlyphShape;
  /** Diameter in CSS px. */
  readonly size?: number | undefined;
}

export interface OverlayPolyline {
  readonly kind: 'polyline';
  readonly points: readonly Vec3[];
  readonly color: string;
  readonly dashed?: boolean | undefined;
  /** Width in CSS px. */
  readonly width?: number | undefined;
  readonly closed?: boolean | undefined;
}

export interface OverlayPolygon {
  readonly kind: 'polygon';
  /** Outer boundary of a planar polygon; it may be concave. */
  readonly points: readonly Vec3[];
  /** Holes in the same plane, left unfilled. */
  readonly holes?: readonly (readonly Vec3[])[] | undefined;
  readonly color: string;
  readonly opacity?: number | undefined;
}

export interface OverlayLabel {
  readonly kind: 'label';
  readonly position: Vec3;
  readonly text: string;
  readonly color?: string | undefined;
  /** Screen offset in CSS px. */
  readonly offset?: Vec2 | undefined;
}

/** Tooltip next to the cursor (inference tips like "On Face"). */
export interface OverlayCursorHint {
  readonly kind: 'cursorHint';
  readonly text: string;
  readonly screen?: Vec2 | undefined;
}

/** Screen-space rectangle in CSS px (zoom window, selection box). */
export interface OverlayScreenRect {
  readonly kind: 'screenRect';
  readonly a: Vec2;
  readonly b: Vec2;
  readonly color: string;
  readonly dashed?: boolean | undefined;
}

/** Screen-space polyline in CSS px (lasso outline). */
export interface OverlayScreenPolyline {
  readonly kind: 'screenPolyline';
  readonly points: readonly Vec2[];
  readonly color: string;
  readonly dashed?: boolean | undefined;
  readonly closed?: boolean | undefined;
}

/** World-space circle (protractor): optional radial tick marks (`ticks` per full turn, every 4th major). */
export interface OverlayCircle {
  readonly kind: 'circle';
  readonly center: Vec3;
  readonly normal: Vec3;
  readonly radius: number;
  readonly color: string;
  readonly dashed?: boolean | undefined;
  readonly ticks?: number | undefined;
  /** Width in CSS px. */
  readonly width?: number | undefined;
}

/** Axis-aligned world box drawn as 12 edges (scale bounding box). */
export interface OverlayBox {
  readonly kind: 'box';
  readonly min: Vec3;
  readonly max: Vec3;
  readonly color: string;
  readonly dashed?: boolean | undefined;
  /** Width in CSS px. */
  readonly width?: number | undefined;
}

export type OverlayPrimitive =
  | OverlayPoint
  | OverlayPolyline
  | OverlayPolygon
  | OverlayLabel
  | OverlayCursorHint
  | OverlayScreenRect
  | OverlayScreenPolyline
  | OverlayCircle
  | OverlayBox;
