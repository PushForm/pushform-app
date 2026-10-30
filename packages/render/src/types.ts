// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Box3, Mat4, MeshData, PlaneBasis, Vec3 } from '@pushform/core';

/**
 * Instance path of a render entity: the ComponentInstance ids from the root down to the container
 * that owns it (empty = root container). Mirrors the model's `EntityRef.path`.
 */
export type RenderPath = readonly number[];

/** Stable key of an instance path (the model's `pathKey`): ids joined by `.`, `''` for the root. */
export const renderPathKey = (path: RenderPath): string => path.join('.');

/** Render key of an entity: `${pathKey(path)}/${id}`; unique across instances of one definition. */
export const renderKey = (path: RenderPath, id: number): string => `${renderPathKey(path)}/${id}`;

/** True when `path` starts with `prefix` (the entity lives inside the context `prefix`). */
export function renderPathWithin(path: RenderPath, prefix: RenderPath): boolean {
  if (path.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (path[i] !== prefix[i]) return false;
  return true;
}

/**
 * True when a body/sketch render key belongs to the instance whose path key is `instanceKey`
 * (the entity's path equals the instance path or descends from it).
 */
export function renderKeyWithinInstance(key: string, instanceKey: string): boolean {
  return key.startsWith(`${instanceKey}/`) || key.startsWith(`${instanceKey}.`);
}

/**
 * Minimal body description the renderer consumes. `packages/model` adapts its documents to this
 * shape; the renderer never imports model types directly.
 */
/**
 * Always Face Camera: draw the object turned about `axis` through `pivot` so that `front` faces the camera,
 * and with `shadowsFaceSun` cast its shadow as if turned to face the sun. World coordinates; `front` is
 * the placement's front direction as placed (its negative green axis). Not compared when diffing.
 */
export interface RenderFaceCamera {
  readonly pivot: Vec3;
  readonly axis: Vec3;
  readonly front: Vec3;
  readonly shadowsFaceSun: boolean;
}

export interface RenderBody {
  /** `renderKey(path, entityId)`. */
  readonly id: string;
  /** Instance path of the container owning the body (empty = root). */
  readonly path: RenderPath;
  /** The model body id. */
  readonly entityId: number;
  /** Bump to force a rebuild. When absent, the `mesh` object identity is used for diffing. */
  readonly version?: number | undefined;
  readonly mesh: MeshData;
  /** Column-major world transform (the instance chain's accumulated matrix). */
  readonly transform: Mat4;
  /**
   * CSS color for faces with no material of their own (body material, else the instance material).
   * Undefined = the style's default front/back colors.
   */
  readonly defaultColor?: string | undefined;
  /**
   * Body edge polylines with flags (model `EdgeRecord`s, body-local coordinates). When present
   * they are drawn instead of edges extracted from the mesh. Compared by identity for diffing:
   * hand the renderer a stable array while the edges are unchanged.
   */
  readonly edges?: ReadonlyArray<RenderBodyEdge> | undefined;
  /** Smooth face groups (model `SurfaceRecord`s): shaded with averaged normals. Compared by identity. */
  readonly surfaces?: ReadonlyArray<RenderBodySurface> | undefined;
  /** Entity shadow flags (default true). */
  readonly castShadows?: boolean | undefined;
  readonly receiveShadows?: boolean | undefined;
  /** Inside a placement of a component that Always Faces Camera. */
  readonly faceCamera?: RenderFaceCamera | undefined;
  /**
   * Per-face materials (face id → front/back material + UV mapping; the adapter resolves the
   * body/instance default for faces without an explicit material). Compared by identity for
   * diffing. Absent = every face takes `defaultColor`.
   */
  readonly faceMaterials?: ReadonlyMap<number, RenderFaceMaterial> | undefined;
  /** Faces omitted from the normal view; shown when hidden geometry is enabled. */
  readonly hiddenFaces?: ReadonlySet<number> | undefined;
}

/** A material as the renderer sees it (CSS color, opacity and an optional texture image URL). */
export interface RenderMaterial {
  readonly id: number;
  readonly color: string;
  readonly alpha: number;
  /** Object/data URL of the texture image; undefined = plain color. */
  readonly textureUrl?: string | undefined;
  /** World size of one texture tile in meters. */
  readonly widthM?: number | undefined;
  readonly heightM?: number | undefined;
  /** Colorize the texture toward `color`; undefined shows its image colors. */
  readonly colorize?: 'shift' | 'tint' | undefined;
}

/**
 * Face UV mapping (mirrors the model's `UvMapping`): `auto` = face basis (u, v) in meters divided
 * by the texture size; `affine` = 2×3 matrix from face (u, v) to texture tiles (texture pins);
 * `projective` = 3×3 matrix to (s', t', q), shown at (s'/q, t'/q) (distorted pins); `sized` = 2×3
 * matrix to texture-frame meters, divided by the texture size.
 */
export type RenderUvMapping =
  | { readonly kind: 'auto' }
  | { readonly kind: 'affine'; readonly matrix: readonly [number, number, number, number, number, number] }
  | { readonly kind: 'projective'; readonly matrix: readonly [number, number, number, number, number, number, number, number, number] }
  | { readonly kind: 'sized'; readonly matrix: readonly [number, number, number, number, number, number] };

export interface RenderFaceMaterial {
  readonly front: RenderMaterial | null;
  readonly back: RenderMaterial | null;
  readonly uv: RenderUvMapping;
  /** Back-side mapping where it differs from `uv`. */
  readonly uvBack?: RenderUvMapping | undefined;
  /** Face basis in body-local coordinates (origin, u, v, n) for the UV computation. */
  readonly basis: PlaneBasis;
}

/** A contiguous vertex range of a face geometry drawn with one material (null = the shared default). */
export interface RenderFaceGroup {
  readonly start: number;
  readonly count: number;
  readonly material: RenderMaterial | null;
}

export interface RenderBodyEdge {
  readonly points: readonly Vec3[];
  readonly soft: boolean;
  readonly smooth: boolean;
  readonly hidden: boolean;
  readonly faceA: number;
  readonly faceB: number;
  /** CSS color overriding the style edge color (Color by Tag). */
  readonly color?: string | undefined;
  /** Tag dash pattern: 'dash' | 'dot' (others draw solid); null/undefined = solid. */
  readonly dashes?: string | null | undefined;
}

export interface RenderBodySurface {
  readonly faceIds: readonly number[];
}

/**
 * A placed picture (an image entity): a rectangle `widthM` × `heightM` from the origin along the local x and y
 * axes of `transform` (world), showing the picture on both sides. `textureUrl` is null while its bytes are missing.
 */
export interface RenderImage {
  /** Render key of the entity (`renderKey(path, entityId)`). */
  readonly key: string;
  /** Instance path of the container holding it. */
  readonly path: RenderPath;
  readonly entityId: number;
  readonly transform: Mat4;
  readonly widthM: number;
  readonly heightM: number;
  readonly textureUrl: string | null;
  readonly castShadows: boolean;
  readonly receiveShadows: boolean;
}

/** Construction guides in world coordinates (infinite dashed lines, finite segments, point glyphs). */
export interface RenderGuides {
  readonly lines: ReadonlyArray<{ readonly id: number; readonly p: Vec3; readonly dir: Vec3 }>;
  readonly points: ReadonlyArray<{ readonly id: number; readonly p: Vec3 }>;
  /** Finite guide lines (Tape Measure from an edge endpoint). */
  readonly segments?: ReadonlyArray<{ readonly id: number; readonly a: Vec3; readonly b: Vec3 }> | undefined;
}

export const EMPTY_GUIDES: RenderGuides = { lines: [], points: [] };

/** One drawn dimension, world coordinates. */
export interface RenderDimension {
  readonly id: number;
  /** Extension lines, dimension line and leaders. */
  readonly lines: ReadonlyArray<readonly [Vec3, Vec3]>;
  /** Arrowheads: the tip and the unit direction from the tip back along its line. */
  readonly arrows: ReadonlyArray<{ readonly tip: Vec3; readonly back: Vec3 }>;
  readonly text: string;
  readonly textAt: Vec3;
  readonly fontSizePt: number;
  readonly selected: boolean;
  /** Endpoints; default closed arrows. */
  readonly arrow?: RenderTextArrow | undefined;
  /**
   * Text along a linear dimension's line: the line's unit direction and the unit direction from the measured
   * points out to the line, both in the dimension's plane, and where the text sits; absent = facing the screen.
   */
  readonly aligned?: { readonly along: Vec3; readonly out: Vec3; readonly position: 'above' | 'centered' | 'outside' } | undefined;
}

export interface RenderDimensions {
  readonly items: readonly RenderDimension[];
}

/** A text's leader arrow. */
export type RenderTextArrow = 'none' | 'slash' | 'dot' | 'closed' | 'open';

/** One drawn text, world coordinates; laid out each frame because it depends on the view. */
export interface RenderText {
  /** `renderKey(path, id)`. */
  readonly id: string;
  readonly text: string;
  readonly kind: 'leader' | 'screen';
  /** Leader text: the world anchor. Screen text: [x, y, 0] as fractions of the view from its top-left corner. */
  readonly position: Vec3;
  /** A pushpin leader's label offset from the anchor, world. */
  readonly offset: Vec3 | null;
  /** A view-based leader's label offset along the view's right and up directions, meters. */
  readonly viewOffset: readonly [number, number] | null;
  readonly leader: 'none' | 'view' | 'pushpin';
  readonly arrow: RenderTextArrow;
  /** CSS color. */
  readonly color: string;
  readonly fontSizePt: number;
  readonly selected: boolean;
}

export interface RenderTexts {
  readonly items: readonly RenderText[];
}

export const EMPTY_TEXTS: RenderTexts = { items: [] };

export const EMPTY_DIMENSIONS: RenderDimensions = { items: [] };

/** Drawing axes placement (origin + unit directions), world coordinates. */
export interface RenderAxes {
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
}

export const DEFAULT_RENDER_AXES: RenderAxes = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

export type RenderFaceStyle = 'shaded' | 'shadedTextured' | 'wireframe' | 'hiddenLine' | 'monochrome';

/** Display settings (View menu / Display panel); `Viewport.setDisplay` accepts a partial update. */
export interface RenderDisplay {
  /** Draw soft/hidden edges dashed and hidden faces. */
  readonly hiddenGeometry: boolean;
  /** Draw edges at all. */
  readonly edges: boolean;
  /** Draw profiles/silhouettes thicker. */
  readonly profiles: boolean;
  readonly guides: boolean;
  readonly axes: boolean;
  /** Second edge pass showing obscured edges dashed (exclusive with X-ray). */
  readonly backEdges: boolean;
  /** Transparent faces, edges always on top. */
  readonly xray: boolean;
  readonly faceStyle: RenderFaceStyle;
  /** Edge color (hex) of the style's All Same mode; default near-black. */
  readonly edgeColor?: number | undefined;
  /** Edges along a model axis in the axis color (Styles › Edge color By Axis). */
  readonly edgeAxisColors?: boolean | undefined;
  /** Profile width in px. */
  readonly profileWidth?: number | undefined;
  /** Depth cue: the nearest edges' width in px, 0 for off. */
  readonly depthCue?: number | undefined;
  /** Extension: px each edge runs past its ends, 0 for off. */
  readonly edgeExtension?: number | undefined;
  /** Front and back colors (hex) of faces painted with the default material. */
  readonly faceFrontColor?: number | undefined;
  readonly faceBackColor?: number | undefined;
  /** Face opacity in X-ray mode. */
  readonly xrayOpacity?: number | undefined;
  /** The Selected and Guides colors (hex) of the style's Modeling settings. */
  readonly selectedColor?: number | undefined;
  readonly guideColor?: number | undefined;
}

export const DEFAULT_DISPLAY: RenderDisplay = {
  hiddenGeometry: false,
  edges: true,
  profiles: true,
  guides: true,
  axes: true,
  backEdges: false,
  xray: false,
  faceStyle: 'shaded',
};

/** A planar sketch face (outer loop first, then holes), world coordinates. */
export interface RenderSketchFace {
  readonly id: number;
  readonly loops: readonly (readonly Vec3[])[];
  readonly basis: PlaneBasis;
  /** CSS color; defaults to the style's front/back face color. */
  readonly frontColor?: string | undefined;
  readonly backColor?: string | undefined;
  readonly hidden: boolean;
  /** Materials with textures (the colors above stay the fallback); `uv` maps face basis (u, v) to tiles. */
  readonly frontMaterial?: RenderMaterial | null | undefined;
  readonly backMaterial?: RenderMaterial | null | undefined;
  readonly uv?: RenderUvMapping | undefined;
  /** Back-side mapping where it differs from `uv`. */
  readonly uvBack?: RenderUvMapping | undefined;
  /**
   * Basis giving each world point its (u, v) in the face's own definition coordinates, for texture
   * coordinates; default `basis`. Under an instance transform it is not orthonormal, so textures
   * follow the instance's rotation, scale and mirroring like its geometry.
   */
  readonly uvBasis?: PlaneBasis | undefined;
}

export interface RenderSketchEdge {
  readonly id: number;
  readonly a: Vec3;
  readonly b: Vec3;
  readonly soft: boolean;
  readonly smooth: boolean;
  readonly hidden: boolean;
  /** CSS color overriding the style edge color (Color by Tag). */
  readonly color?: string | undefined;
  /** Tag dash pattern ('dash' | 'dot'); null/undefined = solid. */
  readonly dashes?: string | null | undefined;
}

/**
 * The sketch (loose geometry) of one container. `version` is compared by identity: hand the
 * renderer the immutable sketch object itself (or any token that changes with it).
 */
export interface RenderSketch {
  /** `renderPathKey(path)`: one sketch per container. */
  readonly id: string;
  readonly path: RenderPath;
  readonly version: unknown;
  readonly faces: readonly RenderSketchFace[];
  readonly edges: readonly RenderSketchEdge[];
  /** Inside a placement of a component that Always Faces Camera. */
  readonly faceCamera?: RenderFaceCamera | undefined;
  /**
   * Shadows of the container's faces: false when it, or a group or component containing it, does not cast
   * or receive them. Default true.
   */
  readonly castShadows?: boolean | undefined;
  readonly receiveShadows?: boolean | undefined;
}

/** What to highlight; built by the UI from EntityRefs so the renderer stays model-free. */
export type EntityHighlight =
  | { readonly kind: 'face'; readonly key: string; readonly faceId: number; readonly loops: readonly (readonly Vec3[])[] }
  | { readonly kind: 'edge'; readonly points: readonly Vec3[] }
  /** Whole-body tint; `key` is the body's render key. */
  | { readonly kind: 'body'; readonly key: string }
  /** A component instance: its world bounding box drawn as a box, every body inside it tinted. `key` is the instance's path key. */
  | { readonly kind: 'instance'; readonly key: string; readonly bounds: Box3 }
  | { readonly kind: 'sketchFace'; readonly id: number; readonly loops: readonly (readonly Vec3[])[] }
  | { readonly kind: 'sketchEdge'; readonly id: number; readonly a: Vec3; readonly b: Vec3 }
  | { readonly kind: 'sketchVertex'; readonly p: Vec3 }
  /** A placed picture: its rectangle tinted and outlined; `key` is its render key. */
  | { readonly kind: 'image'; readonly key: string; readonly corners: readonly Vec3[] }
  /** A guide: `dir` set = infinite line through `p` (or finite to `end` when given); `dir` null = guide point. */
  | { readonly kind: 'guide'; readonly id: number; readonly p: Vec3; readonly dir: Vec3 | null; readonly end?: Vec3 | undefined };

export interface HighlightState {
  readonly hover: EntityHighlight | null;
  readonly selected: readonly EntityHighlight[];
}

export const EMPTY_HIGHLIGHT: HighlightState = { hover: null, selected: [] };

/**
 * Component edit display (open group or component): entities outside the open context are
 * faded or hidden, and the context instance's world bounds are drawn as a dashed box.
 */
export interface RenderEditContext {
  /** Instance path of the open context (empty = root: nothing faded, no box). */
  readonly path: RenderPath;
  /** World bounds of the context instance's contents, or null when empty / at the root. */
  readonly bounds: Box3 | null;
  /** Fade (translucent faces, grey edges) everything outside the context. */
  readonly fadeOthers: boolean;
  /** Hide everything outside the context (takes precedence over fading). */
  readonly hideOthers: boolean;
}

export const ROOT_EDIT_CONTEXT: RenderEditContext = { path: [], bounds: null, fadeOthers: true, hideOthers: false };

/** Per-segment edge flags (bit set) carried in the `instanceFlags` attribute. */
export const EDGE_FLAG_BOUNDARY = 1;
export const EDGE_FLAG_SOFT = 2;
export const EDGE_FLAG_SMOOTH = 4;
export const EDGE_FLAG_HIDDEN = 8;

/**
 * Edge segments for an EdgeBatch: `positions` is [x1,y1,z1,x2,y2,z2,...]; `normalA`/`normalB` are
 * the unit normals of the two faces adjacent to each segment (`normalB` zero + BOUNDARY flag when
 * the segment bounds a single face). The shader widens a segment to the profile width when the
 * two normals face opposite ways relative to the camera (silhouette) or it is a boundary.
 */
export interface EdgeSegments {
  readonly positions: Float32Array;
  readonly normalA: Float32Array;
  readonly normalB: Float32Array;
  readonly flags: Uint8Array;
  /** Optional per-segment start/end RGB (6 floats per segment) for `EDGE_FLAG_COLORED` segments. */
  readonly colors?: Float32Array | undefined;
}

export const EMPTY_SEGMENTS: EdgeSegments = {
  positions: new Float32Array(0),
  normalA: new Float32Array(0),
  normalB: new Float32Array(0),
  flags: new Uint8Array(0),
};

/** Wrap bare positions as segments drawn at the normal width (both normals +Z, no flags). */
export function segmentsFromPositions(positions: Float32Array): EdgeSegments {
  const n = positions.length / 6;
  const normalA = new Float32Array(n * 3);
  const normalB = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    normalA[i * 3 + 2] = 1;
    normalB[i * 3 + 2] = 1;
  }
  return { positions, normalA, normalB, flags: new Uint8Array(n) };
}

/** Style background: solid color, or a sky/ground gradient (style background). */
export interface RenderBackground {
  readonly color: string;
  readonly sky: boolean;
  readonly skyColor: string;
  readonly ground: boolean;
  readonly groundColor: string;
  /** 0 = opaque ground, 1 = fully transparent (shows the background color). */
  readonly groundTransparency: number;
}

// --- tags: dash patterns and per-edge colors (flag bits 16/32/64) -------------------------------

/** Tag dash pattern "dash": drawn 6 px on / 4 px off in screen space. */
export const EDGE_FLAG_DASH = 16;
/** Tag dash pattern "dot": 2 px on / 3 px off. */
export const EDGE_FLAG_DOT = 32;
/** The segment carries its own color in the `instanceColorStart/End` attributes (Color by Tag). */
export const EDGE_FLAG_COLORED = 64;

/** Flag bits for an edge's tag dash pattern and explicit color. */
export function edgeStyleFlags(e: { readonly dashes?: string | null | undefined; readonly color?: string | undefined }): number {
  let f = 0;
  if (e.dashes === 'dash' || e.dashes === 'longDash' || e.dashes === 'shortDash') f |= EDGE_FLAG_DASH;
  else if (e.dashes === 'dot' || e.dashes === 'dashDot') f |= EDGE_FLAG_DOT;
  if (e.color) f |= EDGE_FLAG_COLORED;
  return f;
}

/** Parse a CSS hex color (`#rgb` / `#rrggbb`) to 0..1 components; white for anything else. */
export function cssToRgb(css: string | undefined): [number, number, number] {
  if (!css) return [1, 1, 1];
  let h = css.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h[0]! + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return [1, 1, 1];
  const v = parseInt(h, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Sun/shadow settings for `Viewport.setShadows`. */
export interface RenderShadows {
  readonly enabled: boolean;
  /** Unit vector from the scene toward the sun (world, Z up). */
  readonly sunDirection: Vec3;
  /** Sun above the horizon; below, shadows are off and the sun light is disabled. */
  readonly sunUp: boolean;
  /** Styles' Light (0..100): sun intensity. */
  readonly light: number;
  /** Styles' Dark (0..100): ambient intensity (lower = darker shadows). */
  readonly dark: number;
  /** Shade faces with the sun direction even when shadows are off. */
  readonly useSunForShading: boolean;
  readonly onFaces: boolean;
  readonly onGround: boolean;
  readonly fromEdges: boolean;
}

export const DEFAULT_RENDER_SHADOWS: RenderShadows = {
  enabled: false,
  sunDirection: [0.5, -0.4, 0.77],
  sunUp: true,
  light: 80,
  dark: 45,
  useSunForShading: true,
  onFaces: true,
  onGround: true,
  fromEdges: false,
};

/** Fog for `Viewport.setFog`: linear fog in meters from the eye. */
export interface RenderFog {
  readonly enabled: boolean;
  readonly near: number;
  readonly far: number;
  /** CSS color (the background color when the style's "use background" is on). */
  readonly color: string;
}

export const DEFAULT_RENDER_FOG: RenderFog = { enabled: false, near: 0, far: 100, color: '#ffffff' };

// --- section planes and cuts -----------------------------------------------------------

/** A section plane as drawn: a rectangle on its plane with its symbol, world coordinates. */
export interface RenderSectionPlane {
  /** `renderKey(path, entityId)`. */
  readonly id: string;
  /** Instance path of the container that holds the plane. */
  readonly path: RenderPath;
  readonly entityId: number;
  /** Rectangle corners in order around it, on the plane. */
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3];
  /** Unit normal pointing to the side the cut keeps. */
  readonly normal: Vec3;
  readonly symbol: string;
  /** The active cut of its container. */
  readonly active: boolean;
  readonly selected: boolean;
}

/**
 * The active cut of one container: it removes, from everything inside the container at `path` (nested
 * groups and components included), the points `p` with `dot(normal, p) + d < 0`.
 */
export interface RenderSectionCut {
  /** `renderKey(path, entityId)` of the section plane. */
  readonly key: string;
  readonly path: RenderPath;
  readonly normal: Vec3;
  readonly d: number;
}

export interface RenderSections {
  readonly planes: readonly RenderSectionPlane[];
  readonly cuts: readonly RenderSectionCut[];
  /** Fill the cut faces of solids (Styles › Section Fill). */
  readonly fill: boolean;
  /** CSS colors from the style: active and inactive plane, fill and section lines. */
  readonly activeColor: string;
  readonly inactiveColor: string;
  readonly fillColor: string;
  readonly lineColor: string;
  /** Section line width in CSS px. */
  readonly lineWidth: number;
}

export const EMPTY_SECTIONS: RenderSections = {
  planes: [], cuts: [], fill: true, activeColor: '#ff7f00', inactiveColor: '#7f7f7f', fillColor: '#515151', lineColor: '#000000', lineWidth: 3,
};

/** Cuts that apply to an entity at `path`: those of its own container and of every container it lies in. */
export function cutsFor(cuts: readonly RenderSectionCut[], path: RenderPath): RenderSectionCut[] {
  return cuts.filter((c) => renderPathWithin(path, c.path));
}
