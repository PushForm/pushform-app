// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { GreaterDepth, ShaderLib } from 'three';
import { createEdgeMaterial, patchEdgeShader } from './EdgeMaterial';

describe('EdgeMaterial', () => {
  it('fades with scene fog like faces do', () => {
    expect(createEdgeMaterial().fog).toBe(true);
    expect(createEdgeMaterial({ dashed: true, backEdges: true }).fog).toBe(true);
  });

  it('patches the real three LineMaterial vertex shader with per-segment profile selection', () => {
    createEdgeMaterial(); // registers ShaderLib.line
    const line = ShaderLib['line'];
    expect(line).toBeDefined();
    const shader = { vertexShader: line!.vertexShader, fragmentShader: line!.fragmentShader, uniforms: {} };
    patchEdgeShader(shader);
    expect(shader.vertexShader).toContain('attribute vec3 instanceNormalA;');
    expect(shader.vertexShader).toContain('attribute vec3 instanceNormalB;');
    expect(shader.vertexShader).toContain('attribute float instanceFlags;');
    expect(shader.vertexShader).toContain('uniform float profileWidth;');
    expect(shader.vertexShader).not.toContain('offset *= linewidth;');
    expect(shader.vertexShader).toContain('offset *= pfWidth;');
    // the width decision is made after `perspective` is known and before the clip-space offset
    expect(shader.vertexShader.indexOf('bool perspective')).toBeLessThan(shader.vertexShader.indexOf('pfToCam'));
    expect(shader.vertexShader.indexOf('offset *= pfWidth;')).toBeLessThan(shader.vertexShader.indexOf('offset /= resolution.y;'));
    // screen-space dashes are computed once the ndc endpoints are known
    expect(shader.vertexShader).toContain('float pfScale = length( pfPx ) / pfWorldLen;');
    expect(shader.vertexShader.indexOf('vec3 ndcEnd')).toBeLessThan(shader.vertexShader.indexOf('pfScale'));
  });

  it('back-edges materials draw only where obscured, without depth writes', () => {
    const m = createEdgeMaterial({ dashed: true, backEdges: true });
    expect(m.depthFunc).toBe(GreaterDepth);
    expect(m.depthWrite).toBe(false);
    expect(m.dashed).toBe(true);
  });

  it('throws when the upstream shader no longer has the expected anchors', () => {
    expect(() => patchEdgeShader({ vertexShader: 'void main(){}', fragmentShader: '', uniforms: {} })).toThrow(/profile patch/);
  });

  it('exposes profileWidth as a uniform and defaults to 2 px profiles over 1 px edges', () => {
    const m = createEdgeMaterial();
    expect(m.linewidth).toBe(1);
    expect(m.profileWidth).toBe(2);
    m.profileWidth = 3;
    expect(m.uniforms['profileWidth']?.value).toBe(3);
    expect(m.customProgramCacheKey()).toBe('pf-edge');
    expect(createEdgeMaterial({ dashed: true }).customProgramCacheKey()).toBe('pf-edge-dashed');
  });
});
