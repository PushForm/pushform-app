// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useRef, type JSX } from 'react';
import type { ClipboardRichText } from './layoutClipboardRichText';
import {
  tableCellAt,
  tableCellEntities,
  tableCellOwner,
  tableFrame,
  tableBoundaries,
  resizeTableAxis,
  type LayoutEntity,
} from '@pushform/layout';
import { TableGrid } from './TableGrid';
import { LayoutTableCellEditor } from './LayoutTableCellEditor';
import { LENGTH_TOL } from '@pushform/core';
import { TableGridResizers, type TableGridBoundary } from './TableGridResizers';
import type { TableCellAddress, TableGridSelection } from './tableGridSelection';

/** Layout adapter: paper coordinates and cell text styling around the reusable grid. */
export function LayoutTableGrid({
  entity,
  pixelsPerMm,
  selection,
  onSelect,
  onCommit,
  onClear,
  onExit,
  pointFromClient,
  editRequest,
  onResizePreview,
  onResize,
  onCommitRich,
}: {
  entity: LayoutEntity;
  pixelsPerMm: number;
  selection: TableGridSelection;
  editRequest: number;
  onSelect(selection: TableGridSelection): void;
  onCommit(cell: TableCellAddress, value: string): void;
  onCommitRich(cell: TableCellAddress, text: ClipboardRichText): void;
  onClear(cells: TableCellAddress[]): void;
  pointFromClient(x: number, y: number): [number, number];
  onExit(): void;
  onResizePreview(entity: LayoutEntity | null): void;
  onResize(axis: 'row' | 'column', index: number, sizeMm: number): void;
}): JSX.Element {
  const richDraft = useRef<ClipboardRichText | null>(null);
  const table = entity.table!,
    { a, b, d, width, height } = tableFrame(entity);
  const cells = tableCellEntities(entity).map((local) => {
    const row = Math.floor(local.id / table.columns.length),
      column = local.id % table.columns.length;
    const p = local.points[0]!,
      q = local.points[1]!;
    return {
      ...tableCellOwner(table, row, column),
      text: table.cells[local.id]!.text.content,
      left: p[0] * pixelsPerMm,
      top: p[1] * pixelsPerMm,
      width: (q[0] - p[0]) * pixelsPerMm,
      height: (q[1] - p[1]) * pixelsPerMm,
    };
  });
  const lines = tableBoundaries(entity);
  const boundaries: TableGridBoundary[] = (['column', 'row'] as const).flatMap((axis) => {
    const sizes = axis === 'column' ? table.columns : table.rows,
      extent = axis === 'column' ? width : height;
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const direction = axis === 'column' ? [b[0] - a[0], b[1] - a[1]] : [d[0] - a[0], d[1] - a[1]];
    const cursor = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][
      (Math.round(Math.atan2(direction[1]!, direction[0]!) / (Math.PI / 4)) + 8) % 4
    ]!;
    let position = 0;
    return sizes.map((value, index) => {
      const size = (value / total) * extent;
      position += size;
      const runs: [number, number][] =
        index === sizes.length - 1
          ? [[0, axis === 'column' ? height : width]]
          : (lines.find((line) => line.axis === axis && line.index === index)?.runs ?? []).map(
              (run) => {
                const coordinate = axis === 'column' ? 1 : 0;
                return [run[0]![coordinate], run.at(-1)![coordinate]];
              },
            );
      return {
        axis,
        index,
        position,
        size,
        extent: axis === 'column' ? height : width,
        runs,
        cursor,
      };
    });
  });
  return (
    <TableGrid
      cells={cells}
      rows={table.rows.length}
      columns={table.columns.length}
      selection={selection}
      onSelect={onSelect}
      onCommit={(cell, value) => {
        if (richDraft.current?.content === value) onCommitRich(cell, richDraft.current);
        else onCommit(cell, value);
        richDraft.current = null;
      }}
      onClear={onClear}
      onExit={onExit}
      editRequest={editRequest}
      hitCell={(x, y) => tableCellAt(entity, pointFromClient(x, y))}
      style={{
        left: a[0] * pixelsPerMm,
        top: a[1] * pixelsPerMm,
        width: width * pixelsPerMm,
        height: height * pixelsPerMm,
        transform: `matrix(${(b[0] - a[0]) / width},${(b[1] - a[1]) / width},${(d[0] - a[0]) / height},${(d[1] - a[1]) / height},0,0)`,
        transformOrigin: '0 0',
      }}
      renderEditor={(props) => (
        <LayoutTableCellEditor
          key={`${props.cell.row}:${props.cell.column}`}
          {...props}
          entity={entity}
          pixelsPerMm={pixelsPerMm}
          onRichChange={text => { richDraft.current = text; }}
        />
      )}
    >
      <TableGridResizers
        boundaries={boundaries}
        pixelsPerUnit={pixelsPerMm}
        minimumSize={LENGTH_TOL * 1000}
        pointFromClient={(x, y) => {
          const p = pointFromClient(x, y),
            ux = (b[0] - a[0]) / width,
            uy = (b[1] - a[1]) / width,
            vx = (d[0] - a[0]) / height,
            vy = (d[1] - a[1]) / height;
          return [(p[0] - a[0]) * ux + (p[1] - a[1]) * uy, (p[0] - a[0]) * vx + (p[1] - a[1]) * vy];
        }}
        onPreview={(axis, index, size) =>
          onResizePreview(size === null ? null : resizeTableAxis(entity, axis, index, size))
        }
        onCommit={onResize}
      />
    </TableGrid>
  );
}
