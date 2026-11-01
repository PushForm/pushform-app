// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { operateLayoutPaths, validateLayoutPathOperand, type LayoutPathOperation } from '@pushform/layout';
import { resizedViewportCamera, layoutModelFields, viewportSourceKey as modelSourceRevisionKey, previewLayoutModelAnnotation, type LayoutModelAttachment } from '@pushform/layout';
import { LayoutDocumentHost } from '@pushform/commands';
import { snapLayoutModelVertex } from './layoutModelSnaps';
import { peekLayoutViewportModel, retainLayoutViewportModels } from './layoutViewportRenders';
import { LayoutTableGrid } from './LayoutTableGrid';
import { cloneLayoutTable, resizeTableAxis, tableFrame } from '@pushform/layout';
import type { TableCellAddress, TableGridSelection } from './tableGridSelection';
import { layoutPathArrows, createLayoutTable, createLayoutEllipse, createLayoutPolygon, snapLayoutPolygonReference, LAYOUT_POLYGON_MAX_SIDES, LAYOUT_POLYGON_MIN_SIDES, tableCellAt, LAYOUT_AUTO_TEXT_TAGS, LAYOUT_ACCOUNT_TAGS, LAYOUT_NON_PAGE_NUMBER_TAGS, LAYOUT_PAGE_NUMBER_STYLES, DEFAULT_LAYOUT_PAGE_NUMBERING, layoutPageNumbering, type LayoutPageNumbering, type LayoutPageNumberStyle, layoutAccountFieldsVersion, subscribeLayoutAccountFields, LAYOUT_DEFAULT_TEXT, layoutDashMm, matchLayoutDash, isViewport, type LayoutViewportCamera } from '@pushform/layout';
import { paintLayoutTable } from './layoutTable';
import { LayoutTablePanel } from './LayoutTablePanel';
import {
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type JSX,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { SERVICE_LAYOUT_WORKSPACE, LAYOUT_TOOLS, parseVcb, type LayoutWorkspaceHost } from '@pushform/commands';
import { removeLayoutPathVertex, nextLayoutPathIndex, layoutPathContours, layoutPathSegmentIndices,isLayoutLayerVisible, labelAnchorAt, layoutLabelDragPart, layoutLabelWholeMovePart, moveLayoutLabel, previewLayoutLabel, type LayoutLabelDragPart, formatLayoutTextRange, layoutTextStyleAt, layoutLabelLeader, createLayoutLabelGeometry, inferLinearDimensionAlignment, layoutRotationAngle, snapLayoutRotationAngle, rotateLayoutEntity, rotateLayoutPoint, layoutTextCenter, resizeLayoutTextPoints, createLayoutCornerBetween, isLayoutCornerTool, createLayoutOffset, layoutOffsetDistance, createLayoutArc, isLayoutArcTool, layoutArcSweep, createLayoutRectangle, isLayoutRectangleTool, type LayoutRectanglePath, pointInsideLayoutPath, angularRaysFromPoints, angularEdgesFromPicks, type LayoutAngularEdgeAnchor, angularDimensionError, angularPlacementReflex, angularMeasurement, autoDimensionExtent, entitiesInSelectionBox, entitiesInLasso, lassoIsCrossing, layoutEntityBounds, angularDimensionGeometry, formatAngularDimension, createAngularDimension, type LayoutAngularDimension, createLinearDimension, dimensionAnchorAt, linearMeasurement, linearDimensionGeometry, formatLinearDimension, formatLayoutLength, layoutLengthPrecisionLabel, layoutDimensionScaleLabel, LAYOUT_DIMENSION_SCALES, previewLayoutDimension, type LayoutDimensionAnchor, type LayoutLinearDimension, editLayoutTextContent, importLayoutText, entitiesForLayer, entityOnPage, flattenLayoutPath, pathSegment, pointOnPathSegment, splitLayoutPathSegment, snapPaperPoint, alignToPaperReference, addLayoutBezierAnchor, pullLayoutBezierHandle, previewLayoutBezier, finishLayoutBezier, type LayoutBezierDraft, type PaperAlignment, type LayoutEntity, type LayoutPathHandle, type LayoutPage, type LayoutDocumentState, type PaperSnapKind } from '@pushform/layout';
import { FREEHAND_SMOOTHING_PX, LENGTH_TOL } from '@pushform/core';
import { createLayoutFreehand } from '@pushform/layout';
import { dxfLayoutEntities, isDxfFile } from '@pushform/io';
import type { DocumentSession, LayoutTab, LayoutToolId } from '../session';
import { paintAngularDimension, paintLayoutDimension } from './layoutDimension';
import { fittedLayoutTextBounds, layoutEditorLineHeight, layoutEditorTabSizeMm, layoutFontLineHeight, layoutTextBlock, layoutTextInset, paintLayoutLabelLeader, paintLayoutText } from './layoutText';
import { repeatLayoutShape, type LayoutShapeRepeat } from './layoutShapeRepeat';
import { lastCreatedLayoutObjects, trackLayoutCreations } from './layoutLastCreated';
import { LayoutDashControls } from './LayoutDashControls';
import { LayoutArrowControls } from './LayoutArrowControls';
import { layoutImageLoads, paintLayoutImage } from './layoutImage';
import { layoutViewportModel, layoutViewportPicture, layoutViewportSources } from './layoutViewportRenders';
import { initialViewportCamera, orbitViewportCamera, panViewportCamera, zoomViewportCamera } from './layoutViewportCameras';
import { LayoutViewportPanel } from './LayoutViewportPanel';
import { Icon } from './Icon';
import { useLayoutShapeBuilder } from './useLayoutShapeBuilder';
import { LayoutShapeBuilderPreview } from './LayoutShapeBuilderPreview';
import { ToolStack } from './ToolStack';
import { ToolButton } from './ToolButton';
import { LayoutTextEditor as InlineLayoutTextEditor, getLayoutTextSelection, setLayoutTextSelection } from './LayoutTextEditor';
import { LayoutFontInput } from './LayoutFontPicker';
import { layoutFontLoads, layoutFontRequests, layoutFontStatus, prepareLayoutFonts } from './layoutFonts';
import { isDocumentToolbarTarget, toolbarNeedsInputFocus } from './toolbarFocus';
import { LayoutTextToolbar } from './LayoutTextToolbar';
import { LayoutPrintDialog } from './LayoutPrintDialog';
import { LayoutExportDialog } from './LayoutExportDialog';
import { LayoutLayerScopeDialog } from './LayoutLayerScopeDialog';
import { LayoutDocumentSettingsDialog } from './LayoutDocumentSettingsDialog';
import { LayoutPlacementMarker } from './LayoutPlacementMarker';
import { LayoutAlignmentGuide } from './LayoutAlignmentGuide';
import { LayoutSnapTooltip } from './LayoutSnapTooltip';
import { LayoutContextMenu, type LayoutMenuItem } from './LayoutContextMenu';
import { readLayoutClipboard, layoutClipboardImage, layoutClipboardText, layoutClipboardSvg, layoutClipboardHtml } from './layoutClipboard';
import { createLayoutClipboardPayload, writeLayoutClipboardEvent, writeLayoutSystemClipboard, readLayoutSystemClipboard } from './layoutClipboardWrite';
import { currentModelClipboardView, readModelClipboardView } from '../modelClipboard';
import { checkLayoutReferences, convertEmbeddedModel, layoutClipboardEntity, linkCloudModel, openReferencedModel, pasteModelView, persistLayoutViewportRenders, updateLayoutReference,
  type LayoutCloudAccess, type LayoutReferenceStatus } from './layoutCloudModels';
import { LayoutCloudModelPicker } from './LayoutCloudModelPicker';
import { LayoutReferencesPanel } from './LayoutReferencesPanel';
import { LayoutObjectBrowser, layoutBrowserPassesKey, type LayoutBrowserDrop, type LayoutBrowserSelectMode, type LayoutBrowserTarget } from './LayoutObjectBrowser';

type Point = [number, number];
function objectLocked(entity: LayoutEntity, state: LayoutDocumentState): boolean {
  return Boolean(entity.locked || state.layers.get(entity.layerId)?.locked);
}
function expandLayoutGroups(ids: number[], page: LayoutPage, state: LayoutDocumentState): number[] {
  const groups = new Set(ids.flatMap(id => { const groupId = entityOnPage(page, state, id)?.groupId; return groupId === undefined ? [] : [groupId]; }));
  const members = state.layerOrder.filter(id => isLayoutLayerVisible(page, state, id)).flatMap(id => entitiesForLayer(page, state, id))
    .filter(entity => entity.groupId !== undefined && groups.has(entity.groupId)).map(entity => entity.id);
  return [...new Set([...ids, ...members])];
}
type DimensionDraft = {
  modelAttachments?: (LayoutModelAttachment | null)[];
  points: Point[];
  anchors: (LayoutDimensionAnchor | null)[];
  edgeAnchors?: [LayoutAngularEdgeAnchor, LayoutAngularEdgeAnchor];
  edgeGuide?: Point[];
  rayPoints?: Point[];
  rayDefinition?: NonNullable<LayoutAngularDimension['rayDefinition']>;
};

function angularDraftGeometry(draft: DimensionDraft, cursor: Point): { points: Point[]; placing: boolean } | null {
  if (draft.rayPoints && draft.rayPoints.length < 4) {
    if (draft.rayPoints.length !== 3) return null;
    try { return { points: angularRaysFromPoints([...draft.rayPoints, cursor]), placing: false }; } catch { return null; }
  }
  return draft.points.length === 3 ? { points: draft.points, placing: true } : null;
}
type LayoutTool = LayoutToolId;
interface LabelDraft { tip: Point; bend: Point | null; attachment: LayoutDimensionAnchor | null; modelAttachment?: LayoutModelAttachment }
interface RotationDraft { entityId: number; pivot: Point; reference: Point | null; angleDeg: number }
interface CornerPick { entityId: number; segmentIndex: number; point: Point }
interface ArcDraft { points: Point[]; sweep: number }
/** The platform's primary modifier, named the way its keyboard labels it. */
const PRIMARY_MODIFIER = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';
/** `whole` is the Move tool's preview: labels move whole and copied dimensions become fixed paper points. */
interface MovePreview { entityIds: ReadonlySet<number>; delta: Point; copy: boolean; labelPart?: LayoutLabelDragPart; whole?: boolean }
/** A pending Move tool move: what moves, from which base point, and whether it copies. */
interface MoveDraft { entityIds: number[]; base: Point; copy: boolean }
/** Tapped after a Move base point to toggle copying, named the way the keyboard labels them. */
const COPY_TOGGLE_KEYS = PRIMARY_MODIFIER === 'Cmd' ? 'Ctrl or Option' : 'Ctrl or Alt';
interface BoxSelect { from: Point; to: Point; additive: boolean }
/** A Lasso outline in progress: dragged freehand, or clicked point by point while `cursor` follows the pointer. */
interface LassoDraft { points: Point[]; freehand: boolean; cursor: Point | null }
interface PathEditPreview { resizeViewport?: boolean; rotationDeg?: number; showVertices?: boolean; entityId: number; points: Point[] | null; handles: LayoutPathHandle[] | null; activeIndex: number | null }

function copyHandles(handles: readonly LayoutPathHandle[] | undefined, count: number): LayoutPathHandle[] {
  return Array.from({ length: count }, (_, index) => ({
    ...(handles?.[index]?.in ? { in: [...handles[index]!.in!] as Point } : {}),
    ...(handles?.[index]?.out ? { out: [...handles[index]!.out!] as Point } : {}),
  }));
}
function pathBounds(points: Point[], handles: LayoutPathHandle[] | undefined, closed: boolean, contourStarts?: number[]) {
  const samples = flattenLayoutPath(points, handles, closed, 20, contourStarts);
  const xs = samples.map((p) => p[0]), ys = samples.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs), maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
function traceLayoutPath(ctx: CanvasRenderingContext2D, points: Point[], handles: LayoutPathHandle[] | undefined,
  closed: boolean, contourStarts?: number[], openContours?: number[]): void {
  ctx.beginPath();
  for (const contour of layoutPathContours(points, handles, closed, contourStarts, openContours)) {
    if (!contour.points.length) continue;
    ctx.moveTo(...contour.points[0]!);
    for (let index = 0; index < contour.points.length - (contour.closed ? 0 : 1); index++) {
      const segment = pathSegment(contour.points, contour.handles, index, contour.closed);
      if (segment.curved) ctx.bezierCurveTo(...segment.c1, ...segment.c2, ...segment.b);
      else ctx.lineTo(...segment.b);
    }
    if (contour.closed) ctx.closePath();
  }
}
/** Offset guides are interaction overlays: redraw both outlines after every document object. */
function paintOffsetPreview(ctx: CanvasRenderingContext2D, source: LayoutEntity | null, preview: LayoutRectanglePath | null, zoom: number): void {
  ctx.save();
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  const outline = (shape: Pick<LayoutEntity, 'points' | 'handles' | 'closed' | 'contourStarts' | 'openContours'>, draft: boolean): void => {
    traceLayoutPath(ctx, shape.points, shape.handles, shape.closed, shape.contourStarts, shape.openContours);
    // The solid halo keeps the guide visible over opaque or similarly colored objects.
    ctx.setLineDash([]); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2 / zoom; ctx.stroke();
    ctx.setLineDash(draft ? [1.5 / zoom, 1 / zoom] : []);
    ctx.strokeStyle = '#1e63d1'; ctx.lineWidth = (draft ? 0.5 : 0.35) / zoom; ctx.stroke();
  };
  if (source) outline(source, false);
  if (preview) outline(preview, true);
  ctx.restore();
}
function imageFrame(points: Point[]) {
  const [a, b, c, d] = points as [Point, Point, Point, Point];
  const width = Math.hypot(b[0] - a[0], b[1] - a[1]), height = Math.hypot(d[0] - a[0], d[1] - a[1]);
  const center: Point = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
  return { angle: Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI, center,
    minX: center[0] - width / 2, maxX: center[0] + width / 2, minY: center[1] - height / 2, maxY: center[1] + height / 2, width, height };
}
/** The box an object's resize handles sit on, unrotated, with `boxAngle` its turn about its center. */
function selectionBox(entity: LayoutEntity, previewPoints?: Point[], previewHandles?: LayoutPathHandle[]) {
  const points = previewPoints ?? entity.points;
  return (entity.image || entity.table) ? imageFrame(points) : pathBounds(entity.text ? points.slice(0, 2) : points,
    entity.text ? undefined : previewHandles ?? entity.handles, entity.text ? false : entity.closed, entity.contourStarts);
}
function boxAngle(entity: LayoutEntity): number {
  return (entity.image || entity.table) ? imageFrame(entity.points).angle : entity.text?.rotationDeg ?? 0;
}
type Box = { minX: number; minY: number; width: number; height: number };
/** The page point at fractions (u, v) of a box turned `angle` degrees about its center. */
function boxPoint(box: Box, angle: number, u: number, v: number): Point {
  return rotateLayoutPoint([box.minX + u * box.width, box.minY + v * box.height], [box.minX + box.width / 2, box.minY + box.height / 2], angle);
}
/** The fractions of a turned box at the page point `p`, kept within the box. */
function boxFraction(box: Box, angle: number, p: Point): { u: number; v: number } {
  const local = rotateLayoutPoint(p, [box.minX + box.width / 2, box.minY + box.height / 2], -angle);
  const clamp = (t: number) => Math.min(1, Math.max(0, t));
  return { u: box.width > 1e-6 ? clamp((local[0] - box.minX) / box.width) : 0.5, v: box.height > 1e-6 ? clamp((local[1] - box.minY) / box.height) : 0.5 };
}
/** The rotation grip's arm, from the center of rotation to the handle, in screen pixels. */
const ROTATION_ARM_PX = 24;
const SCALE_HANDLES = [
  { name: 'top left', x: 0, y: 0, cursor: 'nwse-resize' },
  { name: 'top', x: 0.5, y: 0, cursor: 'ns-resize' },
  { name: 'top right', x: 1, y: 0, cursor: 'nesw-resize' },
  { name: 'right', x: 1, y: 0.5, cursor: 'ew-resize' },
  { name: 'bottom right', x: 1, y: 1, cursor: 'nwse-resize' },
  { name: 'bottom', x: 0.5, y: 1, cursor: 'ns-resize' },
  { name: 'bottom left', x: 0, y: 1, cursor: 'nesw-resize' },
  { name: 'left', x: 0, y: 0.5, cursor: 'ew-resize' },
] as const;
interface ScaleDrag {
  entityId: number; points: Point[]; handles: LayoutPathHandle[]; pivot: Point; center: Point;
  start: Point; x: number; y: number; scaleX: boolean; scaleY: boolean;
  pointer: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean };
}

const SELECT_TOOLS = [
  { id: 'select', title: 'Select', icon: 'tool-select', key: 'Space' },
  { id: 'lasso', title: 'Lasso', icon: 'tool-lasso', key: 'Shift+Space' },
] as const;
const TOOLS: { id: LayoutTool; title: string; key: string }[] = [
  { id: 'select', title: 'Select', key: 'Space' },
  { id: 'eraser', title: 'Eraser', key: 'E' },
  { id: 'line', title: 'Line', key: 'L' },
  { id: 'arc', title: 'Arc', key: '' },
  { id: 'rectangle', title: 'Rectangle', key: 'R' },
  { id: 'circle', title: 'Circle', key: 'C' },
  { id: 'polygon', title: 'Polygon', key: '' },
  { id: 'offset', title: 'Offset', key: '' },
  { id: 'fillet', title: 'Fillet', key: 'Shift+F' },
  { id: 'move', title: 'Move', key: 'M' },
  { id: 'rotate', title: 'Rotate', key: 'Q' },
  { id: 'scale', title: 'Scale', key: '' },
  { id: 'boolean-union', title: 'Union', key: '' },
  { id: 'text', title: 'Text', key: 'T' },
  { id: 'dimension', title: 'Linear Dimension', key: 'D' },
  { id: 'label', title: 'Label', key: '' },
  { id: 'table', title: 'Table', key: '' },
];
const TOOL_GROUPS: { title: string; tools: LayoutTool[] }[] = [
  { title: 'Transform', tools: ['select', 'move', 'rotate', 'scale', 'eraser'] },
  { title: 'Draw', tools: ['line', 'arc', 'rectangle', 'circle', 'polygon'] },
  { title: 'Modify', tools: ['offset', 'fillet', 'boolean-union'] },
  { title: 'Annotate', tools: ['text', 'label', 'dimension'] },
  { title: 'Insert', tools: ['table'] },
];
const BOOLEAN_TOOLS = [
  { id: 'shape-builder', title: 'Shape Builder', icon: 'tool-shape-builder', key: 'X' },
  { id: 'boolean-union', title: 'Union', icon: 'tool-boolean-union' },
  { id: 'boolean-subtract', title: 'Difference', icon: 'tool-boolean-subtract' },
  { id: 'boolean-intersect', title: 'Intersection', icon: 'tool-boolean-intersect' },
  { id: 'boolean-exclude', title: 'Exclusion', icon: 'tool-boolean-exclude' },
  { id: 'boolean-division', title: 'Division', icon: 'tool-boolean-division' },
  { id: 'boolean-cut-path', title: 'Cut Path', icon: 'tool-boolean-cut-path' },
] as const;
const booleanOperation = (tool: LayoutTool): LayoutPathOperation | null =>
  tool.startsWith('boolean-') ? tool.slice('boolean-'.length) as LayoutPathOperation : null;

const CORNER_TOOLS = [
  { id: 'fillet', title: 'Fillet', icon: 'tool-fillet', key: 'Shift+F' },
  { id: 'chamfer', title: 'Chamfer', icon: 'tool-chamfer', key: 'Shift+C' },
] as const;
const LINE_TOOLS = [
  { id: 'line', title: 'Line', icon: 'tool-line', key: 'L' },
  { id: 'bezier', title: 'Bézier Curve', icon: 'tool-bezier' },
  { id: 'freehand', title: 'Freehand', icon: 'tool-freehand' },
] as const;
const ARC_TOOLS = [
  { id: 'arc', title: 'Arc', icon: 'tool-arc' },
  { id: 'arc2', title: '2 Point Arc', icon: 'tool-arc2', key: 'A' },
  { id: 'arc3', title: '3 Point Arc', icon: 'tool-arc3' },
  { id: 'pie', title: 'Pie', icon: 'tool-pie' },
] as const;
const CIRCLE_TOOLS = [
  { id: 'circle', title: 'Circle', icon: 'tool-circle', key: 'C' },
  { id: 'ellipse', title: 'Ellipse', icon: 'tool-ellipse' },
] as const;
const POLYGON_TOOLS = [
  { id: 'polygon', title: 'Polygon', icon: 'tool-polygon' },
  { id: 'circumscribed-polygon', title: 'Circumscribed Polygon', icon: 'tool-circumscribed-polygon' },
] as const;
/** Tools that draw open lines, the only shapes that take arrows. */
const LINE_DRAWING_TOOLS: ReadonlySet<string> = new Set(['line', 'bezier', 'freehand', 'arc', 'arc2', 'arc3']);
const isPolygonTool = (id: string): boolean => id === 'polygon' || id === 'circumscribed-polygon';
/** Tools whose double-click repeats their last shape. */
const isRepeatableShapeTool = (id: string): boolean => isLayoutRectangleTool(id) || id === 'circle' || id === 'ellipse' || isPolygonTool(id);
const RECTANGLE_TOOLS = [
  { id: 'rectangle', title: 'Rectangle', icon: 'tool-rectangle', key: 'R' },
  { id: 'rounded-rectangle', title: 'Rounded', icon: 'tool-rounded-rectangle' },
  { id: 'bulged-rectangle', title: 'Bulged', icon: 'tool-bulged-rectangle' },
  { id: 'lozenge', title: 'Lozenge', icon: 'tool-lozenge' },
] as const;
const DIMENSION_TOOLS = [
  { id: 'dimension', title: 'Linear Dimension', icon: 'tool-dimension', key: 'D' },
  { id: 'angular-dimension', title: 'Angular Dimension', icon: 'tool-angular-dimension', key: 'Shift+D' },
] as const;
const PX_PER_MM = 3;
const THUMBNAIL_MAX_PX = 88;
const ZOOM_PRESETS = [25, 50, 75, 100, 150, 200, 400] as const;

function useLayoutAssetLoads(): number {
  const images = useSyncExternalStore(layoutImageLoads.subscribe, layoutImageLoads.version);
  const fonts = useSyncExternalStore(layoutFontLoads.subscribe, layoutFontLoads.version);
  // Account auto-text values change when the profile is edited.
  const account = useSyncExternalStore(subscribeLayoutAccountFields, layoutAccountFieldsVersion);
  return images + fonts + account;
}

function useDocumentVersion(tab: LayoutTab): number {
  return useSyncExternalStore(
    (notify) => tab.doc.events.on('change', notify),
    () => tab.doc.version,
  );
}

type PlacementModifiers = { center: boolean; square: boolean };
/** Tools drawn between two corners, where Shift makes them square and Ctrl/Cmd draws from the center. */
const usesPlacementModifiers = (tool: string): boolean => isLayoutRectangleTool(tool) || tool === 'ellipse';
const NO_PLACEMENT_MODIFIERS: PlacementModifiers = { center: false, square: false };
function placementCorners(a: Point, b: Point, modifiers: PlacementModifiers): [Point, Point] {
  let dx = b[0] - a[0], dy = b[1] - a[1];
  if (modifiers.square) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * size; dy = (dy < 0 ? -1 : 1) * size;
  }
  return [modifiers.center ? [a[0] - dx, a[1] - dy] : a, [a[0] + dx, a[1] + dy]];
}

function pathPoints(tool: LayoutTool, a: Point, b: Point, amountMm = 5, modifiers = NO_PLACEMENT_MODIFIERS, polygonSides = 6): LayoutRectanglePath {
  if (tool === 'table' || tool === 'viewport') return { points: [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]], closed: true };
  if (isLayoutRectangleTool(tool)) {
    [a, b] = placementCorners(a, b, modifiers);
    if (Math.abs(b[0] - a[0]) < 1e-6 || Math.abs(b[1] - a[1]) < 1e-6) return { points: [a, b], closed: false };
    return createLayoutRectangle(tool, a, b, amountMm);
  }
  if (tool === 'polygon' || tool === 'circumscribed-polygon') {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= LENGTH_TOL * 1000) return { points: [a, b], closed: false };
    return createLayoutPolygon(a, b, tool === 'polygon' ? 'inscribed' : 'circumscribed', polygonSides);
  }
  if (tool === 'circle') {
    const radius = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return radius <= 1e-6 ? { points: [a, b], closed: false } : createLayoutEllipse(a, radius, radius);
  }
  if (tool === 'ellipse') {
    // The ellipse fills the box between two corners.
    [a, b] = placementCorners(a, b, modifiers);
    const rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
    if (rx <= 1e-6 || ry <= 1e-6) return { points: [a, b], closed: false };
    return createLayoutEllipse([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], rx, ry);
  }
  return { points: [a, b], closed: false };
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function projectOnSegment(p: Point, a: Point, b: Point): { point: Point; distance: number; t: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  const point: Point = [a[0] + t * dx, a[1] + t * dy];
  return { point, distance: Math.hypot(p[0] - point[0], p[1] - point[1]), t };
}

function projectOnPathSegment(p: Point, entity: LayoutEntity, index: number):
  { point: Point; distance: number; t: number } {
  const segment = pathSegment(entity.points, entity.handles, index, entity.closed, entity.contourStarts);
  if (!segment.curved) return projectOnSegment(p, segment.a, segment.b);
  let best = { point: segment.a, distance: Infinity, t: 0 };
  let previous = segment.a;
  const steps = 40;
  for (let step = 1; step <= steps; step++) {
    const next = pointOnPathSegment(entity.points, entity.handles, index, entity.closed, step / steps, entity.contourStarts);
    const projection = projectOnSegment(p, previous, next);
    if (projection.distance < best.distance)
      best = { point: projection.point, distance: projection.distance, t: (step - 1 + projection.t) / steps };
    previous = next;
  }
  return best;
}

function pickCornerSegment(p: Point, page: LayoutPage, state: LayoutDocumentState, tolerance: number): CornerPick | null {
  for (const layerId of [...state.layerOrder].reverse()) {
    if (!isLayoutLayerVisible(page, state, layerId)) continue;
    for (const entity of entitiesForLayer(page, state, layerId).reverse()) {
      if (entity.kind !== 'path') continue;
      let best: CornerPick | null = null, distance = tolerance;
      for (const i of layoutPathSegmentIndices(entity)) {
        const projection = projectOnPathSegment(p, entity, i);
        if (projection.distance <= distance) { distance = projection.distance; best = { entityId: entity.id, segmentIndex: i, point: projection.point }; }
      }
      if (best) return best;
    }
  }
  return null;
}

/**
 * Everything a plain move changes: the moving objects plus the dimensions associated with them and the labels
 * attached to them, which follow on commit, so none of them may attract the destination.
 */
function movingWithFollowers(entityIds: readonly number[], page: LayoutPage, state: LayoutDocumentState): Set<number> {
  const moving = new Set(entityIds);
  const refersToMoving = (anchors: readonly ({ entityId: number } | null)[] | undefined) => Boolean(anchors?.some((anchor) => anchor && moving.has(anchor.entityId)));
  const followers: number[] = [];
  for (const layerId of state.layerOrder) for (const entity of entitiesForLayer(page, state, layerId)) {
    const dim = entity.dimension ?? entity.angularDimension;
    if ((entity.labelAnchor && moving.has(entity.labelAnchor.entityId)) || refersToMoving(dim?.anchors) ||
        refersToMoving(entity.angularDimension?.edgeAnchors) || refersToMoving(entity.angularDimension?.rayDefinition?.anchors)) followers.push(entity.id);
  }
  for (const id of followers) moving.add(id);
  return moving;
}

function pickEntity(p: Point, page: LayoutPage, state: LayoutDocumentState, includeUnfilledInterior = false, excludedIds: readonly number[] = []): LayoutEntity | null {
  for (const layerId of [...state.layerOrder].reverse()) {
    if (!isLayoutLayerVisible(page, state, layerId)) continue;
    for (const entity of entitiesForLayer(page, state, layerId).reverse()) {
      if (excludedIds.includes(entity.id)) continue;
      if (entity.angularDimension) {
        const geometry = angularDimensionGeometry(entity);
        if (geometry.arc.slice(1).some((point, i) => distanceToSegment(p, geometry.arc[i]!, point) < 2)
          || [[entity.points[1]!, geometry.start], [entity.points[2]!, geometry.end]].some(([a, b]) => distanceToSegment(p, a!, b!) < 2)
          || Math.hypot(p[0] - geometry.text[0], p[1] - geometry.text[1]) < 5) return entity;
        continue;
      }
      if (entity.dimension) {
        const { a, b, start, end } = linearDimensionGeometry(entity);
        const middle: Point = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
        if ([[a, start], [b, end], [start, end]].some(([first, second]) => distanceToSegment(p, first!, second!) < 2)
          || Math.hypot(p[0] - middle[0], p[1] - middle[1]) < 5) return entity;
        continue;
      }
      if (entity.image || entity.table) {
        if (pointInsideLayoutPath(p, entity.points)) return entity;
        continue;
      }
      if (entity.text) {
        const [a, b] = entity.points;
        const local = rotateLayoutPoint(p, layoutTextCenter(entity), -(entity.text.rotationDeg ?? 0));
        if (a && b && local[0] >= Math.min(a[0], b[0]) && local[0] <= Math.max(a[0], b[0]) &&
          local[1] >= Math.min(a[1], b[1]) && local[1] <= Math.max(a[1], b[1])) return entity;
        const leader = layoutLabelLeader(entity);
        if (leader && (distanceToSegment(local, leader.tip, leader.bend) < 2 || distanceToSegment(local, leader.bend, leader.start) < 2)) return entity;
        continue;
      }
      // Fill tests close every contour (pointInsideLayoutPath wraps around); edge tests skip undrawn closing segments.
      const contours = layoutPathContours(entity.points, entity.handles, entity.closed, entity.contourStarts, entity.openContours)
        .map(contour => flattenLayoutPath(contour.points, contour.handles, contour.closed));
      if (entity.closed && (entity.style?.fillColor || includeUnfilledInterior) &&
        contours.filter(samples => pointInsideLayoutPath(p, samples)).length % 2 === 1) return entity;
      for (const samples of contours) for (let i = 1; i < samples.length; i++) {
        if (distanceToSegment(p, samples[i - 1]!, samples[i]!) < 2) return entity;
      }
    }
  }
  return null;
}

/** The visible workspace around the page, in paper millimetres from the page's top-left corner. */
interface LayoutSurround { x: number; y: number; width: number; height: number; pxPerMm: number }

function paintPage(
  canvas: HTMLCanvasElement,
  page: LayoutPage,
  state: LayoutDocumentState,
  anchor: Point | null,
  cursor: Point | null,
  tool: LayoutTool,
  selected: ReadonlySet<number>,
  movePreview: MovePreview | null,
  pathEdit: PathEditPreview | null,
  freehand: Point[],
  zoom: number,
  thumbnail = false,
  dimensionDraft: DimensionDraft | null = null,
  rectangleAmountMm = 5,
  arcDraft: ArcDraft | null = null,
  draftPathPreview: LayoutRectanglePath | null = null,
  rotationDraft: RotationDraft | null = null,
  labelDraft: LabelDraft | null = null,
  presentation = false,
  outputDpi?: number,
  initialLabelEditId: number | null = null,
  offsetPreviewSource: LayoutEntity | null = null,
  moveGuide: { base: Point; target: Point } | null = null,
  tableGrid = { rows: 3, columns: 3 },
  placementModifiers = NO_PLACEMENT_MODIFIERS,
  viewportPreview: { entityId: number; camera: LayoutViewportCamera } | null = null,
  polygonSides = 6,
  tableResizePreview: LayoutEntity | null = null,
  surround: LayoutSurround | null = null,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const visibleEntities = state.layerOrder.filter(id => isLayoutLayerVisible(page, state, id)).flatMap(id => entitiesForLayer(page, state, id));
  void prepareLayoutFonts(visibleEntities).catch(() => { /* Keep the readable fallback when offline. */ });
  const renderScale = outputDpi ? outputDpi / 25.4 : thumbnail
    ? THUMBNAIL_MAX_PX * window.devicePixelRatio / Math.max(...page.size)
    : surround ? surround.pxPerMm * Math.min(window.devicePixelRatio, 2)
    : PX_PER_MM * Math.max(1, Math.min(zoom * window.devicePixelRatio, 4));
  if (surround) {
    // The surround shows objects past the paper edge; the paper canvas above it covers the page itself.
    canvas.width = Math.round(surround.width * renderScale);
    canvas.height = Math.round(surround.height * renderScale);
    ctx.setTransform(renderScale, 0, 0, renderScale, -surround.x * renderScale, -surround.y * renderScale);
    // The paper's shadow is drawn here, below the objects, so it never darkens their off-page parts.
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.18)';
    ctx.shadowBlur = 18 * renderScale / surround.pxPerMm;
    ctx.shadowOffsetY = 3 * renderScale / surround.pxPerMm;
    ctx.fillStyle = page.background;
    ctx.fillRect(0, 0, page.size[0], page.size[1]);
    ctx.restore();
  } else {
    canvas.width = Math.round(page.size[0] * renderScale);
    canvas.height = Math.round(page.size[1] * renderScale);
    ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
    ctx.fillStyle = page.background;
    ctx.fillRect(0, 0, page.size[0], page.size[1]);
  }
  if (!surround && !thumbnail && !presentation && state.settings.grid.show && state.settings.grid.spacingMm > 0) {
    const spacing = state.settings.grid.spacingMm;
    const left = page.margin.left;
    const top = page.margin.top;
    const right = page.size[0] - page.margin.right;
    const bottom = page.size[1] - page.margin.bottom;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    // The grid and margin guide are editing aids sized in screen pixels, not paper millimetres.
    ctx.strokeStyle = '#e5eaf0';
    ctx.lineWidth = 0.3 / zoom;
    ctx.beginPath();
    for (let x = (Math.floor(left / spacing) + 1) * spacing; x < right; x += spacing) {
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    for (let y = (Math.floor(top / spacing) + 1) * spacing; y < bottom; y += spacing) {
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
    ctx.restore();
  }
  if (!surround && !thumbnail && !presentation) {
    ctx.setLineDash([1.5 / zoom, 1.5 / zoom]);
    ctx.strokeStyle = '#b5bdc7';
    ctx.lineWidth = 0.3 / zoom;
    ctx.strokeRect(
      page.margin.left,
      page.margin.top,
      page.size[0] - page.margin.left - page.margin.right,
      page.size[1] - page.margin.top - page.margin.bottom,
    );
    ctx.setLineDash([]);
  }
  // Associated dimensions follow a source path while it is dragged: resolve them against the previewed geometry.
  const draggedSourceIds: ReadonlySet<number> = pathEdit?.points ? new Set([pathEdit.entityId])
    : movePreview && !movePreview.copy ? movePreview.entityIds : new Set();
  const previewedSource = (id: number): LayoutEntity | undefined => {
    const source = entityOnPage(page, state, id);
    if (!source) return source;
    if (viewportPreview?.entityId === id && isViewport(source)) return { ...source,
      image: { ...source.image, viewport: { ...source.image.viewport, camera: viewportPreview.camera } } };
    const live = source.dimension || source.angularDimension ? previewLayoutDimension(source, previewedSource) : source;
    if (!draggedSourceIds.has(id)) return live;
    if (pathEdit?.points) return { ...source, points: pathEdit.points, ...(pathEdit.resizeViewport && isViewport(source) ? { image: { ...source.image,
      viewport: { ...source.image.viewport, camera: resizedViewportCamera(source.image.viewport.camera, source.points, pathEdit.points, source.image.viewport.preserveScaleOnResize) } } } : {}),
      ...(pathEdit.handles ? { handles: pathEdit.handles } : {}),
      ...(source.text && pathEdit.rotationDeg !== undefined ? { text: { ...source.text, rotationDeg: pathEdit.rotationDeg } } : {}) };
    const fixed = source.dimension?.anchors.some(Boolean) ? 2 :
      source.angularDimension && (source.angularDimension.anchors.some(Boolean) || source.angularDimension.edgeAnchors || source.angularDimension.rayDefinition) ? 3 : 0;
    return { ...live, points: live.points.map(([x, y], index): Point => index < fixed ? [x, y] : [x + movePreview!.delta[0], y + movePreview!.delta[1]]) };
  };
  const modelPreview = (entity: LayoutEntity) => previewLayoutModelAnnotation(entity, previewedSource,
    source => peekLayoutViewportModel(state, source)?.state);
  for (const layerId of state.layerOrder) {
    if (!isLayoutLayerVisible(page, state, layerId)) continue;
    for (const entity of entitiesForLayer(page, state, layerId)) {
      if (entity.points.length === 0) continue;
      const id = entity.id;
      const points = pathEdit?.entityId === id && pathEdit.points ? pathEdit.points : entity.points;
      const handles = pathEdit?.entityId === id && pathEdit.handles ? pathEdit.handles : entity.handles;
      const moving = movePreview?.entityIds.has(id) ? movePreview : null;
      // Move tool copies of dimensions are fixed paper points, so every point moves.
      const fixedCopy = Boolean(moving?.whole && moving.copy);
      if (entity.angularDimension) {
        const live = draggedSourceIds.size ? previewLayoutDimension(entity, previewedSource) : entity;
        if (!moving || moving.copy) paintAngularDimension(ctx, live, selected.has(id));
        if (moving) paintAngularDimension(ctx, { ...live, points: live.points.map(([x, y], index): Point =>
          !fixedCopy && (entity.angularDimension!.anchors.some(Boolean) || entity.angularDimension!.edgeAnchors || entity.angularDimension!.rayDefinition) && index < 3 ? [x, y] : [x + moving.delta[0], y + moving.delta[1]]) }, true);
        continue;
      }
      if (entity.dimension) {
        const live = modelPreview(draggedSourceIds.size ? previewLayoutDimension(entity, previewedSource) : entity);
        if (!moving || moving.copy) paintLayoutDimension(ctx, live, selected.has(id));
        if (moving) {
          const preview = { ...live, points: live.points.map(([x, y], index): Point =>
            !fixedCopy && (entity.modelAnnotation || entity.dimension!.anchors.some(Boolean)) && index < 2 ? [x, y] : [x + moving.delta[0], y + moving.delta[1]]) };
          paintLayoutDimension(ctx, preview, true);
        }
        continue;
      }
      if (entity.table) {
        const preview = tableResizePreview?.id === entity.id ? tableResizePreview : { ...entity, points };
        if (!moving || moving.copy) paintLayoutTable(ctx, preview, page, state, selected.has(id));
        if (moving) { ctx.save(); ctx.translate(...moving.delta); paintLayoutTable(ctx, preview, page, state, true); ctx.restore(); }
        continue;
      }
      if (entity.image) {
        const preview = pathEdit?.entityId === id && pathEdit.points ? previewedSource(id)! : entity;
        const picture = layoutViewportPicture(state, preview, viewportPreview?.entityId === id ? viewportPreview.camera : undefined, outputDpi ? undefined : renderScale);
        if (!moving || moving.copy) paintLayoutImage(ctx, preview, selected.has(id), picture);
        if (moving) {
          ctx.save(); ctx.translate(...moving.delta);
          paintLayoutImage(ctx, preview, true, picture); ctx.restore();
        }
        continue;
      }
      if (entity.text) {
        const preview = pathEdit?.entityId === id && pathEdit.points ? { ...entity, points, text: { ...entity.text, ...(pathEdit.rotationDeg === undefined ? { bounded: true } : { rotationDeg: pathEdit.rotationDeg }) } } : entity;
        const live = entity.kind === 'label' ? modelPreview(previewLayoutLabel(preview, previewedSource)) : preview;
        if (id === initialLabelEditId) {
          // The borderless editor owns the text during the first edit; only paint its leader beneath it.
          paintLayoutText(ctx, { ...live, text: { ...entity.text, content: '', spans: [] } }, page, state, false);
          continue;
        }
        if (!moving || moving.copy) paintLayoutText(ctx, live, page, state, selected.has(id));
        if (moving && entity.kind === 'label') {
          const part = moving.whole ? moving.copy ? 'tip' : layoutLabelWholeMovePart(entity, moving.entityIds) : moving.labelPart ?? 'leader';
          const moved = moveLayoutLabel(preview, moving.delta, part);
          paintLayoutText(ctx, modelPreview(previewLayoutLabel(moved, previewedSource)), page, state, true);
        } else if (moving) {
          ctx.save(); ctx.translate(...moving.delta);
          paintLayoutText(ctx, preview, page, state, true); ctx.restore();
        }
        continue;
      }
      if (!moving || moving.copy) {
        // An open shape's arrowheads, with the line stopped behind open ones.
        const arrows = layoutPathArrows(points, handles, entity.closed, entity.style);
        traceLayoutPath(ctx, arrows.points, handles, entity.closed, entity.contourStarts);
        if (entity.style?.fillColor && entity.closed) {
          ctx.fillStyle = entity.style.fillColor;
          if (entity.contourStarts) ctx.fill('evenodd');
          else ctx.fill();
        }
        // Open contours fill as if closed, but their closing segments are not stroked.
        if (entity.openContours) traceLayoutPath(ctx, arrows.points, handles, entity.closed, entity.contourStarts, entity.openContours);
        ctx.strokeStyle =
          selected.has(id)
            ? '#1e63d1'
            : (entity.style?.strokeColor ?? state.defaultStyle.strokeColor);
        // No stroke is thinner than one device pixel, so hairlines stay visible at any zoom or dpi.
        const transform = ctx.getTransform?.();
        const devicePixelMm = transform ? 1 / (Math.hypot(transform.a, transform.b) || 1) : 0;
        ctx.lineWidth = Math.max(((entity.style?.strokeWeightPt ?? state.defaultStyle.strokeWeightPt) * 25.4) / 72, devicePixelMm);
        ctx.setLineDash(entity.style?.strokeDashMm ?? []);
        ctx.stroke();
        ctx.setLineDash([]);
        // Arrowheads are solid, in the stroke color and weight, even on a dashed line.
        for (const shape of arrows.shapes) {
          ctx.beginPath(); ctx.moveTo(...shape.points[0]!);
          for (const point of shape.points.slice(1)) ctx.lineTo(...point);
          if (shape.closed) ctx.closePath();
          if (shape.filled) { ctx.fillStyle = ctx.strokeStyle; ctx.fill(); }
          ctx.stroke();
        }
      }
      if (moving) {
        ctx.save();
        ctx.translate(...moving.delta);
        traceLayoutPath(ctx, points, handles, entity.closed, entity.contourStarts, entity.openContours);
        ctx.setLineDash(entity.style?.strokeDashMm ?? [1.5, 1]);
        ctx.strokeStyle = '#1e63d1';
        ctx.lineWidth = 0.5;
        ctx.stroke();
        ctx.restore();
      }
    }
  }
  if (pathEdit && pathEdit.showVertices !== false) {
    const entity = entityOnPage(page, state, pathEdit.entityId);
    if (entity?.kind === 'path' && isLayoutLayerVisible(page, state, entity.layerId)) {
      const points = pathEdit.points ?? entity.points;
      const handles = pathEdit.handles ?? entity.handles;
      for (const [index, point] of points.entries()) {
        for (const side of ['in', 'out'] as const) {
          const handle = handles?.[index]?.[side];
          if (!handle) continue;
          ctx.beginPath(); ctx.moveTo(...point); ctx.lineTo(...handle);
          ctx.strokeStyle = '#7b8eaa'; ctx.lineWidth = 0.3; ctx.stroke();
          ctx.beginPath(); ctx.arc(handle[0], handle[1], 1.1, 0, 2 * Math.PI);
          ctx.fillStyle = '#ffffff'; ctx.fill();
          ctx.strokeStyle = '#1e63d1'; ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(point[0], point[1], index === pathEdit.activeIndex ? 1.8 : 1.3, 0, 2 * Math.PI);
        ctx.fillStyle = index === pathEdit.activeIndex ? '#1e63d1' : '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#1e63d1';
        ctx.lineWidth = 0.4;
        ctx.stroke();
      }
    }
  }
  let preview: LayoutRectanglePath | null =
    anchor && cursor && tool !== 'select' && tool !== 'eraser' && tool !== 'dimension' && tool !== 'angular-dimension' && !isLayoutArcTool(tool) && tool !== 'offset' && !isLayoutCornerTool(tool) && tool !== 'move' && tool !== 'rotate' && tool !== 'label'
      ? tool === 'freehand'
        ? createLayoutFreehand(freehand, FREEHAND_SMOOTHING_PX * page.size[0] / Math.max(1, canvas.getBoundingClientRect().width))
        : pathPoints(tool === 'text' ? 'rectangle' : tool, anchor, cursor, rectangleAmountMm,
          tool === 'text' ? { ...placementModifiers, square: false } : placementModifiers, polygonSides)
      : null;
  if (isLayoutArcTool(tool) && arcDraft && cursor) {
    const [a, b] = arcDraft.points;
    preview = { points: [...arcDraft.points, cursor], closed: false };
    if (a && b) {
      try { preview = createLayoutArc(tool, a, b, cursor,
        tool === 'arc' || tool === 'pie' ? layoutArcSweep(a, b, cursor, arcDraft.sweep) : undefined); }
      catch { /* Keep the construction guides visible while the curve is degenerate. */ }
    }
    ctx.beginPath(); ctx.moveTo(...arcDraft.points[0]!);
    for (const point of [...arcDraft.points.slice(1), cursor]) ctx.lineTo(...point);
    ctx.setLineDash([1, 1]); ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 0.3; ctx.stroke(); ctx.setLineDash([]);
    for (const point of arcDraft.points) {
      ctx.beginPath(); ctx.arc(...point, 1, 0, Math.PI * 2); ctx.fillStyle = '#1e63d1'; ctx.fill();
    }
  }
  if (tool === 'rotate' || tool === 'bezier' || isLayoutCornerTool(tool)) preview = draftPathPreview;
  if (tool === 'table' && preview && anchor && cursor) {
    paintLayoutTable(ctx, { id: 0, layerId: 0, kind: 'table', closed: true, points: preview.points,
      table: createLayoutTable(tableGrid.rows, tableGrid.columns), style: { ...state.defaultStyle, fillColor: null } }, page, state, true);
    preview = null;
  }
  if (preview && preview.points.length > 1) {
    traceLayoutPath(ctx, preview.points, preview.handles, preview.closed, preview.contourStarts);
    ctx.setLineDash([1.5, 1]);
    ctx.strokeStyle = '#1e63d1';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (tool === 'bezier' && draftPathPreview) {
    // The placed anchors, with the handles pulled from them.
    ctx.save(); ctx.strokeStyle = '#1e63d1'; ctx.fillStyle = '#1e63d1'; ctx.lineWidth = 0.35 / zoom;
    draftPathPreview.points.forEach((point, index) => {
      if (index === draftPathPreview.points.length - 1 && cursor) return;
      const handle = draftPathPreview.handles?.[index];
      for (const end of [handle?.in, handle?.out]) {
        if (!end) continue;
        ctx.beginPath(); ctx.moveTo(...point); ctx.lineTo(...end); ctx.stroke();
        ctx.beginPath(); ctx.arc(...end, 0.8 / zoom, 0, Math.PI * 2); ctx.fill();
      }
      ctx.beginPath(); ctx.rect(point[0] - 0.9 / zoom, point[1] - 0.9 / zoom, 1.8 / zoom, 1.8 / zoom); ctx.fill();
    });
    ctx.restore();
  }
  if ((tool === 'polygon' || tool === 'circumscribed-polygon') && anchor && cursor) {
    const radius = Math.hypot(cursor[0] - anchor[0], cursor[1] - anchor[1]);
    ctx.save(); ctx.beginPath();
    ctx.arc(anchor[0], anchor[1], radius, 0, Math.PI * 2);
    ctx.moveTo(...anchor); ctx.lineTo(...cursor);
    ctx.setLineDash([1.5 / zoom, 1 / zoom]);
    ctx.strokeStyle = '#1e63d1'; ctx.lineWidth = 0.35 / zoom;
    ctx.stroke(); ctx.restore();
  }
  if (tool === 'offset' && (offsetPreviewSource || draftPathPreview)) paintOffsetPreview(ctx,
    offsetPreviewSource && isLayoutLayerVisible(page, state, offsetPreviewSource.layerId) && !objectLocked(offsetPreviewSource, state) ? offsetPreviewSource : null, draftPathPreview, zoom);
  if (dimensionDraft && cursor) {
    const points = dimensionDraft.points;
    if (dimensionDraft.edgeGuide?.length === 2) {
      ctx.beginPath(); ctx.moveTo(...dimensionDraft.edgeGuide[0]!); ctx.lineTo(...dimensionDraft.edgeGuide[1]!);
      ctx.strokeStyle = '#1e63d1'; ctx.lineWidth = 1; ctx.stroke();
    }
    if (tool === 'angular-dimension') {
      const rays = dimensionDraft.rayPoints;
      if (rays && rays.length < 4) {
        ctx.beginPath(); ctx.moveTo(...rays[0]!); ctx.lineTo(...rays[1]!);
        if (rays[2]) { ctx.moveTo(...rays[2]); ctx.lineTo(...cursor); }
        ctx.strokeStyle = '#1e63d1'; ctx.lineWidth = 0.4; ctx.stroke();
      } else if (points.length === 1) {
        ctx.beginPath(); ctx.moveTo(...points[0]!); ctx.lineTo(...cursor);
        ctx.strokeStyle = '#1e63d1'; ctx.lineWidth = 0.4; ctx.stroke();
      }
      const geometry = angularDraftGeometry(dimensionDraft, cursor);
      if (geometry) {
        const [vertex, first, second] = geometry.points as [Point, Point, Point];
        ctx.beginPath(); ctx.moveTo(...first); ctx.lineTo(...vertex); ctx.lineTo(...second);
        ctx.setLineDash([1.5, 1]); ctx.strokeStyle = '#1e63d1'; ctx.lineWidth = 0.4; ctx.stroke(); ctx.setLineDash([]);
        const dim = createAngularDimension(); dim.reflex = geometry.placing && angularPlacementReflex(vertex, first, second, cursor);
        dim.cachedAngleDeg = angularMeasurement(vertex, first, second, dim.reflex)!;
        const radius = Math.max(2, Math.min(Math.hypot(first[0] - vertex[0], first[1] - vertex[1]), Math.hypot(second[0] - vertex[0], second[1] - vertex[1])) / 2);
        const placement: Point = geometry.placing ? cursor : [vertex[0] + radius, vertex[1]];
        if (!angularDimensionError([...geometry.points, placement])) paintAngularDimension(ctx, {
          id: 0, kind: 'angular-dimension', layerId: 0, closed: false, points: [...geometry.points, placement], angularDimension: dim }, true);
        ctx.font = `${3 / zoom}px Arial`; ctx.fillStyle = '#1e63d1'; ctx.fillText('V', vertex[0] + 2 / zoom, vertex[1] - 1 / zoom);
      }
    } else if (points.length === 1) {
      const a = points[0]!;
      const alignment = tool === 'dimension' ? inferLinearDimensionAlignment(a, cursor) : 'aligned';
      const guideEnd: Point = alignment === 'horizontal' ? [cursor[0], a[1]] : alignment === 'vertical' ? [a[0], cursor[1]] : cursor;
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...guideEnd);
      ctx.strokeStyle = '#1e63d1'; ctx.lineWidth = 0.4; ctx.stroke();
    } else if (points.length === 2) {
      const dimension = createLinearDimension();
      dimension.alignment = inferLinearDimensionAlignment(points[0]!, points[1]!);
      dimension.cachedValueMm = linearMeasurement(points[0]!, points[1]!, dimension.alignment);
      const attachments = dimensionDraft.modelAttachments?.filter((a): a is LayoutModelAttachment => a !== null);
      paintLayoutDimension(ctx, modelPreview({ id: 0, kind: 'dimension', layerId: 0, closed: false,
        points: [points[0]!, points[1]!, cursor], dimension,
        ...(attachments?.length === 2 ? { modelAnnotation: { attachments, status: 'resolved' as const } } : {}),
      }), true);
    }
    if (tool === 'angular-dimension') (dimensionDraft.rayPoints ?? points).forEach(point => {
      ctx.beginPath(); ctx.arc(...point, 1 / zoom, 0, Math.PI * 2); ctx.fillStyle = '#1e63d1'; ctx.fill();
    });
  }
  if (tool === 'label' && labelDraft && cursor) {
    const bend = labelDraft.bend ?? cursor, end: Point = labelDraft.bend ? [cursor[0], bend[1]] : bend;
    ctx.save(); ctx.strokeStyle = '#1e63d1'; ctx.lineWidth = 0.4;
    paintLayoutLabelLeader(ctx, { tip: labelDraft.tip, bend, start: end }, 'arrow');
    ctx.restore();
  }
  if ((tool === 'rotate' || tool === 'select') && rotationDraft && cursor) {
    const { pivot, reference, angleDeg } = rotationDraft;
    ctx.save(); ctx.lineWidth = 0.5 / zoom; ctx.strokeStyle = '#1e63d1';
    ctx.setLineDash([2 / zoom, 1 / zoom]);
    ctx.beginPath(); ctx.moveTo(...pivot); ctx.lineTo(...(reference ?? cursor)); ctx.stroke(); ctx.setLineDash([]);
    if (reference) {
      const start = Math.atan2(reference[1] - pivot[1], reference[0] - pivot[0]);
      const sweep = Math.max(-Math.PI * 2, Math.min(Math.PI * 2, angleDeg * Math.PI / 180));
      const direction = start + angleDeg * Math.PI / 180;
      const length = Math.max(Math.hypot(reference[0] - pivot[0], reference[1] - pivot[1]), Math.hypot(cursor[0] - pivot[0], cursor[1] - pivot[1]));
      ctx.beginPath(); ctx.moveTo(...pivot); ctx.lineTo(pivot[0] + length * Math.cos(direction), pivot[1] + length * Math.sin(direction)); ctx.stroke();
      const radius = Math.min(Math.hypot(reference[0] - pivot[0], reference[1] - pivot[1]) * 0.4, 12 / zoom);
      ctx.beginPath(); ctx.arc(...pivot, radius, start, start + sweep, sweep < 0); ctx.stroke();
      ctx.beginPath(); ctx.arc(...reference, 0.9 / zoom, 0, Math.PI * 2); ctx.fillStyle = '#1e63d1'; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(...pivot, 1.2 / zoom, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.stroke(); ctx.restore();
  }
  if (moveGuide) {
    // A dashed guide from the base point to the destination, with the base point marked.
    const { base, target } = moveGuide;
    ctx.save(); ctx.lineWidth = 0.5 / zoom; ctx.strokeStyle = '#1e63d1';
    ctx.setLineDash([2 / zoom, 1 / zoom]);
    ctx.beginPath(); ctx.moveTo(...base); ctx.lineTo(...target); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(...base, 1.2 / zoom, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.stroke(); ctx.restore();
  }
}

/** A page painted for print (and for the sample check), with no selection, guides or tool feedback. */
export function paintPrintPage(canvas: HTMLCanvasElement, page: LayoutPage, state: LayoutDocumentState, dpi: number): void {
  if (!canvas.getContext('2d')) throw new Error('The print canvas could not be created. Try a lower print quality.');
  paintPage(canvas, page, state, null, null, 'select', new Set<number>(), null, null, [], 1,
    false, null, 5, null, null, null, null, true, dpi);
}

function LayoutPresentation({ tab, onClose }: { tab: LayoutTab; onClose: () => void }): JSX.Element {
  const version = useDocumentVersion(tab);
  const imageLoads = useLayoutAssetLoads();
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [index, setIndex] = useState(() => Math.max(0, tab.doc.state.pageOrder.indexOf(tab.activePageId)));
  const [viewport, setViewport] = useState(() => [window.innerWidth, window.innerHeight]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const state = tab.doc.state;
  const count = state.pageOrder.length;
  const page = state.pages.get(state.pageOrder[Math.min(index, count - 1)]!)!;
  const scale = Math.max(0.01, Math.min((viewport[0]! - 48) / page.size[0], (viewport[1]! - 48) / page.size[1]));
  useEffect(() => {
    if (canvas.current) paintPage(canvas.current, page, state, null, null, 'select', new Set<number>(),
      null, null, [], scale / PX_PER_MM, false, null, 5, null, null, null, null, true);
  }, [page, state, version, imageLoads, scale]);
  useEffect(() => {
    const element = root.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>('.pf-app');
    const wasInert = app?.inert ?? false;
    if (app) app.inert = true;
    element.focus();
    let disposed = false;
    let ownedFullscreen = false;
    // Remain in the presentation overlay if fullscreen is unavailable or denied.
    if (!document.fullscreenElement && element.requestFullscreen) {
      void element.requestFullscreen().then(() => {
        ownedFullscreen = true;
        if (disposed && document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
      }).catch(() => {});
    }
    const resize = () => setViewport([window.innerWidth, window.innerHeight]);
    const fullscreen = () => {
      resize();
      if (ownedFullscreen && !document.fullscreenElement) closeRef.current();
    };
    const keydown = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      else if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) {
        event.preventDefault(); setIndex(value => Math.min(count - 1, value + 1));
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) {
        event.preventDefault(); setIndex(value => Math.max(0, value - 1));
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); setIndex(event.key === 'Home' ? 0 : count - 1);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        element.focus();
      }
    };
    window.addEventListener('resize', resize);
    document.addEventListener('fullscreenchange', fullscreen);
    window.addEventListener('keydown', keydown, true);
    return () => {
      disposed = true;
      window.removeEventListener('resize', resize);
      document.removeEventListener('fullscreenchange', fullscreen);
      window.removeEventListener('keydown', keydown, true);
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
      if (app) app.inert = wasInert;
      previousFocus?.focus();
    };
  }, [count]);
  return createPortal(<div ref={root} className="pf-layout-presentation" role="dialog" aria-modal="true"
    aria-label="Presentation mode" tabIndex={-1}
    aria-description="Left click or Left Arrow: previous page. Right click, Right Arrow, or Space: next page. Escape: exit."
    onClick={(event) => { if (event.button === 0) setIndex(value => Math.max(0, value - 1)); }}
    onContextMenu={(event) => { event.preventDefault(); setIndex(value => Math.min(count - 1, value + 1)); }}>
    <div className="pf-layout-presentation-stage">
      <canvas ref={canvas} aria-label={`${page.name} presentation`} style={{ width: page.size[0] * scale, height: page.size[1] * scale }} />
    </div>
  </div>, document.body);
}

/** Screen pixels of drag per added table column and row while choosing counts. */
const TABLE_COUNT_STEP_PX = [36, 18] as const;

/** Title of the context-sensitive top panel: what is selected, or the default style when nothing is. */
function layoutSelectionTitle(entity: LayoutEntity | null, count: number): string {
  if (count > 1) return `${count} Objects`;
  if (!entity) return 'Default Style';
  if (entity.table) return 'Table';
  if (entity.image) return isViewport(entity) ? 'Model View' : 'Image';
  if (entity.dimension || entity.angularDimension) return 'Dimension';
  if (entity.kind === 'label') return 'Label';
  if (entity.text) return 'Text';
  return 'Shape';
}

function LayoutAccordion({ title, id, open, onToggle, children, count }: {
  title: string;
  id: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  count?: number;
}): JSX.Element {
  return (
    <section className="pf-layout-accordion">
      <h2>
        <button type="button" className="pf-layout-accordion-trigger" aria-expanded={open}
          aria-controls={id} onClick={onToggle}>
          <span className={`pf-layout-accordion-chevron${open ? ' is-open' : ''}`} aria-hidden="true">
            <Icon name="chevron-right" size={14} />
          </span>
          {title}
          {count !== undefined ? <span className="pf-layout-accordion-count" aria-hidden="true">{count}</span> : null}
        </button>
      </h2>
      {open ? <div id={id} className="pf-layout-accordion-content">{children}</div> : null}
    </section>
  );
}

/** How a dimension's measured points are attached: to vertices, or also to points along segments. */
function associationLabel(anchors: readonly (LayoutDimensionAnchor | null)[]): string {
  return anchors.some((anchor) => anchor?.t !== undefined) ? 'Associated with paths' : 'Associated with path vertices';
}

export function LayoutWorkspace({
  tab,
  session,
  leading,
  objectBrowser,
  cloud,
}: {
  tab: LayoutTab;
  session: DocumentSession;
  /** The left menu bar and its dock, first in the editor band below the tool row, mirroring the settings panel. */
  leading?: ReactNode;
  /** The left menu bar's docked Object browser: rendered into `host` while `open`. */
  objectBrowser?: { readonly host: HTMLElement | null; readonly open: boolean; readonly onClose: () => void } | undefined;
  /** Cloud files for model references; `saves` counts cloud model saves in this session, each prompting a freshness check. */
  cloud?: (LayoutCloudAccess & { saves: number }) | undefined;
}): JSX.Element {
  const version = useDocumentVersion(tab);
  const imageLoads = useLayoutAssetLoads();
  const [choosingModel, setChoosingModel] = useState(false);
  const [referenceStatuses, setReferenceStatuses] = useState<Map<number, LayoutReferenceStatus>>(new Map());
  const cloudApi = cloud?.api;
  // Stale pictures of cloud views are replaced by finished renders without an undo step.
  useEffect(() => { if (cloudApi) persistLayoutViewportRenders(tab); }, [tab, cloudApi, version, imageLoads]);
  // References follow their model's latest saved revision: checked on open, on return to the window, and after a cloud model save.
  const referenceCount = [...tab.doc.state.references.values()].filter(reference => reference.target.kind === 'cloud').length;
  const cloudSaves = cloud?.saves ?? 0;
  useEffect(() => {
    if (!cloudApi || !referenceCount) { setReferenceStatuses(new Map()); return undefined; }
    let live = true;
    const check = (): void => {
      setReferenceStatuses(current => { const next = new Map(current); for (const reference of tab.doc.state.references.values()) if (!next.has(reference.id)) next.set(reference.id, { kind: 'checking' }); return next; });
      void checkLayoutReferences(tab, cloudApi, () => live).then(statuses => { if (live) setReferenceStatuses(statuses); });
    };
    check();
    const onFocus = (): void => { if (document.visibilityState === 'visible') check(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { live = false; window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [tab, cloudApi, referenceCount, cloudSaves]);
  const [presenting, setPresenting] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [exportingImage, setExportingImage] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const panOffset = useRef<Point>([0, 0]);
  const setPanOffset = (x: number, y: number): void => {
    panOffset.current = [x, y];
    workspaceRef.current?.style.setProperty('--pf-layout-pan-x', `${x}px`);
    workspaceRef.current?.style.setProperty('--pf-layout-pan-y', `${y}px`);
    paintSurround.current();
  };
  const [tableCellsActive, setTableCellsActive] = useState(false);
  const [tableResizePreview, setTableResizePreview] = useState<LayoutEntity | null>(null);
  const [tableEditRequest, setTableEditRequest] = useState(0);
  const tableDrag = useRef<TableGridSelection | null>(null);
  const [tableRows, setTableRows] = useState(3), [tableColumns, setTableColumns] = useState(3);
  // True while the button is held after the first table corner, so dragging picks rows and columns.
  const [tableCounting, setTableCounting] = useState(false);
  const [tableSelection, setTableSelection] = useState<TableGridSelection>({ anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 } });
  const tableCell = tableSelection.focus;
  const setTableCell = (cell: TableCellAddress, extend = false) => setTableSelection(current => ({ anchor: extend ? current.anchor : cell, focus: cell }));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surroundRef = useRef<HTMLCanvasElement>(null);
  const paintSurround = useRef<() => void>(() => {});
  const inlineTextRef = useRef<HTMLDivElement>(null);
  const [textSelection, setTextSelectionState] = useState({ start: 0, end: 0 });
  const textSelectionRef = useRef(textSelection);
  const setTextSelection = (range: { start: number; end: number }): void => {
    textSelectionRef.current = range; setTextSelectionState(range);
  };
  const imageImportInput = useRef<HTMLInputElement>(null);
  const imageImportRequest = useRef(0);
  const clipboardWrite = useRef<Promise<void> | null>(null);
  const textMeasureCanvas = useRef<HTMLCanvasElement | null>(null);
  const [layerScopeChoice, setLayerScopeChoice] = useState<{ layerId: number; pageId: number } | null>(null);
  const zoomAnchor = useRef<{ x: number; y: number; pageX: number; pageY: number } | null>(null);
  const zoomCenter = useRef<Point | null>(null);
  const zoomMenuRef = useRef<HTMLDivElement>(null);
  const pointerDown = useRef<{ point: Point; x: number; y: number; fromAnchor: boolean } | null>(null);
  const linePointer = useRef<{ clientX: number; clientY: number } | null>(null);
  const scaleStart = useRef<ScaleDrag | null>(null);
  const [scalePreview, setScalePreview] = useState<PathEditPreview | null>(null);
  const moveStart = useRef<{ entityIds: number[]; point: Point; x: number; y: number; labelPart?: LayoutLabelDragPart } | null>(null);
  const pointEditStart = useRef<{ index: number; side: 'anchor' | 'in' | 'out'; points: Point[];
    handles: LayoutPathHandle[]; x: number; y: number } | null>(null);
  const [tool, setTool] = useState<LayoutTool>(tab.workspace.tool === 'shape-builder' ? 'select' : tab.workspace.tool);
  const modelSnap = useRef<LayoutModelAttachment | null>(null);
  const modelSnapUnavailable = useRef(false);
  const [reattachModel, setReattachModel] = useState<{ id: number; attachments: LayoutModelAttachment[] } | null>(null);
  useEffect(() => { if (tool !== 'dimension' && tool !== 'label') setReattachModel(null); }, [tool]);
  useEffect(() => { setReattachModel(null); }, [tab, tab.activePageId]);
  useEffect(() => {
    const host = tab.commands.ctx.tx;
    if (!(host instanceof LayoutDocumentHost)) return;
    host.annotationModels = (state, source) => peekLayoutViewportModel(state, source)?.state;
    const state = tab.doc.state;
    const all = [...state.sharedEntities.values(), ...[...state.pages.values()].flatMap(page => [...page.entities.values()])];
    const annotated = all.some(entity => entity.modelAnnotation);
    if (!annotated && tool !== 'dimension' && tool !== 'label') return;
    let live = true;
    const page = state.pages.get(tab.activePageId);
    const picking = tool === 'dimension' || tool === 'label';
    const views = picking ? [...state.sharedEntities.values(), ...page?.entities.values() ?? []].filter(isViewport) : [];
    const needed = [...all.flatMap(entity => entity.modelAnnotation?.attachments.map(a => a.source) ?? []), ...views.map(view => view.image.viewport.source)];
    const sources = new Map(needed.map(source => [modelSourceRevisionKey(state, source), source]));
    const release = retainLayoutViewportModels(sources.keys());
    for (const [key, source] of sources) {
      void layoutViewportModel(state, source).then(() => {
        if (live && annotated && modelSourceRevisionKey(tab.doc.state, source) === key) tab.commands.execute('layout.annotation.refreshModels', {});
      }, () => {});
    }
    return () => { live = false; release(); };
  }, [tab, tab.activePageId, tool, version]);
  const [booleanIds, setBooleanIds] = useState<number[]>([]);
  const [polygonAlt, setPolygonAlt] = useState(false);
  const polygonAltRef = useRef(false);
  const updatePolygonAlt = useCallback((held: boolean) => {
    polygonAltRef.current = held; setPolygonAlt(held);
  }, []);
  const polygonTool: LayoutTool = polygonAlt && isPolygonTool(tool) ? tool === 'polygon' ? 'circumscribed-polygon' : 'polygon' : tool;
  /** Sides of the next polygon, shared by both Polygon tools. */
  const [polygonSides, setPolygonSides] = useState(6);
  const [anchor, setAnchor] = useState<Point | null>(tab.workspace.anchor);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [placementModifiers, setPlacementModifiers] = useState(NO_PLACEMENT_MODIFIERS);
  const placementModifiersRef = useRef(NO_PLACEMENT_MODIFIERS);
  // Each shape tool's last shape, which a double-click with that tool draws again.
  const shapeRepeats = useRef(new Map<LayoutTool, LayoutShapeRepeat>());
  useEffect(() => { trackLayoutCreations(tab.doc); }, [tab]);
  const updatePlacementModifiers = useCallback((next: PlacementModifiers) => {
    placementModifiersRef.current = next;
    setPlacementModifiers(previous => previous.center === next.center && previous.square === next.square ? previous : next);
  }, []);
  useEffect(() => {
    if (!usesPlacementModifiers(tool) && tool !== 'text') { updatePlacementModifiers(NO_PLACEMENT_MODIFIERS); return; }
    const onModifier = (event: KeyboardEvent) => {
      if (!['Shift', 'Control', 'Meta'].includes(event.key)) return;
      updatePlacementModifiers({ center: event.ctrlKey || event.metaKey, square: tool !== 'text' && event.shiftKey });
      setSnapKind(null);
    };
    const onBlur = () => updatePlacementModifiers(NO_PLACEMENT_MODIFIERS);
    window.addEventListener('keydown', onModifier);
    window.addEventListener('keyup', onModifier);
    window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('keydown', onModifier); window.removeEventListener('keyup', onModifier); window.removeEventListener('blur', onBlur); };
  }, [tool, updatePlacementModifiers]);
  const [dimensionDraft, setDimensionDraft] = useState<DimensionDraft | null>(null);
  const [angularEdgeFirst, setAngularEdgeFirst] = useState<CornerPick | null>(null);
  const [arcDraft, setArcDraft] = useState<ArcDraft | null>(null);
  const [labelDraft, setLabelDraft] = useState<LabelDraft | null>(null);
  const [rotationDraft, setRotationDraft] = useState<RotationDraft | null>(null);
  // The Select tool's rotation grip. Its center is kept as fractions of the selection box.
  const [gripCenter, setGripCenter] = useState<{ entityId: number; u: number; v: number } | null>(null);
  const [gripRotation, setGripRotation] = useState<RotationDraft | null>(null);
  const gripDrag = useRef<'center' | 'rotate' | null>(null);
  const [moveDraft, setMoveDraft] = useState<MoveDraft | null>(null);
  // The latest Move copy while an array may still replace it: its undo entry must still be the newest.
  const lastMoveCopy = useRef<{ pageId: number; entityIds: number[]; delta: Point; entry: object | undefined } | null>(null);
  const [cornerFirst, setCornerFirst] = useState<CornerPick | null>(null);
  const [cornerHover, setCornerHover] = useState<CornerPick | null>(null);
  const [filletRadiusMm, setFilletRadiusMm] = useState(5);
  const [chamferDistanceMm, setChamferDistanceMm] = useState(5);
  const cornerAmountMm = tool === 'chamfer' ? chamferDistanceMm : filletRadiusMm;
  const [offsetDraft, setOffsetDraft] = useState<{ entityId: number; distanceMm: number } | null>(null);
  useEffect(() => { setOffsetDraft(null); setCornerFirst(null); setCornerHover(null); setRotationDraft(null); setLabelDraft(null); }, [tool]);
  const [arcError, setArcError] = useState<string | null>(null);
  useEffect(() => { setArcDraft(null); setArcError(null); }, [tool]);
  const [dimensionError, setDimensionError] = useState<string | null>(null);
  const [snapKind, setSnapKind] = useState<PaperSnapKind | null>(null);
  const [snapType, setSnapType] = useState<PaperSnapKind | 'center' | null>(null);
  const [snapHoverEpoch, setSnapHoverEpoch] = useState(0);
  useEffect(() => { setSnapKind(null); setCursor(null); }, [tool]);
  const [freehand, setFreehand] = useState<Point[]>([]);
  const previousFreehandTool = useRef(tool);
  useEffect(() => {
    if (tool === 'freehand' || previousFreehandTool.current === 'freehand') {
      pointerDown.current = null;
      setFreehand([]); setAnchor(null); setCursor(null); setSnapKind(null);
    }
    previousFreehandTool.current = tool;
  }, [tool, tab.activePageId]);
  // Ordered multi-selection; single-object editors and handles derive from the one-item case.
  const [selectionIds, setSelectionIds] = useState<number[]>(tab.workspace.selectedEntityId === null ? [] : [tab.workspace.selectedEntityId]);
  const selectionId = selectionIds.length === 1 ? selectionIds[0]! : null;
  const setSelectionId = useCallback((id: number | null): void => setSelectionIds(id === null ? [] : [id]), []);
  const selectedSet = useMemo(() => new Set(selectionIds), [selectionIds]);
  /** The object browser's choice on another page, applied once that page is active. */
  const pendingPageSelection = useRef<number[] | null>(null);
  const [boxSelect, setBoxSelect] = useState<BoxSelect | null>(null);
  const boxStart = useRef<{ point: Point; x: number; y: number; additive: boolean } | null>(null);
  const [lasso, setLasso] = useState<LassoDraft | null>(null);
  /** Where the Lasso's pointer went down, and the screen position of the last outline point. */
  const lassoPress = useRef<{ point: Point; x: number; y: number } | null>(null);
  const lassoLast = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { setLasso(null); lassoPress.current = null; lassoLast.current = null; }, [tool, tab.activePageId]);
  const [movePreview, setMovePreview] = useState<MovePreview | null>(null);
  useEffect(() => { setMoveDraft(null); setMovePreview(null); lastMoveCopy.current = null; }, [tool]);
  /** The vertex or midpoint Line last snapped to, and the guide from it while the pointer lines up with it. */
  const lineReference = useRef<Point | null>(null);
  const [lineGuide, setLineGuide] = useState<{ reference: Point; axis: PaperAlignment['axis'] } | null>(null);
  useEffect(() => { lineReference.current = null; setLineGuide(null); }, [tool, tab.activePageId]);
  /** The Bézier tool's path in progress, and the screen position of a press that may yet drag out handles. */
  const [bezierDraft, setBezierDraft] = useState<LayoutBezierDraft | null>(null);
  const bezierPress = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { setBezierDraft(null); bezierPress.current = null; }, [tool, tab.activePageId]);
  const [editingPathId, setEditingPathId] = useState<number | null>(null);
  const [editingTextId, setEditingTextId] = useState<number | null>(null);
  const initialLabelEditId = useRef<number | null>(null);
  const [editPoints, setEditPoints] = useState<Point[] | null>(null);
  const [editHandles, setEditHandles] = useState<LayoutPathHandle[] | null>(null);
  const [activePointIndex, setActivePointIndex] = useState<number | null>(null);
  const [vcb, setVcb] = useState(tab.workspace.vcbDraft);
  const [vcbError, setVcbError] = useState<string | null>(null);
  /** What the last DXF import did: its scale and anything it left out. */
  const [importNote, setImportNote] = useState<string | null>(null);
  const [cornerRadiusMm, setCornerRadiusMm] = useState(5);
  const [bulgeMm, setBulgeMm] = useState(5);
  const rectangleAmountMm = tool === 'bulged-rectangle' ? bulgeMm : cornerRadiusMm;
  const [rotationDeg, setRotationDeg] = useState('90');
  const [scalePercent, setScalePercent] = useState('100');
  const scalePercentInput = useRef<HTMLInputElement>(null);
  const [zoom, setZoom] = useState(tab.workspace.zoom);
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const [zoomRequest, setZoomRequest] = useState(0);
  const [openSections, setOpenSections] = useState({ selection: true });
  // The Document Settings dialog, opened from the object browser or the `layout.document.settings` command.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // A model view whose camera is being navigated, and the camera previewed during a drag or zoom.
  const [navigatingViewportId, setNavigatingViewportId] = useState<number | null>(null);
  const [viewportCameraPreview, setViewportCameraPreview] = useState<LayoutViewportCamera | null>(null);
  const viewportDrag = useRef<{ start: Point; camera: LayoutViewportCamera; pan: boolean } | null>(null);
  const viewportPreviewRef = useRef<LayoutViewportCamera | null>(null);
  const navigatingViewportRef = useRef<number | null>(null);
  navigatingViewportRef.current = navigatingViewportId;
  const viewportWheel = useRef<(event: WheelEvent) => boolean>(() => false);
  const viewportZoomCommit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [viewportSourceKey, setViewportSourceKey] = useState('');
  const state = tab.doc.state;
  const page = state.pages.get(tab.activePageId) ?? state.pages.get(state.pageOrder[0]!)!;
  const viewportSources = useMemo(() => layoutViewportSources(state), [state.modelArchives, state.references]);
  const viewportSource = viewportSources.find(source => source.key === viewportSourceKey) ?? viewportSources[0] ?? null;
  useEffect(() => { setContextMenu(null); }, [tab, page.id, tool, presenting, printing]);
  const selectedEntity = selectionId === null ? null : (entityOnPage(page, state, selectionId) ?? null);
  useEffect(() => {
    if (reattachModel && (selectedEntity?.id !== reattachModel.id || (!selectedEntity.modelAnnotation && !selectedEntity.preservedModelConnections) ||
      tool !== (selectedEntity.dimension ? 'dimension' : 'label'))) setReattachModel(null);
  }, [reattachModel, selectedEntity, tool]);
  const shapeBuilder = useLayoutShapeBuilder(tab, page, state, tool === 'shape-builder', ids => {
    setSelectionIds(ids); setTool('select'); setVcbError(null);
  }, setVcbError);
  const booleanPreview = useMemo(() => {
    const operation = booleanOperation(tool);
    if (!operation || booleanIds.length < 2) return null;
    try {
      const sources = booleanIds.map(id => entityOnPage(page, state, id));
      if (sources.some(entity => !entity || entity.hidden || objectLocked(entity, state) || !isLayoutLayerVisible(page, state, entity.layerId)))
        return { shapes: [], error: 'A picked shape is no longer available. Escape to start again.' };
      return { shapes: operateLayoutPaths(sources as LayoutEntity[], operation), error: null };
    } catch (error) { return { shapes: [], error: error instanceof Error ? error.message : 'Cannot preview this operation.' }; }
  }, [tool, booleanIds, page, state]);
  // Keyboard shortcuts and page changes can switch context without going through chooseTool.
  useEffect(() => { setBooleanIds([]); }, [tool, tab, page.id]);
  const commitBoolean = (): void => {
    const operation = booleanOperation(tool);
    if (!operation || booleanIds.length < 2) { setVcbError('Pick a target and at least one other shape.'); return; }
    try {
      const result = tab.commands.execute('layout.shape.boolean', { pageId: page.id, entityIds: booleanIds, operation }) as number | number[] | null;
      setBooleanIds([]); setSelectionIds(Array.isArray(result) ? result : result === null ? [] : [result]); setVcbError(null); setCursor(null); setSnapKind(null);
    } catch (error) { setVcbError(error instanceof Error ? error.message : 'Boolean operation failed.'); }
  };

  // An object selected again starts with its rotation center in the middle.
  useEffect(() => { setGripCenter(null); setGripRotation(null); gripDrag.current = null; }, [selectedEntity?.id]);
  // Hiding an object, including through undo or redo, drops it from the selection.
  useEffect(() => {
    const shown = selectionIds.filter(id => !entityOnPage(page, state, id)?.hidden);
    if (shown.length !== selectionIds.length) setSelectionIds(shown);
  }, [version, selectionIds, page, state]);
  const offsetSource = offsetDraft ? entityOnPage(page, state, offsetDraft.entityId) : undefined;
  const offsetResult = useMemo((): { shape: LayoutRectanglePath | null; error: string | null } => {
    if (tool !== 'offset' || !offsetDraft) return { shape: null, error: null };
    const layer = offsetSource ? state.layers.get(offsetSource.layerId) : null;
    if (!offsetSource || !layer || !isLayoutLayerVisible(page, state, offsetSource.layerId) || layer.locked || offsetSource.locked) return { shape: null, error: 'Source path is unavailable.' };
    if (Math.abs(offsetDraft.distanceMm) < 1e-6) return { shape: null, error: null };
    try { return { shape: createLayoutOffset(offsetSource, offsetDraft.distanceMm), error: null }; }
    catch (error) { return { shape: null, error: error instanceof Error ? error.message : 'Cannot offset this path.' }; }
  }, [tool, offsetDraft, offsetSource, state]);
  const cornerResult = useMemo((): { shape: LayoutRectanglePath | null; error: string | null } => {
    if (!isLayoutCornerTool(tool) || !cornerFirst || !cornerHover ||
        (cornerFirst.entityId === cornerHover.entityId && cornerFirst.segmentIndex === cornerHover.segmentIndex)) return { shape: null, error: null };
    const first = entityOnPage(page, state, cornerFirst.entityId), second = entityOnPage(page, state, cornerHover.entityId);
    if (!first || !second) return { shape: null, error: 'Source path is unavailable.' };
    const layer = state.layers.get(first.layerId), otherLayer = state.layers.get(second.layerId);
    if (!layer || !isLayoutLayerVisible(page, state, first.layerId) || layer.locked || !otherLayer || !isLayoutLayerVisible(page, state, second.layerId) || otherLayer.locked || first.locked || second.locked) return { shape: null, error: 'Source layer is unavailable.' };
    if (first.layerId !== second.layerId) return { shape: null, error: 'Both paths must be on the same layer.' };
    try { return { shape: createLayoutCornerBetween(first, cornerFirst.segmentIndex, second, cornerHover.segmentIndex,
      tool, cornerAmountMm, first.id === second.id, cornerFirst.point, cornerHover.point), error: null }; }
    catch (error) { return { shape: null, error: error instanceof Error ? error.message : 'Cannot edit this corner.' }; }
  }, [tool, cornerFirst, cornerHover, page, state, cornerAmountMm]);
  // The Rotate tool's draft, or the Select tool's while its rotation handle is dragged.
  const activeRotation = tool === 'rotate' ? rotationDraft : tool === 'select' ? gripRotation : null;
  const rotationSource = rotationDraft ? entityOnPage(page, state, rotationDraft.entityId) : undefined;
  const activeRotationSource = activeRotation ? entityOnPage(page, state, activeRotation.entityId) : undefined;
  const rotationPreview = useMemo((): PathEditPreview | null => {
    const rotationDraft = activeRotation, rotationSource = activeRotationSource;
    if (!rotationDraft?.reference || !rotationSource) return null;
    const layer = state.layers.get(rotationSource.layerId);
    if (!layer || !isLayoutLayerVisible(page, state, rotationSource.layerId) || layer.locked || rotationSource.locked) return null;
    try {
      const geometry = rotateLayoutEntity(rotationSource, rotationDraft.pivot, rotationDraft.angleDeg);
      return { ...(geometry.text ? { rotationDeg: geometry.text.rotationDeg ?? 0 } : {}), entityId: rotationSource.id, points: geometry.points, handles: geometry.handles ?? [], activeIndex: null, showVertices: false };
    } catch { return null; }
  }, [activeRotation, activeRotationSource, state]);
  useEffect(() => {
    if (!rotationDraft) return;
    const layer = rotationSource ? state.layers.get(rotationSource.layerId) : null;
    if (!rotationSource || !layer || !isLayoutLayerVisible(page, state, rotationSource.layerId) || layer.locked || rotationSource.locked) { setRotationDraft(null); setCursor(null); }
  }, [rotationDraft, rotationSource, state]);
  useEffect(() => {
    // A pending move ends when any moving object is removed, hidden, or locked.
    if (moveDraft?.entityIds.some((id) => {
      const entity = entityOnPage(page, state, id);
      return !entity || !isLayoutLayerVisible(page, state, entity.layerId) || objectLocked(entity, state);
    })) { setMoveDraft(null); setMovePreview(null); setCursor(null); setSnapKind(null); }
  }, [moveDraft, page, state]);
  const editingText = editingTextId === null ? null : entityOnPage(page, state, editingTextId);
  const initialLabelEdit = editingText?.kind === 'label' && initialLabelEditId.current === editingText.id;
  const inlineEditingText = useMemo(() => {
    if (!initialLabelEdit || !editingText) return editingText;
    textMeasureCanvas.current ??= document.createElement('canvas');
    const ctx = textMeasureCanvas.current.getContext('2d');
    return ctx ? { ...editingText, points: fittedLayoutTextBounds(ctx, editingText, page, state) } : editingText;
  }, [editingText, initialLabelEdit, page, state, imageLoads]);
  const inlineTextPaddingMm = useMemo(() => {
    if (!inlineEditingText?.text || inlineEditingText.text.vertical === 'top') return 0;
    const [a, b] = inlineEditingText.points, text = initialLabelEdit ? { ...inlineEditingText.text, bounded: false } : inlineEditingText.text;
    if (!a || !b) return 0;
    textMeasureCanvas.current ??= document.createElement('canvas');
    const ctx = textMeasureCanvas.current.getContext('2d');
    const width = Math.abs(b[0] - a[0]), lineHeight = text.fontSizePt * 25.4 / 72 * layoutFontLineHeight(text);
    const contentHeight = ctx ? layoutTextBlock(ctx, text, width - 2 * layoutTextInset(width), page, state).lineHeights.reduce((sum, value) => sum + value, 0) : text.content.split('\n').length * lineHeight;
    return Math.max(0, (Math.abs(b[1] - a[1]) - contentHeight) / (text.vertical === 'middle' ? 2 : 1));
  }, [inlineEditingText, initialLabelEdit, page, state, imageLoads]);
  const canTransform = Boolean(selectedEntity &&
    isLayoutLayerVisible(page, state, selectedEntity.layerId) && !objectLocked(selectedEntity, state));
  useEffect(() => { setTableResizePreview(null); }, [selectionId, tool, page.id, canTransform, version]);
  const updateTableCellText = (cells: TableCellAddress[], content: string): void => {
    const currentPage = tab.doc.state.pages.get(page.id);
    const current = currentPage && selectedEntity ? entityOnPage(currentPage, tab.doc.state, selectedEntity.id) : undefined;
    if (!current?.table || objectLocked(current, tab.doc.state) || !isLayoutLayerVisible(currentPage!, tab.doc.state, current.layerId)) return;
    const table = cloneLayoutTable(current.table);
    for (const cell of cells) {
      const target = table.cells[cell.row * table.columns.length + cell.column];
      if (target) { target.text.content = content; delete target.text.spans; }
    }
    tab.commands.execute('layout.table.update', { pageId: page.id, entityId: current.id, table });
  };
  const selectionBounds = (tool === 'select' || tool === 'scale') && selectedEntity && (selectedEntity.kind === 'path' || selectedEntity.text || selectedEntity.image || selectedEntity.table) && editingTextId === null &&
    selectedEntity.points.length >= 2 && canTransform && editingPathId === null
    ? (() => {
      const bounds = selectionBox(selectedEntity, tableResizePreview?.id === selectedEntity.id ? tableResizePreview.points : scalePreview?.points ?? undefined, scalePreview?.handles ?? undefined);
      if (movePreview?.entityIds.has(selectedEntity.id) && !movePreview.copy) return { ...bounds,
        minX: bounds.minX + movePreview.delta[0], minY: bounds.minY + movePreview.delta[1],
        maxX: bounds.maxX + movePreview.delta[0], maxY: bounds.maxY + movePreview.delta[1] };
      return bounds;
    })() : null;
  /**
   * The selection box's CSS transform: turned with its object, and while the rotation handle is dragged also turned
   * with the preview about the center of rotation, so the box and grip follow the object.
   */
  const gripBoxTransform = (box: Box): { transform: string; transformOrigin?: string } => {
    const angle = selectedEntity ? boxAngle(selectedEntity) : 0;
    if (!gripRotation || !selectedEntity || gripRotation.entityId !== selectedEntity.id) return { transform: `rotate(${angle}deg)` };
    const { u, v } = gripFraction(selectedEntity), local: Point = [box.minX + u * box.width, box.minY + v * box.height];
    // About the pivot's own place in the box, then moved to where the pivot is on the page.
    const pivot = boxPoint(box, angle, u, v), px = PX_PER_MM * zoom;
    return { transform: `translate(${(pivot[0] - local[0]) * px}px, ${(pivot[1] - local[1]) * px}px) rotate(${angle + gripRotation.angleDeg}deg)`,
      transformOrigin: `${u * 100}% ${v * 100}%` };
  };
  const angularPreview = (() => {
    if (tool !== 'angular-dimension' || !dimensionDraft || dimensionDraft.points.length < 2 || !cursor) return null;
    const geometry = angularDraftGeometry(dimensionDraft, cursor);
    if (!geometry) return null;
    const points = geometry.points;
    const reflex = geometry.placing && angularPlacementReflex(points[0]!, points[1]!, points[2]!, cursor);
    const angle = angularMeasurement(points[0]!, points[1]!, points[2]!, reflex);
    return angle === null ? null : `${angle.toFixed(1)}°`;
  })();
  const currentStyle = selectedEntity?.style ?? state.defaultStyle;
  const setStyle = (values: object): void => {
    tab.commands.execute(selectedEntity ? 'layout.shape.setStyle' : 'layout.style.setDefault', {
      ...(selectedEntity ? { pageId: page.id, entityId: selectedEntity.id } : {}),
      ...values,
    });
  };

  useEffect(() => {
    tab.workspace.tool = tool;
    tab.workspace.zoom = zoom;
    tab.workspace.selectedEntityId = selectionId;
    tab.workspace.anchor = anchor;
    tab.workspace.vcbDraft = vcb;
  }, [tab, tool, zoom, selectionId, anchor, vcb]);

  useEffect(() => () => {
    if (pointerDown.current || moveStart.current || pointEditStart.current) tab.workspace.anchor = null;
    pointerDown.current = null;
    moveStart.current = null;
    pointEditStart.current = null;
  }, [tab]);

  useEffect(() => {
    const paint = (canvas: HTMLCanvasElement, surround: LayoutSurround | null = null) => paintPage(canvas, page, state, anchor, cursor, polygonTool, selectedSet,
      movePreview, rotationPreview ?? scalePreview ?? (editingPathId === null ? null : {
        entityId: editingPathId, points: editPoints, handles: editHandles, activeIndex: activePointIndex,
      }), freehand, zoom, false, dimensionDraft, rectangleAmountMm, arcDraft,
      tool === 'bezier' && bezierDraft ? previewLayoutBezier(bezierDraft, bezierPress.current ? null : cursor) : offsetResult.shape ?? cornerResult.shape, activeRotation, labelDraft,
      false, undefined, initialLabelEdit ? editingTextId : null, tool === 'offset' ? offsetSource ?? null : null,
      tool === 'move' && moveDraft ? { base: moveDraft.base, target: cursor ?? moveDraft.base } : null, { rows: tableRows, columns: tableColumns }, placementModifiers,
      navigatingViewportId !== null && viewportCameraPreview ? { entityId: navigatingViewportId, camera: viewportCameraPreview } : null, polygonSides, tableResizePreview, surround);
    if (canvasRef.current) paint(canvasRef.current);
    paintSurround.current = () => {
      const canvas = canvasRef.current, surround = surroundRef.current;
      if (!canvas || !surround) return;
      const pageRect = canvas.getBoundingClientRect(), frame = surround.getBoundingClientRect();
      const pxPerMm = pageRect.width / page.size[0];
      if (!(pxPerMm > 0) || frame.width <= 0 || frame.height <= 0) { surround.width = 0; surround.height = 0; return; }
      paint(surround, { x: (frame.left - pageRect.left) / pxPerMm, y: (frame.top - pageRect.top) / pxPerMm,
        width: frame.width / pxPerMm, height: frame.height / pxPerMm, pxPerMm });
    };
    paintSurround.current();
  }, [version, imageLoads, page, state, anchor, cursor, tool, selectedSet, movePreview, moveDraft,
    editingPathId, editPoints, editHandles, activePointIndex, freehand, zoom, dimensionDraft, scalePreview, rectangleAmountMm, arcDraft, offsetResult.shape, offsetSource, cornerResult.shape, activeRotation, rotationPreview, labelDraft, initialLabelEdit, editingTextId, tableRows, tableColumns, placementModifiers, polygonTool, polygonSides, navigatingViewportId, viewportCameraPreview, bezierDraft, tableResizePreview]);
  // Objects past the paper edge follow scrolling and workspace resizing.
  useEffect(() => {
    const workspace = workspaceRef.current, surround = surroundRef.current;
    if (!workspace || !surround) return;
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; paintSurround.current(); }); };
    workspace.addEventListener('scroll', schedule, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(surround);
    return () => { cancelAnimationFrame(frame); workspace.removeEventListener('scroll', schedule); observer?.disconnect(); };
  }, []);
  // Navigation ends when its view is deleted, undone away, or left on another page.
  useEffect(() => {
    if (navigatingViewportId !== null && !isViewport(entityOnPage(page, state, navigatingViewportId))) endViewportNavigationRef.current();
  }, [navigatingViewportId, page, state]);

  useLayoutEffect(() => {
    if (editingText?.text) { inlineTextRef.current?.focus(); if (inlineTextRef.current) setLayoutTextSelection(inlineTextRef.current, 0, editingText.text.content.length); setTextSelection({ start: 0, end: editingText.text.content.length }); }
  }, [editingTextId, page.id]);

  useEffect(() => {
    if (editingTextId === null) return;
    const keepToolbarFocus = (event: PointerEvent | MouseEvent): boolean => {
      if (!(event.target instanceof Element) || !isDocumentToolbarTarget(event.target)) return false;
      setTextSelection(getTextSelection());
      if (!toolbarNeedsInputFocus(event.target)) {
        event.preventDefault();
        returnToText();
      }
      return true;
    };
    const outside = (event: PointerEvent) => {
      if (keepToolbarFocus(event) || !(event.target instanceof Element) || event.target.closest('.pf-layout-inline-text')) return;
      setEditingTextId(null);
    };
    const mouseDown = (event: MouseEvent) => { keepToolbarFocus(event); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('mousedown', mouseDown, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('mousedown', mouseDown, true);
    };
  }, [editingTextId]);

  useEffect(() => {
    if (editingTextId === null) return;
    const pageId = page.id;
    const fitInitialLabel = initialLabelEditId.current === editingTextId;
    return () => {
      const current = tab.doc.state;
      const targetPage = current.pages.get(pageId);
      const entity = targetPage ? entityOnPage(targetPage, current, editingTextId) : null;
      if (!targetPage || !entity?.text || objectLocked(entity, current) ||
          !(entity.kind === 'label' && fitInitialLabel || entity.kind === 'text' && !entity.text.bounded)) return;
      const fit = () => {
        // Ignore a delayed load if this entity has since been edited or removed.
        const latest = tab.doc.state, latestPage = latest.pages.get(pageId);
        if (!latestPage || entityOnPage(latestPage, latest, entity.id) !== entity) return;
        textMeasureCanvas.current ??= document.createElement('canvas');
        const ctx = textMeasureCanvas.current.getContext('2d');
        if (!ctx) return;
        const bounds = fittedLayoutTextBounds(ctx, entity, latestPage, latest);
        if (fitInitialLabel && initialLabelEditId.current === entity.id) initialLabelEditId.current = null;
        if (bounds.every((point, index) => point.every((value, axis) => Math.abs(value - entity.points[index]![axis]!) < 1e-6))) return;
        tab.commands.execute('layout.text.setBounds', { pageId, entityId: entity.id, bounds, bounded: entity.kind === 'label' });
      };
      if (layoutFontRequests([entity]).length) void prepareLayoutFonts([entity]).then(fit, fit).catch(() => {});
      else fit();
    };
  }, [tab, page.id, editingTextId]);

  useLayoutEffect(() => {
    if (!tab.workspace.zoomToPageOnOpen) return;
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const fit = (): boolean => {
      if (!tab.workspace.zoomToPageOnOpen) return true;
      if (workspace.clientWidth <= 48 || workspace.clientHeight <= 48) return false;
      tab.workspace.zoomToPageOnOpen = false;
      const next = Math.min((workspace.clientWidth - 48) / (page.size[0] * PX_PER_MM),
        (workspace.clientHeight - 48) / (page.size[1] * PX_PER_MM));
      setZoom(Math.max(0.1, Math.min(8, next)));
      workspace.scrollLeft = 0; workspace.scrollTop = 0;
      return true;
    };
    if (fit()) return;
    const retry = () => { if (fit()) { observer?.disconnect(); window.removeEventListener('resize', retry); } };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(retry);
    observer?.observe(workspace);
    window.addEventListener('resize', retry);
    return () => { observer?.disconnect(); window.removeEventListener('resize', retry); };
  }, [tab, page]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (viewportWheel.current(event)) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const overPage = event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom;
      zoomAnchor.current = {
        x: event.clientX,
        y: event.clientY,
        pageX: overPage ? (event.clientX - rect.left) / rect.width : 0.5,
        pageY: overPage ? (event.clientY - rect.top) / rect.height : 0.5,
      };
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? workspace.clientHeight : 1);
      setZoom((value) => Math.max(0.1, Math.min(8, value * Math.exp(-delta * 0.0015))));
    };
    workspace.addEventListener('wheel', onWheel, { passive: false });
    return () => workspace.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    let pan: { pointerId: number; x: number; y: number; left: number; top: number } | null = null;
    const down = (event: PointerEvent) => {
      if (event.button !== 1 || (event.buttons & 1) !== 0 || navigatingViewportRef.current !== null) return;
      event.preventDefault(); event.stopPropagation();
      pan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: panOffset.current[0], top: panOffset.current[1] };
      workspace.classList.add('is-panning');
      workspace.setPointerCapture?.(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!pan || pan.pointerId !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      // Scroll positions clamp when the paper fits; a view offset can move in either direction.
      setPanOffset(pan.left + event.clientX - pan.x, pan.top + event.clientY - pan.y);
    };
    const end = (event: PointerEvent) => {
      if (!pan || pan.pointerId !== event.pointerId) return;
      event.stopPropagation();
      pan = null;
      workspace.classList.remove('is-panning');
      if (workspace.hasPointerCapture?.(event.pointerId)) workspace.releasePointerCapture(event.pointerId);
    };
    const auxClick = (event: MouseEvent) => { if (event.button === 1) event.preventDefault(); };
    workspace.addEventListener('pointerdown', down, true);
    workspace.addEventListener('pointermove', move, true);
    workspace.addEventListener('pointerup', end, true);
    workspace.addEventListener('pointercancel', end, true);
    workspace.addEventListener('lostpointercapture', end, true);
    workspace.addEventListener('auxclick', auxClick);
    return () => {
      workspace.classList.remove('is-panning');
      if (pan && workspace.hasPointerCapture?.(pan.pointerId)) workspace.releasePointerCapture(pan.pointerId);
      workspace.removeEventListener('pointerdown', down, true);
      workspace.removeEventListener('pointermove', move, true);
      workspace.removeEventListener('pointerup', end, true);
      workspace.removeEventListener('pointercancel', end, true);
      workspace.removeEventListener('lostpointercapture', end, true);
      workspace.removeEventListener('auxclick', auxClick);
    };
  }, []);

  useLayoutEffect(() => {
    const pending = zoomAnchor.current;
    const workspace = workspaceRef.current;
    const canvas = canvasRef.current;
    if (!pending || !workspace || !canvas) return;
    zoomAnchor.current = null;
    const rect = canvas.getBoundingClientRect();
    workspace.scrollLeft += rect.left + pending.pageX * rect.width - pending.x;
    workspace.scrollTop += rect.top + pending.pageY * rect.height - pending.y;
  }, [zoom]);

  useLayoutEffect(() => {
    const center = zoomCenter.current;
    const workspace = workspaceRef.current;
    const canvas = canvasRef.current;
    if (!center || !workspace || !canvas) return;
    zoomCenter.current = null;
    const pageRect = canvas.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    workspace.scrollLeft += pageRect.left + center[0] / page.size[0] * pageRect.width -
      (workspaceRect.left + workspace.clientWidth / 2);
    workspace.scrollTop += pageRect.top + center[1] / page.size[1] * pageRect.height -
      (workspaceRect.top + workspace.clientHeight / 2);
  }, [zoom, zoomRequest, page]);

  useEffect(() => {
    if (!zoomMenuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!zoomMenuRef.current?.contains(event.target as Node)) setZoomMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZoomMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [zoomMenuOpen]);

  useEffect(() => {
    // Copy and paste on an object browser item leave the canvas selection and the page alone.
    const nativeEditing = (event: ClipboardEvent): boolean => editingTextId !== null || presenting || printing || event.defaultPrevented ||
      event.target instanceof Element && Boolean(event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], .pf-layout-object-browser, .pf-workspace-files'));
    const copy = (event: ClipboardEvent) => {
      if (nativeEditing(event) || !selectionIds.length || !event.clipboardData) return;
      clipboardWrite.current = null;
      try {
        const entities = state.layerOrder.flatMap(layerId => entitiesForLayer(page, state, layerId))
          .filter(entity => selectionIds.includes(entity.id)).map(entity => layoutClipboardEntity(entity, state));
        if (!entities.length) return;
        const payload = createLayoutClipboardPayload(state, page, entities);
        setVcbError(null);
        writeLayoutClipboardEvent(event.clipboardData, payload);
        event.preventDefault();
        clipboardWrite.current = writeLayoutSystemClipboard(payload);
        if (clipboardWrite.current) void clipboardWrite.current.catch(error => {
          setVcbError(error instanceof Error ? error.message : 'Could not copy vectors to the system clipboard.');
        });
        else if (payload.svg) setVcbError('Copied for PushForm. This browser cannot copy SVG to other apps; use SVG Export or the desktop app.');
      } catch (error) {
        event.preventDefault();
        clipboardWrite.current = Promise.reject(error);
        void clipboardWrite.current.catch(() => {});
        setVcbError(error instanceof Error ? error.message : 'Could not copy this selection.');
      }
    };
    window.addEventListener('copy', copy);
    return () => window.removeEventListener('copy', copy);
  }, [tab, page, state, selectionIds, editingTextId, presenting, printing]);

  useEffect(() => {
    let active = true;
    let plain = false;
    const pasteKey = (event: KeyboardEvent) => { if (event.key.toLowerCase() === 'v') plain = (event.metaKey || event.ctrlKey) && event.shiftKey; };
    const releaseKey = () => { plain = false; };
    // Copy and paste on an object browser item leave the canvas selection and the page alone.
    const nativeEditing = (event: ClipboardEvent): boolean => editingTextId !== null || presenting || printing || event.defaultPrevented ||
      event.target instanceof Element && Boolean(event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], .pf-layout-object-browser, .pf-workspace-files'));
    const paste = (event: ClipboardEvent) => {
      if (nativeEditing(event) || !event.clipboardData) return;
      try {
        let content = readLayoutClipboard(event.clipboardData, plain);
        const system = plain || content && content.kind !== 'image' ? null : readLayoutSystemClipboard(); plain = false;
        // A Modeling copy pastes as a view of its model; this window's own copy only when nothing else is on the clipboard.
        const modelView = readModelClipboardView(event.clipboardData) ?? (content ? null : currentModelClipboardView());
        if (!content && !modelView && !system) return;
        event.preventDefault(); setVcbError(null);
        const accept = () => {
          if (!active) return;
          const layer = tab.doc.state.layers.get(tab.doc.state.activeLayerId);
          if (!layer || !isLayoutLayerVisible(tab.doc.state.pages.get(page.id)!, tab.doc.state, layer.id) || layer.locked)
            throw new Error('Choose a visible, unlocked layer before pasting.');
          if (modelView && content?.kind !== 'object' && content?.kind !== 'svg') {
            if (!cloudApi) throw new Error('Sign in to cloud files to paste a model view.');
            void pasteModelView(tab, cloudApi, page.id, modelView).then(entityId => {
              if (!active) return;
              setSelectionIds([entityId]); setTool('select');
            }, error => { if (active) setVcbError(error instanceof Error ? error.message : 'Could not paste the model view.'); });
            return;
          }
          if (!content) return;
          const insert = (entities: unknown[]) => {
            if (!active) return;
            try {
              const entityIds = tab.commands.execute('layout.clipboard.paste', { pageId: page.id, entities }) as number[];
              setSelectionIds(entityIds); setTool('select'); setEditingPathId(null); setEditPoints(null); setEditHandles(null);
              setActivePointIndex(null); setAnchor(null); setDimensionDraft(null); setAngularEdgeFirst(null);
              setArcDraft(null); setOffsetDraft(null); setCornerFirst(null); setRotationDraft(null); setLabelDraft(null);
              setCursor(null); setSnapKind(null); setFreehand([]);
            } catch { setVcbError('Could not paste this Layout object.'); }
          };
          if (content.kind === 'object') insert(content.entities);
          else if (content.kind === 'text') insert([layoutClipboardText(content.text, tab.doc.state.pages.get(page.id)!, tab.doc.state, content.rich)]);
          else if (content.kind === 'svg') void layoutClipboardSvg(content.source, tab.doc.state.pages.get(page.id)!).then(insert).catch(error => {
            if (active) setVcbError(error instanceof Error ? error.message : 'Could not paste this SVG.');
          });
          else if (content.kind === 'html') void layoutClipboardHtml(content.html, tab.doc.state.pages.get(page.id)!, tab.doc.state, content.images).then(insert).catch(error => {
            if (active) setVcbError(error instanceof Error ? error.message : 'Could not paste this content.');
          });
          else void layoutClipboardImage(content.source, tab.doc.state.pages.get(page.id)!).then(entity => insert([entity])).catch(error => {
            if (active) setVcbError(error instanceof Error ? error.message : 'Could not paste this image.');
          });
        };
        if (system) void system.then(values => {
          if (!active) return;
          const native = readLayoutClipboard({ getData: (type: string) => values[type] ?? '', files: [], items: [] } as unknown as DataTransfer);
          if (native) content = native;
          accept();
        }).catch(error => { if (active) setVcbError(error instanceof Error ? error.message : 'Could not read the system clipboard.'); });
        else accept();
      } catch (error) { event.preventDefault(); setVcbError(error instanceof Error ? error.message : 'Could not read the clipboard.'); }
    };
    window.addEventListener('paste', paste);
    window.addEventListener('keydown', pasteKey, true);
    window.addEventListener('keyup', releaseKey, true);
    return () => { active = false; window.removeEventListener('paste', paste); window.removeEventListener('keydown', pasteKey, true); window.removeEventListener('keyup', releaseKey, true); };
  }, [tab, page.id, editingTextId, presenting, printing, cloudApi]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // From the object browser only Print, undo and redo reach Layout shortcuts.
      if (target instanceof Element && target.closest('.pf-layout-object-browser') && !layoutBrowserPassesKey(event)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault(); setPrinting(true); return;
      }
      if (target instanceof Element && target.closest('.pf-layout-context-menu')) return;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (!presenting && !printing && shapeBuilder.keyDown(event)) return;
      const nudge: Point | undefined = ({ ArrowLeft: [-0.2, 0], ArrowRight: [0.2, 0], ArrowUp: [0, -0.2], ArrowDown: [0, 0.2] } as Record<string, Point>)[event.key];
      if (nudge && tool === 'select' && selectionIds.length && editingTextId === null && editingPathId === null &&
          !presenting && !printing && !event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey &&
          !moveStart.current && !scaleStart.current && !boxStart.current &&
          !(target instanceof Element && target.closest('[aria-label="Layout settings"], [role="dialog"], [role="menu"]'))) {
        event.preventDefault();
        const movable = selectionIds.filter(id => {
          const entity = entityOnPage(page, state, id);
          return entity && isLayoutLayerVisible(page, state, entity.layerId) && !objectLocked(entity, state);
        });
        if (movable.length) tab.commands.execute('layout.shape.move', { pageId: page.id, entityIds: movable, delta: nudge });
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && /^[zy]$/i.test(event.key)) {
        event.preventDefault();
        tab.commands.execute(event.shiftKey || event.key.toLowerCase() === 'y' ? 'edit.redo' : 'edit.undo');
        return;
      }
      if (booleanOperation(tool) && !presenting && !printing && !event.defaultPrevented &&
          !(target instanceof Element && target.closest('[role="dialog"], [role="menu"]')) && (event.key === 'Enter' || event.key === 'Escape')) {
        event.preventDefault();
        if (event.key === 'Enter') commitBoolean();
        else { setBooleanIds([]); setSelectionIds([]); setVcbError(null); setCursor(null); }
        return;
      }
      if (event.key === 'Escape' && navigatingViewportRef.current !== null) {
        event.preventDefault();
        endViewportNavigationRef.current();
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Escape') && tool === 'bezier' && bezierDraft) {
        event.preventDefault();
        finishBezier(bezierDraft, false);
        return;
      }
      if (event.key === 'Enter' && tool === 'lasso' && lasso && !lasso.freehand) {
        event.preventDefault();
        finishLasso(lasso.points, event);
        return;
      }
      if (event.key === 'Escape') {
        setReattachModel(null);
        setSnapKind(null); setCursor(null);
        scaleStart.current = null; setScalePreview(null);
        gripDrag.current = null; setGripRotation(null);
        moveStart.current = null; setMovePreview(null); setMoveDraft(null);
        boxStart.current = null; setBoxSelect(null);
        setLasso(null); lassoPress.current = null; lassoLast.current = null;
        setAnchor(null);
        setDimensionDraft(null); setAngularEdgeFirst(null); setDimensionError(null); setArcDraft(null); setArcError(null); setOffsetDraft(null); setCornerFirst(null); setCornerHover(null); setRotationDraft(null); setLabelDraft(null);
        pointerDown.current = null;
        setFreehand([]);
        setVcbError(null);
        pointEditStart.current = null;
        setEditPoints(null);
        setEditHandles(null);
        setEditingPathId(null);
        setActivePointIndex(null);
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (editingPathId !== null) {
          if (selectedEntity?.id === editingPathId && activePointIndex !== null && canTransform &&
              selectedEntity.points.length > 2) {
            const geometry = removeLayoutPathVertex(selectedEntity, activePointIndex);
            if (geometry) tab.commands.execute('layout.shape.setPath', {
              pageId: tab.activePageId, entityId: editingPathId, ...geometry,
            });
            setActivePointIndex(null);
          }
          event.preventDefault();
          return;
        }
        // Every selected object on an unlocked, visible layer erases in one undoable step.
        const erasable = selectionIds.filter((id) => {
          const layer = state.layers.get(entityOnPage(page, state, id)?.layerId ?? -1);
          return Boolean(layer && isLayoutLayerVisible(page, state, layer.id) && !layer.locked && !entityOnPage(page, state, id)?.locked);
        });
        if (erasable.length > 0) {
          tab.commands.execute('layout.shape.delete', { pageId: tab.activePageId, entityIds: erasable });
          setSelectionIds(selectionIds.filter((id) => !erasable.includes(id)));
          event.preventDefault();
        }
        return;
      }
      // Shift+= brings the selection forward and Shift+- sends it backward, like the Arrange menu.
      if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && (event.code === 'Equal' || event.code === 'Minus')) {
        const direction = event.code === 'Equal' ? 'forward' : 'backward';
        const editable = state.layerOrder.flatMap((layerId) => entitiesForLayer(page, state, layerId))
          .filter((entity) => selectionIds.includes(entity.id) && isLayoutLayerVisible(page, state, entity.layerId) && !objectLocked(entity, state));
        if (editable.length) {
          event.preventDefault();
          // Move the topmost first when going forward and the bottommost first when going backward, so the
          // selection keeps its relative stacking; one undo entry per key press, as the context menu.
          if (direction === 'forward') editable.reverse();
          try {
            tab.doc.undoStack.transact(direction === 'forward' ? 'Bring Forward' : 'Send Backward', () => {
              for (const entity of editable) tab.commands.execute('layout.shape.order', { pageId: page.id, entityId: entity.id, direction });
            });
          } catch (error) { setVcbError(error instanceof Error ? error.message : 'Could not reorder the selection.'); }
        }
        return;
      }
      const shortcut =
        event.shiftKey && event.code === 'KeyF' ? 'fillet' : event.shiftKey && event.code === 'KeyC' ? 'chamfer' :
        event.code === 'Space'
          ? event.shiftKey ? 'lasso' : 'select'
          : (
              { KeyX: 'shape-builder', KeyD: event.shiftKey ? 'angular-dimension' : 'dimension', KeyT: 'text', KeyM: 'move', KeyQ: 'rotate', KeyA: 'arc2', KeyL: 'line', KeyR: 'rectangle', KeyC: 'circle', KeyE: 'eraser' } as Record<
                string,
                LayoutTool
              >
            )[event.code];
      if (shortcut && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (shortcut === 'shape-builder') { event.preventDefault(); chooseTool('shape-builder'); return; }
        setDimensionDraft(null); setAngularEdgeFirst(null); setDimensionError(null); setArcDraft(null); setArcError(null); setOffsetDraft(null); setCornerFirst(null); setCornerHover(null); setRotationDraft(null); setLabelDraft(null);
        setTool(shortcut as LayoutTool);
        setAnchor(null);
        setVcbError(null);
        if (shortcut !== 'select') {
          setEditingPathId(null);
          setEditPoints(null);
          setEditHandles(null);
          setActivePointIndex(null);
        }
        if (target instanceof HTMLElement && target.closest('[aria-label="Layout tools"]')) target.blur();
        event.preventDefault();
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && (/^[0-9.]$/.test(event.key) || (tool === 'offset' || tool === 'rotate') && event.key === '-' || tool === 'move' && /^[-*/]$/.test(event.key))) {
        const input = document.getElementById('pf-layout-vcb') as HTMLInputElement | null;
        if (input) {
          input.focus();
          setVcb(event.key);
          event.preventDefault();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tab, selectionIds, selectedEntity, editingPathId, editingTextId, activePointIndex, canTransform, tool, page, state, presenting, printing, moveDraft, lasso, bezierDraft, booleanIds, shapeBuilder]);

  useEffect(() => {
    updatePolygonAlt(false);
    if (!isPolygonTool(tool) || presenting || printing) return;
    const validTarget = (event: KeyboardEvent) => {
      const target = event.target;
      return !(target instanceof Element && (target.closest('[role="menu"], [role="dialog"]') ||
        target.closest('input, textarea, select, [contenteditable="true"]') && target.id !== 'pf-layout-vcb'));
    };
    const down = (event: KeyboardEvent) => {
      if (event.key !== 'Alt' || !validTarget(event) || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      updatePolygonAlt(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key !== 'Alt') return;
      if (polygonAltRef.current) event.preventDefault();
      updatePolygonAlt(false);
    };
    const cancel = () => updatePolygonAlt(false);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', cancel);
    };
  }, [tool, presenting, printing, updatePolygonAlt]);

  // Pressing or releasing Ctrl (Cmd) during a Select drag updates the copy preview at once.
  useEffect(() => {
    const onModifier = (event: KeyboardEvent) => {
      if ((event.key !== 'Control' && event.key !== 'Meta') || !moveStart.current) return;
      const copy = event.ctrlKey || event.metaKey;
      setMovePreview((preview) => preview && preview.copy !== copy ? { ...preview, copy } : preview);
    };
    window.addEventListener('keydown', onModifier);
    window.addEventListener('keyup', onModifier);
    return () => { window.removeEventListener('keydown', onModifier); window.removeEventListener('keyup', onModifier); };
  }, []);

  // A tap of Ctrl or Alt (Option) toggles copying, also while Measurements has focus. A chord such as Ctrl+Z
  // or Ctrl+wheel zoom is not a tap: any other key, wheel or pointer press while the modifier is down cancels it.
  const copyTap = useRef<string | null>(null);
  useEffect(() => {
    if (tool !== 'move' || !moveDraft) { copyTap.current = null; return; }
    const tapTarget = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      return !(target instanceof Element && (target.closest('.pf-layout-context-menu, .pf-layout-object-browser') ||
        (target.closest('input, textarea, select, [contenteditable="true"]') && target.id !== 'pf-layout-vcb')));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Control' && event.key !== 'Alt') { copyTap.current = null; return; }
      if (!tapTarget(event)) return;
      event.preventDefault(); // Alt must not move focus to the browser menu.
      if (!event.repeat) copyTap.current = event.key;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Control' && event.key !== 'Alt') return;
      const tapped = copyTap.current === event.key;
      copyTap.current = null;
      if (!tapped || !tapTarget(event)) return;
      event.preventDefault();
      const copy = !moveDraft.copy;
      setMoveDraft({ ...moveDraft, copy });
      setMovePreview((preview) => preview && { ...preview, copy });
    };
    const cancel = () => { copyTap.current = null; };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('wheel', cancel, true);
    window.addEventListener('pointerdown', cancel, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('wheel', cancel, true);
      window.removeEventListener('pointerdown', cancel, true);
    };
  }, [tool, moveDraft]);

  useEffect(() => {
    setAnchor(null);
    setBooleanIds([]);
    setSelectionIds(pendingPageSelection.current ?? []); pendingPageSelection.current = null;
    setTableCellsActive(false); setTableEditRequest(0); tableDrag.current = null; setTableResizePreview(null);
    scaleStart.current = null; setScalePreview(null);
    setMovePreview(null);
    moveStart.current = null;
    setMoveDraft(null); lastMoveCopy.current = null;
    pointEditStart.current = null;
    setEditingPathId(null);
    setEditingTextId(null);
    setEditPoints(null);
    setEditHandles(null);
    setActivePointIndex(null);
    setFreehand([]);
    setVcbError(null);
    setDimensionDraft(null); setAngularEdgeFirst(null); setDimensionError(null); setArcDraft(null); setArcError(null); setOffsetDraft(null); setCornerFirst(null); setCornerHover(null); setRotationDraft(null); setLabelDraft(null);
  }, [tab.activePageId]);

  const rawPointFromEvent = (event: {
    currentTarget: HTMLCanvasElement; clientX: number; clientY: number;
  }): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [
      ((event.clientX - bounds.left) * page.size[0]) / bounds.width,
      ((event.clientY - bounds.top) * page.size[1]) / bounds.height,
    ];
  };
  const pointFromEvent = (event: { currentTarget: HTMLCanvasElement; clientX: number; clientY: number; shiftKey: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): Point => {
    if (isPolygonTool(tool)) updatePolygonAlt(!!event.altKey);
    if (usesPlacementModifiers(tool) || tool === 'text') updatePlacementModifiers({ center: !!(event.ctrlKey || event.metaKey), square: tool !== 'text' && event.shiftKey });
    const bounds = event.currentTarget.getBoundingClientRect();
    const raw = rawPointFromEvent(event);
    modelSnap.current = null;
    modelSnapUnavailable.current = false;
    if (reattachModel || tool === 'dimension' && (dimensionDraft?.points.length ?? 0) < 2 || tool === 'label' && !labelDraft) {
      const model = snapLayoutModelVertex(raw, page, tab.doc.state, 8 * page.size[0] / bounds.width);
      if (model && 'attachment' in model) { modelSnap.current = model.attachment; setSnapKind('endpoint'); setSnapType('endpoint'); return model.point; }
      if (model && 'unavailable' in model) modelSnapUnavailable.current = true;
    }
    // Freehand always follows the pointer, including its start and release.
    if (tool === 'freehand') { setSnapKind(null); setSnapType(null); return raw; }
    const snap = snapPaperPoint(raw, page, tab.doc.state, 8 * page.size[0] / bounds.width,
      tool === 'offset' && offsetDraft ? new Set([offsetDraft.entityId])
        // A move's destination snaps only to objects that stay put.
        : tool === 'move' && moveDraft && !moveDraft.copy ? movingWithFollowers(moveDraft.entityIds, page, tab.doc.state) : undefined,
      tool === 'offset' && offsetSource ? point => {
        try { return Math.abs(layoutOffsetDistance(offsetSource, point)) >= 1e-6; } catch { return true; }
      } : undefined);
    setSnapKind(snap.kind); setSnapType(snap.type ?? snap.kind);
    if (usesPlacementModifiers(tool) && anchor && event.shiftKey) {
      const [, endpoint] = placementCorners(anchor, snap.point, placementModifiersRef.current);
      if (endpoint[0] !== snap.point[0] || endpoint[1] !== snap.point[1]) setSnapKind(null);
    }
    // A polygon's reference point turns to the nearest 90° from its center; object snaps take precedence.
    if (isPolygonTool(tool) && anchor && (snap.kind === null || snap.kind === 'grid')) {
      const square = snapLayoutPolygonReference(anchor, raw, 8 * page.size[0] / bounds.width);
      if (square) { setSnapKind(null); return square; }
    }
    if (tool === 'line') {
      linePointer.current = { clientX: event.clientX, clientY: event.clientY };
      setLineGuide(null);
      if (anchor && event.shiftKey) {
        const point: Point = Math.abs(snap.point[0] - anchor[0]) >= Math.abs(snap.point[1] - anchor[1])
          ? [snap.point[0], anchor[1]] : [anchor[0], snap.point[1]];
        if (point[0] !== snap.point[0] || point[1] !== snap.point[1]) setSnapKind(null);
        return point;
      }
      // Touching a vertex or midpoint makes it the reference; lining up with it locks the point and shows a guide.
      if (snap.kind === 'endpoint' || snap.kind === 'midpoint' && snap.type !== 'center') lineReference.current = snap.point;
      else if ((snap.kind === null || snap.kind === 'grid') && lineReference.current) {
        const reference = lineReference.current;
        const aligned = alignToPaperReference(raw, reference, 8 * page.size[0] / bounds.width);
        if (aligned) {
          const point: Point = aligned.axis === 'horizontal' ? [snap.point[0], reference[1]] : [reference[0], snap.point[1]];
          setSnapKind(null); setLineGuide({ reference, axis: aligned.axis });
          return point;
        }
      }
    }
    return snap.point;
  };
  useEffect(() => {
    if (tool !== 'line' || !anchor) { linePointer.current = null; return; }
    const onShift = (event: KeyboardEvent) => {
      const canvas = canvasRef.current;
      if (event.key !== 'Shift' || !canvas || !linePointer.current) return;
      setCursor(pointFromEvent({ currentTarget: canvas, ...linePointer.current, shiftKey: event.type === 'keydown' }));
    };
    window.addEventListener('keydown', onShift);
    window.addEventListener('keyup', onShift);
    return () => { window.removeEventListener('keydown', onShift); window.removeEventListener('keyup', onShift); };
  }, [tool, anchor, page, state]);
  /** The Rotate tool's angle to the pointer at `p`, held at 90° detents within the snap tolerance. */
  const pointerRotation = (draft: RotationDraft, reference: Point, p: Point, event: { currentTarget: HTMLCanvasElement }): number =>
    snapLayoutRotationAngle(layoutRotationAngle(draft.pivot, reference, p, draft.angleDeg),
      Math.hypot(p[0] - draft.pivot[0], p[1] - draft.pivot[1]), 8 * page.size[0] / event.currentTarget.getBoundingClientRect().width);
  const commitRotation = (angleDeg: number): void => {
    if (!rotationDraft?.reference) return;
    try {
      if (Math.abs(angleDeg % 360) > 1e-10) tab.commands.execute('layout.shape.rotate', {
        pageId: page.id, entityId: rotationDraft.entityId, pivot: rotationDraft.pivot, angleDeg,
      });
      setRotationDraft(null); setCursor(null); setSnapKind(null); setVcb(''); setVcbError(null);
    } catch (error) { setVcbError(error instanceof Error ? error.message : 'Cannot rotate this object.'); }
  };
  /** The page point under a pointer event on a grip (the grips sit over the page canvas). */
  const gripPoint = (event: { clientX: number; clientY: number }): Point => rawPointFromEvent({ currentTarget: canvasRef.current!, clientX: event.clientX, clientY: event.clientY });
  /** Screen pixels per page millimeter, as the canvas is shown. */
  const screenPxPerMm = (): number => canvasRef.current!.getBoundingClientRect().width / page.size[0];
  const gripFraction = (entity: LayoutEntity) => gripCenter && gripCenter.entityId === entity.id ? gripCenter : { u: 0.5, v: 0.5 };
  // The center moves within the box and snaps back to its middle within 8 screen pixels.
  const moveGripCenter = (entity: LayoutEntity, box: Box, p: Point): void => {
    const angle = boxAngle(entity), middle = boxPoint(box, angle, 0.5, 0.5);
    const snap = Math.hypot(p[0] - middle[0], p[1] - middle[1]) <= 8 / screenPxPerMm();
    setGripCenter({ entityId: entity.id, ...(snap ? { u: 0.5, v: 0.5 } : boxFraction(box, angle, p)) });
  };
  // The handle starts where the arm ends; the angle follows the pointer about the center.
  const startGripRotation = (entity: LayoutEntity, box: Box): void => {
    const { u, v } = gripFraction(entity), angle = boxAngle(entity), pivot = boxPoint(box, angle, u, v);
    const arm = rotateLayoutPoint([ROTATION_ARM_PX / (PX_PER_MM * zoom), 0], [0, 0], angle);
    const reference: Point = [pivot[0] + arm[0], pivot[1] + arm[1]];
    setGripRotation({ entityId: entity.id, pivot, reference, angleDeg: 0 }); setCursor(reference);
  };
  const updateGripRotation = (p: Point): void => {
    if (!gripRotation?.reference || Math.hypot(p[0] - gripRotation.pivot[0], p[1] - gripRotation.pivot[1]) < 1e-6) return;
    setGripRotation({ ...gripRotation, angleDeg: pointerRotation(gripRotation, gripRotation.reference, p, { currentTarget: canvasRef.current! }) });
    setCursor(p);
  };
  const finishGripRotation = (): void => {
    const draft = gripRotation;
    setGripRotation(null); setCursor(null);
    if (!draft || Math.abs(draft.angleDeg % 360) <= 1e-10) return;
    tab.commands.execute('layout.shape.rotate', { pageId: page.id, entityId: draft.entityId, pivot: draft.pivot, angleDeg: draft.angleDeg });
    // The center stays where it was on the page, within the rotated object's new box.
    const rotated = entityOnPage(page, tab.doc.state, draft.entityId);
    if (rotated) setGripCenter({ entityId: rotated.id, ...boxFraction(selectionBox(rotated), boxAngle(rotated), draft.pivot) });
  };
  /** Offset from the base point to `target`, kept horizontal or vertical when constrained. */
  const moveDelta = (draft: MoveDraft, target: Point, constrain: boolean): Point => {
    const delta: Point = [target[0] - draft.base[0], target[1] - draft.base[1]];
    return constrain ? Math.abs(delta[0]) >= Math.abs(delta[1]) ? [delta[0], 0] : [0, delta[1]] : delta;
  };
  const endMove = (): void => {
    setMoveDraft(null); setMovePreview(null); setCursor(null); setSnapKind(null); setVcb(''); setVcbError(null);
  };
  const commitMove = (delta: Point): void => {
    if (!moveDraft) return;
    // A zero offset changes nothing and records no undo step.
    if (Math.hypot(delta[0], delta[1]) <= LENGTH_TOL) { endMove(); return; }
    try {
      const ids = tab.commands.execute('layout.shape.move', {
        pageId: page.id, entityIds: moveDraft.entityIds, delta, copy: moveDraft.copy, whole: true,
      }) as number[];
      // A move keeps the whole selection, including locked members that stayed put; a copy selects the copies.
      if (moveDraft.copy) {
        setSelectionIds(ids);
        lastMoveCopy.current = { pageId: page.id, entityIds: moveDraft.entityIds, delta, entry: tab.doc.undoStack.peek() };
      }
      endMove();
    } catch (error) { setVcbError(error instanceof Error ? error.message : 'Cannot move these objects.'); }
  };
  /** Replace the latest copy by an array, undoing it first so one Undo removes the whole array. */
  const arrayMoveCopy = (count: number, mode: 'external' | 'internal'): void => {
    const last = lastMoveCopy.current;
    if (!last || last.pageId !== page.id || tab.doc.undoStack.peek() !== last.entry) {
      setVcbError('Copy objects with Move, then enter Nx or /N to make an array.'); return;
    }
    const delta: Point = mode === 'internal' ? [last.delta[0] / count, last.delta[1] / count] : last.delta;
    tab.commands.execute('edit.undo');
    try {
      const ids = tab.commands.execute('layout.shape.move', {
        pageId: page.id, entityIds: last.entityIds, delta, copy: true, whole: true, count,
      }) as number[];
      last.entry = tab.doc.undoStack.peek();
      setSelectionIds(ids); setVcb(''); setVcbError(null);
    } catch (error) {
      tab.commands.execute('edit.redo');
      setVcbError(error instanceof Error ? error.message : 'Cannot make this array.');
    }
  };
  const commitOffset = (distanceMm: number): void => {
    if (!offsetDraft) return;
    try {
      const id = tab.commands.execute('layout.path.offset', { pageId: page.id, entityId: offsetDraft.entityId, distanceMm }) as number;
      setSelectionId(id); setOffsetDraft(null); setCornerFirst(null); setCornerHover(null); setRotationDraft(null); setLabelDraft(null); setCursor(null); setVcb(''); setVcbError(null);
    } catch (error) { setVcbError(error instanceof Error ? error.message : 'Cannot offset this path.'); }
  };
  const previewViewportCamera = (camera: LayoutViewportCamera | null): void => {
    viewportPreviewRef.current = camera;
    setViewportCameraPreview(camera);
  };
  const commitViewportCamera = (entityId: number, camera: LayoutViewportCamera): void => {
    try {
      tab.commands.execute('layout.viewport.setCamera', { pageId: page.id, entityId, camera, scene: null });
    } catch (error) { setVcbError(error instanceof Error ? error.message : 'Cannot change this view.'); }
  };
  /** Leaves navigation; a zoom still waiting to commit is kept, a drag in progress is cancelled. */
  const endViewportNavigation = (): void => {
    if (viewportZoomCommit.current) { clearTimeout(viewportZoomCommit.current); viewportZoomCommit.current = null; }
    const id = navigatingViewportRef.current, pending = viewportPreviewRef.current;
    if (id !== null && pending && !viewportDrag.current) commitViewportCamera(id, pending);
    viewportDrag.current = null;
    previewViewportCamera(null);
    setNavigatingViewportId(null);
  };
  const endViewportNavigationRef = useRef(endViewportNavigation);
  endViewportNavigationRef.current = endViewportNavigation;
  viewportWheel.current = (event) => {
    const canvas = canvasRef.current;
    const entity = navigatingViewportId === null ? undefined : entityOnPage(page, tab.doc.state, navigatingViewportId);
    if (!canvas || !isViewport(entity) || viewportDrag.current) return false;
    if (!pointInsideLayoutPath(rawPointFromEvent({ currentTarget: canvas, clientX: event.clientX, clientY: event.clientY }), entity.points)) return false;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
    const camera = zoomViewportCamera(viewportPreviewRef.current ?? entity.image.viewport.camera, entity.points, Math.exp(delta * 0.0015));
    previewViewportCamera(camera);
    // Scrolling is one undoable step once it pauses.
    if (viewportZoomCommit.current) clearTimeout(viewportZoomCommit.current);
    viewportZoomCommit.current = setTimeout(() => {
      viewportZoomCommit.current = null;
      if (viewportDrag.current) return;
      const pending = viewportPreviewRef.current;
      previewViewportCamera(null);
      if (pending) commitViewportCamera(entity.id, pending);
    }, 400);
    return true;
  };
  /** A new view of an embedded model, starting from its first scene or an iso view. */
  const placeViewport = async (a: Point, b: Point): Promise<void> => {
    const source = viewportSource;
    if (!source) return;
    const left = Math.min(a[0], b[0]), top = Math.min(a[1], b[1]), right = Math.max(a[0], b[0]), bottom = Math.max(a[1], b[1]);
    const pageId = page.id;
    try {
      const model = await layoutViewportModel(tab.doc.state, source.source);
      const { camera, scene } = initialViewportCamera(model.scenes, [[left, top], [right, top], [right, bottom], [left, bottom]], model.bounds);
      const id = tab.commands.execute('layout.viewport.add', { pageId, first: [left, top], second: [right, bottom], source: source.source, camera, scene }) as number;
      setSelectionId(id);
      setTool('select');
    } catch (error) { setVcbError(error instanceof Error ? error.message : 'The model view could not be added.'); }
  };
  /** End the Bézier tool's path as one undoable shape; too few anchors draw nothing. */
  const finishBezier = (draft: LayoutBezierDraft, closed: boolean): void => {
    setBezierDraft(null); bezierPress.current = null; setCursor(null); setSnapKind(null);
    const shape = finishLayoutBezier(draft, closed);
    if (!shape) return;
    try { tab.commands.execute('layout.shape.add', { pageId: page.id, ...shape }); setVcbError(null); }
    catch (error) { setVcbError(error instanceof Error ? error.message : 'Cannot draw on this layer.'); }
  };
  const commit = (a: Point, b: Point, override?: LayoutRectanglePath, textBounded?: boolean, modifiers = placementModifiersRef.current): void => {
    if (tool === 'viewport') {
      setAnchor(null); setCursor(null); setVcb('');
      if (Math.abs(a[0] - b[0]) >= 1 && Math.abs(a[1] - b[1]) >= 1) void placeViewport(a, b);
      return;
    }
    if (tool === 'table') {
      if (Math.abs(a[0] - b[0]) < LENGTH_TOL * 1000 || Math.abs(a[1] - b[1]) < LENGTH_TOL * 1000) return;
      const id = tab.commands.execute('layout.table.add', { pageId: page.id, first: a, second: b, rows: tableRows, columns: tableColumns }) as number;
      setSelectionId(id); setTableCell({ row: 0, column: 0 }); setTool('select'); setAnchor(null); setCursor(null); setVcb(''); return;
    }
    if (tool === 'text') {
      const bounded = textBounded ?? Math.hypot(b[0] - a[0], b[1] - a[1]) > 2;
      const align = bounded && modifiers.center ? 'center' : bounded && b[0] < a[0] ? 'right' : 'left';
      if (bounded) [a, b] = placementCorners(a, b, { ...modifiers, square: false });
      const points: Point[] = bounded
        ? [[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]) + (a[0] === b[0] ? 0.1 : 0), Math.max(a[1], b[1]) + (a[1] === b[1] ? 0.1 : 0)]]
        : [a, [a[0] + 60, a[1] + 20]];
      const entityId = tab.commands.execute('layout.text.add', {
        pageId: page.id, kind: tool, points,
        text: { content: '', ...LAYOUT_DEFAULT_TEXT, bold: false, italic: false, underline: false, align,
          vertical: bounded && modifiers.center ? 'middle' : 'top', bounded, leader: 'elbow', endpoint: 'arrow' },
      }) as number;
      setSelectionId(entityId); setEditingTextId(entityId); setTool('select'); setAnchor(null); setCursor(null);
      setEditingPathId(null); setEditPoints(null); setActivePointIndex(null); pointEditStart.current = null;
      setEditHandles(null);
      return;
    }
    const first = a;
    if (isLayoutRectangleTool(tool)) [a, b] = placementCorners(a, b, modifiers);
    const drawingTool = polygonAltRef.current && isPolygonTool(tool) ? tool === 'polygon' ? 'circumscribed-polygon' : 'polygon' : tool;
    const shape = override ?? pathPoints(drawingTool, a, b, rectangleAmountMm, tool === 'ellipse' ? modifiers : NO_PLACEMENT_MODIFIERS, polygonSides);
    if ((isLayoutRectangleTool(tool) || tool === 'circle' || tool === 'ellipse' || isPolygonTool(tool)) && !shape.closed) return;
    if (shape.points.length < 2 || (!override && Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01))
      return;
    const entityId = tool === 'line'
      ? tab.commands.execute('layout.path.addLine', { pageId: page.id, start: a, end: b }) as number
      : isLayoutRectangleTool(tool)
        ? tab.commands.execute('layout.rectangle.add', { pageId: page.id, kind: tool, first: a, second: b, amountMm: rectangleAmountMm }) as number
        : tab.commands.execute('layout.shape.add', { pageId: page.id, ...shape }) as number;
    if (isRepeatableShapeTool(tool)) shapeRepeats.current.set(tool, isLayoutRectangleTool(tool)
      ? { anchor: first, rectangle: { kind: tool, first: a, second: b, amountMm: rectangleAmountMm } }
      : { anchor: first, shape: { points: shape.points, ...(shape.handles ? { handles: shape.handles } : {}), closed: shape.closed } });
    const closed = entityOnPage(tab.doc.state.pages.get(page.id)!, tab.doc.state, entityId)?.closed ?? false;
    setAnchor(tool === 'line' && !closed ? b : null);
    setCursor(tool === 'line' && !closed ? b : null);
    setFreehand([]);
    setVcb('');
    setVcbError(null);
  };
  /**
   * Close the Lasso outline and select with the modifiers held as it closes, as a click with
   * Select would: none replaces, Ctrl (Cmd) adds, Shift toggles and Ctrl+Shift (Cmd+Shift) removes.
   */
  const finishLasso = (points: readonly Point[], modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): void => {
    setLasso(null); lassoPress.current = null; lassoLast.current = null;
    if (points.length < 3) return;
    const covered = expandLayoutGroups(entitiesInLasso(points, page, tab.doc.state).map((entity) => entity.id), page, tab.doc.state);
    const primary = modifiers.metaKey || modifiers.ctrlKey;
    if (primary && modifiers.shiftKey) setSelectionIds(selectionIds.filter((id) => !covered.includes(id)));
    else if (primary) setSelectionIds([...selectionIds, ...covered.filter((id) => !selectionIds.includes(id))]);
    else if (modifiers.shiftKey) setSelectionIds([...selectionIds.filter((id) => !covered.includes(id)), ...covered.filter((id) => !selectionIds.includes(id))]);
    else setSelectionIds(covered);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (tool === 'shape-builder' && event.button === 0) {
      shapeBuilder.down(rawPointFromEvent(event), event.shiftKey);
      event.currentTarget.setPointerCapture?.(event.pointerId); event.preventDefault(); return;
    }
    setSnapHoverEpoch(value => value + 1);
    if (tool === 'lasso' && event.button === 0 && navigatingViewportId === null) {
      // A press starts a freehand outline once it drags, or places the next point of a clicked one.
      lassoPress.current = { point: rawPointFromEvent(event), x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (navigatingViewportId !== null) {
      // Drag inside the view orbits (Shift or the middle button pans); a click elsewhere ends navigation.
      const entity = entityOnPage(page, tab.doc.state, navigatingViewportId);
      const raw = rawPointFromEvent(event);
      if (isViewport(entity) && (event.button === 0 || event.button === 1) && pointInsideLayoutPath(raw, entity.points)) {
        event.preventDefault();
        if (viewportZoomCommit.current) { clearTimeout(viewportZoomCommit.current); viewportZoomCommit.current = null; }
        viewportDrag.current = { start: raw, camera: viewportPreviewRef.current ?? entity.image.viewport.camera, pan: event.button === 1 || event.shiftKey };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        return;
      }
      endViewportNavigation();
    }
    if (event.button !== 0) return;
    if (editingPathId !== null && tool === 'select') {
      const entity = entityOnPage(page, tab.doc.state, editingPathId);
      if (!entity || entity.kind !== 'path' || !isLayoutLayerVisible(page, tab.doc.state, entity.layerId)) return;
      const raw = rawPointFromEvent(event);
      const tolerance = 8 * page.size[0] / event.currentTarget.getBoundingClientRect().width;
      let nearest = -1, side: 'anchor' | 'in' | 'out' = 'anchor', distance = tolerance;
      for (const [index, handles] of (entity.handles ?? []).entries()) {
        for (const candidateSide of ['in', 'out'] as const) {
          const handle = handles[candidateSide];
          if (!handle) continue;
          const candidate = Math.hypot(raw[0] - handle[0], raw[1] - handle[1]);
          if (candidate <= distance) { nearest = index; side = candidateSide; distance = candidate; }
        }
      }
      for (const [index, point] of entity.points.entries()) {
        const candidate = Math.hypot(raw[0] - point[0], raw[1] - point[1]);
        if (candidate <= distance) { nearest = index; side = 'anchor'; distance = candidate; }
      }
      if (nearest >= 0 && !objectLocked(entity, tab.doc.state)) {
        setActivePointIndex(nearest);
        pointEditStart.current = {
          index: nearest, side, points: entity.points.map(([x, y]) => [x, y]),
          handles: copyHandles(entity.handles, entity.points.length),
          x: event.clientX, y: event.clientY,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setSnapKind(null);
        return;
      }
      setActivePointIndex(null); setSnapKind(null);
      if (pickEntity(raw, page, tab.doc.state)?.id === editingPathId) return;
      setEditingPathId(null); setEditPoints(null); setEditHandles(null);
    }
    if (reattachModel && (tool === 'dimension' || tool === 'label')) {
      event.preventDefault();
      pointFromEvent(event);
      if (modelSnapUnavailable.current) { setVcbError('Model geometry is unavailable. Wait for the model to load before connecting.'); return; }
      const attachment = modelSnap.current;
      if (!attachment) { setVcbError('Click a model vertex to reconnect the annotation.'); return; }
      const attachments = [...reattachModel.attachments, attachment];
      if (attachments[0]!.viewportId !== attachment.viewportId) { setVcbError('Choose both points in the same model view.'); return; }
      if (tool === 'dimension' && attachments.length < 2) { setReattachModel({ ...reattachModel, attachments }); return; }
      try {
        tab.commands.execute('layout.annotation.attachModel', { pageId: page.id, entityId: reattachModel.id, attachments });
        setReattachModel(null); setDimensionDraft(null); setLabelDraft(null); setVcbError(null); setTool('select');
      } catch (error) { setVcbError(error instanceof Error ? error.message : 'Cannot reconnect this annotation.'); }
      return;
    }
    if (tool === 'label') {
      event.preventDefault();
      const snapped = pointFromEvent(event);
      if (modelSnapUnavailable.current) { setVcbError('Model geometry is unavailable. Wait for the model to load before connecting.'); return; }
      const p: Point = labelDraft?.bend ? [snapped[0], labelDraft.bend[1]] : snapped;
      if (p[1] !== snapped[1]) setSnapKind(null);
      setCursor(p); setVcbError(null);
      if (!labelDraft) setLabelDraft({ tip: p, bend: null, attachment: modelSnap.current ? null : labelAnchorAt(p, page, tab.doc.state),
        ...(modelSnap.current ? { modelAttachment: modelSnap.current } : {}) });
      else if (!labelDraft.bend) {
        if (Math.hypot(p[0] - labelDraft.tip[0], p[1] - labelDraft.tip[1]) < 1e-6) { setVcbError('Place the bend away from the arrow tip.'); return; }
        setLabelDraft({ ...labelDraft, bend: p });
      } else {
        try {
          const geometry = createLayoutLabelGeometry(labelDraft.tip, labelDraft.bend, p);
          const id = tab.commands.execute('layout.text.add', { pageId: page.id, kind: 'label', points: geometry.points, labelAnchor: labelDraft.attachment,
            ...(labelDraft.modelAttachment ? { modelAttachments: [labelDraft.modelAttachment] } : {}),
            text: { content: '', ...LAYOUT_DEFAULT_TEXT, bold: false, italic: false, underline: false,
              align: geometry.align, vertical: geometry.vertical, bounded: true, leader: 'elbow', endpoint: 'arrow' } }) as number;
          initialLabelEditId.current = id;
          setSelectionId(id); setEditingTextId(id); setLabelDraft(null); setTool('select'); setCursor(null); setSnapKind(null);
        } catch (error) { setVcbError(error instanceof Error ? error.message : 'Cannot create this label.'); }
      }
      return;
    }
    if (booleanOperation(tool)) {
      const entity = pickEntity(rawPointFromEvent(event), page, state, true, booleanIds);
      if (!entity || booleanIds.includes(entity.id)) return;
      const first = booleanIds.length ? entityOnPage(page, state, booleanIds[0]!) : null;
      if (entity.hidden || objectLocked(entity, state) || entity.groupId !== undefined || first && first.layerId !== entity.layerId) {
        setVcbError('Choose visible, unlocked, ungrouped paths on the same layer.'); return;
      }
      try { validateLayoutPathOperand(entity, booleanOperation(tool)!, booleanIds.length === 0); }
      catch (error) { setVcbError(error instanceof Error ? error.message : 'Choose a closed path.'); return; }
      const next = [...booleanIds, entity.id];
      setBooleanIds(next); setSelectionIds(next); setCursor(null); setSnapKind(null); setVcbError(null);
      return;
    }
    if (tool === 'scale') {
      const entity = pickEntity(rawPointFromEvent(event), page, state, true);
      setSelectionId(entity && !objectLocked(entity, state) ? entity.id : null);
      setCursor(null); setSnapKind(null); setVcbError(null);
      return;
    }
    if (tool === 'move') {
      const raw = rawPointFromEvent(event), p = pointFromEvent(event); setVcbError(null);
      if (moveDraft) { commitMove(moveDelta(moveDraft, p, event.shiftKey)); return; }
      // An unselected object (with its group) replaces the selection; otherwise the selection moves.
      const entity = pickEntity(raw, page, state, true) ?? pickEntity(p, page, state, true);
      const chosen = entity && !selectionIds.includes(entity.id) ? expandLayoutGroups([entity.id], page, state) : selectionIds;
      const entityIds = chosen.filter((id) => {
        const member = entityOnPage(page, state, id);
        return member && isLayoutLayerVisible(page, state, member.layerId) && !objectLocked(member, state);
      });
      if (!entityIds.length) {
        if (chosen.length) setVcbError('Locked or hidden objects cannot be moved.');
        return;
      }
      lastMoveCopy.current = null;
      if (chosen !== selectionIds) setSelectionIds(chosen);
      setMoveDraft({ entityIds, base: p, copy: false }); setCursor(p);
      return;
    }
    if (tool === 'rotate') {
      const p = pointFromEvent(event); setCursor(p); setVcbError(null);
      if (!rotationDraft) {
        const entity = pickEntity(p, page, state, true);
        if (!entity || (entity.kind !== 'path' && !entity.text && !entity.image && !entity.table)) { setVcbError('Click within a shape, image, or text box, or on a line to choose the rotation point.'); return; }
        if (objectLocked(entity, state)) { setVcbError('Source layer is locked.'); return; }
        const pivot = p;
        setSelectionId(entity.id); setRotationDraft({ entityId: entity.id, pivot, reference: null, angleDeg: 0 }); setCursor(pivot);
      } else {
        setCursor(p);
        if (Math.hypot(p[0] - rotationDraft.pivot[0], p[1] - rotationDraft.pivot[1]) < 1e-6) { setVcbError('Choose a direction away from the rotation point.'); return; }
        if (!rotationDraft.reference) setRotationDraft({ ...rotationDraft, reference: p, angleDeg: 0 });
        else {
          try { commitRotation(pointerRotation(rotationDraft, rotationDraft.reference, p, event)); }
          catch (error) { setVcbError(error instanceof Error ? error.message : 'Cannot rotate this object.'); }
        }
      }
      return;
    }
    if (isLayoutCornerTool(tool)) {
      const raw = rawPointFromEvent(event), p = pointFromEvent(event); setCursor(p); setVcbError(null);
      const picked = pickCornerSegment(raw, page, state, 8 * page.size[0] / event.currentTarget.getBoundingClientRect().width);
      if (!picked) { setVcbError('Click a straight path segment.'); return; }
      if (!cornerFirst) {
        const source = entityOnPage(page, state, picked.entityId)!;
        if (objectLocked(source, state)) { setVcbError('Source layer is locked.'); return; }
        if (pathSegment(source.points, source.handles, picked.segmentIndex, source.closed, source.contourStarts).curved) { setVcbError('Choose a straight segment.'); return; }
        setCornerFirst(picked); setCornerHover(null); setSelectionId(picked.entityId);
      } else {
        try {
          const id = tab.commands.execute('layout.path.corner', { pageId: page.id, kind: tool, amountMm: cornerAmountMm, first: cornerFirst, second: picked }) as number;
          setSelectionId(id); setCornerFirst(null); setCornerHover(null); setCursor(null); setVcb('');
        } catch (error) { setVcbError(error instanceof Error ? error.message : 'Cannot edit this corner.'); }
      }
      return;
    }
    if (tool === 'offset') {
      const raw = rawPointFromEvent(event), p = pointFromEvent(event); setCursor(p); setVcbError(null);
      if (offsetDraft && offsetSource) {
        try { commitOffset(layoutOffsetDistance(offsetSource, p)); }
        catch (error) { setVcbError(error instanceof Error ? error.message : 'Cannot offset this path.'); }
      } else {
        // Prefer the clicked boundary when another filled shape covers its interior.
        const boundary = pickCornerSegment(raw, page, state, 2);
        const entity = boundary ? entityOnPage(page, state, boundary.entityId) : pickEntity(raw, page, state);
        if (!entity || entity.kind !== 'path') { setVcbError('Click a path to offset.'); return; }
        if (objectLocked(entity, state)) { setVcbError('Source layer is locked.'); return; }
        setSelectionId(entity.id); setOffsetDraft({ entityId: entity.id, distanceMm: 0 });
      }
      return;
    }
    const p = tool === 'select' ? rawPointFromEvent(event) : pointFromEvent(event);
    if (tool === 'bezier') {
      // Each press places an anchor; pressing the first anchor closes the path, the last one ends it.
      if (event.button !== 0) return;
      setCursor(p); setVcbError(null);
      const tolerance = 8 * page.size[0] / event.currentTarget.getBoundingClientRect().width;
      const near = (q: Point | undefined): boolean => !!q && Math.hypot(p[0] - q[0], p[1] - q[1]) <= tolerance;
      if (bezierDraft && near(bezierDraft.points[0]) && finishLayoutBezier(bezierDraft, true)) { finishBezier(bezierDraft, true); return; }
      if (bezierDraft && near(bezierDraft.points.at(-1))) { finishBezier(bezierDraft, false); return; }
      setBezierDraft(addLayoutBezierAnchor(bezierDraft, p));
      bezierPress.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (isLayoutArcTool(tool)) {
      setCursor(p); setArcError(null);
      const points = arcDraft?.points ?? [];
      if (points.length < 2) {
        if (points[0] && Math.hypot(p[0] - points[0][0], p[1] - points[0][1]) < 1e-6) {
          setArcError('Choose a different second point.'); return;
        }
        setArcDraft({ points: [...points, p], sweep: 0 });
      } else {
        try {
          const sweep = tool === 'arc' || tool === 'pie' ? layoutArcSweep(points[0]!, points[1]!, p, arcDraft!.sweep) : undefined;
          const id = tab.commands.execute('layout.arc.add', { pageId: page.id, kind: tool, points: [...points, p], sweep }) as number;
          setSelectionId(id); setArcDraft(null);
        } catch (error) { setArcError(error instanceof Error ? error.message : 'Unable to create arc.'); }
      }
      return;
    }
    if (tool === 'angular-dimension' && (dimensionDraft?.points.length ?? 0) < 2) {
      setCursor(p); setDimensionError(null);
      const raw = rawPointFromEvent(event), tolerance = 8 * page.size[0] / event.currentTarget.getBoundingClientRect().width;
      const straightPick = (): CornerPick | null => {
        // At a shared corner, prefer the already chosen edge: it still counts as the same edge.
        if (angularEdgeFirst) {
          const first = entityOnPage(page, state, angularEdgeFirst.entityId);
          if (first && angularEdgeFirst.segmentIndex < first.points.length - (first.closed ? 0 : 1)) {
            const projected = projectOnPathSegment(raw, first, angularEdgeFirst.segmentIndex);
            if (projected.distance <= tolerance) return { ...angularEdgeFirst, point: projected.point };
          }
        }
        const pick = pickCornerSegment(raw, page, state, tolerance);
        const source = pick && entityOnPage(page, state, pick.entityId);
        if (!pick || !source || pathSegment(source.points, source.handles, pick.segmentIndex, source.closed, source.contourStarts).curved) return null;
        const a = source.points[pick.segmentIndex]!, b = source.points[(pick.segmentIndex + 1) % source.points.length]!;
        return Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6 ? null : pick;
      };
      const picked = straightPick();
      if (!dimensionDraft) {
        setAngularEdgeFirst(picked);
        const source = picked && entityOnPage(page, state, picked.entityId);
        setDimensionDraft({ points: [p], anchors: [dimensionAnchorAt(p, page, state)],
          ...(picked && source ? { edgeGuide: [source.points[picked.segmentIndex]!, source.points[(picked.segmentIndex + 1) % source.points.length]!] } : {}) });
      } else if (angularEdgeFirst && picked && (picked.entityId !== angularEdgeFirst.entityId || picked.segmentIndex !== angularEdgeFirst.segmentIndex)) {
        const first = entityOnPage(page, state, angularEdgeFirst.entityId), second = entityOnPage(page, state, picked.entityId);
        if (!first || !second) { setDimensionError('A measured edge is unavailable. Press Escape to start again.'); return; }
        try {
          const result = angularEdgesFromPicks({ entity: first, segmentIndex: angularEdgeFirst.segmentIndex, point: angularEdgeFirst.point },
            { entity: second, segmentIndex: picked.segmentIndex, point: picked.point });
          setDimensionDraft({ points: result.points, anchors: [null, null, null], edgeAnchors: result.edges });
          setAngularEdgeFirst(null);
        } catch (error) { setDimensionError(error instanceof Error ? error.message : 'Cannot measure these edges.'); }
      } else {
        const problem = Math.hypot(p[0] - dimensionDraft.points[0]![0], p[1] - dimensionDraft.points[0]![1]) < 1e-6 ? 'Choose two different points for the first ray.' : null;
        if (problem) { setDimensionError(problem); return; }
        setDimensionDraft({ points: [...dimensionDraft.points, p], rayPoints: [...dimensionDraft.points, p], anchors: [...dimensionDraft.anchors, dimensionAnchorAt(p, page, state)] });
        setAngularEdgeFirst(null);
      }
      return;
    }
    if (tool === 'angular-dimension' && dimensionDraft?.rayPoints && dimensionDraft.rayPoints.length < 4) {
      setCursor(p); setDimensionError(null);
      const rayPoints = [...dimensionDraft.rayPoints, p];
      const anchors = [...dimensionDraft.anchors, dimensionAnchorAt(p, page, state)];
      if (rayPoints.length === 3) setDimensionDraft({ ...dimensionDraft, rayPoints, anchors });
      else {
        try {
          const points = angularRaysFromPoints(rayPoints);
          setDimensionDraft({ points, anchors: [null, null, null], rayPoints,
            rayDefinition: { points: rayPoints as NonNullable<LayoutAngularDimension['rayDefinition']>['points'],
              anchors: anchors as NonNullable<LayoutAngularDimension['rayDefinition']>['anchors'] } });
        } catch (error) { setDimensionError(error instanceof Error ? error.message : 'Cannot measure these rays.'); }
      }
      return;
    }
    if (tool === 'dimension' || tool === 'angular-dimension') {
      if (modelSnapUnavailable.current) { setDimensionError('Model geometry is unavailable. Wait for the model to load before measuring.'); return; }
      setCursor(p); setDimensionError(null);
      if (tool === 'dimension' && !dimensionDraft && (event.metaKey || event.ctrlKey)) {
        // Measure the whole coincident straight run through the clicked segment; the next click places the line.
        // Once points are pending, a still-held modifier means nothing and the click falls through as a normal one.
        const picked = pickCornerSegment(rawPointFromEvent(event), page, state, 8 * page.size[0] / event.currentTarget.getBoundingClientRect().width);
        const source = picked && entityOnPage(page, state, picked.entityId);
        const visible = state.layerOrder.filter((id) => isLayoutLayerVisible(page, state, id)).flatMap((id) => entitiesForLayer(page, state, id));
        const extent = picked && source ? autoDimensionExtent(source, picked.segmentIndex, visible) : null;
        if (!extent) { setDimensionError(`${PRIMARY_MODIFIER}-click a straight line to measure its full length.`); return; }
        setDimensionDraft({ points: [...extent.points], anchors: [...extent.anchors] });
        return;
      }
      const points = dimensionDraft?.points ?? [];
      const anchors = dimensionDraft?.anchors ?? [];
      const measurementCount = tool === 'angular-dimension' ? 3 : 2;
      if (tool === 'angular-dimension') {
        const problem = angularDimensionError([...points, p]);
        if (problem) { setDimensionError(problem); return; }
      }
      if (points.length < measurementCount) {
        if (points.length > 0 && Math.hypot(p[0] - points[0]![0], p[1] - points[0]![1]) < 1e-6) {
          setDimensionError(tool === 'angular-dimension' ? 'Choose a point away from the vertex.' : 'Choose a different second point.'); return;
        }
        const previousModel = dimensionDraft?.modelAttachments?.[0];
        const pickedModel = tool === 'dimension' ? modelSnap.current : null;
        if (tool === 'dimension' && points.length && (!!previousModel !== !!pickedModel || previousModel && pickedModel && previousModel.viewportId !== pickedModel.viewportId)) {
          setDimensionError('Choose the second model point in the same view, or press Escape to start again.'); return;
        }
        setDimensionDraft({ points: [...points, p], anchors: [...anchors, pickedModel ? null : dimensionAnchorAt(p, page, state)],
          modelAttachments: [...(dimensionDraft?.modelAttachments ?? []), pickedModel] });
      } else {
        try {
          const id = tab.commands.execute(tool === 'angular-dimension' ? 'layout.dimension.addAngular' : 'layout.dimension.add', { pageId: page.id,
            points: [...points, p], anchors, ...(dimensionDraft?.edgeAnchors ? { edgeAnchors: dimensionDraft.edgeAnchors } : {}),
            ...(dimensionDraft?.modelAttachments?.every(Boolean) && dimensionDraft.modelAttachments.length === 2 ? { modelAttachments: dimensionDraft.modelAttachments } : {}),
            ...(dimensionDraft?.rayDefinition ? { rayDefinition: dimensionDraft.rayDefinition } : {}),
            ...(tool === 'dimension' ? { style: { alignment: inferLinearDimensionAlignment(points[0]!, points[1]!) } } : { style: { reflex: angularPlacementReflex(points[0]!, points[1]!, points[2]!, p) } }) }) as number;
          setSelectionId(id); setDimensionDraft(null); setAngularEdgeFirst(null); setCursor(null); setSnapKind(null);
        } catch (error) { setDimensionError(error instanceof Error ? error.message : 'Unable to create dimension.'); }
      }
      return;
    }
    if (tool === 'select' || tool === 'eraser') {
      if (tool === 'select') { setCursor(null); setSnapKind(null); }
      setEditingTextId(null);
      const entity = pickEntity(p, page, tab.doc.state);
      if (tool === 'select' && tableCellsActive && selectionId === entity?.id && entity?.table && entity.groupId === undefined && !objectLocked(entity, tab.doc.state) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const cell = tableCellAt(entity, p);
        if (cell) {
          event.preventDefault();
          const anchor = event.shiftKey && selectionId === entity.id ? tableSelection.anchor : cell;
          const selection = { anchor, focus: cell };
          setSelectionId(entity.id); setTableSelection(selection); setTableCellsActive(true); setTableEditRequest(0);
          tableDrag.current = selection; event.currentTarget.setPointerCapture?.(event.pointerId); return;
        }
      }
      setTableCellsActive(false);
      if (tool === 'select') {
        if (!entity) {
          // A drag from empty paper draws a selection box; a plain click clears the selection on release.
          boxStart.current = { point: p, x: event.clientX, y: event.clientY, additive: event.shiftKey };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          return;
        }
        const primary = event.metaKey || event.ctrlKey;
        if (event.shiftKey || primary) {
          // Shift toggles membership;: Ctrl (Cmd) adds and Ctrl+Shift subtracts. None starts a move.
          const members = expandLayoutGroups([entity.id], page, tab.doc.state);
          const remove = primary ? event.shiftKey : selectionIds.includes(entity.id);
          setSelectionIds(remove ? selectionIds.filter(id => !members.includes(id)) : [...new Set([...selectionIds, ...members])]);
          return;
        }
        const group = selectionIds.includes(entity.id) ? selectionIds : expandLayoutGroups([entity.id], page, tab.doc.state);
        setSelectionIds(group);
        // Alt (Option) selects without moving.
        if (event.altKey) return;
        const unlocked = group.filter((id) => { const member = entityOnPage(page, tab.doc.state, id); return member && !objectLocked(member, tab.doc.state); });
        if (unlocked.includes(entity.id)) {
          moveStart.current = { entityIds: unlocked, point: rawPointFromEvent(event), x: event.clientX, y: event.clientY,
            ...(entity.kind === 'label' && group.length === 1 ? { labelPart: layoutLabelDragPart(entity, rawPointFromEvent(event),
              8 * page.size[0] / event.currentTarget.getBoundingClientRect().width) } : {}) };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }
      }
      else if (entity && !objectLocked(entity, tab.doc.state))
        tab.commands.execute('layout.shape.delete', { pageId: page.id, entityId: entity.id });
      return;
    }
    if (anchor && tool === 'line') {
      pointerDown.current = { point: p, x: event.clientX, y: event.clientY, fromAnchor: true };
      setCursor(p);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (anchor && tool !== 'freehand') {
      commit(anchor, p);
      pointerDown.current = null;
      return;
    }
    pointerDown.current = { point: p, x: event.clientX, y: event.clientY, fromAnchor: false };
    setAnchor(p);
    setCursor(p);
    if (tool === 'table') setTableCounting(true);
    if (tool === 'freehand') setFreehand([p]);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (tool === 'shape-builder') { shapeBuilder.pointer(rawPointFromEvent(event), true, event.shiftKey); return; }
    if (tableDrag.current && selectedEntity?.table) {
      const focus = tableCellAt(selectedEntity, rawPointFromEvent(event));
      if (focus) setTableSelection({ anchor: tableDrag.current.anchor, focus });
      return;
    }
    if (tool === 'lasso') {
      const press = lassoPress.current, p = rawPointFromEvent(event);
      if (press && (event.buttons & 1) && (!lasso || lasso.freehand)) {
        // Freehand points are kept every 3 screen pixels once the press has moved 4.
        if (!lasso && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
          lassoLast.current = { x: event.clientX, y: event.clientY };
          setLasso({ points: [press.point, p], freehand: true, cursor: null });
        } else if (lasso && lassoLast.current && Math.hypot(event.clientX - lassoLast.current.x, event.clientY - lassoLast.current.y) >= 3) {
          lassoLast.current = { x: event.clientX, y: event.clientY };
          setLasso({ ...lasso, points: [...lasso.points, p] });
        }
      } else if (lasso && !lasso.freehand) setLasso({ ...lasso, cursor: p });
      return;
    }
    const viewDrag = viewportDrag.current;
    if (viewDrag && navigatingViewportId !== null) {
      const entity = entityOnPage(page, tab.doc.state, navigatingViewportId);
      const raw = rawPointFromEvent(event);
      if (isViewport(entity)) previewViewportCamera((viewDrag.pan ? panViewportCamera : orbitViewportCamera)(viewDrag.camera, entity.points,
        [raw[0] - viewDrag.start[0], raw[1] - viewDrag.start[1]]));
      return;
    }
    const pointEdit = pointEditStart.current;
    if (pointEdit) {
      const original = pointEdit.points[pointEdit.index]!;
      let next = rawPointFromEvent(event);
      if (event.shiftKey && pointEdit.side === 'anchor') next = Math.abs(next[0] - original[0]) >= Math.abs(next[1] - original[1])
        ? [next[0], original[1]] : [original[0], next[1]];
      const points = pointEdit.points.map((point, index): Point =>
        index === pointEdit.index && pointEdit.side === 'anchor' ? next : point);
      const handles = copyHandles(pointEdit.handles, points.length);
      if (pointEdit.side === 'anchor') {
        const delta: Point = [next[0] - original[0], next[1] - original[1]];
        for (const side of ['in', 'out'] as const) {
          const handle = handles[pointEdit.index]![side];
          if (handle) handles[pointEdit.index]![side] = [handle[0] + delta[0], handle[1] + delta[1]];
        }
      } else handles[pointEdit.index]![pointEdit.side] = next;
      setEditPoints(points);
      setEditHandles(handles);
      return;
    }
    const moving = moveStart.current;
    if (moving && tool === 'select') {
      const current = rawPointFromEvent(event);
      let delta: Point = [current[0] - moving.point[0], current[1] - moving.point[1]];
      if (event.shiftKey) delta = Math.abs(delta[0]) >= Math.abs(delta[1])
        ? [delta[0], 0] : [0, delta[1]];
      const moved = Math.hypot(event.clientX - moving.x, event.clientY - moving.y) > 4;
      setMovePreview(moved ? { entityIds: new Set(moving.entityIds), delta, copy: event.metaKey || event.ctrlKey, ...(moving.labelPart ? { labelPart: moving.labelPart } : {}) } : null);
      return;
    }
    const box = boxStart.current;
    if (box && tool === 'select') {
      const moved = Math.hypot(event.clientX - box.x, event.clientY - box.y) > 4;
      setBoxSelect(moved ? { from: box.point, to: rawPointFromEvent(event), additive: event.shiftKey || box.additive } : null);
      return;
    }
    if (tool === 'label') {
      const snapped = pointFromEvent(event);
      const p: Point = labelDraft?.bend ? [snapped[0], labelDraft.bend[1]] : snapped;
      if (p[1] !== snapped[1]) setSnapKind(null);
      setCursor(p); setVcbError(null); return;
    }
    if (tool === 'move') {
      const p = pointFromEvent(event);
      if (!moveDraft) { setCursor(p); return; }
      const delta = moveDelta(moveDraft, p, event.shiftKey);
      const target: Point = [moveDraft.base[0] + delta[0], moveDraft.base[1] + delta[1]];
      if (target[0] !== p[0] || target[1] !== p[1]) setSnapKind(null);
      setCursor(target);
      setMovePreview({ entityIds: new Set(moveDraft.entityIds), delta, copy: moveDraft.copy, whole: true });
      return;
    }
    if (tool === 'rotate') {
      const p = pointFromEvent(event); setCursor(p);
      if (rotationDraft?.reference && Math.hypot(p[0] - rotationDraft.pivot[0], p[1] - rotationDraft.pivot[1]) >= 1e-6) {
        setRotationDraft({ ...rotationDraft, angleDeg: pointerRotation(rotationDraft, rotationDraft.reference, p, event) }); setVcbError(null);
      }
      return;
    }
    if (isLayoutCornerTool(tool)) {
      const raw = rawPointFromEvent(event), p = pointFromEvent(event); setCursor(p); setVcbError(null);
      setCornerHover(pickCornerSegment(raw, page, state, 8 * page.size[0] / event.currentTarget.getBoundingClientRect().width));
      return;
    }
    if (tool === 'offset') {
      const p = pointFromEvent(event); setCursor(p);
      if (offsetDraft && offsetSource) {
        try { setOffsetDraft({ entityId: offsetDraft.entityId, distanceMm: layoutOffsetDistance(offsetSource, p) }); setVcbError(null); }
        catch (error) { setVcbError(error instanceof Error ? error.message : 'Cannot offset this path.'); }
      }
      return;
    }
    if (tool === 'select' || tool === 'scale' || booleanOperation(tool)) { setCursor(null); setSnapKind(null); return; }
    const counting = pointerDown.current;
    if (tool === 'table' && counting && !counting.fromAnchor) {
      // Each step right or left adds a column, each step up or down a row; the preview grows by whole cells.
      const dx = event.clientX - counting.x, dy = event.clientY - counting.y;
      if (Math.hypot(dx, dy) <= 4) return;
      const columns = Math.min(100, Math.max(1, Math.ceil(Math.abs(dx) / TABLE_COUNT_STEP_PX[0])));
      const rows = Math.min(100, Math.max(1, Math.ceil(Math.abs(dy) / TABLE_COUNT_STEP_PX[1])));
      const mmPerPx = page.size[0] / event.currentTarget.getBoundingClientRect().width;
      setTableColumns(columns); setTableRows(rows); setSnapKind(null);
      setCursor([counting.point[0] + (dx < 0 ? -1 : 1) * columns * TABLE_COUNT_STEP_PX[0] * mmPerPx,
        counting.point[1] + (dy < 0 ? -1 : 1) * rows * TABLE_COUNT_STEP_PX[1] * mmPerPx]);
      return;
    }
    const press = bezierPress.current;
    if (tool === 'bezier' && press && bezierDraft && (event.buttons & 1)) {
      // Dragging past 4 screen pixels pulls the new anchor's handles to the pointer, unsnapped.
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 4) return;
      setCursor(null); setSnapKind(null);
      setBezierDraft(pullLayoutBezierHandle(bezierDraft, rawPointFromEvent(event)));
      return;
    }
    const p = pointFromEvent(event);
    setCursor(p);
    if (tool === 'angular-dimension' && dimensionDraft && !angularDimensionError([...dimensionDraft.points, p])) setDimensionError(null);
    if ((tool === 'arc' || tool === 'pie') && arcDraft?.points.length === 2) {
      setArcDraft(previous => previous ? { ...previous, sweep: layoutArcSweep(previous.points[0]!, previous.points[1]!, p, previous.sweep) } : null);
    }
    if (tool === 'freehand' && pointerDown.current) setFreehand((points) => [...points, p]);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (tool === 'shape-builder') { shapeBuilder.up(rawPointFromEvent(event), event.shiftKey); return; }
    if (tableDrag.current) { tableDrag.current = null; return; }
    if (tool === 'scale' || booleanOperation(tool)) return;
    if (tool === 'lasso') {
      const press = lassoPress.current;
      lassoPress.current = null;
      if (!press || event.button !== 0) return;
      if (lasso?.freehand) { finishLasso([...lasso.points, rawPointFromEvent(event)], event); return; }
      // A click adds an outline point; the second click of a double-click lands on the same spot and adds none.
      const last = lassoLast.current;
      if (last && Math.hypot(event.clientX - last.x, event.clientY - last.y) <= 4) return;
      lassoLast.current = { x: event.clientX, y: event.clientY };
      setLasso({ points: [...(lasso?.points ?? []), press.point], freehand: false, cursor: press.point });
      return;
    }
    if (tool === 'bezier') { bezierPress.current = null; return; }
    if (viewportDrag.current) {
      // The drag commits as one undoable camera change on release.
      viewportDrag.current = null;
      const camera = viewportPreviewRef.current;
      previewViewportCamera(null);
      if (camera && navigatingViewportId !== null) commitViewportCamera(navigatingViewportId, camera);
      return;
    }
    const pointEdit = pointEditStart.current;
    pointEditStart.current = null;
    if (pointEdit) {
      setEditPoints(null);
      setEditHandles(null);
      const moved = Math.hypot(event.clientX - pointEdit.x, event.clientY - pointEdit.y) > 4;
      if (moved && editingPathId !== null) {
        const original = pointEdit.points[pointEdit.index]!;
        let next = rawPointFromEvent(event);
        if (event.shiftKey && pointEdit.side === 'anchor') next = Math.abs(next[0] - original[0]) >= Math.abs(next[1] - original[1])
          ? [next[0], original[1]] : [original[0], next[1]];
        const points = pointEdit.points.map((point, index): Point =>
          index === pointEdit.index && pointEdit.side === 'anchor' ? next : point);
        const handles = copyHandles(pointEdit.handles, points.length);
        if (pointEdit.side === 'anchor') {
          const delta: Point = [next[0] - original[0], next[1] - original[1]];
          for (const side of ['in', 'out'] as const) {
            const handle = handles[pointEdit.index]![side];
            if (handle) handles[pointEdit.index]![side] = [handle[0] + delta[0], handle[1] + delta[1]];
          }
        } else handles[pointEdit.index]![pointEdit.side] = next;
        tab.commands.execute('layout.shape.setPath', { pageId: page.id, entityId: editingPathId, points, handles });
      }
      return;
    }
    const moving = moveStart.current;
    moveStart.current = null;
    if (moving) {
      setMovePreview(null);
      const moved = Math.hypot(event.clientX - moving.x, event.clientY - moving.y) > 4;
      if (moved) {
        const current = rawPointFromEvent(event);
        let delta: Point = [current[0] - moving.point[0], current[1] - moving.point[1]];
        if (event.shiftKey) delta = Math.abs(delta[0]) >= Math.abs(delta[1])
          ? [delta[0], 0] : [0, delta[1]];
        const copy = event.metaKey || event.ctrlKey; //: Ctrl (Cmd) held on release drops a copy.
        const movedIds = tab.commands.execute('layout.shape.move', {
          pageId: page.id, entityIds: moving.entityIds, delta, copy, ...(moving.labelPart ? { labelPart: moving.labelPart } : {}),
        }) as number[];
        // Locked members of a group move stay selected in place; a copy selects the copies.
        setSelectionIds(copy ? movedIds : selectionIds.length > moving.entityIds.length ? selectionIds : movedIds);
      }
      return;
    }
    const box = boxStart.current;
    boxStart.current = null;
    if (box) {
      setBoxSelect(null);
      const moved = Math.hypot(event.clientX - box.x, event.clientY - box.y) > 4;
      if (!moved) { setSelectionIds([]); return; }
      const covered = expandLayoutGroups(entitiesInSelectionBox(box.point, rawPointFromEvent(event), page, tab.doc.state).map((entity) => entity.id), page, tab.doc.state);
      const additive = event.shiftKey || box.additive;
      setSelectionIds(additive ? [...selectionIds, ...covered.filter((id) => !selectionIds.includes(id))] : covered);
      return;
    }
    const down = pointerDown.current;
    pointerDown.current = null;
    if (!down) return;
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4;
    // Releasing locks the row and column counts; the next click sets the table's size.
    if (tool === 'table') { setTableCounting(false); return; }
    if (tool === 'freehand') {
      const end = pointFromEvent(event);
      const shape = createLayoutFreehand([...freehand, end], FREEHAND_SMOOTHING_PX * page.size[0] / Math.max(1, event.currentTarget.getBoundingClientRect().width));
      if (shape.points.length > 1) commit(down.point, end, shape);
      setAnchor(null); setCursor(null); setSnapKind(null); setFreehand([]);
    } else if (tool === 'line') {
      if (down.fromAnchor && anchor) commit(anchor, pointFromEvent(event));
      else if (moved) commit(down.point, pointFromEvent(event));
    } else if (moved || tool === 'text') commit(down.point, pointFromEvent(event), undefined, tool === 'text' ? moved : undefined);
  };
  // Tools work past the paper edge: presses on the workspace around the page reach the page's handlers,
  // with page coordinates measured from the page canvas.
  const offPage = <E extends ReactMouseEvent<HTMLElement>>(handler: (event: never) => void) => (event: E): void => {
    const canvas = canvasRef.current;
    if (!canvas || (event.target !== event.currentTarget && !(event.target instanceof Element && event.target.classList.contains('pf-layout-page-wrap')))) return;
    // A press beside the page gives the page keyboard focus, as a press on the page does.
    if (event.type === 'pointerup' && document.activeElement !== canvas) canvas.focus({ preventScroll: true });
    handler(Object.create(event, { currentTarget: { value: canvas } }) as never);
  };
  const pageCursor: CSSProperties | undefined = tool === 'shape-builder' ? { cursor: shapeBuilder.session?.busy ? 'wait' : shapeBuilder.effectiveMode === 'add' ? 'copy' : 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\'%3E%3Cpath d=\'M8 1v14M1 8h14M16 19h7\' stroke=\'white\' stroke-width=\'3\'/%3E%3Cpath d=\'M8 1v14M1 8h14M16 19h7\' stroke=\'%23d62975\' stroke-width=\'1.5\'/%3E%3C/svg%3E") 8 8, crosshair' } : tool === 'move' && !moveDraft ? { cursor: 'move' } : undefined;
  const onDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>): void => {
    if (tool === 'lasso') { if (lasso && !lasso.freehand) finishLasso(lasso.points, event); return; }
    if (tool === 'line') { setAnchor(null); setCursor(null); pointerDown.current = null; return; }
    if (isRepeatableShapeTool(tool)) {
      // The double-click's own clicks draw nothing; the tool's last shape is drawn again from the click.
      setAnchor(null); setCursor(null); setVcb(''); pointerDown.current = null;
      const repeat = shapeRepeats.current.get(tool);
      if (!repeat) return;
      const { id, params } = repeatLayoutShape(repeat, page.id, pointFromEvent(event));
      tab.commands.execute(id, params);
      return;
    }
    if (tool === 'table' || tool === 'freehand' || isLayoutArcTool(tool) || tool === 'label' || tool === 'viewport' || tool === 'dimension' || tool === 'angular-dimension') {
      setAnchor(null); setCursor(null); setVcb(''); pointerDown.current = null;
      setTableCounting(false); setArcDraft(null); setLabelDraft(null); setDimensionDraft(null); setAngularEdgeFirst(null); setFreehand([]);
      setDimensionError(null); setSnapKind(null);
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      const objects = lastCreatedLayoutObjects(tab.doc, page);
      if (!objects.length) return;
      try {
        const ids = tab.commands.execute('layout.clipboard.paste', { pageId: page.id, position: rawPointFromEvent(event),
          entities: objects.map(entity => layoutClipboardEntity(entity, tab.doc.state)) }) as number[];
        setSelectionIds(ids); setEditingPathId(null); setEditPoints(null); setEditHandles(null);
        setTableCellsActive(false); setTableEditRequest(0); setVcbError(null);
      } catch (error) { setVcbError(error instanceof Error ? error.message : 'Could not repeat the last object.'); }
      return;
    }
    if (tool !== 'select') return;
    const raw = rawPointFromEvent(event);
    const target = pickEntity(raw, page, tab.doc.state);
    if (target?.groupId !== undefined) return;
    if (isViewport(target) && isLayoutLayerVisible(page, tab.doc.state, target.layerId) && !objectLocked(target, tab.doc.state)) {
      setSelectionId(target.id);
      setNavigatingViewportId(target.id);
      return;
    }
    if (target?.table && !objectLocked(target, tab.doc.state)) {
      setSelectionId(target.id); setTableCell(tableCellAt(target, raw) ?? { row: 0, column: 0 });
      setTableCellsActive(true); setTableEditRequest(request => request + 1);
      return;
    }
    if (target?.text && isLayoutLayerVisible(page, tab.doc.state, target.layerId) &&
        !objectLocked(target, tab.doc.state)) {
      setEditingPathId(null);
      setEditPoints(null);
      setEditHandles(null);
      setActivePointIndex(null);
      setSelectionId(target.id);
      setEditingTextId(target.id);
      return;
    }
    if (editingPathId !== target?.id) {
      const entity = target;
      if (entity?.kind === 'path' && isLayoutLayerVisible(page, tab.doc.state, entity.layerId) &&
          !objectLocked(entity, tab.doc.state)) {
        setTool('select');
        setSelectionId(entity.id);
        setEditingPathId(entity.id);
        setActivePointIndex(null);
      }
      return;
    }
    const entity = entityOnPage(page, tab.doc.state, editingPathId);
    if (!entity || entity.kind !== 'path') return;
    const tolerance = 8 * page.size[0] / event.currentTarget.getBoundingClientRect().width;
    if (entity.points.some((point) => Math.hypot(raw[0] - point[0], raw[1] - point[1]) <= tolerance))
      return;
    let best: { index: number; point: Point; distance: number; t: number } | null = null;
    for (const index of layoutPathSegmentIndices(entity)) {
      const projection = projectOnPathSegment(raw, entity, index);
      if (projection.distance <= tolerance && (!best || projection.distance < best.distance))
        best = { index, ...projection };
    }
    if (!best) return;
    const split = splitLayoutPathSegment(entity.points, entity.handles, entity.closed,
      best.index, Math.max(0.001, Math.min(0.999, best.t)), entity.contourStarts);
    tab.commands.execute('layout.shape.setPath', {
      pageId: page.id, entityId: editingPathId, points: split.points, handles: split.handles, ...(split.contourStarts ? { contourStarts: split.contourStarts } : {}),
    });
    setActivePointIndex(best.index + 1);
  };
  const applyVcb = (): void => {
    if (!vcb.trim()) return;
    if (tool === 'move') {
      const parsed = parseVcb(vcb, state.settings.units === 'mm' ? 'mm' : 'in');
      if (!parsed.ok) { setVcbError(parsed.error.error); return; }
      const value = parsed.value;
      if (value.kind === 'array') { arrayMoveCopy(value.count, value.mode); return; }
      if (!moveDraft) { setVcbError('Click an object to choose the base point first.'); return; }
      if (value.kind === 'length') {
        // Exactly this distance along the previewed (possibly Shift-constrained) direction.
        const direction = movePreview?.delta ?? [0, 0];
        const magnitude = Math.hypot(direction[0], direction[1]);
        if (magnitude <= LENGTH_TOL) { setVcbError('Move the pointer to show the direction first.'); return; }
        const lengthMm = value.meters * 1000;
        commitMove([direction[0] * lengthMm / magnitude, direction[1] * lengthMm / magnitude]); return;
      }
      const [x, y] = value.kind === 'list' && value.values.length === 2 ? value.values : [];
      if (x?.kind === 'length' && y?.kind === 'length') { commitMove([x.meters * 1000, y.meters * 1000]); return; }
      setVcbError('Enter a distance, or x, y offsets.'); return;
    }
    if (tool === 'rotate') {
      if (!rotationDraft?.reference) { setVcbError('Choose the rotation point and reference direction first.'); return; }
      const parsed = parseVcb(vcb, state.settings.units === 'mm' ? 'mm' : 'in');
      if (!parsed.ok) { setVcbError(parsed.error.error); return; }
      const angle = parsed.value.kind === 'angle' ? parsed.value.degrees
        : parsed.value.kind === 'length' && parsed.value.unit === null ? parsed.value.raw : NaN;
      if (!Number.isFinite(angle)) { setVcbError('Enter a rotation angle in degrees.'); return; }
      commitRotation(angle); return;
    }
    if (isLayoutCornerTool(tool)) {
      const parsed = parseVcb(vcb, state.settings.units === 'mm' ? 'mm' : 'in');
      if (!parsed.ok) { setVcbError(parsed.error.error); return; }
      if (parsed.value.kind !== 'length' || parsed.value.meters <= 0) { setVcbError('Enter a positive corner size.'); return; }
      const amount = parsed.value.meters * 1000;
      if (tool === 'fillet') setFilletRadiusMm(amount); else setChamferDistanceMm(amount);
      setVcb(''); setVcbError(null); return;
    }
    if (tool === 'offset') {
      if (!offsetDraft || !offsetSource) { setVcbError('Click a path before entering its offset distance.'); return; }
      const parsed = parseVcb(vcb, state.settings.units === 'mm' ? 'mm' : 'in');
      if (!parsed.ok) { setVcbError(parsed.error.error); return; }
      if (parsed.value.kind !== 'length') { setVcbError('Enter an offset distance.'); return; }
      const direction = offsetSource.closed ? 1 : Math.sign(offsetDraft.distanceMm) || 1;
      commitOffset(parsed.value.meters * 1000 * direction); return;
    }
    if (isPolygonTool(tool)) {
      const sides = parseVcb(vcb);
      if (sides.ok && sides.value.kind === 'segments') {
        const count = sides.value.count;
        if (count < LAYOUT_POLYGON_MIN_SIDES || count > LAYOUT_POLYGON_MAX_SIDES) { setVcbError(`Enter ${LAYOUT_POLYGON_MIN_SIDES} to ${LAYOUT_POLYGON_MAX_SIDES} sides.`); return; }
        setPolygonSides(count); setVcb(''); setVcbError(null); return;
      }
    }
    if (!anchor) {
      setVcbError('Start a shape before entering a measurement');
      return;
    }
    const parsed = parseVcb(vcb, state.settings.units === 'mm' ? 'mm' : 'in');
    if (!parsed.ok) {
      setVcbError(parsed.error.error);
      return;
    }
    const value = parsed.value;
    const dx = (cursor?.[0] ?? anchor[0] + 1) - anchor[0];
    const dy = (cursor?.[1] ?? anchor[1]) - anchor[1];
    const magnitude = Math.hypot(dx, dy) || 1;
    if (value.kind === 'length') {
      const lengthMm = value.meters * 1000;
      commit(anchor, [
        anchor[0] + (lengthMm * dx) / magnitude,
        anchor[1] + (lengthMm * dy) / magnitude,
      ]);
    } else if (value.kind === 'angle' && tool === 'line') {
      const radians = value.degrees * Math.PI / 180;
      setCursor([anchor[0] + magnitude * Math.cos(radians), anchor[1] + magnitude * Math.sin(radians)]);
      setVcb('');
      setVcbError(null);
    } else if (value.kind === 'list' && tool === 'line' &&
      value.values[0]?.kind === 'length' && value.values[1]?.kind === 'angle') {
      const radians = value.values[1].degrees * Math.PI / 180;
      const lengthMm = value.values[0].meters * 1000;
      commit(anchor, [anchor[0] + lengthMm * Math.cos(radians),
        anchor[1] + lengthMm * Math.sin(radians)]);
    } else if (value.kind === 'list' && value.values.length >= 2 && (usesPlacementModifiers(tool) || tool === 'table')) {
      const width = value.values[0]?.kind === 'length' ? value.values[0].meters * 1000 : null;
      const height = value.values[1]?.kind === 'length' ? value.values[1].meters * 1000 : null;
      if (width !== null && height !== null) {
        const modifiers = usesPlacementModifiers(tool) ? { ...placementModifiersRef.current, square: false } : NO_PLACEMENT_MODIFIERS;
        const divisor = modifiers.center ? 2 : 1;
        commit(anchor, [anchor[0] + width / divisor, anchor[1] + height / divisor], undefined, undefined, modifiers);
      }
      else setVcbError(tool === 'ellipse' ? 'Enter ellipse width and height' : 'Enter rectangle width and height');
    } else if ((value.kind === 'relative' || value.kind === 'absolute') && tool === 'line' &&
      value.coords[0] !== null && value.coords[1] !== null) {
      const origin: Point = value.kind === 'relative' ? anchor : [0, 0];
      commit(anchor, [origin[0] + value.coords[0] * 1000,
        origin[1] + value.coords[1] * 1000]);
    } else {
      setVcbError('Measurement is not supported by this tool');
    }
  };
  const runPageCommand = (id: string, params: object): void => {
    tab.commands.execute(id, params);
  };
  const fitPage = (): void => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    setPanOffset(0, 0);
    const next = Math.min(
      (workspace.clientWidth - 48) / (page.size[0] * PX_PER_MM),
      (workspace.clientHeight - 48) / (page.size[1] * PX_PER_MM),
    );
    setZoom(Math.max(0.1, Math.min(8, next)));
    workspace.scrollTo(0, 0);
    setZoomMenuOpen(false);
  };
  const fitEntities = (entities: LayoutEntity[]): void => {
    const workspace = workspaceRef.current;
    const bounds = entities.map(layoutEntityBounds).filter((value): value is NonNullable<typeof value> => value !== null);
    if (!workspace || bounds.length === 0) {
      fitPage();
      return;
    }
    setPanOffset(0, 0);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const extent of bounds) {
      minX = Math.min(minX, extent.minX);
      maxX = Math.max(maxX, extent.maxX);
      minY = Math.min(minY, extent.minY);
      maxY = Math.max(maxY, extent.maxY);
    }
    const next = Math.min(
      (workspace.clientWidth - 48) / (Math.max(10, maxX - minX) * PX_PER_MM),
      (workspace.clientHeight - 48) / (Math.max(10, maxY - minY) * PX_PER_MM),
    );
    zoomCenter.current = [(minX + maxX) / 2, (minY + maxY) / 2];
    setZoom(Math.max(0.1, Math.min(8, next)));
    setZoomRequest((value) => value + 1);
    setZoomMenuOpen(false);
  };
  const contextEntities = selectionIds.map(id => entityOnPage(page, state, id)).filter((entity): entity is LayoutEntity => Boolean(entity));
  const editableSelection = contextEntities.length > 0 && contextEntities.every(entity => isLayoutLayerVisible(page, state, entity.layerId) && !objectLocked(entity, state));
  const layerEditableSelection = contextEntities.length > 0 && contextEntities.every(entity => isLayoutLayerVisible(page, state, entity.layerId) && !state.layers.get(entity.layerId)?.locked);
  const allLocked = contextEntities.length > 0 && contextEntities.every(entity => entity.locked);
  const sameGroup = contextEntities.length > 0 && contextEntities[0]!.groupId !== undefined && contextEntities.every(entity => entity.groupId === contextEntities[0]!.groupId);
  const selectionExtent = () => {
    const bounds = contextEntities.map(layoutEntityBounds).filter((value): value is NonNullable<typeof value> => value !== null);
    return { minX: Math.min(...bounds.map(b => b.minX)), minY: Math.min(...bounds.map(b => b.minY)),
      maxX: Math.max(...bounds.map(b => b.maxX)), maxY: Math.max(...bounds.map(b => b.maxY)) };
  };
  const contextAction = (label: string, action: () => void): (() => void) => () => {
    try { setVcbError(null); tab.doc.undoStack.transact(label, action); }
    catch (error) { setVcbError(error instanceof Error ? error.message : `Could not ${label.toLowerCase()}.`); }
  };
  const forSelection = (command: string, params: object) => {
    // Use painting order so multi-object arrange operations preserve relative stacking.
    const ordered = state.layerOrder.flatMap(layerId => entitiesForLayer(page, state, layerId)).filter(entity => selectionIds.includes(entity.id));
    const direction = (params as { direction?: string }).direction;
    if (direction === 'back' || direction === 'forward') ordered.reverse();
    for (const entity of ordered) tab.commands.execute(command, { pageId: page.id, entityId: entity.id, ...params });
  };
  const copyFromMenu = (cut: boolean) => {
    // The native copy event writes the same rich Layout payload as the keyboard shortcut.
    if (!document.execCommand?.('copy')) throw new Error('Could not access the clipboard. Use the Copy keyboard shortcut.');
    if (cut) {
      const copied = selectionIds.map(id => entityOnPage(page, tab.doc.state, id));
      const remove = () => {
        const currentPage = tab.doc.state.pages.get(page.id);
        if (tab.activePageId !== page.id || !currentPage || copied.some((entity, i) => entityOnPage(currentPage, tab.doc.state, selectionIds[i]!) !== entity)) {
          setVcbError('The copied selection changed before Cut completed. Copy and cut it again.'); return;
        }
        tab.commands.execute('layout.shape.delete', { pageId: page.id, entityIds: selectionIds });
        setSelectionIds([]);
      };
      if (clipboardWrite.current) void clipboardWrite.current.then(remove).catch(error => {
        setVcbError(error instanceof Error ? error.message : 'Could not cut: clipboard write failed.');
      });
      else remove();
    }
  };
  const contextItems: LayoutMenuItem[] = [
    { label: 'Cut', disabled: !editableSelection, action: contextAction('Cut', () => copyFromMenu(true)) },
    { label: 'Copy', disabled: !contextEntities.length, action: contextAction('Copy', () => copyFromMenu(false)) },
    { label: 'Delete', disabled: !editableSelection, action: contextAction('Delete', () => {
      tab.commands.execute('layout.shape.delete', { pageId: page.id, entityIds: selectionIds }); setSelectionIds([]);
    }) },
    { label: allLocked ? 'Unlock' : 'Lock', disabled: !layerEditableSelection, action: contextAction(allLocked ? 'Unlock' : 'Lock', () => {
      tab.commands.execute('layout.shape.setLocked', { pageId: page.id, entityIds: selectionIds, locked: !allLocked });
      setEditingPathId(null); setEditingTextId(null);
    }) },
    { label: 'Zoom Selection', disabled: !contextEntities.length, action: () => fitEntities(contextEntities) },
    { label: 'Object Snap', separator: true, checked: state.settings.objectSnap !== false,
      action: contextAction('Object Snap', () => tab.commands.execute('layout.snap.set', { enabled: state.settings.objectSnap === false })) },
    { label: 'Grid Snap', checked: state.settings.grid.snap,
      action: contextAction('Grid Snap', () => tab.commands.execute('layout.grid.set', { snap: !state.settings.grid.snap })) },
    { label: 'Move to Layer', separator: true, disabled: !editableSelection, children: [...state.layerOrder].reverse().map(layerId => {
      const layer = state.layers.get(layerId)!;
      return { label: layer.name, checked: contextEntities.every(entity => entity.layerId === layerId), disabled: layer.locked || !isLayoutLayerVisible(page, state, layer.id),
        action: contextAction('Move to Layer', () => forSelection('layout.shape.assignLayer', { layerId })) };
    }) },
    { label: 'Arrange', disabled: !editableSelection, children: [
      ['Bring to Front', 'front'], ['Bring Forward', 'forward'], ['Send Backward', 'backward'], ['Send to Back', 'back'],
    ].map(([label, direction]) => ({ label: label!, action: contextAction(label!, () => forSelection('layout.shape.order', { direction })) })) },
    { label: 'Center', disabled: !editableSelection, children: [
      ['Horizontally', 'horizontal'], ['Vertically', 'vertical'], ['Both', 'both'],
    ].map(([label, axis]) => ({ label: label!, action: contextAction('Center', () => {
      const bounds = selectionExtent();
      tab.commands.execute('layout.shape.move', { pageId: page.id, entityIds: selectionIds,
        delta: [axis === 'vertical' ? 0 : page.size[0] / 2 - (bounds.minX + bounds.maxX) / 2,
          axis === 'horizontal' ? 0 : page.size[1] / 2 - (bounds.minY + bounds.maxY) / 2] });
    }) })) },
    { label: 'Flip', disabled: !editableSelection, children: [['Horizontally', 'horizontal'], ['Vertically', 'vertical']].map(([label, axis]) => ({
      label: label!, action: contextAction('Flip', () => {
        const bounds = selectionExtent();
        forSelection('layout.shape.flip', { axis, pivot: [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2] });
      }),
    })) },
    { label: sameGroup ? 'Ungroup' : 'Make Group', separator: true,
      disabled: !editableSelection || (!sameGroup && (contextEntities.length < 2 || contextEntities.some(entity => state.layers.get(entity.layerId)?.shared !== state.layers.get(contextEntities[0]!.layerId)?.shared))),
      action: contextAction(sameGroup ? 'Ungroup' : 'Make Group', () => tab.commands.execute(sameGroup ? 'layout.shape.ungroup' : 'layout.shape.group', { pageId: page.id, entityIds: selectionIds })) },
    { label: 'Update Pattern Reference', separator: true, disabled: true },
    { label: 'Reset Pattern Origin', disabled: true },
  ];
  const openContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (tool === 'shape-builder') { event.preventDefault(); return; }
    if (event.target instanceof Element && event.target.closest('[contenteditable="true"], input, textarea')) return;
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    const entity = inside ? pickEntity(rawPointFromEvent({ currentTarget: canvas, clientX: event.clientX, clientY: event.clientY }), page, state) : null;
    if (!entity) setSelectionIds([]);
    else if (!selectionIds.includes(entity.id)) setSelectionIds(expandLayoutGroups([entity.id], page, state));
    setEditingPathId(null); setEditingTextId(null); setCursor(null); setSnapKind(null);
    setContextMenu({ x: event.clientX, y: event.clientY });
  };
  const fitContent = (): void => fitEntities(
    state.layerOrder.filter((id) => isLayoutLayerVisible(page, state, id))
      .flatMap((id) => entitiesForLayer(page, state, id)),
  );
  const toggleSection = (section: keyof typeof openSections): void =>
    setOpenSections((current) => ({ ...current, [section]: !current[section] }));
  // A refused toggle or drop reports in the status area instead of throwing from the tree's event handlers.
  const browserCommand = (id: string, params: object): unknown => {
    try { return tab.commands.execute(id, params); } catch (error) { setVcbError(error instanceof Error ? error.message : String(error)); return undefined; }
  };
  // The object browser activates pages and layers and selects objects as the panels and canvas do.
  const browserActions = {
    activatePage: (pageId: number): void => { if (pageId !== page.id) session.setActivePage(pageId); },
    activateLayer: (pageId: number, layerId: number): void => {
      if (pageId !== page.id) session.setActivePage(pageId);
      const current = tab.doc.state, target = current.pages.get(pageId), layer = current.layers.get(layerId);
      if (target && layer && !layer.locked && isLayoutLayerVisible(target, current, layerId) && layerId !== current.activeLayerId)
        runPageCommand('layout.layer.activate', { layerId });
    },
    selectObject: (pageId: number, entityId: number, mode: LayoutBrowserSelectMode, group?: readonly number[]): void => {
      const current = tab.doc.state, target = current.pages.get(pageId);
      const entity = target ? entityOnPage(target, current, entityId) : undefined;
      // Objects on hidden layers cannot be selected; the click only activates their page. An object item selects just that object,
      // even inside a group, and a group item just its members.
      const members = target && entity && isLayoutLayerVisible(target, current, entity.layerId)
        ? group ? group.filter(id => {
          const member = entityOnPage(target, current, id);
          return member && !member.hidden && isLayoutLayerVisible(target, current, member.layerId);
        }) : [entityId] : null;
      // A selecting click switches to Select and ends any open draft or edit, so the selection shows its handles.
      if (members) { chooseTool('select'); setCursor(null); setSnapKind(null); setFreehand([]); }
      if (pageId !== page.id) { pendingPageSelection.current = members; session.setActivePage(pageId); return; }
      if (!members) return;
      // Shift toggles, Ctrl (Cmd) adds and Ctrl+Shift removes; a plain click selects only this object.
      const remove = mode === 'remove' || mode === 'toggle' && members.every(id => selectionIds.includes(id));
      if (mode === 'replace') setSelectionIds(members);
      else setSelectionIds(remove ? selectionIds.filter(id => !members.includes(id)) : [...new Set([...selectionIds, ...members])]);
    },
    rename: (target: LayoutBrowserTarget, name: string): void => {
      try {
        if (target.kind === 'object') tab.commands.execute('layout.shape.rename', { pageId: target.pageId, entityId: target.entityId, name });
        else if (target.kind === 'layer') tab.commands.execute('layout.layer.rename', { layerId: target.layerId, name });
        else if (target.kind === 'page') tab.commands.execute('layout.page.rename', { pageId: target.pageId, name });
      } catch (error) { setVcbError(error instanceof Error ? error.message : 'Could not rename.'); }
    },
    documentSettings: (): void => setSettingsOpen(true),
    // A layer's eye acts on the page it is listed under, like the Layers panel's eye.
    setVisible: (target: LayoutBrowserTarget, visible: boolean): void => {
      if (target.kind === 'layer') browserCommand('layout.layer.setVisible', { pageId: target.pageId, layerId: target.layerId, visible });
      else if (target.kind === 'object') browserCommand('layout.shape.setHidden', { pageId: target.pageId, entityIds: [target.entityId], hidden: !visible });
      else if (target.kind === 'group') browserCommand('layout.shape.setHidden', { pageId: target.pageId, entityIds: target.entityIds, hidden: !visible });
    },
    setLocked: (target: LayoutBrowserTarget, locked: boolean): void => {
      if (target.kind === 'layer') browserCommand('layout.layer.setLocked', { layerId: target.layerId, locked });
      else if (target.kind === 'object') browserCommand('layout.shape.setLocked', { pageId: target.pageId, entityIds: [target.entityId], locked });
      else if (target.kind === 'group') browserCommand('layout.shape.setLocked', { pageId: target.pageId, entityIds: target.entityIds, locked });
    },
    // A dragged object brings along the selection it belongs to, or else its group, as a canvas drag does.
    moveObject: (pageId: number, entityIds: readonly number[], drop: LayoutBrowserDrop, exact = false): void => {
      const current = tab.doc.state, target = current.pages.get(pageId);
      if (!target || !entityIds.length) return;
      // An item inside a group, and a group item, move exactly their objects; an object brings its selection, or else its outer group.
      const moving = exact ? [...entityIds] : pageId === page.id && entityIds.every(id => selectionIds.includes(id)) ? selectionIds
        : entityIds.length > 1 ? [...entityIds] : expandLayoutGroups([...entityIds], target, current);
      if (drop.neighborId !== null && moving.includes(drop.neighborId)) return;
      const destination = current.layers.get(drop.layerId);
      const store = destination?.shared ? { entities: current.sharedEntities, order: current.sharedEntityOrder } : { entities: target.entities, order: target.entityOrder };
      const siblings = store.order.filter(id => store.entities.get(id)?.layerId === drop.layerId && !moving.includes(id));
      const index = drop.neighborId === null ? siblings.length : siblings.indexOf(drop.neighborId) + (drop.side === 'front' ? 1 : 0);
      if (drop.neighborId !== null && !siblings.includes(drop.neighborId)) return;
      browserCommand('layout.shape.arrange', { pageId, entityIds: moving, layerId: drop.layerId, index });
    },
    moveLayer: (layerId: number, toIndex: number): void => { browserCommand('layout.layer.move', { layerId, toIndex }); },
    // Ungroup removes the outer group from all its members on the page, as the context menu's Ungroup does.
    ungroup: (pageId: number, entityIds: readonly number[]): void => {
      const target = tab.doc.state.pages.get(pageId);
      if (target) browserCommand('layout.shape.ungroup', { pageId, entityIds: expandLayoutGroups([...entityIds], target, tab.doc.state) });
    },
    // Delete erases the item's unlocked objects together and drops them from the selection.
    deleteObjects: (pageId: number, entityIds: readonly number[]): void => {
      const current = tab.doc.state, target = current.pages.get(pageId);
      const erasable = target ? entityIds.filter(id => { const entity = entityOnPage(target, current, id); return entity && !objectLocked(entity, current); }) : [];
      if (!erasable.length) return;
      browserCommand('layout.shape.delete', { pageId, entityIds: erasable });
      setSelectionIds(selectionIds.filter(id => !erasable.includes(id)));
    },
    movePage: (pageId: number, toIndex: number): void => { browserCommand('layout.page.move', { pageId, toIndex }); },
    // The page context menu; a new page becomes the active page, as the Pages panel's Add Page does.
    addPageAfter: (pageId: number): void => {
      const added = browserCommand('layout.page.add', { afterId: pageId });
      if (typeof added === 'number') session.setActivePage(added);
    },
    addLayer: (): number | null => {
      const names = new Set([...tab.doc.state.layers.values()].map(layer => layer.name));
      let n = tab.doc.state.layerOrder.length + 1;
      while (names.has(`Layer ${n}`)) n++;
      const added = browserCommand('layout.layer.add', { name: `Layer ${n}` });
      return typeof added === 'number' ? added : null;
    },
    duplicatePage: (pageId: number): void => {
      const added = browserCommand('layout.page.duplicate', { pageId });
      if (typeof added === 'number') session.setActivePage(added);
    },
    duplicateLayer: (layerId: number): number | null => {
      const added = browserCommand('layout.layer.duplicate', { layerId });
      return typeof added === 'number' ? added : null;
    },
    // Sharing a layer whose objects sit on other pages first asks which objects to share.
    setShared: (pageId: number, layerId: number, shared: boolean): void => {
      const current = tab.doc.state;
      if (shared && [...current.pages.values()].some(target => target.id !== pageId && [...target.entities.values()].some(entity => entity.layerId === layerId))) {
        setLayerScopeChoice({ layerId, pageId }); return;
      }
      browserCommand('layout.layer.setShared', { pageId, layerId, shared });
    },
    deleteLayer: (layerId: number): void => { browserCommand('layout.layer.delete', { layerId }); },
    deletePage: (pageId: number): void => {
      const order = tab.doc.state.pageOrder, index = order.indexOf(pageId);
      const next = order[index + 1] ?? order[index - 1];
      if (next === undefined) return;
      browserCommand('layout.page.delete', { pageId });
      if (pageId === page.id && !tab.doc.state.pages.has(pageId)) session.setActivePage(next);
    },
  };
  const browserActionsRef = useRef(browserActions);
  browserActionsRef.current = browserActions;
  // Stable callbacks keep the memoized browser from re-rendering on every pointer move.
  const browserCallbacks = useMemo(() => ({
    onActivatePage: (pageId: number) => browserActionsRef.current.activatePage(pageId),
    onActivateLayer: (pageId: number, layerId: number) => browserActionsRef.current.activateLayer(pageId, layerId),
    onSelectObject: (pageId: number, entityId: number, mode: LayoutBrowserSelectMode) => browserActionsRef.current.selectObject(pageId, entityId, mode),
    onRename: (target: LayoutBrowserTarget, name: string) => browserActionsRef.current.rename(target, name),
    onDocumentSettings: () => browserActionsRef.current.documentSettings(),
    onSetVisible: (target: LayoutBrowserTarget, visible: boolean) => browserActionsRef.current.setVisible(target, visible),
    onSetLocked: (target: LayoutBrowserTarget, locked: boolean) => browserActionsRef.current.setLocked(target, locked),
    onMoveObject: (pageId: number, entityIds: readonly number[], drop: LayoutBrowserDrop, exact?: boolean) =>
      browserActionsRef.current.moveObject(pageId, entityIds, drop, exact),
    onSelectGroup: (pageId: number, entityIds: readonly number[], mode: LayoutBrowserSelectMode) =>
      browserActionsRef.current.selectObject(pageId, entityIds[0]!, mode, entityIds),
    onUngroup: (pageId: number, entityIds: readonly number[]) => browserActionsRef.current.ungroup(pageId, entityIds),
    onDeleteObjects: (pageId: number, entityIds: readonly number[]) => browserActionsRef.current.deleteObjects(pageId, entityIds),
    onMoveLayer: (layerId: number, toIndex: number) => browserActionsRef.current.moveLayer(layerId, toIndex),
    onMovePage: (pageId: number, toIndex: number) => browserActionsRef.current.movePage(pageId, toIndex),
    onAddPageAfter: (pageId: number) => browserActionsRef.current.addPageAfter(pageId),
    onAddLayer: () => browserActionsRef.current.addLayer(),
    onDeletePage: (pageId: number) => browserActionsRef.current.deletePage(pageId),
    onDuplicatePage: (pageId: number) => browserActionsRef.current.duplicatePage(pageId),
    onDuplicateLayer: (layerId: number) => browserActionsRef.current.duplicateLayer(layerId),
    onSetShared: (pageId: number, layerId: number, shared: boolean) => browserActionsRef.current.setShared(pageId, layerId, shared),
    onDeleteLayer: (layerId: number) => browserActionsRef.current.deleteLayer(layerId),
  }), []);

  type ScaleModifiers = { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean };
  // Alt resizes about the object's center instead of the opposite handle.
  const scalePivot = (drag: ScaleDrag, altKey: boolean): Point => altKey ? drag.center : drag.pivot;
  const scaleFactors = (drag: ScaleDrag, event: ScaleModifiers): Point => {
    const pivot = scalePivot(drag, event.altKey);
    const raw = rawPointFromEvent({ ...event, currentTarget: canvasRef.current! });
    const down = rawPointFromEvent({ currentTarget: canvasRef.current!, clientX: drag.x, clientY: drag.y });
    const entity = entityOnPage(page, tab.doc.state, drag.entityId);
    const delta = rotateLayoutPoint([raw[0] - down[0], raw[1] - down[1]], [0, 0], -((entity?.image || entity?.table) ? imageFrame(entity.points).angle : entity?.text?.rotationDeg ?? 0));
    const point: Point = [drag.start[0] + delta[0], drag.start[1] + delta[1]];
    let sx = drag.scaleX ? Math.max(0.01, (point[0] - pivot[0]) / (drag.start[0] - pivot[0])) : 1;
    let sy = drag.scaleY ? Math.max(0.01, (point[1] - pivot[1]) / (drag.start[1] - pivot[1])) : 1;
    if (event.shiftKey) sx = sy = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
    return [sx, sy];
  };
  const scaledPoints = (drag: ScaleDrag, sx: number, sy: number, pivot: Point): Point[] => {
    const transform = ([x, y]: Point): Point => [pivot[0] + (x - pivot[0]) * sx, pivot[1] + (y - pivot[1]) * sy];
    const entity = entityOnPage(page, tab.doc.state, drag.entityId);
    if (entity?.image || entity?.table) {
      const frame = imageFrame(drag.points);
      return drag.points.map(point => rotateLayoutPoint(transform(rotateLayoutPoint(point, frame.center, -frame.angle)), frame.center, frame.angle));
    }
    if (!entity?.text) return drag.points.map(transform);
    const [a, b] = drag.points.slice(0, 2).map(transform) as [Point, Point];
    const height = Math.abs(b[1] - a[1]), centerY = (drag.points[0]![1] + drag.points[1]![1]) / 2;
    return [[Math.min(a[0], b[0]), entity.kind === 'label' ? centerY - height / 2 : Math.min(a[1], b[1])],
      [Math.max(a[0], b[0]), entity.kind === 'label' ? centerY + height / 2 : Math.max(a[1], b[1])], ...drag.points.slice(2)];
  };
  const updateScalePreview = (event: ScaleModifiers): void => {
    const drag = scaleStart.current;
    if (!drag) return;
    drag.pointer = { clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey, altKey: event.altKey };
    const [sx, sy] = scaleFactors(drag, event);
    const pivot = scalePivot(drag, event.altKey);
    const transform = ([x, y]: Point): Point => [pivot[0] + (x - pivot[0]) * sx, pivot[1] + (y - pivot[1]) * sy];
    setScalePreview({ entityId: drag.entityId, activeIndex: null, showVertices: false, resizeViewport: true,
      points: (() => { const points = scaledPoints(drag, sx, sy, pivot); const entity = entityOnPage(page, tab.doc.state, drag.entityId);
        return entity?.text ? resizeLayoutTextPoints(entity, points.slice(0, 2)) : points; })(), handles: drag.handles.map((h) => ({
        ...(h.in ? { in: transform(h.in) } : {}), ...(h.out ? { out: transform(h.out) } : {}),
      })) });
  };
  useEffect(() => {
    const onShift = (event: KeyboardEvent) => {
      const drag = scaleStart.current;
      if ((event.key !== 'Shift' && event.key !== 'Alt') || !drag) return;
      // Keep Alt from focusing the browser menu bar mid-drag.
      if (event.key === 'Alt') event.preventDefault();
      // Apply the constraint immediately even when the pointer is stationary.
      updateScalePreview({ ...drag.pointer, shiftKey: event.shiftKey, altKey: event.altKey });
    };
    window.addEventListener('keydown', onShift);
    window.addEventListener('keyup', onShift);
    return () => {
      window.removeEventListener('keydown', onShift);
      window.removeEventListener('keyup', onShift);
    };
  }, [tab, page]);
  const getTextSelection = () => (inlineTextRef.current && getLayoutTextSelection(inlineTextRef.current)) ?? textSelectionRef.current;
  const returnToText = (): void => {
    const editor = inlineTextRef.current;
    if (!editor) return;
    const range = getTextSelection();
    editor.focus(); setLayoutTextSelection(editor, range.start, range.end); setTextSelection(range);
  };
  const formatEditingText = (patch: Partial<NonNullable<LayoutEntity['text']>>, returnFocus = true): void => {
    if (!editingText?.text || !canTransform) return;
    setTextSelection(getTextSelection());
    // Native color pickers emit both live input and a final change for the same value.
    if (Object.entries(patch).some(([key, value]) => JSON.stringify(editingText.text![key as keyof typeof editingText.text]) !== JSON.stringify(value)))
      tab.commands.execute('layout.text.update', { pageId: page.id, entityId: editingText.id, text: patch });
    if (returnFocus) returnToText();
  };
  const chooseTool = (id: LayoutTool): void => {
    if (id === 'shape-builder' && !shapeBuilder.start(selectionIds)) return;
    setBooleanIds([]);
    if (booleanOperation(id) || booleanOperation(tool)) setSelectionIds([]);
    if (navigatingViewportRef.current !== null) endViewportNavigation();
    setTableCellsActive(false); setTableResizePreview(null); setImportNote(null);
    setDimensionDraft(null); setAngularEdgeFirst(null); setDimensionError(null); setArcDraft(null); setArcError(null); setOffsetDraft(null); setCornerFirst(null); setCornerHover(null); setRotationDraft(null); setLabelDraft(null); setTool(id); setAnchor(null); setVcbError(null);
    setEditingTextId(null);
    scaleStart.current = null; setScalePreview(null);
    setMoveDraft(null); setMovePreview(null);
    setEditingPathId(null); setEditPoints(null); setEditHandles(null); setActivePointIndex(null);
  };
  useEffect(() => () => { imageImportRequest.current++; setImportNote(null); }, [tab, page.id]);
  const openImageImport = (): void => {
    const layer = tab.doc.state.layers.get(tab.doc.state.activeLayerId);
    if (!layer || !isLayoutLayerVisible(page, state, layer.id) || layer.locked) { setVcbError('Choose a visible, unlocked layer before importing.'); return; }
    const input = imageImportInput.current;
    if (input) { input.value = ''; input.click(); }
  };
  const importImageFile = async (file: File): Promise<void> => {
    const request = ++imageImportRequest.current;
    setVcbError(null);
    try {
      if (isDxfFile(file.name)) {
        // A DXF drawing becomes native objects in one group at a standard scale that fits the page.
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (request !== imageImportRequest.current) return;
        const drawing = dxfLayoutEntities(bytes, page.size);
        const ids = tab.commands.execute('layout.dxf.import', { pageId: page.id, entities: drawing.entities }) as number[];
        chooseTool('select'); setSelectionIds(ids); setCursor(null); setSnapKind(null); setFreehand([]);
        const unit = drawing.unitRecorded ? '' : ` The drawing does not record its units; it is read in ${drawing.unit === 'in' ? 'inches' : 'millimeters'}.`;
        setImportNote([`Imported ${file.name} at 1:${drawing.scale}.${unit}`, ...drawing.warnings].join(' '));
        return;
      }
      const entity = await layoutClipboardImage(file, page);
      if (request !== imageImportRequest.current) return;
      const ids = tab.commands.execute('layout.clipboard.paste', { pageId: page.id, entities: [entity] }) as number[];
      chooseTool('select'); setSelectionIds(ids); setCursor(null); setSnapKind(null); setFreehand([]);
    } catch (error) {
      if (request === imageImportRequest.current) setVcbError(error instanceof Error ? error.message : `Could not import this ${isDxfFile(file.name) ? 'drawing' : 'image'}.`);
    }
  };
  // Keep workspace commands bound to the latest page and content while mounted.
  const chooseToolRef = useRef(chooseTool);
  chooseToolRef.current = chooseTool;
  // The Add Layer command adds a layer as the object browser's context menu does.
  const addLayerRef = useRef(() => { browserActionsRef.current.addLayer(); });
  const zoomActionsRef = useRef({ zoomToPage: fitPage, fitContent });
  zoomActionsRef.current = { zoomToPage: fitPage, fitContent };
  const openImageImportRef = useRef(openImageImport);
  openImageImportRef.current = openImageImport;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  useEffect(() => {
    const ctx = tab.commands.ctx;
    ctx.tools = {
      activate: (id) => chooseToolRef.current(id as LayoutTool),
      get activeToolId() { return toolRef.current; },
    };
    ctx.services.set(SERVICE_LAYOUT_WORKSPACE, {
      present: () => setPresenting(true), print: () => setPrinting(true), exportImage: () => setExportingImage(true),
      importImage: () => openImageImportRef.current(),
      documentSettings: () => setSettingsOpen(true),
      zoomToPage: () => zoomActionsRef.current.zoomToPage(),
      fitContent: () => zoomActionsRef.current.fitContent(),
      addLayer: () => addLayerRef.current(),
    } satisfies LayoutWorkspaceHost);
    return () => {
      ctx.tools = undefined;
      ctx.services.delete(SERVICE_LAYOUT_WORKSPACE);
    };
  }, [tab]);
  const activeToolTitle = editingText?.text && canTransform
    ? editingText.kind === 'label' ? 'Label' : 'Text'
    : LAYOUT_TOOLS.find(item => item.id === polygonTool)?.title ?? 'Tool';
  const showToolPane = Boolean(booleanOperation(tool) || tool === 'shape-builder' || tool === 'table' ||
    tool === 'viewport' && (viewportSources.length > 0 || cloudApi) || isLayoutCornerTool(tool) || isPolygonTool(tool) ||
    tool === 'rounded-rectangle' || tool === 'bulged-rectangle' || editingText?.text && canTransform);
  return (
    <>
      {contextMenu ? <LayoutContextMenu x={contextMenu.x} y={contextMenu.y} items={contextItems} onClose={() => { setContextMenu(null); canvasRef.current?.focus(); }} /> : null}
      {printing ? <LayoutPrintDialog state={state} activePageId={page.id} title={tab.name} paint={paintPrintPage}
        imageVersion={imageLoads} onClose={() => setPrinting(false)} /> : null}
      {exportingImage ? <LayoutExportDialog state={state} activePageId={page.id} documentName={tab.name} paint={paintPrintPage}
        onClose={() => setExportingImage(false)} /> : null}
      {presenting ? <LayoutPresentation tab={tab} onClose={() => setPresenting(false)} /> : null}
      {settingsOpen ? <LayoutDocumentSettingsDialog state={state} onCommand={browserCommand} onClose={() => setSettingsOpen(false)} /> : null}
      {objectBrowser?.open && objectBrowser.host ? createPortal(<LayoutObjectBrowser state={state} activePageId={page.id} selectionIds={selectionIds}
        {...browserCallbacks} onPinModel={(referenceId, pinned) => tab.commands.execute('layout.reference.pin', { referenceId, pinned })}
        view={tab.workspace.browserView} onViewChange={view => { tab.workspace.browserView = view; }}
        onClose={objectBrowser.onClose} />, objectBrowser.host) : null}
      {layerScopeChoice ? <LayoutLayerScopeDialog onCancel={() => setLayerScopeChoice(null)} onApply={(source) => {
        try { runPageCommand('layout.layer.setShared', { ...layerScopeChoice, shared: true, source }); }
        catch (error) { setVcbError(error instanceof Error ? error.message : String(error)); }
        setLayerScopeChoice(null);
      }} /> : null}
          {choosingModel && cloudApi ? <LayoutCloudModelPicker api={cloudApi} onClose={() => setChoosingModel(false)} onPick={file => {
            setChoosingModel(false);
            linkCloudModel(tab, cloudApi, file).then(referenceId => { setViewportSourceKey(`reference:${referenceId}`); chooseTool('viewport'); },
              error => setVcbError(error instanceof Error ? error.message : 'The model could not be linked.'));
          }} /> : null}
        <nav className="pf-toolbar pf-layout-ribbon" data-orientation="horizontal" aria-label="Layout tools">
          {TOOL_GROUPS.map(group => <div key={group.title} className="pf-layout-ribbon-group" role="group" aria-label={group.title}>
            <div className="pf-layout-ribbon-buttons">
          {group.tools.map(id => TOOLS.find(item => item.id === id)!).map((item) => item.id === 'select' ? (
            <ToolStack key={item.id} title="Select" tools={SELECT_TOOLS} activeId={tool}
              onSelect={(id) => chooseTool(id as LayoutTool)} />
          ) : item.id === 'boolean-union' ? (
            <ToolStack key={item.id} title="Boolean" tools={BOOLEAN_TOOLS} activeId={tool}
              onSelect={id => chooseTool(id as LayoutTool)} />
          ) : item.id === 'dimension' ? (
            <ToolStack key={item.id} title="Dimension" tools={DIMENSION_TOOLS} activeId={tool}
              onSelect={(id) => chooseTool(id as LayoutTool)} />
          ) : item.id === 'fillet' ? (
            <ToolStack key={item.id} title="Fillet / Chamfer" tools={CORNER_TOOLS} activeId={tool}
              onSelect={(id) => chooseTool(id as LayoutTool)} />
          ) : item.id === 'line' ? (
            <ToolStack key={item.id} title="Line" tools={LINE_TOOLS} activeId={tool}
              onSelect={(id) => chooseTool(id as LayoutTool)} />
          ) : item.id === 'arc' ? (
            <ToolStack key={item.id} title="Arc" tools={ARC_TOOLS} activeId={tool}
              onSelect={(id) => chooseTool(id as LayoutTool)} />
          ) : item.id === 'circle' ? (
            <ToolStack key={item.id} title="Circle" tools={CIRCLE_TOOLS} activeId={tool}
              onSelect={(id) => chooseTool(id as LayoutTool)} />
          ) : item.id === 'rectangle' ? (
            <ToolStack key={item.id} title="Rectangle" tools={RECTANGLE_TOOLS} activeId={tool}
              onSelect={(id) => chooseTool(id as LayoutTool)} />
          ) : item.id === 'polygon' ? (
            <ToolStack key={item.id} title="Polygon" tools={POLYGON_TOOLS} activeId={polygonTool}
              onSelect={(id) => chooseTool(id as LayoutTool)} />
          ) : (
            <ToolButton
              key={item.id}
              data-guidance-id={`toolbar:${item.id}`}
              type="button"
              className={`pf-toolbtn${tool === item.id ? ' is-active' : ''}`}
              title={item.key ? `${item.title} (${item.key})` : item.title}
              aria-label={item.title}
              aria-pressed={tool === item.id}
              onClick={() => chooseTool(item.id)}
            >
              <Icon name={`tool-${item.id}`} size={24} />
            </ToolButton>
          ))}
          {group.title === 'Insert' ? <>
          <ToolButton type="button" className="pf-toolbtn" title="Import" aria-label="Import"
            data-guidance-id="toolbar:import" data-guidance-action="layout.import" data-guidance-route="Toolbar > Insert > Import"
            onClick={() => tab.commands.execute('layout.import')}><Icon name="image" size={24} /></ToolButton>
          <ToolButton type="button" className={`pf-toolbtn${tool === 'viewport' ? ' is-active' : ''}`} aria-label="Model View" aria-pressed={tool === 'viewport'}
            title={viewportSources.length || cloudApi ? 'Model View' : 'Model View: import a LayOut document with an embedded SketchUp model to add views of it'}
            disabled={!viewportSources.length && !cloudApi}
            onClick={() => { if (!viewportSources.length) setChoosingModel(true); else chooseTool('viewport'); }}><Icon name="tool-viewport" size={24} /></ToolButton>
          </> : null}
            </div>
            <span className="pf-layout-ribbon-caption" aria-hidden="true">{group.title}</span>
          </div>)}
          <div className="pf-layout-ribbon-group pf-layout-ribbon-present" role="group" aria-label="Present">
            <div className="pf-layout-ribbon-buttons">
          <ToolButton type="button" className="pf-toolbtn pf-layout-present-button" title="Presentation mode" aria-label="Presentation mode"
            onClick={() => setPresenting(true)}><Icon name="presentation" size={24} /></ToolButton>
            </div>
            <span className="pf-layout-ribbon-caption" aria-hidden="true">Present</span>
          </div>
        </nav>
      <div className="pf-layout-main">
        {leading}
        <div className="pf-layout-workspace-frame">
        <canvas ref={surroundRef} className="pf-layout-surround" aria-hidden="true" />
        <main ref={workspaceRef} className="pf-layout-workspace" aria-label="Layout workspace" onContextMenu={openContextMenu}
          data-tool={polygonTool} style={pageCursor}
          onPointerDown={offPage(onPointerDown)} onPointerMove={offPage(onPointerMove)} onPointerUp={offPage(onPointerUp)}
          onDoubleClick={offPage(onDoubleClick)}>
          <div className="pf-layout-page-wrap" style={{ width: page.size[0] * PX_PER_MM * zoom }}>
          {tool === 'shape-builder' ? <LayoutShapeBuilderPreview builder={shapeBuilder} size={page.size} defaultStyle={state.defaultStyle} /> : null}
          {booleanPreview?.shapes.length ? <svg className="pf-layout-boolean-preview" aria-label="Boolean result preview" viewBox={`0 0 ${page.size[0]} ${page.size[1]}`}>
            {booleanPreview.shapes.map((shape, index) => <path key={index} style={tool === 'boolean-cut-path' || !shape.closed ? { fill: 'none' } : undefined}
              d={layoutPathContours(shape.points, shape.handles, shape.closed, shape.contourStarts).map(contour => {
                let d = `M${contour.points[0]!.join(',')}`;
                for (let i = 0; i < contour.points.length - (contour.closed ? 0 : 1); i++) {
                  const s = pathSegment(contour.points, contour.handles, i, contour.closed);
                  d += s.curved ? `C${s.c1.join(',')} ${s.c2.join(',')} ${s.b.join(',')}` : `L${s.b.join(',')}`;
                }
                return d + (contour.closed ? 'Z' : '');
              }).join(' ')} fillRule="evenodd" />)}
          </svg> : null}
          {tool === 'line' && lineGuide && cursor ? <LayoutAlignmentGuide axis={lineGuide.axis}
            from={[lineGuide.reference[0] * PX_PER_MM * zoom, lineGuide.reference[1] * PX_PER_MM * zoom]}
            to={[cursor[0] * PX_PER_MM * zoom, cursor[1] * PX_PER_MM * zoom]} /> : null}
          {cursor && tool !== 'select' && tool !== 'scale' && !booleanOperation(tool) ? <LayoutPlacementMarker snapKind={snapKind} x={cursor[0] * PX_PER_MM * zoom} y={cursor[1] * PX_PER_MM * zoom} /> : null}
          {snapKind && snapKind !== 'grid' && cursor && tool !== 'select' && tool !== 'scale' && !presenting && !printing && !contextMenu && editingTextId === null &&
              state.settings.objectSnap !== false ? <LayoutSnapTooltip
            key={`${page.id}:${tool}:${snapHoverEpoch}:${snapType}:${cursor[0]}:${cursor[1]}`}
            type={snapType ?? snapKind} x={cursor[0] * PX_PER_MM * zoom} y={cursor[1] * PX_PER_MM * zoom}
            pageWidth={page.size[0] * PX_PER_MM * zoom} pageHeight={page.size[1] * PX_PER_MM * zoom} /> : null}
          {activeRotation?.reference && cursor ? <output className="pf-layout-rotation-angle" aria-label="Rotation angle preview"
            style={{ left: Math.max(0, Math.min(page.size[0] * PX_PER_MM * zoom - 90, cursor[0] * PX_PER_MM * zoom + 14)),
              top: Math.max(0, Math.min(page.size[1] * PX_PER_MM * zoom - 28, cursor[1] * PX_PER_MM * zoom + 14)) }}>
            {activeRotation.angleDeg.toFixed(1)}°
          </output> : null}
          {/* Columns x rows follow the pointer while the button is held. */}
          {tool === 'table' && tableCounting && anchor && cursor && (cursor[0] !== anchor[0] || cursor[1] !== anchor[1])
            ? <output className="pf-layout-rotation-angle" aria-label="Table size preview"
              style={{ left: Math.max(0, Math.min(page.size[0] * PX_PER_MM * zoom - 80, cursor[0] * PX_PER_MM * zoom + 14)),
                top: Math.max(0, Math.min(page.size[1] * PX_PER_MM * zoom - 28, cursor[1] * PX_PER_MM * zoom + 14)) }}>
              {`${tableColumns} x ${tableRows}`}
            </output> : null}
          {/* The readout gives the move's x, y offsets, positive x right and positive y down, as typed in. */}
          {tool === 'move' && moveDraft && cursor ? <output className="pf-layout-rotation-angle" aria-label="Move offset preview"
            style={{ left: Math.max(0, Math.min(page.size[0] * PX_PER_MM * zoom - 160, cursor[0] * PX_PER_MM * zoom + 14)),
              top: Math.max(0, Math.min(page.size[1] * PX_PER_MM * zoom - 28, cursor[1] * PX_PER_MM * zoom + 14)) }}>
            {moveDraft.copy ? 'Copy ' : ''}{(movePreview?.delta ?? [0, 0]).map((offset) => formatLayoutLength(offset / 25.4, {
              units: state.settings.units === 'mm' ? 'mm' : 'inch', format: state.settings.units === 'architectural' ? 'architectural' : 'decimal',
              precision: state.settings.precision, showUnits: true })).join(', ')}
          </output> : null}
          {angularPreview && cursor ? <output className="pf-layout-rotation-angle" aria-label="Angular dimension preview"
            style={{ left: Math.max(0, Math.min(page.size[0] * PX_PER_MM * zoom - 90, cursor[0] * PX_PER_MM * zoom + 14)),
              top: Math.max(0, Math.min(page.size[1] * PX_PER_MM * zoom - 28, cursor[1] * PX_PER_MM * zoom + 14)) }}>{angularPreview}</output> : null}
          <canvas
            ref={canvasRef}
            tabIndex={-1}
            className="pf-layout-page"
            data-tool={polygonTool}
            style={pageCursor}
            aria-label={`${page.name} canvas`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={onDoubleClick}
            onPointerCancel={() => {
              if (tool === 'shape-builder') { shapeBuilder.cancelPointer(); return; }
              if (tableDrag.current) setTableSelection(tableDrag.current);
              tableDrag.current = null;
              if (booleanOperation(tool)) { setBooleanIds([]); setSelectionIds([]); }
              setDimensionDraft(null); setAngularEdgeFirst(null); setDimensionError(null); setArcDraft(null); setArcError(null); setOffsetDraft(null); setCornerFirst(null); setCornerHover(null); setRotationDraft(null); setLabelDraft(null);
              pointerDown.current = null;
              moveStart.current = null;
              boxStart.current = null; setBoxSelect(null);
              lassoPress.current = null; if (lasso?.freehand) setLasso(null);
              pointEditStart.current = null;
              setMovePreview(null); setMoveDraft(null);
              setEditPoints(null);
              setEditHandles(null);
              setAnchor(null);
              setSnapKind(null);
              setFreehand([]);
            }}
            onLostPointerCapture={() => { if (tool === 'shape-builder') shapeBuilder.cancelPointer(); }}
            onPointerLeave={() => { setSnapKind(null); if (tool === 'shape-builder') shapeBuilder.leave(); }}
          />
          {tableCellsActive && tool === 'select' && selectedEntity?.table && selectedEntity.groupId === undefined && canTransform && !presenting && !printing && !scalePreview && !movePreview ? <LayoutTableGrid key={`${page.id}:${selectedEntity.id}`} entity={tableResizePreview?.id === selectedEntity.id ? tableResizePreview : selectedEntity} selection={tableSelection} pixelsPerMm={PX_PER_MM * zoom}
            onCommitRich={(cell, text) => {
              const current = entityOnPage(tab.doc.state.pages.get(page.id)!, tab.doc.state, selectedEntity.id);
              if (!current?.table || objectLocked(current, tab.doc.state)) return;
              const table = cloneLayoutTable(current.table), target = table.cells[cell.row * table.columns.length + cell.column];
              if (!target) return;
              Object.assign(target.text, text);
              tab.commands.execute('layout.table.update', { pageId: page.id, entityId: current.id, table });
            }}
            editRequest={tableEditRequest} onSelect={setTableSelection} onExit={() => { setTableCellsActive(false); setTableEditRequest(0); }}
            onResizePreview={setTableResizePreview} onResize={(axis, index, sizeMm) => {
              const current = entityOnPage(tab.doc.state.pages.get(page.id)!, tab.doc.state, selectedEntity.id);
              if (!current?.table || objectLocked(current, tab.doc.state)) return;
              const resized = resizeTableAxis(current, axis, index, sizeMm), frame = tableFrame(resized);
              tab.commands.execute('layout.table.update', { pageId: page.id, entityId: current.id, table: resized.table, widthMm: frame.width, heightMm: frame.height });
            }}
            pointFromClient={(clientX, clientY) => rawPointFromEvent({ currentTarget: canvasRef.current!, clientX, clientY })}
            onCommit={(cell, value) => updateTableCellText([cell], value)} onClear={cells => updateTableCellText(cells, '')} /> : null}
          {selectionBounds && selectedEntity ? <div className="pf-layout-selection-box" aria-label="Selected object bounds"
            style={{ left: `${selectionBounds.minX / page.size[0] * 100}%`, top: `${selectionBounds.minY / page.size[1] * 100}%`,
              width: `${selectionBounds.width / page.size[0] * 100}%`, height: `${selectionBounds.height / page.size[1] * 100}%`, ...gripBoxTransform(selectionBounds) }}>
            {SCALE_HANDLES.filter((handle) => selectionBounds.width < 1e-6 ? handle.x === 0.5
              : selectionBounds.height < 1e-6 ? handle.y === 0.5 : true).map((handle) => <button
                key={handle.name} type="button" className="pf-layout-scale-handle" aria-label={`${selectedEntity.text ? 'Resize text' : selectedEntity.image ? 'Resize image' : 'Scale'} ${handle.name}`} title={`${selectedEntity.text ? 'Resize text' : selectedEntity.image ? 'Resize image' : 'Scale'} ${handle.name}`}
                style={{ left: `${handle.x * 100}%`, top: `${handle.y * 100}%`, cursor: handle.cursor }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault(); event.stopPropagation();
                  const pivot: Point = [selectionBounds.minX + (1 - handle.x) * selectionBounds.width,
                    selectionBounds.minY + (1 - handle.y) * selectionBounds.height];
                  const center: Point = [selectionBounds.minX + selectionBounds.width / 2, selectionBounds.minY + selectionBounds.height / 2];
                  scaleStart.current = { entityId: selectedEntity.id, points: selectedEntity.points.map((p) => [...p]),
                    handles: copyHandles(selectedEntity.handles, selectedEntity.points.length), pivot, center,
                    start: [selectionBounds.minX + handle.x * selectionBounds.width, selectionBounds.minY + handle.y * selectionBounds.height],
                    scaleX: handle.x !== 0.5 && selectionBounds.width > 1e-6, scaleY: handle.y !== 0.5 && selectionBounds.height > 1e-6,
                    x: event.clientX, y: event.clientY, pointer: { clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey, altKey: event.altKey } };
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                }}
                onPointerMove={updateScalePreview}
                onPointerUp={(event) => {
                  const drag = scaleStart.current; scaleStart.current = null; setScalePreview(null);
                  if (!drag || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 2) return;
                  const [scaleX, scaleY] = scaleFactors(drag, event), pivot = scalePivot(drag, event.altKey);
                  if (selectedEntity.text) tab.commands.execute('layout.text.setBounds', {
                    pageId: page.id, entityId: drag.entityId, bounds: scaledPoints(drag, scaleX, scaleY, pivot).slice(0, 2),
                  });
                  else tab.commands.execute('layout.shape.scale', { pageId: page.id, entityId: drag.entityId,
                    pivot: (selectedEntity.image || selectedEntity.table) ? rotateLayoutPoint(pivot, imageFrame(drag.points).center, imageFrame(drag.points).angle) : pivot, scaleX, scaleY });
                }}
                onPointerCancel={() => { scaleStart.current = null; setScalePreview(null); }}
                onDoubleClick={(event) => { event.stopPropagation(); scaleStart.current = null; setScalePreview(null); if (selectedEntity.text) setEditingTextId(selectedEntity.id); else if (selectedEntity.kind === 'path') setEditingPathId(selectedEntity.id); }}
              />)}
            {tool !== 'scale' && selectedEntity.kind !== 'label' && !(selectedEntity.table && tableCellsActive) && !scalePreview && !movePreview ? (() => {
              // The center of rotation, its arm and the rotation handle.
              const { u, v } = gripFraction(selectedEntity), box = selectionBounds;
              return <div className="pf-layout-rotation-grip" style={{ left: `${u * 100}%`, top: `${v * 100}%` }}>
                <span className="pf-layout-rotation-arm" style={{ width: ROTATION_ARM_PX }} />
                <button type="button" className="pf-layout-rotation-center" aria-label="Center of rotation" title="Center of rotation"
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault(); event.stopPropagation();
                    gripDrag.current = 'center'; event.currentTarget.setPointerCapture?.(event.pointerId);
                  }}
                  onPointerMove={(event) => { if (gripDrag.current === 'center') moveGripCenter(selectedEntity, box, gripPoint(event)); }}
                  onPointerUp={() => { gripDrag.current = null; }}
                  onPointerCancel={() => { gripDrag.current = null; }} />
                <button type="button" className="pf-layout-rotation-handle" aria-label="Rotation handle" title="Drag to rotate"
                  style={{ left: ROTATION_ARM_PX }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault(); event.stopPropagation();
                    gripDrag.current = 'rotate'; event.currentTarget.setPointerCapture?.(event.pointerId);
                    startGripRotation(selectedEntity, box);
                  }}
                  onPointerMove={(event) => { if (gripDrag.current === 'rotate') updateGripRotation(gripPoint(event)); }}
                  onPointerUp={() => { if (gripDrag.current !== 'rotate') return; gripDrag.current = null; finishGripRotation(); }}
                  onPointerCancel={() => { gripDrag.current = null; setGripRotation(null); setCursor(null); }} />
              </div>;
            })() : null}
          </div> : null}
          {tool === 'select' && selectionIds.length > 1 && editingTextId === null ? (() => {
            // One dashed outline, without handles, around the drawn extent of every selected object.
            const boxes = selectionIds.map((id) => {
              const entity = entityOnPage(page, state, id);
              const bounds = entity && isLayoutLayerVisible(page, state, entity.layerId) ? layoutEntityBounds(entity) : null;
              if (!bounds || !movePreview?.entityIds.has(id) || movePreview.copy) return bounds;
              return { minX: bounds.minX + movePreview.delta[0], minY: bounds.minY + movePreview.delta[1],
                maxX: bounds.maxX + movePreview.delta[0], maxY: bounds.maxY + movePreview.delta[1] };
            }).filter((bounds): bounds is NonNullable<typeof bounds> => bounds !== null);
            if (boxes.length === 0) return null;
            const minX = Math.min(...boxes.map((b) => b.minX)), minY = Math.min(...boxes.map((b) => b.minY));
            const maxX = Math.max(...boxes.map((b) => b.maxX)), maxY = Math.max(...boxes.map((b) => b.maxY));
            return <div className="pf-layout-selection-box" aria-label="Selected objects bounds"
              style={{ left: `${minX / page.size[0] * 100}%`, top: `${minY / page.size[1] * 100}%`,
                width: `${(maxX - minX) / page.size[0] * 100}%`, height: `${(maxY - minY) / page.size[1] * 100}%` }} />;
          })() : null}
          {boxSelect ? <div className="pf-layout-marquee" aria-label="Selection box" data-mode={boxSelect.to[0] < boxSelect.from[0] ? 'crossing' : 'window'}
            style={{ left: `${Math.min(boxSelect.from[0], boxSelect.to[0]) / page.size[0] * 100}%`, top: `${Math.min(boxSelect.from[1], boxSelect.to[1]) / page.size[1] * 100}%`,
              width: `${Math.abs(boxSelect.to[0] - boxSelect.from[0]) / page.size[0] * 100}%`, height: `${Math.abs(boxSelect.to[1] - boxSelect.from[1]) / page.size[1] * 100}%` }} /> : null}
          {lasso ? (() => {
            // A clicked outline runs on to the pointer and back to its first point; dashed while clockwise.
            const outline = !lasso.freehand && lasso.cursor ? [...lasso.points, lasso.cursor] : lasso.points;
            return <svg className="pf-layout-lasso" aria-label="Lasso outline" data-mode={lassoIsCrossing(outline) ? 'crossing' : 'window'}
              viewBox={`0 0 ${page.size[0]} ${page.size[1]}`} preserveAspectRatio="none">
              <polygon points={outline.map(([x, y]) => `${x},${y}`).join(' ')} />
            </svg>;
          })() : null}
          {editingText?.text && canTransform && editingText.id === selectedEntity?.id ? (() => {
            const [a, b] = inlineEditingText?.points ?? editingText.points;
            if (!a || !b) return null;
            const text = editingText.text;
            return <InlineLayoutTextEditor
              ref={inlineTextRef}
              label={`Edit ${editingText.kind === 'label' ? 'label' : 'text'} on page`}
              text={text} pixelsPerMm={PX_PER_MM * zoom}
              autoTextTags={[...new Set([...LAYOUT_AUTO_TEXT_TAGS, ...LAYOUT_ACCOUNT_TAGS, ...Object.keys(layoutModelFields(editingText) ?? {}), ...state.customFields.keys(), ...state.pageNumberFields?.keys() ?? []])]}
              style={{
                left: `${Math.min(a[0], b[0]) / page.size[0] * 100}%`,
                top: `${Math.min(a[1], b[1]) / page.size[1] * 100}%`,
                width: `${Math.abs(b[0] - a[0]) / page.size[0] * 100}%`,
                height: `${Math.abs(b[1] - a[1]) / page.size[1] * 100}%`,
                transform: `rotate(${text.rotationDeg ?? 0}deg)`,
                transformOrigin: `${Math.abs(b[0] - a[0]) * PX_PER_MM * zoom / 2}px ${Math.abs(b[1] - a[1]) * PX_PER_MM * zoom / 2}px`,
                fontFamily: text.fontFamily,
                paddingTop: `${inlineTextPaddingMm * PX_PER_MM * zoom}px`,
                // The editor sets lines where the page does.
                paddingLeft: `${layoutTextInset(Math.abs(b[0] - a[0])) * PX_PER_MM * zoom}px`,
                paddingRight: `${layoutTextInset(Math.abs(b[0] - a[0])) * PX_PER_MM * zoom}px`,
                lineHeight: layoutEditorLineHeight(text),
                tabSize: `${layoutEditorTabSizeMm(text) * PX_PER_MM * zoom}px`,
                fontSize: `${text.fontSizePt * 25.4 / 72 * PX_PER_MM * zoom}px`,
                fontWeight: text.bold ? 'bold' : 'normal',
                fontStyle: text.italic ? 'italic' : 'normal',
                textAlign: text.align,
                color: text.color,
                backgroundColor: page.background,
                ...(initialLabelEdit ? { borderWidth: 0, borderStyle: 'none', backgroundColor: 'transparent' } : {}),
                overflow: initialLabelEdit ? 'visible' : 'hidden',
                whiteSpace: !initialLabelEdit && text.bounded ? 'pre-wrap' : 'pre',
                overflowWrap: 'normal',
                wordBreak: 'normal',
                minWidth: initialLabelEdit ? '1px' : text.bounded ? 0 : '180px',
                minHeight: initialLabelEdit ? 0 : text.bounded ? 0 : '40px',
              }}
              onChange={content => tab.commands.execute('layout.text.update', {
                pageId: page.id, entityId: editingText.id, text: editLayoutTextContent(text, content),
              })}
              onRichChange={text => tab.commands.execute('layout.text.update', { pageId: page.id, entityId: editingText.id, text })}
              onSelection={setTextSelection}
              onFinish={() => setEditingTextId(null)}
              onUndo={redo => tab.commands.execute(redo ? 'edit.redo' : 'edit.undo')}
              onEmphasis={key => formatEditingText(formatLayoutTextRange(text, getTextSelection(),
                { [key]: !layoutTextStyleAt(text, getTextSelection().start)[key] }))}
            />;
          })() : null}
          </div>
        </main>
        </div>
        <aside className="pf-layout-controls" aria-label="Layout settings">
      <input ref={imageImportInput} type="file" hidden aria-label="Import image or DXF file"
        accept=".svg,.png,.jpg,.jpeg,.dxf,image/svg+xml,image/png,image/jpeg" onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
          if (file) void importImageFile(file);
        }} />

          {showToolPane ? <section className="pf-layout-tool-panel" aria-label={`${activeToolTitle} tool options`}>
            <h2>{activeToolTitle}</h2>
          {tool === 'shape-builder' ? <div className="pf-layout-tool-option pf-layout-boolean-options pf-layout-shape-builder-controls" role="group" aria-label="Shape Builder controls">
            <div className="pf-layout-tool-actions">
            <button type="button" disabled={!shapeBuilder.canApply} onClick={shapeBuilder.apply}>{shapeBuilder.canApply && shapeBuilder.result?.groups.length === 0 ? 'Apply: delete selected shapes' : 'Apply'}</button>
            <button type="button" onClick={shapeBuilder.cancel}>Cancel</button>
            </div>
            <button type="button" aria-pressed={shapeBuilder.mode === 'add'} onClick={() => shapeBuilder.setMode('add')}>Add</button>
            <button type="button" aria-pressed={shapeBuilder.mode === 'remove'} onClick={() => shapeBuilder.setMode('remove')}>Remove</button>
            <label><input type="checkbox" checked={shapeBuilder.keepOriginals} onChange={event => shapeBuilder.setKeepOriginals(event.target.checked)} />Keep originals</label>
            <span role="status">{shapeBuilder.session?.busy ? 'Finding regions…' : `${shapeBuilder.result?.groups.length ?? 0} result objects. ${shapeBuilder.result?.sourceIndex !== null ? 'Only added sections will be kept.' : 'Delete sections to keep everything else, or add sections to choose what to keep.'}`}</span>
          </div> : null}
          {booleanOperation(tool) ? <div className="pf-layout-tool-option pf-layout-boolean-options" role="group" aria-label="Boolean operation">
            <div className="pf-layout-tool-actions"><button type="button" disabled={booleanIds.length < 2 || Boolean(booleanPreview?.error)} onClick={commitBoolean}>Apply boolean</button></div>
            <span>{booleanPreview?.error ?? (booleanPreview && !booleanPreview.shapes.length ? 'Empty result: applying removes the picked shapes.' : booleanIds.length ? `${booleanIds.length} shapes picked. Enter to apply; Escape to cancel.` : 'Pick the target first, then other shapes.')}
              {tool === 'boolean-cut-path' ? ' Cuts the outline and removes fill.' : tool === 'boolean-division' ? ' Produces separate filled pieces.' : ''}</span>

          </div> : null}

          {tool === 'table' ? <>
            <label className="pf-layout-tool-option">Rows<input aria-label="Table rows" type="number" min="1" max="100" value={tableRows} onChange={event => { const n = Number(event.target.value); if (Number.isInteger(n) && n > 0 && n <= 100) setTableRows(n); }} /></label>
            <label className="pf-layout-tool-option">Columns<input aria-label="Table columns" type="number" min="1" max="100" value={tableColumns} onChange={event => { const n = Number(event.target.value); if (Number.isInteger(n) && n > 0 && n <= 100) setTableColumns(n); }} /></label>
          </> : null}
          {tool === 'viewport' && (viewportSources.length > 0 || cloudApi) ? <label className="pf-layout-tool-option">Model
            <select aria-label="Model" value={viewportSource?.key ?? ''} onChange={event => {
              if (event.target.value === 'cloud:choose') setChoosingModel(true); else setViewportSourceKey(event.target.value);
            }}>
              {viewportSources.map(source => <option key={source.key} value={source.key}>{source.name}</option>)}
              {cloudApi ? <option value="cloud:choose">Choose cloud model…</option> : null}
            </select>
          </label> : null}
          {isLayoutCornerTool(tool) ? <label className="pf-layout-tool-option">
            {tool === 'fillet' ? 'Fillet radius (mm)' : 'Chamfer distance (mm)'}
            <input type="number" min="0.001" step="0.5" value={cornerAmountMm} onChange={event => {
              const value = Number(event.target.value);
              if (Number.isFinite(value) && value > 0) { if (tool === 'fillet') setFilletRadiusMm(value); else setChamferDistanceMm(value); }
            }} />
          </label> : null}
          {isPolygonTool(tool) ? <label className="pf-layout-tool-option">
            Sides
            <input type="number" min={LAYOUT_POLYGON_MIN_SIDES} max={LAYOUT_POLYGON_MAX_SIDES} step="1" value={polygonSides} onChange={event => {
              const sides = Number(event.target.value);
              if (Number.isInteger(sides) && sides >= LAYOUT_POLYGON_MIN_SIDES && sides <= LAYOUT_POLYGON_MAX_SIDES) setPolygonSides(sides);
            }} />
          </label> : null}
          {tool === 'rounded-rectangle' || tool === 'bulged-rectangle' ? <label className="pf-layout-tool-option">
            {tool === 'rounded-rectangle' ? 'Corner radius (mm)' : 'Bulge (mm)'}
            <input type="number" min="0" step="0.5" value={rectangleAmountMm} onChange={(event) => {
              const amount = Number(event.target.value);
              if (event.target.value.trim() && Number.isFinite(amount) && amount >= 0) {
                if (tool === 'bulged-rectangle') setBulgeMm(amount); else setCornerRadiusMm(amount);
              }
            }} />
          </label> : null}
          {editingText?.text && canTransform ? <LayoutTextToolbar text={editingText.text} range={textSelection} getSelection={getTextSelection} onCaptureSelection={setTextSelection}
            onChange={formatEditingText} onReturnToText={returnToText} onFinish={() => setEditingTextId(null)} /> : null}
          </section> : null}

          {viewportSources.length ? <LayoutReferencesPanel state={state} sources={viewportSources} statuses={referenceStatuses} cloud={cloud}
            onUpdate={(referenceId, head) => updateLayoutReference(tab, referenceId, head)}
            onPin={(referenceId, pinned) => tab.commands.execute('layout.reference.pin', { referenceId, pinned })}
            onEdit={reference => { if (cloud) openReferencedModel(reference, cloud).catch(error => setVcbError(error instanceof Error ? error.message : 'The model could not be opened.')); }}
            onConvert={(source, name) => { if (cloud) convertEmbeddedModel(tab, source, name, cloud).catch(error => setVcbError(error instanceof Error ? error.message : 'The model could not be converted.')); }} /> : null}
          <LayoutAccordion title={layoutSelectionTitle(selectedEntity, selectionIds.length)} id={`layout-selection-${tab.id}`} open={openSections.selection}
            onToggle={() => toggleSection('selection')}>
          <div className="pf-form-note">
            {selectedEntity
              ? `${selectedEntity.kind === 'table' ? 'Table' : selectedEntity.kind === 'path' ? 'Path' : selectedEntity.kind === 'image' ? 'Image' : selectedEntity.kind === 'text' ? 'Text' : selectedEntity.kind === 'dimension' || selectedEntity.kind === 'angular-dimension' ? 'Dimension' : 'Label'} #${selectedEntity.id} · ${selectedEntity.points.length} points`
              : selectionIds.length > 1 ? `${selectionIds.length} objects selected` : 'No selection · editing default style'}
          </div>
          {selectedEntity?.table && isLayoutLayerVisible(page, state, selectedEntity.layerId) ? <LayoutTablePanel key={`${page.id}:${selectedEntity.id}`} entity={selectedEntity} selected={tableCell} selection={tableSelection} onSelect={setTableCell} disabled={!canTransform}
            onChange={(table, size) => { tab.commands.execute('layout.table.update', { pageId: page.id, entityId: selectedEntity.id, table, ...size }); }} /> : null}
          {selectedEntity?.angularDimension ? <LayoutAngularDimensionEditor entity={selectedEntity} disabled={!canTransform}
            onChange={(style) => tab.commands.execute('layout.dimension.updateAngular', { pageId: page.id, entityId: selectedEntity.id, style })}
            onDetach={() => tab.commands.execute('layout.dimension.updateAngular', { pageId: page.id, entityId: selectedEntity.id, detach: true })}
          /> : null}
          {selectedEntity?.dimension ? <LayoutDimensionEditor entity={selectedEntity} disabled={!canTransform}
            onChange={(style) => tab.commands.execute('layout.dimension.update', { pageId: page.id, entityId: selectedEntity.id, style })}
            onDetach={() => tab.commands.execute(selectedEntity.modelAnnotation ? 'layout.annotation.detachModel' : 'layout.dimension.update', { pageId: page.id, entityId: selectedEntity.id, detach: true })}
          /> : null}
          {selectedEntity && (selectedEntity.modelAnnotation || selectedEntity.preservedModelConnections) ? <fieldset disabled={!canTransform}>
            <legend>Model connection</legend>
            <p role="status">{reattachModel ? `Click ${reattachModel.attachments.length ? 'the second' : 'a'} model vertex to reconnect.`
              : !selectedEntity.modelAnnotation ? 'Preserved LayOut connection — reconnect to enable live model updates.'
                : selectedEntity.modelAnnotation.status === 'detached' ? 'Detached — showing the last valid annotation.'
                : selectedEntity.modelAnnotation.status === 'unavailable' ? 'Model unavailable — showing the last valid annotation.' : 'Connected to model geometry'}</p>
            <button type="button" onClick={() => { setReattachModel({ id: selectedEntity.id, attachments: [] }); setDimensionDraft(null); setLabelDraft(null);
              setTool(selectedEntity.dimension ? 'dimension' : 'label'); }}>Reconnect to model</button>
            <button type="button" onClick={() => tab.commands.execute('layout.annotation.detachModel', { pageId: page.id, entityId: selectedEntity.id })}>Disconnect from model</button>
          </fieldset> : null}
          {selectedEntity?.text ? (
            <LayoutTextEditor entity={selectedEntity} disabled={!canTransform}
              fields={state.customFields} state={state}
              onSetField={(name, value) => tab.commands.execute('layout.document.setField', { name, value })}
              onSetPageNumbering={(name, numbering) => tab.commands.execute('layout.document.setPageNumbering', { name, numbering })}
              onBounds={(values) => tab.commands.execute('layout.text.setBounds', {
                pageId: page.id, entityId: selectedEntity.id, ...values,
              })}
              onChange={(text) => tab.commands.execute('layout.text.update', {
                pageId: page.id, entityId: selectedEntity.id, text,
              })} />
          ) : null}
          {isViewport(selectedEntity) ? <LayoutViewportPanel key={selectedEntity.id} entity={selectedEntity} state={state} disabled={!canTransform}
            navigating={navigatingViewportId === selectedEntity.id}
            onCamera={(camera, scene) => runPageCommand('layout.viewport.setCamera', { pageId: page.id, entityId: selectedEntity.id, camera, scene })}
            onResizeMode={preserveScale => runPageCommand('layout.viewport.setResizeMode', { pageId: page.id, entityId: selectedEntity.id, preserveScale })}
            onNavigate={on => { if (on) setNavigatingViewportId(selectedEntity.id); else endViewportNavigation(); }} /> : null}
          {/* A model view's layer changes through Move to Layer or the object browser, not the panel. */}
          {selectedEntity && !isViewport(selectedEntity) ? (
            <label>
              Shape layer
              <select aria-label="Shape layer" value={selectedEntity.layerId} disabled={!canTransform}
                onChange={(event) => runPageCommand('layout.shape.assignLayer', {
                  pageId: page.id, entityId: selectedEntity.id, layerId: Number(event.target.value),
                })}>
                {state.layerOrder.map((id) => {
                  const layer = state.layers.get(id)!;
                  return <option key={id} value={id} disabled={layer.locked || !isLayoutLayerVisible(page, state, layer.id)}>{layer.name}</option>;
                })}
              </select>
            </label>
          ) : null}
          {selectedEntity?.kind === 'path' ? (
            <button type="button" disabled={!canTransform && editingPathId !== selectedEntity.id}
              onClick={() => {
                setTool('select');
                setEditingPathId((current) => current === selectedEntity.id ? null : selectedEntity.id);
                setEditPoints(null);
                setEditHandles(null);
                setActivePointIndex(null);
              }}>
              {editingPathId === selectedEntity.id ? 'Done editing path' : 'Edit path'}
            </button>
          ) : null}
          {editingPathId === selectedEntity?.id ? (
            <div>
              Drag anchors or curve handles; double-click a segment to add a point. Delete removes the selected point.
              <button type="button" disabled={activePointIndex === null || !canTransform ||
                (selectedEntity?.kind === 'path' && !selectedEntity.closed &&
                  activePointIndex === selectedEntity.points.length - 1)}
                onClick={() => {
                  const entity = selectedEntity;
                  const index = activePointIndex;
                  if (!entity || index === null || (index === entity.points.length - 1 && !entity.closed)) return;
                  const next = nextLayoutPathIndex(entity.points.length, index, entity.contourStarts);
                  const a = entity.points[index]!, b = entity.points[next]!;
                  const handles = copyHandles(entity.handles, entity.points.length);
                  if (handles[index]!.out || handles[next]!.in) {
                    handles[index]!.out = undefined;
                    handles[next]!.in = undefined;
                  } else {
                    handles[index]!.out = [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3];
                    handles[next]!.in = [a[0] + 2 * (b[0] - a[0]) / 3, a[1] + 2 * (b[1] - a[1]) / 3];
                  }
                  tab.commands.execute('layout.shape.setPath', { pageId: page.id, entityId: entity.id,
                    points: entity.points, handles });
                }}>{activePointIndex !== null && selectedEntity &&
                  (selectedEntity.handles?.[activePointIndex]?.out ||
                    selectedEntity.handles?.[nextLayoutPathIndex(selectedEntity.points.length, activePointIndex, selectedEntity.contourStarts)]?.in)
                  ? 'Straighten next segment' : 'Curve next segment'}</button>
            </div>
          ) : null}
          {/* Only the style one object draws: images have no stroke, only paths fill; several objects have no shared style editor. */}
          {selectionIds.length > 1 || selectedEntity?.image ? null : <>
          <label>
            Stroke
            <input type="color" value={currentStyle.strokeColor} onChange={(event) => setStyle({ strokeColor: event.target.value })} />
          </label>
          <label>
            Weight (pt)
            <input type="number" min="0.01" step="0.1" value={currentStyle.strokeWeightPt} onChange={(event) => {
              const strokeWeightPt = Number(event.target.value);
              // A pattern's dashes follow the stroke weight.
              const dash = selectedEntity?.style?.strokeDashMm, pattern = dash?.length ? matchLayoutDash(dash, currentStyle.strokeWeightPt) : null;
              if (strokeWeightPt > 0) setStyle({ strokeWeightPt, ...(pattern ? { strokeDashMm: layoutDashMm(pattern.id, strokeWeightPt, pattern.scale) } : {}) });
            }} />
          </label>
          {selectedEntity && (selectedEntity.kind === 'path' || selectedEntity.table) ? <LayoutDashControls dashMm={selectedEntity.style?.strokeDashMm}
            weightPt={currentStyle.strokeWeightPt} onChange={strokeDashMm => setStyle({ strokeDashMm })} /> : null}
          {/* Arrows for one line, or, with nothing selected, for the lines the active line tool draws next. */}
          {(selectedEntity ? selectedEntity.kind === 'path' && !selectedEntity.closed && !selectedEntity.table : LINE_DRAWING_TOOLS.has(tool)) ? <LayoutArrowControls
            startArrow={currentStyle.startArrow} endArrow={currentStyle.endArrow} onChange={change => setStyle(change)} /> : null}
          </>}
          {selectionIds.length <= 1 && (!selectedEntity || selectedEntity.kind === 'path') ? <>
          <label>
            <input type="checkbox" checked={currentStyle.fillColor !== null} onChange={(event) => setStyle({ fillColor: event.target.checked ? '#ffffff' : null })} />{' '}
            Fill
          </label>
          {currentStyle.fillColor !== null ? (
            <label>
              Fill color
              <input type="color" value={currentStyle.fillColor} onChange={(event) => setStyle({ fillColor: event.target.value })} />
            </label>
          ) : null}
          </> : null}
          {selectedEntity ? <section className="pf-layout-panel-section" aria-label="Arrange">
            <h3>Arrange</h3>
            <label>
              Rotate (°)
              <input type="number" aria-label="Rotation angle" value={rotationDeg}
                onChange={(event) => setRotationDeg(event.target.value)} />
            </label>
            <button type="button" disabled={!canTransform || !Number.isFinite(Number(rotationDeg)) || !rotationDeg.trim()}
              onClick={() => tab.commands.execute('layout.shape.rotate', {
                pageId: page.id, entityId: selectedEntity!.id, angleDeg: Number(rotationDeg),
              })}>Rotate clockwise</button>
            <label>
              Scale (%)
              <input ref={scalePercentInput} type="number" aria-label="Scale percent" min="0.01" value={scalePercent}
                onChange={(event) => setScalePercent(event.target.value)} />
            </label>
            <button type="button" disabled={!canTransform || !(Number(scalePercent) > 0)}
              onClick={() => tab.commands.execute('layout.shape.scale', {
                pageId: page.id, entityId: selectedEntity!.id,
                scaleX: Number(scalePercent) / 100, scaleY: Number(scalePercent) / 100,
              })}>Apply scale</button>
            <div className="pf-layout-arrange-actions">
              <button type="button" disabled={!canTransform}
                onClick={() => tab.commands.execute('layout.shape.flip', {
                  pageId: page.id, entityId: selectedEntity!.id, axis: 'horizontal',
                })}>Flip horizontally</button>
              <button type="button" disabled={!canTransform}
                onClick={() => tab.commands.execute('layout.shape.flip', {
                  pageId: page.id, entityId: selectedEntity!.id, axis: 'vertical',
                })}>Flip vertically</button>
              <button type="button" disabled={!canTransform}
                onClick={() => tab.commands.execute('layout.shape.order', {
                  pageId: page.id, entityId: selectedEntity!.id, direction: 'front',
                })}>Bring to front</button>
              <button type="button" disabled={!canTransform}
                onClick={() => tab.commands.execute('layout.shape.order', {
                  pageId: page.id, entityId: selectedEntity!.id, direction: 'forward',
                })}>Bring forward</button>
              <button type="button" disabled={!canTransform}
                onClick={() => tab.commands.execute('layout.shape.order', {
                  pageId: page.id, entityId: selectedEntity!.id, direction: 'backward',
                })}>Send backward</button>
              <button type="button" disabled={!canTransform}
                onClick={() => tab.commands.execute('layout.shape.order', {
                  pageId: page.id, entityId: selectedEntity!.id, direction: 'back',
                })}>Send to back</button>
            </div>
          </section> : null}
          </LayoutAccordion>
        </aside>
      </div>
      <div className="pf-layout-footer">
        <div className="pf-layout-footer-spacer" role="status">
          {tool === 'select' && importNote !== null ? importNote : tool === 'select' ? navigatingViewportId !== null ? vcbError ?? 'Drag to orbit, Shift+drag or middle-drag to pan, and scroll to zoom the view. Click outside it or press Esc when done.'
            : editingPathId !== null ? 'Drag vertices to edit. Delete removes the selected vertex. Esc returns to object selection.'
            : scalePreview ? 'Resizing: hold Shift to maintain aspect ratio, Alt to keep the center. Release to finish.'
            : 'Click to select, drag to move, or use the handles to resize (hold Shift to maintain aspect ratio, Alt to keep the center). Double-click to edit vertices.'
            : tool === 'shape-builder' ? `${shapeBuilder.effectiveMode === 'add' ? 'Add' : 'Remove'}: click regions or drag across them. Shift reverses the mode. ${shapeBuilder.result?.sourceIndex !== null ? 'Only added sections are kept.' : 'Deleting alone keeps everything else.'} Enter applies; Escape cancels.`
            : booleanOperation(tool) ? booleanIds.length ? 'Pick more shapes. Enter to apply; Escape to cancel.' : 'Click the target first, then the other shapes.'
            : tool === 'scale' ? 'Click an object, then drag a resize handle. Hold Shift to maintain aspect ratio and Alt to keep the center.'
            : tool === 'move' ? moveDraft
              ? `${moveDraft.copy ? 'Copy' : 'Move'}: click the destination, or enter a distance or x, y offsets in Measurements. Tap ${COPY_TOGGLE_KEYS} to toggle copying; hold Shift to move only horizontally or vertically. Esc cancels.`
              : 'Click an object, or anywhere to move the selection, to choose the base point. After a copy, enter Nx or /N in Measurements for an array.'
            : tool === 'rotate' ? rotationDraft?.reference
              ? `Rotation: ${rotationDraft.angleDeg.toFixed(1)}°. Click to finish, or enter an angle in Measurements. Esc cancels.`
              : rotationDraft ? 'Click a second point to establish the reference line.' : 'Click within a shape or on a line to choose the rotation point.'
            : isLayoutCornerTool(tool) ? cornerResult.error ?? (cornerFirst
              ? `Click the second adjoining segment to ${tool === 'fillet' ? 'round' : 'bevel'} the corner. Size: ${cornerAmountMm} mm. Esc cancels.`
              : `Click the first straight segment. Set the ${tool === 'fillet' ? 'radius' : 'setback'} in the toolbar or Measurements.`)
            : tool === 'offset' ? offsetResult.error ?? (offsetDraft
              ? `Click to place the offset (${offsetDraft.distanceMm.toFixed(2)} mm), or enter a distance in Measurements. Negative values inset closed shapes. Esc cancels.`
              : 'Click a path to offset, then move and click to place its copy.')
            : isLayoutArcTool(tool) ? arcError ?? (arcDraft?.points.length === 2
              ? tool === 'arc2' ? 'Click to set the bulge.' : tool === 'arc3' ? 'Click the arc endpoint.' : 'Move around the center and click the arc endpoint.'
              : arcDraft?.points.length === 1 ? tool === 'arc2' ? 'Click the second endpoint.' : tool === 'arc3' ? 'Click the pivot point on the arc.' : 'Click the arc start to set its radius.'
              : tool === 'arc' || tool === 'pie' ? 'Click the center point.' : 'Click the arc start point.')
            : tool === 'angular-dimension' ? dimensionError ?? (dimensionDraft?.points.length === 3 ? 'Click inside for the angle, or outside for its reflex; distance sets arc radius.'
            : dimensionDraft?.points.length === 2 ? dimensionDraft.rayPoints?.length === 3 ? 'Click the second point of the second ray.' : 'Click the first point of the second ray.'
              : dimensionDraft?.points.length === 1 ? angularEdgeFirst ? 'Click a different edge or the second point of the first ray.' : 'Click the second point of the first ray.'
                : 'Click the first ray point or first edge.')
            : tool === 'dimension' ? dimensionError ?? (dimensionDraft?.points.length === 2 ? 'Click to place the dimension line.'
            : dimensionDraft?.points.length === 1 ? 'Click the second measurement point.' : `Click the first measurement point, or ${PRIMARY_MODIFIER}-click a line to measure its full length.`)
            : tool === 'ellipse' ? `Drag or click two corners. Hold Shift for a circle; ${PRIMARY_MODIFIER} draws from the center. Enter width, height for an exact size.`
            : tool === 'circle' ? 'Click the center, then a point on the circle. Enter a radius for an exact size.'
            : isLayoutRectangleTool(tool) ? `Drag or click two points. Hold Shift for a square; ${PRIMARY_MODIFIER} draws from the center. Enter width, height for an exact size.`
            : tool === 'viewport' ? vcbError ?? `Drag or click two corners to place a view of ${viewportSource?.name ?? 'the model'}.`
            : tool === 'table' ? !anchor ? 'Press and drag to choose rows and columns, or set them in the toolbar and click the first corner.'
              : tableCounting ? `Drag right or left for columns, up or down for rows: ${tableRows} ${tableRows === 1 ? 'row' : 'rows'} × ${tableColumns} ${tableColumns === 1 ? 'column' : 'columns'}. Release to keep them.`
              : `Move to size the table (${tableRows} × ${tableColumns}), then click to place it. Enter width,height in Measurements for an exact size. Esc cancels.`
            : tool === 'line' ? 'Click or drag to draw. Hold Shift for horizontal or vertical. Esc or double-click ends the chain.'
            : tool === 'bezier' ? bezierDraft
              ? 'Click for a corner or drag to pull out handles. Click the first point to close; Enter, Esc or double-click ends the curve.'
              : 'Click to place the first point, or drag to pull out its handles.'
            : tool === 'text' ? `Click for unbounded text, or drag a text box. Hold ${PRIMARY_MODIFIER} to draw a centered box.`
            : polygonTool === 'polygon' ? `Inscribed: choose the center, then a vertex on the reference circle. ${polygonAlt ? 'Release Alt/Option to return to Circumscribed.' : 'Hold Alt/Option for Circumscribed.'} Type a number followed by s to set the sides.`
            : polygonTool === 'circumscribed-polygon' ? `Circumscribed: choose the center, then a side midpoint on the inner circle. ${polygonAlt ? 'Release Alt/Option to return to Inscribed.' : 'Hold Alt/Option for Inscribed.'} Type a number followed by s to set the sides.`
            : tool === 'label' ? labelDraft?.bend ? 'Move horizontally and click to place the text.' : labelDraft ? 'Click to place the leader bend.' : 'Click where the arrow should point.' : ''}
        </div>
        <div ref={zoomMenuRef} className="pf-layout-zoom">
          {zoomMenuOpen ? (
            <div className="pf-layout-zoom-menu" role="menu" aria-label="Layout zoom options">
              {ZOOM_PRESETS.map((percent) => (
                <button key={percent} type="button" role="menuitem" onClick={() => {
                  setZoom(percent / 100);
                  setZoomMenuOpen(false);
                }}>
                  {percent}%
                </button>
              ))}
              <button type="button" role="menuitem" onClick={() => tab.commands.execute('layout.zoom.page')}>Zoom To Page</button>
              <button type="button" role="menuitem" onClick={() => tab.commands.execute('layout.zoom.content')}>Fit Content</button>
              <button type="button" role="menuitem" disabled={!selectedEntity} onClick={() => {
                if (selectedEntity) fitEntities([selectedEntity]);
              }}>Zoom Selection</button>
            </div>
          ) : null}
          <button
            type="button"
            className="pf-layout-zoom-trigger"
            aria-label="Layout zoom"
            aria-haspopup="menu"
            aria-expanded={zoomMenuOpen}
            onClick={() => setZoomMenuOpen((open) => !open)}
          >
            {Math.round(zoom * 100)}% <span aria-hidden="true">⌄</span>
          </button>
        </div>
        <label className="pf-layout-vcb">
          Measurements
          <input
            id="pf-layout-vcb"
            aria-label="Layout Measurements"
            aria-invalid={Boolean(vcbError)}
            value={vcb}
            onChange={(event) => {
              setVcb(event.target.value);
              setVcbError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && (tool === 'offset' || tool === 'rotate' || tool === 'move' || isLayoutCornerTool(tool))) {
                setMoveDraft(null); setMovePreview(null); setCursor(null);
                setOffsetDraft(null); setCornerFirst(null); setCornerHover(null); setRotationDraft(null); setLabelDraft(null); setVcb(''); setVcbError(null); event.currentTarget.blur(); event.preventDefault(); return;
              }
              if (event.key === 'Enter') {
                applyVcb();
                event.preventDefault();
              }
            }}
          />
        </label>
        {vcbError ? <span className="pf-layout-vcb-error" role="alert">{vcbError}</span> : null}
      </div>
    </>
  );
}

const PAGE_NUMBER_STYLE_LABELS: Record<LayoutPageNumberStyle, string> = {
  'arabic': '1, 2, 3', 'two-digit': '01, 02, 03', 'upper-letter': 'A, B, C', 'lower-letter': 'a, b, c', 'upper-roman': 'I, II, III', 'lower-roman': 'i, ii, iii',
};

/** Start page, start number and style of a page-number field. */
function LayoutPageNumberingEditor({ name, numbering, state, onChange }: {
  name: string; numbering: LayoutPageNumbering; state: LayoutDocumentState;
  onChange: (name: string, numbering: LayoutPageNumbering | null) => void;
}): JSX.Element {
  const startPageId = numbering.startPageId !== null && state.pages.has(numbering.startPageId) ? numbering.startPageId : state.pageOrder[0]!;
  const set = (change: Partial<LayoutPageNumbering>): void => onChange(name, { ...numbering, ...change });
  return <fieldset aria-label="Page numbering">
    <legend>{`<${name}>`} page numbering</legend>
    <label>Start page<select value={startPageId}
      onChange={(event) => { const id = Number(event.target.value); set({ startPageId: id === state.pageOrder[0] ? null : id }); }}>
      {state.pageOrder.map((id) => <option key={id} value={id}>{state.pages.get(id)!.name}</option>)}
    </select></label>
    <label>Start number<input type="number" min="0" max="99999" step="1" value={numbering.startNumber}
      onChange={(event) => { const value = Number(event.target.value); if (event.target.value.trim() && Number.isInteger(value) && value >= 0 && value <= 99999) set({ startNumber: value }); }} /></label>
    <label>Style<select value={numbering.style} onChange={(event) => set({ style: event.target.value as LayoutPageNumberStyle })}>
      {LAYOUT_PAGE_NUMBER_STYLES.map((style) => <option key={style} value={style}>{PAGE_NUMBER_STYLE_LABELS[style]}</option>)}
    </select></label>
    {name === 'PageNumber' && state.pageNumberFields?.has('PageNumber')
      ? <button type="button" onClick={() => onChange(name, null)}>Reset page numbering</button> : null}
  </fieldset>;
}

function LayoutTextEditor({ entity, disabled, onChange, onBounds, fields, state, onSetField, onSetPageNumbering }: {
  entity: LayoutEntity; disabled: boolean;
  fields: Map<string, string>;
  state: LayoutDocumentState;
  onSetField: (name: string, value: string) => void;
  onSetPageNumbering: (name: string, numbering: LayoutPageNumbering | null) => void;
  onBounds: (values: { widthMm?: number; heightMm?: number; anchor?: Point }) => void;
  onChange: (values: Partial<NonNullable<LayoutEntity['text']>>) => void;
}): JSX.Element {
  const text = entity.text!;
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const [token, setToken] = useState('PageNumber');
  const modelFields = layoutModelFields(entity);
  const modelField = !!modelFields && Object.hasOwn(modelFields, token);
  const [importError, setImportError] = useState('');
  const fontStatus = layoutFontStatus(text.fontFamily);
  const fontAvailable = fontStatus === 'ready' || layoutFontAvailable(text.fontFamily);
  return <fieldset disabled={disabled}>
    <legend>{entity.kind === 'label' ? 'Label' : 'Text'}</legend>
    <label>Text content<textarea ref={contentRef} aria-label="Text content" value={text.content}
      onChange={(event) => onChange(editLayoutTextContent(text, event.target.value))} /></label>
    <div className="pf-layout-inline-formatting" aria-label="Inline formatting">
      {(['bold', 'italic', 'underline'] as const).map((key) => <button type="button" key={key}
        onClick={() => {
          const input = contentRef.current;
          if (!input || input.selectionStart === input.selectionEnd) return;
          onChange({ spans: [...(text.spans ?? []), { start: input.selectionStart, end: input.selectionEnd,
            bold: text.bold, italic: text.italic, underline: text.underline, [key]: true }] });
        }}>Apply {key} to selection</button>)}
    </div>
    <label>List<select value={text.list ?? 'none'} onChange={(event) => onChange({ list: event.target.value as 'none' | 'bullet' | 'number' })}>
      {['none', 'bullet', 'number'].map((key) => <option key={key}>{key}</option>)}
    </select></label>
    <label>Auto-text field<select value={token} onChange={(event) => setToken(event.target.value)}>
      {[...new Set([...LAYOUT_AUTO_TEXT_TAGS, ...LAYOUT_ACCOUNT_TAGS, ...Object.keys(modelFields ?? {}), ...fields.keys(), ...state.pageNumberFields?.keys() ?? []])].map((key) => <option key={key} value={key}>{`<${key}>`}</option>)}
    </select></label>
    <label>Field name<input aria-label="Auto-text field name" value={token} onChange={(event) => setToken(event.target.value)} /></label>
    <button type="button" disabled={!token.trim() || /[<>\r\n]/.test(token)}
      onClick={() => onChange({ content: text.content + `<${token}>` })}>Insert auto-text</button>
    <small>Custom tags use {'<ProjectName>'}; enter the tag name and its value below.</small>
    {token.trim() && !modelField && !/[<>\r\n]/.test(token) && !LAYOUT_AUTO_TEXT_TAGS.includes(token) && !LAYOUT_ACCOUNT_TAGS.includes(token) ? <label>Field type
      <select aria-label="Auto-text field type" value={layoutPageNumbering(token, state) ? 'page-number' : 'text'}
        onChange={(event) => event.target.value === 'page-number' ? onSetPageNumbering(token, DEFAULT_LAYOUT_PAGE_NUMBERING) : onSetField(token, '')}>
        <option value="text">Text</option>
        <option value="page-number">Page number</option>
      </select>
    </label> : null}
    {modelField ? <small>From the connected model: {modelFields[token]}</small>
      : layoutPageNumbering(token, state) && !LAYOUT_NON_PAGE_NUMBER_TAGS.includes(token)
      ? <LayoutPageNumberingEditor name={token} numbering={layoutPageNumbering(token, state)!} state={state} onChange={onSetPageNumbering} />
      : LAYOUT_ACCOUNT_TAGS.includes(token) && !fields.has(token) ? <small>Filled from your account profile; change it in your account details.</small>
      : token === 'FileName' || !LAYOUT_AUTO_TEXT_TAGS.includes(token) ? <label>Field value
      <input aria-label="Auto-text field value" value={fields.get(token) ?? ''}
        onChange={(event) => onSetField(token, event.target.value)} />
    </label> : null}
    {(['widthMm', 'heightMm'] as const).map((key, axis) => <label key={key}>
      {axis === 0 ? 'Text box width (mm)' : 'Text box height (mm)'}
      <input type="number" min="0.1" step="1"
        value={Math.abs(entity.points[1]![axis]! - entity.points[0]![axis]!)}
        onChange={(event) => { if (Number(event.target.value) > 0) onBounds({ [key]: Number(event.target.value) }); }} />
    </label>)}
    {entity.kind === 'label' ? ([0, 1] as const).map((axis) => <label key={axis}>
      Paper anchor {axis === 0 ? 'X' : 'Y'} (mm)
      <input type="number" value={entity.points[2]![axis]} onChange={(event) => {
        if (!event.target.value.trim() || !Number.isFinite(Number(event.target.value))) return;
        const anchor: Point = [...entity.points[2]!]; anchor[axis] = Number(event.target.value); onBounds({ anchor });
      }} />
    </label>) : null}
    <label>Font family<LayoutFontInput value={text.fontFamily} onChange={fontFamily => onChange({ fontFamily })} /></label>
    {fontStatus === 'loading' ? <p role="status">Loading {text.fontFamily}…</p>
      : !fontAvailable ? <p role="status">Font unavailable: {text.fontFamily}. A substitute is displayed.</p> : null}
    <label>Font size (pt)<input type="number" min="1" value={text.fontSizePt} onChange={(event) => {
      if (Number(event.target.value) > 0) onChange({ fontSizePt: Number(event.target.value) });
    }} /></label>
    <label>Text color<input type="color" value={text.color} onChange={(event) => onChange({ color: event.target.value })} /></label>
    {(['bold', 'italic', 'underline', 'bounded'] as const).map((key) => <label key={key}>
      <input type="checkbox" checked={text[key]} onChange={(event) => onChange({ [key]: event.target.checked })} />
      {key === 'bounded' ? 'Wrap to box' : key[0]!.toUpperCase() + key.slice(1)}
    </label>)}
    <label>Alignment<select value={text.align} onChange={(event) => onChange({ align: event.target.value as typeof text.align })}>
      {['left', 'center', 'right'].map((key) => <option key={key}>{key}</option>)}
    </select></label>
    <label>Vertical anchor<select value={text.vertical} onChange={(event) => onChange({ vertical: event.target.value as typeof text.vertical })}>
      {['top', 'middle', 'bottom'].map((key) => <option key={key}>{key}</option>)}
    </select></label>
    {entity.kind === 'label' ? <>
      <label>Leader<select value={text.leader} onChange={(event) => onChange({ leader: event.target.value as typeof text.leader })}>
        {['straight', 'elbow', 'none'].map((key) => <option key={key}>{key}</option>)}
      </select></label>
      <label>Endpoint<select value={text.endpoint} onChange={(event) => onChange({ endpoint: event.target.value as typeof text.endpoint })}>
        {['arrow', 'dot', 'none'].map((key) => <option key={key}>{key}</option>)}
      </select></label>
    </> : null}
    <label>Import text / RTF<input type="file" accept=".txt,.rtf,text/plain,application/rtf" onChange={async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try { onChange(importLayoutText(await file.text())); setImportError(''); }
      catch { setImportError('Unable to read text file.'); }
    }} /></label>
    <small>RTF import preserves text, bold, italic, and underline.</small>
    {importError ? <p role="alert">{importError}</p> : null}
  </fieldset>;
}

function layoutFontAvailable(family: string): boolean {
  if (['sans-serif', 'serif', 'monospace', 'system-ui'].includes(family)) return true;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return true;
  const sample = 'mmmmmmmmmmWWWWiiii0123456789';
  return ['monospace', 'serif', 'sans-serif'].some((fallback) => {
    ctx.font = `72px ${fallback}`;
    const baseline = ctx.measureText(sample).width;
    ctx.font = `72px "${family.replace(/["\\]/g, '')}", ${fallback}`;
    return ctx.measureText(sample).width !== baseline;
  });
}

/** Decimal units and the feet-and-inch formats in one list. */
const DIMENSION_UNIT_CHOICES: readonly [string, string][] = [
  ['mm', 'mm'], ['cm', 'cm'], ['m', 'm'], ['inch', 'Decimal inches (")'], ['ft', "Decimal feet (')"], ['pt', 'Points (pt)'],
  ['architectural', 'Architectural (6\'-3 1/2")'], ['fractional', 'Fractional inches (75-1/2")'], ['engineering', "Engineering feet (6.29')"],
];

/** The N of a 1:N scale, edited as a draft and committed once on Enter or blur so a scale change is one undo step. */
function LayoutScaleRatioInput({ scale, onCommit }: { scale: number; onCommit: (ratio: number) => void }): JSX.Element {
  const shown = String(Number((1 / scale).toPrecision(6)));
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    const ratio = Number(draft);
    if (draft !== null && draft.trim() && Number.isFinite(ratio) && ratio > 0 && draft !== shown) onCommit(ratio);
    setDraft(null);
  };
  return <input type="number" min="0" step="any" value={draft ?? shown} onChange={(event) => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={(event) => {
      if (event.key === 'Enter') commit();
      if (event.key === 'Escape') setDraft(null);
    }} />;
}

function LayoutDimensionEditor({ entity, disabled, onChange, onDetach }: {
  entity: LayoutEntity; disabled: boolean;
  onChange: (style: Partial<LayoutLinearDimension>) => void; onDetach: () => void;
}): JSX.Element {
  const dim = entity.dimension!;
  const format = dim.format ?? 'decimal', scale = dim.scale ?? 1, points = format === 'decimal' && dim.units === 'pt';
  const presetIndex = LAYOUT_DIMENSION_SCALES.findIndex(preset => layoutDimensionScaleLabel(scale) === preset.label);
  return <fieldset disabled={disabled}>
    <legend>Linear Dimension</legend>
    <p>{formatLinearDimension(dim)}</p>
    <p role="status">{dim.detached ? 'Detached — showing the last measured value.'
      : entity.modelAnnotation ? 'Automatically measured from model view' : dim.anchors.some(Boolean) ? associationLabel(dim.anchors) : 'Paper points'}</p>
    {dim.anchors.some(Boolean) ? <button type="button" onClick={onDetach}>Use fixed paper points</button> : null}
    <label>Dimension alignment<select value={dim.alignment} onChange={(event) => onChange({ alignment: event.target.value as LayoutLinearDimension['alignment'] })}>
      {['aligned', 'horizontal', 'vertical', 'rotated'].map((value) => <option key={value}>{value}</option>)}
    </select></label>
    {/* A rotated dimension measures along its own angle. */}
    {dim.alignment === 'rotated' ? <label>Dimension angle (°)<input type="number" min="0" max="180" step="1" value={+(dim.angleDeg ?? 0).toFixed(3)}
      onChange={(event) => { const angleDeg = Number(event.target.value); if (Number.isFinite(angleDeg)) onChange({ angleDeg }); }} /></label> : null}
    <label>Dimension units<select value={format === 'decimal' ? dim.units : format} onChange={(event) => {
      const value = event.target.value;
      // Feet-and-inch formats count in inches (engineering in feet).
      if (value === 'architectural' || value === 'fractional' || value === 'engineering') onChange({ format: value, units: value === 'engineering' ? 'ft' : 'inch' });
      // Points show at most one decimal place.
      else onChange({ format: 'decimal', units: value as LayoutLinearDimension['units'], ...(value === 'pt' && dim.precision > 1 ? { precision: 1 } : {}) });
    }}>
      {DIMENSION_UNIT_CHOICES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <label>Dimension precision<select value={points ? Math.min(dim.precision, 1) : dim.precision} onChange={(event) => onChange({ precision: Number(event.target.value) })}>
      {(points ? [0, 1] : [0, 1, 2, 3, 4, 5, 6]).map((value) =>
        <option key={value} value={value}>{layoutLengthPrecisionLabel(format, value)}</option>)}
    </select></label>
    <label><input type="checkbox" checked={dim.showUnits} onChange={(event) => onChange({ showUnits: event.target.checked })} /> Show dimension units</label>
    {format === 'architectural' || format === 'fractional'
      ? <label><input type="checkbox" checked={dim.showDashes ?? true} onChange={(event) => onChange({ showDashes: event.target.checked })} /> Dash between feet, inches, and fractions</label>
      : null}
    <label>Dimension scale<select disabled={!!entity.modelAnnotation} value={presetIndex >= 0 ? String(presetIndex) : 'custom'} onChange={(event) => {
      const preset = LAYOUT_DIMENSION_SCALES[Number(event.target.value)];
      if (preset) onChange({ scale: preset.scale });
    }}>
      {LAYOUT_DIMENSION_SCALES.map((preset, index) => <option key={preset.label} value={index}>{preset.label}</option>)}
      {presetIndex < 0 ? <option value="custom">{layoutDimensionScaleLabel(scale)}</option> : null}
    </select></label>
    {!entity.modelAnnotation ? <label>Custom scale 1:<LayoutScaleRatioInput scale={scale} onCommit={ratio => onChange({ scale: 1 / ratio })} /></label> : null}
    <label>Dimension text<input value={dim.text} onChange={(event) => onChange({ text: event.target.value })} /></label>
    <small>Use {'<>'} for the measured value, for example: Overall {'<>'}.</small>
    <label>Dimension font<LayoutFontInput value={dim.fontFamily} onChange={fontFamily => onChange({ fontFamily })} /></label>
    <label>Dimension endpoint<select value={dim.endpoint} onChange={(event) => onChange({ endpoint: event.target.value as LayoutLinearDimension['endpoint'] })}>
      {['arrow', 'tick', 'dot', 'none'].map((value) => <option key={value}>{value}</option>)}
    </select></label>
    {([['fontSizePt', 'Dimension font size (pt)'], ['arrowSizeMm', 'Endpoint size (mm)'],
      ['extensionGapMm', 'Extension gap (mm)'], ['extensionOverrunMm', 'Extension overrun (mm)']] as const).map(([key, label]) => <label key={key}>
      {label}<input type="number" min={key === 'extensionGapMm' || key === 'extensionOverrunMm' ? 0 : 0.1} step="0.1"
        value={dim[key]} onChange={(event) => {
          const value = Number(event.target.value);
          if (Number.isFinite(value) && (key === 'extensionGapMm' || key === 'extensionOverrunMm' ? value >= 0 : value > 0)) onChange({ [key]: value });
        }} />
    </label>)}
  </fieldset>;
}

function LayoutAngularDimensionEditor({ entity, disabled, onChange, onDetach }: {
  entity: LayoutEntity; disabled: boolean; onChange: (style: Partial<LayoutAngularDimension>) => void; onDetach: () => void;
}): JSX.Element {
  const dim = entity.angularDimension!;
  return <fieldset disabled={disabled}>
    <legend>Angular Dimension</legend><p>{formatAngularDimension(dim)}</p>
    <p role="status">{dim.detached ? 'Detached — showing the last measured angle.'
      : dim.edgeAnchors ? 'Associated with straight edges' : (dim.rayDefinition?.anchors.some(Boolean) || dim.anchors.some(Boolean))
        ? associationLabel([...dim.anchors, ...(dim.rayDefinition?.anchors ?? [])]) : 'Paper points'}</p>
    {(dim.anchors.some(Boolean) || ('edgeAnchors' in dim && dim.edgeAnchors) || ('rayDefinition' in dim && dim.rayDefinition)) ? <button type="button" onClick={onDetach}>Use fixed paper points</button> : null}
    <label>Angle units<select value={dim.units} onChange={(event) => onChange({ units: event.target.value as LayoutAngularDimension['units'] })}>
      <option value="degrees">Degrees</option><option value="radians">Radians</option>
    </select></label>
    <label><input type="checkbox" checked={dim.reflex} onChange={(event) => onChange({ reflex: event.target.checked })} /> Reflex angle</label>
    <label>Angle precision<input type="number" min="0" max="6" value={dim.precision} onChange={(event) => {
      const value = Number(event.target.value); if (Number.isInteger(value) && value >= 0 && value <= 6) onChange({ precision: value });
    }} /></label>
    <label>Angle text<input value={dim.text} onChange={(event) => onChange({ text: event.target.value })} /></label>
    <small>Use {'<>'} for the measured angle.</small>
    <label><input type="checkbox" checked={dim.showUnits} onChange={(event) => onChange({ showUnits: event.target.checked })} /> Show angle units</label>
    <label>Angle font<LayoutFontInput value={dim.fontFamily} onChange={fontFamily => onChange({ fontFamily })} /></label>
    <label>Angle endpoint<select value={dim.endpoint} onChange={(event) => onChange({ endpoint: event.target.value as LayoutAngularDimension['endpoint'] })}>
      {['arrow', 'tick', 'dot', 'none'].map((value) => <option key={value}>{value}</option>)}
    </select></label>
    {([['fontSizePt', 'Angle font size (pt)'], ['arrowSizeMm', 'Angle endpoint size (mm)'],
      ['extensionGapMm', 'Angle extension gap (mm)'], ['extensionOverrunMm', 'Angle extension overrun (mm)']] as const).map(([key, label]) => <label key={key}>
      {label}<input type="number" step="0.1" min={key.startsWith('extension') ? 0 : 0.1} value={dim[key]} onChange={(event) => {
        const value = Number(event.target.value);
        if (Number.isFinite(value) && (key.startsWith('extension') ? value >= 0 : value > 0)) onChange({ [key]: value });
      }} />
    </label>)}
  </fieldset>;
}
