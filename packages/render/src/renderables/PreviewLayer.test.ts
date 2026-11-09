// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { PreviewLayer } from './PreviewLayer';
import { cameraLight, studioLight } from './BodyRenderable';

const shaderStub = (): WebGLProgramParametersWithUniforms =>
  ({
    uniforms: {},
    vertexShader: '#include <common>\n#include <begin_vertex>\n#include <uv_vertex>',
    fragmentShader: '#include <common>\n#include <lights_fragment_end>\n#include <color_fragment>',
  }) as unknown as WebGLProgramParametersWithUniforms;

describe('PreviewLayer', () => {
  it('lights its faces the way the solid they replace is lit, so a studio environment with no scene lights does not draw them black', () => {
    const layer = new PreviewLayer(new LineMaterial());
    for (const material of [layer.front, layer.back]) {
      const shader = shaderStub();
      material.onBeforeCompile(shader, null as unknown as WebGLRenderer);
      expect(shader.uniforms['uPfStudioLight']).toBe(studioLight);
      expect(shader.uniforms['uPfCameraLight']).toBe(cameraLight);
      expect(shader.fragmentShader).toContain('uPfStudioLight > 0.5');
    }
    layer.dispose();
  });
});
