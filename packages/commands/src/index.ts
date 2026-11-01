// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// @pushform/commands: Command registry, tools, VCB parser, keymap, scripting
export const PACKAGE = '@pushform/commands';

export type { Command, AnyCommand, CommandCategory, CommandContext, TransactionHost, ToolHost } from './registry/Command';
export { defineCommand, MemoryTransactionHost } from './registry/Command';
export { CommandRegistry } from './registry/CommandRegistry';
export type { CommandInfo, CommandRegistryEvents } from './registry/CommandRegistry';
export { editCommands } from './registry/editCommands';

export type { CameraHost, CameraState, Projection, StandardView } from './camera/CameraHost';
export { cameraCommands } from './camera/cameraCommands';

export type * from './tools/overlay';
export type {
  Tool,
  ToolContext,
  ToolPointerEvent,
  ToolKeyEvent,
  ToolWheelEvent,
  ToolStatus,
  EntryField,
  EntryFieldKind,
  Modifiers,
  InferenceResult,
} from './tools/Tool';
export { NO_MODIFIERS } from './tools/Tool';
export { ToolManager } from './tools/ToolManager';
export type { ToolManagerEvents, ToolManagerOptions } from './tools/ToolManager';
export { OrbitTool } from './tools/impl/Orbit';
export { PanTool } from './tools/impl/Pan';
export { ZoomTool } from './tools/impl/Zoom';
export { ZoomWindowTool } from './tools/impl/ZoomWindow';
export { SelectTool } from './tools/impl/Select';
export { LassoTool, lassoModeOf } from './tools/impl/Lasso';
export type { BoxPickRect, BoxSelectMode } from './tools/impl/Select';
export { LineTool } from './tools/impl/Line';
export { RectangleTool } from './tools/impl/Rectangle';
export type { RectangleParams } from './tools/impl/Rectangle';
export { EraserTool } from './tools/impl/Eraser';
export { sketchTools } from './tools/sketchTools';
export { entityOverlay, inferenceOverlay, worldPerPixelAt } from './tools/toolUtil';
export { placeholderTool } from './tools/impl/Placeholder';

export { Keymap, chordFromEvent, normalizeChord, formatChord, detectPlatform } from './keymap/Keymap';
export type { KeyBinding, KeymapJson, KeyEventLike, Platform } from './keymap/Keymap';

export { parseVcb } from './vcb/parse';
export type { VcbValue, VcbScalar, VcbKind, VcbParseResult, VcbParseError } from './vcb/parse';

export { ScriptRunner, ScriptSchema, ScriptStepSchema } from './scripting/ScriptRunner';
export type { Script, ScriptStep, ScriptStepResult, ScriptRunOptions } from './scripting/ScriptRunner';
export * from './host/DocumentHost';
export * from './host/services';
export * from './commands/model';
export * from './commands/sketch';
export * from './commands/sketchQueries';
export * from './commands/pushpull';
export { PushPullTool, pushPullTools } from './tools/impl/PushPull';
export { LayoutDocumentHost, layoutCommands, createLayoutRegistry } from './commands/layout';
export { LAYOUT_TOOL_IDS, LAYOUT_TOOLS, SERVICE_LAYOUT_WORKSPACE, layoutToolCommandId, layoutToolCommands, layoutPresentCommand, layoutWorkspaceCommands } from './commands/layoutTools';
export type { LayoutToolId, LayoutToolInfo, LayoutWorkspaceHost } from './commands/layoutTools';
export * from './host/DisplayHost';
export * from './commands/view';
export * from './commands/lastop';
export * from './commands/edges';

// Curve drawing tools and curve commands (Circle, Polygon, Arcs, Pie, Freehand, Rotated Rectangle)
export * from './commands/curves';
export { drawingTools } from './tools/drawingTools';
export { CircleTool } from './tools/impl/Circle';
export type { CircleParams } from './tools/impl/Circle';
export { PolygonTool } from './tools/impl/Polygon';
export { ArcTool, ARC_SEGMENTS } from './tools/impl/Arc';
export type { ArcParams } from './tools/impl/Arc';
export { PieTool } from './tools/impl/Pie';
export { TwoPointArcTool, sagittaForRadius } from './tools/impl/TwoPointArc';
export type { Arc2Params } from './tools/impl/TwoPointArc';
export { ThreePointArcTool } from './tools/impl/ThreePointArc';
export type { Arc3Params } from './tools/impl/ThreePointArc';
export { FreehandTool, FREEHAND_SAMPLE_PX } from './tools/impl/Freehand';
export { RotatedRectangleTool, rotatedRectangleCorners } from './tools/impl/RotatedRectangle';
export type { RotatedRectangleParams } from './tools/impl/RotatedRectangle';
export { curveTangentAt } from './tools/impl/drawingUtil';
export * from './commands/transform';
export { MoveTool } from './tools/impl/Move';
export { PasteTool } from './tools/impl/Paste';
export { PlaceComponentTool } from './tools/impl/PlaceComponent';
export { SectionPlaneTool } from './tools/impl/SectionPlane';
export { RotateTool, PROTRACTOR_PX } from './tools/impl/Rotate';
export { ScaleTool, buildScaleBox, pickGrip, GRIP_PICK_PX } from './tools/impl/Scale';
export type { ScaleBox, ScaleGrip, GripKind } from './tools/impl/Scale';
export { transformTools } from './tools/transformTools';
export { worldToScreen, movedOutline, TransformToolBase } from './tools/impl/transformShared';
export type { TransformCommit } from './tools/impl/transformShared';
export * from './commands/guides';
export * from './commands/dimensions';
export * from './commands/texts';
export * from './commands/axes';
export * from './commands/offset';
export * from './commands/followme';
export * from './commands/solids';
export * from './commands/edgeBlend';
export * from './commands/intersect';
export * from './commands/context';
export * from './commands/groups';
export * from './commands/componentBehaviors';
export * from './commands/clipboard';
export * from './commands/components';
export * from './commands/sectionPlanes';
export * from './commands/images';
export * from './commands/text3d';
export { TapeTool } from './tools/impl/Tape';
export type { TapeMode, TapeMeasurement, PendingResize } from './tools/impl/Tape';
export { ProtractorTool } from './tools/impl/Protractor';
export { AxesTool, type PickedAxes } from './tools/impl/AxesTool';
export { ComponentAxesTool, componentAxesPick, type ComponentAxesRequest } from './tools/impl/ComponentAxesTool';
export { OffsetTool } from './tools/impl/Offset';
export { FollowMeTool } from './tools/impl/FollowMe';
export { EdgeBlendTool, edgeBlendTools } from './tools/impl/EdgeBlend';
export { SolidTool, solidTools } from './tools/impl/SolidTool';
export { constructionTools } from './tools/constructionTools';
export * from './commands/contextMenu';
export { selectableOf, enterPathOf } from './tools/impl/Select';

// Tags, scenes, styles, shadows, fog and the Tag tool
export * from './commands/tags';
export * from './commands/scenes';
export * from './commands/styles';
export * from './commands/shadows';
export * from './commands/fog';
export * from './commands/modelInfo';
export { TagTool } from './tools/impl/TagTool';
export { tagTools } from './tools/tagTools';

// Materials, Paint Bucket and texture positioning
export * from './commands/materials';
export { BUILTIN_LIBRARY, generateLibraryTexture, libraryMaterial } from './commands/materialLibrary';
export type { LibraryMaterial, LibraryTexture } from './commands/materialLibrary';
export { PaintTool, paintModeOf, hitSide } from './tools/impl/Paint';
export { PositionTextureTool, positionTextureCommands, textureTargetOf, PIN_COLORS, PIN_KINDS, PIN_PICK_PX } from './tools/impl/PositionTexture';
export type { PinKind, TextureTarget } from './tools/impl/PositionTexture';
export { paintTools } from './tools/paintTools';
