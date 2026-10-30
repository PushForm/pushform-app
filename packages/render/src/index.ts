// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// @pushform/render: three.js viewport, scene sync, styles, overlay, sections, shadows
export const PACKAGE = '@pushform/render';

export type {
  EdgeSegments,
  EntityHighlight,
  HighlightState,
  RenderAxes,
  RenderBody,
  RenderBodyEdge,
  RenderBodySurface,
  RenderDisplay,
  RenderEditContext,
  RenderFaceStyle,
  RenderGuides,
  RenderDimension,
  RenderDimensions,
  RenderPath,
  RenderSectionCut,
  RenderSectionPlane,
  RenderSections,
  RenderSketch,
  RenderSketchEdge,
  RenderSketchFace,
  RenderFaceCamera,
  RenderImage,
  RenderText,
  RenderTextArrow,
  RenderTexts,
} from './types';
export {
  DEFAULT_DISPLAY,
  DEFAULT_RENDER_AXES,
  EDGE_FLAG_BOUNDARY,
  EDGE_FLAG_HIDDEN,
  EDGE_FLAG_SMOOTH,
  EDGE_FLAG_SOFT,
  EMPTY_GUIDES,
  EMPTY_DIMENSIONS,
  EMPTY_TEXTS,
  EMPTY_HIGHLIGHT,
  EMPTY_SECTIONS,
  EMPTY_SEGMENTS,
  ROOT_EDIT_CONTEXT,
  cutsFor,
  renderKey,
  renderKeyWithinInstance,
  renderPathKey,
  renderPathWithin,
  segmentsFromPositions,
} from './types';
export { Viewport } from './Viewport';
export type { ImageOptions, SnapshotOptions, ViewportEvents, ViewportOptions } from './Viewport';
export { CameraController } from './camera/CameraController';
export type { CameraControllerEvents, CameraControllerHooks } from './camera/CameraController';
export * from './camera/CameraState';
export { SceneSync } from './SceneSync';
export type { EdgeStyle, ResolvedEdgeStyle } from './SceneSync';
export { XRAY_OPACITY, CONTEXT_BOX_COLOR } from './SceneSync';
export {
  BodyRenderable,
  createBodyMaterials,
  patchSelectTint,
  fillFlags,
  fillColorAttribute,
  FRONT_COLOR,
  BACK_COLOR,
  SELECT_COLOR,
  HIDDEN_EDGE_COLOR,
  BACK_EDGE_COLOR,
  FADE_OPACITY,
  FADED_EDGE_COLOR,
  FADED_EDGE_OPACITY,
} from './renderables/BodyRenderable';
export type { BodyMaterials, BodyMaterialOptions } from './renderables/BodyRenderable';
export { EdgeBatch } from './renderables/EdgeBatch';
export { EdgeMaterial, createEdgeMaterial, patchEdgeShader, DEFAULT_EDGE_WIDTH, DEFAULT_PROFILE_WIDTH } from './renderables/EdgeMaterial';
export type { EdgeMaterialOptions, EdgeShaderSource } from './renderables/EdgeMaterial';
export { buildFaceGeometry, buildFaceArrays, buildBodyEdgeSegments, extractEdges, extractEdgeSegments, meshFaceNormals, transformedVerts } from './renderables/buildGeometry';
export type { BodyEdgeSegments, FaceArrays, FaceGeometryOptions } from './renderables/buildGeometry';
export { ImageLayer, ImageRenderable, buildImageArrays, imageCorners, MISSING_IMAGE_COLOR } from './renderables/ImageLayer';
export { GuideLayer, buildGuideGeometry, GUIDE_COLOR, GUIDE_EXTENT, GUIDE_POINT_SIZE } from './renderables/GuideLayer';
export type { GuideGeometry } from './renderables/GuideLayer';
export { SectionLayer, SECTION_PLANE_OPACITY } from './renderables/SectionLayer';
export type { SectionBody } from './renderables/SectionLayer';
export { sectionSegments, clipPlaneOf, setObjectClipping } from './renderables/sectionGeometry';
export { DimensionLayer, buildDimensionLines, buildArrowTriangles, DIMENSION_COLOR, DIMENSION_ARROW_PX } from './renderables/DimensionLayer';
export { TextLayer, textLabelPoint, textArrowGeometry, TEXT_ARROW_PX } from './renderables/TextLayer';
export { SketchRenderable, buildSketchGeometry, createSketchMaterials } from './renderables/SketchRenderable';
export { applyFaceCamera, faceCameraAngle } from './renderables/faceCamera';
export type { SketchGeometryData, SketchGeometryOptions, SketchMaterials } from './renderables/SketchRenderable';
export { HighlightLayer, buildHighlightGeometry, loopBasis, box3Segments } from './renderables/HighlightLayer';
export type { HighlightGeometry } from './renderables/HighlightLayer';
export { PreviewLayer, PREVIEW_OPACITY } from './renderables/PreviewLayer';
export { OverlayLayer, circleSegments, boxSegments } from './overlay/OverlayLayer';
export { GroundGrid } from './scene/GroundGrid';
export { Axes } from './scene/Axes';
export { SkyBackground, DEFAULT_RENDER_BACKGROUND } from './scene/SkyBackground';
export type { RenderBackground } from './types';

// Tags (dash patterns, per-edge colors), shadows (NOAA sun) and fog
export { EDGE_FLAG_DASH, EDGE_FLAG_DOT, EDGE_FLAG_COLORED, edgeStyleFlags, cssToRgb, DEFAULT_RENDER_SHADOWS, DEFAULT_RENDER_FOG } from './types';
export type { RenderShadows, RenderFog } from './types';
export { solarPosition, sunDirection, julianDay, DEFAULT_SOLAR_YEAR } from './shadows/SolarPosition';
export type { SolarInput, SolarPosition } from './shadows/SolarPosition';
export { SunLight, SHADOW_MAP_SIZE, DEFAULT_SUN_DIRECTION, BASE_SUN_INTENSITY, BASE_AMBIENT_INTENSITY, GROUND_SHADOW_OPACITY } from './shadows/SunLight';
export { shadowDisplay } from './renderables/BodyRenderable';

// Materials: per-face colors / textures (materials agent)
export type { RenderMaterial, RenderUvMapping, RenderFaceMaterial, RenderFaceGroup } from './types';
export { faceMaterialNeedsGroup } from './renderables/buildGeometry';
export { TextureCache, TexturedMaterialCache, colorizedImageUrl, needsOwnMaterial } from './materials/TextureCache';
export type { TexturedDisplay } from './materials/TextureCache';
