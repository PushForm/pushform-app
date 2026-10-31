// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { BufferAttribute, BufferGeometry, Color, Matrix4, Mesh, PerspectiveCamera, SRGBColorSpace, ShaderMaterial, Vector3 } from 'three';
import type { Camera } from 'three';
import { DEFAULT_RENDER_FOG } from '../types';
import type { RenderBackground, RenderFog } from '../types';

export const DEFAULT_RENDER_BACKGROUND: RenderBackground = {
  color: '#ffffff',
  sky: true,
  skyColor: '#c7dbf5',
  ground: true,
  groundColor: '#dbd6c7',
  groundTransparency: 0.5,
};

const VERT = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
uniform mat4 uInvViewProj;
uniform vec3 uEye;
uniform vec3 uColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uSky;
uniform float uGround;
uniform float uGroundOpacity;
uniform vec3 uForward;
uniform float uFogOn;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uFogColor;
varying vec2 vNdc;
void main() {
  vec4 far = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - uEye);
  float up = dir.z; // world Z is up
  vec3 color = uColor;
  if (up >= 0.0) {
    // sky: lighter toward the horizon, full sky color near the zenith
    float t = smoothstep(0.0, 0.55, up);
    vec3 horizon = mix(uColor, uSkyColor, 0.35);
    vec3 sky = mix(horizon, uSkyColor, t);
    color = mix(uColor, sky, uSky);
    // Fog: a haze band that is all fog color at the horizon, where the ground is infinitely far.
    color = mix(color, uFogColor, uFogOn * uSky * (1.0 - smoothstep(0.0, 0.3, up)));
  } else {
    float t = smoothstep(0.0, 0.35, -up);
    vec3 horizon = mix(uColor, uGroundColor, 0.45);
    vec3 ground = mix(horizon, uGroundColor, t);
    color = mix(uColor, mix(uColor, ground, uGroundOpacity), uGround);
    // Fog: depth along the view of the point where this ray meets the ground plane, as for geometry.
    float hit = uEye.z > 0.0 ? -uEye.z / dir.z : 1.0e9;
    float fogF = clamp((hit * dot(dir, uForward) - uFogNear) / max(uFogFar - uFogNear, 0.001), 0.0, 1.0);
    color = mix(color, uFogColor, uFogOn * uGround * fogF);
  }
  gl_FragColor = vec4(color, 1.0);
}`;

/**
 * Sky/ground gradient drawn behind everything. A full-screen triangle whose
 * fragment shader reconstructs the world view direction per pixel; the horizon is where that
 * direction crosses the world XY plane. In parallel projection a virtual perspective with the
 * same orientation is used so a horizon still appears.
 */
export class SkyBackground extends Mesh<BufferGeometry, ShaderMaterial> {
  private readonly virtual = new PerspectiveCamera(35, 1, 0.1, 10);
  private readonly inv = new Matrix4();
  private readonly eye = new Vector3();

  constructor(settings: RenderBackground = DEFAULT_RENDER_BACKGROUND) {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uInvViewProj: { value: new Matrix4() },
        uEye: { value: new Vector3() },
        uColor: { value: new Color() },
        uSkyColor: { value: new Color() },
        uGroundColor: { value: new Color() },
        uSky: { value: 1 },
        uGround: { value: 1 },
        uGroundOpacity: { value: 0.5 },
        uForward: { value: new Vector3(0, 1, 0) },
        uFogOn: { value: 0 },
        uFogNear: { value: 0 },
        uFogFar: { value: 100 },
        uFogColor: { value: new Vector3() },
      },
    });
    super(geo, mat);
    this.frustumCulled = false;
    this.renderOrder = -1000;
    this.setSettings(settings);
    this.setFog(DEFAULT_RENDER_FOG);
  }

  setSettings(s: RenderBackground): void {
    const u = this.material.uniforms;
    (u.uColor!.value as Color).set(s.color);
    (u.uSkyColor!.value as Color).set(s.skyColor);
    (u.uGroundColor!.value as Color).set(s.groundColor);
    u.uSky!.value = s.sky ? 1 : 0;
    u.uGround!.value = s.ground ? 1 : 0;
    u.uGroundOpacity!.value = 1 - Math.min(1, Math.max(0, s.groundTransparency));
  }

  /**
   * Fog on the ground and the sky: the ground fades to the fog color with its depth from the eye,
   * like the geometry on it, and the sky takes a band of it at the horizon. The color is the one
   * the fog draws on screen, written as it is because this pass writes its colors as they are.
   */
  setFog(fog: RenderFog): void {
    const u = this.material.uniforms;
    u.uFogOn!.value = fog.enabled && fog.far > 0 ? 1 : 0;
    u.uFogNear!.value = fog.near;
    u.uFogFar!.value = fog.far;
    const rgb = { r: 0, g: 0, b: 0 };
    new Color(fog.color).getRGB(rgb, SRGBColorSpace);
    (u.uFogColor!.value as Vector3).set(rgb.r, rgb.g, rgb.b);
  }

  /** Update the per-frame view reconstruction. Call before rendering with the active camera. */
  update(camera: Camera, aspect: number): void {
    camera.updateMatrixWorld();
    const v = this.virtual;
    v.aspect = aspect;
    v.updateProjectionMatrix();
    v.matrixWorld.copy(camera.matrixWorld);
    v.matrixWorldInverse.copy(camera.matrixWorld).invert();
    this.inv.multiplyMatrices(v.projectionMatrix, v.matrixWorldInverse).invert();
    (this.material.uniforms.uInvViewProj!.value as Matrix4).copy(this.inv);
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    (this.material.uniforms.uEye!.value as Vector3).copy(this.eye);
    camera.getWorldDirection((this.material.uniforms.uForward!.value as Vector3));
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
