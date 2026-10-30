// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { validLayoutModelAnnotation, validLayoutTable, validTableFrame, LAYOUT_OBJECT_NAME_MAX, isCloudSource, isCloudReference, LAYOUT_VIEWPORT_FACE_STYLES, LAYOUT_PAGE_NUMBER_STYLES } from '@pushform/layout';
import { strFromU8, strToU8, zipSync } from 'fflate';
import { validLayoutContourStarts, LayoutDocument, LAYOUT_FORMAT_VERSION, type LayoutDocumentState, type LayoutEntity } from '@pushform/layout';
import { readNativeArchive } from './nativeArchive';

const FORMAT = 'pushform-layout';
const MANIFEST = 'layout.json';
function validateLayoutVersion(version: unknown, state: unknown): void {
  if (version !== LAYOUT_FORMAT_VERSION)
    throw new Error(`Unsupported Layout version: ${String(version)}`);
  if (state && typeof state === 'object' && 'meta' in state) {
    const meta = (state as { meta?: unknown }).meta;
    if (meta && typeof meta === 'object' && 'formatVersion' in meta &&
      (meta as { formatVersion: unknown }).formatVersion !== version)
      throw new Error('Layout document version does not match its manifest');
  }
}

function mapReplacer(_key: string, value: unknown): unknown {
  return value instanceof Map ? { $map: [...value.entries()] } : value;
}

function mapReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && '$map' in value) {
    const entries = (value as { $map: unknown }).$map;
    if (!Array.isArray(entries)) throw new Error('Invalid map in Layout document');
    return new Map(entries as [unknown, unknown][]);
  }
  return value;
}

/** Stable serialized content for saved-state comparison and the .pfl manifest. */
export function layoutJson(state: LayoutDocumentState): string {
  return JSON.stringify({ format: FORMAT, version: LAYOUT_FORMAT_VERSION, state }, mapReplacer);
}

/** Zip an already serialized manifest (`layoutJson`). CPU-bound; see `encodeLayoutArchive`. */
export function encodeLayoutArchiveSync(content: string): Uint8Array {
  return zipSync({ [MANIFEST]: strToU8(content) }, { level: 6 });
}

export function encodeLayoutDocument(doc: LayoutDocument): Uint8Array {
  return encodeLayoutArchiveSync(layoutJson(doc.state));
}

export function decodeLayoutDocument(bytes: Uint8Array): LayoutDocument {
  return new LayoutDocument(parseLayoutFile(bytes));
}

/** Validated state of a .pfl archive; only `layout.json` is inflated, within `nativeArchive` bounds. */
export function parseLayoutFile(bytes: Uint8Array): LayoutDocumentState {
  const files = readNativeArchive(bytes, { extension: '.pfl', supported: name => name === MANIFEST });
  const manifest = files[MANIFEST];
  if (!manifest) throw new Error('Layout document is missing layout.json');
  return parseLayoutManifest(strFromU8(manifest));
}

/** Decode the manifest directly for browser session restoration. */
export function decodeLayoutJson(json: string): LayoutDocument {
  return new LayoutDocument(parseLayoutManifest(json));
}

/** Parse and validate a `layout.json` manifest without constructing a document. */
export function parseLayoutManifest(json: string): LayoutDocumentState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json, mapReviver);
  } catch {
    throw new Error('Layout document has invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid Layout document');
  const file = parsed as { format?: unknown; version?: unknown; state?: unknown };
  if (file.format !== FORMAT) throw new Error('Not a PushForm Layout document');
  validateLayoutVersion(file.version, file.state);
  return assertLayoutState(file.state);
}

/** Structural check of revived Layout state, for example after it crossed a worker boundary. */
export function assertLayoutState(state: unknown): LayoutDocumentState {
  if (!isLayoutState(state)) throw new Error('Layout document has invalid state');
  return state;
}

function isLayoutState(value: unknown): value is LayoutDocumentState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<LayoutDocumentState>;
  if (
    !state.meta ||
    typeof state.meta.guid !== 'string' ||
    state.meta.formatVersion !== LAYOUT_FORMAT_VERSION ||
    !Number.isSafeInteger(state.meta.nextId)
  )
    return false;
  if (
    !(state.pages instanceof Map) ||
    !(state.layers instanceof Map) ||
    !(state.references instanceof Map)
  )
    return false;
  if (
    !Array.isArray(state.pageOrder) ||
    state.pageOrder.length === 0 ||
    !Array.isArray(state.layerOrder)
  )
    return false;
  if (!(state.customFields instanceof Map) || !state.settings || !state.defaultStyle ||
    !(state.sharedEntities instanceof Map) || !Array.isArray(state.sharedEntityOrder)) return false;
  for (const [id, reference] of state.references) {
    if (typeof id !== 'number' || !reference || reference.id !== id || typeof reference.displayName !== 'string') return false;
    const target = reference.target;
    if (!target) return false;
    if (target.kind === 'cloud') {
      if (typeof target.documentId !== 'string' || !target.documentId || typeof target.revisionId !== 'string' || !target.revisionId ||
        !Number.isSafeInteger(target.revisionNumber) || target.revisionNumber <= 0 ||
        typeof target.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(target.sha256) || typeof target.pinned !== 'boolean') return false;
    } else if (target.kind !== 'path' || typeof target.path !== 'string' ||
      (target.contentHash !== null && typeof target.contentHash !== 'string')) return false;
  }
  if (state.modelArchives !== undefined) {
    if (!(state.modelArchives instanceof Map)) return false;
    for (const [archiveId, archive] of state.modelArchives) {
      if (typeof archiveId !== 'string' || !archiveId || !archive || archive.format !== 'sketchup-layout' ||
        (archive.annotationConnectionsVersion !== undefined && archive.annotationConnectionsVersion !== 1) ||
        typeof archive.archiveBase64 !== 'string' || !archive.archiveBase64 || archive.archiveBase64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(archive.archiveBase64) ||
        !(archive.models instanceof Map) || !(archive.viewports instanceof Map)) return false;
      for (const [id, model] of archive.models) {
        if (typeof id !== 'string' || !model ||
          (model.internalTarget !== null && typeof model.internalTarget !== 'string') ||
          (model.externalTarget !== null && typeof model.externalTarget !== 'string')) return false;
      }
      for (const [id, viewport] of archive.viewports) {
        if (typeof id !== 'string' || !viewport ||
          (viewport.modelReferenceId !== null && typeof viewport.modelReferenceId !== 'string') ||
          !Array.isArray(viewport.entityIds) || !viewport.entityIds.every(entityId => Number.isSafeInteger(entityId) && entityId > 0)) return false;
      }
    }
  }
  if (state.pageNumberFields !== undefined) {
    if (!(state.pageNumberFields instanceof Map)) return false;
    for (const [name, numbering] of state.pageNumberFields) {
      if (typeof name !== 'string' || !name || !numbering || !Number.isSafeInteger(numbering.startNumber) ||
        !(LAYOUT_PAGE_NUMBER_STYLES as readonly string[]).includes(numbering.style) ||
        (numbering.startPageId !== null && !Number.isSafeInteger(numbering.startPageId))) return false;
    }
  }
  if (state.settings.objectSnap !== undefined && typeof state.settings.objectSnap !== 'boolean') return false;
  const unit = (value: unknown): boolean => value === undefined || value === 'mm' || value === 'in';
  if (!unit(state.settings.paperUnits) || !unit(state.settings.grid?.units)) return false;
  if (!state.pageOrder.every((id) => typeof id === 'number' && state.pages!.has(id))) return false;
  if (!state.layerOrder.every((id) => typeof id === 'number' && state.layers!.has(id)))
    return false;
  if (typeof state.activeLayerId !== 'number' || !state.layers.has(state.activeLayerId))
    return false;
  if (!state.sharedEntityOrder.every((id) => state.sharedEntities!.has(id))) return false;
  for (const entity of state.sharedEntities.values()) {
    if (!state.layers.get(entity.layerId)?.shared || !validLayoutEntityContent(entity) || !validViewport(entity, state.references!)) return false;
  }
  for (const page of state.pages.values()) {
    if (
      !page ||
      !Array.isArray(page.size) ||
      page.size.length !== 2 ||
      !(page.entities instanceof Map) ||
      !Array.isArray(page.entityOrder)
    )
      return false;
    if (!page.entityOrder.every((id) => page.entities.has(id))) return false;
    if (page.layerVisibility !== undefined && (!(page.layerVisibility instanceof Map) ||
      [...page.layerVisibility].some(([id, visible]) => !state.layers!.has(id) || typeof visible !== 'boolean'))) return false;
    for (const entity of page.entities.values()) {
      if (!validLayoutEntityContent(entity) || !validViewport(entity, state.references!)) return false;
      if (!state.layers.get(entity.layerId) || state.layers.get(entity.layerId)?.shared ||
        state.sharedEntities.has(entity.id)) return false;
    }
  }
  return true;
}

/** A view's source names an embedded model or one of the document's cloud references. */
/** An anchor's point along a segment: absent for a vertex, or strictly between the segment's ends. */
function validSegmentFraction(t: unknown): boolean {
  return t === undefined || (typeof t === 'number' && t > 0 && t < 1);
}

function validViewport(entity: LayoutEntity, references: LayoutDocumentState['references']): boolean {
  const viewport = entity.image?.viewport;
  if (viewport === undefined) return true;
  if (entity.kind !== 'image' || !viewport || !viewport.source) return false;
  if (viewport.preserveScaleOnResize !== undefined && typeof viewport.preserveScaleOnResize !== 'boolean') return false;
  if (viewport.cache !== null && viewport.cache.sha256 !== undefined && typeof viewport.cache.sha256 !== 'string') return false;
  const display = viewport.display;
  if (display !== undefined && (!display || !LAYOUT_VIEWPORT_FACE_STYLES.includes(display.faceStyle) ||
    ![display.edges, display.profiles, display.backEdges, display.xray, display.hiddenGeometry].every(value => typeof value === 'boolean') ||
    display.shadows !== undefined && !validShadows(display.shadows))) return false;
  if (isCloudSource(viewport.source)) {
    return Number.isSafeInteger(viewport.source.referenceId) && isCloudReference(references.get(viewport.source.referenceId)) &&
      viewport.templateId === null && viewport.originalId === null;
  }
  return typeof viewport.source.archiveId === 'string' && typeof viewport.source.modelReferenceId === 'string' && typeof viewport.templateId === 'string';
}

/** A view's sun and shadow settings. */
function validShadows(shadows: unknown): boolean {
  if (!shadows || typeof shadows !== 'object') return false;
  const s = shadows as Record<string, unknown>;
  const within = (key: string, min: number, max: number) => typeof s[key] === 'number' && s[key] >= min && s[key] <= max;
  return within('month', 1, 12) && within('day', 1, 31) && within('time', 0, 1439) && within('utcOffsetHours', -12, 14) &&
    within('latitude', -90, 90) && within('longitude', -180, 180) && within('northAngle', 0, 360) && within('light', 0, 100) &&
    within('dark', 0, 100) && ['enabled', 'useSunForShading', 'onGround', 'onFaces', 'fromEdges'].every(key => typeof s[key] === 'boolean');
}

/** Validate new annotation payloads before they reach geometry and numeric formatting code. */
export function validLayoutEntityContent(entity: LayoutEntity): boolean {
  if (!validLayoutModelAnnotation(entity)) return false;
  if (entity.kind === 'table' ? !validLayoutTable(entity.table) || !validTableFrame(entity.points) : entity.table !== undefined) return false;
  if (entity.contourStarts !== undefined && (entity.kind !== 'path' || !Array.isArray(entity.points) ||
    !Array.isArray(entity.contourStarts) || entity.openContours !== undefined && !Array.isArray(entity.openContours) ||
    !validLayoutContourStarts(entity.points, entity.closed, entity.contourStarts, entity.openContours))) return false;
  if (entity.openContours !== undefined && entity.contourStarts === undefined) return false;
  const dash = entity.style?.strokeDashMm;
  if (dash !== undefined && (!Array.isArray(dash) || dash.length % 2 !== 0 ||
    !dash.every(length => Number.isFinite(length) && length > 0))) return false;
  if (entity.name !== undefined && (typeof entity.name !== 'string' || entity.name.length > LAYOUT_OBJECT_NAME_MAX)) return false;
  if (entity.locked !== undefined && typeof entity.locked !== 'boolean') return false;
  if (entity.hidden !== undefined && typeof entity.hidden !== 'boolean') return false;
  if (entity.groupId !== undefined && (!Number.isSafeInteger(entity.groupId) || entity.groupId <= 0)) return false;
  const nestedGroups = entity.nestedGroupIds;
  if (nestedGroups !== undefined && (entity.groupId === undefined || !Array.isArray(nestedGroups) || !nestedGroups.length ||
    nestedGroups.some(id => !Number.isSafeInteger(id) || id <= 0 || id === entity.groupId) ||
    new Set(nestedGroups).size !== nestedGroups.length)) return false;
  if (entity.labelAnchor !== undefined) {
    const anchor = entity.labelAnchor;
    if (entity.kind !== 'label' || !entity.text || !Array.isArray(entity.points) || entity.points.length < 3 || !anchor ||
      !Number.isSafeInteger(anchor.entityId) || anchor.entityId <= 0 || anchor.entityId === entity.id ||
      !Number.isSafeInteger(anchor.pointCount) || anchor.pointCount < 2 ||
      !Number.isSafeInteger(anchor.pointIndex) || anchor.pointIndex < 0 || anchor.pointIndex >= anchor.pointCount ||
      !validSegmentFraction(anchor.t)) return false;
  }
  const angular = entity.kind === 'angular-dimension';
  if (entity.kind !== 'dimension' && !angular) return entity.dimension === undefined && entity.angularDimension === undefined;
  if (angular ? entity.dimension !== undefined : entity.angularDimension !== undefined) return false;
  const dim = angular ? entity.angularDimension : entity.dimension;
  if (!dim || !Array.isArray(entity.points) || entity.points.length !== (angular ? 4 : 3) ||
    !entity.points.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) return false;
  if (entity.dimension && (!['aligned', 'horizontal', 'vertical', 'rotated'].includes(entity.dimension.alignment) ||
    (entity.dimension.angleDeg !== undefined && !Number.isFinite(entity.dimension.angleDeg)) ||
    !['mm', 'cm', 'm', 'inch', 'ft', 'pt'].includes(entity.dimension.units) || !Number.isFinite(entity.dimension.cachedValueMm) || entity.dimension.cachedValueMm < 0 ||
    (entity.dimension.format !== undefined && !['decimal', 'architectural', 'engineering', 'fractional'].includes(entity.dimension.format)) ||
    (entity.dimension.scale !== undefined && !(Number.isFinite(entity.dimension.scale) && entity.dimension.scale > 0)) ||
    (entity.dimension.showDashes !== undefined && typeof entity.dimension.showDashes !== 'boolean'))) return false;
  if (entity.angularDimension && ['format', 'scale', 'showDashes'].some(key => key in entity.angularDimension!)) return false;
  if (entity.angularDimension && (!['degrees', 'radians'].includes(entity.angularDimension.units) ||
    typeof entity.angularDimension.reflex !== 'boolean' || !Number.isFinite(entity.angularDimension.cachedAngleDeg) ||
    entity.angularDimension.cachedAngleDeg < 0 || entity.angularDimension.cachedAngleDeg > 360)) return false;
  const rays = entity.angularDimension?.rayDefinition;
  if (rays !== undefined && (!rays || entity.angularDimension?.edgeAnchors || !Array.isArray(dim.anchors) || dim.anchors.some(Boolean) ||
    !Array.isArray(rays.points) || rays.points.length !== 4 || !rays.points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) ||
    !Array.isArray(rays.anchors) || rays.anchors.length !== 4 || rays.anchors.some(a => a !== null &&
      (!a || !Number.isSafeInteger(a.entityId) || a.entityId <= 0 || !Number.isSafeInteger(a.pointCount) || a.pointCount < 2 ||
      !Number.isSafeInteger(a.pointIndex) || a.pointIndex < 0 || a.pointIndex >= a.pointCount)))) return false;
  const edges = entity.angularDimension?.edgeAnchors;
  if (edges !== undefined && (!Array.isArray(edges) || edges.length !== 2 || edges.some(edge =>
    !edge || !Number.isSafeInteger(edge.entityId) || edge.entityId <= 0 || !Number.isSafeInteger(edge.pointCount) || edge.pointCount < 2 ||
    !Number.isSafeInteger(edge.segmentIndex) || edge.segmentIndex < 0 || edge.segmentIndex >= edge.pointCount ||
    (edge.direction !== 1 && edge.direction !== -1)))) return false;
  if (!['arrow', 'tick', 'dot', 'none'].includes(dim.endpoint)) return false;
  if (!Number.isInteger(dim.precision) || dim.precision < 0 || dim.precision > 6 ||
    typeof dim.detached !== 'boolean' ||
    typeof dim.showUnits !== 'boolean' || typeof dim.text !== 'string' || typeof dim.fontFamily !== 'string' || !dim.fontFamily.trim()) return false;
  if (![dim.fontSizePt, dim.arrowSizeMm].every((value) => Number.isFinite(value) && value > 0) ||
    ![dim.extensionGapMm, dim.extensionOverrunMm].every((value) => Number.isFinite(value) && value >= 0)) return false;
  return Array.isArray(dim.anchors) && dim.anchors.length === (angular ? 3 : 2) && dim.anchors.every((anchor) => anchor === null ||
    (anchor && Number.isSafeInteger(anchor.entityId) && anchor.entityId > 0 &&
      Number.isSafeInteger(anchor.pointCount) && anchor.pointCount >= 2 &&
      Number.isSafeInteger(anchor.pointIndex) && anchor.pointIndex >= 0 && anchor.pointIndex < anchor.pointCount && validSegmentFraction(anchor.t)));
}
