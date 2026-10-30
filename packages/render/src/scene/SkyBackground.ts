// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { BufferAttribute, BufferGeometry, Color, Matrix4, Mesh, PerspectiveCamera, ShaderMaterial, Vector3 } from 'three';
import type { Camera } from 'three';
import type { RenderBackground } from '../types';

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
  } else {
    float t = smoothstep(0.0, 0.35, -up);
    vec3 horizon = mix(uColor, uGroundColor, 0.45);
    vec3 ground = mix(horizon, uGroundColor, t);
    color = mix(uColor, mix(uColor, ground, uGroundOpacity), uGround);
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
      },
    });
    super(geo, mat);
    this.frustumCulled = false;
    this.renderOrder = -1000;
    this.setSettings(settings);
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
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
