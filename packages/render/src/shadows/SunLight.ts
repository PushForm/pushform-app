// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Box3, Vec3 } from '@pushform/core';
import { Mesh, PCFSoftShadowMap, PlaneGeometry, ShadowMaterial, Vector3 } from 'three';
import type { DirectionalLight, HemisphereLight, WebGLRenderer } from 'three';
import { DEFAULT_RENDER_SHADOWS } from '../types';
import type { RenderShadows } from '../types';

/** Shadow map resolution (PCF soft). */
export const SHADOW_MAP_SIZE = 2048;
/** Default sun direction when shadows/sun shading are off (the viewport's fixed key light). */
export const DEFAULT_SUN_DIRECTION: Vec3 = [0.6, -0.45, 1];
/** Base intensities of the key and ambient lights (Light/Dark sliders scale these). */
export const BASE_SUN_INTENSITY = 1.4;
export const BASE_AMBIENT_INTENSITY = 1.1;
/** Ground shadow plane opacity at Dark = 0 (full shadows). */
export const GROUND_SHADOW_OPACITY = 0.45;

/**
 * Sun + shadows over the viewport's existing key light and hemisphere light: positions the
 * directional light from the NOAA sun direction, enables a PCF soft shadow map with an
 * orthographic shadow camera refit to the scene bounds, scales intensities from the Light/Dark
 * sliders and owns the ground `ShadowMaterial` plane for "On Ground" shadows.
 */
export class SunLight {
  readonly ground: Mesh<PlaneGeometry, ShadowMaterial>;
  private settings: RenderShadows = DEFAULT_RENDER_SHADOWS;
  private origin: Vec3 = [0, 0, 0];
  private lastBounds: Box3 | null = null;

  constructor(
    readonly sun: DirectionalLight,
    readonly ambient: HemisphereLight,
  ) {
    sun.castShadow = false;
    sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 2;
    sun.target.position.set(0, 0, 0);
    this.ground = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ opacity: GROUND_SHADOW_OPACITY, transparent: true, depthWrite: false }));
    this.ground.name = 'GroundShadow';
    this.ground.receiveShadow = true;
    this.ground.visible = false;
    this.ground.renderOrder = -1;
    this.apply();
  }

  get current(): RenderShadows {
    return this.settings;
  }

  /** Apply settings; `renderer.shadowMap` is switched when a renderer exists. */
  set(settings: RenderShadows, renderer: WebGLRenderer | null): boolean {
    const prev = this.settings;
    this.settings = settings;
    this.apply();
    this.configureRenderer(renderer);
    return prev !== settings;
  }

  configureRenderer(renderer: WebGLRenderer | null): void {
    if (!renderer) return;
    const on = this.settings.enabled && this.settings.sunUp;
    if (renderer.shadowMap.enabled !== on) {
      renderer.shadowMap.enabled = on;
      renderer.shadowMap.type = PCFSoftShadowMap;
      renderer.shadowMap.needsUpdate = true;
    }
  }

  setOrigin(origin: Vec3): void {
    this.origin = origin;
    this.lastBounds = null;
  }

  /**
   * Refit the orthographic shadow camera and the ground plane to the scene bounds (world
   * coordinates; converted to origin-relative). Cheap when the bounds object is unchanged.
   */
  fit(bounds: Box3 | null): void {
    if (bounds === this.lastBounds) return;
    this.lastBounds = bounds;
    const o = this.origin;
    const min = bounds ? bounds.min : [-5, -5, 0];
    const max = bounds ? bounds.max : [5, 5, 3];
    const cx = (min[0] + max[0]) / 2 - o[0], cy = (min[1] + max[1]) / 2 - o[1], cz = (min[2] + max[2]) / 2 - o[2];
    const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1);
    const radius = size * 0.9;
    const d = this.settings.sunDirection;
    this.sun.target.position.set(cx, cy, cz);
    this.sun.target.updateMatrixWorld();
    this.sun.position.set(cx + d[0] * radius * 3, cy + d[1] * radius * 3, cz + d[2] * radius * 3);
    const cam = this.sun.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = radius * 0.5;
    cam.far = radius * 6;
    cam.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
    // ground plane at the lowest point of the scene, wide enough for long shadows
    const groundSize = size * 6;
    this.ground.scale.set(groundSize, groundSize, 1);
    this.ground.position.set(cx, cy, (bounds ? bounds.min[2] : 0) - o[2] - 0.001);
  }

  private apply(): void {
    const s = this.settings;
    const sunActive = (s.enabled || s.useSunForShading) && s.sunUp;
    const d = sunActive ? s.sunDirection : DEFAULT_SUN_DIRECTION;
    const v = new Vector3(d[0], d[1], d[2]).normalize();
    // keep the direction; `fit` places the light relative to the scene center
    const dist = this.sun.position.length() || 20;
    this.sun.position.copy(v.multiplyScalar(dist));
    const light = Math.min(100, Math.max(0, s.light)) / 100;
    const dark = Math.min(100, Math.max(0, s.dark)) / 100;
    this.sun.intensity = BASE_SUN_INTENSITY * (s.enabled ? 0.4 + 0.9 * light : 1);
    this.ambient.intensity = BASE_AMBIENT_INTENSITY * (s.enabled ? 0.35 + 0.65 * dark : 1);
    const shadows = s.enabled && s.sunUp;
    this.sun.castShadow = shadows && (s.onFaces || s.onGround);
    this.sun.visible = s.sunUp || !s.enabled;
    this.ground.visible = shadows && s.onGround;
    this.ground.material.opacity = GROUND_SHADOW_OPACITY * (1 - dark * 0.6);
    this.lastBounds = null;
  }

  dispose(): void {
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.sun.shadow.dispose();
  }
}
