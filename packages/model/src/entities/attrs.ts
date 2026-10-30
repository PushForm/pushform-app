// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Id, ImageId, MaterialId, SceneId, StyleId, TagFolderId, TagId, Vec3 } from '@pushform/core';
import type { ColorizeType } from '../colorize';

export type Rgb = readonly [number, number, number]; // 0..1

export interface MaterialTexture {
  imageId: ImageId;
  widthM: number;
  heightM: number;
  /** The texture is colorized toward the material color; false shows its image colors. */
  colorize: boolean;
  /** Colorize type: `shift` (the default) moves each pixel's hue, `tint` replaces it. */
  colorizeType?: ColorizeType | undefined;
}
export interface Material {
  id: MaterialId;
  name: string;
  color: Rgb;
  alpha: number;
  texture: MaterialTexture | null;
}

/** Image asset referenced by textures and image entities (bytes live in the file package). */
export interface ImageAsset {
  id: ImageId;
  name: string;
  mime: string;
  width: number;
  height: number;
  /** Content hash for dedupe; the blob itself is stored outside the document state. */
  sha256: string;
}

/**
 * Face UV mapping: `auto` = face basis (u, v) in meters divided by texture size;
 * `affine` = explicit 2x3 matrix from face (u, v) to texture coordinates (texture pins);
 * `projective` = a distorted (four-pin) placement: the rows of the 3x3 matrix map (u, v, 1) to
 * (s', t', q), and the side shows tile (s'/q, t'/q);
 * `sized` = the automatic placement in another frame: the 2x3 matrix maps (u, v) to meters in the
 * texture's frame, which are divided by the size of the texture the side shows.
 */
export type UvMapping =
  | { kind: 'auto' }
  | { kind: 'affine'; matrix: readonly [number, number, number, number, number, number] }
  | { kind: 'projective'; matrix: readonly [number, number, number, number, number, number, number, number, number] }
  | { kind: 'sized'; matrix: readonly [number, number, number, number, number, number] };

export const UV_AUTO: UvMapping = { kind: 'auto' };

export interface Tag {
  id: TagId;
  name: string;
  visible: boolean;
  color: Rgb;
  /** Dash pattern name ("solid", "dash", "dot", ...) or null for solid. */
  dashes: string | null;
  folderId: TagFolderId | null;
}
export interface TagFolder {
  id: TagFolderId;
  name: string;
  visible: boolean;
  parentId: TagFolderId | null;
}

export interface CameraState {
  eye: Vec3;
  target: Vec3;
  up: Vec3;
  perspective: boolean;
  /** Vertical field of view in degrees (perspective) */
  fov: number;
  /** View height in meters (parallel projection) */
  height: number;
}

export interface SceneFlags {
  useCamera: boolean;
  useHiddenGeometry: boolean;
  useHiddenObjects: boolean;
  useTags: boolean;
  useStyle: boolean;
  useShadows: boolean;
  useSectionPlanes: boolean;
  useAxes: boolean;
}
export interface Scene {
  id: SceneId;
  name: string;
  description: string;
  camera: CameraState;
  flags: SceneFlags;
  hiddenEntities: Id[];
  hiddenTags: TagId[];
  hiddenTagFolders: TagFolderId[];
  styleId: StyleId | null;
  shadows: ShadowSettings | null;
  /** Fog saved with the style ("Style and Fog"); undefined on scenes from older files. */
  fog?: FogSettings | null | undefined;
  /** Active section plane per definition path key, or empty. */
  activeSectionPlanes: Id[];
  axesVisible: boolean;
  /** Played by the scene animation (default true). */
  includeInAnimation?: boolean | undefined;
}

export type EdgeStyleMode = 'allSame' | 'byMaterial' | 'byAxis';
export type FaceStyleMode = 'wireframe' | 'hiddenLine' | 'shaded' | 'shadedWithTextures' | 'monochrome' | 'xray';

export interface EdgeStyle {
  edges: boolean;
  profiles: boolean;
  profileWidth: number;
  depthCue: boolean;
  depthCueLevels: number;
  extension: boolean;
  extensionLength: number;
  endpoints: boolean;
  endpointLength: number;
  jitter: boolean;
  backEdges: boolean;
  color: Rgb;
  colorMode: EdgeStyleMode;
}
export interface FaceStyle {
  mode: FaceStyleMode;
  frontColor: Rgb;
  backColor: Rgb;
  xrayOpacity: number;
  /** Styles › Face "Enable transparency" quality (kept for scripts; the renderer sorts in every mode). */
  transparencyQuality?: 'faster' | 'medium' | 'nicer' | undefined;
}
export interface BackgroundStyle {
  color: Rgb;
  sky: boolean;
  skyColor: Rgb;
  ground: boolean;
  groundColor: Rgb;
  groundTransparency: number;
  showGroundFromBelow: boolean;
}
export interface ModelingColors {
  selected: Rgb;
  locked: Rgb;
  guides: Rgb;
  inactiveSection: Rgb;
  activeSection: Rgb;
  sectionFill: Rgb;
  sectionLine: Rgb;
  sectionLineWidth: number;
  sectionFillEnabled: boolean;
  hiddenGeometry: boolean;
  guidesVisible: boolean;
  sectionPlanesVisible: boolean;
  sectionCutsVisible: boolean;
  modelAxesVisible: boolean;
  /** Color faces and edges by their tag's color (Styles › Modeling "Color by Tag"). */
  colorByTag?: boolean | undefined;
}
export interface Style {
  id: StyleId;
  name: string;
  description: string;
  edges: EdgeStyle;
  faces: FaceStyle;
  background: BackgroundStyle;
  modeling: ModelingColors;
  /** Watermark images (screen quads). */
  watermarks: { imageId: ImageId; position: 'background' | 'overlay'; opacity: number; nativeUnknownFields?: Uint8Array[] }[];
}

export interface ShadowSettings {
  enabled: boolean;
  /** Month 1..12 and day of month. */
  month: number;
  day: number;
  /** Minutes since midnight, local time. */
  time: number;
  utcOffsetHours: number;
  latitude: number;
  longitude: number;
  /** Degrees, clockwise rotation of model north from the +y axis. */
  northAngle: number;
  light: number;
  dark: number;
  useSunForShading: boolean;
  onGround: boolean;
  onFaces: boolean;
  fromEdges: boolean;
}

/** Fog (catalog B.3 "Fog"): linear fog between `near` and `far` meters from the eye. */
export interface FogSettings {
  enabled: boolean;
  near: number;
  far: number;
  /** Use the style's background color instead of `color`. */
  useBackground: boolean;
  color: Rgb;
}
