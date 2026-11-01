// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { cloneLayoutValue, layoutDimensionUnits, layoutValuesEqual, setLayoutGridUnits } from '@pushform/layout';
import { operateLayoutPaths, LAYOUT_PATH_OPERATIONS, createLayoutShapeRegions, replayLayoutShapeBuild, layoutShapeBuildSnapshot, retainedLayoutShapeSources, retainLayoutShapeOpenSource } from '@pushform/layout';
import { LENGTH_TOL } from '@pushform/core';
import { resizedViewportCamera } from '@pushform/layout';
import { detachedLayoutModelAnnotation, copyLayoutModelAnnotation, refreshLayoutModelAnnotations, validLayoutModelAttachment, validLayoutModelAnnotation, type LayoutModelAttachment, type LayoutAnnotationModels } from '@pushform/layout';
import { LAYOUT_ARROW_TYPES, createLayoutTable, cloneLayoutTable, validLayoutTable, validTableFrame, tableFrame, copyLayoutImage, isViewport, isCloudSource, isCloudReference, LAYOUT_OBJECT_NAME_MAX, LAYOUT_NON_PAGE_NUMBER_TAGS, LAYOUT_PAGE_NUMBER_STYLES, type LayoutTable } from '@pushform/layout';
import { z } from 'zod';
import { allocId, type Draft } from '@pushform/model';
import { layoutAnchorOnPath, validLayoutContourStarts, isLayoutLayerVisible, moveLayoutLabel, layoutLabelWholeMovePart, refreshLayoutLabels, resolveLayoutLabelAnchor, rotateLayoutEntity, layoutTextCenter, resizeLayoutTextPoints, createLayoutCornerBetween, createLayoutOffset, createLayoutArc, LAYOUT_ARC_KINDS, createLayoutRectangle, LAYOUT_RECTANGLE_KINDS, addLayoutLine, angularRaysFromPoints, resolveAngularEdgePoints, angularMeasurement, angularDimensionError, createAngularDimension, createLinearDimension, refreshLayoutDimensions, linearMeasurement, normalizeDimensionAngle, flattenLayoutPath, snapPaperPoint, type LayoutDocument, type LayoutDocumentState, type LayoutEntity, type LayoutPathHandle, type LayoutLinearDimension, type LayoutAngularDimension } from '@pushform/layout';
import type { TransactionHost, AnyCommand } from '../registry/Command';
import { defineCommand } from '../registry/Command';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import { layoutWorkspaceCommands } from './layoutTools';

/** Transaction adapter for a Layout document. The registry owns the outer transaction. */
export class LayoutDocumentHost implements TransactionHost {
  /** Runtime revision cache; never serialized with the drawing. */
  annotationModels: LayoutAnnotationModels = () => undefined;
  constructor(readonly doc: LayoutDocument) {}

  transact<T>(label: string, fn: () => T): T {
    return this.doc.undoStack.transact(label, () => fn());
  }
  edit<T>(label: string, fn: (draft: Draft<LayoutDocumentState>) => T): T {
    return this.doc.undoStack.transact(label, (draft) => {
      const result = fn(draft);
      refreshLayoutDimensions(draft);
      refreshLayoutLabels(draft);
      refreshLayoutModelAnnotations(draft, this.annotationModels);
      return result;
    });
  }
  /** A change to derived data: saved, but not an undo step. */
  derive<T>(label: string, fn: (draft: Draft<LayoutDocumentState>) => T): T {
    return this.doc.undoStack.derive(label, fn);
  }
  undo(): boolean {
    return this.doc.undoStack.undo();
  }
  redo(): boolean {
    return this.doc.undoStack.redo();
  }
  canUndo(): boolean {
    return this.doc.undoStack.canUndo;
  }
  canRedo(): boolean {
    return this.doc.undoStack.canRedo;
  }
  onChange(fn: () => void): () => void {
    return this.doc.events.on('change', fn);
  }
}

const finite = z.number().finite();
const point = z.tuple([finite, finite]);
const pathHandle = z.object({ in: point.optional(), out: point.optional() });
const id = z.number().int().positive();
const color = z.string().min(1);
const strokeDashMm = z.array(finite.positive()).refine(lengths => lengths.length % 2 === 0, {
  message: 'Dash patterns need alternating dash and gap lengths',
});

function host(ctx: { tx: TransactionHost }): LayoutDocumentHost {
  if (!(ctx.tx instanceof LayoutDocumentHost))
    throw new Error('Layout command requires a Layout document');
  return ctx.tx;
}

/** Point a cloud reference at a saved model revision; `followOnly` leaves a pinned reference alone. */
function cloudReference(draft: Draft<LayoutDocumentState>, referenceId: number,
  revision: { revisionId: string; revisionNumber: number; sha256: string }, followOnly = false): boolean {
  const reference = draft.references.get(referenceId);
  if (!isCloudReference(reference)) throw new Error('Unknown model reference');
  if (followOnly && reference.target.pinned) return false;
  if (reference.target.revisionId === revision.revisionId) return false;
  reference.target.revisionId = revision.revisionId;
  reference.target.revisionNumber = revision.revisionNumber;
  reference.target.sha256 = revision.sha256;
  return true;
}

/** Copies share fresh group identities with one another, never with the originals. */
function copyGroupMembership(entity: LayoutEntity, groups: Map<number, number>, draft: Draft<LayoutDocumentState>): Pick<LayoutEntity, 'groupId' | 'nestedGroupIds'> {
  const remap = (id: number): number => {
    if (!groups.has(id)) groups.set(id, allocId(draft));
    return groups.get(id)!;
  };
  return {
    ...(entity.groupId !== undefined ? { groupId: remap(entity.groupId) } : {}),
    ...(entity.nestedGroupIds ? { nestedGroupIds: entity.nestedGroupIds.map(remap) } : {}),
  };
}

function page(draft: Draft<LayoutDocumentState>, pageId: number) {
  const value = draft.pages.get(pageId);
  if (!value) throw new Error(`Unknown page: ${pageId}`);
  return value;
}

function shapeStore(draft: Draft<LayoutDocumentState>, pageId: number, layerId: number) {
  const target = page(draft, pageId);
  const layer = draft.layers.get(layerId);
  if (!layer) throw new Error('Unknown layer');
  return layer.shared
    ? { entities: draft.sharedEntities, order: draft.sharedEntityOrder }
    : { entities: target.entities, order: target.entityOrder };
}

function findShape(draft: Draft<LayoutDocumentState>, pageId: number, entityId: number) {
  const target = page(draft, pageId);
  const entity = target.entities.get(entityId) ?? draft.sharedEntities.get(entityId);
  if (!entity) throw new Error('Unknown shape');
  return { entity, store: shapeStore(draft, pageId, entity.layerId) };
}

function editablePath(draft: Draft<LayoutDocumentState>, pageId: number, entityId: number) {
  const { entity } = findShape(draft, pageId, entityId);
  const layer = draft.layers.get(entity.layerId);
  if (!layer || layer.locked || !isLayoutLayerVisible(page(draft, pageId), draft, layer.id)) throw new Error('Layer is unavailable');
  if (entity.locked) throw new Error('Object is locked');
  return entity;
}

/**
 * Independent copies of `sources` in their order, with fresh ids and fresh shared group identities. Anchors between
 * copied objects follow the copies; anchors to anything else keep pointing at the original.
 */
function copyLayoutEntities(sources: readonly LayoutEntity[], draft: Draft<LayoutDocumentState>, layerId?: number): LayoutEntity[] {
  const groups = new Map<number, number>();
  const copies = sources.map((source): LayoutEntity => {
    const copy: LayoutEntity = { ...cloneLayoutValue(source), id: allocId(draft),
      ...copyGroupMembership(source, groups, draft), layerId: layerId ?? source.layerId };
    if (copy.image?.viewport) copy.image.viewport.originalId = null;
    if (copy.text && copy.preservedModelConnections) copy.text = detachedLayoutModelAnnotation(copy).text!;
    delete copy.preservedModelConnections;
    return copy;
  });
  const copiedIds = new Map(sources.map((original, index) => [original.id, copies[index]!.id]));
  for (const entity of copies) {
    for (const a of entity.modelAnnotation?.attachments ?? []) a.viewportId = copiedIds.get(a.viewportId) ?? a.viewportId;
    if (entity.labelAnchor) entity.labelAnchor.entityId = copiedIds.get(entity.labelAnchor.entityId) ?? entity.labelAnchor.entityId;
    const dimension = entity.dimension ?? entity.angularDimension;
    if (!dimension) continue;
    dimension.anchors = dimension.anchors.map((anchor) => anchor
      ? { ...anchor, entityId: copiedIds.get(anchor.entityId) ?? anchor.entityId } : null) as typeof dimension.anchors;
    if (entity.angularDimension?.rayDefinition) for (const anchor of entity.angularDimension.rayDefinition.anchors)
      if (anchor) anchor.entityId = copiedIds.get(anchor.entityId) ?? anchor.entityId;
    if (entity.angularDimension?.edgeAnchors) for (const edge of entity.angularDimension.edgeAnchors)
      edge.entityId = copiedIds.get(edge.entityId) ?? edge.entityId;
  }
  // A group copied with only one of its members is no group at all.
  const members = new Map<number, number>();
  for (const entity of copies) if (entity.groupId !== undefined) members.set(entity.groupId, (members.get(entity.groupId) ?? 0) + 1);
  for (const entity of copies) if (entity.groupId !== undefined && members.get(entity.groupId) === 1) { delete entity.groupId; delete entity.nestedGroupIds; }
  return copies;
}

function pathCenter(points: readonly [number, number][]): [number, number] {
  if (points.length === 0) throw new Error('Cannot transform an empty path');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return [minX + (maxX - minX) / 2, minY + (maxY - minY) / 2];
}

function transformPath(
  points: readonly [number, number][],
  pivot: [number, number],
  fn: (x: number, y: number) => [number, number],
): [number, number][] {
  return points.map(([x, y]): [number, number] => {
    const [localX, localY] = fn(x - pivot[0], y - pivot[1]);
    const transformed: [number, number] = [pivot[0] + localX, pivot[1] + localY];
    if (!transformed.every(Number.isFinite)) throw new Error('Transform exceeds coordinate range');
    return transformed;
  });
}

/** A rotated dimension's line direction follows a linear transform of its points. */
function transformDimensionAngle(entity: LayoutEntity, fn: (x: number, y: number) => [number, number]): void {
  if (entity.dimension?.alignment !== 'rotated') return;
  const radians = (entity.dimension.angleDeg ?? 0) * Math.PI / 180;
  const [x, y] = fn(Math.cos(radians), Math.sin(radians));
  entity.dimension.angleDeg = normalizeDimensionAngle(Math.atan2(y, x) * 180 / Math.PI);
}

function cloneHandles(handles: readonly LayoutPathHandle[] | undefined): LayoutPathHandle[] | undefined {
  return handles?.map((handle) => ({
    ...(handle.in ? { in: [...handle.in] as [number, number] } : {}),
    ...(handle.out ? { out: [...handle.out] as [number, number] } : {}),
  }));
}

function transformHandles(entity: LayoutEntity, pivot: [number, number],
  fn: (x: number, y: number) => [number, number]): void {
  if (!entity.handles) return;
  entity.handles = entity.handles.map((handle) => ({
    ...(handle.in ? { in: transformPath([handle.in], pivot, fn)[0]! } : {}),
    ...(handle.out ? { out: transformPath([handle.out], pivot, fn)[0]! } : {}),
  }));
}

const textProperties = z.object({
  spans: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(),
    bold: z.boolean(), italic: z.boolean(), underline: z.boolean(),
    fontFamily: z.string().trim().min(1).optional(), fontSizePt: finite.positive().optional(), color: color.optional() })).optional(),
  list: z.enum(['none', 'bullet', 'number']).optional(),
  /** A multiple of the natural line height, or a line height in points. */
  lineSpacing: z.object({ mode: z.enum(['multiple', 'exactly', 'atLeast']), value: finite.positive().max(1000) }).optional(),
  /** Ascending tab stops in points from the box's left side. */
  tabStopsPt: z.array(finite.positive().max(10000)).max(64)
    .refine(stops => stops.every((stop, i) => i === 0 || stop > stops[i - 1]!), 'Tab stops must ascend').optional(),
  content: z.string(), fontFamily: z.string().trim().min(1), fontSizePt: finite.positive(),
  color, bold: z.boolean(), italic: z.boolean(), underline: z.boolean(),
  align: z.enum(['left', 'center', 'right']), vertical: z.enum(['top', 'middle', 'bottom']),
  bounded: z.boolean(), leader: z.enum(['straight', 'elbow', 'none']),
  endpoint: z.enum(['arrow', 'dot', 'none']),
  /** Where a label's leader meets its text, below the box's vertical center. */
  leaderOffsetMm: finite.optional(),
});

function structuredCloneDimension(dimension: LayoutLinearDimension): LayoutLinearDimension {
  return cloneLayoutValue(dimension);
}

function cloneAngularDimension(dimension: LayoutAngularDimension): LayoutAngularDimension {
  return cloneLayoutValue(dimension);
}

const angularEdgeAnchor = z.object({ entityId: id, segmentIndex: z.number().int().nonnegative(), pointCount: z.number().int().min(2), direction: z.union([z.literal(1), z.literal(-1)]) });
const dimensionAnchor = z.object({ entityId: id, pointIndex: z.number().int().nonnegative(), pointCount: z.number().int().min(2),
  /** A point along the segment from `pointIndex`. */
  t: z.number().gt(0).lt(1).optional() }).nullable();
const modelAttachments = z.array(z.custom<LayoutModelAttachment>(validLayoutModelAttachment)).min(1).max(2);
function attachModelAnnotation(entity: LayoutEntity, attachments: LayoutModelAttachment[], draft: LayoutDocumentState, models: LayoutAnnotationModels): void {
  entity.modelAnnotation = { attachments: structuredClone(attachments), status: 'unavailable' };
  delete entity.labelAnchor;
  if (entity.dimension) entity.dimension.anchors = [null, null];
  if (!validLayoutModelAnnotation(entity)) throw new Error('Model dimension attachments must measure one view');
  refreshLayoutModelAnnotations(draft, models);
  if (entity.modelAnnotation.status !== 'resolved') throw new Error('Model attachment is unavailable');
  delete entity.preservedModelConnections;
}
const dimensionStyle = z.object({
  alignment: z.enum(['aligned', 'horizontal', 'vertical', 'rotated']), angleDeg: finite, units: z.enum(['mm', 'cm', 'm', 'inch', 'ft', 'pt']),
  format: z.enum(['decimal', 'architectural', 'engineering', 'fractional']), scale: finite.positive(), showDashes: z.boolean(),
  precision: z.number().int().min(0).max(6), showUnits: z.boolean(), text: z.string(),
  fontFamily: z.string().trim().min(1), fontSizePt: finite.positive(),
  endpoint: z.enum(['arrow', 'tick', 'dot', 'none']), arrowSizeMm: finite.positive(),
  extensionGapMm: finite.nonnegative(), extensionOverrunMm: finite.nonnegative(),
}).partial();

const angularStyle = dimensionStyle.omit({ alignment: true, angleDeg: true, units: true, format: true, scale: true, showDashes: true }).extend({
  units: z.enum(['degrees', 'radians']).optional(), reflex: z.boolean().optional(),
});

/** A start or end arrow on an open shape. */
type Arrow = { type: typeof LAYOUT_ARROW_TYPES[number]; sizePt: number };
function setArrows(style: { startArrow?: Arrow; endArrow?: Arrow }, start: Arrow | null | undefined, end: Arrow | null | undefined): void {
  if (start) style.startArrow = { ...start }; else if (start === null) delete style.startArrow;
  if (end) style.endArrow = { ...end }; else if (end === null) delete style.endArrow;
}

const arrow = z.object({ type: z.enum(LAYOUT_ARROW_TYPES), sizePt: finite.positive().max(1000) });

/** The default style without its arrows, for objects that are not open shapes. */
function plainStyle(draft: Draft<LayoutDocumentState>): NonNullable<LayoutEntity['style']> {
  const { startArrow: _start, endArrow: _end, ...style } = draft.defaultStyle;
  return { ...style };
}

/** The style a new shape starts with: open shapes take the default arrows, closed ones the default fill. */
function newShapeStyle(draft: Draft<LayoutDocumentState>, closed: boolean): NonNullable<LayoutEntity['style']> {
  return closed ? { ...plainStyle(draft), fillColor: draft.defaultStyle.fillColor ?? '#ffffff' } : { ...draft.defaultStyle, fillColor: null };
}

/** Copies keep a custom object name. */
const clipboardBase = z.object({ name: z.string().trim().max(LAYOUT_OBJECT_NAME_MAX).optional(),
  points: z.array(point).min(2), closed: z.boolean(), groupId: id.optional(), nestedGroupIds: z.array(id).min(1).optional(),
  style: z.object({ strokeColor: color, strokeWeightPt: finite.nonnegative(), strokeDashMm: strokeDashMm.optional(), fillColor: color.nullable(),
    startArrow: arrow.optional(), endArrow: arrow.optional() }).optional() });
const vector3 = z.tuple([finite, finite, finite]);
const viewportCamera = z.object({ eye: vector3, target: vector3, up: vector3, projection: z.enum(['perspective', 'parallel']),
  fov: finite.positive().lt(180), scale: finite.positive(), shift: point.optional() });
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const cloudTarget = z.object({ kind: z.literal('cloud'), documentId: z.string().min(1), revisionId: z.string().min(1),
  revisionNumber: z.number().int().positive(), sha256, pinned: z.boolean() });
const archiveSource = z.object({ archiveId: z.string().min(1), modelReferenceId: z.string().min(1) });
const cloudModel = z.object({ displayName: z.string().trim().min(1).max(200), documentId: z.string().min(1), revisionId: z.string().min(1),
  revisionNumber: z.number().int().positive(), sha256 });
/** The document's reference to a cloud model, created at the given revision when it has none. */
function cloudReferenceFor(draft: Draft<LayoutDocumentState>, model: z.infer<typeof cloudModel>): number {
  const existing = [...draft.references.values()].find(reference => isCloudReference(reference) && reference.target.documentId === model.documentId);
  if (existing) return existing.id;
  const referenceId = allocId(draft);
  draft.references.set(referenceId, { id: referenceId, displayName: model.displayName, target: { kind: 'cloud', documentId: model.documentId,
    revisionId: model.revisionId, revisionNumber: model.revisionNumber, sha256: model.sha256, pinned: false } });
  return referenceId;
}
/** A copied cloud view carries its reference, so pasting into another document can recreate it. */
const clipboardSource = z.union([archiveSource,
  z.object({ referenceId: id, reference: z.object({ displayName: z.string(), target: cloudTarget }).optional() })]);
const viewportCache = z.object({ camera: viewportCamera, widthMm: finite.positive(), heightMm: finite.positive(), sha256: sha256.optional() });
const layoutViewport = z.object({
  source: clipboardSource,
  templateId: z.string().min(1).nullable(), originalId: z.string().min(1).nullable(), camera: viewportCamera,
  scene: z.string().nullable(), background: color.nullable(),
  cache: viewportCache.nullable(),
  preserveScaleOnResize: z.boolean().optional(),
});
const pictureSource = /^data:image\/(?:png|jpeg|jpg|svg\+xml|webp|gif|bmp|avif)[;,]/i;
/** A viewport may have no picture yet: it is rendered from its model. */
const clipboardImage = z.object({ src: z.string(), viewport: layoutViewport.optional(),
  clip: z.object({ points: z.array(point).min(3), handles: z.array(pathHandle).optional() }).optional() })
  .refine(image => pictureSource.test(image.src) || image.viewport && image.src === '', { message: 'Unsupported picture' });
const tableProperties = z.custom<LayoutTable>(validLayoutTable, 'Invalid table grid');
const clipboardEntity = z.discriminatedUnion('kind', [
  clipboardBase.extend({ kind: z.literal('path'), handles: z.array(pathHandle).optional(), contourStarts: z.array(id.or(z.literal(0))).optional(),
    openContours: z.array(z.number().int().nonnegative()).optional() }),
  clipboardBase.extend({ kind: z.literal('text'), text: textProperties.extend({ rotationDeg: finite.optional() }) }),
  clipboardBase.extend({ kind: z.literal('label'), text: textProperties.extend({ rotationDeg: finite.optional() }) }),
  clipboardBase.extend({ kind: z.literal('table'), table: tableProperties }),
  clipboardBase.extend({ kind: z.literal('image'), image: clipboardImage }),
  clipboardBase.extend({ kind: z.literal('dimension'), dimension: dimensionStyle.required({ alignment: true, units: true, precision: true, showUnits: true, text: true,
    fontFamily: true, fontSizePt: true, endpoint: true, arrowSizeMm: true, extensionGapMm: true, extensionOverrunMm: true }).extend({ cachedValueMm: finite.nonnegative() })
    .transform(dim => ({ ...dim, anchors: [null, null] as LayoutLinearDimension['anchors'], detached: false })) }),
  clipboardBase.extend({ kind: z.literal('angular-dimension'), angularDimension: angularStyle.required().extend({ cachedAngleDeg: finite.min(0).max(360) })
    .transform(dim => ({ ...dim, anchors: [null, null, null] as LayoutAngularDimension['anchors'], detached: false })) }),
]).superRefine((entity, ctx) => {
  if (entity.kind === 'path' && (entity.contourStarts ? !validLayoutContourStarts(entity.points, entity.closed, entity.contourStarts, entity.openContours) : entity.openContours))
    ctx.addIssue({ code: 'custom', message: 'Invalid compound path contours.' });
  if (entity.nestedGroupIds && (entity.groupId === undefined || entity.nestedGroupIds.includes(entity.groupId) ||
    new Set(entity.nestedGroupIds).size !== entity.nestedGroupIds.length))
    ctx.addIssue({ code: 'custom', message: 'Invalid clipboard group hierarchy.' });
  if (entity.kind === 'table' && !validTableFrame(entity.points)) ctx.addIssue({ code: 'custom', message: 'Invalid table frame.' });
  const count = entity.points.length;
  if (entity.kind === 'path' ? entity.handles && entity.handles.length !== count :
    entity.kind === 'text' ? count !== 2 : entity.kind === 'label' ? count !== 3 && count !== 4 :
    entity.kind === 'dimension' ? count !== 3 : count !== 4)
    ctx.addIssue({ code: 'custom', message: 'Invalid clipboard object geometry.' });
});

/**
 * Place independent copies of clipboard objects as a group centered on a page, on the active layer;
 * returns their ids. DXF import places its converted drawing the same way.
 */
function pasteEntities(draft: Draft<LayoutDocumentState>, pageId: number, copies: readonly z.infer<typeof clipboardEntity>[], position?: [number, number]): number[] {
  const target = page(draft, pageId), layer = draft.layers.get(draft.activeLayerId);
  if (!layer || !isLayoutLayerVisible(page(draft, pageId), draft, layer.id) || layer.locked) throw new Error('Active layer is unavailable');
  const entities = copies.flatMap(entity => {
    const pasted = { ...entity, id: allocId(draft), layerId: layer.id } as LayoutEntity;
    if (!pasted.image) return [pasted];
    // A pasted viewport is a copy; one whose model is not in this document keeps only its picture.
    pasted.image = copyLayoutImage(pasted.image);
    const source = pasted.image.viewport?.source as z.infer<typeof clipboardSource> | undefined;
    if (source && isCloudSource(source)) {
      // A cloud view pastes through this document's reference to the same model, created from the copy if needed.
      const existing = source.reference ? [...draft.references.values()].find(reference => isCloudReference(reference) &&
        reference.target.documentId === source.reference!.target.documentId) : draft.references.get(source.referenceId);
      const reference = existing ?? (source.reference ? { id: allocId(draft), ...source.reference } : undefined);
      if (!reference || !isCloudReference(reference)) delete pasted.image.viewport;
      else {
        if (!existing) draft.references.set(reference.id, reference);
        pasted.image.viewport!.source = { referenceId: reference.id };
      }
    } else if (source && !draft.modelArchives?.get(source.archiveId)?.models.has(source.modelReferenceId)) delete pasted.image.viewport;
    return pasted.image.src || pasted.image.viewport ? [pasted] : [];
  });
  if (entities.length === 0) throw new Error('Nothing to paste');
  const bounds = entities.flatMap(entity => entity.text ? entity.points.slice(0, 2) : entity.kind === 'path'
    ? flattenLayoutPath(entity.points, entity.handles, entity.closed, 20, entity.contourStarts) : entity.points);
  const xs = bounds.map(p => p[0]), ys = bounds.map(p => p[1]);
  const center = position ?? [target.size[0] / 2, target.size[1] / 2];
  const delta = [center[0]! - (Math.min(...xs) + Math.max(...xs)) / 2,
    center[1]! - (Math.min(...ys) + Math.max(...ys)) / 2];
  const translate = (p: [number, number]): [number, number] => [p[0] + delta[0]!, p[1] + delta[1]!];
  const store = shapeStore(draft, pageId, layer.id);
  const groups = new Map<number, number>();
  for (const entity of entities) {
    Object.assign(entity, copyGroupMembership(entity, groups, draft));
    if (!entity.name) delete entity.name;
    entity.points = entity.points.map(translate);
    if (entity.handles) entity.handles = entity.handles.map(h => ({ ...(h.in ? { in: translate(h.in) } : {}), ...(h.out ? { out: translate(h.out) } : {}) }));
    if (entity.angularDimension) {
      const problem = angularDimensionError(entity.points);
      if (problem) throw new Error(problem);
    }
    store.entities.set(entity.id, entity); store.order.push(entity.id);
  }
  return entities.map(entity => entity.id);
}

export const layoutCommands: readonly AnyCommand[] = [
  defineCommand({
    id: 'layout.annotation.attachModel', title: 'Attach Annotation to Model', category: 'layout', menu: 'Dimensions',
    params: z.object({ pageId: id, entityId: id, attachments: modelAttachments }),
    undoable: true,
    run: (ctx, params) => host(ctx).edit('Attach Annotation to Model', draft => {
      const entity = editablePath(draft, params.pageId, params.entityId);
      if (entity.kind !== 'dimension' && entity.kind !== 'label') throw new Error('Only dimensions and labels can attach to a model');
      attachModelAnnotation(entity, params.attachments, draft, host(ctx).annotationModels);
    }),
  }),
  defineCommand({
    id: 'layout.annotation.detachModel', title: 'Disconnect Model Annotation', category: 'layout', menu: 'Dimensions',
    params: z.object({ pageId: id, entityId: id }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Disconnect Model Annotation', draft => {
      const entity = editablePath(draft, params.pageId, params.entityId);
      if (!entity.modelAnnotation && !entity.preservedModelConnections) return;
      Object.assign(entity, detachedLayoutModelAnnotation(entity));
      delete entity.modelAnnotation;
      delete entity.preservedModelConnections;
    }),
  }),
  defineCommand({
    id: 'layout.annotation.refreshModels', title: 'Update Model Annotations', category: 'layout', menu: 'Dimensions',
    params: z.object({}), undoable: true,
    run: ctx => host(ctx).edit('Update Model Annotations', () => {}),
  }),
  defineCommand({
    id: 'layout.shape.build', title: 'Build Shapes', category: 'layout', menu: 'Tools', undoable: true,
    params: z.object({ pageId: id, entityIds: z.array(id).min(1), sourceSnapshot: z.string(), keepOriginals: z.boolean(),
      gestures: z.array(z.object({ mode: z.enum(['add', 'remove']), regions: z.array(z.string()).min(1) })).min(1) }),
    run: (ctx, params) => host(ctx).edit('Build Shapes', draft => {
      if (new Set(params.entityIds).size !== params.entityIds.length) throw new Error('Choose distinct paths.');
      const sources = params.entityIds.map(entityId => editablePath(draft, params.pageId, entityId));
      const first = sources[0]!;
      if (sources.some(entity => entity.hidden || entity.groupId !== undefined || entity.layerId !== first.layerId))
        throw new Error('Choose visible, ungrouped paths on the same layer.');
      const store = shapeStore(draft, params.pageId, first.layerId);
      sources.sort((a, b) => store.order.indexOf(a.id) - store.order.indexOf(b.id));
      if (layoutShapeBuildSnapshot(sources) !== params.sourceSnapshot) throw new Error('Shape Builder sources have changed. Start again.');
      const regions = createLayoutShapeRegions(sources);
      const result = replayLayoutShapeBuild(regions, params.gestures);
      const makeReplacement = ({ shape, sourceIndex }: (typeof result.groups)[number]): LayoutEntity => {
        const donor = sources[sourceIndex]!;
        const style = { ...(donor.style ?? plainStyle(draft)) };
        delete style.startArrow; delete style.endArrow;
        return { id: allocId(draft), kind: 'path', layerId: first.layerId, ...shape,
          ...(donor.name !== undefined ? { name: donor.name } : {}),
          style: { ...style, ...(style.strokeDashMm ? { strokeDashMm: [...style.strokeDashMm] } : {}) } };
      };
      const replacements = result.groups.map(makeReplacement);
      const originals = new Map<number, LayoutEntity[]>();
      if (params.keepOriginals && result.sourceIndex !== null) {
        const kept = new Set(result.selected);
        for (const retained of retainedLayoutShapeSources(regions, kept)) {
          const source = sources[retained.sourceIndex]!;
          if (!source.closed || source.openContours?.length) continue;
          const unchanged = regions.filter(region => region.sourceIndices.includes(retained.sourceIndex)).every(region => kept.has(region.key));
          originals.set(source.id, [unchanged ? source : makeReplacement(retained)]);
        }
        sources.forEach((source, sourceIndex) => {
          if (source.closed && !source.openContours?.length) return;
          const retained = retainLayoutShapeOpenSource(source, regions.filter(region => kept.has(region.key)));
          originals.set(source.id, retained.unchanged ? [source] : retained.shapes.map(shape =>
            makeReplacement({ shape, sourceIndex, regions: [] })));
        });
      }
      const ids = new Set(params.entityIds), resultIds = replacements.map(entity => entity.id);
      const front = store.order.filter(entityId => ids.has(entityId)).at(-1)!;
      const order = store.order.flatMap(entityId => [
        ...(ids.has(entityId) ? originals.get(entityId)?.map(entity => entity.id) ?? [] : [entityId]),
        ...(entityId === front ? resultIds : []),
      ]);
      store.order.splice(0, store.order.length, ...order);
      for (const entityId of ids) store.entities.delete(entityId);
      for (const original of [...originals.values()].flat()) store.entities.set(original.id, original);
      for (const entity of replacements) store.entities.set(entity.id, entity);
      return resultIds;
    }),
  }),
  defineCommand({
    id: 'layout.shape.boolean', title: 'Boolean Shapes', category: 'layout', menu: 'Tools',
    params: z.object({ pageId: id, entityIds: z.array(id).min(2), operation: z.enum(LAYOUT_PATH_OPERATIONS) }),
    undoable: true,
    run: (ctx, params) => host(ctx).edit('Boolean Shapes', draft => {
      if (new Set(params.entityIds).size !== params.entityIds.length) throw new Error('Choose distinct paths.');
      const sources = params.entityIds.map(entityId => editablePath(draft, params.pageId, entityId));
      const first = sources[0]!;
      if (sources.some(entity => entity.hidden || entity.groupId !== undefined || entity.layerId !== first.layerId))
        throw new Error('Choose visible, ungrouped paths on the same layer.');
      const results = operateLayoutPaths(sources, params.operation);
      const store = shapeStore(draft, params.pageId, first.layerId);
      const replacements: LayoutEntity[] = results.map(result => ({
        id: allocId(draft), kind: 'path', layerId: first.layerId, ...result,
        ...(first.name !== undefined ? { name: first.name } : {}),
        ...(first.style ? { style: { ...first.style, ...(first.style.strokeDashMm ? { strokeDashMm: [...first.style.strokeDashMm] } : {}) } } : {}),
      }));
      if (params.operation === 'cut-path') for (const replacement of replacements) {
        replacement.style ??= plainStyle(draft);
        replacement.style.fillColor = null;
        // The target's end decorations must not appear at every newly cut end.
        delete replacement.style.startArrow; delete replacement.style.endArrow;
      }
      const resultIds = replacements.map(entity => entity.id);
      // Replace at the target's stacking position; other objects keep their relative order.
      const ids = new Set(params.entityIds);
      const order = store.order.flatMap(entityId => entityId === first.id ? resultIds : ids.has(entityId) ? [] : [entityId]);
      store.order.splice(0, store.order.length, ...order);
      for (const entityId of ids) store.entities.delete(entityId);
      for (const replacement of replacements) store.entities.set(replacement.id, replacement);
      return params.operation === 'division' || params.operation === 'cut-path' ? resultIds : resultIds[0] ?? null;
    }),
  }),
  defineCommand({
    id: 'layout.table.add', title: 'Add Table', category: 'layout', menu: 'Tools', undoable: true,
    params: z.object({ pageId: id, first: point, second: point, rows: z.number().int().min(1).max(100).default(3), columns: z.number().int().min(1).max(100).default(3) }),
    run: (ctx, params) => host(ctx).edit('Add Table', draft => {
      const layer = draft.layers.get(draft.activeLayerId);
      if (!layer || layer.locked || !isLayoutLayerVisible(page(draft, params.pageId), draft, layer.id)) throw new Error('Active layer is unavailable');
      const x = Math.min(params.first[0], params.second[0]), y = Math.min(params.first[1], params.second[1]);
      const right = Math.max(params.first[0], params.second[0]), bottom = Math.max(params.first[1], params.second[1]);
      if (!validTableFrame([[x, y], [right, y], [right, bottom], [x, bottom]])) throw new Error('Table needs a nonzero width and height');
      const entityId = allocId(draft), store = shapeStore(draft, params.pageId, layer.id);
      store.entities.set(entityId, { id: entityId, kind: 'table', layerId: layer.id, closed: true,
        points: [[x, y], [right, y], [right, bottom], [x, bottom]], table: createLayoutTable(params.rows, params.columns), style: plainStyle(draft) });
      store.order.push(entityId); return entityId;
    }),
  }),
  defineCommand({
    id: 'layout.viewport.add', title: 'Add Model View', category: 'layout', menu: 'Tools', undoable: true,
    params: z.object({ pageId: id, first: point, second: point,
      // `model` links a cloud model in the same step, as pasting a Modeling copy does.
      source: z.union([archiveSource, z.object({ referenceId: id }), z.object({ model: cloudModel })]),
      camera: viewportCamera, scene: z.string().nullable().default(null) }),
    run: (ctx, params) => host(ctx).edit('Add Model View', draft => {
      const layer = draft.layers.get(draft.activeLayerId);
      if (!layer || layer.locked || !isLayoutLayerVisible(page(draft, params.pageId), draft, layer.id)) throw new Error('Active layer is unavailable');
      let templateId: string | null = null;
      const source = 'model' in params.source ? { referenceId: cloudReferenceFor(draft, params.source.model) } : params.source;
      if (isCloudSource(source)) {
        if (!isCloudReference(draft.references.get(source.referenceId))) throw new Error('Unknown model');
      } else {
        const archive = draft.modelArchives?.get(source.archiveId);
        if (!archive?.models.has(source.modelReferenceId)) throw new Error('Unknown model');
        // A new view keeps the settings of an imported view of the same model.
        templateId = [...archive.viewports].find(([, record]) => record.modelReferenceId === source.modelReferenceId)?.[0] ?? null;
        if (!templateId) throw new Error('The model has no view to start from');
      }
      const x = Math.min(params.first[0], params.second[0]), y = Math.min(params.first[1], params.second[1]);
      const right = Math.max(params.first[0], params.second[0]), bottom = Math.max(params.first[1], params.second[1]);
      if (right - x < LENGTH_TOL * 1000 || bottom - y < LENGTH_TOL * 1000) throw new Error('A view needs a nonzero width and height');
      const entityId = allocId(draft), store = shapeStore(draft, params.pageId, layer.id);
      store.entities.set(entityId, { id: entityId, kind: 'image', layerId: layer.id, closed: true,
        points: [[x, y], [right, y], [right, bottom], [x, bottom]],
        image: { src: '', viewport: { source: { ...source }, templateId, originalId: null, camera: params.camera, scene: params.scene, background: null, cache: null } } });
      store.order.push(entityId); return entityId;
    }),
  }),
  defineCommand({
    id: 'layout.reference.add', title: 'Link Cloud Model', category: 'layout', menu: 'Tools', undoable: true,
    params: z.object({ displayName: z.string().trim().min(1).max(200), documentId: z.string().min(1), revisionId: z.string().min(1),
      revisionNumber: z.number().int().positive(), sha256 }),
    run: (ctx, params) => host(ctx).edit('Link Cloud Model', draft => {
      // One reference per cloud model: views of the same model share it.
      const existing = [...draft.references.values()].find(reference => isCloudReference(reference) && reference.target.documentId === params.documentId);
      if (existing) return existing.id;
      const referenceId = allocId(draft);
      draft.references.set(referenceId, { id: referenceId, displayName: params.displayName, target: { kind: 'cloud', documentId: params.documentId,
        revisionId: params.revisionId, revisionNumber: params.revisionNumber, sha256: params.sha256, pinned: false } });
      return referenceId;
    }),
  }),
  defineCommand({
    id: 'layout.reference.update', title: 'Update Model Reference', category: 'layout', menu: 'Tools', undoable: true,
    params: z.object({ referenceId: id, revisionId: z.string().min(1), revisionNumber: z.number().int().positive(), sha256 }),
    run: (ctx, params) => host(ctx).edit('Update Model Reference', draft => cloudReference(draft, params.referenceId, params)),
  }),
  defineCommand({
    id: 'layout.reference.follow', title: 'Follow Latest Model Revision', category: 'layout', menu: 'Tools', undoable: false,
    params: z.object({ referenceId: id, revisionId: z.string().min(1), revisionNumber: z.number().int().positive(), sha256 }),
    // Following the model's latest revision is automatic, so it records no undo step.
    run: (ctx, params) => host(ctx).derive('Follow Latest Model Revision', draft => cloudReference(draft, params.referenceId, params, true)),
  }),
  defineCommand({
    id: 'layout.reference.pin', title: 'Pin Model Revision', category: 'layout', menu: 'Tools', undoable: true,
    params: z.object({ referenceId: id, pinned: z.boolean() }),
    run: (ctx, params) => host(ctx).edit(params.pinned ? 'Pin Model Revision' : 'Follow Latest Model Revision', draft => {
      const reference = draft.references.get(params.referenceId);
      if (!isCloudReference(reference)) throw new Error('Unknown model reference');
      reference.target.pinned = params.pinned;
    }),
  }),
  defineCommand({
    id: 'layout.viewport.relink', title: 'Relink Model Views', category: 'layout', menu: 'Tools', undoable: true,
    params: z.object({ source: archiveSource, referenceId: id }),
    // Every view of an embedded model switches to the cloud reference: their pictures stay, now stamped with the revision they show.
    run: (ctx, params) => host(ctx).edit('Relink Model Views', draft => {
      const reference = draft.references.get(params.referenceId);
      if (!isCloudReference(reference)) throw new Error('Unknown model reference');
      let count = 0;
      const stores = [draft.sharedEntities, ...[...draft.pages.values()].map(page => page.entities)];
      for (const store of stores) for (const entity of store.values()) {
        if (!isViewport(entity) || isCloudSource(entity.image.viewport.source)) continue;
        const source = entity.image.viewport.source;
        if (source.archiveId !== params.source.archiveId || source.modelReferenceId !== params.source.modelReferenceId) continue;
        const viewport = entity.image.viewport;
        viewport.source = { referenceId: reference.id };
        viewport.templateId = null;
        viewport.originalId = null;
        if (viewport.cache) viewport.cache.sha256 = reference.target.sha256;
        count++;
      }
      return count;
    }),
  }),
  defineCommand({
    id: 'layout.viewport.snapshot', title: 'Store Model View Render', category: 'layout', menu: 'Tools', undoable: false,
    params: z.object({ pageId: id, entityId: id, src: z.string().regex(pictureSource), cache: viewportCache }),
    // A finished render is derived data: it is saved with the document but adds no undo step.
    run: (ctx, params) => host(ctx).derive('Store Model View Render', draft => {
      const entity = page(draft, params.pageId).entities.get(params.entityId) ?? draft.sharedEntities.get(params.entityId);
      if (!isViewport(entity)) throw new Error('Object is not a model view');
      entity.image.src = params.src;
      entity.image.viewport.cache = params.cache;
    }),
  }),
  defineCommand({
    id: 'layout.viewport.setResizeMode', title: 'Change Model View Resize Mode', category: 'layout', menu: 'Tools', undoable: true,
    params: z.object({ pageId: id, entityId: id, preserveScale: z.boolean() }),
    run: (ctx, params) => host(ctx).edit('Change Model View Resize Mode', draft => {
      const entity = editablePath(draft, params.pageId, params.entityId);
      if (!isViewport(entity)) throw new Error('Object is not a model view');
      entity.image.viewport.preserveScaleOnResize = params.preserveScale;
    }),
  }),
  defineCommand({
    id: 'layout.viewport.setCamera', title: 'Change View', category: 'layout', menu: 'Tools', undoable: true,
    params: z.object({ pageId: id, entityId: id, camera: viewportCamera, scene: z.string().nullable() }),
    run: (ctx, params) => host(ctx).edit('Change View', draft => {
      const entity = editablePath(draft, params.pageId, params.entityId);
      if (!isViewport(entity)) throw new Error('Object is not a model view');
      entity.image.viewport.camera = params.camera;
      entity.image.viewport.scene = params.scene;
    }),
  }),
  defineCommand({
    id: 'layout.table.update', title: 'Edit Table', category: 'layout', menu: 'Tools', undoable: true,
    params: z.object({ pageId: id, entityId: id, table: tableProperties, widthMm: finite.min(LENGTH_TOL * 1000).optional(), heightMm: finite.min(LENGTH_TOL * 1000).optional() }),
    run: (ctx, params) => host(ctx).edit('Edit Table', draft => {
      const entity = editablePath(draft, params.pageId, params.entityId);
      if (!entity.table || entity.kind !== 'table') throw new Error('Entity is not a table');
      const frame = tableFrame(entity), sx = (params.widthMm ?? frame.width) / frame.width, sy = (params.heightMm ?? frame.height) / frame.height;
      entity.points = entity.points.map(([x, y]) => {
        const dx = x - frame.a[0], dy = y - frame.a[1], ux = (frame.b[0] - frame.a[0]) / frame.width, uy = (frame.b[1] - frame.a[1]) / frame.width;
        const along = (dx * ux + dy * uy) * (sx - 1), across = (-dx * uy + dy * ux) * (sy - 1);
        return [x + along * ux - across * uy, y + along * uy + across * ux];
      });
      if (!validTableFrame(entity.points)) throw new Error('Invalid table size');
      entity.table = cloneLayoutTable(params.table);
    }),
  }),
  defineCommand({
    id: 'layout.shape.setLocked', title: 'Lock Objects', category: 'layout', menu: 'Arrange',
    params: z.object({ pageId: id, entityIds: z.array(id).min(1), locked: z.boolean() }), undoable: true,
    run: (ctx, params) => host(ctx).edit(params.locked ? 'Lock Objects' : 'Unlock Objects', draft => {
      for (const entityId of params.entityIds) {
        const { entity } = findShape(draft, params.pageId, entityId);
        const layer = draft.layers.get(entity.layerId);
        if (!layer || !isLayoutLayerVisible(page(draft, params.pageId), draft, layer.id) || layer.locked) throw new Error('Layer is unavailable');
        entity.locked = params.locked;
      }
    }),
  }),
  defineCommand({
    id: 'layout.shape.setHidden', title: 'Hide Objects', category: 'layout', menu: 'Arrange',
    params: z.object({ pageId: id, entityIds: z.array(id).min(1), hidden: z.boolean() }), undoable: true,
    // Like locking, hiding needs the object's layer visible on the page and unlocked; locked objects can still be hidden.
    run: (ctx, params) => host(ctx).edit(params.hidden ? 'Hide Objects' : 'Show Objects', draft => {
      for (const entityId of params.entityIds) {
        const { entity } = findShape(draft, params.pageId, entityId);
        const layer = draft.layers.get(entity.layerId);
        if (!layer || !isLayoutLayerVisible(page(draft, params.pageId), draft, layer.id) || layer.locked) throw new Error('Layer is unavailable');
        if (params.hidden) entity.hidden = true;
        else delete entity.hidden;
      }
    }),
  }),
  defineCommand({
    id: 'layout.shape.group', title: 'Make Group', category: 'layout', menu: 'Arrange',
    params: z.object({ pageId: id, entityIds: z.array(id).min(2) }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Make Group', draft => {
      const entities = [...new Set(params.entityIds)].map(entityId => editablePath(draft, params.pageId, entityId));
      if (entities.length < 2) throw new Error('Select at least two objects');
      if (entities.some(entity => draft.layers.get(entity.layerId)?.shared !== draft.layers.get(entities[0]!.layerId)?.shared))
        throw new Error('Groups cannot mix shared and page layers');
      const groupId = allocId(draft);
      for (const entity of entities) {
        if (entity.groupId !== undefined) entity.nestedGroupIds = [entity.groupId, ...(entity.nestedGroupIds ?? [])];
        entity.groupId = groupId;
      }
      return groupId;
    }),
  }),
  defineCommand({
    id: 'layout.shape.ungroup', title: 'Ungroup', category: 'layout', menu: 'Arrange',
    params: z.object({ pageId: id, entityIds: z.array(id).min(1) }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Ungroup', draft => {
      for (const entityId of params.entityIds) {
        const entity = editablePath(draft, params.pageId, entityId);
        const [next, ...rest] = entity.nestedGroupIds ?? [];
        if (next === undefined) delete entity.groupId;
        else entity.groupId = next;
        if (rest.length) entity.nestedGroupIds = rest;
        else delete entity.nestedGroupIds;
      }
    }),
  }),
  /** Names are organizational, so locked and hidden objects can be renamed; an empty name restores the default. */
  defineCommand({
    id: 'layout.shape.rename', title: 'Rename Object', category: 'layout', menu: 'Arrange',
    params: z.object({ pageId: id, entityId: id, name: z.string().trim().max(LAYOUT_OBJECT_NAME_MAX) }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Rename Object', draft => {
      const { entity } = findShape(draft, params.pageId, params.entityId);
      if (params.name) { if (entity.name !== params.name) entity.name = params.name; }
      else if (entity.name !== undefined) delete entity.name;
    }),
  }),
  defineCommand({
    id: 'layout.snap.set', title: 'Object Snap', category: 'layout', menu: 'View',
    params: z.object({ enabled: z.boolean() }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Object Snap', draft => { draft.settings.objectSnap = params.enabled; }),
  }),
  defineCommand({
    id: 'layout.clipboard.paste', title: 'Paste Layout Object', category: 'layout', menu: 'Edit',
    params: z.object({ pageId: id, entities: z.array(clipboardEntity).min(1), position: point.optional() }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Paste', draft => pasteEntities(draft, params.pageId, params.entities, params.position)),
  }),
  defineCommand({
    id: 'layout.dxf.import', title: 'Import DXF', category: 'layout', menu: 'File',
    params: z.object({ pageId: id, entities: z.array(clipboardEntity).min(1) }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Import DXF', draft => pasteEntities(draft, params.pageId, params.entities)),
  }),
  defineCommand({
    id: 'layout.path.corner', title: 'Fillet or Chamfer', category: 'layout', menu: 'Tools',
    params: z.object({ pageId: id, kind: z.enum(['fillet', 'chamfer']), amountMm: finite.positive(),
      first: z.object({ entityId: id, segmentIndex: z.number().int().nonnegative(), point: point.optional() }),
      second: z.object({ entityId: id, segmentIndex: z.number().int().nonnegative(), point: point.optional() }) }), undoable: true,
    run: (ctx, params) => host(ctx).edit(params.kind === 'fillet' ? 'Fillet' : 'Chamfer', draft => {
      const first = editablePath(draft, params.pageId, params.first.entityId), second = editablePath(draft, params.pageId, params.second.entityId);
      if (first.kind !== 'path' || second.kind !== 'path') throw new Error('Choose paths to edit.');
      if (first.layerId !== second.layerId) throw new Error('Both paths must be on the same layer.');
      const shape = createLayoutCornerBetween(first, params.first.segmentIndex, second, params.second.segmentIndex,
        params.kind, params.amountMm, first.id === second.id, params.first.point, params.second.point);
      Object.assign(first, shape);
      if (first.id !== second.id) {
        const store = shapeStore(draft, params.pageId, second.layerId);
        store.entities.delete(second.id); store.order.splice(store.order.indexOf(second.id), 1);
      }
      return first.id;
    }),
  }),
  defineCommand({
    id: 'layout.path.offset', title: 'Offset Path', category: 'layout', menu: 'Tools',
    params: z.object({ pageId: id, entityId: id, distanceMm: finite }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Offset Path', draft => {
      const source = editablePath(draft, params.pageId, params.entityId);
      if (source.kind !== 'path') throw new Error('Choose a path to offset.');
      const shape = createLayoutOffset(source, params.distanceMm), entityId = allocId(draft);
      const store = shapeStore(draft, params.pageId, source.layerId);
      store.entities.set(entityId, { id: entityId, kind: 'path', layerId: source.layerId, ...shape,
        ...(source.style ? { style: { ...source.style } } : {}) });
      // Positive offsets expand a closed source; keep its inherited fill behind the source.
      if (source.closed && params.distanceMm > 0) store.order.splice(store.order.indexOf(source.id), 0, entityId);
      else store.order.push(entityId);
      return entityId;
    }),
  }),
  defineCommand({
    id: 'layout.arc.add', title: 'Draw Arc', category: 'layout', menu: 'Tools',
    params: z.object({ pageId: id, kind: z.enum(LAYOUT_ARC_KINDS), points: z.tuple([point, point, point]), sweep: finite.optional() }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Draw Arc', (draft) => {
      const layer = draft.layers.get(draft.activeLayerId);
      if (!layer || layer.locked || !isLayoutLayerVisible(page(draft, params.pageId), draft, layer.id)) throw new Error('Active layer is unavailable');
      const shape = createLayoutArc(params.kind, ...params.points, params.sweep);
      const store = shapeStore(draft, params.pageId, layer.id), entityId = allocId(draft);
      store.entities.set(entityId, { id: entityId, kind: 'path', layerId: layer.id, ...shape,
        style: newShapeStyle(draft, shape.closed) });
      store.order.push(entityId); return entityId;
    }),
  }),
  defineCommand({
    id: 'layout.rectangle.add', title: 'Draw Rectangle', category: 'layout', menu: 'Tools',
    params: z.object({ pageId: id, kind: z.enum(LAYOUT_RECTANGLE_KINDS), first: point, second: point,
      amountMm: finite.nonnegative().default(5) }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Draw Rectangle', (draft) => {
      const layer = draft.layers.get(draft.activeLayerId);
      if (!layer || layer.locked || !isLayoutLayerVisible(page(draft, params.pageId), draft, layer.id)) throw new Error('Active layer is unavailable');
      const shape = createLayoutRectangle(params.kind, params.first, params.second, params.amountMm);
      const store = shapeStore(draft, params.pageId, layer.id);
      const entityId = allocId(draft);
      store.entities.set(entityId, { id: entityId, kind: 'path', layerId: layer.id, ...shape, style: newShapeStyle(draft, true) });
      store.order.push(entityId); return entityId;
    }),
  }),
  defineCommand({
    id: 'layout.path.addLine', title: 'Draw Connected Line', category: 'layout', menu: 'Tools',
    params: z.object({ pageId: id, start: point, end: point }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Draw Connected Line', (draft) => addLayoutLine(draft, params.pageId, params.start, params.end)),
  }),
  defineCommand({
    id: 'layout.dimension.addAngular', title: 'Angular Dimension', category: 'layout', menu: 'Tools',
    params: z.object({ pageId: id, points: z.tuple([point, point, point, point]),
      anchors: z.tuple([dimensionAnchor, dimensionAnchor, dimensionAnchor]).optional(),
      edgeAnchors: z.tuple([angularEdgeAnchor, angularEdgeAnchor]).optional(),
      rayDefinition: z.object({ points: z.tuple([point, point, point, point]), anchors: z.tuple([dimensionAnchor, dimensionAnchor, dimensionAnchor, dimensionAnchor]) }).optional(), style: angularStyle.optional() }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Angular Dimension', (draft) => {
      const layer = draft.layers.get(draft.activeLayerId);
      if (!layer || layer.locked || !isLayoutLayerVisible(page(draft, params.pageId), draft, layer.id)) throw new Error('Active layer is unavailable');
      const target = page(draft, params.pageId);
      const dimension = createAngularDimension();
      Object.assign(dimension, params.style);
      dimension.anchors = params.anchors ?? [null, null, null];
      const points = params.points.map(point => [...point] as [number, number]);
      if (params.rayDefinition) {
        if (params.edgeAnchors || dimension.anchors.some(Boolean)) throw new Error('Choose only one angular measurement definition.');
        const rays = params.rayDefinition;
        const actual = rays.points.map((p, index) => {
          const anchor = rays.anchors[index];
          if (!anchor) return p;
          const source = layer.shared ? draft.sharedEntities.get(anchor.entityId) : target.entities.get(anchor.entityId) ?? draft.sharedEntities.get(anchor.entityId);
          const at = source && layoutAnchorOnPath(source, anchor);
          if (!at) throw new Error('Dimension anchor is unavailable');
          return at;
        });
        points.splice(0, 3, ...angularRaysFromPoints(actual));
        if (rays.anchors.some(Boolean)) dimension.rayDefinition = { ...rays, points: actual as typeof rays.points };
      }
      if (params.edgeAnchors) {
        if (dimension.anchors.some(Boolean)) throw new Error('Choose vertex anchors or edge anchors, not both.');
        const resolved = resolveAngularEdgePoints(params.edgeAnchors, id => layer.shared ? draft.sharedEntities.get(id)
          : target.entities.get(id) ?? draft.sharedEntities.get(id));
        points.splice(0, 3, ...resolved); dimension.edgeAnchors = params.edgeAnchors;
      }
      for (const [index, anchor] of dimension.anchors.entries()) {
        if (!anchor) continue;
        const source = layer.shared ? draft.sharedEntities.get(anchor.entityId)
          : target.entities.get(anchor.entityId) ?? draft.sharedEntities.get(anchor.entityId);
        const at = source && layoutAnchorOnPath(source, anchor);
        if (!at) throw new Error('Dimension anchor is unavailable');
        points[index] = at;
      }
      const store = shapeStore(draft, params.pageId, draft.activeLayerId);
      const entityId = allocId(draft);
      store.entities.set(entityId, { id: entityId, kind: 'angular-dimension', layerId: draft.activeLayerId,
        points, closed: false, angularDimension: dimension, style: plainStyle(draft) });
      store.order.push(entityId);
      refreshLayoutDimensions(draft);
      const added = store.entities.get(entityId)!;
      const angle = angularMeasurement(added.points[0]!, added.points[1]!, added.points[2]!);
      const problem = angularDimensionError(added.points);
      if (problem) throw new Error(problem);
      if (angle === null) throw new Error('Angular dimension needs two distinct rays');
      return entityId;
    }),
  }),
  defineCommand({
    id: 'layout.dimension.updateAngular', title: 'Edit Angular Dimension', category: 'layout', menu: 'Dimensions',
    params: z.object({ pageId: id, entityId: id, style: angularStyle.optional(), placement: point.optional(),
      detach: z.boolean().optional() }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Edit Angular Dimension', (draft) => {
      const entity = editablePath(draft, params.pageId, params.entityId);
      if (!entity.angularDimension) throw new Error('Entity is not an angular dimension');
      const previousReflex = entity.angularDimension.reflex;
      if (params.style) Object.assign(entity.angularDimension, params.style);
      if (previousReflex !== entity.angularDimension.reflex)
        entity.angularDimension.cachedAngleDeg = 360 - entity.angularDimension.cachedAngleDeg;
      if (params.placement) {
        const problem = angularDimensionError([...entity.points.slice(0, 3), params.placement]);
        if (problem) throw new Error(problem);
        entity.points[3] = params.placement;
      }
      if (params.detach) { entity.angularDimension.anchors = [null, null, null]; delete entity.angularDimension.edgeAnchors; delete entity.angularDimension.rayDefinition; }
    }),
  }),
  defineCommand({
    id: 'layout.dimension.add', title: 'Linear Dimension', category: 'layout', menu: 'Tools',
    params: z.object({ pageId: id, points: z.tuple([point, point, point]),
      anchors: z.tuple([dimensionAnchor, dimensionAnchor]).optional(), style: dimensionStyle.optional(), modelAttachments: modelAttachments.optional() }),
    undoable: true,
    run: (ctx, params) => host(ctx).edit('Linear Dimension', (draft) => {
      const layer = draft.layers.get(draft.activeLayerId);
      if (!layer || layer.locked || !isLayoutLayerVisible(page(draft, params.pageId), draft, layer.id)) throw new Error('Active layer is unavailable');
      const target = page(draft, params.pageId);
      // New dimensions measure in the drawing units unless a style says otherwise.
      const dimension = { ...createLinearDimension(), ...layoutDimensionUnits(draft) };
      Object.assign(dimension, params.style);
      dimension.anchors = params.anchors ?? [null, null];
      for (const anchor of dimension.anchors) {
        if (!anchor) continue;
        const source = layer.shared ? draft.sharedEntities.get(anchor.entityId)
          : target.entities.get(anchor.entityId) ?? draft.sharedEntities.get(anchor.entityId);
        if (!source || !layoutAnchorOnPath(source, anchor)) throw new Error('Dimension anchor is unavailable');
      }
      const store = shapeStore(draft, params.pageId, draft.activeLayerId);
      const entityId = allocId(draft);
      const entity: LayoutEntity = { id: entityId, kind: 'dimension', layerId: draft.activeLayerId,
        points: params.points, closed: false, dimension: { ...dimension, anchors: [dimension.anchors[0]!, dimension.anchors[1]!] },
        style: plainStyle(draft) };
      // Resolve associations before checking the measured length.
      store.entities.set(entityId, entity); store.order.push(entityId);
      refreshLayoutDimensions(draft);
      const added = store.entities.get(entityId)!;
      if (params.modelAttachments) attachModelAnnotation(added, params.modelAttachments, draft, host(ctx).annotationModels);
      if (linearMeasurement(added.points[0]!, added.points[1]!, added.dimension!.alignment, added.dimension!.angleDeg) < 1e-6)
        throw new Error('Dimension needs two distinct measurement points');
      return entityId;
    }),
  }),
  defineCommand({
    id: 'layout.dimension.update', title: 'Edit Dimension', category: 'layout', menu: 'Dimensions',
    params: z.object({ pageId: id, entityId: id, style: dimensionStyle.optional(), placement: point.optional(),
      detach: z.boolean().optional() }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Edit Dimension', (draft) => {
      const entity = editablePath(draft, params.pageId, params.entityId);
      if (!entity.dimension) throw new Error('Entity is not a dimension');
      if (entity.modelAnnotation && (params.style?.scale !== undefined || params.detach))
        throw new Error('Disconnect the model annotation before changing its measurement scale');
      if (params.style) Object.assign(entity.dimension, params.style);
      // A dimension made rotated without an angle keeps its measured direction.
      if (entity.dimension.alignment === 'rotated') {
        const [a, b] = entity.points;
        entity.dimension.angleDeg = normalizeDimensionAngle(entity.dimension.angleDeg ?? Math.atan2(b![1] - a![1], b![0] - a![0]) * 180 / Math.PI);
      }
      if (params.placement) entity.points[2] = params.placement;
      if (params.detach) entity.dimension.anchors = [null, null];
    }),
  }),
  defineCommand({
    id: 'layout.document.setField', title: 'Set Auto-text Field', category: 'layout', menu: 'Text',
    params: z.object({ name: z.string().trim().min(1), value: z.string() }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Set Auto-text Field', (draft) => {
      // A name is one kind of field: a text value replaces its page numbering.
      draft.pageNumberFields?.delete(params.name);
      draft.customFields.set(params.name, params.value);
    }),
  }),
  defineCommand({
    id: 'layout.document.setPageNumbering', title: 'Set Page Numbering', category: 'layout', menu: 'Text',
    params: z.object({
      name: z.string().trim().min(1).regex(/^[^<>\r\n]+$/),
      /** null: `<PageNumber>` returns to its default; another name stops being a page-number field. */
      numbering: z.object({
        startPageId: id.nullable(),
        startNumber: z.number().int().min(0).max(99999),
        style: z.enum(LAYOUT_PAGE_NUMBER_STYLES),
      }).nullable(),
    }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Set Page Numbering', (draft) => {
      if (LAYOUT_NON_PAGE_NUMBER_TAGS.includes(params.name)) throw new Error(`<${params.name}> cannot number pages`);
      if (!params.numbering) { draft.pageNumberFields?.delete(params.name); return; }
      if (params.numbering.startPageId !== null && !draft.pages.has(params.numbering.startPageId)) throw new Error('Start page not found');
      draft.customFields.delete(params.name);
      (draft.pageNumberFields ??= new Map()).set(params.name, { ...params.numbering });
    }),
  }),
  defineCommand({
    id: 'layout.text.setBounds', title: 'Resize Text or Set Label Anchor', category: 'layout', menu: 'Text',
    params: z.object({ pageId: id, entityId: id, widthMm: finite.positive().optional(),
      heightMm: finite.positive().optional(), anchor: point.optional(),
      bounds: z.tuple([point, point]).optional(), bounded: z.boolean().optional() }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Resize Text or Set Label Anchor', (draft) => {
      const entity = editablePath(draft, params.pageId, params.entityId);
      if (!entity.text) throw new Error('Entity has no text');
      const original = { ...entity, points: entity.points.map(p => [...p] as [number, number]) };
      if (params.bounds) {
        const [first, second] = params.bounds;
        const width = Math.abs(second[0] - first[0]), height = Math.abs(second[1] - first[1]);
        if (width <= 0 || height <= 0) throw new Error('Text bounds must have positive width and height');
        const centerY = (entity.points[0]![1] + entity.points[1]![1]) / 2;
        entity.points[0] = [Math.min(first[0], second[0]), entity.kind === 'label' ? centerY - height / 2 : Math.min(first[1], second[1])];
        entity.points[1] = [Math.max(first[0], second[0]), entity.kind === 'label' ? centerY + height / 2 : Math.max(first[1], second[1])];
      }
      if (params.bounds || params.widthMm !== undefined || params.heightMm !== undefined)
        entity.text.bounded = params.bounded ?? true;
      const a = entity.points[0]!, b = entity.points[1]!;
      const bend = entity.kind === 'label' ? entity.points[3] : undefined;
      const centerY = (a[1] + b[1]) / 2;
      if (params.widthMm !== undefined) {
        if (bend && bend[0] > (a[0] + b[0]) / 2) a[0] = b[0] - params.widthMm;
        else b[0] = a[0] + params.widthMm;
      }
      if (params.heightMm !== undefined) {
        if (bend) { a[1] = centerY - params.heightMm / 2; b[1] = centerY + params.heightMm / 2; }
        else b[1] = a[1] + params.heightMm;
      }
      if (params.bounds || params.widthMm !== undefined || params.heightMm !== undefined)
        entity.points = resizeLayoutTextPoints(original, entity.points.slice(0, 2));
      if (params.anchor) {
        if (entity.kind !== 'label') throw new Error('Only labels have paper anchors');
        entity.points[2] = params.anchor;
        delete entity.labelAnchor;
      }
    }),
  }),
  defineCommand({
    id: 'layout.text.add', title: 'Add Text or Label', category: 'layout', menu: 'Tools',
    params: z.object({ pageId: id, kind: z.enum(['text', 'label']),
      points: z.array(point).min(2).max(4), text: textProperties, labelAnchor: dimensionAnchor.optional(), modelAttachments: modelAttachments.optional() }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Add Text or Label', (draft) => {
      if (params.kind === 'label' && ![3, 4].includes(params.points.length)) throw new Error('Label needs a paper anchor and optional bend');
      if (params.kind === 'text' && params.points.length !== 2) throw new Error('Text needs two bounds points');
      const layer = draft.layers.get(draft.activeLayerId);
      if (!layer || layer.locked || !isLayoutLayerVisible(page(draft, params.pageId), draft, layer.id)) throw new Error('Active layer is unavailable');
      const store = shapeStore(draft, params.pageId, draft.activeLayerId);
      const entityId = allocId(draft);
      const { spans, list, lineSpacing, tabStopsPt, ...text } = params.text;
      if (params.labelAnchor && params.kind !== 'label') throw new Error('Only labels can have a label anchor');
      const labelAnchor = params.labelAnchor;
      if (labelAnchor && !resolveLayoutLabelAnchor({ id: entityId, kind: 'label', layerId: layer.id,
        points: params.points, closed: false, text, labelAnchor }, sourceId => layer.shared ? draft.sharedEntities.get(sourceId)
          : (page(draft, params.pageId).entities.get(sourceId) ?? draft.sharedEntities.get(sourceId)))) throw new Error('Label anchor is unavailable');
      store.entities.set(entityId, { id: entityId, kind: params.kind, layerId: draft.activeLayerId,
        points: params.points, closed: false,
        ...(labelAnchor ? { labelAnchor: { ...labelAnchor } } : {}),
        text: { ...text, ...(spans === undefined ? {} : { spans }),
          ...(list === undefined ? {} : { list }), ...(lineSpacing === undefined ? {} : { lineSpacing }),
          ...(tabStopsPt === undefined ? {} : { tabStopsPt }) },
        style: plainStyle(draft) });
      store.order.push(entityId);
      if (params.modelAttachments) attachModelAnnotation(store.entities.get(entityId)!, params.modelAttachments, draft, host(ctx).annotationModels);
      return entityId;
    }),
  }),
  defineCommand({
    id: 'layout.text.update', title: 'Edit Text or Label', category: 'layout', menu: 'Text',
    params: z.object({ pageId: id, entityId: id, text: textProperties.partial() }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Edit Text or Label', (draft) => {
      const entity = editablePath(draft, params.pageId, params.entityId);
      if (!entity.text) throw new Error('Entity has no text');
      Object.assign(entity.text, params.text);
    }),
  }),
  defineCommand({
    id: 'layout.page.add',
    title: 'Add Page',
    category: 'layout',
    menu: 'Pages',
    params: z.object({ name: z.string().trim().min(1).optional(), afterId: id.optional() }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Add Page', (draft) => {
        const pageId = allocId(draft);
        const name = params.name ?? `Page ${draft.pageOrder.length + 1}`;
        // A new page takes the document's paper size and margin.
        const reference = draft.pages.get(draft.pageOrder[0]!);
        draft.pages.set(pageId, {
          id: pageId,
          name,
          size: reference ? [reference.size[0], reference.size[1]] : [297, 210],
          margin: reference ? { ...reference.margin } : { top: 10, right: 10, bottom: 10, left: 10 },
          background: '#ffffff',
          entities: new Map(),
          entityOrder: [],
        });
        const index =
          params.afterId === undefined
            ? draft.pageOrder.length
            : draft.pageOrder.indexOf(params.afterId) + 1;
        if (index === 0) throw new Error(`Unknown page: ${params.afterId}`);
        draft.pageOrder.splice(index, 0, pageId);
        return pageId;
      }),
  }),
  defineCommand({
    id: 'layout.page.rename',
    title: 'Rename Page',
    category: 'layout',
    menu: 'Pages',
    params: z.object({ pageId: id, name: z.string().trim().min(1) }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Rename Page', (draft) => {
        page(draft, params.pageId).name = params.name;
      }),
  }),
  defineCommand({
    id: 'layout.page.delete',
    title: 'Delete Page',
    category: 'layout',
    menu: 'Pages',
    params: z.object({ pageId: id }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Delete Page', (draft) => {
        if (draft.pageOrder.length === 1) throw new Error('A layout needs at least one page');
        page(draft, params.pageId);
        draft.pages.delete(params.pageId);
        draft.pageOrder.splice(draft.pageOrder.indexOf(params.pageId), 1);
      }),
  }),
  defineCommand({
    id: 'layout.page.duplicate',
    title: 'Duplicate Page',
    category: 'layout',
    menu: 'Pages',
    params: z.object({ pageId: id }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Duplicate Page', (draft) => {
        const source = page(draft, params.pageId);
        const pageId = allocId(draft);
        const copies = copyLayoutEntities(source.entityOrder.flatMap((entityId) => source.entities.get(entityId) ?? []), draft);
        const entities = new Map(copies.map((entity) => [entity.id, entity]));
        const entityOrder = copies.map((entity) => entity.id);
        draft.pages.set(pageId, {
          ...source,
          ...(source.nativeUnknownFields ? { nativeUnknownFields: cloneLayoutValue(source.nativeUnknownFields) } : {}),
          id: pageId,
          name: `${source.name} Copy`,
          size: [...source.size],
          margin: { ...source.margin },
          background: source.background,
          ...(source.layerVisibility ? { layerVisibility: new Map(source.layerVisibility) } : {}),
          entities,
          entityOrder,
        });
        draft.pageOrder.splice(draft.pageOrder.indexOf(params.pageId) + 1, 0, pageId);
        return pageId;
      }),
  }),
  defineCommand({
    id: 'layout.page.move',
    title: 'Move Page',
    category: 'layout',
    menu: 'Pages',
    params: z.object({ pageId: id, toIndex: z.number().int().min(0) }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Move Page', (draft) => {
        const from = draft.pageOrder.indexOf(params.pageId);
        if (from < 0 || params.toIndex >= draft.pageOrder.length)
          throw new Error('Invalid page move');
        draft.pageOrder.splice(from, 1);
        draft.pageOrder.splice(params.toIndex, 0, params.pageId);
      }),
  }),
  defineCommand({
    id: 'layout.document.setup',
    title: 'Document Setup',
    category: 'layout',
    menu: 'Pages',
    // Paper size and margin belong to the document, so every page changes together.
    // `units` are the page size units; `gridUnits` set the grid's, which drawing values follow (a paper preset sets both).
    params: z.object({ widthMm: finite.positive().optional(), heightMm: finite.positive().optional(), marginMm: finite.min(0).optional(),
      units: z.enum(['mm', 'in']).optional(), gridUnits: z.enum(['mm', 'in']).optional() }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Document Setup', (draft) => {
        if (params.units !== undefined) draft.settings.paperUnits = params.units;
        if (params.gridUnits !== undefined) setLayoutGridUnits(draft.settings, params.gridUnits);
        const reference = page(draft, draft.pageOrder[0]!);
        const width = params.widthMm ?? reference.size[0];
        const height = params.heightMm ?? reference.size[1];
        const margin = params.marginMm ?? reference.margin.left;
        if (margin * 2 >= Math.min(width, height)) throw new Error('Margins exceed page size');
        for (const target of draft.pages.values()) {
          if (target.size[0] !== width || target.size[1] !== height) target.size = [width, height];
          if (params.marginMm !== undefined) target.margin = { top: margin, right: margin, bottom: margin, left: margin };
        }
      }),
  }),
  defineCommand({
    id: 'layout.page.setup',
    title: 'Page Setup',
    category: 'layout',
    menu: 'Pages',
    params: z.object({
      pageId: id,
      widthMm: finite.positive().optional(),
      heightMm: finite.positive().optional(),
      marginMm: finite.min(0).optional(),
      background: color.optional(),
    }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Page Setup', (draft) => {
        const target = page(draft, params.pageId);
        const width = params.widthMm ?? target.size[0];
        const height = params.heightMm ?? target.size[1];
        const margin = params.marginMm ?? target.margin.left;
        if (margin * 2 >= Math.min(width, height)) throw new Error('Margins exceed page size');
        target.size = [width, height];
        if (params.marginMm !== undefined)
          target.margin = { top: margin, right: margin, bottom: margin, left: margin };
        if (params.background !== undefined) target.background = params.background;
      }),
  }),
  defineCommand({
    id: 'layout.layer.add',
    title: 'Add Layer',
    category: 'layout',
    menu: 'Layers',
    params: z.object({ name: z.string().trim().min(1), shared: z.boolean().default(false) }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Add Layer', (draft) => {
        const layerId = allocId(draft);
        draft.layers.set(layerId, {
          id: layerId,
          name: params.name,
          visible: true,
          locked: false,
          shared: params.shared,
        });
        draft.layerOrder.push(layerId);
        draft.activeLayerId = layerId;
        return layerId;
      }),
  }),
  /** Renaming works on locked and hidden layers. */
  defineCommand({
    id: 'layout.layer.rename', title: 'Rename Layer', category: 'layout', menu: 'Layers',
    params: z.object({ layerId: id, name: z.string().trim().min(1) }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Rename Layer', (draft) => {
      const layer = draft.layers.get(params.layerId);
      if (!layer) throw new Error('Unknown layer');
      layer.name = params.name;
    }),
  }),
  defineCommand({
    id: 'layout.layer.setShared', title: 'Show Layer on Every Page', category: 'layout', menu: 'Layers',
    params: z.object({ pageId: id, layerId: id, shared: z.boolean(), source: z.enum(['current', 'all']).optional() }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Change Layer Page Scope', (draft) => {
      const current = page(draft, params.pageId);
      const layer = draft.layers.get(params.layerId);
      if (!layer || layer.locked) throw new Error('Unlock this layer before changing its page scope.');
      if (layer.shared === params.shared) return;
      const remapAnchors = (entity: LayoutEntity, ids: Map<number, number>) => {
        if (entity.labelAnchor) entity.labelAnchor.entityId = ids.get(entity.labelAnchor.entityId) ?? entity.labelAnchor.entityId;
        const dimension = entity.dimension ?? entity.angularDimension;
        if (dimension) dimension.anchors = dimension.anchors.map(anchor => anchor
          ? { ...anchor, entityId: ids.get(anchor.entityId) ?? anchor.entityId } : null) as typeof dimension.anchors;
        if (entity.angularDimension?.edgeAnchors) for (const edge of entity.angularDimension.edgeAnchors)
          edge.entityId = ids.get(edge.entityId) ?? edge.entityId;
        if (entity.angularDimension?.rayDefinition) for (const anchor of entity.angularDimension.rayDefinition.anchors)
          if (anchor) anchor.entityId = ids.get(anchor.entityId) ?? anchor.entityId;
      };
      if (params.shared) {
        const sourcePages = params.source === 'all' ? draft.pageOrder.map(pageId => page(draft, pageId)) : [current];
        const source = sourcePages.flatMap(target => target.entityOrder.map(entityId => target.entities.get(entityId)!)
          .filter(entity => entity.layerId === params.layerId));
        const signature = (entities: LayoutEntity[]) => {
          const ids = new Map(entities.map((entity, index) => [entity.id, -index - 1]));
          return entities.map(entity => {
            const copy = cloneLayoutValue(entity);
            copy.id = 0; remapAnchors(copy, ids); return copy;
          });
        };
        const expected = signature(source);
        const remapped = new Map<number, number>();
        for (const target of draft.pages.values()) {
          if (target.id === current.id) continue;
          const contents = target.entityOrder.map(entityId => target.entities.get(entityId)!)
            .filter(entity => entity.layerId === params.layerId);
          const identical = layoutValuesEqual(signature(contents), expected);
          if (contents.length && !identical && params.source === undefined)
            throw new Error('Choose whether to include the current page or collect objects from all pages.');
          if (params.source !== 'all' && identical) contents.forEach((entity, index) => remapped.set(entity.id, source[index]!.id));
        }
        for (const target of draft.pages.values()) {
          for (const [entityId, entity] of target.entities) {
            if (entity.layerId === params.layerId) target.entities.delete(entityId);
            else remapAnchors(entity, remapped);
          }
          target.entityOrder = target.entityOrder.filter(entityId => target.entities.has(entityId));
        }
        for (const entity of source) {
          draft.sharedEntities.set(entity.id, entity);
          draft.sharedEntityOrder.push(entity.id);
        }
      } else {
        const source = draft.sharedEntityOrder.map(entityId => draft.sharedEntities.get(entityId)!)
          .filter(entity => entity.layerId === params.layerId);
        for (const target of draft.pages.values()) {
          const ids = new Map(source.map(entity => [entity.id, target.id === current.id ? entity.id : allocId(draft)]));
          for (const entity of source) {
            const copy = cloneLayoutValue(entity);
            copy.id = ids.get(entity.id)!; remapAnchors(copy, ids);
            target.entities.set(copy.id, copy); target.entityOrder.push(copy.id);
          }
          for (const entity of target.entities.values()) remapAnchors(entity, ids);
        }
        for (const entity of source) draft.sharedEntities.delete(entity.id);
        draft.sharedEntityOrder = draft.sharedEntityOrder.filter(entityId => draft.sharedEntities.has(entityId));
      }
      layer.shared = params.shared;
    }),
  }),
  defineCommand({
    id: 'layout.layer.duplicate',
    title: 'Duplicate Layer',
    category: 'layout',
    menu: 'Layers',
    params: z.object({ layerId: id }),
    undoable: true,
    // The copy sits directly above the original with its settings and a copy of its objects on every page.
    run: (ctx, params) =>
      host(ctx).edit('Duplicate Layer', (draft) => {
        const source = draft.layers.get(params.layerId);
        if (!source) throw new Error('Unknown layer');
        const layerId = allocId(draft);
        draft.layers.set(layerId, { id: layerId, name: `${source.name} Copy`, visible: source.visible, locked: source.locked, shared: source.shared });
        draft.layerOrder.splice(draft.layerOrder.indexOf(params.layerId) + 1, 0, layerId);
        const copyInto = (store: { entities: Map<number, LayoutEntity>; order: number[] }): void => {
          const copies = copyLayoutEntities(store.order.flatMap((entityId) => {
            const entity = store.entities.get(entityId);
            return entity?.layerId === params.layerId ? [entity] : [];
          }), draft, layerId);
          for (const copy of copies) { store.entities.set(copy.id, copy); store.order.push(copy.id); }
        };
        if (source.shared) copyInto({ entities: draft.sharedEntities, order: draft.sharedEntityOrder });
        for (const target of draft.pages.values()) {
          if (!source.shared) copyInto({ entities: target.entities, order: target.entityOrder });
          const visible = target.layerVisibility?.get(params.layerId);
          if (visible !== undefined) target.layerVisibility!.set(layerId, visible);
        }
        return layerId;
      }),
  }),
  defineCommand({
    id: 'layout.layer.delete',
    title: 'Delete Layer', category: 'layout', menu: 'Layers',
    params: z.object({ layerId: id }), undoable: true,
    run: (ctx, params) => host(ctx).edit('Delete Layer', (draft) => {
      const layer = draft.layers.get(params.layerId);
      if (!layer || layer.locked) throw new Error('Layer is unavailable');
      const remaining = draft.layerOrder.filter(candidate => candidate !== params.layerId);
      const next = remaining.find(candidate => !draft.layers.get(candidate)?.locked);
      if (next === undefined) throw new Error('At least one layer must remain editable');
      for (const target of draft.pages.values()) {
        for (const [entityId, entity] of target.entities) {
          if (entity.layerId === params.layerId) target.entities.delete(entityId);
        }
        target.entityOrder = target.entityOrder.filter(entityId => target.entities.has(entityId));
      }
      for (const [entityId, entity] of draft.sharedEntities) {
        if (entity.layerId === params.layerId) draft.sharedEntities.delete(entityId);
      }
      draft.sharedEntityOrder = draft.sharedEntityOrder.filter(entityId => draft.sharedEntities.has(entityId));
      draft.layers.delete(params.layerId);
      for (const target of draft.pages.values()) target.layerVisibility?.delete(params.layerId);
      draft.layerOrder = remaining;
      if (draft.activeLayerId === params.layerId) draft.activeLayerId = next;
    }),
  }),
  defineCommand({
    id: 'layout.layer.activate',
    title: 'Set Active Layer',
    category: 'layout',
    menu: 'Layers',
    params: z.object({ layerId: id }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Set Active Layer', (draft) => {
        const layer = draft.layers.get(params.layerId);
        if (!layer || layer.locked) throw new Error('Layer is unavailable');
        draft.activeLayerId = params.layerId;
      }),
  }),
  defineCommand({
    id: 'layout.layer.setVisible',
    title: 'Set Layer Visibility',
    category: 'layout',
    menu: 'Layers',
    params: z.object({ layerId: id, pageId: id.optional(), visible: z.boolean() }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Set Layer Visibility', (draft) => {
        const layer = draft.layers.get(params.layerId);
        if (!layer) throw new Error('Unknown layer');
        if (params.pageId !== undefined) {
          const target = page(draft, params.pageId);
          target.layerVisibility ??= new Map();
          target.layerVisibility.set(params.layerId, params.visible);
        } else {
          layer.visible = params.visible;
          for (const target of draft.pages.values()) target.layerVisibility?.delete(params.layerId);
        }
      }),
  }),
  defineCommand({
    id: 'layout.layer.setLocked',
    title: 'Set Layer Lock',
    category: 'layout',
    menu: 'Layers',
    params: z.object({ layerId: id, locked: z.boolean() }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Set Layer Lock', (draft) => {
        const layer = draft.layers.get(params.layerId);
        if (!layer) throw new Error('Unknown layer');
        layer.locked = params.locked;
        if (layer.locked && draft.activeLayerId === params.layerId) {
          const next = draft.layerOrder.find((candidate) => !draft.layers.get(candidate)?.locked);
          if (next === undefined) throw new Error('At least one layer must remain editable');
          draft.activeLayerId = next;
        }
      }),
  }),
  defineCommand({
    id: 'layout.layer.move',
    title: 'Reorder Layer',
    category: 'layout',
    menu: 'Layers',
    params: z.object({ layerId: id, toIndex: z.number().int().min(0) }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Reorder Layer', (draft) => {
        const from = draft.layerOrder.indexOf(params.layerId);
        if (from < 0 || params.toIndex >= draft.layerOrder.length)
          throw new Error('Invalid layer move');
        draft.layerOrder.splice(from, 1);
        draft.layerOrder.splice(params.toIndex, 0, params.layerId);
      }),
  }),
  defineCommand({
    id: 'layout.grid.set',
    title: 'Grid Settings',
    category: 'layout',
    menu: 'View',
    params: z.object({
      show: z.boolean().optional(),
      snap: z.boolean().optional(),
      spacingMm: finite.positive().optional(),
      units: z.enum(['mm', 'in']).optional(),
    }).refine(params => params.show !== undefined || params.snap !== undefined || params.spacingMm !== undefined || params.units !== undefined, {
      message: 'Specify a grid setting to change',
    }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Grid Settings', (draft) => {
        // Drawing values follow the grid units; a change of units also rounds the grid size unless one is given.
        if (params.units !== undefined) setLayoutGridUnits(draft.settings, params.units);
        if (params.show !== undefined) draft.settings.grid.show = params.show;
        if (params.snap !== undefined) draft.settings.grid.snap = params.snap;
        if (params.spacingMm !== undefined) draft.settings.grid.spacingMm = params.spacingMm;
      }),
  }),
  defineCommand({
    id: 'layout.grid.toggle', title: 'Toggle Grid', category: 'layout', menu: 'View',
    params: z.object({}), undoable: true,
    run: (ctx) => host(ctx).edit('Toggle Grid', draft => { draft.settings.grid.show = !draft.settings.grid.show; }),
  }),
  defineCommand({
    id: 'layout.style.setDefault',
    title: 'Default Drawing Style',
    category: 'layout',
    menu: 'Styles',
    params: z.object({
      strokeColor: color.optional(),
      strokeWeightPt: finite.positive().optional(),
      fillColor: color.nullable().optional(),
      /** Arrows for new open shapes; null removes one. */
      startArrow: arrow.nullable().optional(),
      endArrow: arrow.nullable().optional(),
    }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Default Drawing Style', (draft) => {
        const { startArrow, endArrow, ...rest } = params;
        Object.assign(draft.defaultStyle, rest);
        setArrows(draft.defaultStyle, startArrow, endArrow);
      }),
  }),
  defineCommand({
    id: 'layout.shape.setStyle',
    title: 'Shape Style',
    category: 'layout',
    menu: 'Styles',
    params: z.object({
      pageId: id,
      entityId: id,
      strokeColor: color.optional(),
      strokeWeightPt: finite.positive().optional(),
      strokeDashMm: strokeDashMm.optional(),
      fillColor: color.nullable().optional(),
      /** null removes the arrow. */
      startArrow: arrow.nullable().optional(),
      endArrow: arrow.nullable().optional(),
    }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Shape Style', (draft) => {
        const entity = editablePath(draft, params.pageId, params.entityId);
        entity.style ??= plainStyle(draft);
        if (params.strokeColor !== undefined) entity.style.strokeColor = params.strokeColor;
        if (params.strokeWeightPt !== undefined) entity.style.strokeWeightPt = params.strokeWeightPt;
        if (params.strokeDashMm?.length) entity.style.strokeDashMm = [...params.strokeDashMm];
        else if (params.strokeDashMm) delete entity.style.strokeDashMm;
        if (params.fillColor !== undefined) entity.style.fillColor = params.fillColor;
        setArrows(entity.style, params.startArrow, params.endArrow);
        // A table's stroke applies to its frame and every grid line, replacing per-line strokes.
        if (entity.table && [params.strokeColor, params.strokeWeightPt, params.strokeDashMm].some(value => value !== undefined)) {
          delete entity.table.rowEdges; delete entity.table.columnEdges;
        }
      }),
  }),
  defineCommand({
    id: 'layout.shape.add',
    title: 'Draw Shape',
    category: 'layout',
    menu: 'Tools',
    params: z.object({
      pageId: id,
      points: z.array(point).min(2),
      handles: z.array(pathHandle).optional(),
      closed: z.boolean().default(false),
      snapStartToleranceMm: finite.positive().optional(),
    }),
    undoable: true,
    run: (ctx, params) => {
      const tx = host(ctx);
      let points = params.points;
      let handles = cloneHandles(params.handles);
      if (params.snapStartToleranceMm !== undefined) {
        const target = tx.doc.state.pages.get(params.pageId);
        if (!target) throw new Error(`Unknown page: ${params.pageId}`);
        const snapped = snapPaperPoint(
          params.points[0]!, target, tx.doc.state, params.snapStartToleranceMm,
        );
        if (snapped.kind !== null) {
          const dx = snapped.point[0] - params.points[0]![0];
          const dy = snapped.point[1] - params.points[0]![1];
          points = params.points.map(([x, y]): [number, number] => [x + dx, y + dy]);
          handles = handles?.map((handle) => ({
            ...(handle.in ? { in: [handle.in[0] + dx, handle.in[1] + dy] as [number, number] } : {}),
            ...(handle.out ? { out: [handle.out[0] + dx, handle.out[1] + dy] as [number, number] } : {}),
          }));
        }
      }
      return tx.edit('Draw Shape', (draft) => {
        if (params.handles && params.handles.length !== points.length)
          throw new Error('Path handles must match anchor count');
        page(draft, params.pageId);
        const layer = draft.layers.get(draft.activeLayerId);
        if (!layer || layer.locked || !isLayoutLayerVisible(page(draft, params.pageId), draft, layer.id))
          throw new Error('Active layer is unavailable');
        const entityId = allocId(draft);
        const store = shapeStore(draft, params.pageId, draft.activeLayerId);
        store.entities.set(entityId, {
          id: entityId,
          kind: 'path',
          layerId: draft.activeLayerId,
          points: points.map((p) => [p[0], p[1]]),
          ...(handles ? { handles } : {}),
          closed: params.closed,
          style: newShapeStyle(draft, params.closed),
        });
        store.order.push(entityId);
        return entityId;
      });
    },
  }),
  defineCommand({
    id: 'layout.shape.setPath',
    title: 'Edit Path',
    category: 'layout',
    menu: 'Arrange',
    params: z.object({
      pageId: id,
      entityId: id,
      points: z.array(point).min(2),
      handles: z.array(pathHandle).optional(),
      closed: z.boolean().optional(),
      contourStarts: z.array(z.number().int().nonnegative()).optional(),
    }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Edit Path', (draft) => {
        const entity = editablePath(draft, params.pageId, params.entityId);
        if (entity.kind !== 'path') throw new Error('Only paths can be edited as paths');
        const closed = params.closed ?? entity.closed;
        const contourStarts = params.contourStarts ?? entity.contourStarts;
        if (contourStarts && (!validLayoutContourStarts(params.points, closed, contourStarts, entity.openContours) ||
          entity.contourStarts && params.contourStarts === undefined && params.points.length !== entity.points.length))
          throw new Error('Compound path edits must preserve valid contour boundaries');
        if (closed && params.points.length < 3)
          throw new Error('A closed path needs at least three points');
        if (params.handles && params.handles.length !== params.points.length)
          throw new Error('Path handles must match anchor count');
        const previousPoints = entity.points;
        const previousHandles = entity.handles;
        entity.points = params.points.map(([x, y]): [number, number] => [x, y]);
        if (params.handles) entity.handles = cloneHandles(params.handles);
        else if (previousHandles && previousPoints.length === params.points.length)
          entity.handles = previousHandles.map((handle, index) => {
            const deltaX = params.points[index]![0] - previousPoints[index]![0];
            const deltaY = params.points[index]![1] - previousPoints[index]![1];
            return {
              ...(handle.in ? { in: [handle.in[0] + deltaX, handle.in[1] + deltaY] as [number, number] } : {}),
              ...(handle.out ? { out: [handle.out[0] + deltaX, handle.out[1] + deltaY] as [number, number] } : {}),
            };
          });
        else entity.handles = undefined;
        if (closed && !entity.closed) {
          entity.style ??= plainStyle(draft);
          entity.style.fillColor ??= draft.defaultStyle.fillColor ?? '#ffffff';
        }
        entity.closed = closed;
        if (contourStarts) entity.contourStarts = [...contourStarts];
      }),
  }),
  defineCommand({
    id: 'layout.shape.move',
    title: 'Move or Copy Shape',
    category: 'layout',
    menu: 'Arrange',
    params: z.object({
      pageId: id,
      entityId: id.optional(),
      /** Several objects move or copy together as one undoable step; the result is then an array of ids. */
      entityIds: z.array(id).min(1).optional(),
      delta: point,
      labelPart: z.enum(['text', 'leader', 'tip']).default('leader'),
      copy: z.boolean().default(false),
      /**
       * The Move tool's semantics: labels move whole, keeping an attachment only to an object moving
       * with them, and copied dimensions become fixed paper points, as Paste makes them. `labelPart` is then ignored.
       */
      whole: z.boolean().default(false),
      /** Copies in an array: copy N lands at N times `delta`, each directly above the previous one. */
      count: z.number().int().min(1).default(1),
    }).refine((params) => params.entityId !== undefined || params.entityIds !== undefined, { message: 'entityId or entityIds is required' })
      .refine((params) => params.copy || params.count === 1, { message: 'Only copies can be arrayed' }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit(params.copy ? 'Copy Shape' : 'Move Shape', (draft) => {
        const sourceIds = params.entityIds ?? [params.entityId!];
        const moving = new Set(sourceIds);
        const fixedCopies = params.copy && params.whole;
        // Each copy stacks directly above the previous copy of the same original.
        const above = new Map<number, number>();
        const moveOne = (entityId: number, delta: [number, number], groups: Map<number, number>, copiedIds: Map<number, number>): number => {
        const entity = editablePath(draft, params.pageId, entityId);
        const store = shapeStore(draft, params.pageId, entity.layerId);
        const labelPart = params.whole ? (params.copy ? 'tip' : layoutLabelWholeMovePart(entity, moving)) : params.labelPart;
        const attachmentSource = entity.modelAnnotation?.attachments[0]?.viewportId ?? entity.labelAnchor?.entityId;
        const keepsAttachment = params.whole ? attachmentSource !== undefined && moving.has(attachmentSource) : labelPart !== 'tip';
        const movedLabel = entity.kind === 'label' ? moveLayoutLabel(entity, delta, labelPart) : null;
        const anchored = !fixedCopies && Boolean(entity.modelAnnotation || (entity.dimension ?? entity.angularDimension)?.anchors.some(Boolean) || entity.angularDimension?.edgeAnchors || entity.angularDimension?.rayDefinition);
        const points = movedLabel?.points ?? entity.points.map(([x, y], index): [number, number] =>
          anchored && index < (entity.angularDimension ? 3 : 2) ? [x, y] : [x + delta[0], y + delta[1]]);
        const handles = entity.handles?.map((handle) => ({
          ...(handle.in ? { in: [handle.in[0] + delta[0], handle.in[1] + delta[1]] as [number, number] } : {}),
          ...(handle.out ? { out: [handle.out[0] + delta[0], handle.out[1] + delta[1]] as [number, number] } : {}),
        }));
        if (!params.copy) {
          if (entity.kind === 'label' && labelPart === 'tip') {
            delete entity.labelAnchor;
            delete entity.modelAnnotation;
            delete entity.preservedModelConnections;
            if (movedLabel?.text) entity.text = movedLabel.text;
          }
          entity.points = points;
          if (handles) entity.handles = handles;
          return entity.id;
        }
        const newId = allocId(draft);
        copiedIds.set(entity.id, newId);
        const angularDimension = entity.angularDimension ? cloneAngularDimension(entity.angularDimension) : null;
        if (angularDimension && fixedCopies) {
          angularDimension.anchors = [null, null, null]; angularDimension.detached = false;
          delete angularDimension.edgeAnchors; delete angularDimension.rayDefinition;
        }
        const copy: LayoutEntity = {
          ...(movedLabel ?? entity),
          ...copyGroupMembership(entity, groups, draft),
          ...(entity.dimension ? { dimension: fixedCopies ? { ...structuredCloneDimension(entity.dimension), anchors: [null, null], detached: false }
            : structuredCloneDimension(entity.dimension) } : {}),
          ...(angularDimension ? { angularDimension } : {}),
          ...(entity.image ? { image: copyLayoutImage(entity.image) } : {}),
          ...(entity.modelAnnotation && (entity.kind !== 'label' || keepsAttachment)
            ? { modelAnnotation: copyLayoutModelAnnotation(entity.modelAnnotation) } : {}),
          id: newId,
          points,
          ...(handles ? { handles } : {}),
          ...(entity.style ? { style: { ...entity.style } } : {}),
        };
        if (entity.labelAnchor && keepsAttachment) copy.labelAnchor = { ...entity.labelAnchor };
        else delete copy.labelAnchor;
        if (entity.kind === 'label' && keepsAttachment && entity.modelAnnotation && entity.text) copy.text = { ...entity.text };
        if (fixedCopies && copy.dimension && entity.modelAnnotation) {
          Object.assign(copy, detachedLayoutModelAnnotation(copy));
          delete copy.modelAnnotation;
          delete copy.preservedModelConnections;
        }
        store.entities.set(newId, copy);
        const index = store.order.indexOf(above.get(entity.id) ?? entity.id);
        store.order.splice(index + 1, 0, newId);
        above.set(entity.id, newId);
        return newId;
        };
        const movedIds: number[] = [];
        for (let step = 1; step <= params.count; step++) {
          const groups = new Map<number, number>(), copiedIds = new Map<number, number>();
          const ids = sourceIds.map((entityId) => moveOne(entityId, [params.delta[0] * step, params.delta[1] * step], groups, copiedIds));
          // Copies attach to the copies of the objects they were attached to, within the same array step.
          if (params.copy) for (const newId of ids) {
            const copy = findShape(draft, params.pageId, newId).entity;
            for (const a of copy.modelAnnotation?.attachments ?? []) a.viewportId = copiedIds.get(a.viewportId) ?? a.viewportId;
            if (copy.labelAnchor) copy.labelAnchor.entityId = copiedIds.get(copy.labelAnchor.entityId) ?? copy.labelAnchor.entityId;
          }
          movedIds.push(...ids);
        }
        return params.entityIds ? movedIds : movedIds[0]!;
      }),
  }),
  defineCommand({
    id: 'layout.shape.rotate',
    title: 'Rotate Shape',
    category: 'layout',
    menu: 'Arrange',
    params: z.object({ pageId: id, entityId: id, angleDeg: finite, pivot: point.optional() }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Rotate Shape', (draft) => {
        const entity = editablePath(draft, params.pageId, params.entityId);
        const pivot = params.pivot ?? (entity.text ? layoutTextCenter(entity) : pathCenter(entity.kind === 'path'
          ? flattenLayoutPath(entity.points, entity.handles, entity.closed, 20, entity.contourStarts) : entity.points));
        const rotated = rotateLayoutEntity(entity, pivot, params.angleDeg);
        entity.points = rotated.points; entity.handles = rotated.handles;
        if (rotated.text) entity.text = rotated.text;
        if (entity.dimension && rotated.dimension?.angleDeg !== undefined) entity.dimension.angleDeg = rotated.dimension.angleDeg;
      }),
  }),
  defineCommand({
    id: 'layout.shape.scale',
    title: 'Scale Shape',
    category: 'layout',
    menu: 'Arrange',
    params: z.object({
      pageId: id, entityId: id,
      scaleX: finite.positive(), scaleY: finite.positive(), pivot: point.optional(),
    }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Scale Shape', (draft) => {
        const entity = editablePath(draft, params.pageId, params.entityId);
        const pivot = params.pivot ?? pathCenter(entity.kind === 'path'
          ? flattenLayoutPath(entity.points, entity.handles, entity.closed, 20, entity.contourStarts) : entity.points);
        const angle = entity.image || entity.table ? Math.atan2(entity.points[1]![1] - entity.points[0]![1], entity.points[1]![0] - entity.points[0]![0]) : 0;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const scale = (x: number, y: number): [number, number] => {
          const u = (x * cos + y * sin) * params.scaleX, v = (-x * sin + y * cos) * params.scaleY;
          return [u * cos - v * sin, u * sin + v * cos];
        };
        const points = transformPath(entity.points, pivot, scale);
        if (isViewport(entity)) entity.image.viewport.camera = resizedViewportCamera(entity.image.viewport.camera,
          entity.points, points, entity.image.viewport.preserveScaleOnResize);
        entity.points = points;
        if (entity.table && !validTableFrame(entity.points)) throw new Error('Invalid table size');
        transformHandles(entity, pivot, scale);
        transformDimensionAngle(entity, scale);
      }),
  }),
  defineCommand({
    id: 'layout.shape.flip',
    title: 'Flip Shape',
    category: 'layout',
    menu: 'Arrange',
    params: z.object({
      pageId: id, entityId: id, axis: z.enum(['horizontal', 'vertical']), pivot: point.optional(),
    }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Flip Shape', (draft) => {
        const entity = editablePath(draft, params.pageId, params.entityId);
        const pivot = params.pivot ?? pathCenter(entity.kind === 'path'
          ? flattenLayoutPath(entity.points, entity.handles, entity.closed, 20, entity.contourStarts) : entity.points);
        const flip = (x: number, y: number): [number, number] =>
          params.axis === 'horizontal' ? [-x, y] : [x, -y];
        entity.points = transformPath(entity.points, pivot, flip);
        transformHandles(entity, pivot, flip);
        transformDimensionAngle(entity, flip);
      }),
  }),
  defineCommand({
    id: 'layout.shape.assignLayer',
    title: 'Move Shape to Layer',
    category: 'layout',
    menu: 'Layers',
    params: z.object({ pageId: id, entityId: id, layerId: id }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Move Shape to Layer', (draft) => {
        const entity = editablePath(draft, params.pageId, params.entityId);
        const destination = draft.layers.get(params.layerId);
        if (!destination || destination.locked || !isLayoutLayerVisible(page(draft, params.pageId), draft, destination.id))
          throw new Error('Destination layer is unavailable');
        if (entity.layerId === params.layerId) return;
        const sourceStore = shapeStore(draft, params.pageId, entity.layerId);
        const destinationStore = shapeStore(draft, params.pageId, params.layerId);
        const moved: LayoutEntity = {
          ...entity,
          layerId: params.layerId,
          points: entity.points.map(([x, y]) => [x, y]),
          ...(entity.handles ? { handles: cloneHandles(entity.handles) } : {}),
          ...(entity.style ? { style: { ...entity.style } } : {}),
        };
        sourceStore.entities.delete(entity.id);
        sourceStore.order.splice(sourceStore.order.indexOf(entity.id), 1);
        destinationStore.entities.set(entity.id, moved);
        destinationStore.order.push(entity.id);
      }),
  }),
  defineCommand({
    id: 'layout.shape.order',
    title: 'Change Shape Order',
    category: 'layout',
    menu: 'Arrange',
    params: z.object({
      pageId: id, entityId: id,
      direction: z.enum(['front', 'back', 'forward', 'backward']),
    }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Change Shape Order', (draft) => {
        const entity = editablePath(draft, params.pageId, params.entityId);
        const store = shapeStore(draft, params.pageId, entity.layerId);
        const siblings = store.order.filter((candidate) =>
          store.entities.get(candidate)?.layerId === entity.layerId);
        const from = siblings.indexOf(entity.id);
        const to = params.direction === 'front' ? siblings.length - 1
          : params.direction === 'back' ? 0
            : params.direction === 'forward' ? Math.min(from + 1, siblings.length - 1)
              : Math.max(from - 1, 0);
        if (from === to) return;
        store.order.splice(store.order.indexOf(entity.id), 1);
        const neighborIndex = store.order.indexOf(siblings[to]!);
        store.order.splice(to > from ? neighborIndex + 1 : neighborIndex, 0, entity.id);
      }),
  }),
  defineCommand({
    id: 'layout.shape.arrange',
    title: 'Arrange Objects',
    category: 'layout',
    menu: 'Arrange',
    // `index` counts the destination layer's other objects in paint order, 0 being the back.
    params: z.object({ pageId: id, entityIds: z.array(id).min(1), layerId: id, index: z.number().int().min(0) }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Arrange Objects', (draft) => {
        const destination = draft.layers.get(params.layerId);
        if (!destination || destination.locked || !isLayoutLayerVisible(page(draft, params.pageId), draft, destination.id))
          throw new Error('Destination layer is unavailable');
        const moving = [...new Set(params.entityIds)].map((entityId) => editablePath(draft, params.pageId, entityId));
        // The moved objects keep their relative paint order: by layer, then by position within it.
        const rank = (entity: LayoutEntity): [number, number] =>
          [draft.layerOrder.indexOf(entity.layerId), shapeStore(draft, params.pageId, entity.layerId).order.indexOf(entity.id)];
        moving.sort((a, b) => { const [la, oa] = rank(a), [lb, ob] = rank(b); return la - lb || oa - ob; });
        const movingIds = new Set(moving.map((entity) => entity.id));
        const crosses = (entity: LayoutEntity): boolean => draft.layers.get(entity.layerId)?.shared !== destination.shared;
        for (const entity of moving) {
          if (entity.groupId === undefined || !crosses(entity)) continue;
          const { entities } = shapeStore(draft, params.pageId, entity.layerId);
          if ([...entities.values()].some((other) => other.groupId === entity.groupId && !movingIds.has(other.id)))
            throw new Error('Shared and page-local objects cannot be grouped together');
        }
        const to = shapeStore(draft, params.pageId, params.layerId);
        const rest = to.order.filter((entityId) => !movingIds.has(entityId));
        const siblings = rest.filter((entityId) => to.entities.get(entityId)?.layerId === params.layerId);
        const at = params.index < siblings.length ? rest.indexOf(siblings[params.index]!)
          : siblings.length ? rest.indexOf(siblings.at(-1)!) + 1 : rest.length;
        const next = [...rest.slice(0, at), ...moving.map((entity) => entity.id), ...rest.slice(at)];
        if (moving.every((entity) => entity.layerId === params.layerId) && next.length === to.order.length &&
          next.every((entityId, index) => to.order[index] === entityId)) return;
        for (const entity of moving) {
          if (!crosses(entity)) { entity.layerId = params.layerId; continue; }
          const from = shapeStore(draft, params.pageId, entity.layerId);
          const moved: LayoutEntity = {
            ...entity,
            layerId: params.layerId,
            points: entity.points.map(([x, y]) => [x, y]),
            ...(entity.handles ? { handles: cloneHandles(entity.handles) } : {}),
            ...(entity.style ? { style: { ...entity.style } } : {}),
          };
          from.entities.delete(entity.id);
          from.order.splice(from.order.indexOf(entity.id), 1);
          to.entities.set(entity.id, moved);
        }
        to.order.splice(0, to.order.length, ...next);
      }),
  }),
  defineCommand({
    id: 'layout.shape.delete',
    title: 'Erase Shape',
    category: 'layout',
    menu: 'Tools',
    params: z.object({ pageId: id, entityId: id.optional(), entityIds: z.array(id).min(1).optional() })
      .refine((params) => params.entityId !== undefined || params.entityIds !== undefined, { message: 'entityId or entityIds is required' }),
    undoable: true,
    run: (ctx, params) =>
      host(ctx).edit('Erase Shape', (draft) => {
        // Several objects erase together as one undoable step.
        for (const entityId of params.entityIds ?? [params.entityId!]) {
          const entity = editablePath(draft, params.pageId, entityId);
          const store = shapeStore(draft, params.pageId, entity.layerId);
          store.entities.delete(entity.id);
          store.order.splice(store.order.indexOf(entity.id), 1);
        }
      }),
  }),
];

export function createLayoutRegistry(doc: LayoutDocument): {
  host: LayoutDocumentHost;
  commands: CommandRegistry;
} {
  const tx = new LayoutDocumentHost(doc);
  const commands = new CommandRegistry({ tx, services: new Map() });
  commands.registerAll(editCommands);
  commands.registerAll(layoutCommands);
  commands.registerAll(layoutWorkspaceCommands);
  return { host: tx, commands };
}
