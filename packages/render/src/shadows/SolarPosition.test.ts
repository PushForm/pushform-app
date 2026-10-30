// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { DirectionalLight, HemisphereLight, ShaderLib } from 'three';
import { julianDay, solarPosition, sunDirection } from './SolarPosition';
import { BASE_AMBIENT_INTENSITY, BASE_SUN_INTENSITY, SunLight } from './SunLight';
import { DEFAULT_RENDER_SHADOWS, EDGE_FLAG_COLORED, EDGE_FLAG_DASH, EDGE_FLAG_DOT, cssToRgb, edgeStyleFlags } from '../types';
import { createEdgeMaterial, patchEdgeShader } from '../renderables/EdgeMaterial';
import { EdgeBatch } from '../renderables/EdgeBatch';
import { buildBodyEdgeSegments } from '../renderables/buildGeometry';
import { M4_IDENTITY } from '@pushform/core';

describe('NOAA solar position', () => {
  it('Julian day of J2000 epoch', () => {
    expect(julianDay(2000, 1, 1, 12)).toBeCloseTo(2451545, 6);
  });

  it('equinox at the equator: sun overhead at solar noon, azimuth flips through 180 near noon', () => {
    // 2025-03-20 09:01 UTC is the equinox; at lon 0 solar noon ≈ 12:07 UTC (equation of time ≈ -7 min)
    const noon = solarPosition({ year: 2025, month: 3, day: 20, minutes: 12 * 60 + 7, utcOffsetHours: 0, latitude: 0, longitude: 0 });
    expect(Math.abs(noon.declination)).toBeLessThan(0.2);
    expect(noon.elevation).toBeGreaterThan(89.5);
    expect(noon.solarNoonMinutes).toBeCloseTo(12 * 60 + 7, 0);
    const morning = solarPosition({ year: 2025, month: 3, day: 20, minutes: 9 * 60, utcOffsetHours: 0, latitude: 0, longitude: 0 });
    expect(morning.azimuth).toBeGreaterThan(80);
    expect(morning.azimuth).toBeLessThan(100);
    expect(morning.elevation).toBeCloseTo(90 - 3 * 15 - 7 / 4, 0);
  });

  it('summer solstice noon in Boulder, CO (MDT): elevation ≈ 90 − 40.02 + 23.44', () => {
    const p = solarPosition({ year: 2025, month: 6, day: 21, minutes: 13 * 60 + 2, utcOffsetHours: -6, latitude: 40.017, longitude: -105.283 });
    expect(p.declination).toBeCloseTo(23.44, 1);
    expect(p.elevation).toBeCloseTo(73.4, 0);
    expect(Math.abs(p.azimuth - 180)).toBeLessThan(2);
    expect(p.solarNoonMinutes).toBeCloseTo(13 * 60 + 2, -1);
  });

  it('winter solstice in London: low sun, below the horizon at night; refraction lifts the horizon sun', () => {
    const noon = solarPosition({ year: 2025, month: 12, day: 21, minutes: 12 * 60, utcOffsetHours: 0, latitude: 51.5, longitude: -0.12 });
    expect(noon.elevation).toBeCloseTo(15.1, 0);
    const night = solarPosition({ year: 2025, month: 12, day: 21, minutes: 0, utcOffsetHours: 0, latitude: 51.5, longitude: -0.12 });
    expect(night.elevation).toBeLessThan(-50);
    expect(night.azimuth).toBeLessThan(10);
  });

  it('sun direction: east at azimuth 90, north rotated by the north angle, Z from the elevation', () => {
    const east = sunDirection(90, 0);
    expect(east[0]).toBeCloseTo(1);
    expect(east[1]).toBeCloseTo(0);
    expect(east[2]).toBeCloseTo(0);
    const up = sunDirection(180, 90);
    expect(up[2]).toBeCloseTo(1);
    // north angle 90: model north points toward +X, so a north sun (az 0) comes from +X and an east sun from -Y
    const north = sunDirection(0, 30, 90);
    expect(north[0]).toBeCloseTo(Math.cos(Math.PI / 6));
    expect(Math.abs(north[1])).toBeLessThan(1e-9);
    const rotated = sunDirection(90, 30, 90);
    expect(rotated[1]).toBeCloseTo(-Math.cos(Math.PI / 6));
    expect(Math.abs(rotated[0])).toBeLessThan(1e-9);
    // SketchUp 2027: London, 20 March 2020 at noon with north angle 30 puts the sun at x -0.36 (PF-258).
    const london = solarPosition({ year: 2020, month: 3, day: 20, minutes: 720, utcOffsetHours: 0, latitude: 51.5, longitude: -0.12 });
    expect(sunDirection(london.azimuth, london.elevation, 30)[0]).toBeCloseTo(-0.36, 1);
    const boulder = solarPosition({ year: 2015, month: 6, day: 29, minutes: 13 * 60 + 42, utcOffsetHours: -7, latitude: 40.018309, longitude: -105.242139 });
    const sun = sunDirection(boulder.azimuth, boulder.elevation);
    [-0.38, -0.236, 0.894].forEach((value, axis) => expect(sun[axis]).toBeCloseTo(value, 2));
  });
});

describe('SunLight', () => {
  it('positions the key light from the sun direction, scales intensities, toggles shadow casting and the ground plane', () => {
    const sun = new DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.6, -0.45, 1);
    const hemi = new HemisphereLight(0xffffff, 0x9aa5b1, 1.1);
    const light = new SunLight(sun, hemi);
    expect(sun.castShadow).toBe(false);
    expect(light.ground.visible).toBe(false);
    expect(sun.shadow.mapSize.x).toBe(2048);
    light.set({ ...DEFAULT_RENDER_SHADOWS, enabled: true, sunDirection: [0, 0, 1], light: 100, dark: 0, onGround: true }, null);
    expect(sun.castShadow).toBe(true);
    expect(light.ground.visible).toBe(true);
    expect(sun.intensity).toBeCloseTo(BASE_SUN_INTENSITY * 1.3);
    expect(hemi.intensity).toBeCloseTo(BASE_AMBIENT_INTENSITY * 0.35);
    light.fit({ min: [0, 0, 0], max: [2, 2, 2] });
    expect(sun.position.z).toBeGreaterThan(sun.target.position.z);
    expect(sun.position.x).toBeCloseTo(1);
    expect(sun.shadow.camera.right).toBeCloseTo(1.8);
    expect(light.ground.position.z).toBeCloseTo(-0.001);
    // sun below the horizon: no shadows, sun light disabled
    light.set({ ...DEFAULT_RENDER_SHADOWS, enabled: true, sunUp: false }, null);
    expect(sun.castShadow).toBe(false);
    expect(sun.visible).toBe(false);
    expect(light.ground.visible).toBe(false);
    // off: back to the fixed key light
    light.set(DEFAULT_RENDER_SHADOWS, null);
    expect(sun.visible).toBe(true);
    expect(sun.intensity).toBeCloseTo(BASE_SUN_INTENSITY);
    expect(hemi.intensity).toBeCloseTo(BASE_AMBIENT_INTENSITY);
  });
});

describe('tag edge styling in the edge pipeline', () => {
  it('flags, colors and the shader patch', () => {
    expect(edgeStyleFlags({ dashes: 'dash' })).toBe(EDGE_FLAG_DASH);
    expect(edgeStyleFlags({ dashes: 'dot', color: '#ff0000' })).toBe(EDGE_FLAG_DOT | EDGE_FLAG_COLORED);
    expect(edgeStyleFlags({ dashes: null })).toBe(0);
    expect(cssToRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(cssToRgb('#fff')).toEqual([1, 1, 1]);
    expect(cssToRgb('nope')).toEqual([1, 1, 1]);
    const segs = buildBodyEdgeSegments(
      [
        { points: [[0, 0, 0], [1, 0, 0]], soft: false, smooth: false, hidden: false, faceA: 0, faceB: 1, dashes: 'dash', color: '#0000ff' },
        { points: [[0, 0, 0], [0, 1, 0]], soft: false, smooth: false, hidden: false, faceA: 0, faceB: 1 },
      ],
      new Map([
        [0, [0, 0, 1]],
        [1, [0, 1, 0]],
      ]),
      M4_IDENTITY,
      [0, 0, 0],
    );
    expect(segs.edges.flags[0]! & EDGE_FLAG_DASH).toBe(EDGE_FLAG_DASH);
    expect(segs.edges.flags[0]! & EDGE_FLAG_COLORED).toBe(EDGE_FLAG_COLORED);
    expect(segs.edges.flags[1]).toBe(0);
    expect(Array.from(segs.edges.colors!.slice(0, 3))).toEqual([0, 0, 1]);
    expect(Array.from(segs.edges.colors!.slice(6, 9))).toEqual([1, 1, 1]);
    const batch = new EdgeBatch(createEdgeMaterial({ vertexColors: true }));
    batch.setSegments(segs.edges);
    expect(batch.geometry.getAttribute('instanceColorStart')).toBeDefined();
    expect(batch.segmentCount).toBe(2);
    expect(createEdgeMaterial({ vertexColors: true }).customProgramCacheKey()).toBe('pf-edge-vc');

    const line = ShaderLib['line']!;
    const shader = { vertexShader: line.vertexShader, fragmentShader: line.fragmentShader, uniforms: {} };
    patchEdgeShader(shader);
    expect(shader.vertexShader).toContain('vPfFlags = instanceFlags;');
    expect(shader.fragmentShader).toContain('varying float vPfDist;');
    expect(shader.fragmentShader).toContain('if ( pfDash && mod( vPfDist, 10.0 ) > 6.0 ) discard;');
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = vColor.rgb;');
    expect(shader.fragmentShader.indexOf('pfDash')).toBeLessThan(shader.fragmentShader.indexOf('#include <color_fragment>'));
  });
});
