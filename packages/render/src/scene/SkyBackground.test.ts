// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Vector3 } from 'three';
import { SkyBackground } from './SkyBackground';

describe('SkyBackground fog', () => {
  it('takes the fog distances and the color as it is drawn', () => {
    const sky = new SkyBackground();
    const u = sky.material.uniforms;
    expect(u.uFogOn!.value).toBe(0);
    sky.setFog({ enabled: true, near: 5, far: 60, color: '#ff8000' });
    expect(u.uFogOn!.value).toBe(1);
    expect([u.uFogNear!.value, u.uFogFar!.value]).toEqual([5, 60]);
    const c = u.uFogColor!.value as Vector3;
    expect([c.x, c.y, c.z].map((v) => Math.round(v * 255))).toEqual([255, 128, 0]);
  });

  it('is off when fog is off or has no far distance', () => {
    const sky = new SkyBackground();
    sky.setFog({ enabled: false, near: 0, far: 100, color: '#ffffff' });
    expect(sky.material.uniforms.uFogOn!.value).toBe(0);
    sky.setFog({ enabled: true, near: 0, far: 0, color: '#ffffff' });
    expect(sky.material.uniforms.uFogOn!.value).toBe(0);
  });
});
