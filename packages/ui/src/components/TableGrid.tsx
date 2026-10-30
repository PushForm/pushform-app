// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  tableGridCellSelected,
  tableGridNextCell,
  tableGridRange,
  type TableCellAddress,
  type TableCellSpan,
  type TableGridSelection,
} from './tableGridSelection';

export interface TableGridCell extends TableCellSpan {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface TableGridEditorProps {
  cell: TableCellAddress;
  value: string;
  onChange(value: string, forceCommit?: boolean): void;
  onBlur(): void;
}

/** Reusable cell interaction surface. The host owns geometry, text rendering and
 * undoable writes; this widget owns transient typing, focus and pointer gestures. */
export function TableGrid({
  cells,
  rows,
  columns,
  selection,
  onSelect,
  onCommit,
  onClear,
  onExit,
  renderEditor,
  hitCell,
  editRequest = 0,
  style,
  children,
}: {
  cells: TableGridCell[];
  rows: number;
  columns: number;
  selection: TableGridSelection;
  onSelect(selection: TableGridSelection): void;
  onCommit(cell: TableCellAddress, value: string): void;
  onClear(cells: TableCellAddress[]): void;
  onExit(): void;
  renderEditor(props: TableGridEditorProps): ReactNode;
  hitCell(x: number, y: number): TableCellAddress | null;
  editRequest?: number;
  style?: CSSProperties;
  children?: ReactNode;
}): JSX.Element {
  const id = useId(),
    root = useRef<HTMLDivElement>(null),
    editorHost = useRef<HTMLDivElement>(null);
  const drag = useRef<TableGridSelection | null>(null);
  const [editing, setEditing] = useState<{
    cell: TableCellAddress;
    value: string;
    original: string;
    forceCommit?: boolean;
  } | null>(null);
  const draft = useRef(editing);
  const latest = useRef({ onCommit, cells, selection });
  latest.current = { onCommit, cells, selection };
  const updateDraft = (value: typeof editing) => {
    draft.current = value;
    setEditing(value);
  };
  const commit = () => {
    const pending = draft.current;
    if (!pending) return;
    if (pending.value !== pending.original || pending.forceCommit) latest.current.onCommit(pending.cell, pending.value);
    updateDraft(null);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const ownerOf = (cell: TableCellAddress) => {
    const row = Math.max(0, Math.min(rows - 1, cell.row)),
      column = Math.max(0, Math.min(columns - 1, cell.column));
    return cells.find(
      (c) =>
        row >= c.row &&
        row < c.row + c.rowSpan &&
        column >= c.column &&
        column < c.column + c.columnSpan,
    )!;
  };
  const begin = (cell: TableCellAddress, value?: string) => {
    const owner = ownerOf(cell);
    updateDraft({ cell: owner, value: value ?? owner.text, original: owner.text });
  };
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (editRequest) begin(latest.current.selection.focus);
    // A host double-click requests editing even if the grid has just mounted.
  }, [editRequest]);
  useEffect(() => {
    const leaveEditor = (event: PointerEvent) => {
      if (event.target instanceof Node && !editorHost.current?.contains(event.target))
        commitRef.current();
    };
    // Commit before a parent changes selection/tool and removes the textarea.
    document.addEventListener('pointerdown', leaveEditor, true);
    return () => {
      document.removeEventListener('pointerdown', leaveEditor, true);
    };
  }, []);
  const range = tableGridRange(selection, rows, columns, cells),
    active = ownerOf(selection.focus);
  const cellId = (cell: TableCellAddress) => `${id}-${cell.row}-${cell.column}`;
  const navigate = (key: string, shift: boolean, keepEditing: boolean) => {
    const pending = draft.current;
    commit();
    const next = tableGridNextCell(cells, active, key, shift);
    onSelect({ anchor: shift && key.startsWith('Arrow') ? selection.anchor : next, focus: next });
    if (keepEditing) {
      if (pending && pending.cell.row === next.row && pending.cell.column === next.column)
        updateDraft({ ...pending, original: pending.value, forceCommit: false });
      else begin(next);
    } else root.current?.focus({ preventScroll: true });
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!draft.current && (event.ctrlKey || event.metaKey) && /^[zy]$/i.test(event.key)) return;
    // Cell navigation/typing must not trigger the host's move, erase or tool shortcuts.
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    const modified = event.ctrlKey || event.metaKey || event.altKey;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (
        !draft.current &&
        selection.anchor.row === selection.focus.row &&
        selection.anchor.column === selection.focus.column
      ) {
        onExit();
        return;
      }
      updateDraft(null);
      onSelect({ anchor: selection.focus, focus: selection.focus });
      root.current?.focus();
      return;
    }
    if (draft.current) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || event.altKey)) {
        event.preventDefault();
        const input = event.target as HTMLTextAreaElement;
        const start = input.selectionStart,
          end = input.selectionEnd;
        updateDraft({
          ...draft.current,
          value: draft.current.value.slice(0, start) + '\n' + draft.current.value.slice(end),
        });
        requestAnimationFrame(() => input.setSelectionRange(start + 1, start + 1));
      } else if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        navigate(event.key, event.shiftKey, true);
      }
      return;
    }
    if (!modified && (event.key.startsWith('Arrow') || event.key === 'Tab')) {
      event.preventDefault();
      navigate(event.key, event.shiftKey, false);
    } else if (!modified && (event.key === 'Enter' || event.key === 'F2')) {
      event.preventDefault();
      begin(selection.focus);
    } else if (!modified && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault();
      onClear(cells.filter((c) => tableGridCellSelected(c, range)));
    } else if (!modified && event.key.length === 1) {
      event.preventDefault();
      onSelect({ anchor: active, focus: active });
      begin(active, event.key);
    }
  };
  return (
    <div
      ref={root}
      role="grid"
      aria-label="Table cells on page"
      aria-rowcount={rows}
      aria-colcount={columns}
      aria-multiselectable="true"
      aria-activedescendant={cellId(active)}
      tabIndex={0}
      className="pf-table-grid"
      style={style}
      onKeyDown={keyDown}
      onDoubleClick={(event) => {
        if (editorHost.current?.contains(event.target as Node)) return;
        const cell = hitCell(event.clientX, event.clientY);
        if (cell) {
          event.preventDefault();
          begin(cell);
        }
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const focus = hitCell(event.clientX, event.clientY);
        if (focus) onSelect({ anchor: drag.current.anchor, focus });
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        if (drag.current) onSelect(drag.current);
        drag.current = null;
      }}
    >
      {Array.from({ length: rows }, (_, row) => (
        <div role="row" key={row} className="pf-table-grid-row">
          {cells
            .filter((c) => c.row === row)
            .map((cell) => (
              <div
                key={cellId(cell)}
                id={cellId(cell)}
                role="gridcell"
                aria-label={`Row ${cell.row + 1}, column ${cell.column + 1}${cell.text ? `: ${cell.text}` : ''}`}
                aria-rowindex={cell.row + 1}
                aria-colindex={cell.column + 1}
                aria-rowspan={cell.rowSpan}
                aria-colspan={cell.columnSpan}
                aria-selected={tableGridCellSelected(cell, range)}
                className={`pf-table-grid-cell${cell === active ? ' is-active' : ''}`}
                style={{ left: cell.left, top: cell.top, width: cell.width, height: cell.height }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  commit();
                  const next = { anchor: event.shiftKey ? selection.anchor : cell, focus: cell };
                  drag.current = next;
                  onSelect(next);
                  root.current?.focus({ preventScroll: true });
                  root.current?.setPointerCapture?.(event.pointerId);
                }}
              />
            ))}
        </div>
      ))}
      {children}
      <div ref={editorHost}>
        {editing
          ? renderEditor({
              cell: editing.cell,
              value: editing.value,
              onChange: (value, forceCommit) => {
                if (draft.current) updateDraft({ ...draft.current, value, ...(forceCommit ? { forceCommit } : {}) });
              },
              onBlur: commit,
            })
          : null}
      </div>
    </div>
  );
}
