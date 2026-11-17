// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { Color, SRGBColorSpace } from 'three';
import type { MeshStandardMaterial, WebGLProgramParametersWithUniforms } from 'three';
import { DEFAULT_MATERIAL_APPEARANCE } from '@pushform/model';
import type { MaterialAppearance } from '@pushform/model';

/** Shared by the modeling view and isolated studio sample. */
export function applyMaterialAppearance(
  material: MeshStandardMaterial,
  appearance: Readonly<MaterialAppearance> = DEFAULT_MATERIAL_APPEARANCE,
): void {
  material.toneMapped = false;
  material.roughness = appearance.roughness;
  material.metalness = appearance.metalness;
  material.emissive.copy(new Color().setRGB(...appearance.emissionColor, SRGBColorSpace));
  material.emissiveIntensity = appearance.emissionStrength;
  const normal = appearance.normal;
  material.normalScale.set(
    normal?.strength ?? 1,
    (normal?.strength ?? 1) * (normal?.flipGreen ? -1 : 1),
  );
}

/** Compress HDR highlights for physical surfaces without changing legacy flat/line passes. */
export function applyAppearanceToneMapping(shader: WebGLProgramParametersWithUniforms): void {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <tonemapping_fragment>',
    'gl_FragColor.rgb = gl_FragColor.rgb / ( vec3( 1.0 ) + gl_FragColor.rgb );\n#include <tonemapping_fragment>',
  );
}
