// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { formatAngleDeg, parseLength, typedLengthUnit, type UnitSettings } from '@pushform/core';
import type { UiEvent, UiNode, UiNodeOf, UiQuantity, UiTable, UiTreeItem } from '@pushform/extension-protocol';
import type { ExtensionUiHost } from '@pushform/extensions';
import { formatArea, formatLength, formatVolume } from '../engine/format';

/**
 * Renders an extension's interface tree with the editor's own components. Nothing in the tree reaches the DOM except
 * as text content or as values of fixed, host-chosen attributes; there is no markup, style or event handler from the
 * extension. Input is reported through `onEvent`; the extension answers by sending a new tree. Text and number fields
 * keep the user's typing locally and report it when committed (Enter or leaving the field), so each keystroke does
 * not round-trip through the extension.
 */

export interface ExtensionUiProps {
  readonly tree: UiNode;
  readonly units: UnitSettings;
  readonly onEvent: (event: UiEvent) => void;
}

export function ExtensionUiView({ tree, units, onEvent }: ExtensionUiProps): JSX.Element {
  return <div className="pf-xui"><Node node={tree} units={units} onEvent={onEvent} /></div>;
}

/** The interface an extension mounted for `target`, kept current as the extension updates it. */
export function ExtensionTarget({ host, target, units, empty }: {
  readonly host: ExtensionUiHost;
  readonly target: string;
  readonly units: UnitSettings;
  readonly empty?: ReactNode;
}): JSX.Element | null {
  const shown = useSyncExternalStore(
    (notify) => host.subscribe((changed) => { if (changed === target) notify(); }),
    () => host.get(target),
  );
  if (!shown) return <>{empty ?? null}</>;
  return <ExtensionUiView tree={shown.tree} units={units} onEvent={(event) => host.dispatch(target, event)} />;
}

interface NodeProps<T extends UiNode = UiNode> {
  readonly node: T;
  readonly units: UnitSettings;
  readonly onEvent: (event: UiEvent) => void;
}

function Node({ node, units, onEvent }: NodeProps): JSX.Element | null {
  switch (node.type) {
    case 'stack':
      return (
        <div className={`pf-xui-stack is-${node.direction ?? 'vertical'} gap-${node.gap ?? 'medium'} align-${node.align ?? 'stretch'}`}>
          {node.children.map((child) => <Node key={child.id} node={child} units={units} onEvent={onEvent} />)}
        </div>
      );
    case 'divider':
      return <hr className="pf-xui-divider" />;
    case 'text': {
      const className = `pf-xui-text tone-${node.tone ?? 'default'}`;
      switch (node.variant) {
        case 'heading': return <h3 className={className}>{node.text}</h3>;
        case 'subheading': return <h4 className={className}>{node.text}</h4>;
        case 'caption': return <p className={`${className} is-caption`}>{node.text}</p>;
        case 'code': return <pre className={`${className} is-code`}>{node.text}</pre>;
        default: return <p className={className}>{node.text}</p>;
      }
    }
    case 'message':
      return <p className={`pf-xui-message tone-${node.tone}`} role={node.tone === 'error' ? 'alert' : 'status'}>{node.text}</p>;
    case 'progress':
      return (
        <div className="pf-xui-progress">
          <span className="pf-xui-label">{node.label}</span>
          <progress aria-label={node.label} {...(node.value === null ? {} : { value: node.value, max: 1 })} />
        </div>
      );
    case 'button':
      return (
        <button type="button" className={`pf-btn pf-xui-button is-${node.variant ?? 'secondary'}`} disabled={node.disabled}
          onClick={() => onEvent({ component: node.id, event: 'press' })}>{node.label}</button>
      );
    case 'textField':
      return <TextField node={node} units={units} onEvent={onEvent} />;
    case 'numberField':
      return <NumberField node={node} units={units} onEvent={onEvent} />;
    case 'checkbox':
      return (
        <label className="pf-xui-check">
          <input type="checkbox" checked={node.checked} disabled={node.disabled}
            onChange={(e) => onEvent({ component: node.id, event: 'change', value: e.target.checked })} />
          <span>{node.label}</span>
        </label>
      );
    case 'choice':
      return <ChoiceField node={node} onEvent={onEvent} />;
    case 'colorField':
      return <Field label={node.label}>{(id) => (
        <input id={id} type="color" className="pf-xui-color" value={node.value} disabled={node.disabled}
          onChange={(e) => onEvent({ component: node.id, event: 'change', value: e.target.value })} />
      )}</Field>;
    case 'tabs':
      return <Tabs node={node} units={units} onEvent={onEvent} />;
    case 'tree':
      return <TreeView node={node} onEvent={onEvent} />;
    case 'table':
      return <Table node={node} units={units} onEvent={onEvent} />;
  }
}

function Field({ label, error, children }: { label: string; error?: string | undefined; children: (id: string, errorId: string | undefined) => ReactNode }): JSX.Element {
  const id = useId();
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="pf-xui-field">
      <label className="pf-xui-label" htmlFor={id}>{label}</label>
      {children(id, errorId)}
      {error ? <span id={errorId} className="pf-xui-error">{error}</span> : null}
    </div>
  );
}

/** Keeps a draft while the user edits, starting from `value` and following it while not editing. */
function useDraft(value: string): [string, (next: string) => void, boolean, (editing: boolean) => void] {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  return [draft, setDraft, editing, setEditing];
}

function TextField({ node, onEvent }: NodeProps<UiNodeOf<'textField'>>): JSX.Element {
  const [draft, setDraft, , setEditing] = useDraft(node.value);
  const commit = () => {
    setEditing(false);
    if (draft !== node.value) onEvent({ component: node.id, event: 'change', value: draft });
  };
  const common = {
    value: draft, disabled: node.disabled, placeholder: node.placeholder, maxLength: node.maxLength,
    onFocus: () => setEditing(true), onBlur: commit,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
  };
  return <Field label={node.label} error={node.error}>{(id, errorId) => node.multiline
    ? <textarea id={id} className="pf-xui-input" rows={3} aria-invalid={node.error ? true : undefined} aria-describedby={errorId} {...common} />
    : <input id={id} className="pf-xui-input" aria-invalid={node.error ? true : undefined} aria-describedby={errorId} {...common}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />}
  </Field>;
}

/** A number as the document shows it: lengths, areas and volumes in its units, angles in degrees. */
export function formatQuantity(value: number, quantity: UiQuantity | undefined, units: UnitSettings): string {
  switch (quantity) {
    case 'length': return formatLength(value, units);
    case 'area': return formatArea(value, units);
    case 'volume': return formatVolume(value, units);
    case 'angle': return formatAngleDeg(value, units.anglePrecision);
    case 'percent': return `${Number((value * 100).toFixed(2))} %`;
    case 'count': return String(Math.round(value));
    default: return String(Number(value.toPrecision(12)));
  }
}

/** Reads what the user typed as a number of `quantity`, or `null` when it is not one. Lengths accept any unit. */
export function parseQuantity(input: string, quantity: UiQuantity | undefined, units: UnitSettings): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  if (quantity === 'length') return parseLength(trimmed, typedLengthUnit(units));
  const number = Number(trimmed.replace(/[^0-9eE+\-.]/g, ''));
  if (!Number.isFinite(number) || !/[0-9]/.test(trimmed)) return null;
  return quantity === 'percent' ? number / 100 : number;
}

function NumberField({ node, units, onEvent }: NodeProps<UiNodeOf<'numberField'>>): JSX.Element {
  const shown = node.value === null ? '' : formatQuantity(node.value, node.quantity, units);
  const [draft, setDraft, , setEditing] = useDraft(shown);
  const [problem, setProblem] = useState<string | null>(null);
  const commit = () => {
    setEditing(false);
    if (draft === shown) { setProblem(null); return; }
    const value = parseQuantity(draft, node.quantity, units);
    if (draft.trim() !== '' && value === null) { setProblem('Enter a number.'); return; }
    if (value !== null && node.integer && !Number.isInteger(value)) { setProblem('Enter a whole number.'); return; }
    if (value !== null && node.min !== undefined && value < node.min) { setProblem(`The smallest value is ${formatQuantity(node.min, node.quantity, units)}.`); return; }
    if (value !== null && node.max !== undefined && value > node.max) { setProblem(`The largest value is ${formatQuantity(node.max, node.quantity, units)}.`); return; }
    setProblem(null);
    onEvent({ component: node.id, event: 'change', value });
  };
  const error = problem ?? node.error;
  return <Field label={node.label} error={error}>{(id, errorId) => (
    <input id={id} className="pf-xui-input is-number" inputMode="decimal" value={draft} disabled={node.disabled}
      aria-invalid={error ? true : undefined} aria-describedby={errorId}
      onFocus={() => setEditing(true)} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(shown); setProblem(null); } }} />
  )}</Field>;
}

function ChoiceField({ node, onEvent }: Omit<NodeProps<UiNodeOf<'choice'>>, 'units'>): JSX.Element {
  return <Field label={node.label}>{(id) => (
    <select id={id} className="pf-xui-select" value={node.value ?? ''} disabled={node.disabled}
      onChange={(e) => onEvent({ component: node.id, event: 'change', value: e.target.value === '' ? null : e.target.value })}>
      {node.value === null ? <option value="">—</option> : null}
      {node.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )}</Field>;
}

function Tabs({ node, units, onEvent }: NodeProps<UiNodeOf<'tabs'>>): JSX.Element {
  const base = useId();
  const index = Math.max(0, node.tabs.findIndex((t) => t.id === node.selected));
  const move = (e: KeyboardEvent, i: number) => {
    const next = e.key === 'ArrowRight' ? (i + 1) % node.tabs.length : e.key === 'ArrowLeft' ? (i - 1 + node.tabs.length) % node.tabs.length : -1;
    if (next < 0) return;
    e.preventDefault();
    onEvent({ component: node.id, event: 'select', value: node.tabs[next]!.id });
    document.getElementById(`${base}-tab-${next}`)?.focus();
  };
  const panel = node.children[index];
  return (
    <div className="pf-xui-tabs">
      <div className="pf-tabs" role="tablist" aria-label={node.label}>
        {node.tabs.map((tab, i) => (
          <button key={tab.id} id={`${base}-tab-${i}`} type="button" role="tab" className={`pf-tab${i === index ? ' is-active' : ''}`}
            aria-selected={i === index} aria-controls={`${base}-panel`} tabIndex={i === index ? 0 : -1}
            onClick={() => onEvent({ component: node.id, event: 'select', value: tab.id })} onKeyDown={(e) => move(e, i)}>
            {tab.label}
          </button>
        ))}
      </div>
      <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-tab-${index}`} className="pf-xui-tabpanel">
        {panel ? <Node node={panel} units={units} onEvent={onEvent} /> : null}
      </div>
    </div>
  );
}

function TreeView({ node, onEvent }: Omit<NodeProps<UiNodeOf<'tree'>>, 'units'>): JSX.Element {
  const expanded = new Set(node.expanded ?? []);
  const render = (items: readonly UiTreeItem[], level: number): JSX.Element[] => items.map((item) => {
    const open = expanded.has(item.id);
    const branch = (item.children?.length ?? 0) > 0;
    return (
      <li key={item.id} role="treeitem" aria-level={level} aria-selected={node.selected === item.id}
        {...(branch ? { 'aria-expanded': open } : {})}>
        <div className={`pf-xui-tree-row${node.selected === item.id ? ' is-selected' : ''}`} style={{ paddingInlineStart: `${(level - 1) * 14}px` }}>
          {branch
            ? <button type="button" className="pf-xui-tree-toggle" aria-label={open ? `Collapse ${item.label}` : `Expand ${item.label}`}
                onClick={() => onEvent({ component: node.id, event: 'toggle', item: item.id, expanded: !open })}>{open ? '▾' : '▸'}</button>
            : <span className="pf-xui-tree-toggle" aria-hidden="true" />}
          <button type="button" className="pf-xui-tree-label" onClick={() => onEvent({ component: node.id, event: 'select', value: item.id })}>
            {item.label}
          </button>
        </div>
        {branch && open ? <ul role="group">{render(item.children!, level + 1)}</ul> : null}
      </li>
    );
  });
  return <ul className="pf-xui-tree" role="tree" aria-label={node.label}>{render(node.items, 1)}</ul>;
}

/** Height of one table row in pixels, fixed so that only the rows in view need rendering. */
export const TABLE_ROW_PX = 26;
const TABLE_VIEW_PX = 360;
const OVERSCAN = 8;

function Table({ node, units, onEvent }: NodeProps<UiTable>): JSX.Element {
  const hidden = new Set(node.hiddenColumns ?? []);
  const columns = node.columns.filter((c) => !hidden.has(c.id));
  const selected = useMemo(() => new Set(node.selected ?? []), [node.selected]);
  const [scrollTop, setScrollTop] = useState(0);
  const [editing, setEditing] = useState<{ row: string; column: string } | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const first = Math.max(0, Math.floor(scrollTop / TABLE_ROW_PX) - OVERSCAN);
  const last = Math.min(node.rows.length, Math.ceil((scrollTop + TABLE_VIEW_PX) / TABLE_ROW_PX) + OVERSCAN);
  const hideable = node.columns.filter((c) => c.hideable);

  const select = (row: string, additive: boolean) => {
    if (node.selection === undefined || node.selection === 'none') return;
    const rows = node.selection === 'multiple' && additive
      ? (selected.has(row) ? [...selected].filter((r) => r !== row) : [...selected, row])
      : [row];
    onEvent({ component: node.id, event: 'rowSelect', rows });
  };
  const sortBy = (column: string) => {
    const direction = node.sort?.column === column && node.sort.direction === 'ascending' ? 'descending' : 'ascending';
    onEvent({ component: node.id, event: 'sort', column, direction });
  };

  return (
    <div className="pf-xui-table-wrap">
      <div className="pf-xui-table-bar">
        <span className="pf-xui-label">{node.label}</span>
        {hideable.length ? (
          <div className="pf-xui-columns">
            <button type="button" className="pf-btn" aria-expanded={columnsOpen} onClick={() => setColumnsOpen(!columnsOpen)}>Columns</button>
            {columnsOpen ? (
              <fieldset className="pf-xui-columns-menu">
                <legend className="pf-xui-label">Shown columns</legend>
                {hideable.map((c) => (
                  <label key={c.id} className="pf-xui-check">
                    <input type="checkbox" checked={!hidden.has(c.id)} onChange={(e) => onEvent({ component: node.id, event: 'columns',
                      hidden: e.target.checked ? [...hidden].filter((h) => h !== c.id) : [...hidden, c.id] })} />
                    <span>{c.label}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}
          </div>
        ) : null}
      </div>
      <div ref={scroller} className="pf-xui-table-scroll" style={{ maxHeight: TABLE_VIEW_PX }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <table className="pf-xui-table" role="grid" aria-label={node.label} aria-rowcount={node.rows.length + 1}
          aria-multiselectable={node.selection === 'multiple' ? true : undefined}>
          <thead>
            <tr aria-rowindex={1}>
              {columns.map((c) => {
                const sorted = node.sort?.column === c.id ? node.sort.direction : undefined;
                return (
                  <th key={c.id} scope="col" className={c.align === 'end' || c.kind === 'number' ? 'is-end' : undefined}
                    aria-sort={sorted ?? (c.sortable ? 'none' : undefined)}>
                    {c.sortable
                      ? <button type="button" className="pf-xui-sort" onClick={() => sortBy(c.id)}>
                          {c.label}{sorted ? <span aria-hidden="true">{sorted === 'ascending' ? ' ▲' : ' ▼'}</span> : null}
                        </button>
                      : c.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {first > 0 ? <tr aria-hidden="true" style={{ height: first * TABLE_ROW_PX }} /> : null}
            {node.rows.slice(first, last).map((row, offset) => {
              const index = first + offset;
              if (row.heading !== undefined)
                return <tr key={row.id} className="pf-xui-table-heading" aria-rowindex={index + 2} style={{ height: TABLE_ROW_PX }}>
                  <th colSpan={columns.length} scope="colgroup">{row.heading}</th>
                </tr>;
              const isSelected = selected.has(row.id);
              return (
                <tr key={row.id} aria-rowindex={index + 2} aria-selected={node.selection && node.selection !== 'none' ? isSelected : undefined}
                  className={isSelected ? 'is-selected' : undefined} style={{ height: TABLE_ROW_PX }}
                  onClick={(e) => select(row.id, e.metaKey || e.ctrlKey)}>
                  {columns.map((c) => (
                    <Cell key={c.id} table={node} column={c} rowId={row.id} value={row.cells[c.id] ?? null} error={row.errors?.[c.id]}
                      units={units} editing={editing?.row === row.id && editing.column === c.id}
                      startEdit={() => c.editable && setEditing({ row: row.id, column: c.id })}
                      stopEdit={() => { setEditing(null); scroller.current?.focus(); }} onEvent={onEvent} />
                  ))}
                </tr>
              );
            })}
            {last < node.rows.length ? <tr aria-hidden="true" style={{ height: (node.rows.length - last) * TABLE_ROW_PX }} /> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Column = UiTable['columns'][number];
type CellValue = string | number | boolean | null;

function Cell({ table, column, rowId, value, error, units, editing, startEdit, stopEdit, onEvent }: {
  table: UiTable; column: Column; rowId: string; value: CellValue; error: string | undefined; units: UnitSettings;
  editing: boolean; startEdit: () => void; stopEdit: () => void; onEvent: (event: UiEvent) => void;
}): JSX.Element {
  const edit = (next: CellValue) => onEvent({ component: table.id, event: 'cellEdit', row: rowId, column: column.id, value: next });
  const className = [column.align === 'end' || column.kind === 'number' ? 'is-end' : '', error ? 'is-invalid' : '', column.editable ? 'is-editable' : '']
    .filter(Boolean).join(' ') || undefined;
  const label = `${column.label}${error ? `: ${error}` : ''}`;
  if (column.kind === 'boolean')
    return <td className={className} title={error}>
      <input type="checkbox" aria-label={label} checked={value === true} disabled={!column.editable} aria-invalid={error ? true : undefined}
        onClick={(e) => e.stopPropagation()} onChange={(e) => edit(e.target.checked)} />
    </td>;
  const shown = value === null ? '' : column.kind === 'number' ? formatQuantity(value as number, column.quantity, units)
    : column.kind === 'choice' ? column.options?.find((o) => o.value === value)?.label ?? String(value) : String(value);
  if (editing && column.kind === 'choice')
    return <td className={className}>
      <select autoFocus aria-label={column.label} defaultValue={typeof value === 'string' ? value : ''} onBlur={stopEdit}
        onChange={(e) => { edit(e.target.value); stopEdit(); }} onKeyDown={(e) => { if (e.key === 'Escape') stopEdit(); }}>
        {(column.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </td>;
  if (editing)
    return <td className={className}>
      <CellInput initial={shown} label={column.label} onCancel={stopEdit} onCommit={(text) => {
        if (column.kind === 'number') {
          const parsed = parseQuantity(text, column.quantity, units);
          if (text.trim() !== '' && parsed === null) return false;
          edit(parsed);
        } else edit(text);
        stopEdit();
        return true;
      }} />
    </td>;
  return (
    <td className={className} title={error} aria-invalid={error ? true : undefined} tabIndex={column.editable ? 0 : undefined}
      aria-label={column.editable ? `${label}, ${shown || 'empty'}, editable` : undefined}
      onDoubleClick={startEdit} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); startEdit(); } }}>
      {shown}
    </td>
  );
}

function CellInput({ initial, label, onCommit, onCancel }: { initial: string; label: string; onCommit: (text: string) => boolean; onCancel: () => void }): JSX.Element {
  const [text, setText] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  return <input autoFocus className="pf-xui-cell-input" aria-label={label} aria-invalid={invalid ? true : undefined} value={text}
    onChange={(e) => { setText(e.target.value); setInvalid(false); }}
    onClick={(e) => e.stopPropagation()}
    onKeyDown={(e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (!onCommit(text)) setInvalid(true); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    }}
    onBlur={() => { if (!onCommit(text)) onCancel(); }} />;
}
