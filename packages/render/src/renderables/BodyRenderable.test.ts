// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { MeshLambertMaterial, ShaderLib } from 'three';
import type { BufferAttribute } from 'three';
import { BodyRenderable, CAMERA_LIGHT, cameraLight, createBodyMaterials, fillFlags, patchSelectTint } from './BodyRenderable';
import { M4_IDENTITY, meshBox } from '@pushform/core';
import { buildFaceGeometry } from './buildGeometry';
import type { RenderBody } from '../types';

it('omits hidden solid faces, reveals them with hidden geometry, and refreshes after a visibility edit', () => {
  const materials = createBodyMaterials(), renderable = new BodyRenderable('body', materials);
  const mesh = meshBox([0, 0, 0], [1, 1, 1]), faceId = mesh.faceId[0]!;
  const body: RenderBody = { id: 'body', entityId: 1 as never, path: [], version: 0,
    mesh, transform: M4_IDENTITY, hiddenFaces: new Set([faceId]) };
  renderable.update(body, [0, 0, 0]);
  expect(renderable.front.geometry.getAttribute('position').count).toBe(30);
  expect([...renderable.front.geometry.getAttribute('faceId').array]).not.toContain(faceId);
  expect(mesh.tris).toHaveLength(36); // hiding must not open or mutate the model solid
  expect(renderable.needsUpdate(body)).toBe(false);
  renderable.setShowHidden(true);
  expect(renderable.needsUpdate(body)).toBe(true);
  renderable.update(body, [0, 0, 0]);
  expect(renderable.front.geometry.getAttribute('position').count).toBe(36);
  const visible = { ...body, hiddenFaces: new Set<number>() };
  expect(renderable.needsUpdate(visible)).toBe(true);
  renderable.dispose();
  for (const material of Object.values(materials)) material.dispose();
});

describe('patchSelectTint', () => {
  it('injects the flags attribute and tint into the real Lambert shader', () => {
    const m = new MeshLambertMaterial();
    patchSelectTint(m);
    const lambert = ShaderLib['lambert']!;
    const shader = { vertexShader: lambert.vertexShader, fragmentShader: lambert.fragmentShader, uniforms: {} as Record<string, { value: unknown }> };
    m.onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).toContain('attribute float flags;');
    expect(shader.vertexShader).toContain('vPfFlags = flags;');
    expect(shader.fragmentShader).toContain('uniform vec3 uPfSelectColor;');
    expect(shader.fragmentShader).toContain('mix( diffuseColor.rgb, uPfSelectColor, 0.25 )');
    expect(shader.uniforms['uPfSelectColor']).toBeDefined();
    expect(m.customProgramCacheKey()).toBe('pf-select-tint');
  });

  it('lights faces from the camera when asked, on the sRGB color, limited to white', () => {
    const m = new MeshLambertMaterial();
    patchSelectTint(m);
    const lambert = ShaderLib['lambert']!;
    const shader = { vertexShader: lambert.vertexShader, fragmentShader: lambert.fragmentShader, uniforms: {} as Record<string, { value: unknown }> };
    m.onBeforeCompile(shader as never, null as never);
    expect(shader.uniforms['uPfCameraLight']).toBe(cameraLight);
    expect(shader.fragmentShader).toContain('uniform float uPfCameraLight;');
    expect(shader.fragmentShader).toContain(`${CAMERA_LIGHT.ambient} + ${CAMERA_LIGHT.facing} * max( normal.z, 0.0 )`);
    expect(shader.fragmentShader).toContain('sRGBTransferOETF( vec4( diffuseColor.rgb, 1.0 ) )');
  });

  it('brightens a face turned to the camera and darkens one turned away', () => {
    // A 128 grey face at 0°, 30°, 60° and 80° to the view direction shows 154, 140, 102 and 69.
    const lit = (color: number, deg: number) => Math.min(255, color * (CAMERA_LIGHT.ambient + CAMERA_LIGHT.facing * Math.cos(deg * Math.PI / 180)));
    [[0, 154], [30, 140], [60, 102], [80, 69]].forEach(([deg, measured]) => expect(Math.abs(lit(128, deg!) - measured!)).toBeLessThanOrEqual(1));
    // White stays white while the face is within about 41° of the view direction.
    expect(lit(255, 40)).toBe(255);
    expect(lit(255, 45)).toBeLessThan(255);
  });

  it('fillFlags marks a vertex range and flags the attribute for upload', () => {
    const g = buildFaceGeometry(meshBox([0, 0, 0], [1, 1, 1]), M4_IDENTITY, [0, 0, 0]);
    const a = g.getAttribute('flags') as BufferAttribute;
    const before = a.version;
    fillFlags(g, 1, 6, 6);
    expect(a.version).toBeGreaterThan(before); // needsUpdate bumps version
    expect(Array.from(a.array as Uint8Array).filter((f) => f === 1)).toHaveLength(6);
    fillFlags(g, 0);
    expect(Array.from(a.array as Uint8Array).every((f) => f === 0)).toBe(true);
  });
});
