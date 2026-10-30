// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ANGLE_TOL, LENGTH_TOL } from '@pushform/core';
import type { LayoutEntity, LayoutTable, LayoutTableCell, LayoutTableEdge } from './LayoutDocument';
import { LAYOUT_DEFAULT_TEXT } from './text';
type Point = [number, number];
export const MAX_TABLE_AXIS = 100;
const ROTATIONS = [90, 180, 270];
export function createLayoutTable(rows = 3, columns = 3): LayoutTable {
  if (![rows, columns].every(n => Number.isInteger(n) && n > 0 && n <= MAX_TABLE_AXIS)) throw new Error('Tables need 1–100 rows and columns');
  return { rows: Array<number>(rows).fill(1), columns: Array<number>(columns).fill(1), merges: [],
    cells: Array.from({ length: rows * columns }, () => ({ text: {
      content: '', ...LAYOUT_DEFAULT_TEXT, bold: false, italic: false,
      underline: false, align: 'left', vertical: 'top', bounded: true, leader: 'none', endpoint: 'none',
    } })) };
}
const cloneEdge = (edge: LayoutTableEdge): LayoutTableEdge => ({ ...edge, ...(edge.strokeDashMm ? { strokeDashMm: [...edge.strokeDashMm] } : {}) });
export function cloneLayoutTable(table: LayoutTable): LayoutTable {
  return { ...table, rows: [...table.rows], columns: [...table.columns], merges: table.merges.map(m => ({ ...m })),
    cells: table.cells.map(cell => ({ ...cell, text: { ...cell.text, ...(cell.text.spans ? { spans: cell.text.spans.map(s => ({ ...s })) } : {}) } })),
    ...(table.rowEdges ? { rowEdges: table.rowEdges.map(cloneEdge) } : {}),
    ...(table.columnEdges ? { columnEdges: table.columnEdges.map(cloneEdge) } : {}) };
}
function validEdges(edges: unknown, count: number): boolean {
  return edges === undefined || Array.isArray(edges) && edges.length === count && edges.every((edge: LayoutTableEdge) =>
    edge && typeof edge.strokeColor === 'string' && Number.isFinite(edge.strokeWeightPt) && edge.strokeWeightPt > 0 &&
    (edge.strokeDashMm === undefined || Array.isArray(edge.strokeDashMm) && edge.strokeDashMm.every(n => Number.isFinite(n) && n >= 0)));
}
export function validLayoutTable(value: unknown): value is LayoutTable {
  if (!value || typeof value !== 'object') return false;
  const t = value as LayoutTable;
  const sizes = (a: unknown): a is number[] => Array.isArray(a) && a.length > 0 && a.length <= MAX_TABLE_AXIS && a.every(n => Number.isFinite(n) && n > 0) && Number.isFinite(a.reduce((s, n) => s + n, 0));
  if (!sizes(t.rows) || !sizes(t.columns) || !Array.isArray(t.cells) || t.cells.length !== t.rows.length * t.columns.length || !Array.isArray(t.merges)) return false;
  for (const cell of t.cells) {
    const text = cell?.text;
    if (!text || typeof text.content !== 'string' || typeof text.fontFamily !== 'string' || !text.fontFamily.trim() || typeof text.color !== 'string' ||
      !Number.isFinite(text.fontSizePt) || text.fontSizePt <= 0 || !['left', 'center', 'right'].includes(text.align) ||
      !['top', 'middle', 'bottom'].includes(text.vertical) || ![text.bold, text.italic, text.underline, text.bounded].every(v => typeof v === 'boolean') ||
      (text.spans !== undefined && (!Array.isArray(text.spans) || text.spans.some(s => !s || !Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end <= s.start || s.end > text.content.length || ![s.bold, s.italic, s.underline].every(v => typeof v === 'boolean') || (s.fontFamily !== undefined && (typeof s.fontFamily !== 'string' || !s.fontFamily.trim())) || (s.color !== undefined && typeof s.color !== 'string') || (s.fontSizePt !== undefined && (!Number.isFinite(s.fontSizePt) || s.fontSizePt <= 0))))) ||
      (cell.fillColor !== undefined && cell.fillColor !== null && typeof cell.fillColor !== 'string') ||
      (cell.rotationDeg !== undefined && !ROTATIONS.includes(cell.rotationDeg))) return false;
  }
  if (!validEdges(t.rowEdges, t.rows.length - 1) || !validEdges(t.columnEdges, t.columns.length - 1)) return false;
  if (t.merges.length > t.cells.length / 2) return false;
  const covered = new Set<number>();
  for (const m of t.merges) {
    if (!m || ![m.row, m.column, m.rowSpan, m.columnSpan].every(Number.isInteger) || m.row < 0 || m.column < 0 || m.rowSpan < 1 || m.columnSpan < 1 ||
      m.rowSpan * m.columnSpan < 2 || m.row + m.rowSpan > t.rows.length || m.column + m.columnSpan > t.columns.length) return false;
    for (let r = m.row; r < m.row + m.rowSpan; r++) for (let c = m.column; c < m.column + m.columnSpan; c++) {
      const i = r * t.columns.length + c;
      if (covered.has(i)) return false;
      covered.add(i);
    }
  }
  return true;
}
export function tableCellOwner(table: LayoutTable, row: number, column: number) {
  return table.merges.find(m => row >= m.row && row < m.row + m.rowSpan && column >= m.column && column < m.column + m.columnSpan)
    ?? { row, column, rowSpan: 1, columnSpan: 1 };
}
export function tableFrame(entity: LayoutEntity) {
  const a = entity.points[0]!, b = entity.points[1]!, d = entity.points[3]!;
  const width = Math.hypot(b[0] - a[0], b[1] - a[1]), height = Math.hypot(d[0] - a[0], d[1] - a[1]);
  return { a, b, d, width, height };
}
/** Resize one axis member in paper millimeters, keeping every other size and the
 * local top-left corner fixed. Pure geometry for previews and command adapters. */
export function resizeTableAxis(entity: LayoutEntity, axis: 'row' | 'column', index: number, sizeMm: number): LayoutEntity {
  if (!entity.table || !Number.isFinite(sizeMm) || sizeMm < LENGTH_TOL * 1000) throw new Error('Invalid table cell size');
  const table = cloneLayoutTable(entity.table), key = axis === 'row' ? 'rows' : 'columns';
  if (!Number.isInteger(index) || index < 0 || index >= table[key].length) throw new Error('Invalid table index');
  const { a, b, d, width, height } = tableFrame(entity), extent = axis === 'row' ? height : width;
  const total = table[key].reduce((sum, size) => sum + size, 0);
  table[key] = table[key].map(size => size / total * extent);
  table[key][index] = sizeMm;
  const resized = table[key].reduce((sum, size) => sum + size, 0);
  const sx = axis === 'column' ? resized / width : 1, sy = axis === 'row' ? resized / height : 1;
  const point = (u: number, v: number): Point => [a[0] + (b[0] - a[0]) * sx * u + (d[0] - a[0]) * sy * v,
    a[1] + (b[1] - a[1]) * sx * u + (d[1] - a[1]) * sy * v];
  return { ...entity, table, points: [point(0, 0), point(1, 0), point(1, 1), point(0, 1)] };
}
export function tableCellAt(entity: LayoutEntity, point: Point): { row: number; column: number } | null {
  if (!entity.table || entity.points.length !== 4) return null;
  const { a, b, d } = tableFrame(entity), ux = b[0] - a[0], uy = b[1] - a[1], vx = d[0] - a[0], vy = d[1] - a[1];
  const det = ux * vy - uy * vx;
  if (Math.abs(det) <= (LENGTH_TOL * 1000) ** 2) return null;
  const x = ((point[0] - a[0]) * vy - (point[1] - a[1]) * vx) / det;
  const y = (ux * (point[1] - a[1]) - uy * (point[0] - a[0])) / det;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  const index = (sizes: number[], ratio: number) => {
    const target = ratio * sizes.reduce((sum, n) => sum + n, 0);
    let sum = 0;
    return Math.max(0, sizes.findIndex((n, i) => { sum += n; return target < sum || i === sizes.length - 1; }));
  };
  const owner = tableCellOwner(entity.table, index(entity.table.rows, y), index(entity.table.columns, x));
  return { row: owner.row, column: owner.column };
}
/** Insert/delete an axis, adjusting spans and retaining surviving cell data. */
export function editTableAxis(source: LayoutTable, axis: 'row' | 'column', index: number, remove: boolean): LayoutTable {
  const table = cloneLayoutTable(source), sizes = axis === 'row' ? table.rows : table.columns;
  if (!Number.isInteger(index) || index < 0 || index >= sizes.length + (remove ? 0 : 1)) throw new Error('Invalid table index');
  if (remove ? sizes.length === 1 : sizes.length >= MAX_TABLE_AXIS) throw new Error('Tables need 1–100 rows and columns');
  const oldColumns = table.columns.length, oldCells = table.cells;
  sizes.splice(index, remove ? 1 : 0, ...(remove ? [] : [sizes[Math.min(index, sizes.length - 1)]!]));
  // Removing a row or column drops the line below or right of it (the one above or left for the last);
  // a new one gets its own line, styled like its neighbor's.
  const edgeKey = axis === 'row' ? 'rowEdges' : 'columnEdges', edges = table[edgeKey];
  if (edges && remove) edges.splice(Math.min(index, edges.length - 1), 1);
  else if (edges) {
    const neighbor = edges[Math.min(index, edges.length - 1)];
    if (neighbor) edges.splice(Math.min(index, edges.length), 0, cloneEdge(neighbor));
    else delete table[edgeKey];
  }
  table.cells = Array.from({ length: table.rows.length * table.columns.length }, (_, i) => {
    let r = Math.floor(i / table.columns.length), c = i % table.columns.length;
    if (!remove && (axis === 'row' ? r : c) === index) return createLayoutTable(1, 1).cells[0]!;
    if (axis === 'row' && r >= index) r += remove ? 1 : -1;
    if (axis === 'column' && c >= index) c += remove ? 1 : -1;
    return oldCells[r * oldColumns + c]!;
  });
  table.merges = table.merges.flatMap(m => {
    const start = axis === 'row' ? 'row' : 'column', span = axis === 'row' ? 'rowSpan' : 'columnSpan';
    const oldStart = m[start], oldSpan = m[span], master = oldCells[m.row * oldColumns + m.column]!;
    if (index < m[start] || (!remove && index === m[start])) m[start] += remove ? -1 : 1;
    else if (index < m[start] + m[span]) m[span] += remove ? -1 : 1;
    // Preserve the displayed top-left value when its row or column is removed.
    if (remove && index === oldStart && oldSpan > 1) {
      table.cells[m.row * table.columns.length + m.column] = master;
    }
    if (m.rowSpan < 1 || m.columnSpan < 1 || m.rowSpan * m.columnSpan === 1) return [];
    return [m];
  });
  return table;
}
export function mergeTableCells(source: LayoutTable, from: { row: number; column: number }, to: { row: number; column: number }): LayoutTable {
  const table = cloneLayoutTable(source), row = Math.min(from.row, to.row), column = Math.min(from.column, to.column);
  const rowSpan = Math.abs(to.row - from.row) + 1, columnSpan = Math.abs(to.column - from.column) + 1;
  table.merges = table.merges.filter(m => {
    const overlaps = m.row < row + rowSpan && m.row + m.rowSpan > row && m.column < column + columnSpan && m.column + m.columnSpan > column;
    if (overlaps && (m.row < row || m.column < column || m.row + m.rowSpan > row + rowSpan || m.column + m.columnSpan > column + columnSpan)) throw new Error('Select complete merged cells');
    return !overlaps;
  });
  if (rowSpan * columnSpan > 1) table.merges.push({ row, column, rowSpan, columnSpan });
  if (!validLayoutTable(table)) throw new Error('Invalid table selection');
  return table;
}
/** Grid line positions in local table coordinates: the frame edges and every row or column boundary. */
export function tableGridPositions(entity: LayoutEntity): { xs: number[]; ys: number[] } {
  const t = entity.table!, { width, height } = tableFrame(entity);
  const edges = (sizes: number[], extent: number) => { const sum = sizes.reduce((s, n) => s + n, 0); let p = 0; return [0, ...sizes.map(n => (p += n / sum * extent))]; };
  return { xs: edges(t.columns, width), ys: edges(t.rows, height) };
}

/** Each visible (top-left) cell with its box in local table coordinates and its effective background. */
export function tableCells(entity: LayoutEntity): { index: number; row: number; column: number; cell: LayoutTableCell; box: [Point, Point]; fillColor: string | null }[] {
  if (!entity.table) return [];
  const t = entity.table, { xs, ys } = tableGridPositions(entity);
  return t.cells.flatMap((cell, index) => {
    const row = Math.floor(index / t.columns.length), column = index % t.columns.length, m = tableCellOwner(t, row, column);
    if (m.row !== row || m.column !== column) return [];
    return [{ index, row, column, cell, box: [[xs[column]!, ys[row]!], [xs[column + m.columnSpan]!, ys[row + m.rowSpan]!]] as [Point, Point],
      fillColor: cell.fillColor === undefined ? entity.style?.fillColor ?? '#ffffff' : cell.fillColor }];
  });
}

/**
 * Text entities in local table coordinates, shared by screen, print, font loading, and export. A turned
 * cell's text box is the cell's box turned about its center, so its lines run along the cell.
 */
export function tableCellEntities(entity: LayoutEntity): LayoutEntity[] {
  return tableCells(entity).map(({ index, cell, box: [p, q], fillColor }) => {
    const turned = cell.rotationDeg === 90 || cell.rotationDeg === 270;
    const cx = (p[0] + q[0]) / 2, cy = (p[1] + q[1]) / 2, hw = (turned ? q[1] - p[1] : q[0] - p[0]) / 2, hh = (turned ? q[0] - p[0] : q[1] - p[1]) / 2;
    return { id: index, kind: 'text' as const, layerId: entity.layerId, closed: false,
      points: [[cx - hw, cy - hh], [cx + hw, cy + hh]] as Point[],
      text: { ...cell.text, bounded: true, rotationDeg: cell.rotationDeg ?? 0, leader: 'none' as const },
      style: { strokeColor: entity.style?.strokeColor ?? '#222222', strokeWeightPt: entity.style?.strokeWeightPt ?? 0.5,
        ...(entity.style?.strokeDashMm ? { strokeDashMm: entity.style.strokeDashMm } : {}), fillColor } };
  });
}

/** The table's own stroke, which draws its frame and every grid line without one of its own. */
export function tableStroke(entity: LayoutEntity): LayoutTableEdge {
  return { strokeColor: entity.style?.strokeColor ?? '#222222', strokeWeightPt: entity.style?.strokeWeightPt ?? 0.5,
    ...(entity.style?.strokeDashMm?.length ? { strokeDashMm: entity.style.strokeDashMm } : {}) };
}

/** A copy of the table with one inner line's stroke set; every other line keeps the stroke it draws with. */
export function setTableEdge(entity: LayoutEntity, axis: 'row' | 'column', index: number, edge: LayoutTableEdge): LayoutTable {
  const table = cloneLayoutTable(entity.table!), key = axis === 'row' ? 'rowEdges' : 'columnEdges';
  const count = (axis === 'row' ? table.rows : table.columns).length - 1;
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('Invalid table line');
  const stroke = tableStroke(entity), edges = table[key] ?? Array.from({ length: count }, () => cloneEdge(stroke));
  edges[index] = cloneEdge(edge);
  table[key] = edges;
  if (!validLayoutTable(table)) throw new Error('Invalid table line');
  return table;
}

/**
 * Every column then row boundary in local coordinates, as the runs merged cells leave of it (possibly
 * none), with the boundary's own stroke or the table's.
 */
export function tableBoundaries(entity: LayoutEntity): { axis: 'row' | 'column'; index: number; runs: Point[][]; style: LayoutTableEdge }[] {
  const t = entity.table;
  if (!t) return [];
  const { xs, ys } = tableGridPositions(entity), columns = t.columns.length, stroke = tableStroke(entity);
  const owner = Array.from({ length: t.rows.length * columns }, (_, i) => {
    const m = tableCellOwner(t, Math.floor(i / columns), i % columns);
    return m.row * columns + m.column;
  });
  const runs = (count: number, crosses: (along: number) => boolean, point: (along: number) => Point) => {
    const result: Point[][] = [];
    let run: Point[] | null = null;
    for (let along = 0; along < count; along++) {
      if (crosses(along)) { if (!run) result.push(run = [point(along)]); run.push(point(along + 1)); }
      else run = null;
    }
    return result;
  };
  return [
    ...Array.from({ length: columns - 1 }, (_, c) => ({ axis: 'column' as const, index: c, style: t.columnEdges?.[c] ?? stroke,
      runs: runs(t.rows.length, r => owner[r * columns + c] !== owner[r * columns + c + 1], r => [xs[c + 1]!, ys[r]!]) })),
    ...Array.from({ length: t.rows.length - 1 }, (_, r) => ({ axis: 'row' as const, index: r, style: t.rowEdges?.[r] ?? stroke,
      runs: runs(columns, c => owner[r * columns + c] !== owner[(r + 1) * columns + c], c => [xs[c]!, ys[r + 1]!]) })),
  ];
}

/**
 * The table's lines in local coordinates: each row and column boundary as runs that stop where merged
 * cells cover it, with its own stroke or the table's, then the frame as one closed outline.
 */
export function tableGridLines(entity: LayoutEntity): { points: Point[]; closed: boolean; style: LayoutTableEdge }[] {
  if (!entity.table) return [];
  const { xs, ys } = tableGridPositions(entity), right = xs.at(-1)!, bottom = ys.at(-1)!;
  return [
    ...tableBoundaries(entity).flatMap(({ runs, style }) => runs.map(points => ({ points, closed: false, style }))),
    { points: [[0, 0], [right, 0], [right, bottom], [0, bottom]], closed: true, style: tableStroke(entity) },
  ];
}

/** A table frame stays rectangular through ordinary move/rotate/scale operations. */
export function validTableFrame(points: unknown): points is Point[] {
  if (!Array.isArray(points) || points.length !== 4 || !points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return false;
  const [a, b, c, d] = points as [Point, Point, Point, Point];
  const ux = b[0] - a[0], uy = b[1] - a[1], vx = d[0] - a[0], vy = d[1] - a[1];
  const width = Math.hypot(ux, uy), height = Math.hypot(vx, vy);
  return Number.isFinite(width * height) && width >= LENGTH_TOL * 1000 && height >= LENGTH_TOL * 1000 &&
    Math.abs(ux / width * vx / height + uy / width * vy / height) <= ANGLE_TOL &&
    Math.hypot(c[0] - b[0] - d[0] + a[0], c[1] - b[1] - d[1] + a[1]) <= LENGTH_TOL * 1000;
}
