// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { strToU8, zipSync } from 'fflate';
import { DASH_PATTERN_TOL, type LengthFormat } from '@pushform/core';
import { encodePng, PNG_MAX_PX } from './png';
import { PreservedLayoutExport } from './preservedLayoutExport';
import {
  bakeLayoutModelText,
  layoutModelFields,
  matchLayoutDash,
  nearestLayoutDash,
  LAYOUT_AUTO_TEXT_TAGS,
  LAYOUT_PAGE_NUMBER_STYLES,
  DEFAULT_LAYOUT_PAGE_NUMBERING,
  layoutPageNumbering,
  LAYOUT_ACCOUNT_TAGS,
  layoutAccountFields,
  tableBoundaries,
  tableCellEntities,
  tableFrame,
  tableGridPositions,
  tableStroke,
  angularDimensionGeometry,
  formatAngularDimension,
  formatLinearDimension,
  layoutLabelLeader,
  layoutTextCenter,
  layoutTextStyleAt,
  lineSpacingRtf,
  tabStopsRtf,
  LAYOUT_ARROW_FILE_CODES,
  LAYOUT_DEFAULT_ARROW_SIZE_PT,
  type LayoutArrow,
  layoutPathContours,
  linearDimensionGeometry,
  rotateLayoutPoint,
  entityOnPage,
  type LayoutAngularDimension,
  type LayoutDimensionAnchor,
  layoutSegmentAnchorFrame,
  type LayoutDocumentState,
  type LayoutEntity,
  type LayoutLinearDimension,
  type LayoutPage,
  type LayoutPathHandle,
  type LayoutTableEdge,
  type LayoutText,
  type LayoutTextStyle,
} from '@pushform/layout';

/**
 * Export to SketchUp LayOut documents. The XML follows the .layout file format as written by LayOut 2027 (27.0.264).
 */

export interface SketchUpLayoutExportOptions {
  /** Converts pictures LayOut cannot place (SVG, WebP, GIF, BMP) to PNG bytes at the given size. */
  rasterize?: (src: string, widthPx: number, heightPx: number) => Promise<Uint8Array>;
  /** PNG for `doc_thumbnail.png`; a blank page-colored thumbnail is written otherwise. */
  thumbnail?: Uint8Array;
  /** Timestamp written to document properties and references (tests pin it). */
  now?: Date;
}

export interface SketchUpLayoutExport {
  bytes: Uint8Array;
  /** Human-readable notes about content that LayOut receives in a different form. */
  warnings: string[];
}

type Point = [number, number];
interface Style { fill: string | null; stroke: string | null; weightPt: number; dash?: { id: number; scale: number } }
interface Subpath { points: Point[]; handles: LayoutPathHandle[]; closed: boolean }
/** Arrowhead [file code, size] at each end of a path. */
interface Arrows { start: [number, number]; end: [number, number] }

const MM_PER_INCH = 25.4;
const NS = {
  layoutdocument: 'http://sketchup.google.com/schemas/layout/1.0/layoutdocument',
  layout: 'http://sketchup.google.com/schemas/layout/1.0/layout',
  references: 'http://sketchup.google.com/schemas/layout/1.0/references',
  entities: 'http://sketchup.google.com/schemas/layout/1.0/entities',
  page: 'http://sketchup.google.com/schemas/layout/1.0/page',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
};
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n';
const COMMON_NS = `xmlns:l="${NS.layout}" xmlns:ld="${NS.layoutdocument}" xmlns:r="${NS.references}" xmlns:e="${NS.entities}" xmlns:xsi="${NS.xsi}"`;
/** Path opcodes in `<elements>`. */
const OP_MOVE = 0, OP_LINE = 1, OP_CUBIC = 2, OP_CLOSE = 3;
/** `anchorType` bits on text boxes. */
const ANCHOR = { left: 1, right: 2, top: 4, bottom: 8, center: 16, middle: 32 } as const;
/** Pictures LayOut places directly; anything else is rasterized to PNG. */
const PLACEABLE: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };
/** Raster resolution for converted pictures, capped so huge frames stay reasonable. */
const RASTER_DPI = 300, RASTER_MAX_PX = PNG_MAX_PX;
/** Average glyph advance and line height of the exported default text, as fractions of the font size. */
const GLYPH_EM = 0.59, LINE_EM = 1.105;
/** Extra width LayOut gives its own dimension text boxes (about 0.09 in). */
const DIMENSION_TEXT_PADDING_MM = 3;
/** Auto-text LayOut puts in every new document, in its order (type numbers from the API). */
const DEFAULT_AUTO_TEXT: [name: string, attrs: string][] = [
  ['Author', 'type="3" textValue="Author Name"'], ['Company', 'type="3" textValue="Company Name"'],
  ['Address', 'type="3" textValue="Address"'], ['PageNumber', 'type="2" numberingType="0" startNumber="1"'],
  ['PageName', 'type="1"'], ['FileName', 'type="0" showExtension="0" showFullPath="0"'],
  ['CurrentDate', 'type="4" dateFormat="MMMM D, YYYY"'], ['DateCreated', 'type="5" dateFormat="MMMM D, YYYY"'],
  ['DateModified', 'type="6" dateFormat="MMMM D, YYYY"'], ['DatePublished', 'type="7" dateFormat="MMMM D, YYYY"'],
  ['PageCount', 'type="25" numberingType="0" startNumber="1"'],
];
/**
 * Arrowhead codes as stored in `arrowData` (the format's own numbering).
 */
const ARROW = { none: 0, filledTriangle: 1, filledCircle: 5, slashRight: 13, overrun: 16, filledSkinnyTriangle: 17 } as const;
const DIMENSION_ENDPOINTS: Record<LayoutLinearDimension['endpoint'], number> = {
  arrow: ARROW.filledTriangle, tick: ARROW.slashRight, dot: ARROW.filledCircle, none: ARROW.none,
};
const LABEL_ENDPOINTS: Record<LayoutText['endpoint'], number> = { arrow: ARROW.filledTriangle, dot: ARROW.filledCircle, none: ARROW.none };
/** `connectionType` of a label: automatic, or where on its text the leader meets it. */
const LABEL_CONNECTION_AUTO = 1;
const LABEL_CONNECTIONS: Record<`${LayoutText['vertical']}-${'left' | 'right'}`, number> = {
  'top-left': 9, 'middle-left': 4, 'bottom-left': 5, 'top-right': 6, 'middle-right': 7, 'bottom-right': 10,
};
/** PushForm draws label arrowheads 3 mm long and label dots 1.6 mm across. */
const LABEL_ARROW_MM = 3, LABEL_DOT_MM = 1.6;
/** `unitsInfo unit` codes: inches 0, feet 1, millimeters 2, centimeters 3, meters 4, points 5, degrees 9, radians 10. */
const LINEAR_UNITS: Record<LayoutLinearDimension['units'], number> = { inch: 0, ft: 1, mm: 2, cm: 3, m: 4, pt: 5 };
const UNIT_DEGREES = 9, UNIT_RADIANS = 10;
/** `unitsInfo format` codes and the unit each non-decimal format is counted in. */
const LENGTH_FORMATS: Record<Exclude<LengthFormat, 'decimal'>, { format: number; unit: number }> = {
  architectural: { format: 1, unit: LINEAR_UNITS.inch }, engineering: { format: 2, unit: LINEAR_UNITS.ft },
  fractional: { format: 3, unit: LINEAR_UNITS.inch },
};
export async function exportSketchUpLayout(state: LayoutDocumentState, options: SketchUpLayoutExportOptions = {}): Promise<SketchUpLayoutExport> {
  return new Exporter(state, options).run();
}

class Exporter {
  private nextId = 1;
  private readonly warnings = new Map<string, number>();
  private readonly files: Record<string, Uint8Array> = {};
  private readonly references: string[] = [];
  /** Image reference ids by source, so repeated pictures share one file. */
  private readonly images = new Map<string, string>();
  private readonly layerIds = new Map<number, string>();
  private readonly timestamp: string;
  private readonly customTags = new Map<string, string>();
  /** Page-number fields other than PageNumber, by field name, with their LayOut tag names. */
  private readonly pageNumberTags = new Map<string, string>();
  /** The LayOut id each exported path, dimension and label was written with, by PushForm id. */
  private readonly writtenIds = new Map<number, string>();
  private readonly preserved = new PreservedLayoutExport(() => this.allocId(), this.files, this.references, message => this.warn(message), entity => this.placement(entity));

  constructor(private readonly state: LayoutDocumentState, private readonly options: SketchUpLayoutExportOptions) {
    this.timestamp = (options.now ?? new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
    for (const name of state.customFields.keys()) if (name !== 'FileName') this.customTags.set(name, autoTextName(name));
    for (const name of state.pageNumberFields?.keys() ?? []) if (name !== 'PageNumber') this.pageNumberTags.set(name, autoTextName(name));
  }

  /** A page-number field as a LayOut type 2 definition's attributes: its start page, numbering style and start number. */
  private pageNumberAttrs(name: string, pageRefs: readonly string[]): string {
    const numbering = layoutPageNumbering(name, this.state) ?? DEFAULT_LAYOUT_PAGE_NUMBERING;
    const start = numbering.startPageId === null ? 0 : Math.max(0, this.state.pageOrder.indexOf(numbering.startPageId));
    return `type="2" l:ref="${pageRefs[start]}" numberingType="${LAYOUT_PAGE_NUMBER_STYLES.indexOf(numbering.style)}" startNumber="${numbering.startNumber}"`;
  }

  async run(): Promise<SketchUpLayoutExport> {
    const { state } = this;
    this.preserved.prepare(state);
    const pages = state.pageOrder.map((id) => state.pages.get(id)!);
    const first = pages[0]!;
    if (pages.some((page) => page.size[0] !== first.size[0] || page.size[1] !== first.size[1] ||
      (Object.keys(first.margin) as (keyof LayoutPage['margin'])[]).some((side) => page.margin[side] !== first.margin[side])))
      this.warn('LayOut uses one paper size for the whole document; every page uses the first page\'s size and margins');
    if (pages.some((page) => page.background !== first.background)) this.warn('every page uses the first page\'s paper color');

    // LayOut numbers page references first; keep that order so ids look familiar when diffing.
    const pageRefs = pages.map(() => this.allocId());
    pageRefs.forEach((refId, index) => this.references.push(
      `<r:pageFileReference r:id="${refId}" type="0" internalTarget="pages/page${index + 1}.xml" externalTarget="" modificationDate="${this.timestamp}" insertDate="${this.timestamp}"/>`));
    const pageIds = pages.map(() => this.allocId());
    for (const layerId of state.layerOrder) this.layerIds.set(layerId, this.allocId());

    for (const [index, page] of pages.entries()) {
      const manager = await this.layerEntityManager(page.entities, page.entityOrder, false, '');
      this.files[`pages/page${index + 1}.xml`] = strToU8(
        `${XML_HEADER}<page xmlns="${NS.page}" id="${pageIds[index]}" ${COMMON_NS}>\n${manager}</page>\n`);
    }
    const master = await this.layerEntityManager(state.sharedEntities, state.sharedEntityOrder, true, 'n0:');

    this.files['document.xml'] = strToU8(this.documentXml(first, pageRefs, pageIds, master));
    this.files['documentProperties.xml'] = strToU8(this.documentProperties(pages.length));
    this.files['styleManager.xml'] = strToU8(STYLE_MANAGER);
    this.files['doc_thumbnail.png'] = this.options.thumbnail ?? blankThumbnail(first);
    this.files['references.xml'] = strToU8(`${XML_HEADER}<references xmlns="${NS.references}" xmlns:r="${NS.references}" xmlns:xsi="${NS.xsi}" checkForUpdatesOnStartup="1" nextId="${this.allocId()}">\n${this.references.map((line) => `  ${line}\n`).join('')}</references>\n`);
    return {
      bytes: zipSync(this.files, { level: 6 }),
      warnings: [...this.warnings].map(([message, count]) => count > 1 ? `${message} (${count}×)` : message),
    };
  }

  private documentXml(first: LayoutPage, pageRefs: string[], pageIds: string[], master: string): string {
    const { state } = this;
    const inches = (mm: number) => num(mm / MM_PER_INCH);
    const active = state.layers.get(state.activeLayerId) ? this.layerIds.get(state.activeLayerId)! : this.layerIds.values().next().value!;
    const layers = state.layerOrder.map((id) => {
      const layer = state.layers.get(id)!;
      return `    <ld:layerDefinition ver="2" id="${this.layerIds.get(id)}" name="${attr(layer.name)}" visible="${flag(layer.visible)}" locked="${flag(layer.locked)}" shared="${flag(layer.shared)}"/>\n`;
    }).join('');
    const visibility = state.layerOrder.map(() => '1').join(',');
    const pageRefXml = state.pageOrder.map((id, index) =>
      `    <ld:pageRef r:id="${pageRefs[index]}" id="${pageIds[index]}" name="${attr(state.pages.get(id)!.name)}" showMasterLayers="1">\n      <r:layerVisibility>${visibility}</r:layerVisibility>\n    </ld:pageRef>\n`).join('');
    const custom = new Map([...this.customTags].map(([field, tag]) => [tag, state.customFields.get(field) ?? layoutAccountFields().get(field) ?? '']));
    const numbered = new Map([...this.pageNumberTags].map(([field, tag]) => [tag, this.pageNumberAttrs(field, pageRefs)]));
    const autoText = [
      ...DEFAULT_AUTO_TEXT.map(([name, attrs]) => custom.has(name)
        ? `      <ld:autoTextDefinition name="${name}" type="3" textValue="${attr(custom.get(name)!)}"/>\n`
        : `      <ld:autoTextDefinition name="${name}" ${name === 'PageNumber' ? this.pageNumberAttrs(name, pageRefs) : numbered.get(name) ?? attrs}/>\n`),
      ...[...custom].filter(([name]) => !DEFAULT_AUTO_TEXT.some(([standard]) => standard === name))
        .map(([name, value]) => `      <ld:autoTextDefinition name="${attr(name)}" type="3" textValue="${attr(value)}"/>\n`),
      ...[...numbered].filter(([name]) => !custom.has(name) && !DEFAULT_AUTO_TEXT.some(([standard]) => standard === name))
        .map(([name, attrs]) => `      <ld:autoTextDefinition name="${attr(name)}" ${attrs}/>\n`),
    ].join('');
    const metric = state.settings.units === 'mm';
    return `${XML_HEADER}<layoutDocument xmlns="${NS.layoutdocument}" id="${this.allocId()}" ${COMMON_NS} xmlns:n0="${NS.page}">
  <ld:pageInfo id="${this.allocId()}" width="${inches(first.size[0])}" height="${inches(first.size[1])}" leftMargin="${inches(first.margin.left)}" rightMargin="${inches(first.margin.right)}" topMargin="${inches(first.margin.top)}" bottomMargin="${inches(first.margin.bottom)}" paperColor="${color(first.background)}" printPaper="0" showMargins="0" printMargins="0" marginColor="4278190335" targetDPI="150" editDrawingQuality="2" outputDrawingQuality="3" imageEditQuality="2" imageOutputQuality="3" editGroupDimLevel="0.66000003" editGroupHideOther="0"/>
  <ld:grid majorSpacing="${inches(state.settings.grid.spacingMm)}" minorDivisions="4" majorColor="4291480266" minorColor="2143996618" showGrid="${flag(state.settings.grid.show)}" showMinor="1" gridInFront="0" gridSnapTo="${flag(state.settings.grid.snap)}" snapToMajor="0" snapToMinor="1" showMajor="1" printGrid="0" clipToMargins="0" gridType="0"/>
  <ld:unitsInfo format="${metric ? 0 : 3}" unit="${metric ? 2 : 0}" precision="${metric ? 1 : 6}" suppressUnitDisplay="0" suppressDashesDisplay="0" forceInchDisplay="0" showFraction="0" suppressApproximateDisplay="0"/>
  <ld:layerManager id="${this.allocId()}">
${layers}    <ld:currentLayerDefinition ver="2" l:ref="${active}"/>
  </ld:layerManager>
${master}  <ld:pageManager id="${this.allocId()}">
${pageRefXml}  </ld:pageManager>
  <ld:autoTextManager id="${this.allocId()}">
    <ld:entityList>
${autoText}    </ld:entityList>
  </ld:autoTextManager>
  ${this.connections()}
  <ld:lastPageDisplayed ver="1" l:ref="${pageRefs[0]}"/>
  <ld:objectSnapEnabled>1</ld:objectSnapEnabled>
  <ld:highlightClippedText>1</ld:highlightClippedText>
  <ld:highlightUnrenderedModel>1</ld:highlightUnrenderedModel>
  <ld:highlightSoftDisconnect>1</ld:highlightSoftDisconnect>
  <ld:renderModeOverride>-1</ld:renderModeOverride>
</layoutDocument>
`;
  }

  /**
   * Dimension ends and label tips anchored to a path vertex, as LayOut's connections: the vertex by its index
   * (type 1), or a point along a segment by the segment's index plus its curve parameter, with the segment's direction
   * there (type 8 straight, 4 curved); and the dimension's start (5) or end (6), or the label. LayOut keeps
   * them in the document.
   */
  private connections(): string {
    const { state } = this;
    const lines: string[] = [];
    const write = (anchor: LayoutDimensionAnchor | null | undefined, owner: number, lookup: (id: number) => LayoutEntity | undefined, side: string): void => {
      const target = anchor && lookup(anchor.entityId), ownerId = this.writtenIds.get(owner), targetId = anchor && this.writtenIds.get(anchor.entityId);
      if (!anchor || !ownerId || !targetId || target?.kind !== 'path' || target.points.length !== anchor.pointCount) return;
      const along = anchor.t === undefined ? null : layoutSegmentAnchorFrame(target, anchor);
      if (anchor.t !== undefined && !along) return;
      const [x, y] = inch(along ? along.point : target.points[anchor.pointIndex]!);
      const type = along ? (along.curved ? 4 : 8) : 1, [dirx, diry] = along ? along.tangent : [0, 0];
      const param1 = along ? num(anchor.pointIndex + anchor.t!) : `${anchor.pointIndex}`;
      lines.push(`    <n0:connection>\n      <n0:connectionPoint ver="2" type="${type}" x="${num(x)}" y="${num(y)}" dirx="${num(dirx)}" diry="${num(diry)}" param1="${param1}" param2="0" l:ref="${targetId}"/>\n` +
        `      ${side.replace('%', ownerId)}\n    </n0:connection>\n`);
    };
    const annotations = (entities: Iterable<LayoutEntity>, lookup: (id: number) => LayoutEntity | undefined): void => {
      for (const entity of entities) {
        if (this.writtenIds.has(entity.id)) lines.push(...this.preserved.connections(entity));
        entity.dimension?.anchors.forEach((anchor, end) => write(anchor, entity.id, lookup, `<n0:dimensionConnectionPoint l:ref="%" componentId="${end + 5}"/>`));
        if (entity.kind === 'label') write(entity.labelAnchor, entity.id, lookup, '<n0:labelConnectionPoint l:ref="%" componentIndex="4294967295"/>');
      }
    };
    for (const page of state.pages.values()) annotations(page.entities.values(), (id) => entityOnPage(page, state, id));
    annotations(state.sharedEntities.values(), (id) => state.sharedEntities.get(id));
    return lines.length ? `<n0:connectionManager>\n${lines.join('')}  </n0:connectionManager>` : '<n0:connectionManager/>';
  }

  private documentProperties(pageCount: number): string {
    return `${XML_HEADER}<documentProperties xmlns="http://sketchup.google.com/schemas/layout/1.0/documentproperties" xmlns:dp="http://sketchup.google.com/schemas/1.0/documentproperties" xmlns:r="${NS.references}" xmlns:ldp="http://sketchup.google.com/schemas/layout/1.0/documentproperties" xmlns:xsi="${NS.xsi}">
  <dp:path></dp:path>
  <dp:title>${xmlEscape(this.state.customFields.get('FileName') ?? '')}</dp:title>
  <dp:keywords></dp:keywords>
  <dp:lastModifiedBy></dp:lastModifiedBy>
  <dp:revision>1</dp:revision>
  <dp:created>${this.timestamp}</dp:created>
  <dp:modified>${this.timestamp}</dp:modified>
  <dp:published>1970-12-31T12:00:00Z</dp:published>
  <ldp:thumbnail>doc_thumbnail.png</ldp:thumbnail>
  <ldp:documentStatistic pageCount="${pageCount}"/>
  <dp:generator name="PushForm" version="1"/>
  <ldp:version current="27.0.264" fullCompatible="27.0.0" partialCompatible="23.0.0"/>
</documentProperties>
`;
  }

  /**
   * One layerEntityManager: the entity list plus, per layer, the stacking order of its entities.
   * Pages carry every non-shared layer; the document master carries the shared ones.
   */
  private async layerEntityManager(entities: Map<number, LayoutEntity>, order: number[], shared: boolean, prefix: string): Promise<string> {
    const byLayer = new Map<number, string[]>();
    const xml: string[] = [];
    for (const id of order) {
      const entity = entities.get(id);
      // Hidden objects are left out of exported files, as they are of prints.
      if (!entity || entity.hidden || !this.layerIds.has(entity.layerId)) continue;
      if (entity.modelAnnotation) this.warn('A native model annotation was exported as paper geometry; its model connection is unavailable in LayOut');
      const written = this.preserved.entity(entity) ?? await this.entity(entity);
      // Connections name a path, dimension or label by the id it was written with.
      if (written[0] && (entity.kind === 'path' || entity.kind === 'dimension' || entity.kind === 'label')) this.writtenIds.set(entity.id, written[0][0]);
      for (const [entityId, entityXml] of written) {
        xml.push(entityXml);
        byLayer.set(entity.layerId, [...byLayer.get(entity.layerId) ?? [], entityId]);
      }
    }
    const instances = this.state.layerOrder.filter((id) => this.state.layers.get(id)!.shared === shared).map((layerId) => {
      const refs = (byLayer.get(layerId) ?? []).map((ref) => `          <e:entity l:ref="${ref}"/>\n`).join('');
      return `      <ld:layerInstance ver="2" id="${this.allocId()}">\n        <ld:layerDefinition ver="2" l:ref="${this.layerIds.get(layerId)}"/>\n        ${refs ? `<ld:entityList>\n${refs}        </ld:entityList>` : '<ld:entityList/>'}\n      </ld:layerInstance>\n`;
    }).join('');
    return `  <${prefix}layerEntityManager id="${this.allocId()}">\n` +
      `    ${xml.length ? `<${prefix}entityList>\n${xml.join('')}    </${prefix}entityList>` : `<${prefix}entityList/>`}\n` +
      `    <${prefix}layerInstanceManager ver="2" id="${this.allocId()}">\n${instances}    </${prefix}layerInstanceManager>\n` +
      `  </${prefix}layerEntityManager>\n`;
  }

  /** LayOut entities for one PushForm entity, as [id, xml] pairs in stacking order. */
  private async entity(entity: LayoutEntity): Promise<[string, string][]> {
    switch (entity.kind) {
      case 'table': return this.table(entity);
      case 'path': return this.pathEntity(entity);
      case 'text': return entity.text ? [this.textEntity(entity.text, entity.points)] : [];
      case 'label': return this.label(entity.text && layoutModelFields(entity)
        ? { ...entity, text: bakeLayoutModelText(entity.text, layoutModelFields(entity)) } : entity);
      case 'dimension': return this.linearDimension(entity);
      case 'angular-dimension': return this.angularDimension(entity);
      case 'image': return this.image(entity);
    }
  }

  /**
   * A native LayOut table: grid sizes and merges, the frame, each visible cell as a text box
   * filling its cell with the cell's background, and, when any line has its own stroke, every row and
   * column line as LayOut writes them, in page coordinates.
   */
  private table(entity: LayoutEntity): [string, string][] {
    const t = entity.table!, id = this.allocId(), columns = t.columns.length;
    const { a, b, d, width, height } = tableFrame(entity);
    const toPage = ([x, y]: Point): Point => [a[0] + x / width * (b[0] - a[0]) + y / height * (d[0] - a[0]),
      a[1] + x / width * (b[1] - a[1]) + y / height * (d[1] - a[1])];
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    const inches = (sizes: number[], extent: number) => { const sum = sizes.reduce((s, n) => s + n, 0); return sizes.map(n => n / sum * extent / MM_PER_INCH); };
    const attrs = [`rowCount="${t.rows.length}"`, `columnCount="${columns}"`];
    for (const m of t.merges) {
      if (m.rowSpan > 1) attrs.push(`rowSpan_${m.row * columns + m.column}="${m.rowSpan}"`);
      if (m.columnSpan > 1) attrs.push(`columnSpan_${m.row * columns + m.column}="${m.columnSpan}"`);
    }
    inches(t.rows, height).forEach((size, i) => attrs.push(`height_${i}="${num(size)}"`));
    inches(t.columns, width).forEach((size, i) => attrs.push(`width_${i}="${num(size)}"`));
    const [x, y] = inch(a);
    const edgeStyle = (edge: LayoutTableEdge): Style => ({ fill: null, stroke: transparent(edge.strokeColor) ? null : edge.strokeColor, weightPt: edge.strokeWeightPt,
      ...this.dash(edge.strokeDashMm, edge.strokeWeightPt) });
    const frame = `        <e:rectangleBase x="${num(x)}" y="${num(y)}" width="${num(width / MM_PER_INCH)}" height="${num(height / MM_PER_INCH)}">\n` +
      `${graphicEntity(edgeStyle(tableStroke(entity)))}${angle ? rotationAbout([x, y], angle) : ''}\n        </e:rectangleBase>\n`;
    const cells = tableCellEntities(entity).map(cell => {
      const p = cell.points[0]!, q = cell.points[1]!, center = toPage([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
      const w = (q[0] - p[0]) / 2, h = (q[1] - p[1]) / 2;
      const [, xml] = this.textEntity({ ...cell.text!, rotationDeg: angle + (cell.text!.rotationDeg ?? 0) },
        [[center[0] - w, center[1] - h], [center[0] + w, center[1] + h]], 'rtfText', cell.style!.fillColor);
      return `      <e:cell_${cell.id}>\n${xml}      </e:cell_${cell.id}>\n`;
    }).join('');
    // Every row and column line, as LayOut writes them for a turned table; LayOut drops a turned table without them.
    const { xs, ys } = tableGridPositions(entity);
    const lines = tableBoundaries(entity).map(({ axis, index, runs, style }) => {
      // A line merged cells hide entirely is written as a single point, as LayOut does.
      const start: Point = axis === 'row' ? [0, ys[index + 1]!] : [xs[index + 1]!, 0];
      const subpaths = runs.length ? runs : [[start, start]];
      const ops = subpaths.flatMap(run => run.map((_, i) => i ? OP_LINE : OP_MOVE));
      const values = subpaths.flatMap(run => run.flatMap(point => inch(toPage(point))));
      return `      <e:${axis}_edge_${index}>\n        <e:path id="${this.allocId()}" wantInternalPoints="0" rotationAngle="${num(angle * Math.PI / 180)}" requiresStrokeOrFill="0">\n` +
        `${graphicEntity(edgeStyle(style))}        <e:elements>${ops.join(',')}</e:elements>\n        <e:points2f>${values.map(num).join(',')}</e:points2f>\n` +
        `        </e:path>\n      </e:${axis}_edge_${index}>\n`;
    }).join('');
    return [[id, `      <e:table id="${id}" ${attrs.join(' ')}>\n${frame}${cells}${lines}      </e:table>\n`]];
  }

  private pathEntity(entity: LayoutEntity): [string, string][] {
    if (entity.points.length < 2) return [];
    const style = entity.style ?? this.state.defaultStyle;
    const visible: Style = {
      fill: entity.closed && style.fillColor && !transparent(style.fillColor) ? style.fillColor : null,
      stroke: transparent(style.strokeColor) ? null : style.strokeColor,
      weightPt: style.strokeWeightPt,
      ...this.dash(entity.style?.strokeDashMm, style.strokeWeightPt),
    };
    if (!visible.fill && !visible.stroke) return [];
    // An open shape's arrows are LayOut arrow styles in points.
    const end = (arrow: LayoutArrow | undefined): [number, number] => arrow ? [LAYOUT_ARROW_FILE_CODES[arrow.type], arrow.sizePt] : [ARROW.none, LAYOUT_DEFAULT_ARROW_SIZE_PT];
    const arrows = !entity.closed && visible.stroke && (entity.style?.startArrow || entity.style?.endArrow)
      ? { start: end(entity.style.startArrow), end: end(entity.style.endArrow) } : undefined;
    // A compound path is one LayOut path with a subpath per contour; open contours are left unclosed.
    const contours = layoutPathContours(entity.points, entity.handles, entity.closed, entity.contourStarts, entity.openContours)
      .map(contour => ({ points: contour.points, handles: contour.handles ?? [], closed: contour.closed }));
    return [this.path(contours, visible, 'path', '', arrows)];
  }

  /** LayOut draws only its own stroke patterns; other dash lengths take the nearest one. */
  private dash(dashMm: number[] | undefined, weightPt: number): Pick<Style, 'dash'> {
    if (!dashMm?.length) return {};
    const exact = matchLayoutDash(dashMm, weightPt);
    if (!exact) this.warn('dash patterns LayOut does not have were exported as the nearest LayOut pattern');
    return { dash: exact ?? nearestLayoutDash(dashMm, weightPt) };
  }

  private path(subpaths: Subpath | Subpath[], style: Style, tag = 'path', extra = '', arrows?: Arrows): [string, string] {
    const id = this.allocId();
    const encoded = (Array.isArray(subpaths) ? subpaths : [subpaths]).map(encodePath);
    const ops = encoded.flatMap(part => part.ops), values = encoded.flatMap(part => part.values);
    const arrowXml = arrows ? `        <e:arrowData startArrowType="${arrows.start[0]}" startArrowSize="${num(arrows.start[1])}" endArrowType="${arrows.end[0]}" endArrowSize="${num(arrows.end[1])}"/>\n` : '';
    return [id, `      <e:${tag} id="${id}"${extra} rotationAngle="0" requiresStrokeOrFill="1">\n${graphicEntity(style)}        <e:elements>${ops.join(',')}</e:elements>\n        <e:points2f>${values.map(num).join(',')}</e:points2f>\n${arrowXml}      </e:${tag}>\n`];
  }

  /**
   * Text box. PushForm rotates text about the box center; LayOut stores the rotated box as its
   * top-left corner plus a rotation about that corner (LayOut does not draw rotated dimension text
   * stored any other way).
   */
  private textEntity(text: LayoutText, points: [number, number][], tag = 'rtfText', fill: string | null = null): [string, string] {
    const id = this.allocId();
    const [a, b] = points as [Point, Point];
    let x = Math.min(a[0], b[0]) / MM_PER_INCH, y = Math.min(a[1], b[1]) / MM_PER_INCH;
    const width = Math.max(Math.abs(b[0] - a[0]) / MM_PER_INCH, 0.01), height = Math.max(Math.abs(b[1] - a[1]) / MM_PER_INCH, 0.01);
    const anchor = (text.align === 'center' ? ANCHOR.center : text.align === 'right' ? ANCHOR.right : ANCHOR.left) |
      (text.vertical === 'middle' ? ANCHOR.middle : text.vertical === 'bottom' ? ANCHOR.bottom : ANCHOR.top);
    let rotation = '';
    if (text.rotationDeg) {
      const radians = text.rotationDeg * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
      const cx = x + width / 2, cy = y + height / 2;
      x = cx - (cos * width / 2 - sin * height / 2);
      y = cy - (sin * width / 2 + cos * height / 2);
      rotation = rotationAbout([x, y], text.rotationDeg);
    }
    return [id, `      <e:${tag} id="${id}" anchorType="${anchor}" growMode="${text.bounded ? 1 : 0}" sequenceIndex="-2147483648" sequenceAutoTextDef="">
        <e:placedFileReference>
          <e:rectangleBase x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}">
            <e:graphicEntity ${fill && !transparent(fill) ? `${color(fill) === 4294967295 ? '' : `fillColor="${color(fill)}" `}shouldStroke="0"` : 'shouldFill="0" shouldStroke="0"'}>
              <e:entity/>
            </e:graphicEntity>${rotation}
          </e:rectangleBase>
        </e:placedFileReference>
        <e:rtfTextRep>${xmlEscape(this.rtf(text))}</e:rtfTextRep>
      </e:${tag}>\n`];
  }

  /**
   * Native LayOut label: the leader runs from the arrow tip through the bend to the text, and the
   * text is the label's own text box. Labels without a leader are plain text.
   */
  private label(entity: LayoutEntity): [string, string][] {
    const text = entity.text;
    if (!text) return [];
    const leader = layoutLabelLeader(entity);
    if (!leader) return [this.textEntity(text, entity.points)];
    const center = layoutTextCenter(entity), angle = text.rotationDeg ?? 0;
    const [tip, bend, start] = [leader.tip, leader.bend, leader.start].map((point) => rotateLayoutPoint(point, center, angle)) as [Point, Point, Point];
    const points = text.leader === 'elbow' ? [tip, bend, start] : [tip, start];
    const weightPt = 0.5;
    const style: Style = { fill: null, stroke: text.color, weightPt };
    const size = text.endpoint === 'dot' ? arrowSize('dot', LABEL_DOT_MM) : arrowSize('triangle', LABEL_ARROW_MM);
    const arrow: Arrows = { start: [LABEL_ENDPOINTS[text.endpoint], size], end: [ARROW.none, 5] };
    const id = this.allocId();
    const [, leaderXml] = this.path(polyline(points), style, 'leaderLine', ' wantInternalPoints="0"', arrow);
    const [, textXml] = this.textEntity(text, entity.points, 'labelText');
    // A leader meeting the text off its center keeps LayOut's first- or last-line connection on that side.
    const side = leader.start[0] <= center[0] ? 'left' : 'right';
    const connection = text.leaderOffsetMm === undefined ? LABEL_CONNECTION_AUTO : LABEL_CONNECTIONS[`${text.vertical}-${side}`];
    return [[id, `      <e:label id="${id}" connectionType="${connection}" extensionLineLength="0">
${graphicEntity(style)}        <e:bodyOffset x="0" y="0"/>
        <e:affineTransform m11="1" m12="0" m21="0" m22="1" tx="0" ty="0"/>
${leaderXml}${textXml}      </e:label>\n`]];
  }

  /**
   * Native LayOut linear dimension: measured points, cached extension lines, dimension line, and
   * text. LayOut keeps `<>` in the dimension string as the live measurement, like PushForm.
   */
  private linearDimension(entity: LayoutEntity): [string, string][] {
    const dim = entity.dimension;
    if (!dim) return [];
    const style = annotationStyle(entity);
    const { a, b, start, end } = linearDimensionGeometry(entity);
    const dx = end[0] - start[0], dy = end[1] - start[1];
    let angle = Math.atan2(dy, dx);
    if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
    const label = formatLinearDimension(dim);
    const size = textSize(label, dim.fontSizePt);
    // Text sits 1 mm above the line, centered, along the line's reading direction.
    const lift = 1 + size[1] / 2;
    const middle: Point = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    const textCenter: Point = [middle[0] + Math.sin(angle) * lift, middle[1] - Math.cos(angle) * lift];
    const format = dim.format && dim.format !== 'decimal' ? LENGTH_FORMATS[dim.format] : { format: 0, unit: LINEAR_UNITS[dim.units] };
    return [this.dimension('linearDimension', dim, style, {
      connections: [a, b], extents: [start, end], line: polyline([start, end]), leaderAt: middle,
      units: format, scale: dim.scale ?? 1, showDashes: dim.showDashes ?? true,
      text: [dimensionText(dim.text, dim.fontFamily, dim.fontSizePt, style.stroke!, angle * 180 / Math.PI), box(textCenter, size)],
      textOffset: -lift,
    })];
  }

  private angularDimension(entity: LayoutEntity): [string, string][] {
    const dim = entity.angularDimension;
    if (!dim) return [];
    const style = annotationStyle(entity);
    const { vertex, radius, startAngle, sweep, start, end, text } = angularDimensionGeometry(entity);
    const label = formatAngularDimension(dim);
    const size = textSize(label, dim.fontSizePt);
    return [this.dimension('angularDimension', dim, style, {
      connections: [entity.points[1]!, entity.points[2]!], extents: [start, end], line: arc(vertex, radius, startAngle, sweep),
      leaderAt: text, units: { format: 0, unit: dim.units === 'radians' ? UNIT_RADIANS : UNIT_DEGREES }, scale: 1, showDashes: true,
      text: [dimensionText(dim.text, dim.fontFamily, dim.fontSizePt, style.stroke!, 0), box(text, size)],
      textOffset: -(2 + size[1] / 2),
      extra: ` insideAngle="${flag(!dim.reflex)}"`, tail: `        <ld:arcCenter x="${num(vertex[0] / MM_PER_INCH)}" y="${num(vertex[1] / MM_PER_INCH)}"/>\n`,
    })];
  }

  /** Shared structure of LayOut linear and angular dimensions. */
  private dimension(tag: 'linearDimension' | 'angularDimension', dim: LayoutLinearDimension | LayoutAngularDimension, style: Style, parts: {
    connections: [Point, Point]; extents: [Point, Point]; line: Subpath; leaderAt: Point; units: { format: number; unit: number };
    scale: number; showDashes: boolean; text: [LayoutText, [number, number][]]; textOffset: number; extra?: string; tail?: string;
  }): [string, string] {
    const id = this.allocId();
    const [, textXml] = this.textEntity(parts.text[0], parts.text[1], 'dimensionText');
    const endpoint = DIMENSION_ENDPOINTS[dim.endpoint];
    const size = dimensionArrowSize(dim.endpoint, dim.arrowSizeMm);
    const [, lineXml] = this.path(parts.line, style, 'dimensionLine', '', { start: [endpoint, size], end: [endpoint, size] });
    const extensions = parts.connections.map((point, index) => {
      const projected = parts.extents[index]!;
      const ex = projected[0] - point[0], ey = projected[1] - point[1], distance = Math.hypot(ex, ey) || 1;
      const gap = Math.min(dim.extensionGapMm, distance);
      const from: Point = [point[0] + ex / distance * gap, point[1] + ey / distance * gap];
      return this.path(polyline([from, projected]), style, `extensionLine${index + 1}`, '',
        { start: [ARROW.none, 4.5], end: [ARROW.overrun, arrowSize('overrun', dim.extensionOverrunMm)] })[1];
    });
    const [, leaderXml] = this.path(polyline([parts.leaderAt, parts.leaderAt]), style, 'leaderLine', '', { start: [ARROW.filledCircle, 1], end: [ARROW.none, 1] });
    const unitsXml = `        <ld:unitsInfo format="${parts.units.format}" unit="${parts.units.unit}" precision="${dim.precision}" suppressUnitDisplay="${flag(!dim.showUnits)}" suppressDashesDisplay="${flag(!parts.showDashes)}" forceInchDisplay="0" showFraction="0" suppressApproximateDisplay="1"/>\n`;
    const point = (name: string, [x, y]: Point) => `        <ld:${name} x="${num(x / MM_PER_INCH)}" y="${num(y / MM_PER_INCH)}"/>\n`;
    // The drawing scale is fixed rather than taken from a viewport, and keeps full precision (1/48 is not 0.020833).
    const scale = parts.scale === 1 ? 'autoScale="1" scale="1"' : `autoScale="0" scale="${parts.scale}"`;
    return [id, `      <e:${tag} id="${id}" textRotationAlignment="2" textVerticalAlignment="0" leaderStyle="2" startOffsetType="0" endOffsetType="0" ${scale} useInModelDistance="0" dimensionString="${attr(dim.text)}"${parts.extra ?? ''}>
${graphicEntity(style)}        <e:textPositionOffset x="0" y="${num(parts.textOffset / MM_PER_INCH)}"/>
${unitsXml}${textXml}${point('startConnectionPoint', parts.connections[0])}${point('endConnectionPoint', parts.connections[1])}${extensions.join('')}${lineXml}${leaderXml}${parts.tail ?? ''}      </e:${tag}>\n`];
  }

  /** Placed picture: frame from its corners, crop as a clip-mask path in page coordinates. */
  private async image(entity: LayoutEntity): Promise<[string, string][]> {
    const placed = this.placement(entity);
    if (!placed) return [];
    const refId = await this.imageReference(entity.image!.src, placed.width, placed.height);
    if (!refId) return [];
    const id = this.allocId();
    return [[id, `      <e:image id="${id}">
${placed.xml}        <r:imageFileReference r:id="${refId}"/>
      </e:image>\n`]];
  }

  /** A picture's `placedFileReference`: frame from its corners, crop as a clip-mask path in page coordinates. */
  private placement(entity: LayoutEntity): { xml: string; rect: [number, number, number, number]; width: number; height: number } | null {
    const image = entity.image;
    const [tl, tr, br, bl] = entity.points as [Point, Point, Point, Point];
    if (!image || !tl || !tr || !br || !bl) return null;
    const ux: Point = [(tr[0] - tl[0]) / MM_PER_INCH, (tr[1] - tl[1]) / MM_PER_INCH];
    const vy: Point = [(bl[0] - tl[0]) / MM_PER_INCH, (bl[1] - tl[1]) / MM_PER_INCH];
    const width = Math.hypot(...ux), height = Math.hypot(...vy);
    if (width < 1e-9 || height < 1e-9) return null;
    const origin: Point = [tl[0] / MM_PER_INCH, tl[1] / MM_PER_INCH];
    const aligned = Math.abs(ux[1]) < 1e-9 && Math.abs(vy[0]) < 1e-9 && ux[0] > 0 && vy[1] > 0;
    // Axis-aligned frames are a plain rectangle; others place a unit-sized base through the transform.
    const base = aligned
      ? `x="${num(origin[0])}" y="${num(origin[1])}" width="${num(width)}" height="${num(height)}"`
      : `x="0" y="0" width="${num(width)}" height="${num(height)}"`;
    const transform = aligned ? '' : `\n            <e:affineTransform m11="${num(ux[0] / width)}" m12="${num(vy[0] / height)}" m21="${num(ux[1] / width)}" m22="${num(vy[1] / height)}" tx="${num(origin[0])}" ty="${num(origin[1])}"/>`;
    let clip = '';
    if (image.clip && image.clip.points.length >= 3) {
      const toPage = ([u, v]: Point): Point => [tl[0] + u * (tr[0] - tl[0]) + v * (bl[0] - tl[0]), tl[1] + u * (tr[1] - tl[1]) + v * (bl[1] - tl[1])];
      const subpath: Subpath = {
        points: image.clip.points.map(toPage),
        handles: (image.clip.handles ?? []).map((handle) => ({ ...(handle.in ? { in: toPage(handle.in) } : {}), ...(handle.out ? { out: toPage(handle.out) } : {}) })),
        closed: true,
      };
      const [, mask] = this.path(subpath, { fill: '#ffffff', stroke: '#000000', weightPt: 1 });
      clip = `\n          <e:clipMask>\n${mask.replace('<e:graphicEntity>', '<e:graphicEntity isClipMask="1">')}          </e:clipMask>`;
    }
    return {
      xml: `        <e:placedFileReference>
          <e:rectangleBase ${base}>
            <e:graphicEntity shouldFill="0" shouldStroke="0">
              <e:entity/>
            </e:graphicEntity>${transform}
          </e:rectangleBase>${clip}
        </e:placedFileReference>\n`,
      rect: aligned ? [origin[0], origin[1], width, height] : [0, 0, width, height], width, height,
    };
  }

  private async imageReference(src: string, widthIn: number, heightIn: number): Promise<string | null> {
    const cached = this.images.get(src);
    if (cached) return cached;
    const parsed = parseDataUrl(src);
    let bytes = parsed?.bytes, extension = parsed ? PLACEABLE[parsed.mime] : undefined;
    if (!bytes || !extension) {
      if (!this.options.rasterize) { this.warn('pictures LayOut cannot place (SVG, WebP, GIF, BMP) were skipped'); return null; }
      const scale = Math.min(RASTER_DPI, RASTER_MAX_PX / Math.max(widthIn, heightIn));
      try {
        bytes = await this.options.rasterize(src, Math.max(1, Math.round(widthIn * scale)), Math.max(1, Math.round(heightIn * scale)));
      } catch {
        this.warn('a picture that could not be converted to PNG was skipped');
        return null;
      }
      extension = 'png';
      this.warn('vector and other pictures were converted to PNG');
    }
    const id = this.allocId();
    const target = `ref/${id}_image.${extension}`;
    this.files[target] = bytes;
    this.references.push(`<r:imageFileReference r:id="${id}" type="0" internalTarget="${target}" externalTarget="" modificationDate="${this.timestamp}" insertDate="${this.timestamp}"/>`);
    this.images.set(src, id);
    return id;
  }

  /**
   * RichEdit-style RTF, as LayOut writes it: one paragraph format with the box's line spacing, character runs switching bold,
   * italic, underline, font, color, and size. PushForm fields become LayOut auto-text tags.
   */
  private rtf(text: LayoutText): string {
    const fonts: string[] = [], colors: string[] = [];
    const fontIndex = (family: string) => { const i = fonts.indexOf(family); return i >= 0 ? i : fonts.push(family) - 1; };
    const colorIndex = (hex: string) => { const rgb = hex.slice(0, 7).toLowerCase(); const i = colors.indexOf(rgb); return (i >= 0 ? i : colors.push(rgb) - 1) + 1; };
    let body = '';
    let current: { b: boolean; i: boolean; ul: boolean; f: number; cf: number; fs: number } | null = null;
    let paragraph = 0;
    // RichEdit list paragraphs: LayOut draws the marker from the \pntext group and keeps it out of the text.
    const list = text.list === 'bullet' || text.list === 'number' ? text.list : null;
    fontIndex(text.fontFamily); // the text's own font is font 0, the RTF default
    const symbol = list === 'bullet' ? fontIndex('Symbol') : -1;
    const marker = (): string => list === 'bullet' ? `{\\pntext\\f${symbol}\\'B7\\tab}` : list === 'number' ? `{\\pntext\\f0 ${paragraph + 1}.\\tab}` : '';
    const emit = (chars: string, at: number) => {
      const style = layoutTextStyleAt(text, Math.min(at, Math.max(0, text.content.length - 1)));
      const next = { b: style.bold, i: style.italic, ul: style.underline, f: fontIndex(style.fontFamily), cf: colorIndex(style.color), fs: Math.round(style.fontSizePt * 2) };
      let controls = '';
      if (!current || current.f !== next.f) controls += `\\f${next.f}`;
      if (!current || current.cf !== next.cf) controls += `\\cf${next.cf}`;
      if (!current ? next.b : current.b !== next.b) controls += next.b ? '\\b' : '\\b0';
      if (!current ? next.i : current.i !== next.i) controls += next.i ? '\\i' : '\\i0';
      if (!current ? next.ul : current.ul !== next.ul) controls += next.ul ? '\\ul' : '\\ulnone';
      if (!current || current.fs !== next.fs) controls += `\\fs${next.fs}`;
      current = next;
      body += (controls ? `${controls} ` : '') + rtfEscape(chars);
    };
    body += marker();
    if (list === 'bullet') body += `{\\*\\pn\\pnlvlblt\\pnf${symbol}\\pnindent0{\\pntxtb\\'B7}}`;
    if (list === 'number') body += '{\\*\\pn\\pnlvlbody\\pnf0\\pnindent0\\pnstart1\\pndec{\\pntxta.}}';
    if (list) body += '\\fi-360\\li360';
    for (const match of text.content.matchAll(/<([^<>\r\n]+)>|\n|[^<\n]+|</g)) {
      const [whole, field] = match;
      if (whole === '\n') {
        body += '\\par\n';
        paragraph++;
        body += marker();
      } else if (field !== undefined) emit(this.fieldTag(field, whole), match.index);
      else {
        // Split plain text wherever the character style changes.
        let start = 0;
        for (let i = 1; i <= whole.length; i++) {
          if (i < whole.length && sameStyle(layoutTextStyleAt(text, match.index + i), layoutTextStyleAt(text, match.index + start))) continue;
          emit(whole.slice(start, i), match.index + start);
          start = i;
        }
      }
    }
    if (!current) emit('', 0);
    const align = text.align === 'center' ? '\\qc' : text.align === 'right' ? '\\qr' : '';
    return `{\\rtf1\\fbidis\\ansi\\ansicpg1252\\deff0\\nouicompat\\deflang1033{\\fonttbl${fonts.map((family, i) => `{\\f${i}\\fnil\\fcharset${i === symbol ? 2 : 0} ${rtfEscape(family)};}`).join('')}}\n` +
      `{\\colortbl ;${colors.map((hex) => `\\red${parseInt(hex.slice(1, 3), 16)}\\green${parseInt(hex.slice(3, 5), 16)}\\blue${parseInt(hex.slice(5, 7), 16)};`).join('')}}\n` +
      `\\viewkind4\\uc1 \n\\pard\\ltrpar${lineSpacingRtf(text.lineSpacing)}${tabStopsRtf(text.tabStopsPt)}${align}${body}\\par\n}\n`;
  }

  private fieldTag(field: string, whole: string): string {
    // Account tags in use become custom auto-text holding the account's current values.
    if (!this.customTags.has(field) && LAYOUT_ACCOUNT_TAGS.includes(field) && layoutAccountFields().has(field))
      this.customTags.set(field, autoTextName(field));
    const tag = LAYOUT_AUTO_TEXT_TAGS.includes(field) ? field : this.pageNumberTags.get(field) ?? this.customTags.get(field);
    if (tag) return `<${tag}>`;
    this.warn('unknown text fields were exported as typed');
    return whole;
  }

  private allocId(): string {
    return `id${this.nextId++}`;
  }

  private warn(message: string): void {
    this.warnings.set(message, (this.warnings.get(message) ?? 0) + 1);
  }
}

/** Opcodes and flat points for a path in inches; closed paths repeat the start point, then close. */
function encodePath({ points, handles, closed }: Subpath): { ops: number[]; values: number[] } {
  const ops: number[] = [OP_MOVE];
  const values: number[] = [...inch(points[0]!)];
  const count = points.length - (closed ? 0 : 1);
  for (let i = 0; i < count; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    const c1 = handles[i]?.out, c2 = handles[(i + 1) % points.length]?.in;
    if (c1 || c2) {
      ops.push(OP_CUBIC);
      values.push(...inch(c1 ?? a), ...inch(c2 ?? b), ...inch(b));
    } else {
      ops.push(OP_LINE);
      values.push(...inch(b));
    }
  }
  if (closed) ops.push(OP_CLOSE);
  return { ops, values };
}

function graphicEntity({ fill, stroke, weightPt, dash }: Style): string {
  const attrs: string[] = [];
  if (fill === null) attrs.push('shouldFill="0"');
  else if (color(fill) !== 4294967295) attrs.push(`fillColor="${color(fill)}"`);
  if (stroke === null) attrs.push('shouldStroke="0"');
  else {
    if (color(stroke) !== 4278190080) attrs.push(`strokeColor="${color(stroke)}"`);
    // PushForm's thinnest stroke is a hairline; LayOut writes hairlines as zero width.
    const width = weightPt <= 0.1 ? 0 : weightPt;
    if (width !== 1) attrs.push(`strokeWidth="${num(width)}"`);
    if (dash) attrs.push(`strokeDashPattern="${dash.id}"`, ...(Math.abs(dash.scale - 1) > DASH_PATTERN_TOL ? [`stroke.patternscale="${num(dash.scale)}"`] : []));
  }
  return `        <e:graphicEntity${attrs.length ? ` ${attrs.join(' ')}` : ''}>\n          <e:entity/>\n        </e:graphicEntity>\n`;
}

function rotationAbout([cx, cy]: Point, degrees: number): string {
  const radians = degrees * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  return `\n            <e:affineTransform m11="${num(cos)}" m12="${num(-sin)}" m21="${num(sin)}" m22="${num(cos)}" tx="${num(cx - (cos * cx - sin * cy))}" ty="${num(cy - (sin * cx + cos * cy))}"/>`;
}

function sameStyle(a: LayoutTextStyle, b: LayoutTextStyle): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline &&
    a.fontFamily === b.fontFamily && a.fontSizePt === b.fontSizePt && a.color === b.color;
}

function dimensionText(content: string, fontFamily: string, fontSizePt: number, color: string, rotationDeg: number): LayoutText {
  return {
    content, fontFamily, fontSizePt, color, bold: false, italic: false, underline: false,
    align: 'center', vertical: 'middle', bounded: false, leader: 'none', endpoint: 'none',
    ...(Math.abs(rotationDeg) > 1e-6 ? { rotationDeg } : {}),
  };
}

/**
 * Text box for dimension text, in millimeters. LayOut wraps dimension text inside its cached box
 * even when the box grows, so the width leaves room beyond the estimated glyph advance.
 */
function textSize(content: string, fontSizePt: number): Point {
  const em = fontSizePt * MM_PER_INCH / 72;
  return [content.length * em * GLYPH_EM * 1.25 + DIMENSION_TEXT_PADDING_MM, em * LINE_EM];
}

function box([cx, cy]: Point, [width, height]: Point): [number, number][] {
  return [[cx - width / 2, cy - height / 2], [cx + width / 2, cy + height / 2]];
}

function polyline(points: Point[]): Subpath {
  return { points, handles: [], closed: false };
}

/** Circular arc as cubic Béziers of at most 90° each. */
function arc([cx, cy]: Point, radius: number, startAngle: number, sweep: number): Subpath {
  const count = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / count, k = 4 / 3 * Math.tan(step / 4) * radius;
  const points: Point[] = [], handles: LayoutPathHandle[] = [];
  for (let i = 0; i <= count; i++) {
    const angle = startAngle + step * i, cos = Math.cos(angle), sin = Math.sin(angle);
    points.push([cx + radius * cos, cy + radius * sin]);
    handles.push({
      ...(i > 0 ? { in: [cx + radius * cos + k * sin, cy + radius * sin - k * cos] as Point } : {}),
      ...(i < count ? { out: [cx + radius * cos - k * sin, cy + radius * sin + k * cos] as Point } : {}),
    });
  }
  return { points, handles, closed: false };
}

/** Dimension and label stroke, defaulting like PushForm's annotation painter. */
function annotationStyle(entity: LayoutEntity): Style {
  return { fill: null, stroke: entity.style?.strokeColor ?? '#222222', weightPt: entity.style?.strokeWeightPt ?? 0.5 };
}

/**
 * LayOut arrow size for a mark of the given drawn extent. Measured on LayOut 2027 renders, one size
 * unit is one point: triangles are 3 units long, dots and slashes 2 units across, and an overrun
 * extends the line by 1 unit.
 */
function arrowSize(kind: 'triangle' | 'dot' | 'slash' | 'overrun', extentMm: number): number {
  const points = extentMm / MM_PER_INCH * 72;
  return kind === 'triangle' ? points / 3 : kind === 'overrun' ? points : points / 2;
}

/** Size of a PushForm dimension endpoint: arrows are `arrowSizeMm` long, dots half that across, ticks that wide. */
function dimensionArrowSize(endpoint: LayoutLinearDimension['endpoint'], arrowSizeMm: number): number {
  if (endpoint === 'arrow') return arrowSize('triangle', arrowSizeMm);
  if (endpoint === 'dot') return arrowSize('dot', arrowSizeMm / 2);
  return arrowSize('slash', arrowSizeMm);
}

function inch([x, y]: Point): Point {
  return [x / MM_PER_INCH, y / MM_PER_INCH];
}

/** `#rrggbb[aa]` as LayOut's 32-bit color: RGBA bytes little-endian (alpha high, red low). */
function color(hex: string): number {
  const value = hex.replace('#', '');
  const channel = (offset: number) => parseInt(value.slice(offset, offset + 2), 16) || 0;
  const alpha = value.length >= 8 ? channel(6) : 255;
  return ((alpha << 24) | (channel(4) << 16) | (channel(2) << 8) | channel(0)) >>> 0;
}

function transparent(hex: string): boolean {
  return hex.replace('#', '').length >= 8 && color(hex) >>> 24 === 0;
}

function rtfEscape(value: string): string {
  let out = '';
  for (const char of value) {
    if (char === '\\' || char === '{' || char === '}') out += `\\${char}`;
    else if (char === '\t') out += '\\tab ';
    else {
      for (let i = 0; i < char.length; i++) {
        const code = char.charCodeAt(i);
        out += code < 0x80 ? char[i] : `\\u${code > 0x7fff ? code - 0x10000 : code}?`;
      }
    }
  }
  return out;
}

function parseDataUrl(src: string): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
  if (!match) return null;
  const [, mime, base64, payload] = match;
  try {
    const bytes = base64 ? Uint8Array.from(atob(payload!), (c) => c.charCodeAt(0)) : strToU8(decodeURIComponent(payload!));
    return { mime: mime!.toLowerCase(), bytes };
  } catch {
    return null;
  }
}

/** Auto-text names are shown as `<Name>` in LayOut text, so angle brackets cannot appear in them. */
function autoTextName(field: string): string {
  return field.replace(/[<>]/g, '').trim() || 'Field';
}

function num(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function flag(value: boolean): string {
  return value ? '1' : '0';
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A 128 px wide thumbnail filled with the paper color; LayOut replaces it on its next save. */
function blankThumbnail(page: LayoutPage): Uint8Array {
  const width = 128, height = Math.max(1, Math.round(128 * page.size[1] / Math.max(page.size[0], 1e-6)));
  const rgb = [1, 3, 5].map((offset) => parseInt(page.background.slice(offset, offset + 2), 16) || 255);
  const pixels = new Uint8Array(width * 3 * height);
  for (let i = 0; i < pixels.length; i += 3) pixels.set(rgb, i);
  return encodePng(width, height, pixels, 3);
}

/** Default per-tool style dictionary as stored in .layout files. */
const STYLE_MANAGER = `${XML_HEADER}<styleManager xmlns="http://sketchup.google.com/schemas/1.0/preferences" xmlns:t="http://sketchup.google.com/schemas/1.0/types" xmlns:l="${NS.layout}" xmlns:e="${NS.entities}" xmlns:r="${NS.references}" ver="1">
  <t:dicItem key="Default">
    <t:variant type="13">
      <e:styleAttributes>
${([
    ['stroke.patternscalewithweight', 1, '1'], ['stroke.cap', 2, '0'], ['stroke.join', 2, '0'], ['stroke.display', 1, '1'],
    ['stroke.dash', 2, '0'], ['arrow.start.size', 6, '5'], ['stroke.width', 6, '1'], ['stroke.patternscale', 6, '1'],
    ['text.numberingstyle', 4, '0'], ['stroke.color', 4, '-16777216'], ['arrow.start.type', 2, '0'], ['arrow.end.type', 2, '0'],
    ['text.spacingbefore', 4, '0'], ['arrow.end.size', 6, '5'], ['fill.display', 1, '1'], ['fill.color', 4, '-1'],
    ['fill.pattern.display', 1, '0'], ['fill.imagepatternrotation', 6, '0'], ['fill.imagepatternscale', 6, '1'],
    ['shadow.display', 1, '0'], ['text.align', 4, '0'], ['text.vertalign', 4, '0'], ['text.numberingtype', 4, '0'],
    ['text.numberingflow', 4, '0'], ['text.numberingstart', 4, '1'], ['text.spacingafter', 4, '0'], ['text.firstindent', 4, '0'],
    ['text.offsetindent', 4, '0'], ['text.linespacingmode', 4, '0'], ['text.linespacing', 4, '0'],
  ] as const).map(([key, type, value]) => `        <t:dicItem key="${key}">\n          <t:variant type="${type}">${value}</t:variant>\n        </t:dicItem>\n`).join('')}      </e:styleAttributes>
    </t:variant>
  </t:dicItem>
</styleManager>
`;
