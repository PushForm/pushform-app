// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { strFromU8, strToU8, unzipSync } from 'fflate';
import {
  LAYOUT_FORMAT_VERSION,
  LAYOUT_AUTO_TEXT_TAGS,
  LAYOUT_NON_PAGE_NUMBER_TAGS,
  LAYOUT_PAGE_NUMBER_STYLES,
  formatLayoutPageNumber,
  type LayoutPageNumbering,
  type LayoutPageNumberStyle,
  LayoutDocument,
  angularMeasurement,
  linearMeasurement,
  layoutModelConnectionSnapshot,
  bakeLayoutModelText,
  normalizeDimensionAngle,
  importLayoutText,
  layoutPathAnchorAt,
  layoutTextCenter,
  layoutTextStyleAt,
  rotateLayoutPoint,
  MAX_TABLE_AXIS,
  layoutDashMm,
  layoutArrowFromFile,
  LAYOUT_DEFAULT_ARROW_SIZE_PT,
  type LayoutArrow,
  validLayoutTable,
  validTableFrame,
  type LayoutDocumentState,
  type LayoutTable,
  type LayoutTableEdge,
  type LayoutViewportDisplay,
  type LayoutModelArchive,
  type LayoutEntity,
  type LayoutImage,
  type LayoutLayer,
  type LayoutLinearDimension,
  type LayoutPage,
  type LayoutPathHandle,
  type LayoutText,
  type LayoutViewportCamera,
} from '@pushform/layout';
import { newGuid, type LengthFormat } from '@pushform/core';
import { DEFAULT_SHADOWS, type ShadowSettings } from '@pushform/model';
import { child, childrenNamed, parseXml, type XmlElement } from './xml';
import { readLayOutCamera, viewportCameraFromLayOut } from './sketchupViewportCamera';
import { validateImportedLayoutState } from './layoutImportValidation';
import { clearPngColors } from './png';
import { pngIsBlank } from './pngBlank';
import { TiffError, tiffToPng } from './tiff';

/**
 * Import of SketchUp LayOut documents (a zip of XML parts, unchanged in structure from LayOut 2013
 * through 2026).
 */

export const SKETCHUP_LAYOUT_EXTENSION = '.layout';

export interface SketchUpLayoutImport {
  doc: LayoutDocument;
  /** Human-readable notes about content that could not be represented exactly. */
  warnings: string[];
  /** Metadata LayOut wrote into `documentProperties.xml`; every value is null when that entry is absent or unreadable. */
  properties: SketchUpLayoutProperties;
}

/**
 * A converted LayOut document before it becomes a `LayoutDocument`: plain data (Maps, arrays, strings)
 * that structured cloning carries across a worker boundary unchanged.
 */
export interface PreparedSketchUpLayout {
  state: LayoutDocumentState;
  warnings: string[];
  properties: SketchUpLayoutProperties;
}

export interface SketchUpLayoutProperties {
  /** LayOut version that last saved the file, such as `26.2.242`. */
  version: string | null;
  /** Document creation time as an ISO 8601 UTC string. */
  created: string | null;
  /** Document last-modified time as an ISO 8601 UTC string. */
  modified: string | null;
  /** LayOut's own save counter. */
  revision: number | null;
  pageCount: number | null;
}

/** Reads `documentProperties.xml`; a missing or malformed entry yields nulls because the drawing itself is still importable. */
export function readSketchUpLayoutProperties(files: Record<string, Uint8Array>): SketchUpLayoutProperties {
  const empty: SketchUpLayoutProperties = { version: null, created: null, modified: null, revision: null, pageCount: null };
  const bytes = files['documentProperties.xml'];
  if (!bytes) return empty;
  let root: XmlElement;
  try { root = parseXml(strFromU8(bytes)); } catch { return empty; }
  const date = (name: string): string | null => {
    const text = child(root, name)?.text.trim();
    const time = text ? Date.parse(text) : NaN;
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  };
  const revision = Number(child(root, 'revision')?.text.trim());
  const pageCount = Number(child(root, 'documentStatistic')?.attrs.pageCount);
  const version = child(root, 'version')?.attrs.current?.trim() || child(root, 'generator')?.attrs.version?.trim() || null;
  return {
    version: version && version.length <= 100 ? version : null,
    created: date('created'), modified: date('modified'),
    revision: Number.isInteger(revision) && revision >= 0 ? revision : null,
    pageCount: Number.isInteger(pageCount) && pageCount >= 0 ? pageCount : null,
  };
}

type Point = [number, number];
/** Affine with mRowColumn naming: x' = m11·x + m12·y + tx, y' = m21·x + m22·y + ty. */
type Affine = { m11: number; m12: number; m21: number; m22: number; tx: number; ty: number };

const MM_PER_INCH = 25.4;
const PREFIXES = {
  'http://sketchup.google.com/schemas/layout/1.0/references': 'r',
  'http://sketchup.google.com/schemas/layout/1.0/layout': 'l',
};
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
};
/** Path opcodes in `<elements>`; the counts are the points each consumes from `<points2f>`. */
const OP_MOVE = 0, OP_LINE = 1, OP_CUBIC = 2, OP_CLOSE = 3, OP_ARC_CENTER = 10;
const OP_POINTS: Record<number, number> = { [OP_MOVE]: 1, [OP_LINE]: 1, [OP_CUBIC]: 3, [OP_CLOSE]: 0, [OP_ARC_CENTER]: 1 };
/** `anchorType` bits on text boxes. */
const ANCHOR_BOTTOM = 8, ANCHOR_VCENTER = 32;
/** `componentId` of a dimension's start (5) and end (6) in a connection: its measured points. */
const DIMENSION_CONNECTION_ENDS: Record<string, 0 | 1> = { 5: 0, 6: 1 };
/** A connection's stored point finds its vertex within this; files keep about six significant digits of inches. */
const CONNECTION_TOLERANCE_MM = 0.01;
const CLOSE_TOLERANCE_IN = 1e-6;

export function isSketchUpLayoutFile(name: string): boolean {
  return name.toLowerCase().endsWith(SKETCHUP_LAYOUT_EXTENSION);
}

/** Inflate, parse and convert a .layout archive in one synchronous pass; browsers run this in a worker (see sketchupLayoutClient). */
export function prepareSketchUpLayout(bytes: Uint8Array, fileName = 'Imported', options: { preserveSources?: boolean } = {}): PreparedSketchUpLayout {
  let files: Record<string, Uint8Array>;
  try {
    // Model bytes remain in the preserved compressed package; display conversion need not inflate them.
    files = unzipSync(bytes, { filter: (file) => !file.name.toLowerCase().endsWith('.skp') });
  } catch {
    throw new Error('Invalid .layout archive');
  }
  const prepared = new Importer(files, fileName, options.preserveSources === false ? undefined : bytes).run();
  validateImportedLayoutState(prepared.state);
  return prepared;
}

/** The main-thread half of an import: wrap prepared state in a document. Kept separate so it profiles apart from conversion. */
export function installSketchUpLayout(prepared: PreparedSketchUpLayout): SketchUpLayoutImport {
  return { doc: new LayoutDocument(validateImportedLayoutState(prepared.state)), warnings: prepared.warnings, properties: prepared.properties };
}

/** Convert a .layout archive synchronously, for headless callers and tests. */
export function importSketchUpLayout(bytes: Uint8Array, fileName = 'Imported'): SketchUpLayoutImport {
  return installSketchUpLayout(prepareSketchUpLayout(bytes, fileName));
}

class Importer {
  private readonly warnings = new Map<string, number>();
  private readonly references = new Map<string, XmlElement>();
  private readonly dataUrls = new Map<string, string>();
  /** PushForm ids of the paths a LayOut path or shape became, and of the dimension or label an annotation became, by LayOut id. */
  private readonly sourceIds = new Map<string, number[]>();
  private readonly modelDistanceDimensions = new Map<number, boolean>();
  private readonly modelLabelCaches = new Map<number, Record<string, string>>();
  private nextId = 1;
  private readonly modelViewports: LayoutModelArchive['viewports'] = new Map();
  /** Viewports name their preserved package before it is assembled at the end of the import. */
  private readonly archiveId = newGuid();

  constructor(private readonly files: Record<string, Uint8Array>, private readonly fileName: string, private readonly originalArchive?: Uint8Array) {}

  run(): PreparedSketchUpLayout {
    const document = this.xml('document.xml');
    for (const reference of this.xml('references.xml').children) {
      const id = reference.attrs['r:id'];
      if (id) this.references.set(id, reference);
    }
    const info = child(document, 'pageInfo');
    if (!info) throw new Error('LayOut document has no page setup');
    const size: Point = [num(info, 'width', 8.5) * MM_PER_INCH, num(info, 'height', 11) * MM_PER_INCH];
    const margin = {
      top: num(info, 'topMargin', 0) * MM_PER_INCH, right: num(info, 'rightMargin', 0) * MM_PER_INCH,
      bottom: num(info, 'bottomMargin', 0) * MM_PER_INCH, left: num(info, 'leftMargin', 0) * MM_PER_INCH,
    };
    const background = color(info.attrs.paperColor, '#ffffff');

    // LayOut lists layers bottom-to-top, which is also PushForm's paint order.
    const layerIds = new Map<string, number>();
    const layers = new Map<number, LayoutLayer>();
    const layerOrder: number[] = [];
    const definitions = childrenNamed(child(document, 'layerManager') ?? document, 'layerDefinition');
    for (const definition of definitions) {
      const id = this.allocId();
      layerIds.set(definition.attrs.id ?? '', id);
      layers.set(id, {
        id, name: definition.attrs.name || `Layer ${layerOrder.length + 1}`,
        visible: definition.attrs.visible !== '0', locked: definition.attrs.locked === '1', shared: definition.attrs.shared === '1',
      });
      layerOrder.push(id);
    }
    if (layerOrder.length === 0) {
      const id = this.allocId();
      layers.set(id, { id, name: 'Layer 1', visible: true, locked: false, shared: false });
      layerOrder.push(id);
    }
    const currentLayer = layerIds.get(child(child(document, 'layerManager') ?? document, 'currentLayerDefinition')?.attrs['l:ref'] ?? '');
    const activeLayerId = currentLayer !== undefined && !layers.get(currentLayer)!.shared ? currentLayer
      : layerOrder.find((id) => !layers.get(id)!.shared) ?? layerOrder[0]!;

    const customFields = new Map<string, string>([['FileName', this.fileName.replace(/\.layout$/i, '')]]);
    const autoText = new Map(LAYOUT_AUTO_TEXT_TAGS.map(name => [name, `<${name}>`]));
    for (const definition of child(document, 'autoTextManager')?.children.flatMap((item) => item.children) ?? []) {
      const name = definition.attrs.name;
      if (!name || autoText.has(name)) continue;
      if (definition.attrs.type === '3') {
        customFields.set(name, definition.attrs.textValue ?? '');
        autoText.set(name, `<${name}>`);
      }
    }
    // Page-number auto-text (type 2) counts pages from the page it refers to (`l:ref`, a pageRef's r:id), from its start
    // number, in its numbering style; LayOut shows nothing on earlier pages. Each becomes a live page-number field
    // LayOut's PageNumber is <PageNumber> with its settings, and another name that numbers as the default
    // does is <PageNumber> too. The start page becomes a page id once the pages are read.
    const pageRefIds = childrenNamed(child(document, 'pageManager') ?? document, 'pageRef').map((ref) => ref.attrs['r:id'] ?? '');
    const pageNumbers = new Map<string, { from: number; startNumber: number; style: LayoutPageNumberStyle }>();
    for (const definition of child(document, 'autoTextManager')?.children.flatMap((item) => item.children) ?? []) {
      const name = definition.attrs.name;
      if (definition.attrs.type !== '2' || !name || /[<>\r\n]/.test(name) || LAYOUT_NON_PAGE_NUMBER_TAGS.includes(name)) continue;
      pageNumbers.set(name, { from: Math.max(0, pageRefIds.indexOf(definition.attrs['l:ref'] ?? '')), startNumber: Math.max(0, Math.round(num(definition, 'startNumber', 1))),
        style: LAYOUT_PAGE_NUMBER_STYLES[num(definition, 'numberingType', 0)] ?? 'arabic' });
    }
    const isDefaultNumbering = (numbering: { from: number; startNumber: number; style: string } | undefined): boolean =>
      !numbering || (numbering.from === 0 && numbering.startNumber === 1 && numbering.style === 'arabic');
    // Another name numbering as the default does only stands for <PageNumber> while PageNumber itself is the default.
    const plainPageNumber = isDefaultNumbering(pageNumbers.get('PageNumber'));
    for (const [name, numbering] of pageNumbers) {
      customFields.delete(name);
      if (isDefaultNumbering(numbering) && (name === 'PageNumber' || plainPageNumber)) {
        autoText.set(name, '<PageNumber>');
        pageNumbers.delete(name);
      } else autoText.set(name, `<${name}>`);
    }
    // Sequence auto-text (type 26) numbers items: "Sheet A###" with start 1 shows Sheet A1, Sheet A2, ….
    const sequences = new Map<string, { format: string; start: number; style: number }>();
    for (const definition of child(document, 'autoTextManager')?.children.flatMap((item) => item.children) ?? []) {
      if (definition.attrs.type === '26' && definition.attrs.name) sequences.set(definition.attrs.name, {
        format: definition.attrs.sequenceFormat ?? '###', start: num(definition, 'startNumber', 1), style: num(definition, 'numberingType', 0),
      });
    }
    const pageNames = childrenNamed(child(document, 'pageManager') ?? document, 'pageRef').map((ref) => ref.attrs.name ?? '');
    // Indexed and sequence auto-text has no PushForm field, so it becomes the text LayOut shows.
    const resolve = (name: string, index: number | null): string | undefined => {
      if (name === 'PageName' && index !== null) return pageNames[index - 1] ?? '';
      const sequence = sequences.get(name);
      if (!sequence || index === null) return undefined;
      return sequence.format.replace(/#+/, formatSequenceNumber(sequence.start + index - 1, sequence.style));
    };
    const context = { autoText, layers, resolve };

    // LayOut 2015 and earlier keep shared content inline in each shared layer definition's instance.
    const shared = child(document, 'layerEntityManager')
      ? this.layerEntities(child(document, 'layerEntityManager'), layerIds, context, null)
      : this.inlineLayerEntities(definitions.flatMap((definition) => childrenNamed(definition, 'layerInstance')), layerIds, context, null);
    const sharedEntities = new Map<number, LayoutEntity>();
    const sharedEntityOrder: number[] = [];
    for (const entity of shared) {
      if (!layers.get(entity.layerId)?.shared) { this.warn('content on a non-shared layer in the document master was dropped'); continue; }
      sharedEntities.set(entity.id, entity);
      sharedEntityOrder.push(entity.id);
    }

    const pages = new Map<number, LayoutPage>();
    const pageOrder: number[] = [];
    /** Each imported page's position among LayOut's page references, which page-number start pages count in. */
    const pagePositions = new Map<number, number>();
    const pageXmls: XmlElement[] = [];
    for (const pageRef of childrenNamed(child(document, 'pageManager') ?? document, 'pageRef')) {
      const target = this.references.get(pageRef.attrs['r:id'] ?? '')?.attrs.internalTarget;
      if (!target || !this.files[target]) { this.warn('a page whose content is missing was skipped'); continue; }
      const visibility = (child(pageRef, 'layerVisibility')?.text ?? '').split(',').map((value) => value.trim());
      const hidden = new Set(definitions.flatMap((definition, index) => visibility[index] === '0' ? [layerIds.get(definition.attrs.id ?? '')!] : []));
      const id = this.allocId();
      const page: LayoutPage = {
        id, name: pageRef.attrs.name || `Page ${pageOrder.length + 1}`, size, margin, background,
        entities: new Map(), entityOrder: [],
        layerVisibility: new Map(definitions.flatMap((definition, index): [number, boolean][] =>
          visibility[index] === '0' || visibility[index] === '1' ? [[layerIds.get(definition.attrs.id ?? '')!, visibility[index] === '1']] : [])),
      };
      const pageXml = this.xml(target);
      pageXmls.push(pageXml);
      pagePositions.set(id, pageRefIds.indexOf(pageRef.attrs['r:id'] ?? ''));
      const pageEntities = child(pageXml, 'layerEntityManager')
        ? this.layerEntities(child(pageXml, 'layerEntityManager'), layerIds, context, hidden)
        : this.inlineLayerEntities(childrenNamed(child(pageXml, 'layerInstanceManager') ?? pageXml, 'layerInstance'), layerIds, context, hidden);
      for (const entity of pageEntities) {
        if (layers.get(entity.layerId)?.shared) { this.warn('page content on a shared layer was dropped'); continue; }
        page.entities.set(entity.id, entity);
        page.entityOrder.push(entity.id);
      }
      pages.set(id, page);
      pageOrder.push(id);
    }
    if (pageOrder.length === 0) throw new Error('LayOut document has no readable pages');
    // LayOut 2015 and later keep connections in the document; earlier versions keep each page's in the page.
    this.connect([document, ...pageXmls], pages, sharedEntities);
    // A start page that was not imported hands its start to the next page that was.
    const pageNumberFields = new Map([...pageNumbers].map(([name, { from, startNumber, style }]): [string, LayoutPageNumbering] => {
      const startPageId = from === 0 ? null : pageOrder.find((id) => pagePositions.get(id)! >= from) ?? pageOrder.at(-1)!;
      return [name, { startPageId: startPageId === pageOrder[0] ? null : startPageId, startNumber, style }];
    }));

    const units = child(document, 'unitsInfo');
    const state: LayoutDocumentState = {
      meta: { guid: newGuid(), formatVersion: LAYOUT_FORMAT_VERSION, nextId: this.nextId },
      references: new Map(),
      ...(this.modelViewports.size && this.originalArchive ? { modelArchives: new Map([[this.archiveId, {
        format: 'sketchup-layout' as const,
        annotationConnectionsVersion: 1 as const,
        archiveBase64: base64(this.originalArchive),
        models: new Map([...this.references].filter(([, reference]) => reference.name === 'skpFileReference').map(([id, reference]) =>
          [id, { internalTarget: reference.attrs.internalTarget || null, externalTarget: reference.attrs.externalTarget || null }])),
        viewports: this.modelViewports,
      }]]) } : {}),
      pages, pageOrder, layers, layerOrder, sharedEntities, sharedEntityOrder, activeLayerId,
      settings: {
        units: units?.attrs.unit === '2' || units?.attrs.unit === '3' || units?.attrs.unit === '4' ? 'mm' : 'inch',
        precision: 1,
        anglePrecision: 1,
        grid: { spacingMm: Math.max(1, num(child(document, 'grid') ?? info, 'majorSpacing', 1) * MM_PER_INCH), show: false, snap: false, angleSnapDeg: null },
        autoRender: false,
      },
      defaultStyle: { strokeColor: '#000000', strokeWeightPt: 1, fillColor: null },
      customFields,
      ...(pageNumberFields.size ? { pageNumberFields } : {}),
    };
    return {
      state,
      warnings: [...this.warnings].map(([message, count]) => count > 1 ? `${message} (${count}×)` : message),
      properties: readSketchUpLayoutProperties(this.files),
    };
  }

  /**
   * LayOut 2015 and earlier: each layer instance holds its entities inline in its entity list (no shared
   * entity list and no references). An instance with only an `l:ref` points at a shared layer's content,
   * which is read from the document instead.
   */
  private inlineLayerEntities(instances: XmlElement[], layerIds: Map<string, number>,
    context: EntityContext, hidden: Set<number> | null): LayoutEntity[] {
    const result: LayoutEntity[] = [];
    for (const instance of instances) {
      const layerId = layerIds.get(child(instance, 'layerDefinition')?.attrs['l:ref'] ?? '');
      const entities = child(instance, 'entityList')?.children ?? [];
      if (layerId === undefined || !entities.length) continue;
      if (hidden?.has(layerId)) { this.warn('content on layers hidden for its page was skipped'); continue; }
      for (const element of entities) result.push(...this.entity(element, layerId, context));
    }
    return result;
  }

  /** Entities of one layerEntityManager in layer and stacking order. */
  private layerEntities(manager: XmlElement | undefined, layerIds: Map<string, number>,
    context: EntityContext, hidden: Set<number> | null): LayoutEntity[] {
    if (!manager) return [];
    // Layers reference leaves, so retain each leaf's group ancestry while indexing it.
    const byId = new Map<string, XmlElement>();
    const ancestry = new Map<XmlElement, number[]>();
    const index = (entity: XmlElement, groups: number[]): void => {
      if (entity.name === 'group') {
        const nested = [...groups, this.allocId()];
        entity.children.forEach(item => index(item, nested));
      } else {
        byId.set(entity.attrs.id ?? `#${byId.size}`, entity);
        ancestry.set(entity, groups);
      }
    };
    child(manager, 'entityList')?.children.forEach(entity => index(entity, []));
    const assigned = new Map<number, XmlElement[]>();
    const placed = new Set<XmlElement>();
    for (const instance of childrenNamed(child(manager, 'layerInstanceManager') ?? manager, 'layerInstance')) {
      const layerId = layerIds.get(child(instance, 'layerDefinition')?.attrs['l:ref'] ?? '');
      if (layerId === undefined) continue;
      const list = assigned.get(layerId) ?? [];
      for (const ref of child(instance, 'entityList')?.children ?? []) {
        const entity = byId.get(ref.attrs['l:ref'] ?? '');
        if (entity && !placed.has(entity)) { list.push(entity); placed.add(entity); }
      }
      assigned.set(layerId, list);
    }
    const unassigned = [...byId.values()].filter((entity) => !placed.has(entity));
    if (unassigned.length) this.warn('content without a layer was placed on the first layer');
    const result: LayoutEntity[] = [];
    const convert = (element: XmlElement, layerId: number): LayoutEntity[] => {
      const groups = ancestry.get(element) ?? [];
      return this.entity(element, layerId, context).map(({ groupId, nestedGroupIds, ...entity }) => {
        // A placed vector file arrives already grouped; it nests inside the page groups that hold it.
        const chain = [...groups, ...(groupId === undefined ? [] : [groupId, ...(nestedGroupIds ?? [])])];
        return { ...entity,
          ...(chain.length ? { groupId: chain[0]! } : {}),
          ...(chain.length > 1 ? { nestedGroupIds: chain.slice(1) } : {}),
        };
      });
    };
    for (const [layerId, entities] of assigned) {
      if (hidden?.has(layerId)) {
        if (entities.length) this.warn(`content on layers hidden for its page was skipped`);
        continue;
      }
      for (const entity of entities) result.push(...convert(entity, layerId));
    }
    const fallback = [...context.layers.keys()].find((id) => !context.layers.get(id)!.shared) ?? [...context.layers.keys()][0]!;
    for (const entity of unassigned) result.push(...convert(entity, fallback));
    return result;
  }

  private entity(element: XmlElement, layerId: number, context: EntityContext): LayoutEntity[] {
    const entities = this.convertEntity(element, layerId, context);
    // Connections name their ends by LayOut id; remember what each became.
    const sourceId = element.attrs.id;
    // Text and pictures only so the report can say what a connection it does not keep was attached to.
    if (sourceId && ['path', 'rectangle', 'ellipse', 'linearDimension', 'label', 'rtfText', 'image'].includes(element.name)) {
      // Ids repeat across the pages of some old files; a repeated id cannot say which entity a connection meant.
      this.sourceIds.set(sourceId, this.sourceIds.has(sourceId) ? [] : entities.map((entity) => entity.id));
    }
    return entities;
  }

  /**
   * Dimension ends and label tips LayOut connects to a vertex of a path or shape, or to a point along one of its
   * segments (`connectionManager`), stay connected to it as PushForm anchors. Other connections
   * keep their points where they are, reported.
   */
  private connect(roots: XmlElement[], pages: Map<number, LayoutPage>, shared: Map<number, LayoutEntity>): void {
    const homes = new Map<number, Map<number, LayoutEntity>>();
    for (const page of pages.values()) for (const id of page.entities.keys()) homes.set(id, page.entities);
    for (const id of shared.keys()) homes.set(id, shared);
    const preserved = new Set<LayoutEntity>();
    const modelPoints = new Map<number, Map<number, { view: string; point: [number, number, number] }>>();
    const imported = (sourceId: string | undefined, kind: LayoutEntity['kind']): { entity: LayoutEntity; home: Map<number, LayoutEntity> }[] =>
      (this.sourceIds.get(sourceId ?? '') ?? []).flatMap((id) => {
        const home = homes.get(id), entity = home?.get(id);
        return home && entity?.kind === kind ? [{ entity, home }] : [];
      });
    for (const root of roots) {
      for (const connection of childrenNamed(child(root, 'connectionManager') ?? root, 'connection')) {
        const dimensionEnd = child(connection, 'dimensionConnectionPoint'), labelTip = child(connection, 'labelConnectionPoint');
        const [owner] = dimensionEnd ? imported(dimensionEnd.attrs['l:ref'], 'dimension') : labelTip ? imported(labelTip.attrs['l:ref'], 'label') : [];
        // Connections between other objects (text and leaders of LayOut 3 callouts) have no PushForm meaning.
        if (!owner) continue;
        const end = dimensionEnd ? DIMENSION_CONNECTION_ENDS[dimensionEnd.attrs.componentId ?? ''] : 0;
        const target = child(connection, 'connectionPoint');
        const modelTarget = child(connection, 'sketchupConnectionPoint');
        if (end !== undefined && dimensionEnd && modelTarget) {
          const point = child(modelTarget, 'modelPoint');
          const coordinates: [number, number, number] = [num(point ?? modelTarget, 'x', NaN), num(point ?? modelTarget, 'y', NaN), num(point ?? modelTarget, 'z', NaN)];
          if (point && coordinates.every(Number.isFinite)) {
            let ends = modelPoints.get(owner.entity.id);
            if (!ends) modelPoints.set(owner.entity.id, ends = new Map());
            ends.set(end, { view: modelTarget.attrs['l:ref'] ?? '', point: coordinates });
          }
        }
        if (end !== undefined && modelTarget && this.originalArchive) {
          const originalViewId = modelTarget.attrs['l:ref'] ?? '';
          const viewIds = this.modelViewports.get(originalViewId)?.entityIds;
          const viewId = viewIds?.length === 1 ? viewIds[0] : undefined;
          if (viewId !== undefined && (homes.get(viewId) === owner.home || homes.get(viewId) === shared)) {
            const entity = owner.entity;
            entity.preservedModelConnections ??= { archiveId: this.archiveId,
              originalId: (dimensionEnd ?? labelTip)!.attrs['l:ref']!, snapshot: '', viewports: [] };
            const fields = this.modelLabelCaches.get(entity.id);
            if (fields) entity.preservedModelConnections.fields = fields;
            if (!entity.preservedModelConnections.viewports.some(view => view.originalId === originalViewId))
              entity.preservedModelConnections.viewports.push({ originalId: originalViewId, entityId: viewId });
            preserved.add(entity);
            this.warn('Imported model annotation connections are preserved for unchanged export; live model updates are not yet supported for these connections');
            continue;
          }
        }
        if (end === undefined || !target) {
          this.warn(child(connection, 'sketchupConnectionPoint') || child(connection, 'pathFaceConnectionPoint')
            ? 'dimensions and labels attached to model views keep their points but are no longer attached'
            : 'dimensions and labels attached to other annotations keep their points but are no longer attached');
          continue;
        }
        // Type 1 is a vertex; 2 and 8 a point along a straight segment and 4 along a curved one, by segment index plus
        // curve parameter; 32 a point inside an object's bounds by fractions of its width and height; 16 (pictures, model
        // views), 64 and 128 are not known. Text targets use the same types on the text's box.
        const position = toMm([num(target, 'x', NaN), num(target, 'y', NaN)]);
        const type = target.attrs.type ?? '';
        const onPath = type === '1' || type === '2' || type === '4' || type === '8';
        const anchor = onPath ? imported(target.attrs['l:ref'], 'path')
          // An annotation follows a shape on its own page or on a shared layer; a shared one only shared shapes.
          .filter(({ home }) => home === owner.home || home === shared)
          .flatMap(({ entity }) => {
            if (type !== '1') {
              // Found by its point rather than `param1`, since a LayOut path can import as several paths.
              const along = layoutPathAnchorAt(entity, position, CONNECTION_TOLERANCE_MM);
              return along ? [along] : [];
            }
            const index = entity.points.findIndex((point) => Math.hypot(point[0] - position[0], point[1] - position[1]) <= CONNECTION_TOLERANCE_MM);
            return index < 0 ? [] : [{ entityId: entity.id, pointIndex: index, pointCount: entity.points.length }];
          // An open filled path imports as its fill and then its stroke; the stroke is the line LayOut connected to.
          }).at(-1) : undefined;
        if (!anchor) {
          this.warn(type === '32'
            ? 'dimensions and labels attached to points inside text or shapes keep their points but are no longer attached'
            : onPath && !imported(target.attrs['l:ref'], 'text').length && !imported(target.attrs['l:ref'], 'image').length
              ? 'dimensions and labels attached to shapes that were not imported keep their points but are no longer attached'
              : 'dimensions and labels attached to text, pictures or view frames keep their points but are no longer attached');
          continue;
        }
        const entity = owner.entity;
        // LayOut keeps a connection whose annotation was moved off the vertex but leaves the annotation where it is
        // ("soft disconnect"); attaching it would move it, so it stays a free point.
        const angle = entity.text?.rotationDeg ?? 0;
        const drawn = entity.dimension ? entity.points[end]! : rotateLayoutPoint(entity.points[2]!, layoutTextCenter(entity), angle);
        if (Math.hypot(drawn[0] - position[0], drawn[1] - position[1]) > CONNECTION_TOLERANCE_MM) {
          this.warn('dimensions and labels LayOut shows away from the vertex they are connected to keep their points but are no longer attached');
          continue;
        }
        if (entity.dimension) entity.dimension.anchors = end === 0 ? [anchor, entity.dimension.anchors[1]] : [entity.dimension.anchors[0], anchor];
        else entity.labelAnchor = anchor;
      }
    }
    for (const [id, missingValue] of this.modelDistanceDimensions) {
      const dimension = homes.get(id)?.get(id)?.dimension, points = modelPoints.get(id), a = points?.get(0), b = points?.get(1);
      const length = a && b && a.view && a.view === b.view ? Math.hypot(...a.point.map((value, index) => value - b.point[index]!)) * MM_PER_INCH : 0;
      if (dimension && length > 0) dimension.scale = dimension.cachedValueMm / length;
      else if (missingValue) this.warn('dimensions measured in a model viewport without a saved value show their stored scale');
    }
    for (const [id, fields] of this.modelLabelCaches) {
      const entity = homes.get(id)?.get(id);
      if (entity?.text && !entity.preservedModelConnections) entity.text = bakeLayoutModelText(entity.text, fields);
    }
    for (const entity of preserved) entity.preservedModelConnections!.snapshot = layoutModelConnectionSnapshot(entity);
  }

  private convertEntity(element: XmlElement, layerId: number, context: EntityContext): LayoutEntity[] {
    switch (element.name) {
      case 'group':
        return element.children.flatMap((item) => this.entity(item, layerId, context));
      case 'path':
        return this.path(element, layerId);
      case 'rectangle':
      case 'ellipse':
        return this.shape(element, layerId);
      case 'rtfText':
        return this.text(element, layerId, context);
      case 'linearDimension':
      case 'angularDimension': {
        // Some files store a dimension's line as NaN; there is nothing to rebuild or draw.
        const line = child(element, 'dimensionLine');
        if (line && !parsePath(line).every(finiteSubpath)) { this.warn('dimensions LayOut saved without a valid position were skipped'); return []; }
        const rebuilt = element.name === 'linearDimension' ? this.linearDimension(element, layerId, context) : this.angularDimension(element, layerId, context);
        return rebuilt ?? this.dimension(element, layerId, context);
      }
      case 'label':
        return this.label(element, layerId, context);
      case 'image':
        return this.image(element, layerId);
      case 'skpModelRef':
        return this.viewport(element, layerId);
      case 'VectorEntityRef':
        return this.vectorReference(element, layerId, context);
      case 'scaleContext':
        // A scaled group's drawing scale ("1/8" = 1'-0"") and units: metadata with nothing to draw.
        return [];
      case 'table':
        return this.table(element, layerId, context);
      default:
        this.warn(`unsupported "${element.name}" content was skipped`);
        return [];
    }
  }

  /**
   * A placed DWG/DXF file. LayOut keeps the drawing it rendered in `<vectordata>` as ordinary paths already
   * in page coordinates (its placement transform applied), so those are imported as one group; the CAD file
   * itself is not read.
   */
  private vectorReference(element: XmlElement, layerId: number, context: EntityContext): LayoutEntity[] {
    const data = child(element, 'vectordata');
    if (!data) { this.warn('a placed CAD file without LayOut\'s cached drawing was skipped'); return []; }
    const entities = data.children.flatMap((item) => this.entity(item, layerId, context));
    if (entities.length < 2) return entities;
    const groupId = this.allocId();
    return entities.map((entity) => ({ ...entity, groupId }));
  }

  private path(element: XmlElement, layerId: number): LayoutEntity[] {
    const graphic = child(element, 'graphicEntity');
    const subpaths = parsePath(element);
    // The start arrow goes on the first subpath and the end arrow on the last.
    const { startArrow, endArrow } = this.pathArrows(element, subpaths, graphic);
    // Closed subpaths, and the open ones of a filled path without arrows, stay one compound path. Open
    // contours fill as if closed but keep their closing segment undrawn; a lone point draws nothing and is dropped.
    const compound = subpaths.length > 1 && (subpaths.every(subpath => subpath.closed && subpath.points.length >= 3) ||
      Boolean(graphic && fills(graphic)) && !startArrow && !endArrow);
    const contours = compound ? subpaths.filter(subpath => subpath.points.length >= (subpath.closed ? 3 : 2)) : [];
    if (contours.length === 1) return this.pathEntity(contours[0]!, graphic, layerId);
    if (contours.length > 1) {
      const contourStarts: number[] = [], openContours: number[] = [];
      const points: Point[] = [], handles: LayoutPathHandle[] = [];
      contours.forEach((subpath, index) => {
        if (!subpath.closed) openContours.push(index);
        contourStarts.push(points.length); points.push(...subpath.points); handles.push(...subpath.handles);
      });
      return this.pathEntity({ points, handles, closed: true }, graphic, layerId)
        .map(entity => ({ ...entity, contourStarts, ...(openContours.length ? { openContours } : {}) }));
    }
    const entities = subpaths.flatMap((subpath, index) => this.pathEntity(subpath, graphic, layerId, {
      ...(index === 0 && startArrow ? { startArrow } : {}),
      ...(index === subpaths.length - 1 && endArrow ? { endArrow } : {}),
    }));
    if (!compound && subpaths.length > 1 && graphic && fills(graphic)) this.warn('filled paths with arrows were split into separate shapes, one per subpath');
    return entities;
  }

  private pathEntity(subpath: Subpath, graphic: XmlElement | undefined, layerId: number,
    arrows: { startArrow?: LayoutArrow; endArrow?: LayoutArrow } = {}): LayoutEntity[] {
    if (subpath.points.length < 2 && !subpath.closed) return [];
    const style = pathStyle(graphic);
    if (!style) return [];
    const entity = (closed: boolean, entityStyle: NonNullable<LayoutEntity['style']>): LayoutEntity => ({
      id: this.allocId(), kind: 'path', layerId,
      points: subpath.points.map(toMm),
      ...(subpath.handles.some((handle) => handle.in || handle.out) ? { handles: subpath.handles.map(handleToMm) } : {}),
      closed,
      style: entityStyle,
    });
    // LayOut fills an open path as if it were closed but strokes only its drawn segments.
    if (!subpath.closed && style.fillColor && subpath.points.length >= 3) {
      const stroked = style.strokeColor !== '#00000000';
      return [
        entity(true, { ...style, strokeColor: '#00000000' }),
        ...(stroked ? [entity(false, { ...style, fillColor: null, ...arrows })] : []),
      ];
    }
    return [entity(subpath.closed, subpath.closed ? style : { ...style, ...arrows })];
  }

  /** An open, stroked path's start and end arrows. LayOut's underrun and overrun ends are not arrows. */
  private pathArrows(element: XmlElement, subpaths: Subpath[], graphic: XmlElement | undefined): { startArrow?: LayoutArrow; endArrow?: LayoutArrow } {
    const data = child(element, 'arrowData');
    if (!data || !subpaths.length || subpaths.at(-1)!.closed || !graphic || !strokes(graphic)) return {};
    const read = (typeKey: string, sizeKey: string): LayoutArrow | null => {
      const code = Number(data.attrs[typeKey] ?? 0);
      // Sizes are points, as LayOut's arrow size units are.
      const arrow = layoutArrowFromFile(code, num(data, sizeKey, LAYOUT_DEFAULT_ARROW_SIZE_PT));
      if (!arrow && code !== 0 && code !== ARROW_UNDERRUN && code !== ARROW_OVERRUN) this.warn(`arrowhead style ${code} was drawn as a plain line end`);
      return arrow;
    };
    const startArrow = read('startArrowType', 'startArrowSize'), endArrow = read('endArrowType', 'endArrowSize');
    return { ...(startArrow ? { startArrow } : {}), ...(endArrow ? { endArrow } : {}) };
  }

  private shape(element: XmlElement, layerId: number): LayoutEntity[] {
    const base = child(element, 'rectangleBase');
    if (!base) return [];
    const { x, y, width, height, transform } = rectangle(base);
    const rounding = num(element, 'rounding', 0);
    // `shape` follows Layout::Rectangle::TYPE_*: 0 normal, 1 rounded, 2 lozenge, 3 bulged.
    const variant = element.name === 'ellipse' ? 'ellipse' : element.attrs.shape ?? '0';
    if (!['ellipse', '0', '1', '2', '3'].includes(variant)) this.warn(`rectangle variant ${variant} was imported as a plain rectangle`);
    const subpath = variant === 'ellipse' ? ellipse(x, y, width, height)
      : variant === '2' ? roundedRectangle(x, y, width, height, Math.min(Math.abs(width), Math.abs(height)) / 2)
        : variant === '3' ? bulgedRectangle(x, y, width, height, rounding)
          : roundedRectangle(x, y, width, height, rounding > 0 ? rounding : 0);
    return this.pathEntity(transformSubpath(subpath, transform), child(base, 'graphicEntity'), layerId);
  }

  private text(element: XmlElement, layerId: number, context: EntityContext): LayoutEntity[] {
    const base = child(child(element, 'placedFileReference') ?? element, 'rectangleBase');
    const rtf = child(element, 'rtfTextRep')?.text;
    if (!base || rtf === undefined) return [];
    const { x, y, width, height, transform } = rectangle(base);
    // Keep the unrotated box size around the transformed center; the rotation goes on the text.
    const center = apply(transform, [x + width / 2, y + height / 2]);
    const halfWidth = width * Math.hypot(transform.m11, transform.m21) / 2;
    const halfHeight = height * Math.hypot(transform.m12, transform.m22) / 2;
    const rotation = Math.atan2(transform.m21, transform.m11) * 180 / Math.PI;
    // A bare sequence tag shows this text's own place in the sequence.
    const sequenceIndex = Number(element.attrs.sequenceIndex ?? -1);
    const resolve = (name: string, index: number | null): string | undefined => context.resolve(name,
      index ?? (name === element.attrs.sequenceAutoTextDef && sequenceIndex >= 0 ? sequenceIndex + 1 : null));
    const text = rtfText(rtf, context.autoText, Number(element.attrs.anchorType ?? 5), element.attrs.growMode === '1', resolve);
    if (!text) return [];
    if (Math.abs(rotation) > 0.01) text.rotationDeg = Math.round(rotation * 1e4) / 1e4;
    // A LayOut text box can be filled and stroked like a shape; PushForm text cannot, so the box is
    // drawn as a rectangle behind the text.
    const boxGraphic = child(base, 'graphicEntity');
    const box = boxGraphic && (fills(boxGraphic) || strokes(boxGraphic))
      ? this.pathEntity(transformSubpath(roundedRectangle(x, y, width, height, 0), transform), boxGraphic, layerId) : [];
    return [...box, {
      id: this.allocId(), kind: 'text', layerId,
      points: [toMm([center[0] - halfWidth, center[1] - halfHeight]), toMm([center[0] + halfWidth, center[1] + halfHeight])],
      closed: false, text,
    }];
  }

  /**
   * LayOut linear dimension as a PushForm dimension: the measured points, the dimension line's
   * placement and direction, its units, text template, font, endpoints, and extension lines.
   * Returns null when the dimension lacks the geometry to rebuild it.
   */
  private linearDimension(element: XmlElement, layerId: number, context: EntityContext): LayoutEntity[] | null {
    const parts = this.dimensionParts(element, context);
    if (!parts) return null;
    const { a, b, line, dim, style } = parts;
    const along: Point = [line[1][0] - line[0][0], line[1][1] - line[0][1]];
    const chord: Point = [b[0] - a[0], b[1] - a[1]];
    const lineLength = Math.hypot(...along), chordLength = Math.hypot(...chord);
    if (lineLength < 1e-9 || chordLength < 1e-9) return null;
    const parallel = Math.abs(along[0] * chord[1] - along[1] * chord[0]) / (lineLength * chordLength) < 1e-4;
    // A line at any other angle is a rotated dimension measuring along it.
    const alignment = parallel ? 'aligned' : Math.abs(along[1]) < 1e-6 * lineLength ? 'horizontal' : Math.abs(along[0]) < 1e-6 * lineLength ? 'vertical' : 'rotated';
    const angleDeg = normalizeDimensionAngle(Math.atan2(along[1], along[0]) * 180 / Math.PI);
    const value = alignment === 'rotated' ? linearMeasurement(a, b, 'rotated', angleDeg)
      : alignment === 'aligned' ? chordLength : alignment === 'horizontal' ? Math.abs(chord[0]) : Math.abs(chord[1]);
    if (value < 1e-9) return null;
    // Any point on the dimension line places it; the middle is where PushForm's tool usually leaves it.
    const place: Point = [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2];
    const { scale, missingModelValue } = this.dimensionScale(element, dim, parts.shown, value);
    const id = this.allocId();
    if (element.attrs.useInModelDistance === '1') this.modelDistanceDimensions.set(id, missingModelValue);
    return [{
      id, kind: 'dimension', layerId, points: [toMm(a), toMm(b), toMm(place)], closed: false, style,
      dimension: { anchors: [null, null], alignment, ...(alignment === 'rotated' ? { angleDeg } : {}), ...dim, ...(scale === 1 ? {} : { scale }), cachedValueMm: value * MM_PER_INCH, detached: false },
    }];
  }

  /**
   * The drawing scale: the shown length is the paper length divided by it. Dimensions LayOut measures
   * in a model viewport's space ignore `scale`; their saved value implies the viewport's scale instead.
   */
  private dimensionScale(element: XmlElement, dim: Pick<LayoutLinearDimension, 'format' | 'units' | 'text'>,
    shown: string | undefined, paperInches: number): { scale: number; missingModelValue: boolean } {
    const stored = Number(element.attrs.scale ?? 1);
    const fixed = Number.isFinite(stored) && stored > 0 ? stored : 1;
    // Custom text without `<>` never shows the measurement, so its scale does not matter.
    if (element.attrs.useInModelDistance !== '1' || !dim.text.includes('<>')) return { scale: fixed, missingModelValue: false };
    const modelInches = shown === undefined ? null : parseLayoutLength(templateValue(shown, dim.text), dim.format ?? 'decimal', dim.units);
    if (modelInches && modelInches > 0 && paperInches > 0) return { scale: paperInches / modelInches, missingModelValue: false };
    return { scale: fixed, missingModelValue: true };
  }

  /** LayOut angular dimension as a PushForm angular dimension about its arc center. */
  private angularDimension(element: XmlElement, layerId: number, context: EntityContext): LayoutEntity[] | null {
    const parts = this.dimensionParts(element, context);
    const center = child(element, 'arcCenter');
    if (!parts || !center) return null;
    const vertex: Point = [num(center, 'x', 0), num(center, 'y', 0)];
    const reflex = element.attrs.insideAngle === '0';
    const points = [vertex, parts.a, parts.b].map(toMm) as [Point, Point, Point];
    const angle = angularMeasurement(...points, reflex);
    if (angle === null) return null;
    const { units: _units, format: _format, showDashes: _showDashes, ...dim } = parts.dim;
    return [{
      id: this.allocId(), kind: 'angular-dimension', layerId, points: [...points, toMm(parts.line[0])], closed: false, style: parts.style,
      angularDimension: { anchors: [null, null, null], ...dim, units: parts.unit === UNIT_RADIANS ? 'radians' : 'degrees', reflex, cachedAngleDeg: angle, detached: false },
    }];
  }

  /** What linear and angular dimensions share: measured points, dimension line, style, and settings. */
  private dimensionParts(element: XmlElement, context: EntityContext) {
    const start = child(element, 'startConnectionPoint'), end = child(element, 'endConnectionPoint');
    const lineElement = child(element, 'dimensionLine');
    const line = lineElement ? parsePath(lineElement)[0] : undefined;
    if (!start || !end || !line || line.points.length < 2) return null;
    const a: Point = [num(start, 'x', 0), num(start, 'y', 0)], b: Point = [num(end, 'x', 0), num(end, 'y', 0)];
    const units = child(element, 'unitsInfo');
    const unit = Number(units?.attrs.unit ?? 0);
    const format = LENGTH_FORMATS[Number(units?.attrs.format ?? 0)] ?? 'decimal';
    const textElement = child(element, 'dimensionText');
    const rtf = textElement && child(textElement, 'rtfTextRep')?.text;
    const text = rtf ? rtfText(rtf, context.autoText, 48, false) : null;
    // The text LayOut last showed; files before 2016 keep only this, and without autoText="1" it is custom.
    const shown = text?.content.replace(/\n+$/, '');
    const lineGraphic = child(lineElement!, 'graphicEntity'), graphic = child(element, 'graphicEntity');
    const strokeSource = graphic?.attrs.strokeColor !== undefined ? graphic : lineGraphic;
    // An absent strokeWidth is LayOut's 1 pt default.
    const weight = num(graphic?.attrs.strokeWidth !== undefined ? graphic : lineGraphic ?? element, 'strokeWidth', 1);
    const arrows = child(lineElement!, 'arrowData');
    const endpoint = DIMENSION_ENDPOINT[Number(arrows?.attrs.startArrowType ?? 0)] ?? 'arrow';
    const arrowPt = num(arrows ?? element, 'startArrowSize', 3);
    const extension = child(element, 'extensionLine1');
    const extensionPath = extension ? parsePath(extension)[0] : undefined;
    const extensionArrows = extension && child(extension, 'arrowData');
    const measuredGap = extensionPath?.points[0] ? Math.hypot(extensionPath.points[0][0] - a[0], extensionPath.points[0][1] - a[1]) : NaN;
    const gap = Number.isFinite(measuredGap) ? measuredGap : 0.125;
    // A blank body that is not automatic is custom text the author cleared.
    const template = (element.attrs.dimensionString ?? (element.attrs.autoText === '1' || !rtf ? '<>' : shown ?? '')).replace(/\r\n?/g, '\n');
    return {
      a, b, unit, shown,
      line: [line.points[0]!, line.points.at(-1)!] as [Point, Point],
      style: { strokeColor: color(strokeSource?.attrs.strokeColor, '#000000'), strokeWeightPt: weight > 0 ? weight : 0.1, fillColor: null },
      dim: {
        units: format === 'decimal' ? LINEAR_UNITS[unit] ?? 'inch' : format === 'engineering' ? 'ft' : 'inch',
        ...(format === 'decimal' ? {} : { format }),
        // LayOut 3 files predate the attribute and show feet and inches without dashes.
        ...((format === 'architectural' || format === 'fractional') && units?.attrs.suppressDashesDisplay !== '0' ? { showDashes: false } : {}),
        precision: Math.max(0, Math.min(6, Math.round(num(units ?? element, 'precision', 1)))),
        showUnits: units?.attrs.suppressUnitDisplay !== '1',
        text: template,
        fontFamily: text?.fontFamily ?? 'Arial',
        fontSizePt: text?.fontSizePt ?? 10,
        endpoint,
        // Inverse of the calibrated LayOut sizes: triangles 3 pt long per unit, dots 2 pt across, slashes 2 pt.
        arrowSizeMm: Math.max(0.1, (endpoint === 'arrow' ? arrowPt * 3 : endpoint === 'dot' ? arrowPt * 4 : arrowPt * 2) * MM_PER_INCH / 72),
        extensionGapMm: gap * MM_PER_INCH,
        extensionOverrunMm: extensionArrows?.attrs.endArrowType === String(ARROW_OVERRUN) ? num(extensionArrows, 'endArrowSize', 0) * MM_PER_INCH / 72 : 0,
      },
    };
  }

  /**
   * A LayOut table as a native table: its grid sizes, merges, each cell's text, background,
   * and turn, each grid line's stroke, and the frame. A grid PushForm cannot hold is drawn as what it shows.
   */
  private table(element: XmlElement, layerId: number, context: EntityContext): LayoutEntity[] {
    const rowCount = Number(element.attrs.rowCount), columnCount = Number(element.attrs.columnCount);
    const frameBase = child(element, 'rectangleBase');
    if (!frameBase || ![rowCount, columnCount].every(n => Number.isInteger(n) && n > 0 && n <= MAX_TABLE_AXIS)) return this.tableAppearance(element, layerId, context);
    const { x, y, width, height, transform } = rectangle(frameBase);
    // A rectangle along the transform's x-axis: LayOut's six-digit matrices are only nearly orthogonal.
    const along = Math.hypot(transform.m11, transform.m21), across = Math.hypot(transform.m12, transform.m22);
    const u: Point = [transform.m11 / along, transform.m21 / along], v: Point = [-u[1], u[0]];
    const origin = apply(transform, [x, y]), w = width * along, h = height * across;
    const points = ([[0, 0], [w, 0], [w, h], [0, h]] as Point[]).map(([s, t]) => toMm([origin[0] + s * u[0] + t * v[0], origin[1] + s * u[1] + t * v[1]]));
    const sizes = (key: string, count: number, extent: number) => Array.from({ length: count }, (_, i) => {
      const size = Number(element.attrs[`${key}_${i}`]);
      return Number.isFinite(size) && size > 0 ? size : extent / count;
    });
    const frameGraphic = child(frameBase, 'graphicEntity');
    const frameStroke = tableEdge(frameGraphic);
    const frameFill = !frameGraphic || fills(frameGraphic) ? color(frameGraphic?.attrs.fillColor, '#ffffff') : null;
    const tableAngle = Math.atan2(transform.m21, transform.m11) * 180 / Math.PI;
    const merges: LayoutTable['merges'] = [];
    for (let index = 0; index < rowCount * columnCount; index++) {
      const rowSpan = Math.max(1, Number(element.attrs[`rowSpan_${index}`] ?? 1) || 1), columnSpan = Math.max(1, Number(element.attrs[`columnSpan_${index}`] ?? 1) || 1);
      if (rowSpan * columnSpan > 1) merges.push({ row: Math.floor(index / columnCount), column: index % columnCount, rowSpan, columnSpan });
    }
    const parts = new Map(element.children.map(item => [item.name, item]));
    let blank: LayoutText | null = null;
    // A cell's own background, or the frame's showing through an unfilled cell.
    const parsed = Array.from({ length: rowCount * columnCount }, (_, index) => {
      const cellElement = parts.get(`cell_${index}`), cellText = cellElement && child(cellElement, 'rtfText');
      const base = cellText && child(child(cellText, 'placedFileReference') ?? cellText, 'rectangleBase');
      const rtf = cellText && child(cellText, 'rtfTextRep')?.text;
      if (!cellText || !base || rtf === undefined) return null;
      const sequenceIndex = Number(cellText.attrs.sequenceIndex ?? -1);
      const resolve = (name: string, at: number | null): string | undefined => context.resolve(name,
        at ?? (name === cellText.attrs.sequenceAutoTextDef && sequenceIndex >= 0 ? sequenceIndex + 1 : null));
      const text = rtfText(rtf, context.autoText, Number(cellText.attrs.anchorType ?? 5), true, resolve, true)!;
      if (!blank) { const { spans: _spans, ...style } = text; blank = { ...style, content: '' }; }
      const cellTransform = rectangle(base).transform;
      const turn = ((Math.round((Math.atan2(cellTransform.m21, cellTransform.m11) * 180 / Math.PI - tableAngle) / 90) * 90) % 360 + 360) % 360;
      const graphic = child(base, 'graphicEntity');
      const fill = !graphic || fills(graphic) ? color(graphic?.attrs.fillColor, '#ffffff') : frameFill;
      return { text, fill, turn };
    });
    const fillCounts = new Map<string | null, number>();
    for (const cell of parsed) if (cell) fillCounts.set(cell.fill, (fillCounts.get(cell.fill) ?? 0) + 1);
    const tableFill = [...fillCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? frameFill;
    const fallbackText: LayoutText = blank ?? { content: '', fontFamily: 'Arial', fontSizePt: 10, color: '#000000', bold: false, italic: false,
      underline: false, align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none' };
    const table: LayoutTable = {
      rows: sizes('height', rowCount, height), columns: sizes('width', columnCount, width), merges,
      cells: parsed.map(cell => ({
        text: cell ? { ...cell.text, bounded: true } : { ...fallbackText },
        ...(cell && cell.fill !== tableFill ? { fillColor: cell.fill } : {}),
        ...(cell && cell.turn ? { rotationDeg: cell.turn as 90 | 180 | 270 } : {}),
      })),
    };
    // LayOut stores either no grid lines (all drawn with the frame's stroke) or every one with its own stroke.
    const edges = (key: string, count: number) => {
      const lines = Array.from({ length: count }, (_, i) => {
        const edge = parts.get(`${key}_edge_${i}`), path = edge && child(edge, 'path');
        return path ? tableEdge(child(path, 'graphicEntity')) : frameStroke;
      });
      return lines.every(line => sameEdge(line, frameStroke)) ? undefined : lines;
    };
    const rowEdges = edges('row', rowCount - 1), columnEdges = edges('column', columnCount - 1);
    if (rowEdges) table.rowEdges = rowEdges;
    if (columnEdges) table.columnEdges = columnEdges;
    if (!validLayoutTable(table) || !validTableFrame(points)) return this.tableAppearance(element, layerId, context);
    if (child(element, 'tableFileReference')) this.warn('tables linked to a spreadsheet keep their contents but no longer update from it');
    return [{
      id: this.allocId(), kind: 'table', layerId, points, closed: true, table,
      style: { strokeColor: frameStroke.strokeColor, strokeWeightPt: frameStroke.strokeWeightPt,
        ...(frameStroke.strokeDashMm ? { strokeDashMm: frameStroke.strokeDashMm } : {}), fillColor: tableFill },
    }];
  }

  /**
   * Appearance-only fallback for a grid PushForm cannot hold: cell fills, the styled grid edges, the outer
   * frame, and each cell's text in its (possibly merged) cell box.
   */
  private tableAppearance(element: XmlElement, layerId: number, context: EntityContext): LayoutEntity[] {
    this.warn('tables were imported as lines and text');
    const backgrounds: LayoutEntity[] = [], edges: LayoutEntity[] = [], texts: LayoutEntity[] = [];
    for (const item of element.children) {
      if (/^cell_\d+$/.test(item.name)) {
        // A cell is a text box; its filled box is the cell background, under the grid edges.
        const cellText = child(item, 'rtfText');
        for (const entity of cellText ? this.text(cellText, layerId, context) : [])
          (entity.kind === 'text' ? texts : backgrounds).push(entity);
      } else if (/^(row|column)_edge_\d+$/.test(item.name)) {
        const path = child(item, 'path');
        if (path) edges.push(...this.path(path, layerId));
      }
    }
    const frame = child(element, 'rectangleBase');
    const outline: LayoutEntity[] = [];
    if (frame) {
      const { x, y, width, height, transform } = rectangle(frame);
      outline.push(...this.pathEntity(transformSubpath(roundedRectangle(x, y, width, height, 0), transform), child(frame, 'graphicEntity'), layerId));
    }
    return [...backgrounds, ...edges, ...outline, ...texts];
  }

  /** LayOut label as a PushForm label: its text box, leader tip and bend, and tip arrow. */
  private label(element: XmlElement, layerId: number, context: EntityContext): LayoutEntity[] {
    const textElement = child(element, 'labelText');
    const parts = textElement ? this.text(textElement, layerId, context) : [];
    const body = parts.find((entity) => entity.kind === 'text');
    const cache = child(element, 'skpAutoTextCache');
    if (body && cache) {
      const fields = Object.fromEntries(childrenNamed(cache, 'dicItem').flatMap(item => {
        const key = /^<(.+)>$/.exec(item.attrs.key ?? '')?.[1], value = child(item, 'variant');
        return key && value ? [[key, value.text]] : [];
      }));
      if (Object.keys(fields).length) this.modelLabelCaches.set(body.id, fields);
    }
    const boxes = parts.filter((entity) => entity !== body);
    const leaderElement = child(element, 'leaderLine');
    const leader = leaderElement ? parsePath(leaderElement)[0] : undefined;
    if (!body || !leader || leader.points.length < 2) {
      return [...parts, ...(leaderElement ? this.path(leaderElement, layerId) : [])];
    }
    const arrow = Number(child(leaderElement!, 'arrowData')?.attrs.startArrowType ?? 0);
    const elbow = leader.points.length >= 3;
    const angle = body.text!.rotationDeg ?? 0;
    let points = body.points;
    // LayOut sets an unbounded label's text from its leader's end, and its stored box can be stale; one whose anchored
    // edge lies more than half a line from where that puts it moves there, keeping its size.
    if (!body.text!.bounded && angle === 0) {
      const end = toMm(leader.points.at(-1)!)[1];
      const top = Math.min(points[0]![1], points[1]![1]), bottom = Math.max(points[0]![1], points[1]![1]);
      const vertical = body.text!.vertical, half = labelLineHalfHeightMm(body.text!, vertical === 'bottom');
      const shift = vertical === 'top' ? end - half - top : vertical === 'bottom' ? end + half - bottom : end - (top + bottom) / 2;
      if (Math.abs(shift) > half) points = points.map(([x, y]): Point => [x, y + shift]);
    }
    // PushForm keeps a label's leader unrotated and turns it with the text; LayOut stores page points.
    const center = layoutTextCenter({ ...body, points });
    const local = (point: Point): Point => rotateLayoutPoint(toMm(point), center, -angle);
    // The leader meets the text where LayOut's does: the middle of its first or last line, or its center.
    const offset = local(leader.points.at(-1)!)[1] - center[1];
    return [...boxes, {
      ...body, kind: 'label',
      points: [...points, local(leader.points[0]!), ...(elbow ? [local(leader.points.at(-2)!)] : [])],
      text: { ...body.text!, leader: elbow ? 'elbow' : 'straight', endpoint: LABEL_ENDPOINT[arrow] ?? 'arrow',
        ...(Math.abs(offset) > LABEL_OFFSET_EPSILON_MM ? { leaderOffsetMm: offset } : {}) },
    }];
  }

  /** Dimensions without the data to rebuild them are imported as their drawn lines and text. */
  private dimension(element: XmlElement, layerId: number, context: EntityContext): LayoutEntity[] {
    this.warn('dimensions were imported as lines and text');
    const result: LayoutEntity[] = [];
    for (const name of ['extensionLine1', 'extensionLine2', 'dimensionLine', 'leaderLine']) {
      const line = child(element, name);
      if (line) result.push(...this.path(line, layerId));
    }
    const label = child(element, 'dimensionText');
    if (label) result.push(...this.text(label, layerId, context));
    return result;
  }

  private image(element: XmlElement, layerId: number): LayoutEntity[] {
    const placed = child(element, 'placedFileReference');
    const base = placed && child(placed, 'rectangleBase');
    const refId = child(element, 'imageFileReference')?.attrs['r:id'];
    const src = this.imageUrl(refId);
    if (!base) return [];
    if (!src) {
      // LayOut shows a gray box crossed in red where a picture's file is missing; pictures PushForm cannot read get it too.
      const target = refId ? this.references.get(refId)?.attrs.internalTarget : undefined;
      this.warn(target && this.files[target] ? 'an image that could not be read was shown as a placeholder' : 'an image whose file is missing was shown as a placeholder');
      const [a, b, c, d] = transformedFrame(base) as [Point, Point, Point, Point];
      const cross = { strokeColor: '#d81e1e', strokeWeightPt: 0.5, fillColor: null };
      return [
        { id: this.allocId(), kind: 'path', layerId, points: [a, b, c, d].map(toMm), closed: true, style: { strokeColor: '#00000000', strokeWeightPt: 0.1, fillColor: '#c8c8c8' } },
        { id: this.allocId(), kind: 'path', layerId, points: [a, c].map(toMm), closed: false, style: cross },
        { id: this.allocId(), kind: 'path', layerId, points: [b, d].map(toMm), closed: false, style: cross },
      ];
    }
    return [this.imageEntity(base, src, placed, layerId)];
  }

  private viewport(element: XmlElement, layerId: number): LayoutEntity[] {
    const originalId = element.attrs.id ?? `unnamed-viewport-${this.modelViewports.size + 1}`;
    const modelReferenceId = child(element, 'skpFileReference')?.attrs['r:id'] ?? null;
    const entities = this.viewportAppearance(element, layerId, originalId, modelReferenceId);
    this.modelViewports.set(originalId, { modelReferenceId, entityIds: entities.map(entity => entity.id) });
    return entities;
  }

  /**
   * A viewport with an embedded model becomes one editable viewport picture showing LayOut's cached
   * render; without a model it keeps only that cached appearance.
   */
  private viewportAppearance(element: XmlElement, layerId: number, originalId: string, modelReferenceId: string | null): LayoutEntity[] {
    const placed = child(element, 'placedFileReference');
    const base = placed && child(placed, 'rectangleBase');
    if (!base) return [];
    // With "Background" on, LayOut paints the model's background color behind it, within the crop.
    const options = childrenNamed(child(element, 'renderingOptions') ?? element, 'entry');
    const backgroundEntry = options.find((entry) => entry.attrs.key === 'BackgroundColor');
    const backgroundColor = element.attrs.displayBackground === '1' && backgroundEntry ? color(backgroundEntry.attrs.value, '#ffffff') : null;
    // With it off, LayOut's raster render still holds the sky and background, which LayOut does not draw.
    // A color the model itself draws in (faces, edges) or white paper is kept: clearing it would cut into the model.
    const rgbOf = (key: string): number | null => {
      const value = options.find((entry) => entry.attrs.key === key)?.attrs.value;
      if (value === undefined || !Number.isFinite(Number(value))) return null;
      const abgr = Number(value) >>> 0;
      return (abgr & 0xff) << 16 | (abgr >>> 8 & 0xff) << 8 | (abgr >>> 16 & 0xff);
    };
    const modelColors = [0xffffff, ...['FaceFrontColor', 'FaceBackColor', 'ForegroundColor'].map(rgbOf)];
    const backdrop = element.attrs.displayBackground === '1' ? [] : ['SkyColor', 'BackgroundColor']
      .map(rgbOf).filter((rgb): rgb is number => rgb !== null && !modelColors.includes(rgb));
    // LayOut's render mode shows in which caches it stored: a picture (raster), paths (vector), or both
    // (hybrid: the picture's faces under the paths' edges).
    const rasterId = child(element, 'imageFileReference')?.attrs['r:id'];
    const rasterTarget = rasterId ? this.references.get(rasterId)?.attrs.internalTarget : undefined;
    const renderable = Boolean(this.originalArchive && modelReferenceId && this.references.get(modelReferenceId)?.name === 'skpFileReference');
    // LayOut sometimes saves a blank raster render and draws the view again from its model; a model view does the same.
    // (Render timestamps older than the view's last change are not a reliable sign: those renders are still current.)
    const blank = renderable && Boolean(rasterTarget && this.files[rasterTarget] && /\.png$/i.test(rasterTarget) && pngIsBlank(this.files[rasterTarget]!));
    const raster = blank ? null : this.imageUrl(rasterId, backdrop);
    const imageRect = child(element, 'imageRect');
    const vector = this.vectorSvg(child(element, 'vectorFileReference')?.attrs['r:id'], base,
      raster ? { href: raster, ...(imageRect ? { x: num(imageRect, 'x', 0), y: num(imageRect, 'y', 0), width: num(imageRect, 'width', 0), height: num(imageRect, 'height', 0) } : rectangle(base)) } : undefined);
    // A model that is only linked externally is still preserved for export; PushForm cannot render it.
    const camera = child(element, 'camera') ?? { name: 'camera', attrs: {}, children: [], text: '' };
    const frame = rectangle(base);
    const modelCamera = renderable && modelReferenceId ? viewportCameraFromLayOut(readLayOutCamera(camera), frame.width, frame.height) : null;
    // A camera LayOut saved unusable (a parallel view with zero height) cannot show the model; keep what LayOut cached.
    if (modelCamera && !finiteCamera(modelCamera)) this.warn('a SketchUp viewport whose saved camera cannot show the model keeps only its cached render');
    if (modelCamera && finiteCamera(modelCamera) && modelReferenceId) {
      const { width, height } = frame;
      const viewportCamera = modelCamera;
      // A blank raster render is stale even beside vector edges: the model is rendered instead.
      const picture = blank ? null : vector ?? raster;
      const entity = this.imageEntity(base, picture ?? '', placed, layerId);
      entity.image!.viewport = {
        source: { archiveId: this.archiveId, modelReferenceId }, templateId: originalId, originalId,
        camera: viewportCamera, preserveScaleOnResize: element.attrs.constantSize === '1',
        scene: element.attrs.cameraModified === '1' ? null : element.attrs.defaultPageName ?? null,
        background: backgroundColor,
        cache: picture ? { camera: viewportCamera, widthMm: width * MM_PER_INCH, heightMm: height * MM_PER_INCH } : null,
        ...viewportDisplay(element),
      };
      return [entity];
    }
    const mask = child(placed, 'clipMask')?.children[0];
    const outline = (mask && maskOutline(mask)[0]) ?? (() => { const { x, y, width, height, transform } = rectangle(base); return transformSubpath(roundedRectangle(x, y, width, height, 0), transform); })();
    const background: LayoutEntity[] = backgroundColor
      ? [{ id: this.allocId(), kind: 'path', layerId, points: outline.points.map(toMm),
        ...(outline.handles.some((handle) => handle.in || handle.out) ? { handles: outline.handles.map(handleToMm) } : {}),
        closed: true, style: { strokeColor: '#00000000', strokeWeightPt: 0.1, fillColor: backgroundColor } }]
      : [];
    if (vector) return [...background, this.imageEntity(base, vector, placed, layerId)];
    if (raster) return [...background, this.imageEntity(base, raster, placed, layerId)];
    this.warn('a SketchUp viewport without a cached render was shown as an empty frame');
    const { x, y, width, height, transform } = rectangle(base);
    return this.pathEntity(transformSubpath(roundedRectangle(x, y, width, height, 0), transform), undefined, layerId)
      .map((entity) => ({ ...entity, style: { strokeColor: '#9aa4b2', strokeWeightPt: 0.5, fillColor: null } }));
  }

  /** Viewport pictures follow the viewport's own (possibly rotated) frame. */
  private imageEntity(base: XmlElement, src: string, placed: XmlElement, layerId: number): LayoutEntity {
    const frame = transformedFrame(base);
    const image: LayoutImage = { src };
    const mask = child(placed, 'clipMask')?.children[0];
    if (mask) {
      const [subpath] = maskOutline(mask);
      if (subpath && subpath.points.length >= 3) {
        const inverse = frameInverse(frame);
        image.clip = {
          points: subpath.points.map((point) => inverse(point)),
          ...(subpath.handles.some((handle) => handle.in || handle.out) ? {
            handles: subpath.handles.map((handle) => ({ in: handle.in && inverse(handle.in), out: handle.out && inverse(handle.out) })),
          } : {}),
        };
      }
    }
    return { id: this.allocId(), kind: 'image', layerId, points: frame.map(toMm), closed: true, image };
  }

  /** A referenced picture as a data URL; `clear` lists colors (0xRRGGBB) to make transparent in a PNG. */
  private imageUrl(refId: string | undefined, clear: readonly number[] = []): string | null {
    const target = refId ? this.references.get(refId)?.attrs.internalTarget : undefined;
    if (!target) return null;
    const key = clear.length ? `${target}#${clear.join(',')}` : target;
    const cached = this.dataUrls.get(key);
    if (cached) return cached;
    const bytes = this.files[target];
    if (!bytes) return null;
    const cleared = clear.length && /\.png$/i.test(target) ? clearPngColors(bytes, clear) : null;
    const url = cleared ? `data:image/png;base64,${base64(cleared)}` : this.pictureUrl(bytes, target.split('.').pop() ?? '');
    if (url) this.dataUrls.set(key, url);
    return url;
  }

  /** Placed pictures: browser formats as stored, SVG with a size to draw at, and TIFF converted to PNG. */
  private pictureUrl(bytes: Uint8Array, extension: string): string | null {
    const type = extension.toLowerCase();
    if (type === 'tif' || type === 'tiff') {
      try {
        return `data:image/png;base64,${base64(tiffToPng(bytes))}`;
      } catch (error) {
        this.warn(error instanceof TiffError ? error.message : 'a TIFF image could not be read');
        return null;
      }
    }
    if (type === 'svg') return `data:image/svg+xml;base64,${base64(strToU8(sizedSvg(strFromU8(bytes))))}`;
    const mime = IMAGE_TYPES[type];
    if (!mime) { this.warn(`images of type .${extension} are not supported`); return null; }
    return `data:${mime};base64,${base64(bytes)}`;
  }

  private vectorSvg(refId: string | undefined, base: XmlElement, underlay?: { href: string; x: number; y: number; width: number; height: number }): string | null {
    const target = refId ? this.references.get(refId)?.attrs.internalTarget : undefined;
    if (!target || !this.files[target]) return null;
    // Vector caches are in page coordinates; the picture is drawn in the viewport's own frame.
    const { x: left, y: top, width: frameWidth, height: frameHeight, transform: t } = rectangle(base);
    const right = left + frameWidth, bottom = top + frameHeight;
    const det = t.m11 * t.m22 - t.m12 * t.m21;
    const rotated = det !== 0 && (t.m11 !== 1 || t.m12 !== 0 || t.m21 !== 0 || t.m22 !== 1 || t.tx !== 0 || t.ty !== 0);
    const [a, b, c, d] = [t.m22 / det, -t.m12 / det, -t.m21 / det, t.m11 / det];
    // A hybrid render's picture lies in the frame's own coordinates, under the edges.
    const parts: string[] = underlay && underlay.width > 0 && underlay.height > 0
      ? [`<image href="${underlay.href}" x="${round(underlay.x)}" y="${round(underlay.y)}" width="${round(underlay.width)}" height="${round(underlay.height)}" preserveAspectRatio="none"/>`]
      : [];
    if (rotated) parts.push(`<g transform="matrix(${[a, c, b, d, -(a * t.tx + b * t.ty), -(c * t.tx + d * t.ty)].map(round).join(' ')})">`);
    const walk = (element: XmlElement): void => {
      if (element.name !== 'path') { element.children.forEach(walk); return; }
      const graphic = child(element, 'graphicEntity');
      const d = parsePath(element).map(svgPath).join('');
      if (!d) return;
      const fill = !graphic || fills(graphic) ? svgPaint('fill', graphic?.attrs.fillColor, '#ffffff') : 'fill="none"';
      const strokeWidth = num(graphic ?? element, 'strokeWidth', 1);
      const stroke = !graphic || strokes(graphic)
        ? ` ${svgPaint('stroke', graphic?.attrs.strokeColor, '#000000')} stroke-width="${strokeWidth > 0 ? round(strokeWidth / 72) : 0.003}" stroke-linejoin="round" stroke-linecap="round"`
        : '';
      parts.push(`<path d="${d}" ${fill}${stroke}/>`);
    };
    walk(this.xml(target));
    if (rotated) parts.push('</g>');
    const width = right - left, height = bottom - top;
    return `data:image/svg+xml;base64,${base64(new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width * 96)}" height="${round(height * 96)}" viewBox="${round(left)} ${round(top)} ${round(width)} ${round(height)}" fill-rule="evenodd">${parts.join('')}</svg>`,
    ))}`;
  }

  private xml(name: string): XmlElement {
    const bytes = this.files[name];
    if (!bytes) throw new Error(`LayOut document is missing ${name}`);
    return parseXml(strFromU8(bytes), PREFIXES);
  }

  private allocId(): number {
    return this.nextId++;
  }

  private warn(message: string): void {
    this.warnings.set(message, (this.warnings.get(message) ?? 0) + 1);
  }
}

interface EntityContext {
  autoText: Map<string, string>;
  layers: Map<number, LayoutLayer>;
  /** Text LayOut shows for `<Name(index)>` auto-text (page names, sequences); undefined when unknown. */
  resolve: (name: string, index: number | null) => string | undefined;
}

/** Sequence numbers by `numberingType` code (the API's NUMBER_STYLE order: arabic, padded arabic, A–Z, a–z, I–X, i–x). */
function formatSequenceNumber(value: number, style: number): string {
  return formatLayoutPageNumber(value, LAYOUT_PAGE_NUMBER_STYLES[style] ?? 'arabic');
}

interface Subpath {
  points: Point[];
  handles: LayoutPathHandle[];
  closed: boolean;
}

const finiteSubpath = (subpath: Subpath): boolean => subpath.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
const finiteCamera = (camera: LayoutViewportCamera): boolean =>
  [...camera.eye, ...camera.target, ...camera.up, camera.fov, camera.scale, ...(camera.shift ?? [])].every(Number.isFinite);

function parsePath(element: XmlElement): Subpath[] {
  const ops = (child(element, 'elements')?.text ?? '').split(',').filter((value) => value.trim()).map(Number);
  const values = (child(element, 'points2f')?.text ?? '').split(',').filter((value) => value.trim()).map(Number);
  const subpaths: Subpath[] = [];
  let current: Subpath | null = null;
  let cursor = 0;
  const take = (): Point => {
    const point: Point = [values[cursor * 2] ?? 0, values[cursor * 2 + 1] ?? 0];
    cursor++;
    return point;
  };
  for (const op of ops) {
    if (op === OP_MOVE) {
      current = { points: [take()], handles: [{}], closed: false };
      subpaths.push(current);
    } else if (op === OP_LINE && current) {
      current.points.push(take());
      current.handles.push({});
    } else if (op === OP_CUBIC && current) {
      const c1 = take(), c2 = take(), end = take();
      current.handles.at(-1)!.out = c1;
      current.points.push(end);
      current.handles.push({ in: c2 });
    } else if (op === OP_CLOSE && current) {
      current.closed = true;
    } else {
      cursor += OP_POINTS[op] ?? 0;
    }
  }
  for (const subpath of subpaths) {
    const first = subpath.points[0]!, last = subpath.points.at(-1)!;
    if (subpath.points.length > 2 && Math.hypot(first[0] - last[0], first[1] - last[1]) < CLOSE_TOLERANCE_IN) {
      // A path that returns to its start is a closed loop; fold the repeated vertex into the first.
      subpath.points.pop();
      const lastHandle = subpath.handles.pop()!;
      if (lastHandle.in) subpath.handles[0]!.in = lastHandle.in;
      subpath.closed = true;
    }
  }
  return subpaths;
}

/** Outline of a clip mask in page coordinates; LayOut writes paths, rectangles, or ellipses there. */
function maskOutline(mask: XmlElement): Subpath[] {
  if (mask.name === 'path') return parsePath(mask);
  const base = child(mask, 'rectangleBase');
  if (!base || (mask.name !== 'rectangle' && mask.name !== 'ellipse')) return [];
  const { x, y, width, height, transform } = rectangle(base);
  const outline = mask.name === 'ellipse' ? ellipse(x, y, width, height) : roundedRectangle(x, y, width, height, 0);
  return [transformSubpath(outline, transform)];
}

function svgPath(subpath: Subpath): string {
  const { points, handles, closed } = subpath;
  if (points.length === 0) return '';
  let d = `M${round(points[0]![0])} ${round(points[0]![1])}`;
  const count = points.length - (closed ? 0 : 1);
  for (let i = 0; i < count; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    const c1 = handles[i]?.out, c2 = handles[(i + 1) % points.length]?.in;
    d += c1 || c2
      ? `C${round((c1 ?? a)[0])} ${round((c1 ?? a)[1])} ${round((c2 ?? b)[0])} ${round((c2 ?? b)[1])} ${round(b[0])} ${round(b[1])}`
      : `L${round(b[0])} ${round(b[1])}`;
  }
  return closed ? `${d}Z` : d;
}

function fills(graphic: XmlElement): boolean {
  return graphic.attrs.shouldFill !== '0';
}

function strokes(graphic: XmlElement): boolean {
  return graphic.attrs.shouldStroke !== '0';
}

/** A table grid line's stroke: LayOut's 1 pt black unless the graphic entity says otherwise; transparent when unstroked. */
function tableEdge(graphic: XmlElement | undefined): LayoutTableEdge {
  const style = pathStyle(graphic && { ...graphic, attrs: { ...graphic.attrs, shouldFill: '0' } });
  if (!style || style.strokeColor === '#00000000') return { strokeColor: '#00000000', strokeWeightPt: style?.strokeWeightPt ?? 1 };
  return { strokeColor: style.strokeColor, strokeWeightPt: style.strokeWeightPt, ...(style.strokeDashMm ? { strokeDashMm: style.strokeDashMm } : {}) };
}

function sameEdge(a: LayoutTableEdge, b: LayoutTableEdge): boolean {
  return a.strokeColor === b.strokeColor && a.strokeWeightPt === b.strokeWeightPt &&
    (a.strokeDashMm ?? []).join() === (b.strokeDashMm ?? []).join();
}

/** Defaults when the file gives none: filled white and stroked 1 pt black unless the graphic entity says otherwise. */
function pathStyle(graphic: XmlElement | undefined): LayoutEntity['style'] | null {
  const fill = !graphic || fills(graphic) ? color(graphic?.attrs.fillColor, '#ffffff') : null;
  const stroke = !graphic || strokes(graphic);
  if (!fill && !stroke) return null;
  const width = graphic ? num(graphic, 'strokeWidth', 1) : 1;
  const strokeWeightPt = stroke ? (width > 0 ? width : 0.1) : 0.1;
  const patternId = graphic?.attrs.strokeDashPattern;
  let strokeDashMm: number[] | undefined;
  if (stroke && patternId && patternId !== '0') {
    const patternScale = num(graphic!, 'stroke.patternscale', 1);
    strokeDashMm = layoutDashMm(Number(patternId), strokeWeightPt, patternScale > 0 ? patternScale : 1);
    if (!strokeDashMm.every(length => Number.isFinite(length) && length > 0)) throw new Error('Invalid LayOut dash pattern scale');
  }
  return {
    strokeColor: stroke ? color(graphic?.attrs.strokeColor, '#000000') : '#00000000',
    // Zero-width LayOut strokes are hairlines.
    strokeWeightPt,
    ...(strokeDashMm ? { strokeDashMm } : {}),
    fillColor: fill,
  };
}

/**
 * A viewport's display settings from its `renderingOptions`: SketchUp's `RenderMode` (0
 * wireframe, 1 hidden line, 5 monochrome, other values shaded, with `Texture` choosing textures),
 * `ModelTransparency` (X-ray), `EdgeDisplayMode`, `DrawSilhouettes` (profiles), `DrawBackEdges`, and
 * `DrawHidden` (hidden geometry), and its `shadowOptions`. A viewport without rendering options
 * draws the model's own style.
 */
function viewportDisplay(element: XmlElement): { display?: LayoutViewportDisplay } {
  const options = child(element, 'renderingOptions');
  const entries = new Map(childrenNamed(options ?? element, 'entry').map(entry => [entry.attrs.key, entry.attrs.value]));
  if (!options || !entries.has('RenderMode')) return {};
  const on = (key: string, fallback: boolean) => entries.has(key) ? entries.get(key) === '1' : fallback;
  const mode = entries.get('RenderMode'), textured = on('Texture', true);
  const faceStyle: LayoutViewportDisplay['faceStyle'] = mode === '0' ? 'wireframe' : mode === '1' ? 'hiddenLine' : mode === '5' ? 'monochrome'
    : textured ? 'shadedTextured' : 'shaded';
  const shadows = viewportShadows(element);
  return { display: { faceStyle, edges: entries.get('EdgeDisplayMode') !== '0', profiles: on('DrawSilhouettes', true),
    backEdges: on('DrawBackEdges', false), xray: on('ModelTransparency', false), hiddenGeometry: on('DrawHidden', false),
    ...(shadows ? { shadows } : {}) } };
}

/**
 * A viewport's sun and shadow settings from its `shadowOptions`. `ShadowTime_time_t` holds the
 * local standard time as if it were UTC (SketchUp's convention; `TZOffset` is the zone and daylight saving is
 * ignored), so its UTC clock reading is the local time. `ShadowTime` itself is that instant shown in the time
 * zone of the computer that saved the file, and `SunDirection` is derived, so neither is read.
 */
function viewportShadows(element: XmlElement): ShadowSettings | undefined {
  const options = child(element, 'shadowOptions');
  if (!options) return undefined;
  const entries = new Map(childrenNamed(options, 'entry').map(entry => [entry.attrs.key, entry.attrs.value]));
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(entries.get(key));
    return entries.has(key) && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const on = (key: string, fallback: boolean) => entries.has(key) ? entries.get(key) === '1' : fallback;
  const when = new Date(Number(entries.get('ShadowTime_time_t') ?? NaN) * 1000);
  const date = Number.isFinite(when.getTime())
    ? { month: when.getUTCMonth() + 1, day: when.getUTCDate(), time: when.getUTCHours() * 60 + when.getUTCMinutes() }
    : { month: DEFAULT_SHADOWS.month, day: DEFAULT_SHADOWS.day, time: DEFAULT_SHADOWS.time };
  return {
    enabled: on('DisplayShadows', false), ...date,
    utcOffsetHours: number('TZOffset', DEFAULT_SHADOWS.utcOffsetHours, -12, 14),
    latitude: number('Latitude', DEFAULT_SHADOWS.latitude, -90, 90), longitude: number('Longitude', DEFAULT_SHADOWS.longitude, -180, 180),
    northAngle: ((number('NorthAngle', 0, -Infinity, Infinity) % 360) + 360) % 360,
    light: number('Light', DEFAULT_SHADOWS.light, 0, 100), dark: number('Dark', DEFAULT_SHADOWS.dark, 0, 100),
    useSunForShading: on('UseSunForAllShading', false), onGround: on('DisplayOnGroundPlane', true), onFaces: on('DisplayOnAllFaces', true),
    fromEdges: on('EdgesCastShadows', false),
  };
}

/** Colors are 32-bit integers holding RGBA bytes little-endian: alpha high, then blue, green, red low. */
function color(value: string | undefined, fallback: string): string {
  if (value === undefined || value === '' || !Number.isFinite(Number(value))) return fallback;
  const abgr = Number(value) >>> 0;
  const rgb = [abgr & 0xff, (abgr >>> 8) & 0xff, (abgr >>> 16) & 0xff].map((channel) => channel.toString(16).padStart(2, '0')).join('');
  const alpha = abgr >>> 24;
  return alpha === 0xff ? `#${rgb}` : `#${rgb}${alpha.toString(16).padStart(2, '0')}`;
}

/** SVG paint attributes; SVG 1.1 consumers ignore 8-digit hex, so alpha goes in its own attribute. */
function svgPaint(property: 'fill' | 'stroke', value: string | undefined, fallback: string): string {
  const hex = color(value, fallback);
  return hex.length === 9
    ? `${property}="${hex.slice(0, 7)}" ${property}-opacity="${round(parseInt(hex.slice(7), 16) / 255)}"`
    : `${property}="${hex}"`;
}

function rectangle(base: XmlElement): { x: number; y: number; width: number; height: number; transform: Affine } {
  const matrix = child(base, 'affineTransform');
  return {
    x: num(base, 'x', 0), y: num(base, 'y', 0), width: num(base, 'width', 0), height: num(base, 'height', 0),
    transform: matrix
      ? { m11: num(matrix, 'm11', 1), m12: num(matrix, 'm12', 0), m21: num(matrix, 'm21', 0), m22: num(matrix, 'm22', 1), tx: num(matrix, 'tx', 0), ty: num(matrix, 'ty', 0) }
      : { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 },
  };
}

function apply(t: Affine, [x, y]: Point): Point {
  return [t.m11 * x + t.m12 * y + t.tx, t.m21 * x + t.m22 * y + t.ty];
}

/** Image frames are [top-left, top-right, bottom-right, bottom-left] of the placed content. */
function transformedFrame(base: XmlElement): Point[] {
  const { x, y, width, height, transform } = rectangle(base);
  return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]].map((point) => apply(transform, point as Point));
}


/** Maps page points into the frame's unit square, so clips follow later moves, scales and rotations. */
function frameInverse(frame: Point[]): (point: Point) => Point {
  const [origin, right, , down] = frame as [Point, Point, Point, Point];
  const ux: Point = [right[0] - origin[0], right[1] - origin[1]];
  const vy: Point = [down[0] - origin[0], down[1] - origin[1]];
  const det = ux[0] * vy[1] - ux[1] * vy[0];
  return ([px, py]) => {
    const dx = px - origin[0], dy = py - origin[1];
    return det === 0 ? [0, 0] : [(dx * vy[1] - dy * vy[0]) / det, (ux[0] * dy - ux[1] * dx) / det];
  };
}

function transformSubpath(subpath: Subpath, transform: Affine): Subpath {
  return {
    points: subpath.points.map((point) => apply(transform, point)),
    handles: subpath.handles.map((handle) => ({
      ...(handle.in ? { in: apply(transform, handle.in) } : {}),
      ...(handle.out ? { out: apply(transform, handle.out) } : {}),
    })),
    closed: subpath.closed,
  };
}

const KAPPA = 0.5522847498;

function ellipse(x: number, y: number, width: number, height: number): Subpath {
  const cx = x + width / 2, cy = y + height / 2, rx = width / 2, ry = height / 2;
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return {
    points: [[cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]],
    handles: [
      { in: [cx + rx, cy - ky], out: [cx + rx, cy + ky] },
      { in: [cx + kx, cy + ry], out: [cx - kx, cy + ry] },
      { in: [cx - rx, cy + ky], out: [cx - rx, cy - ky] },
      { in: [cx - kx, cy - ry], out: [cx + kx, cy - ry] },
    ],
    closed: true,
  };
}

/**
 * LayOut's bulged rectangle: the two shorter sides bow outward as circular arcs that stay inside the
 * bounds, with `bulge` the arc depth; the longer sides are straight and shortened by that depth.
 */
function bulgedRectangle(x: number, y: number, width: number, height: number, bulge: number): Subpath {
  const w = Math.abs(width), h = Math.abs(height);
  const left = Math.min(x, x + width), top = Math.min(y, y + height);
  const s = Math.min(Math.abs(bulge), Math.min(w, h) / 2);
  if (s <= 0) return roundedRectangle(left, top, w, h, 0);
  // Work with the bulging sides vertical, then swap axes when the rectangle is taller than wide.
  const tall = h > w;
  const along = tall ? w : h, across = tall ? h : w;
  const radius = (along * along / 4 + s * s) / (2 * s), half = Math.asin(Math.min(1, along / 2 / radius));
  const side = (cx: number, start: number, sweep: number): { points: Point[]; handles: LayoutPathHandle[] } => {
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2))), step = sweep / steps;
    const k = 4 / 3 * Math.tan(step / 4) * radius;
    const points: Point[] = [], handles: LayoutPathHandle[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = start + step * i, cos = Math.cos(a), sin = Math.sin(a);
      points.push([cx + radius * cos, along / 2 + radius * sin]);
      handles.push({
        ...(i > 0 ? { in: [cx + radius * cos + k * sin, along / 2 + radius * sin - k * cos] as Point } : {}),
        ...(i < steps ? { out: [cx + radius * cos - k * sin, along / 2 + radius * sin + k * cos] as Point } : {}),
      });
    }
    return { points, handles };
  };
  // Each arc's circle passes through its apex on the bounds and the ends of its chord, `s` inside them:
  // the right side runs top to bottom about a center at `across − radius`, the left bottom to top about `radius`.
  const right = side(across - radius, -half, 2 * half);
  const leftSide = side(radius, Math.PI - half, 2 * half);
  const points = [...right.points, ...leftSide.points];
  const handles = [...right.handles, ...leftSide.handles];
  const place = ([u, v]: Point): Point => tall ? [left + v, top + u] : [left + u, top + v];
  return {
    points: points.map(place),
    handles: handles.map((handle) => ({ ...(handle.in ? { in: place(handle.in) } : {}), ...(handle.out ? { out: place(handle.out) } : {}) })),
    closed: true,
  };
}

function roundedRectangle(x: number, y: number, width: number, height: number, radius: number): Subpath {
  const r = Math.min(Math.abs(radius), Math.abs(width) / 2, Math.abs(height) / 2);
  if (r <= 0) return { points: [[x, y], [x + width, y], [x + width, y + height], [x, y + height]], handles: [{}, {}, {}, {}], closed: true };
  const k = r * (1 - KAPPA), right = x + width, bottom = y + height;
  return {
    points: [[x + r, y], [right - r, y], [right, y + r], [right, bottom - r], [right - r, bottom], [x + r, bottom], [x, bottom - r], [x, y + r]],
    handles: [
      { in: [x + k, y] }, { out: [right - k, y] }, { in: [right, y + k] }, { out: [right, bottom - k] },
      { in: [right - k, bottom] }, { out: [x + k, bottom] }, { in: [x, bottom - k] }, { out: [x, y + k] },
    ],
    closed: true,
  };
}

/** LayOut `arrowData` codes that extend or shorten a line rather than draw an arrow. */
const ARROW_UNDERRUN = 15;
const ARROW_OVERRUN = 16;
const DIMENSION_ENDPOINT: Record<number, LayoutLinearDimension['endpoint']> = {
  0: 'none', 1: 'arrow', 2: 'arrow', 3: 'arrow', 4: 'arrow', 17: 'arrow', 18: 'arrow', 5: 'dot', 6: 'dot', 13: 'tick', 14: 'tick',
};
const LABEL_ENDPOINT: Record<number, LayoutText['endpoint']> = {
  0: 'none', 1: 'arrow', 2: 'arrow', 3: 'arrow', 4: 'arrow', 17: 'arrow', 18: 'arrow', 5: 'dot', 6: 'dot',
};
/** `unitsInfo unit` codes: inches 0, feet 1, millimeters 2, centimeters 3, meters 4, points 5; angles in degrees 9 or radians 10. */
const LINEAR_UNITS: Record<number, LayoutLinearDimension['units']> = { 0: 'inch', 1: 'ft', 2: 'mm', 3: 'cm', 4: 'm', 5: 'pt' };
const UNIT_RADIANS = 10;
/** `unitsInfo format` codes. */
const LENGTH_FORMATS: Record<number, LengthFormat> = { 0: 'decimal', 1: 'architectural', 2: 'engineering', 3: 'fractional' };
const INCHES_PER_UNIT: Record<LayoutLinearDimension['units'], number> = { inch: 1, ft: 12, mm: 1 / 25.4, cm: 1 / 2.54, m: 1 / 0.0254, pt: 1 / 72 };

/** The measurement within text LayOut showed for a template such as `<> RO`, or null when it does not fit. */
function templateValue(shown: string, template: string): string | null {
  const at = template.indexOf('<>');
  if (at < 0) return null;
  const before = template.slice(0, at), after = template.slice(at + 2);
  if (shown.length < before.length + after.length || !shown.startsWith(before) || !shown.endsWith(after)) return null;
  return shown.slice(before.length, shown.length - after.length);
}

/**
 * A length as LayOut shows it (`17'-11 13/16"`, `13-1/2"`, `6.29'`, `9600 mm`, `3,21`), in inches.
 * Decimal commas from the author's locale are accepted.
 */
function parseLayoutLength(text: string | null, format: LengthFormat, units: LayoutLinearDimension['units']): number | null {
  if (text === null) return null;
  const value = text.trim().replace(/^~\s*/, '').replace(',', '.');
  if (format === 'architectural' || format === 'fractional') {
    const match = /^(?:(\d+)'[- ]?)?(?:(\d+)(?:[- ](\d+)\/(\d+))?|(\d+)\/(\d+))?"?$/.exec(value);
    if (!match || match.slice(1).every(part => part === undefined)) return null;
    const [, feet, whole, numerator, denominator, onlyNumerator, onlyDenominator] = match;
    const fraction = numerator ? Number(numerator) / Number(denominator) : onlyNumerator ? Number(onlyNumerator) / Number(onlyDenominator) : 0;
    const inches = Number(feet ?? 0) * 12 + Number(whole ?? 0) + fraction;
    return Number.isFinite(inches) ? inches : null;
  }
  const match = /^(\d*\.?\d+)\s*(?:mm|cm|m|pt|'|")?$/.exec(value);
  return match ? Number(match[1]) * INCHES_PER_UNIT[format === 'engineering' ? 'ft' : units] : null;
}

/** Text body plus the paragraph style of its first run; LayOut's RTF is otherwise character-styled. */
/** Null for blank text unless `keepBlank`, which returns its styling with empty content (a table cell). */
function rtfText(rtf: string, autoText: Map<string, string>, anchor: number, bounded: boolean,
  resolve?: (name: string, index: number | null) => string | undefined, keepBlank = false): LayoutText | null {
  // RichEdit list paragraphs: the marker lives in {\pntext …} groups, the list kind in {\*\pn …}.
  // macOS (Cocoa) lists put the marker in {\listtext …}: a bullet (舦) or a number.
  const cocoaMarker = /\{\\listtext([^{}]*)\}/.exec(rtf)?.[1];
  const list = /\\pnlvlblt/.test(rtf) ? 'bullet' : /\\pnlvlbody|\\pndec/.test(rtf) ? 'number'
    : cocoaMarker !== undefined ? (/\d/.test(cocoaMarker.replace(/\\[a-z]+-?\d* ?/gi, '')) ? 'number' : 'bullet') : 'none';
  rtf = rtf.replace(/\{\\pntext[^{}]*\}/g, '');
  const body = rtf.replace(/\{\\fonttbl[^]*?\}\}|\{\\colortbl[^}]*\}/g, '');
  const control = (word: string) => new RegExp(`\\\\${word}(-?\\d+)?(?![a-z])`).exec(body);
  const parsed = importLayoutText(rtf);
  let content = parsed.content.replace(/\n+$/, '');
  // The box takes its first run's style; trailing paragraph marks may carry another.
  const firstRun = parsed.spans.find((span) => span.start < content.length) ?? parsed.spans[0];
  let spans = parsed.spans.map((span) => ({ ...span, end: Math.min(span.end, content.length) })).filter((span) => span.start < span.end);
  // Named Auto-Text tags stay live in the shared syntax; indexed and sequence tags
  // (<PageName(2)>, <Sheet(1)>) become the text LayOut shows.
  const replace = (name: string, index: string | undefined): string | undefined =>
    index === undefined ? autoText.get(name) ?? resolve?.(name, null) : resolve?.(name, Number(index));
  const tokens = [...content.matchAll(/<([A-Za-z][A-Za-z0-9# ]*)(?:\((\d+)\))?>/g)].filter((match) => replace(match[1]!, match[2]) !== undefined);
  for (const match of tokens.reverse()) {
    const replacement = replace(match[1]!, match[2])!;
    const start = match.index, delta = replacement.length - match[0].length;
    content = content.slice(0, start) + replacement + content.slice(start + match[0].length);
    spans = spans.map((span) => ({
      ...span,
      start: span.start > start ? span.start + delta : span.start,
      end: span.end > start ? span.end + delta : span.end,
    }));
  }
  if (!content.trim()) {
    if (!keepBlank) return null;
    content = ''; spans = [];
  }
  const fontFamily = firstRun?.fontFamily ?? 'Arial', fontSizePt = firstRun?.fontSizePt ?? 12, color = firstRun?.color ?? '#000000';
  // Runs keep only the family, size and color that differ from the box's.
  spans = spans.map(({ fontFamily: family, fontSizePt: size, color: runColor, ...span }) => ({ ...span,
    ...(family !== undefined && family !== fontFamily ? { fontFamily: family } : {}),
    ...(size !== undefined && size !== fontSizePt ? { fontSizePt: size } : {}),
    ...(runColor !== undefined && runColor !== color ? { color: runColor } : {}) }));
  const first = spans[0];
  const styled = spans.some((span) => span.bold || span.italic || span.underline || 'fontFamily' in span || 'fontSizePt' in span || 'color' in span);
  return {
    content,
    ...(styled ? { spans } : {}),
    list,
    ...(parsed.lineSpacing ? { lineSpacing: parsed.lineSpacing } : {}),
    ...(parsed.tabStopsPt ? { tabStopsPt: parsed.tabStopsPt } : {}),
    fontFamily,
    fontSizePt,
    color,
    bold: first?.bold ?? firstRun?.bold ?? false,
    italic: first?.italic ?? firstRun?.italic ?? false,
    underline: first?.underline ?? false,
    align: control('qc') ? 'center' : control('qr') ? 'right' : 'left',
    vertical: anchor & ANCHOR_VCENTER ? 'middle' : anchor & ANCHOR_BOTTOM ? 'bottom' : 'top',
    bounded,
    leader: 'none',
    endpoint: 'none',
  };
}

function toMm([x, y]: Point): Point {
  return [x * MM_PER_INCH, y * MM_PER_INCH];
}

/** A label leader within this of the box's center meets it at the center. */
const LABEL_OFFSET_EPSILON_MM = 0.05;
/** A line's height in ems, for placing a stale label box: LayOut's lines are 1.1 (Arial) to 1.2 (Verdana) em. */
const LABEL_LINE_EM = 1.15;

/** Half the height of a text's first or last line, by its largest font. */
function labelLineHalfHeightMm(text: LayoutText, last: boolean): number {
  const breakAt = last ? text.content.lastIndexOf('\n') : text.content.indexOf('\n');
  const start = last ? breakAt + 1 : 0, end = last || breakAt < 0 ? text.content.length : breakAt;
  let size = layoutTextStyleAt(text, Math.min(start, Math.max(0, text.content.length - 1))).fontSizePt;
  for (let index = start; index < end; index++) size = Math.max(size, layoutTextStyleAt(text, index).fontSizePt);
  return size * LABEL_LINE_EM / 2 * MM_PER_INCH / 72;
}

function handleToMm(handle: LayoutPathHandle): LayoutPathHandle {
  return {
    ...(handle.in ? { in: toMm(handle.in) } : {}),
    ...(handle.out ? { out: toMm(handle.out) } : {}),
  };
}

function num(element: XmlElement, key: string, fallback: number): number {
  const value = Number(element.attrs[key]);
  return element.attrs[key] !== undefined && Number.isFinite(value) ? value : fallback;
}

function round(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/**
 * SVG source whose root has a width and height to draw at: when either is missing or a percentage, both become the
 * viewBox size, as pasted SVGs get. The picture is then stretched to its LayOut frame.
 */
function sizedSvg(source: string): string {
  return source.replace(/<svg\b[^>]*>/, (tag) => {
    const box = /\sviewBox\s*=\s*["']([^"']*)["']/.exec(tag)?.[1]?.trim().split(/[\s,]+/).map(Number);
    let sized = tag;
    const size = (name: string): RegExpExecArray | null => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(sized);
    const fixed = [size('width'), size('height')].every((attribute) => attribute && !attribute[1]!.trim().endsWith('%'));
    if (!fixed && box?.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0) {
      for (const [name, value] of [['width', box[2]!], ['height', box[3]!]] as const) {
        const attribute = size(name);
        sized = attribute ? sized.replace(attribute[0], ` ${name}="${value}"`) : sized.replace(/^<svg\b/, `<svg ${name}="${value}"`);
      }
    }
    return /\sxmlns\s*=/.test(sized) ? sized : sized.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  });
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

