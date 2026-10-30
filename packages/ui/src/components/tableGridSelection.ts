// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Cell coordinates and selection are independent of a document or rendering surface. */
export interface TableCellAddress {
  row: number;
  column: number;
}
export interface TableCellSpan extends TableCellAddress {
  rowSpan: number;
  columnSpan: number;
}
export interface TableGridSelection {
  anchor: TableCellAddress;
  focus: TableCellAddress;
}

export function tableGridRange(
  selection: TableGridSelection,
  rows: number,
  columns: number,
  merges: readonly TableCellSpan[],
) {
  const clamp = (cell: TableCellAddress) => ({
    row: Math.max(0, Math.min(rows - 1, cell.row)),
    column: Math.max(0, Math.min(columns - 1, cell.column)),
  });
  const a = clamp(selection.anchor),
    b = clamp(selection.focus);
  let top = Math.min(a.row, b.row),
    bottom = Math.max(a.row, b.row),
    left = Math.min(a.column, b.column),
    right = Math.max(a.column, b.column);
  // Selecting any part of a merged cell includes its whole span, transitively.
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of merges) {
      const endRow = m.row + m.rowSpan - 1,
        endColumn = m.column + m.columnSpan - 1;
      if (m.row > bottom || endRow < top || m.column > right || endColumn < left) continue;
      const next = [
        Math.min(top, m.row),
        Math.max(bottom, endRow),
        Math.min(left, m.column),
        Math.max(right, endColumn),
      ];
      if (next[0] !== top || next[1] !== bottom || next[2] !== left || next[3] !== right) {
        [top, bottom, left, right] = next as [number, number, number, number];
        changed = true;
      }
    }
  }
  return { top, bottom, left, right };
}

export function tableGridCellSelected(
  cell: TableCellAddress,
  range: ReturnType<typeof tableGridRange>,
): boolean {
  return (
    cell.row >= range.top &&
    cell.row <= range.bottom &&
    cell.column >= range.left &&
    cell.column <= range.right
  );
}

export function tableGridNextCell(
  cells: readonly TableCellSpan[],
  current: TableCellAddress,
  key: string,
  backwards = false,
): TableCellAddress {
  const owner =
    cells.find(
      (c) =>
        current.row >= c.row &&
        current.row < c.row + c.rowSpan &&
        current.column >= c.column &&
        current.column < c.column + c.columnSpan,
    ) ?? cells[0]!;
  if (key === 'Tab')
    return cells[
      Math.max(0, Math.min(cells.length - 1, cells.indexOf(owner) + (backwards ? -1 : 1)))
    ]!;
  const row =
    owner.row +
    (key === 'ArrowUp' || (key === 'Enter' && backwards)
      ? -1
      : key === 'ArrowDown' || key === 'Enter'
        ? owner.rowSpan
        : 0);
  const column =
    owner.column + (key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? owner.columnSpan : 0);
  return (
    cells.find(
      (c) =>
        row >= c.row &&
        row < c.row + c.rowSpan &&
        column >= c.column &&
        column < c.column + c.columnSpan,
    ) ?? owner
  );
}
