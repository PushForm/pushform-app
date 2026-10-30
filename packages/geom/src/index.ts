// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// @pushform/geom: pure geometry algorithms (no document or UI dependencies).
export * from './polygon2d';
export * from './intersections';
export * from './spatialHash';
export { PackedPointIndex, packedPointsWithin, type PackedPointIndexData } from './packedPointIndex';
export * from './planarArrangement';
export * from './triangulate';
export * from './coplanar';
export * from './curves';
export * from './bvh';
export { offsetPolygonFull, offsetPolyline } from './offset';
export type { OffsetArc, OffsetOptions, OffsetResult } from './offset';
