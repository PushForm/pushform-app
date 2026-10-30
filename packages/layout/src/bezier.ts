// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { LayoutPathHandle } from './LayoutDocument';
import type { LayoutRectanglePath } from './rectangles';

type Point = [number, number];

/** A path being placed with the Bézier tool: its anchors so far, each with its handles. */
export interface LayoutBezierDraft { points: Point[]; handles: LayoutPathHandle[] }

/** Start a draft, or add an anchor without handles to it, as a click does. */
export function addLayoutBezierAnchor(draft: LayoutBezierDraft | null, point: Point): LayoutBezierDraft {
  return { points: [...draft?.points ?? [], [point[0], point[1]]], handles: [...draft?.handles ?? [], {}] };
}

/**
 * Pull the last anchor's out handle to `handle`, as dragging does. Its in handle mirrors the out handle
 * through the anchor, so the curve passes through it smoothly.
 */
export function pullLayoutBezierHandle(draft: LayoutBezierDraft, handle: Point): LayoutBezierDraft {
  const index = draft.points.length - 1, anchor = draft.points[index]!;
  const handles = draft.handles.slice();
  handles[index] = { in: [2 * anchor[0] - handle[0], 2 * anchor[1] - handle[1]], out: [handle[0], handle[1]] };
  return { points: draft.points, handles };
}

/** The draft with a pending straight-in segment to `cursor`, for preview. */
export function previewLayoutBezier(draft: LayoutBezierDraft, cursor: Point | null): LayoutRectanglePath {
  return cursor ? { points: [...draft.points, cursor], handles: [...draft.handles, {}], closed: false }
    : { points: draft.points, handles: draft.handles, closed: false };
}

/**
 * The finished path for `layout.shape.add`, or null when it has too few anchors. A closed path needs
 * three anchors, or two joined by a curve; an open one keeps no handles past its ends.
 */
export function finishLayoutBezier(draft: LayoutBezierDraft, closed: boolean): LayoutRectanglePath | null {
  const count = draft.points.length;
  const curved = draft.handles.some(handle => handle.in || handle.out);
  if (count < 2 || closed && count < 3 && !curved) return null;
  const handles = draft.handles.map((handle): LayoutPathHandle => ({ ...handle }));
  if (!closed) { delete handles[0]!.in; delete handles[count - 1]!.out; }
  const points = draft.points.map((point): Point => [point[0], point[1]]);
  return handles.some(handle => handle.in || handle.out) ? { points, handles, closed } : { points, closed };
}
