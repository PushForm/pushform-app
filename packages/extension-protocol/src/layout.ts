// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';

/**
 * Layout document API, version 1. Paper coordinates are millimeters with the origin at the page's
 * top-left corner and y pointing down; angles are degrees, clockwise on the page. Every create operation returns the
 * new object's id; `as` names it so later operations of the same batch can refer to it as `"$name"`.
 */
export const LAYOUT_API_VERSION = 1;

/** Bounds a host applies before any work; requests over them fail with `limit_exceeded`. */
export const LAYOUT_LIMITS = { operationsPerBatch: 200, pointsPerPath: 2000, textChars: 4000, objectsPerList: 200, tableCells: 2500 } as const;

const mm = z.number().finite();
const positiveMm = mm.positive();
const point = z.tuple([mm, mm]).describe('[x, y] in paper millimeters from the page\'s top-left corner, y down.');
const localName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/).describe('Names this operation\'s result for later operations of the same batch, which refer to it as "$name".');
export const LOCAL_REFERENCE = /^\$([A-Za-z][A-Za-z0-9_-]{0,39})$/;
/** A document id, or `"$name"` for an object created earlier in the same batch. */
const ref = z.union([z.number().int().positive(), z.string().regex(LOCAL_REFERENCE)]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('Hex color such as #1f2937.');
const name = z.string().trim().min(1).max(200);
const textStyle = {
  fontSizePt: z.number().finite().positive().max(1000).optional(),
  fontFamily: z.string().trim().min(1).max(100).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  color: color.optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  vertical: z.enum(['top', 'middle', 'bottom']).optional(),
};
const content = z.string().max(LAYOUT_LIMITS.textChars).describe('Text; <PageNumber>, <PageCount>, <PageName>, <CurrentDate> and custom auto-text field names in angle brackets are replaced when shown.');

export const layoutOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_page'), as: localName.optional(), name: name.optional(), afterPageId: ref.optional() })
    .describe('Add a blank A4 landscape page, after afterPageId or at the end. Returns the page id.'),
  z.object({ op: z.literal('rename_page'), pageId: ref, name }),
  z.object({ op: z.literal('delete_page'), pageId: ref }).describe('Delete a page and everything on it; the last page cannot be deleted.'),
  z.object({ op: z.literal('setup_page'), pageId: ref, widthMm: positiveMm.optional(), heightMm: positiveMm.optional(), marginMm: mm.min(0).optional(), background: color.optional() }),
  z.object({ op: z.literal('add_layer'), as: localName.optional(), name, shared: z.boolean().optional().describe('Shared layers show the same objects on every page.') })
    .describe('Add a layer and make it the active layer. Returns the layer id.'),
  z.object({ op: z.literal('set_active_layer'), layerId: ref }).describe('New objects are created on the active layer.'),
  z.object({ op: z.literal('add_rectangle'), as: localName.optional(), pageId: ref, x: mm, y: mm, width: positiveMm, height: positiveMm,
    cornerRadiusMm: mm.min(0).optional().describe('Rounds the corners when greater than zero.') }).describe('Filled rectangle with the default style. Returns its id.'),
  z.object({ op: z.literal('add_ellipse'), as: localName.optional(), pageId: ref, cx: mm, cy: mm, rx: positiveMm, ry: positiveMm })
    .describe('Filled ellipse or circle (rx = ry) centered at cx, cy. Returns its id.'),
  z.object({ op: z.literal('add_path'), as: localName.optional(), pageId: ref, points: z.array(point).min(2).max(LAYOUT_LIMITS.pointsPerPath),
    closed: z.boolean().optional().describe('Closed paths get the default fill; open paths are lines.') }).describe('Straight-segment line, polyline or polygon. Returns its id.'),
  z.object({ op: z.literal('add_text'), as: localName.optional(), pageId: ref, x: mm, y: mm, width: positiveMm, height: positiveMm, content, ...textStyle })
    .describe('Text box whose top-left corner is x, y; content wraps to the width. Defaults: Verdana 10 pt, #000000, left, top. Returns its id.'),
  z.object({ op: z.literal('set_text'), pageId: ref, entityId: ref, content: content.optional(), ...textStyle })
    .describe('Change a text box or label: only the given properties change. New content clears per-character formatting.'),
  z.object({ op: z.literal('add_table'), as: localName.optional(), pageId: ref, x: mm, y: mm, width: positiveMm, height: positiveMm,
    rows: z.number().int().min(1).max(100), columns: z.number().int().min(1).max(100),
    cells: z.array(z.array(z.string().max(1000)).max(100)).max(100).optional().describe('Row-major cell text; missing cells stay empty.'),
    fontSizePt: z.number().finite().positive().max(1000).optional() }).describe('Table with equal rows and columns. Returns its id.'),
  z.object({ op: z.literal('add_dimension'), as: localName.optional(), pageId: ref, start: point, end: point,
    offsetMm: mm.optional().describe('Distance of the dimension line from the measured points, to the left when walking from start to end; default 8.') })
    .describe('Linear dimension between two paper points; horizontal or vertical when the points nearly line up. Returns its id.'),
  z.object({ op: z.literal('set_style'), pageId: ref, entityIds: z.array(ref).min(1).max(LAYOUT_LIMITS.operationsPerBatch),
    strokeColor: color.optional(), strokeWeightPt: z.number().finite().positive().max(100).optional(),
    fillColor: color.nullable().optional().describe('null removes the fill.'),
    strokeDashMm: z.array(positiveMm).max(16).optional().describe('Alternating dash and gap lengths; [] is solid.') }),
  z.object({ op: z.literal('move'), pageId: ref, entityIds: z.array(ref).min(1).max(LAYOUT_LIMITS.operationsPerBatch), dx: mm, dy: mm,
    copy: z.boolean().optional().describe('Leave the originals and move copies; returns the copies\' ids.') }),
  z.object({ op: z.literal('rotate'), pageId: ref, entityId: ref, angleDeg: z.number().finite(), pivot: point.optional().describe('Defaults to the object\'s center.') }),
  z.object({ op: z.literal('arrange'), pageId: ref, entityId: ref, direction: z.enum(['front', 'back', 'forward', 'backward']) }),
  z.object({ op: z.literal('assign_layer'), pageId: ref, entityIds: z.array(ref).min(1).max(LAYOUT_LIMITS.operationsPerBatch), layerId: ref }),
  z.object({ op: z.literal('delete'), pageId: ref, entityIds: z.array(ref).min(1).max(LAYOUT_LIMITS.operationsPerBatch) }),
  z.object({ op: z.literal('set_auto_text'), name: z.string().trim().min(1).max(100).regex(/^[^<>\r\n]+$/), value: z.string().max(1000) })
    .describe('Set a custom auto-text field such as Client or Project; <Client> in any text then shows the value.'),
]);
export type LayoutOperation = z.infer<typeof layoutOperationSchema>;
export type LayoutOperationName = LayoutOperation['op'];

/** One atomic edit: every operation applies, or none does, as one undo entry. */
export const layoutBatchSchema = z.object({
  expectedRevision: z.number().int().nonnegative().describe('The revision returned by the last layout_get_document, layout_list_objects or layout_apply_operations call.'),
  label: z.string().trim().min(1).max(60).describe('Short undo label for the whole batch, such as "Add title block".'),
  operations: z.array(layoutOperationSchema).min(1).max(LAYOUT_LIMITS.operationsPerBatch),
});
export type LayoutBatch = z.infer<typeof layoutBatchSchema>;

export const LAYOUT_OBJECT_KINDS = ['path', 'text', 'label', 'dimension', 'angular-dimension', 'image', 'table'] as const;
/** Field-selected, bounded read of one page's objects; nullable fields so the schema stays strict. */
export const layoutListSchema = z.object({
  pageId: z.number().int().positive().nullable().describe('null: the page shown in the editor.'),
  kinds: z.array(z.enum(LAYOUT_OBJECT_KINDS)).nullable().describe('null: every kind.'),
  entityIds: z.array(z.number().int().positive()).nullable().describe('null: every object on the page.'),
  offset: z.number().int().min(0).nullable(),
  limit: z.number().int().min(1).max(LAYOUT_LIMITS.objectsPerList).nullable().describe('null: 50.'),
});
export type LayoutListQuery = z.infer<typeof layoutListSchema>;
export const layoutGetDocumentSchema = z.object({});

export type LayoutApiErrorCode = 'stale_revision' | 'invalid_reference' | 'invalid_operation' | 'operation_failed' | 'limit_exceeded' | 'unavailable';
export interface LayoutApiError { code: LayoutApiErrorCode; message: string; revision: number | null; operationIndex?: number }

export interface LayoutPageSummary { id: number; name: string; index: number; widthMm: number; heightMm: number; marginMm: number; background: string; objectCount: number }
export interface LayoutLayerSummary { id: number; name: string; visible: boolean; locked: boolean; shared: boolean; active: boolean }
export interface LayoutDocumentSnapshot {
  apiVersion: number;
  revision: number;
  units: 'mm' | 'inch' | 'architectural';
  activePageId: number;
  selectedEntityIds: number[];
  pages: LayoutPageSummary[];
  layers: LayoutLayerSummary[];
  defaultStyle: { strokeColor: string; strokeWeightPt: number; fillColor: string | null };
  autoTextFields: Record<string, string>;
}
export interface LayoutObjectSummary {
  id: number;
  kind: (typeof LAYOUT_OBJECT_KINDS)[number];
  layerId: number;
  bounds: { x: number; y: number; width: number; height: number };
  locked?: boolean;
  groupId?: number;
  closed?: boolean;
  /** Vertices of short paths; long paths report only their count. */
  points?: [number, number][];
  pointCount?: number;
  curved?: boolean;
  style?: { strokeColor: string; strokeWeightPt: number; fillColor: string | null; strokeDashMm?: number[] };
  text?: { content: string; fontFamily: string; fontSizePt: number; color: string; bold: boolean; italic: boolean; align: string; truncated?: boolean };
  dimension?: { text: string; valueMm: number };
  table?: { rows: number; columns: number; cells: string[][] };
}
export interface LayoutObjectList { revision: number; pageId: number; total: number; offset: number; objects: LayoutObjectSummary[]; next: number | null }
export interface LayoutBatchResult { ok: true; revision: number; label: string; created: Record<string, number>; results: { op: LayoutOperationName; id?: number; ids?: number[] }[] }

/** Tool names and descriptions shared by the host and every client that offers them to a model. */
export const LAYOUT_TOOLS = {
  getDocument: {
    name: 'layout_get_document',
    description: 'Read the open Layout document: its revision, pages (ids, names, sizes, object counts), layers, the page shown in the editor, the selection, units, default style and auto-text fields. Call it before editing.',
  },
  listObjects: {
    name: 'layout_list_objects',
    description: 'List objects on one page with their ids, kinds, layers, bounds in millimeters, styles and text. Paged: pass offset from the previous result\'s next.',
  },
  applyOperations: {
    name: 'layout_apply_operations',
    description: 'Edit the open Layout document in one atomic batch: every operation applies or none does, and the batch is one undo entry labelled with label. Coordinates are paper millimeters from the page\'s top-left corner, y down. Create operations accept as: "name"; later operations refer to that object as "$name". Returns the new revision and the created ids, or an error naming the failed operation; a stale_revision error means the user changed the document, so read it again before retrying.',
  },
} as const;
