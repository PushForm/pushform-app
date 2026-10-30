// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { addLayoutBezierAnchor, finishLayoutBezier, previewLayoutBezier, pullLayoutBezierHandle } from './bezier';

describe('Bézier tool drafts', () => {
  it('adds corner anchors and pulls mirrored handles from the last one', () => {
    let draft = addLayoutBezierAnchor(null, [0, 0]);
    draft = addLayoutBezierAnchor(draft, [10, 0]);
    expect(draft.handles).toEqual([{}, {}]);
    draft = pullLayoutBezierHandle(draft, [14, 3]);
    expect(draft.handles[1]).toEqual({ in: [6, -3], out: [14, 3] });
    expect(previewLayoutBezier(draft, [20, 5]).points).toEqual([[0, 0], [10, 0], [20, 5]]);
  });

  it('drops dangling handles from an open path and keeps them when closing', () => {
    let draft = pullLayoutBezierHandle(addLayoutBezierAnchor(null, [0, 0]), [0, 5]);
    draft = pullLayoutBezierHandle(addLayoutBezierAnchor(draft, [10, 0]), [10, -5]);
    expect(finishLayoutBezier(draft, false)).toEqual({ points: [[0, 0], [10, 0]], handles: [{ out: [0, 5] }, { in: [10, 5] }], closed: false });
    expect(finishLayoutBezier(draft, true)?.handles).toEqual(draft.handles);
  });

  it('needs two anchors, and three for a closed path without curves', () => {
    const one = addLayoutBezierAnchor(null, [0, 0]), two = addLayoutBezierAnchor(one, [10, 0]);
    expect(finishLayoutBezier(one, false)).toBeNull();
    expect(finishLayoutBezier(two, true)).toBeNull();
    expect(finishLayoutBezier(two, false)).toEqual({ points: [[0, 0], [10, 0]], closed: false });
  });
});
