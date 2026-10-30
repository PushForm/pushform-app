// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useState, type JSX } from 'react';
import { cloneLayoutTable, editTableAxis, layoutDashMm, matchLayoutDash, mergeTableCells, resizeTableAxis, setTableEdge, tableCellOwner, tableFrame, tableStroke, type LayoutEntity, type LayoutTable, type LayoutTableEdge, type LayoutText } from '@pushform/layout';
import { LayoutDashControls } from './LayoutDashControls';
import { tableGridRange, tableGridCellSelected, type TableGridSelection } from './tableGridSelection';

interface Cell { row: number; column: number }
export function LayoutTablePanel({ entity, selected, selection, onSelect, onChange, disabled }: {
  entity: LayoutEntity; selected: Cell; selection: TableGridSelection; onSelect(cell: Cell, extend?: boolean): void; onChange(table: LayoutTable, size?: { widthMm?: number; heightMm?: number }): void; disabled: boolean;
}): JSX.Element {
  const table = entity.table!, row = Math.min(selected.row, table.rows.length - 1), column = Math.min(selected.column, table.columns.length - 1);
  const owner = tableCellOwner(table, row, column), index = owner.row * table.columns.length + owner.column, cell = table.cells[index]!;
  const [error, setError] = useState<string | null>(null);
  const range = tableGridRange(selection, table.rows.length, table.columns.length, table.merges);
  const rangeStart = selection.anchor.row !== selected.row || selection.anchor.column !== selected.column;
  // The inner lines around the chosen cell; the frame keeps the table's own stroke.
  const lines = ([['Above', 'row', owner.row - 1], ['Below', 'row', owner.row + owner.rowSpan - 1],
    ['Left', 'column', owner.column - 1], ['Right', 'column', owner.column + owner.columnSpan - 1]] as const)
    .filter(([, axis, at]) => at >= 0 && at < (axis === 'row' ? table.rows : table.columns).length - 1);
  const [side, setSide] = useState<string>('Below');
  const line = lines.find(([name]) => name === side) ?? lines[0];
  const edge = line && (table[line[1] === 'row' ? 'rowEdges' : 'columnEdges']?.[line[2]] ?? tableStroke(entity));
  const shown = edge && !/^#[0-9a-f]{6}00$/i.test(edge.strokeColor);
  const setEdge = (values: Partial<LayoutTableEdge>) => { if (line && edge) onChange(setTableEdge(entity, line[1], line[2], { ...edge, ...values })); };
  const change = (fn: (copy: LayoutTable) => void) => { const copy = cloneLayoutTable(table); fn(copy); onChange(copy); };
  const changeCells = (fn: (cell: LayoutTable['cells'][number]) => void) => change(copy => {
    copy.cells.forEach((cell, i) => {
      const row = Math.floor(i / copy.columns.length), column = i % copy.columns.length, owner = tableCellOwner(copy, row, column);
      if (owner.row === row && owner.column === column && tableGridCellSelected({ row, column }, range)) fn(cell);
    });
  });
  const textStyle = (style: Partial<LayoutText>) => changeCells(cell => { Object.assign(cell.text, style); delete cell.text.spans; });
  const axis = (axis: 'row' | 'column', at: number, remove: boolean) => { onChange(editTableAxis(table, axis, at, remove)); onSelect({ row, column }); };
  const size = (axis: 'rows' | 'columns', value: string) => {
    const n = Number(value); if (!Number.isFinite(n) || n <= 0) return;
    const resized = resizeTableAxis(entity, axis === 'rows' ? 'row' : 'column', axis === 'rows' ? row : column, n);
    const frame = tableFrame(resized);
    onChange(resized.table!, axis === 'rows' ? { heightMm: frame.height } : { widthMm: frame.width });
  };
  return <section className="pf-layout-table-panel" aria-label="Table properties">
    <h3>Table</h3>
    <p>{table.rows.length} rows × {table.columns.length} columns</p>
    <fieldset disabled={disabled}>
      <small>Select cells on the page. Drag or Shift-click to extend the range. Drag cell boundaries to resize rows and columns.</small>
      <label>Cell text<textarea key={`${entity.id}:${index}:${cell.text.content}`} aria-label="Table cell text" defaultValue={cell.text.content}
        onBlur={event => { if (event.target.value !== cell.text.content) change(copy => { copy.cells[index]!.text.content = event.target.value; delete copy.cells[index]!.text.spans; }); }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.value = cell.text.content; event.currentTarget.blur(); }
          if (event.key === 'Tab') {
            event.preventDefault(); event.currentTarget.blur();
            const next = Math.max(0, Math.min(table.cells.length - 1, index + (event.shiftKey ? -1 : 1)));
            onSelect({ row: Math.floor(next / table.columns.length), column: next % table.columns.length });
            requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[aria-label="Table cell text"]')?.focus());
          }
        }} /></label>
      <div className="pf-layout-table-actions">
        <button type="button" disabled={table.rows.length >= 100} onClick={() => axis('row', row, false)}>Insert row above</button>
        <button type="button" disabled={table.rows.length >= 100} onClick={() => axis('row', row + 1, false)}>Insert row below</button>
        <button type="button" disabled={table.rows.length === 1} onClick={() => axis('row', row, true)}>Delete row</button>
        <button type="button" disabled={table.columns.length >= 100} onClick={() => axis('column', column, false)}>Insert column left</button>
        <button type="button" disabled={table.columns.length >= 100} onClick={() => axis('column', column + 1, false)}>Insert column right</button>
        <button type="button" disabled={table.columns.length === 1} onClick={() => axis('column', column, true)}>Delete column</button>
        <button type="button" disabled={!rangeStart} onClick={() => {
          try { onChange(mergeTableCells(table, { row: range.top, column: range.left }, { row: range.bottom, column: range.right })); onSelect({ row, column }); setError(null); }
          catch (e) { setError((e as Error).message); }
        }}>Merge cells</button>
        <button type="button" disabled={owner.rowSpan * owner.columnSpan === 1} onClick={() => change(copy => { copy.merges = copy.merges.filter(m => m.row !== owner.row || m.column !== owner.column); })}>Unmerge cells</button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <label>Row height (mm)<input key={`r:${row}:${table.rows[row]}`} type="number" min="0.1" step="0.5" defaultValue={+(table.rows[row]! / table.rows.reduce((s, n) => s + n, 0) * tableFrame(entity).height).toFixed(2)}
        onBlur={event => { if (event.target.value !== event.target.defaultValue) size('rows', event.target.value); }} /></label>
      <label>Column width (mm)<input key={`c:${column}:${table.columns[column]}`} type="number" min="0.1" step="0.5" defaultValue={+(table.columns[column]! / table.columns.reduce((s, n) => s + n, 0) * tableFrame(entity).width).toFixed(2)}
        onBlur={event => { if (event.target.value !== event.target.defaultValue) size('columns', event.target.value); }} /></label>
      <div className="pf-layout-table-actions"><button type="button" onClick={() => change(copy => { copy.rows.fill(1); })}>Equal rows</button>
      <button type="button" onClick={() => change(copy => { copy.columns.fill(1); })}>Equal columns</button></div>
      <label>Cell font<input value={cell.text.fontFamily} onChange={e => { if (e.target.value.trim()) textStyle({ fontFamily: e.target.value }); }} /></label>
      <label>Cell font size (pt)<input type="number" min="1" value={cell.text.fontSizePt} onChange={e => { const n = Number(e.target.value); if (n > 0) textStyle({ fontSizePt: n }); }} /></label>
      <label>Cell text color<input type="color" value={cell.text.color} onChange={e => textStyle({ color: e.target.value })} /></label>
      <label>Cell fill<input type="color" value={cell.fillColor ?? entity.style?.fillColor ?? '#ffffff'} onChange={e => changeCells(cell => { cell.fillColor = e.target.value; })} /></label>
      <label>Cell alignment<select value={cell.text.align} onChange={e => textStyle({ align: e.target.value as LayoutText['align'] })}>
        <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
      <label>Cell vertical alignment<select value={cell.text.vertical} onChange={e => textStyle({ vertical: e.target.value as LayoutText['vertical'] })}>
        <option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option></select></label>
      <label>Cell text rotation<select value={cell.rotationDeg ?? 0} onChange={e => changeCells(cell => {
        const turn = Number(e.target.value) as 0 | 90 | 180 | 270;
        if (turn) cell.rotationDeg = turn; else delete cell.rotationDeg;
      })}>{[0, 90, 180, 270].map(turn => <option key={turn} value={turn}>{turn}°</option>)}</select></label>
      {(['bold', 'italic', 'underline'] as const).map(style => <label key={style}><input type="checkbox" checked={cell.text[style]} onChange={e => textStyle({ [style]: e.target.checked })} />{style[0]!.toUpperCase() + style.slice(1)}</label>)}
      {line && edge ? <div className="pf-layout-table-line" role="group" aria-label="Grid line stroke">
        <label>Grid line<select value={line[0]} onChange={e => setSide(e.target.value)}>
          {lines.map(([name]) => <option key={name} value={name}>{name} this cell</option>)}</select></label>
        <label><input type="checkbox" checked={shown} onChange={e => setEdge({ strokeColor: e.target.checked ? tableStroke(entity).strokeColor.slice(0, 7) : '#00000000' })} />Show line</label>
        {shown ? <>
          <label>Line color<input type="color" value={edge.strokeColor.slice(0, 7)} onChange={e => setEdge({ strokeColor: e.target.value })} /></label>
          <label>Line weight (pt)<input type="number" min="0.01" step="0.1" value={edge.strokeWeightPt} onChange={e => {
            const n = Number(e.target.value), pattern = edge.strokeDashMm?.length ? matchLayoutDash(edge.strokeDashMm, edge.strokeWeightPt) : null;
            if (n > 0) setEdge({ strokeWeightPt: n, ...(pattern ? { strokeDashMm: layoutDashMm(pattern.id, n, pattern.scale) } : {}) });
          }} /></label>
          <LayoutDashControls label="Line dash" dashMm={edge.strokeDashMm} weightPt={edge.strokeWeightPt}
            onChange={dash => { const { strokeDashMm: _, ...rest } = edge; onChange(setTableEdge(entity, line[1], line[2], dash.length ? { ...rest, strokeDashMm: dash } : rest)); }} />
        </> : null}
      </div> : null}
    </fieldset>
  </section>;
}
