// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { cloneLayoutValue } from './nativeValues';
import { LENGTH_TOL, v3dist, type Vec3 } from '@pushform/core';
import { resolveDimensionAnchor, type DimensionAnchor, type DocumentState, type Draft } from '@pushform/model';
import { entityOnPage, type LayoutDocumentState, type LayoutEntity, type LayoutViewportSource } from './LayoutDocument';
import { layoutTextCenter, rotateLayoutPoint } from './rotation';
import { linearMeasurement } from './dimensions';
import { isViewport, viewportPaperPoint } from './viewports';
import { layoutModelLabelFields } from './modelLabelFields';
import { bakeLayoutModelText } from './text';

/** Native identity is scoped to a model, never to a mesh index or the nearest point. */
export interface LayoutModelAttachment {
  nativeUnknownFields?: Uint8Array[];
  viewportId: number;
  source: LayoutViewportSource;
  modelGuid: string;
  anchor: Draft<DimensionAnchor>;
}

export type LayoutModelAttachmentResult =
  | { status: 'resolved'; modelPoint: Vec3; paperPoint: [number, number] }
  | { status: 'unavailable' }
  | { status: 'detached' };

export function sameLayoutModelSource(a: LayoutViewportSource, b: LayoutViewportSource): boolean {
  return 'referenceId' in a
    ? 'referenceId' in b && a.referenceId === b.referenceId
    : !('referenceId' in b) && a.archiveId === b.archiveId && a.modelReferenceId === b.modelReferenceId;
}

export function validLayoutModelAttachment(value: unknown): value is LayoutModelAttachment {
  if (!value || typeof value !== 'object') return false;
  const a = value as LayoutModelAttachment;
  const id = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  if (!id(a.viewportId) || typeof a.modelGuid !== 'string' || !a.modelGuid || !a.source || typeof a.source !== 'object') return false;
  if ('referenceId' in a.source ? !id(a.source.referenceId)
    : typeof a.source.archiveId !== 'string' || !a.source.archiveId || typeof a.source.modelReferenceId !== 'string' || !a.source.modelReferenceId) return false;
  const anchor = a.anchor;
  if (!anchor || !Array.isArray(anchor.path) || !anchor.path.every(id)) return false;
  return anchor.kind === 'sketchVertex' ? id(anchor.id) : anchor.kind === 'bodyVertex' && id(anchor.bodyId) &&
    Array.isArray(anchor.faceIds) && anchor.faceIds.length > 0 && anchor.faceIds.every(v => Number.isSafeInteger(v) && v >= 0) &&
    new Set(anchor.faceIds).size === anchor.faceIds.length;
}

export function validLayoutModelAnnotation(entity: LayoutEntity): boolean {
  const validFields = (fields: unknown): boolean => fields === undefined || entity.kind === 'label' && !!fields &&
    typeof fields === 'object' && !Array.isArray(fields) && Object.values(fields).every(value => typeof value === 'string');
  const preserved = entity.preservedModelConnections;
  if (!validFields(preserved?.fields) || !validFields(entity.modelAnnotation?.fields)) return false;
  if (preserved !== undefined && (!preserved || !['dimension', 'label'].includes(entity.kind) ||
    typeof preserved.archiveId !== 'string' || !preserved.archiveId || typeof preserved.originalId !== 'string' || !preserved.originalId ||
    typeof preserved.snapshot !== 'string' || !preserved.snapshot || !Array.isArray(preserved.viewports) || !preserved.viewports.length ||
    !preserved.viewports.every(view => view && typeof view.originalId === 'string' && view.originalId && Number.isSafeInteger(view.entityId) && view.entityId > 0))) return false;
  const annotation = entity.modelAnnotation;
  if (annotation === undefined) return true;
  if (!annotation || !['resolved', 'unavailable', 'detached'].includes(annotation.status) ||
    !Array.isArray(annotation.attachments) || !annotation.attachments.every(validLayoutModelAttachment)) return false;
  if (entity.kind === 'label') return annotation.attachments.length === 1 && !entity.labelAnchor && !!entity.text;
  if (entity.kind !== 'dimension' || !entity.dimension ||
    !Array.isArray(entity.dimension.anchors) || entity.dimension.anchors.some(Boolean) || annotation.attachments.length !== 2) return false;
  const [a, b] = annotation.attachments;
  return a!.viewportId === b!.viewportId && a!.modelGuid === b!.modelGuid && sameLayoutModelSource(a!.source, b!.source);
}

/** Keep the imported entity's exact baseline independent of its preservation metadata. */
export function layoutModelConnectionSnapshot(entity: LayoutEntity): string {
  const { preservedModelConnections: _preserved, ...data } = entity;
  // Cached paper length is derived, and equivalent inch/mm calculations can differ by rounding.
  return JSON.stringify({ ...data, ...(data.dimension ? { dimension: { ...data.dimension,
    cachedValueMm: linearMeasurement(data.points[0]!, data.points[1]!, data.dimension.alignment, data.dimension.angleDeg),
  } } : {}) });
}

/** Works on both plain state and transaction drafts, unlike structuredClone of an Immer proxy. */
export function copyLayoutModelAnnotation(annotation: NonNullable<LayoutEntity['modelAnnotation']>): NonNullable<LayoutEntity['modelAnnotation']> {
  return cloneLayoutValue(annotation);
}

/** Independent paper geometry keeps the last displayed model value, including perspective dimensions. */
export function detachedLayoutModelAnnotation(entity: LayoutEntity): LayoutEntity {
  if (!entity.modelAnnotation && !entity.preservedModelConnections) return entity;
  const copy = { ...entity };
  if (entity.text) copy.text = bakeLayoutModelText(entity.text, layoutModelFields(entity));
  if (entity.dimension) {
    const dimension = { ...entity.dimension, detached: false };
    const length = linearMeasurement(entity.points[0]!, entity.points[1]!, dimension.alignment, dimension.angleDeg);
    if (dimension.cachedValueMm > 0) {
      if (length <= LENGTH_TOL * 1000) throw new Error('Cannot disconnect a dimension whose projected endpoints coincide');
      dimension.scale = length / (dimension.cachedValueMm / (dimension.scale ?? 1));
    }
    dimension.cachedValueMm = length;
    copy.dimension = dimension;
  }
  delete copy.modelAnnotation;
  delete copy.preservedModelConnections;
  return copy;
}

/** Live native values take precedence over the preserved source's last resolved Auto-Text. */
export function layoutModelFields(entity: LayoutEntity): Record<string, string> | undefined {
  return entity.modelAnnotation?.fields ?? entity.preservedModelConnections?.fields;
}

/**
 * Resolve against the exact loaded revision selected by the caller. Missing model bytes are temporary;
 * a missing viewport, replaced model or deleted identity is detached. Neither case invents geometry.
 */
export function resolveLayoutModelAttachment(
  attachment: LayoutModelAttachment,
  lookup: (id: number) => LayoutEntity | undefined,
  model: DocumentState | undefined,
): LayoutModelAttachmentResult {
  const view = lookup(attachment.viewportId);
  if (!view || !isViewport(view) || !sameLayoutModelSource(view.image.viewport.source, attachment.source))
    return { status: 'detached' };
  if (!model) return { status: 'unavailable' };
  if (model.meta.guid !== attachment.modelGuid) return { status: 'detached' };
  const root = model.definitions.get(model.rootDefinitionId);
  const modelPoint = root && resolveDimensionAnchor(model, root.entities, attachment.anchor);
  if (!modelPoint) return { status: 'detached' };
  const paperPoint = viewportPaperPoint(view.points, view.image.viewport.camera, [...modelPoint]);
  // A valid attachment behind the camera is unavailable in this view, not a deleted entity.
  return paperPoint ? { status: 'resolved', modelPoint, paperPoint } : { status: 'unavailable' };
}

/** The provider must return the model revision currently selected by this drawing, never a stale load. */
export type LayoutAnnotationModels = (state: LayoutDocumentState, source: LayoutViewportSource) => DocumentState | undefined;

/** Update all endpoints together, retaining the last valid value and placement if any attachment fails. */
function updateModelAnnotation(entity: LayoutEntity, lookup: (id: number) => LayoutEntity | undefined,
  model: (source: LayoutViewportSource) => DocumentState | undefined): void {
    const annotation = entity.modelAnnotation;
    if (!annotation) return;
    const results = annotation.attachments.map(a => resolveLayoutModelAttachment(a, lookup, model(a.source)));
    const detached = results.some(r => r.status === 'detached');
    if (detached || results.some(r => r.status === 'unavailable')) {
      annotation.status = detached ? 'detached' : 'unavailable';
      if (entity.dimension) entity.dimension.detached = detached;
      return;
    }
    const resolved = results.filter((r): r is Extract<LayoutModelAttachmentResult, { status: 'resolved' }> => r.status === 'resolved');
    if (entity.kind === 'dimension' && entity.dimension && resolved.length === 2) {
      const [a, b] = resolved;
      for (const [index, result] of resolved.entries()) {
        if (entity.points[index]?.[0] !== result.paperPoint[0] || entity.points[index]?.[1] !== result.paperPoint[1]) entity.points[index] = result.paperPoint;
      }
      const view = lookup(annotation.attachments[0]!.viewportId)!;
      const camera = view.image!.viewport!.camera;
      // Parallel auto-scale measures projected length; perspective uses model distance.
      entity.dimension.cachedValueMm = camera.projection === 'parallel'
        ? linearMeasurement(a!.paperPoint, b!.paperPoint, entity.dimension.alignment, entity.dimension.angleDeg)
        : v3dist(a!.modelPoint, b!.modelPoint) * 1000;
      entity.dimension.scale = camera.projection === 'parallel' ? camera.scale : 1;
      entity.dimension.detached = false;
    } else if (entity.kind === 'label' && entity.text && resolved.length === 1) {
      const tip = rotateLayoutPoint(resolved[0]!.paperPoint, layoutTextCenter(entity), -(entity.text.rotationDeg ?? 0));
      if (entity.points[2]?.[0] !== tip[0] || entity.points[2]?.[1] !== tip[1]) entity.points[2] = tip;
      const attachment = annotation.attachments[0]!;
      const fields = layoutModelLabelFields(attachment, lookup(attachment.viewportId)!, model(attachment.source)!, resolved[0]!.modelPoint);
      if (JSON.stringify(annotation.fields) !== JSON.stringify(fields)) annotation.fields = fields;
    } else return;
    annotation.status = 'resolved';
}

/** Resolve a transient view without writing to the document or its undo history. */
export function previewLayoutModelAnnotation(entity: LayoutEntity, lookup: (id: number) => LayoutEntity | undefined,
  model: (source: LayoutViewportSource) => DocumentState | undefined): LayoutEntity {
  if (!entity.modelAnnotation) return entity;
  const preview: LayoutEntity = { ...entity, points: entity.points.map(point => [...point]),
    modelAnnotation: copyLayoutModelAnnotation(entity.modelAnnotation),
    ...(entity.dimension ? { dimension: { ...entity.dimension } } : {}),
  };
  updateModelAnnotation(preview, lookup, model);
  return preview;
}

export function refreshLayoutModelAnnotations(state: LayoutDocumentState, models: LayoutAnnotationModels): void {
  const update = (entity: LayoutEntity, lookup: (id: number) => LayoutEntity | undefined) =>
    updateModelAnnotation(entity, lookup, source => models(state, source));
  for (const page of state.pages.values()) {
    for (const entity of page.entities.values()) update(entity, id => entityOnPage(page, state, id));
  }
  for (const entity of state.sharedEntities.values()) update(entity, id => state.sharedEntities.get(id));
}
