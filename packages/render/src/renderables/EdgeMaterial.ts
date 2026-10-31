// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { GreaterDepth, Vector2 } from 'three';
import type { Color } from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

/** The subset of three's compile parameters the edge patch touches (kept small for unit tests). */
export interface EdgeShaderSource {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, { value: unknown }>;
}

export interface EdgeMaterialOptions {
  /** Normal edge width in CSS px (default 1). */
  readonly width?: number | undefined;
  /** Profile/silhouette width in CSS px (default 2). Set equal to `width` to disable profiles. */
  readonly profileWidth?: number | undefined;
  readonly color?: number | undefined;
  readonly dashed?: boolean | undefined;
  readonly depthTest?: boolean | undefined;
  readonly opacity?: number | undefined;
  /** Back-edges pass: draw only where the edge is obscured (`GreaterDepth`), without depth writes. */
  readonly backEdges?: boolean | undefined;
  /** Honour per-segment `instanceColorStart/End` (Color by Tag). Only for geometries built by `EdgeBatch`. */
  readonly vertexColors?: boolean | undefined;
}

export const EDGE_COLOR = 0x1a1a1a;
export const DEFAULT_EDGE_WIDTH = 1;
export const DEFAULT_PROFILE_WIDTH = 2;

const ATTR_DECL = /* glsl */ `
		uniform vec2 resolution;
		uniform float profileWidth;
		uniform float pfExtension;
		uniform float pfDepthCue;
		uniform vec2 pfDepthRange;
		varying float vPfAxis;
		attribute vec3 instanceNormalA;
		attribute vec3 instanceNormalB;
		attribute float instanceFlags;
		varying float vPfFlags;
		varying float vPfDist;
		#ifndef USE_DASH
			attribute float instanceDistanceStart;
			attribute float instanceDistanceEnd;
		#endif`;

const DASH_ANCHOR = 'vec2 dir = ndcEnd.xy - ndcStart.xy;';
const DASH_SCREEN = /* glsl */ `
			vec2 dir = ndcEnd.xy - ndcStart.xy;
			// PushForm tag dashes: per-segment flags and a screen-space distance (CSS px) along the
			// segment, available in every material (not only dashed ones).
			vPfFlags = instanceFlags;
			// By Axis edge color: which model axis, if any, the segment runs along (1 red, 2 green, 3 blue).
			{
				vec3 pfWorldDir = normalize( mat3( modelMatrix ) * ( instanceEnd - instanceStart ) );
				vPfAxis = abs( pfWorldDir.x ) > 0.9999 ? 1.0 : abs( pfWorldDir.y ) > 0.9999 ? 2.0 : abs( pfWorldDir.z ) > 0.9999 ? 3.0 : 0.0;
			}
			{
				vec2 pfPx2 = ( ndcEnd.xy - ndcStart.xy ) * resolution * 0.5;
				float pfWorldLen2 = max( instanceDistanceEnd - instanceDistanceStart, 1e-9 );
				vPfDist = ( position.y < 0.5 ) ? 0.0 : length( pfPx2 );
				vPfDist = ( pfWorldLen2 > 0.0 ) ? vPfDist : 0.0;
			}
			#ifdef USE_DASH
				// PushForm: screen-space dashes (dashSize/gapSize in CSS px): rescale the world distance
				// along this segment by its projected length so dashes keep their size at any zoom.
				{
					vec2 pfPx = ( ndcEnd.xy - ndcStart.xy ) * resolution * 0.5;
					float pfWorldLen = max( instanceDistanceEnd - instanceDistanceStart, 1e-9 );
					float pfScale = length( pfPx ) / pfWorldLen;
					vLineDistance = ( position.y < 0.5 ) ? 0.0 : dashScale * ( instanceDistanceEnd - instanceDistanceStart ) * pfScale;
				}
			#endif`;

const WIDTH_SELECT = /* glsl */ `
				// PushForm profiles: widen silhouettes (adjacent face normals straddle the view
				// direction) and boundary segments (BOUNDARY flag or a zero second normal).
				float pfWidth = linewidth;
				{
					vec3 pfMid = mix( start.xyz, end.xyz, 0.5 );
					vec3 pfToCam = perspective ? normalize( - pfMid ) : vec3( 0.0, 0.0, 1.0 );
					vec3 pfNA = normalMatrix * instanceNormalA;
					vec3 pfNB = normalMatrix * instanceNormalB;
					bool pfBoundary = mod( instanceFlags, 2.0 ) >= 1.0 || dot( instanceNormalB, instanceNormalB ) < 0.5;
					if ( pfBoundary || dot( pfNA, pfToCam ) * dot( pfNB, pfToCam ) < 0.0 ) pfWidth = profileWidth;
					// Depth cue: the nearest edges widen to pfDepthCue px, the farthest keep the normal width.
					if ( pfDepthCue > 0.0 ) {
						float pfT = clamp( ( - pfMid.z - pfDepthRange.x ) / max( pfDepthRange.y - pfDepthRange.x, 1e-6 ), 0.0, 1.0 );
						pfWidth = max( pfWidth, mix( pfDepthCue, linewidth, pfT ) );
					}
				}
				offset *= pfWidth;
				// Extension: both ends run on past the vertex by pfExtension px.
				if ( pfExtension > 0.0 ) offset += ( ( position.y < 0.5 ) ? - dir : dir ) * pfExtension * 2.0;`;

const FRAG_DECL_ANCHOR = 'uniform float linewidth;';
const FRAG_DECL = /* glsl */ `
		uniform float linewidth;
		uniform float pfAxisColors;
		varying float vPfFlags;
		varying float vPfDist;
		varying float vPfAxis;`;
const FRAG_MAIN_ANCHOR = 'vec4 diffuseColor = vec4( diffuse, alpha );';
const FRAG_MAIN = /* glsl */ `
			vec4 diffuseColor = vec4( diffuse, alpha );
			// PushForm tag dash patterns (flags 16 = dash 6/4 px, 32 = dot 2/3 px)
			{
				float pfF = floor( vPfFlags + 0.5 );
				bool pfDash = mod( floor( pfF / 16.0 ), 2.0 ) >= 1.0;
				bool pfDot = mod( floor( pfF / 32.0 ), 2.0 ) >= 1.0;
				if ( pfDash && mod( vPfDist, 10.0 ) > 6.0 ) discard;
				if ( pfDot && mod( vPfDist, 5.0 ) > 2.0 ) discard;
			}`;
const FRAG_COLOR_ANCHOR = '#include <color_fragment>';
const FRAG_COLOR = /* glsl */ `
			#include <color_fragment>
			#ifdef USE_COLOR
				// Color by Tag: flagged segments use their own color instead of the material color.
				if ( mod( floor( floor( vPfFlags + 0.5 ) / 64.0 ), 2.0 ) >= 1.0 ) diffuseColor.rgb = vColor.rgb;
				else diffuseColor.rgb = diffuse;
			#endif
			// By Axis: edges along a model axis take its color.
			if ( pfAxisColors > 0.5 ) {
				float pfAxis = floor( vPfAxis + 0.5 );
				if ( pfAxis == 1.0 ) diffuseColor.rgb = vec3( 0.85, 0.1, 0.1 );
				else if ( pfAxis == 2.0 ) diffuseColor.rgb = vec3( 0.1, 0.6, 0.1 );
				else if ( pfAxis == 3.0 ) diffuseColor.rgb = vec3( 0.1, 0.25, 0.85 );
			}`;

/**
 * Patch three's LineMaterial vertex shader so each segment picks its width on the GPU: normal
 * edges use `linewidth`, profiles use the `profileWidth` uniform. The decision is per segment
 * (`instanceNormalA/B`, `instanceFlags`), so no CPU work happens on camera change.
 * Exported for tests; `createEdgeMaterial` wires it through `onBeforeCompile`.
 */
export function patchEdgeShader(shader: EdgeShaderSource): void {
  const v = shader.vertexShader;
  if (!v.includes('uniform vec2 resolution;') || !v.includes('offset *= linewidth;') || !v.includes(DASH_ANCHOR)) {
    throw new Error('EdgeMaterial: three LineMaterial shader changed; profile patch cannot be applied');
  }
  shader.vertexShader = v
    .replace('uniform vec2 resolution;', ATTR_DECL)
    .replace(DASH_ANCHOR, DASH_SCREEN)
    .replace('offset *= linewidth;', WIDTH_SELECT);
  // Fragment: tag dash patterns and per-segment colors (skipped when the anchors are missing).
  const f = shader.fragmentShader;
  if (f.includes(FRAG_DECL_ANCHOR) && f.includes(FRAG_MAIN_ANCHOR)) {
    shader.fragmentShader = f.replace(FRAG_DECL_ANCHOR, FRAG_DECL).replace(FRAG_MAIN_ANCHOR, FRAG_MAIN).replace(FRAG_COLOR_ANCHOR, FRAG_COLOR);
  }
}

/** A LineMaterial with the profile patch and a `profileWidth` uniform. */
export class EdgeMaterial extends LineMaterial {
  constructor(opts: EdgeMaterialOptions = {}) {
    const dashed = opts.dashed ?? false;
    super({
      color: opts.color ?? EDGE_COLOR,
      linewidth: opts.width ?? DEFAULT_EDGE_WIDTH,
      worldUnits: false,
      dashed,
      dashSize: 4,
      gapSize: 3,
      dashScale: 1,
      depthTest: opts.depthTest ?? true,
      transparent: (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
      vertexColors: opts.vertexColors ?? false,
      fog: true,
    });
    this.uniforms['profileWidth'] = { value: opts.profileWidth ?? DEFAULT_PROFILE_WIDTH };
    this.uniforms['pfExtension'] = { value: 0 };
    this.uniforms['pfDepthCue'] = { value: 0 };
    this.uniforms['pfDepthRange'] = { value: new Vector2(0, 1) };
    this.uniforms['pfAxisColors'] = { value: 0 };
    this.resolution.set(1, 1);
    if (opts.backEdges) {
      this.depthFunc = GreaterDepth;
      this.depthWrite = false;
    }
    this.onBeforeCompile = (shader) => patchEdgeShader(shader as unknown as EdgeShaderSource);
    this.customProgramCacheKey = () => `pf-edge${this.dashed ? '-dashed' : ''}${this.vertexColors ? '-vc' : ''}`;
  }

  get profileWidth(): number {
    return this.uniforms['profileWidth']?.value as number;
  }
  set profileWidth(v: number) {
    const u = this.uniforms['profileWidth'];
    if (u) u.value = v;
  }

  /** Styles › Extension: px each end runs past its vertex; 0 is off. */
  get extension(): number { return this.uniforms['pfExtension']?.value as number; }
  set extension(px: number) { this.uniforms['pfExtension']!.value = px; }

  /** Styles › Depth cue: the nearest edges' width in px; 0 is off. */
  get depthCue(): number { return this.uniforms['pfDepthCue']?.value as number; }
  set depthCue(px: number) { this.uniforms['pfDepthCue']!.value = px; }

  /** Camera distances of the nearest and farthest geometry, between which depth cue thins edges. */
  setDepthRange(near: number, far: number): void { (this.uniforms['pfDepthRange']!.value as Vector2).set(near, far); }

  /** Styles › Edge color By Axis: edges along a model axis in its color. */
  get axisColors(): boolean { return (this.uniforms['pfAxisColors']?.value as number) > 0.5; }
  set axisColors(on: boolean) { this.uniforms['pfAxisColors']!.value = on ? 1 : 0; }

  setColorHex(hex: number): void {
    (this.color as Color).set(hex);
  }
}

export function createEdgeMaterial(opts: EdgeMaterialOptions = {}): EdgeMaterial {
  return new EdgeMaterial(opts);
}
