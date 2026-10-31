// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Line, LineBasicMaterial } from 'three';
import { Axes } from './Axes';
import { SkyBackground } from './SkyBackground';

describe('Axes', () => {
  it('draws six half-axes in red, green and blue', () => {
    const axes = new Axes();
    const colors = axes.children.map((c) => ((c as Line).material as LineBasicMaterial).color.getHex());
    expect(colors).toEqual([0xd0342c, 0xd0342c, 0x2fa84f, 0x2fa84f, 0x2a6fd6, 0x2a6fd6]);
  });

  it('keeps its draw order on the lines so the sky background is drawn first', () => {
    // three.js orders by a group's renderOrder before an object's own; a group order would put
    // the axes before the sky, and the sky ignores depth and would paint over them.
    const axes = new Axes();
    const sky = new SkyBackground();
    expect(axes.renderOrder).toBe(0);
    for (const line of axes.children) expect(line.renderOrder).toBeGreaterThan(sky.renderOrder);
  });
});
