// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** All tolerances are in meters (model units) or radians. Centralized so every package agrees. */
export const LENGTH_TOL = 1e-6; // exact-compare for positions
export const MERGE_TOL = 2.54e-5; // 0.001" vertex-merge tolerance
export const COPLANAR_TOL = 1e-5; // point-to-plane distance for coplanarity
export const ANGLE_TOL = 1e-6; // radians, for parallel/perpendicular tests
export const AREA_TOL = 1e-10; // m², degenerate faces below this are dropped
/** Fraction of a display step added before rounding, so conversion noise keeps exact halves rounding up. */
export const ROUNDING_TIE_TOL = 1e-9;
/** Relative difference allowed between a face's boundary area and the area of its triangulation. */
export const TRIANGULATION_AREA_TOL = 1e-6;
/**
 * Horizontal length of a unit plane normal under which a plane is treated as facing straight
 * up or down when texture coordinates are laid out (matches imported .skp texture placement).
 */
export const SKETCHUP_VERTICAL_TEXTURE_TOL = 1e-3;
/** Radians between two imported vertex normals (stored with single-precision text) that still count as one normal. */
export const VERTEX_NORMAL_TOL = 1e-3;
/** Texture coordinates, in texture tiles, under which two imported placements of one point agree. */
export const TEXCOORD_TOL = 1e-3;
/** Relative difference under which two stored ratios (such as drawing scales) are the same. */
export const RATIO_TOL = 1e-6;
/** Relative difference under which dash lengths, stored in .layout files as single-precision scales, match a stroke pattern. */
export const DASH_PATTERN_TOL = 1e-3;
/** Radians a face normal may lean and still count as vertical or horizontal when a component's Glue To picks faces. */
export const GLUE_ORIENTATION_TOL = (0.5 * Math.PI) / 180;
/** Screen-space picking tolerances in CSS pixels. */
export const PICK_PX = { vertex: 8, edge: 6, guide: 6, face: 0 } as const;
/** Maximum sample simplification deviation for Layout freehand strokes, in CSS pixels. */
export const FREEHAND_SMOOTHING_PX = 1.5;

export function approxEq(a: number, b: number, tol = LENGTH_TOL): boolean {
  return Math.abs(a - b) <= tol;
}
export function approxZero(a: number, tol = LENGTH_TOL): boolean {
  return Math.abs(a) <= tol;
}

/** Maximum paper-space deviation when flattening Layout curves, in meters. */
export const LAYOUT_CURVE_TOL = 1e-5;

/** Smallest angle (radians) between the faces beside an edge that Fillet and Chamfer accept, measured from flat and from folded shut. */
export const EDGE_BLEND_MIN_FACE_ANGLE = (1 * Math.PI) / 180;
/** Smallest angle (radians) between a filleted or chamfered edge and the face or mitre its tool prism ends on. */
export const EDGE_BLEND_MIN_END_ANGLE = (10 * Math.PI) / 180;
