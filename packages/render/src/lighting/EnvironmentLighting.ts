// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Box3, Vec3 } from '@pushform/core';
import { temperatureColor } from '@pushform/model';
import type { EnvironmentSettings, SceneLight } from '@pushform/model';
import type { OverlayPrimitive } from '@pushform/commands';
import { DirectionalLight, Group, PointLight, SpotLight, Vector3, PCFSoftShadowMap } from 'three';
import type { Camera, Scene, WebGLRenderer } from 'three';
import type { SunLight } from '../shadows/SunLight';
import type { RenderShadows } from '../types';
import {
  studioLight,
  studioLightDirection,
  studioLightLevels,
} from '../renderables/BodyRenderable';

/** Fixed modeling-view exposure; luminous output still attenuates by inverse-square distance. */
const LUMEN_EXPOSURE = 0.02;
type Emitter = PointLight | SpotLight;

export class EnvironmentLighting {
  readonly studio = new DirectionalLight(0xffffff, 0);
  readonly group = new Group();
  settings: EnvironmentSettings | null = null;
  private lights: readonly SceneLight[] = [];
  private emitters: {
    light: Emitter;
    source: SceneLight;
    position: Vector3;
    target: Vector3;
    fraction: number;
  }[] = [];
  private origin = new Vector3();
  private selection: number | null = null;
  constructor(scene: Scene) {
    this.studio.shadow.mapSize.set(1024, 1024);
    this.studio.shadow.bias = -0.0001;
    this.studio.shadow.normalBias = 0.002;
    scene.add(this.studio, this.studio.target, this.group);
  }
  set(settings: EnvironmentSettings | null, lights: readonly SceneLight[]): void {
    this.settings = settings;
    if (this.lights === lights) return;
    this.clear();
    this.lights = lights;
    for (const source of lights) {
      const position = new Vector3(...source.position),
        target = new Vector3(...source.target);
      const direction = target.clone().sub(position).normalize();
      const horizontal = direction
        .clone()
        .cross(Math.abs(direction.z) > 0.99 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1))
        .normalize();
      const vertical = direction.clone().cross(horizontal).normalize();
      const samples =
        source.type === 'area'
          ? [-1, 1].flatMap((x) =>
              [-1, 1].map((y) =>
                position
                  .clone()
                  .addScaledVector(horizontal, (x * source.width) / (2 * Math.sqrt(3)))
                  .addScaledVector(vertical, (y * source.height) / (2 * Math.sqrt(3))),
              ),
            )
          : [position];
      for (const at of samples) {
        const light = source.type === 'point' ? new PointLight() : new SpotLight();
        light.color.setRGB(...temperatureColor(source.temperature), 'srgb');
        light.decay = 2;
        light.castShadow = source.castShadow;
        light.shadow.mapSize.set(1024, 1024);
        light.shadow.camera.near = 0.01;
        light.shadow.bias = -0.0001;
        light.shadow.normalBias = 0.002;
        if (light instanceof SpotLight) {
          light.angle = ((source.type === 'area' ? 89 : source.angle / 2) * Math.PI) / 180;
          light.penumbra = source.type === 'area' ? 0.05 : source.penumbra;
          this.group.add(light.target);
        }
        this.group.add(light);
        this.emitters.push({
          light,
          source,
          position: at,
          target: at.clone().add(direction),
          fraction: 1 / samples.length,
        });
      }
    }
  }
  setOrigin(origin: Vec3): void {
    this.origin.set(...origin);
  }
  setSelection(id: number | null): void {
    this.selection = id;
  }
  helpers(): OverlayPrimitive[] {
    const source = this.lights.find((light) => light.id === this.selection);
    if (!source) return [];
    return [
      { kind: 'point', position: source.position, color: '#e9ae36', size: 10, shape: 'circle' },
      ...(source.type === 'point'
        ? []
        : [
            {
              kind: 'polyline' as const,
              points: [source.position, source.target],
              color: '#e9ae36',
              width: 2,
            },
          ]),
    ];
  }
  apply(
    camera: Camera,
    bounds: Box3 | null,
    sun: SunLight,
    shadows: RenderShadows,
    renderer: WebGLRenderer | null,
  ): void {
    const env = this.settings;
    studioLight.value = env ? 1 : 0;
    this.studio.visible =
      !!env?.studioEnabled && env.studioShadows && env.key > 0 && env.brightness > 0;
    this.group.visible = !!env?.sceneLightsEnabled;
    if (!env) {
      sun.ambient.visible = true;
      return;
    }
    const center = bounds
      ? new Vector3(...bounds.min)
          .add(new Vector3(...bounds.max))
          .multiplyScalar(0.5)
          .sub(this.origin)
      : new Vector3();
    const radius = bounds ? Math.max(...bounds.max.map((v, i) => v - bounds.min[i]!), 1) : 10;
    const azimuth = (env.azimuth * Math.PI) / 180,
      elevation = (env.elevation * Math.PI) / 180;
    const direction = new Vector3(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.cos(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
    );
    camera.updateMatrixWorld();
    if (env.followCamera) direction.transformDirection(camera.matrixWorld);
    studioLightDirection.value.copy(direction).transformDirection(camera.matrixWorldInverse);
    studioLightLevels.value.set(
      env.studioEnabled ? env.fill * env.brightness : 0,
      env.studioEnabled ? env.facing * env.brightness : 0,
      env.studioEnabled && !env.studioShadows ? env.key * env.brightness : 0,
    );
    this.studio.position.copy(center).addScaledVector(direction, radius * 3);
    this.studio.target.position.copy(center);
    this.studio.target.updateMatrixWorld();
    this.studio.intensity = env.key * env.brightness * Math.PI;
    this.studio.castShadow = env.studioShadows;
    Object.assign(this.studio.shadow.camera, {
      left: -radius,
      right: radius,
      top: radius,
      bottom: -radius,
      near: radius * 0.25,
      far: radius * 6,
    });
    this.studio.shadow.camera.updateProjectionMatrix();
    this.studio.shadow.needsUpdate = true;
    sun.sun.visible = env.sunEnabled && shadows.sunUp && env.sunIntensity > 0 && env.brightness > 0;
    sun.sun.intensity = env.sunIntensity * env.brightness * Math.PI;
    sun.sun.castShadow = env.sunShadows && sun.sun.visible;
    sun.ambient.visible = env.skyLight > 0;
    sun.ambient.intensity = env.skyLight * env.brightness * Math.PI;
    sun.ambient.color.set(
      env.sky === 'night' ? '#8096c5' : env.sky === 'overcast' ? '#e8edf4' : '#d8e8ff',
    );
    for (const emitter of this.emitters) {
      const { light, source, position, target, fraction } = emitter;
      light.visible = source.enabled && source.lumens > 0 && env.brightness > 0;
      light.power = source.lumens * LUMEN_EXPOSURE * env.brightness * fraction;
      light.position.copy(position).sub(this.origin);
      if (light instanceof SpotLight) {
        light.target.position.copy(target).sub(this.origin);
        light.target.updateMatrixWorld();
      }
      light.shadow.camera.far = Math.max(10, radius * 4 + light.position.distanceTo(center));
      light.shadow.camera.updateProjectionMatrix();
    }
    const cast =
      this.studio.visible ||
      sun.sun.castShadow ||
      (env.sceneLightsEnabled && this.emitters.some((e) => e.light.visible && e.source.castShadow));
    if (renderer) {
      renderer.shadowMap.enabled = cast;
      renderer.shadowMap.type = PCFSoftShadowMap;
      renderer.shadowMap.needsUpdate = cast;
    }
    sun.ground.visible = cast && shadows.onGround;
    sun.ground.material.opacity = 0.28;
    sun.fit(bounds);
  }
  private clear(): void {
    for (const { light } of this.emitters) light.shadow.dispose();
    this.group.clear();
    this.emitters = [];
  }
  dispose(): void {
    this.clear();
    this.studio.shadow.dispose();
    this.studio.removeFromParent();
    this.studio.target.removeFromParent();
    this.group.removeFromParent();
  }
}
