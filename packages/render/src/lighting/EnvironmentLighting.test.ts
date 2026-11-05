// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import {
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  PointLight,
  Scene,
  SpotLight,
  Vector3,
} from 'three';
import { defaultSceneLight, environmentPreset } from '@pushform/model';
import type { Id } from '@pushform/core';
import { EnvironmentLighting } from './EnvironmentLighting';
import { SunLight } from '../shadows/SunLight';
import { DEFAULT_RENDER_SHADOWS } from '../types';
import { studioLightDirection } from '../renderables/BodyRenderable';
it('keeps a studio light fixed in view or world coordinates according to Follow camera', () => {
  const lighting = new EnvironmentLighting(new Scene()),
    sun = new SunLight(new DirectionalLight(), new HemisphereLight());
  const camera = new PerspectiveCamera();
  camera.up.set(0, 0, 1);
  camera.position.set(3, -4, 2);
  camera.lookAt(0, 0, 0);
  const env = environmentPreset('bright');
  lighting.set(env, []);
  lighting.apply(camera, null, sun, DEFAULT_RENDER_SHADOWS, null);
  const viewDirection = studioLightDirection.value.clone(),
    position = lighting.studio.position.clone();
  camera.position.set(-4, 3, 2);
  camera.lookAt(0, 0, 0);
  lighting.apply(camera, null, sun, DEFAULT_RENDER_SHADOWS, null);
  expect(studioLightDirection.value.distanceTo(viewDirection)).toBeLessThan(1e-6);
  expect(lighting.studio.position.distanceTo(position)).toBeGreaterThan(1);
  lighting.set({ ...env, followCamera: false }, []);
  lighting.apply(camera, null, sun, DEFAULT_RENDER_SHADOWS, null);
  const fixed = lighting.studio.position.clone();
  camera.position.set(3, -4, 2);
  camera.lookAt(0, 0, 0);
  lighting.apply(camera, null, sun, DEFAULT_RENDER_SHADOWS, null);
  expect(lighting.studio.position.distanceTo(fixed)).toBeLessThan(1e-6);
  lighting.dispose();
  sun.dispose();
});
it('samples an area emitter, retains total output and follows the floating origin', () => {
  const lighting = new EnvironmentLighting(new Scene()),
    sun = new SunLight(new DirectionalLight(), new HemisphereLight());
  lighting.set(environmentPreset('night'), [
    {
      ...defaultSceneLight('area'),
      id: 100 as Id,
      position: [1000000, 0, 2],
      target: [1000000, 0, 0],
      lumens: 1000,
    },
  ]);
  lighting.setOrigin([1000000, 0, 0]);
  lighting.apply(new PerspectiveCamera(), null, sun, DEFAULT_RENDER_SHADOWS, null);
  const emitters = lighting.group.children.filter(
    (child): child is SpotLight => child instanceof SpotLight,
  );
  expect(emitters).toHaveLength(4);
  expect(emitters.reduce((total, light) => total + light.power, 0)).toBeCloseTo(20);
  expect(new Set(emitters.map((light) => light.position.toArray().join(','))).size).toBe(4);
  expect(emitters.every((light) => light.position.distanceTo(new Vector3(0, 0, 2)) < 1)).toBe(true);
  expect(emitters.every((light) => light.castShadow)).toBe(true);
  lighting.dispose();
  sun.dispose();
});
it('turns the sun off for night but keeps explicitly enabled model lights', () => {
  const lighting = new EnvironmentLighting(new Scene()),
    sun = new SunLight(new DirectionalLight(), new HemisphereLight());
  lighting.set(environmentPreset('night'), [{ ...defaultSceneLight(), id: 100 as Id }]);
  lighting.apply(new PerspectiveCamera(), null, sun, DEFAULT_RENDER_SHADOWS, null);
  expect(sun.sun.visible).toBe(false);
  expect(lighting.group.visible).toBe(true);
  expect(
    lighting.group.children.some((child) => child instanceof PointLight && child.power > 0),
  ).toBe(true);
  lighting.dispose();
  sun.dispose();
});
