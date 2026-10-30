// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { newGuid, type LengthFormat } from '@pushform/core';
import { TransactionalDocument, allocId, type Draft, type Patch, type ShadowSettings } from '@pushform/model';
import type { LayoutArrow } from './arrows';
import { prepareNativeAnnotationDictionaries } from './nativeAnnotationFields';
import type { LayoutModelAttachment } from './modelAttachments';
import { reconcileNativePageFields } from './nativePageFields';
import { reconcileNativeEntityFields } from './nativeEntityFields';

export const LAYOUT_FORMAT_VERSION = 1;

export interface LayoutPage {
  nativeUnknownFields?: { envelopeUnknown?: Uint8Array[]; extensions?: Map<string, Uint8Array[]> };
  id: number;
  name: string;
  size: [number, number];
  margin: { top: number; right: number; bottom: number; left: number };
  background: string;
  entities: Map<number, LayoutEntity>;
  entityOrder: number[];
  /** Per-page overrides; an absent entry uses the layer's document visibility. */
  layerVisibility?: Map<number, boolean>;
}

export type LayoutTextStyle = Pick<LayoutText, 'bold' | 'italic' | 'underline' | 'fontFamily' | 'fontSizePt' | 'color'>;
export type LayoutTextSpan = { start: number; end: number; bold: boolean; italic: boolean; underline: boolean;
  nativeUnknownFields?: Map<string, Uint8Array[]>;
  fontFamily?: string | undefined; fontSizePt?: number | undefined; color?: string | undefined };

/**
 * Line spacing of a text box: a multiple of each line's natural height, or a line height in points that
 * is exact or a minimum. Absent is single spacing.
 */
export type LayoutLineSpacing = { mode: 'multiple' | 'exactly' | 'atLeast'; value: number; nativeUnknownFields?: Uint8Array[] };

export interface LayoutText {
  nativeUnknownFields?: { outerEnvelope?: Uint8Array[]; envelope?: Uint8Array[]; extensions?: Map<string, Uint8Array[]> };
  content: string;
  spans?: LayoutTextSpan[];
  list?: 'none' | 'bullet' | 'number';
  lineSpacing?: LayoutLineSpacing;
  /** Tab stops in points from the box's left side, ascending. Absent is a stop every half inch. */
  tabStopsPt?: number[];
  fontFamily: string;
  fontSizePt: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: 'left' | 'center' | 'right';
  vertical: 'top' | 'middle' | 'bottom';
  bounded: boolean;
  /** Clockwise rotation of the text box about its center. */
  rotationDeg?: number;
  leader: 'straight' | 'elbow' | 'none';
  endpoint: 'arrow' | 'dot' | 'none';
  /**
   * How far below the box's vertical center a label's leader meets the text, in mm along the box. Absent
   * is the center; labels connected to their first or last line keep that line's middle.
   */
  leaderOffsetMm?: number | undefined;
}

/** Annotation bounds use the first two points; a label's third point is its paper anchor. */
export interface LayoutPathHandle {
  in?: [number, number] | undefined;
  out?: [number, number] | undefined;
}

export interface LayoutDimensionFields {
  outerEnvelope?: Uint8Array[];
  envelope?: Uint8Array[];
  wrapper?: Uint8Array[];
  extensions?: Map<string, Uint8Array[]>;
}

export interface LayoutDimensionAnchor {
  nativeUnknownFields?: LayoutDimensionFields;
  entityId: number;
  pointIndex: number;
  /** A changed vertex count invalidates indexed anchors instead of attaching to a different vertex. */
  pointCount: number;
  /**
   * A point along the path segment that starts at `pointIndex`, at this curve parameter (0 < t < 1; on a straight
   * segment, the fraction of its length), rather than the vertex itself.
   */
  t?: number | undefined;
}

export interface LayoutLinearDimension {
  nativeUnknownFields?: LayoutDimensionFields;
  anchors: [LayoutDimensionAnchor | null, LayoutDimensionAnchor | null];
  /** `rotated` measures along `angleDeg`. */
  alignment: 'aligned' | 'horizontal' | 'vertical' | 'rotated';
  /** A rotated dimension line's direction in degrees from the page's x axis toward +y, in [0, 180). */
  angleDeg?: number;
  /** Decimal unit; architectural and fractional are in inches, engineering in feet. */
  units: 'mm' | 'cm' | 'm' | 'inch' | 'ft' | 'pt';
  /** Absent in older documents means decimal. */
  format?: LengthFormat;
  /** Decimal places, or for architectural and fractional the smallest fraction 1/2^precision inch. */
  precision: number;
  showUnits: boolean;
  /** Drawing scale: the shown length is the paper length divided by it (0.02 is 1:50). Absent means 1:1. */
  scale?: number;
  /** Dash between feet and inches, or whole and fractional inches; absent means shown. */
  showDashes?: boolean;
  /** <> is replaced with the formatted measurement. */
  text: string;
  fontFamily: string;
  fontSizePt: number;
  endpoint: 'arrow' | 'tick' | 'dot' | 'none';
  arrowSizeMm: number;
  extensionGapMm: number;
  extensionOverrunMm: number;
  cachedValueMm: number;
  detached: boolean;
}

export interface LayoutAngularEdgeAnchor {
  nativeUnknownFields?: Uint8Array[];
  entityId: number;
  segmentIndex: number;
  pointCount: number;
  direction: 1 | -1;
}

export interface LayoutAngularDimension extends Omit<LayoutLinearDimension, 'anchors' | 'alignment' | 'units' | 'format' | 'scale' | 'showDashes' | 'cachedValueMm'> {
  anchors: [LayoutDimensionAnchor | null, LayoutDimensionAnchor | null, LayoutDimensionAnchor | null];
  edgeAnchors?: [LayoutAngularEdgeAnchor, LayoutAngularEdgeAnchor];
  /** Four points defining two ray lines; retained when points have vertex associations. */
  rayDefinition?: {
    nativeUnknownFields?: Map<string, Uint8Array[]>;
    points: [[number, number], [number, number], [number, number], [number, number]];
    anchors: [LayoutDimensionAnchor | null, LayoutDimensionAnchor | null, LayoutDimensionAnchor | null, LayoutDimensionAnchor | null];
  };
  units: 'degrees' | 'radians';
  reflex: boolean;
  cachedAngleDeg: number;
}

/** Placed raster or vector picture; `points` are its frame corners: top-left, top-right, bottom-right, bottom-left. */
export interface LayoutImage {
  nativeAssetFields?: LayoutNativeRecordFields;
  nativeUnknownFields?: { outerEnvelope?: Uint8Array[]; envelope?: Uint8Array[]; extensions?: Map<string, Uint8Array[]> };
  /** data: URL of the picture (PNG, JPEG, or SVG). */
  src: string;
  /** Crop outline in the frame's unit square ([0, 0] top-left, [1, 1] bottom-right), so it follows frame edits. */
  clip?: { points: [number, number][]; handles?: LayoutPathHandle[]; nativeUnknownFields?: Map<string, Uint8Array[]> } | undefined;
  /** Present when the picture is a view of an embedded model; `src` is then its render cache. */
  viewport?: LayoutViewport | undefined;
}

/**
 * How a viewport looks into its model. Model coordinates are meters, Z up. The frame center lies on
 * the view axis, offset by `shift` when the view is off-center.
 */
export interface LayoutViewportCamera {
  nativeUnknownFields?: Uint8Array[];
  eye: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  projection: 'perspective' | 'parallel';
  /** Vertical field of view across the frame, in degrees (perspective). */
  fov: number;
  /** Paper length per model length (parallel). */
  scale: number;
  /** Image-plane offset of the frame center from the view axis: tangent units (perspective) or meters (parallel). */
  shift?: [number, number] | undefined;
}

/**
 * What a view looks at: a model embedded in a preserved .layout package (`LayoutDocumentState.modelArchives`),
 * or a cloud model through one of the document's references (`LayoutDocumentState.references`).
 */
export type LayoutViewportSource = ({ archiveId: string; modelReferenceId: string } | { referenceId: number }) & { nativeUnknownFields?: Uint8Array[] };

/** A view of a model. */
/** How a model view draws its model, from the view's rendering options. */
export interface LayoutViewportDisplay {
  nativeUnknownFields?: Map<string, Uint8Array[]>;
  faceStyle: 'wireframe' | 'hiddenLine' | 'shaded' | 'shadedTextured' | 'monochrome';
  edges: boolean;
  profiles: boolean;
  backEdges: boolean;
  xray: boolean;
  hiddenGeometry: boolean;
  /** The view's own sun and shadow settings; absent uses the model's. */
  shadows?: ShadowSettings & { nativeUnknownFields?: Map<string, Uint8Array[]> };
}

export const LAYOUT_VIEWPORT_FACE_STYLES: readonly LayoutViewportDisplay['faceStyle'][] = ['wireframe', 'hiddenLine', 'shaded', 'shadedTextured', 'monochrome'];

export interface LayoutViewport {
  nativeUnknownFields?: Map<string, Uint8Array[]>;
  source: LayoutViewportSource;
  /** Original viewport record whose settings this viewport keeps; copies and new views share their template's. Null for a cloud source. */
  templateId: string | null;
  /** The imported viewport this object still is; copies and new views have none. */
  originalId: string | null;
  camera: LayoutViewportCamera;
  /** Keep the model's paper position and size when resizing its frame; absent means true. */
  preserveScaleOnResize?: boolean;
  /** The model scene the camera came from, or null for a custom view. */
  scene: string | null;
  /** Painted behind the model within the frame or crop; null leaves the paper visible. */
  background: string | null;
  /**
   * The camera and frame size `src` was rendered for, and for a cloud source the model revision it
   * shows (its sha256); a picture that no longer matches is stale.
   */
  cache: { nativeUnknownFields?: Map<string, Uint8Array[]>; camera: LayoutViewportCamera; widthMm: number; heightMm: number; sha256?: string | undefined } | null;
  /** The view's own display settings; absent draws the model with its own style. */
  display?: LayoutViewportDisplay;
}

/** One grid line's stroke; a transparent color hides the line. */
export interface LayoutTableEdge {
  nativeUnknownFields?: Uint8Array[];
  strokeColor: string;
  strokeWeightPt: number;
  /** Dash and gap lengths in paper millimeters; absent means solid. */
  strokeDashMm?: number[];
}

export interface LayoutTableCell {
  nativeUnknownFields?: { outerEnvelope?: Uint8Array[]; envelope?: Uint8Array[]; extensions?: Map<string, Uint8Array[]> };
  text: LayoutText;
  /** Background; absent uses the table's fill, null shows none. */
  fillColor?: string | null;
  /** Clockwise turn of the cell's text within the cell. */
  rotationDeg?: 90 | 180 | 270;
}

export interface LayoutTable {
  nativeUnknownFields?: { outerEnvelope?: Uint8Array[]; envelope?: Uint8Array[]; extensions?: Map<string, Uint8Array[]> };
  /** Positive relative sizes; the four frame corners define the paper extent. */
  rows: number[];
  columns: number[];
  /** Row-major cells. Covered cells retain their content when merged. */
  cells: LayoutTableCell[];
  merges: { row: number; column: number; rowSpan: number; columnSpan: number; nativeUnknownFields?: Uint8Array[] }[];
  /**
   * The line below each row but the last, and right of each column but the last, each with its own
   * stroke. Absent means every grid line uses the table's stroke. Merged cells interrupt them.
   */
  rowEdges?: LayoutTableEdge[];
  columnEdges?: LayoutTableEdge[];
}

export type LayoutEntityPayload = 'table' | 'image' | 'dimension' | 'angularDimension' | 'text' | 'labelAnchor' | 'modelAnnotation' | 'preservedModelConnections';

export interface LayoutEntity {
  nativeUnknownFields?: {
    emptyPayloads?: Map<LayoutEntityPayload, { envelope?: Uint8Array[]; outerEnvelope?: Uint8Array[] }>;
    outerHeader?: Uint8Array[];
    headerEnvelope?: Uint8Array[];
    header?: Uint8Array[];
    geometry?: Map<string, Uint8Array[]>;
    metadata?: Map<string, Uint8Array[]>;
  };
  id: number;
  /** Custom object browser name; absent means the default kind-and-number name. */
  name?: string;
  locked?: boolean;
  /** Hidden objects are kept and listed in the object browser but never drawn, printed, exported, picked or snapped to. */
  hidden?: boolean;
  /** Members of a selection group share an allocated document id. */
  groupId?: number;
  /** Descendant group identities, from the outer group's child to the innermost group. */
  nestedGroupIds?: number[];
  kind: 'path' | 'text' | 'label' | 'dimension' | 'angular-dimension' | 'image' | 'table';
  table?: LayoutTable;
  image?: LayoutImage;
  dimension?: LayoutLinearDimension;
  angularDimension?: LayoutAngularDimension;
  text?: LayoutText;
  /** A label's arrow tip follows this object's vertex; absent means a free paper point. */
  labelAnchor?: LayoutDimensionAnchor;
  /** Model identities remain separate from paper anchors and cached paper coordinates. */
  modelAnnotation?: {
    nativeUnknownFields?: { outerEnvelope?: Uint8Array[]; envelope?: Uint8Array[]; extensions?: Map<string, Uint8Array[]> };
    attachments: LayoutModelAttachment[];
    status: 'resolved' | 'unavailable' | 'detached';
    /** Last resolved model Auto-Text, separate from the label's authored text and formatting. */
    fields?: Record<string, string>;
  };
  /** Opaque .layout connections can be restored only while the annotation and its model views remain unchanged. */
  preservedModelConnections?: {
    nativeAssetFields?: LayoutNativeRecordFields;
    nativeUnknownFields?: { outerEnvelope?: Uint8Array[]; envelope?: Uint8Array[]; extensions?: Map<string, Uint8Array[]> };
    archiveId: string;
    originalId: string;
    snapshot: string;
    viewports: { originalId: string; entityId: number; nativeUnknownFields?: Uint8Array[] }[];
    /** Last model Auto-Text values saved in the file; the authored template remains in text.content. */
    fields?: Record<string, string>;
  };
  layerId: number;
  points: [number, number][];
  /** Absolute control points, indexed by anchor. Only paths use these. */
  handles?: LayoutPathHandle[] | undefined;
  /** Start indices of the contours in a compound path, including zero; fills use even-odd winding. */
  contourStarts?: number[];
  /**
   * Numbers of a compound path's open contours, ascending. They fill as if closed, but their
   * closing segment is not drawn, picked, or snapped to.
   */
  openContours?: number[];
  closed: boolean;
  style?: {
    nativeUnknownFields?: { records: Map<string, Uint8Array[]>; style: Map<'' | 'startArrow' | 'endArrow', Uint8Array[]> };
    strokeColor: string;
    strokeWeightPt: number;
    /** Alternating dash and gap lengths in paper millimeters; absent or empty means solid. */
    strokeDashMm?: number[];
    fillColor: string | null;
    /** Arrows at an open shape's first and last points; closed shapes draw none. */
    startArrow?: LayoutArrow;
    endArrow?: LayoutArrow;
  };
}

export interface LayoutLayer {
  nativeUnknownFields?: { envelopeUnknown?: Uint8Array[]; unknownFields?: Uint8Array[] };
  id: number;
  name: string;
  visible: boolean;
  locked: boolean;
  shared: boolean;
}

/**
 * A model the document's views look at. A cloud reference names a saved revision of a
 * PushForm model document; it follows the model's latest revision unless pinned. The
 * model's bytes are never stored in the Layout document: only the reference and each view's picture.
 */
export interface ModelReference {
  nativeUnknownFields?: { envelopeUnknown?: Uint8Array[]; unknownFields?: Uint8Array[] };
  id: number;
  displayName: string;
  target:
    | { kind: 'cloud'; documentId: string; revisionId: string; revisionNumber: number; sha256: string; pinned: boolean; nativeUnknownFields?: Uint8Array[] }
    | { kind: 'path'; path: string; contentHash: string | null; nativeUnknownFields?: Uint8Array[] };
}

/** Original .layout package retained independently from its converted paper appearance. */
export interface LayoutNativeRecordFields { envelopeUnknown?: Uint8Array[]; unknownFields?: Uint8Array[] }
export interface LayoutModelArchive {
  nativeAssetFields?: LayoutNativeRecordFields;
  nativeUnknownFields?: LayoutNativeRecordFields;
  format: 'sketchup-layout';
  /** Absent in older native files whose converted annotations did not retain their source connections. */
  annotationConnectionsVersion?: 1;
  /** Original compressed archive, encoded for native JSON persistence and worker transfer. */
  archiveBase64: string;
  models: Map<string, { internalTarget: string | null; externalTarget: string | null; nativeUnknownFields?: LayoutNativeRecordFields }>;
  /** Original viewport id -> converted paper objects; the archive retains uninterpreted settings/connections. */
  viewports: Map<string, { modelReferenceId: string | null; entityIds: number[]; nativeUnknownFields?: LayoutNativeRecordFields }>;
}

export interface LayoutDocumentState {
  nativeFieldUnknownFields?: {
    custom: Map<string, { envelopeUnknown?: Uint8Array[]; unknownFields?: Uint8Array[] }>;
    numbering: Map<string, { envelopeUnknown?: Uint8Array[]; unknownFields?: Uint8Array[] }>;
  };
  /** Unknown document/settings fields only; never file-local geometry references. */
  nativeDocumentUnknownFields?: {
    records: Map<string, Uint8Array[]>;
    metadata: {
      records: Map<'' | 'meta', Uint8Array[]>;
      settings: Map<'' | 'grid', Uint8Array[]>;
      style: Map<'' | 'startArrow' | 'endArrow', Uint8Array[]>;
    };
  };
  /** Owned opaque Protobuf root fields; immutable bytes retained through edits and native saves. */
  nativeRootUnknownFields?: Uint8Array[];
  meta: { guid: string; formatVersion: number; nextId: number };
  references: Map<number, ModelReference>;
  /** Preservation foundation: not yet an editable/live viewport implementation. */
  modelArchives?: Map<string, LayoutModelArchive>;
  pages: Map<number, LayoutPage>;
  pageOrder: number[];
  layers: Map<number, LayoutLayer>;
  layerOrder: number[];
  sharedEntities: Map<number, LayoutEntity>;
  sharedEntityOrder: number[];
  activeLayerId: number;
  settings: {
    /** Absent in older documents means enabled. */
    objectSnap?: boolean;
    units: 'mm' | 'inch' | 'architectural';
    /** Units the Document Settings dialog shows paper sizes and margins in; absent means millimeters. */
    paperUnits?: 'mm' | 'in';
    precision: number;
    anglePrecision: number;
    /** `units` is how the grid size is shown; absent means millimeters. The spacing is always stored in millimeters. */
    grid: { spacingMm: number; show: boolean; snap: boolean; angleSnapDeg: number | null; units?: 'mm' | 'in' };
    autoRender: boolean;
  };
  /** Arrows apply to the open shapes drawn next. */
  defaultStyle: { strokeColor: string; strokeWeightPt: number; fillColor: string | null; startArrow?: LayoutArrow; endArrow?: LayoutArrow };
  customFields: Map<string, string>;
  /** Page-number fields by tag name, `PageNumber` included once its settings change; absent in older documents. */
  pageNumberFields?: Map<string, LayoutPageNumbering>;
}

/** Page-number styles, in the order of the `numberingType` codes 0–5 in .layout files. */
export const LAYOUT_PAGE_NUMBER_STYLES = ['arabic', 'two-digit', 'upper-letter', 'lower-letter', 'upper-roman', 'lower-roman'] as const;
export type LayoutPageNumberStyle = (typeof LAYOUT_PAGE_NUMBER_STYLES)[number];

/** How a page-number field counts: from its start page (null: the first page), at its start number. */
export interface LayoutPageNumbering {
  startPageId: number | null;
  startNumber: number;
  style: LayoutPageNumberStyle;
}

export class LayoutDocument extends TransactionalDocument<LayoutDocumentState> {
  protected override reconcileCommit(state: LayoutDocumentState, patches: Patch[]): [LayoutDocumentState, Patch[], Patch[]] | null {
    const pages = reconcileNativePageFields(state, patches), entities = reconcileNativeEntityFields(pages?.[0] ?? state, patches);
    if (!pages) return entities;
    if (!entities) return pages;
    return [entities[0], [...pages[1], ...entities[1]], [...entities[2], ...pages[2]]];
  }
  protected override prepareCommit(draft: Draft<LayoutDocumentState>): void {
    const fields = draft.nativeFieldUnknownFields;
    if (fields) {
      for (const name of fields.custom.keys()) if (!draft.customFields.has(name)) fields.custom.delete(name);
      for (const name of fields.numbering.keys()) if (!draft.pageNumberFields?.has(name)) fields.numbering.delete(name);
      if (!fields.custom.size && !fields.numbering.size) delete draft.nativeFieldUnknownFields;
    }
    const extra = draft.nativeDocumentUnknownFields;
    if (!extra) return;
    for (const key of ['startArrow', 'endArrow'] as const) {
      // Defined arrows own their fields directly; only explicit undefined wrappers use the map.
      if (!Object.hasOwn(draft.defaultStyle, key) || draft.defaultStyle[key] !== undefined) extra.metadata.style.delete(key);
    }
    if (!extra.records.size && !extra.metadata.records.size && !extra.metadata.settings.size && !extra.metadata.style.size) delete draft.nativeDocumentUnknownFields;
  }
  readonly undoStack = new LayoutUndoStack(this);

  constructor(state: LayoutDocumentState = createLayoutDocumentState()) {
    super(prepareNativeAnnotationDictionaries(state));
  }

  addPage(name = `Page ${this.state.pageOrder.length + 1}`): number {
    return this.undoStack.transact('Add Page', (draft) => {
      const id = allocId(draft);
      // A new page takes the document's paper size and margin.
      const reference = draft.pages.get(draft.pageOrder[0]!);
      draft.pages.set(id, { ...createPage(id, name), ...(reference ? { size: [reference.size[0], reference.size[1]], margin: { ...reference.margin } } : {}) });
      draft.pageOrder.push(id);
      return id;
    });
  }

  renamePage(id: number, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Page name cannot be empty');
    this.undoStack.transact('Rename Page', (draft) => {
      const page = draft.pages.get(id);
      if (!page) throw new Error(`Unknown page: ${id}`);
      page.name = trimmed;
    });
  }

  deletePage(id: number): void {
    this.undoStack.transact('Delete Page', (draft) => {
      if (draft.pageOrder.length === 1) throw new Error('A layout needs at least one page');
      if (!draft.pages.delete(id)) throw new Error(`Unknown page: ${id}`);
      draft.pageOrder.splice(draft.pageOrder.indexOf(id), 1);
    });
  }
}

export class LayoutUndoStack {
  private undoEntries: { patches: Patch[]; inverse: Patch[]; label: string }[] = [];
  private redoEntries: { patches: Patch[]; inverse: Patch[]; label: string }[] = [];

  constructor(private readonly doc: LayoutDocument) {}

  get canUndo(): boolean {
    return this.undoEntries.length > 0;
  }
  get canRedo(): boolean {
    return this.redoEntries.length > 0;
  }

  transact<T>(label: string, fn: (draft: Draft<LayoutDocumentState>) => T): T {
    const tx = this.doc.transact(label, fn);
    if (!tx.nested && tx.patches.length > 0) {
      this.undoEntries.push({ patches: tx.patches, inverse: tx.inversePatches, label });
      this.redoEntries = [];
    }
    return tx.value;
  }

  /**
   * Change derived data without recording an undo step: a finished render or a reference
   * following its model's latest revision. The change is saved like any other.
   */
  derive<T>(label: string, fn: (draft: Draft<LayoutDocumentState>) => T): T {
    return this.doc.transact(label, fn).value;
  }

  /** The newest undo entry, compared by identity to tell whether anything was recorded since. */
  peek(): object | undefined {
    return this.undoEntries.at(-1);
  }

  undo(): boolean {
    const entry = this.undoEntries.pop();
    if (!entry) return false;
    this.doc.applyPatches(entry.inverse, entry.patches, 'undo', entry.label);
    this.redoEntries.push(entry);
    return true;
  }

  redo(): boolean {
    const entry = this.redoEntries.pop();
    if (!entry) return false;
    this.doc.applyPatches(entry.patches, entry.inverse, 'redo', entry.label);
    this.undoEntries.push(entry);
    return true;
  }
}

function createPage(id: number, name: string): LayoutPage {
  return {
    id,
    name,
    size: [297, 210],
    margin: { top: 10, right: 10, bottom: 10, left: 10 },
    background: '#ffffff',
    entities: new Map(),
    entityOrder: [],
  };
}

export function createLayoutDocumentState(): LayoutDocumentState {
  const layerId = 1;
  const pageId = 2;
  return {
    meta: { guid: newGuid(), formatVersion: LAYOUT_FORMAT_VERSION, nextId: 3 },
    references: new Map(),
    pages: new Map([[pageId, createPage(pageId, 'Page 1')]]),
    pageOrder: [pageId],
    layers: new Map([
      [layerId, { id: layerId, name: 'Layer 1', visible: true, locked: false, shared: false }],
    ]),
    layerOrder: [layerId],
    sharedEntities: new Map(),
    sharedEntityOrder: [],
    activeLayerId: layerId,
    settings: {
      units: 'mm',
      precision: 1,
      anglePrecision: 1,
      grid: { spacingMm: 10, show: true, snap: true, angleSnapDeg: null },
      autoRender: true,
    },
    defaultStyle: { strokeColor: '#222222', strokeWeightPt: 0.5, fillColor: '#ffffff' },
    customFields: new Map(),
  };
}

export function createLayoutDocument(): LayoutDocument {
  return new LayoutDocument();
}

/** Paths visible on one layer of a page, in paint order. */
export function isLayoutLayerVisible(page: LayoutPage, state: LayoutDocumentState, layerId: number): boolean {
  return state.layers.has(layerId) && (page.layerVisibility?.get(layerId) ?? state.layers.get(layerId)!.visible);
}

/** Objects on one layer, excluding content hidden on this page and hidden objects. */
export function entitiesForLayer(
  page: LayoutPage,
  state: LayoutDocumentState,
  layerId: number,
): LayoutEntity[] {
  if (!isLayoutLayerVisible(page, state, layerId)) return [];
  const source = state.layers.get(layerId)?.shared
    ? { entities: state.sharedEntities, order: state.sharedEntityOrder }
    : { entities: page.entities, order: page.entityOrder };
  return source.order.flatMap((id) => {
    const entity = source.entities.get(id);
    return entity?.layerId === layerId && !entity.hidden ? [entity] : [];
  });
}

export function entityOnPage(
  page: LayoutPage,
  state: LayoutDocumentState,
  entityId: number,
): LayoutEntity | undefined {
  return page.entities.get(entityId) ?? state.sharedEntities.get(entityId);
}
