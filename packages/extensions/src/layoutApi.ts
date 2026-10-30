// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { CommandRegistry } from '@pushform/commands';
import {
  LAYOUT_API_VERSION, LAYOUT_LIMITS, LAYOUT_TOOLS, LOCAL_REFERENCE, layoutBatchSchema, layoutListSchema,
  type LayoutApiError, type LayoutApiErrorCode, type LayoutBatchResult, type LayoutDocumentSnapshot, type LayoutObjectList,
  type LayoutObjectSummary, type LayoutOperation,
} from '@pushform/extension-protocol';
import { LAYOUT_DEFAULT_TEXT, createLayoutTable, flattenLayoutPath, inferLinearDimensionAlignment, type LayoutDocument, type LayoutEntity } from '@pushform/layout';

/** Runtime editor state the document does not hold: which page is shown and what is selected. */
export interface LayoutViewState {
  activePageId(): number;
  selectedEntityIds(): readonly number[];
}

/** A structured API error; the message is safe to show to the user and to a model. */
export class LayoutApiFailure extends Error {
  constructor(readonly error: LayoutApiError) { super(error.message); this.name = 'LayoutApiFailure'; }
}

/** The result of one tool call as a model sees it. */
export interface ToolCallResult { content: string; isError: boolean }

type Point = [number, number];
const ELLIPSE_SEGMENTS = 48;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_DIMENSION_OFFSET_MM = 8;
const POINT_LIST_MAX = 32;
const TEXT_PREVIEW_CHARS = 500;
const CELL_PREVIEW_CHARS = 100;
const TABLE_PREVIEW_CELLS = 400;
const round = (value: number): number => Math.round(value * 100) / 100;
const zodMessage = (error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string => error.issues.slice(0, 5).map(i => `${i.path.map(String).join('.') || 'input'}: ${i.message}`).join('; ');

/**
 * Host side of the Layout document API for one open document and one client. Reads are snapshots
 * of committed state; `apply` runs a whole batch inside one Layout transaction, so it commits as one undo entry,
 * labelled `<client>: <label>`, or not at all. Every mutation goes through the document's command registry.
 */
export class LayoutDocumentApi {
  constructor(private readonly doc: LayoutDocument, private readonly commands: CommandRegistry, private readonly view: LayoutViewState, private readonly client: string) {}

  get revision(): number { return this.doc.version; }

  getDocument(): LayoutDocumentSnapshot {
    const state = this.doc.state;
    return {
      apiVersion: LAYOUT_API_VERSION,
      revision: this.revision,
      units: state.settings.units,
      activePageId: this.activePageId(),
      selectedEntityIds: [...this.view.selectedEntityIds()],
      pages: state.pageOrder.flatMap((id, index) => {
        const page = state.pages.get(id);
        return page ? [{ id, name: page.name, index, widthMm: page.size[0], heightMm: page.size[1], marginMm: page.margin.left, background: page.background, objectCount: page.entities.size }] : [];
      }),
      layers: state.layerOrder.flatMap(id => {
        const layer = state.layers.get(id);
        return layer ? [{ id, name: layer.name, visible: layer.visible, locked: layer.locked, shared: layer.shared, active: id === state.activeLayerId }] : [];
      }),
      defaultStyle: { ...state.defaultStyle },
      autoTextFields: Object.fromEntries(state.customFields),
    };
  }

  listObjects(input: unknown): LayoutObjectList {
    const parsed = layoutListSchema.safeParse(input);
    if (!parsed.success) throw this.failure('invalid_operation', zodMessage(parsed.error));
    const query = parsed.data;
    const state = this.doc.state;
    const pageId = query.pageId ?? this.activePageId();
    const page = state.pages.get(pageId);
    if (!page) throw this.failure('invalid_reference', `No page ${pageId}. Call ${LAYOUT_TOOLS.getDocument.name} for the page ids.`);
    const kinds = query.kinds ? new Set<string>(query.kinds) : null;
    const ids = query.entityIds ? new Set(query.entityIds) : null;
    // Paint order: layers bottom to top, a shared layer's objects from the document-wide store.
    const all: LayoutEntity[] = [];
    for (const layerId of state.layerOrder) {
      const layer = state.layers.get(layerId);
      if (!layer) continue;
      const source = layer.shared ? { entities: state.sharedEntities, order: state.sharedEntityOrder } : { entities: page.entities, order: page.entityOrder };
      for (const id of source.order) {
        const entity = source.entities.get(id);
        if (entity?.layerId === layerId && (!kinds || kinds.has(entity.kind)) && (!ids || ids.has(entity.id))) all.push(entity);
      }
    }
    const offset = query.offset ?? 0, limit = query.limit ?? DEFAULT_LIST_LIMIT;
    const objects = all.slice(offset, offset + limit).map(summarize);
    return { revision: this.revision, pageId, total: all.length, offset, objects, next: offset + limit < all.length ? offset + limit : null };
  }

  /** Validate, check the revision, then run every operation in one transaction; throws `LayoutApiFailure`. */
  apply(input: unknown): LayoutBatchResult {
    const parsed = layoutBatchSchema.safeParse(input);
    if (!parsed.success) {
      const index = parsed.error.issues.find(i => i.path[0] === 'operations' && typeof i.path[1] === 'number')?.path[1];
      throw this.failure(parsed.error.issues.some(i => i.code === 'too_big' && i.path.length === 1) ? 'limit_exceeded' : 'invalid_operation', zodMessage(parsed.error), typeof index === 'number' ? index : undefined);
    }
    const batch = parsed.data;
    if (batch.expectedRevision !== this.revision)
      throw this.failure('stale_revision', `The document changed since revision ${batch.expectedRevision}; it is now at revision ${this.revision}. Read it again before editing.`);
    const tableCells = batch.operations.reduce((sum, op) => sum + (op.op === 'add_table' ? op.rows * op.columns : 0), 0);
    if (tableCells > LAYOUT_LIMITS.tableCells) throw this.failure('limit_exceeded', `The batch creates ${tableCells} table cells; the limit is ${LAYOUT_LIMITS.tableCells}.`);
    const label = `${this.client}: ${batch.label}`;
    const names = new Map<string, number>();
    const results: LayoutBatchResult['results'] = [];
    let at = 0;
    try {
      this.doc.undoStack.transact(label, () => {
        for (const [index, op] of batch.operations.entries()) {
          at = index;
          const result = this.run(op, names);
          if (typeof result === 'number' && 'as' in op && op.as) {
            if (names.has(op.as)) throw this.failure('invalid_operation', `The name "${op.as}" is used twice in this batch.`, index);
            names.set(op.as, result);
          }
          results.push({ op: op.op, ...(typeof result === 'number' ? { id: result } : Array.isArray(result) ? { ids: result } : {}) });
        }
      });
    } catch (cause) {
      // The transaction threw, so its draft was discarded: the document is exactly as it was.
      if (cause instanceof LayoutApiFailure) throw new LayoutApiFailure({ ...cause.error, revision: this.revision, operationIndex: cause.error.operationIndex ?? at });
      throw this.failure('operation_failed', `Operation ${at} (${batch.operations[at]?.op}) failed: ${cause instanceof Error ? cause.message : String(cause)}. Nothing was changed.`, at);
    }
    return { ok: true, revision: this.revision, label, created: Object.fromEntries(names), results };
  }

  private activePageId(): number {
    const state = this.doc.state, id = this.view.activePageId();
    return state.pages.has(id) ? id : state.pageOrder[0]!;
  }

  private failure(code: LayoutApiErrorCode, message: string, operationIndex?: number): LayoutApiFailure {
    return new LayoutApiFailure({ code, message, revision: this.revision, ...(operationIndex === undefined ? {} : { operationIndex }) });
  }

  private run(op: LayoutOperation, names: ReadonlyMap<string, number>): number | number[] | void {
    const id = (value: number | string): number => {
      if (typeof value === 'number') return value;
      const name = LOCAL_REFERENCE.exec(value)?.[1];
      const resolved = name === undefined ? undefined : names.get(name);
      if (resolved === undefined) throw this.failure('invalid_reference', `"${value}" does not name an object created earlier in this batch.`);
      return resolved;
    };
    const exec = (command: string, params: Record<string, unknown>): unknown => this.commands.execute(command, params);
    switch (op.op) {
      case 'add_page': return exec('layout.page.add', { ...(op.name ? { name: op.name } : {}), ...(op.afterPageId !== undefined ? { afterId: id(op.afterPageId) } : {}) }) as number;
      case 'rename_page': exec('layout.page.rename', { pageId: id(op.pageId), name: op.name }); return;
      case 'delete_page': exec('layout.page.delete', { pageId: id(op.pageId) }); return;
      case 'setup_page': {
        const { op: _, pageId, ...setup } = op;
        exec('layout.page.setup', { pageId: id(pageId), ...setup }); return;
      }
      case 'add_layer': return exec('layout.layer.add', { name: op.name, shared: op.shared ?? false }) as number;
      case 'set_active_layer': exec('layout.layer.activate', { layerId: id(op.layerId) }); return;
      case 'add_rectangle': {
        const radius = op.cornerRadiusMm ?? 0;
        return exec('layout.rectangle.add', { pageId: id(op.pageId), kind: radius > 0 ? 'rounded-rectangle' : 'rectangle',
          first: [op.x, op.y], second: [op.x + op.width, op.y + op.height], amountMm: radius }) as number;
      }
      case 'add_ellipse': {
        // The same 48-vertex closed path the Circle and Ellipse tools draw.
        const points = Array.from({ length: ELLIPSE_SEGMENTS }, (_, index): Point => {
          const angle = (2 * Math.PI * index) / ELLIPSE_SEGMENTS;
          return [op.cx + op.rx * Math.cos(angle), op.cy + op.ry * Math.sin(angle)];
        });
        return exec('layout.shape.add', { pageId: id(op.pageId), points, closed: true }) as number;
      }
      case 'add_path': return exec('layout.shape.add', { pageId: id(op.pageId), points: op.points, closed: op.closed ?? false }) as number;
      case 'add_text': {
        const { op: _, as: _as, pageId, x, y, width, height, content, ...style } = op;
        return exec('layout.text.add', { pageId: id(pageId), kind: 'text', points: [[x, y], [x + width, y + height]],
          text: { content, ...LAYOUT_DEFAULT_TEXT, bold: false, italic: false, underline: false,
            align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none', ...style } }) as number;
      }
      case 'set_text': {
        const { op: _, pageId, entityId, content, ...style } = op;
        // New content would misalign per-character runs, so it replaces them.
        exec('layout.text.update', { pageId: id(pageId), entityId: id(entityId), text: { ...style, ...(content === undefined ? {} : { content, spans: [] }) } });
        return;
      }
      case 'add_table': {
        const pageId = id(op.pageId);
        const tableId = exec('layout.table.add', { pageId, first: [op.x, op.y], second: [op.x + op.width, op.y + op.height], rows: op.rows, columns: op.columns }) as number;
        if (op.cells || op.fontSizePt !== undefined) {
          const table = createLayoutTable(op.rows, op.columns);
          table.cells.forEach((cell, index) => {
            const text = op.cells?.[Math.floor(index / op.columns)]?.[index % op.columns];
            if (text !== undefined) cell.text.content = text;
            if (op.fontSizePt !== undefined) cell.text.fontSizePt = op.fontSizePt;
          });
          exec('layout.table.update', { pageId, entityId: tableId, table });
        }
        return tableId;
      }
      case 'add_dimension': {
        const [dx, dy] = [op.end[0] - op.start[0], op.end[1] - op.start[1]];
        const length = Math.hypot(dx, dy);
        if (length < 1e-6) throw this.failure('invalid_operation', 'A dimension needs two distinct points.');
        // Visually left of start -> end on a y-down page.
        const offset = op.offsetMm ?? DEFAULT_DIMENSION_OFFSET_MM;
        const placement: Point = [(op.start[0] + op.end[0]) / 2 + (dy / length) * offset, (op.start[1] + op.end[1]) / 2 - (dx / length) * offset];
        return exec('layout.dimension.add', { pageId: id(op.pageId), points: [op.start, op.end, placement],
          style: { alignment: inferLinearDimensionAlignment(op.start, op.end) } }) as number;
      }
      case 'set_style': {
        const { op: _, pageId, entityIds, ...style } = op;
        for (const entityId of entityIds) exec('layout.shape.setStyle', { pageId: id(pageId), entityId: id(entityId), ...style });
        return;
      }
      case 'move': {
        const moved = exec('layout.shape.move', { pageId: id(op.pageId), entityIds: op.entityIds.map(id), delta: [op.dx, op.dy], copy: op.copy ?? false, whole: true });
        return op.copy ? moved as number[] : undefined;
      }
      case 'rotate': exec('layout.shape.rotate', { pageId: id(op.pageId), entityId: id(op.entityId), angleDeg: op.angleDeg, ...(op.pivot ? { pivot: op.pivot } : {}) }); return;
      case 'arrange': exec('layout.shape.order', { pageId: id(op.pageId), entityId: id(op.entityId), direction: op.direction }); return;
      case 'assign_layer': {
        const layerId = id(op.layerId);
        for (const entityId of op.entityIds) exec('layout.shape.assignLayer', { pageId: id(op.pageId), entityId: id(entityId), layerId });
        return;
      }
      case 'delete': exec('layout.shape.delete', { pageId: id(op.pageId), entityIds: op.entityIds.map(id) }); return;
      case 'set_auto_text': exec('layout.document.setField', { name: op.name, value: op.value }); return;
    }
  }
}

function boundsOf(points: readonly Point[]): LayoutObjectSummary['bounds'] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: round(minX), y: round(minY), width: round(maxX - minX), height: round(maxY - minY) };
}

function summarize(entity: LayoutEntity): LayoutObjectSummary {
  const outline = entity.kind === 'path' && entity.handles?.some(h => h.in || h.out)
    ? flattenLayoutPath(entity.points, entity.handles, entity.closed, 8, entity.contourStarts) : entity.points;
  const summary: LayoutObjectSummary = { id: entity.id, kind: entity.kind, layerId: entity.layerId, bounds: boundsOf(outline) };
  if (entity.locked) summary.locked = true;
  if (entity.groupId !== undefined) summary.groupId = entity.groupId;
  if (entity.kind === 'path') {
    summary.closed = entity.closed;
    summary.pointCount = entity.points.length;
    if (entity.points.length <= POINT_LIST_MAX) summary.points = entity.points.map(([x, y]): Point => [round(x), round(y)]);
    if (outline !== entity.points) summary.curved = true;
  }
  if (entity.style && entity.kind !== 'text' && entity.kind !== 'table') {
    summary.style = { strokeColor: entity.style.strokeColor, strokeWeightPt: entity.style.strokeWeightPt, fillColor: entity.style.fillColor,
      ...(entity.style.strokeDashMm?.length ? { strokeDashMm: [...entity.style.strokeDashMm] } : {}) };
  }
  if (entity.text) {
    const t = entity.text;
    summary.text = { content: t.content.slice(0, TEXT_PREVIEW_CHARS), fontFamily: t.fontFamily, fontSizePt: t.fontSizePt, color: t.color, bold: t.bold, italic: t.italic, align: t.align,
      ...(t.content.length > TEXT_PREVIEW_CHARS ? { truncated: true } : {}) };
  }
  if (entity.dimension) summary.dimension = { text: entity.dimension.text, valueMm: round(entity.dimension.cachedValueMm) };
  if (entity.table) {
    const { rows, columns, cells } = entity.table;
    summary.table = { rows: rows.length, columns: columns.length,
      cells: rows.length * columns.length > TABLE_PREVIEW_CELLS ? [] : rows.map((_, r) => columns.map((_, c) => (cells[r * columns.length + c]?.text.content ?? '').slice(0, CELL_PREVIEW_CHARS))) };
  }
  return summary;
}

/** Run one Layout tool call by name; failures come back as error results, never as exceptions. */
export function runLayoutTool(api: LayoutDocumentApi, name: string, input: unknown): ToolCallResult {
  try {
    switch (name) {
      case LAYOUT_TOOLS.getDocument.name: return { content: JSON.stringify(api.getDocument()), isError: false };
      case LAYOUT_TOOLS.listObjects.name: return { content: JSON.stringify(api.listObjects(input)), isError: false };
      case LAYOUT_TOOLS.applyOperations.name: return { content: JSON.stringify(api.apply(input)), isError: false };
      default: return { content: JSON.stringify({ ok: false, error: { code: 'invalid_operation', message: `Unknown Layout tool "${name}".`, revision: api.revision } }), isError: true };
    }
  } catch (cause) {
    const error: LayoutApiError = cause instanceof LayoutApiFailure ? cause.error
      : { code: 'operation_failed', message: cause instanceof Error ? cause.message : String(cause), revision: api.revision };
    return { content: JSON.stringify({ ok: false, error }), isError: true };
  }
}
