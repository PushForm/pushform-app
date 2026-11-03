// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { formatAngleDeg, parseLength, typedLengthUnit, type UnitSettings } from '@pushform/core';
import type { UiEvent, UiIcon, UiNode, UiNodeOf, UiQuantity, UiTable, UiTreeItem } from '@pushform/extension-protocol';
import { Icon } from '../components/Icon';
import { formatArea, formatLength, formatVolume } from '../engine/format';
import { VectorView } from './VectorView';

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

/** The host's icon for each icon name an extension may use. Only these names reach the icon component. */
export const UI_ICON_NAMES: Readonly<Record<UiIcon, string>> = {
  add: 'plus', remove: 'minus', delete: 'page-delete', edit: 'page-rename', copy: 'page-duplicate', save: 'save', print: 'print',
  download: 'download', upload: 'upload', search: 'search', filter: 'filter', refresh: 'refresh', settings: 'settings', help: 'help',
  info: 'panel-entityInfo', warning: 'warning', check: 'check', close: 'close', more: 'more', menu: 'menu', expand: 'chevron-down',
  collapse: 'chevron-up', up: 'page-up', down: 'page-down', show: 'eye', hide: 'eye-off', lock: 'lock', unlock: 'unlock', undo: 'undo',
  redo: 'redo', folder: 'folder', document: 'layer-page', tag: 'tool-tag', tags: 'panel-tags', palette: 'panel-styles', box: 'outliner-group',
  component: 'outliner-component', table: 'tool-table', ruler: 'tool-dimension', 'saw-blade': 'saw-blade',
};

function UiIconGlyph({ icon }: { icon: UiIcon }): JSX.Element {
  return <span className="pf-xui-icon" aria-hidden="true"><Icon name={UI_ICON_NAMES[icon]} size={14} /></span>;
}

/** A button's contents: its icon, if any, and its label unless the button shows only the icon. */
function ButtonFace({ label, icon, iconOnly }: { label: string; icon: UiIcon | undefined; iconOnly: boolean }): JSX.Element {
  return <>{icon ? <UiIconGlyph icon={icon} /> : null}{iconOnly ? null : <span>{label}</span>}</>;
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
    case 'button': {
      const iconOnly = node.variant === 'icon';
      return (
        <button type="button" className={`pf-btn pf-xui-button is-${node.variant ?? 'secondary'}`} disabled={node.disabled}
          {...(iconOnly ? { 'aria-label': node.label, title: node.label } : {})}
          onClick={() => onEvent({ component: node.id, event: 'press' })}>
          <ButtonFace label={node.label} icon={node.icon} iconOnly={iconOnly} />
        </button>
      );
    }
    case 'section':
      return <Section node={node} units={units} onEvent={onEvent} />;
    case 'menu':
      return <Menu node={node} onEvent={onEvent} />;
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
    case 'vector':
      return <VectorView node={node} onEvent={onEvent} />;
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
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape' && (draft !== shown || problem)) { e.preventDefault(); setDraft(shown); setProblem(null); } }} />
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

/**
 * A disclosure. The header button reports the state the user asked for and the extension sends the tree back with
 * `collapsed` set; header actions are buttons of their own, so they do not toggle the section.
 */
function Section({ node, units, onEvent }: NodeProps<UiNodeOf<'section'>>): JSX.Element {
  const base = useId();
  const open = !node.collapsed;
  return (
    <section className={`pf-xui-section${open ? ' is-open' : ''}`} aria-labelledby={`${base}-title`}>
      <div className="pf-xui-section-head">
        <button type="button" className="pf-xui-section-toggle" aria-expanded={open} aria-controls={`${base}-body`}
          aria-labelledby={`${base}-title`} aria-describedby={node.subtitle || node.badge ? `${base}-detail` : undefined}
          onClick={() => onEvent({ component: node.id, event: 'collapse', collapsed: open })}>
          <span className="pf-xui-section-chevron" aria-hidden="true"><Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} /></span>
          <span id={`${base}-title`} className="pf-xui-section-title">{node.title}</span>
          {node.subtitle || node.badge ? (
            <span id={`${base}-detail`} className="pf-xui-section-detail">
              {node.badge ? <span className="pf-xui-section-badge">{node.badge}</span> : null}
              {node.subtitle ? <span className="pf-xui-section-subtitle">{node.subtitle}</span> : null}
            </span>
          ) : null}
        </button>
        {node.actions?.length ? (
          <div className="pf-xui-section-actions" role="group" aria-label={`${node.title} actions`}>
            {node.actions.map((action) => (
              <button key={action.id} type="button" className={`pf-btn pf-xui-button is-${action.icon ? 'icon' : 'secondary'} is-action`} disabled={action.disabled}
                {...(action.icon ? { 'aria-label': action.label, title: action.label } : {})}
                onClick={() => onEvent({ component: node.id, event: 'press', action: action.id })}>
                <ButtonFace label={action.label} icon={action.icon} iconOnly={action.icon !== undefined} />
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {open ? (
        <div id={`${base}-body`} className="pf-xui-section-body">
          {node.children.map((child) => <Node key={child.id} node={child} units={units} onEvent={onEvent} />)}
        </div>
      ) : null}
    </section>
  );
}

/**
 * A dropdown menu drawn by the host. The button opens it (a click, Enter, Space or an arrow key) with focus on the
 * first item; arrows move through the enabled items and wrap, Home and End jump, Escape or Tab closes and returns
 * focus to the button, and so does choosing an item, which is reported as `select`. A click elsewhere closes it.
 */
function Menu({ node, onEvent }: Omit<NodeProps<UiNodeOf<'menu'>>, 'units'>): JSX.Element {
  const base = useId();
  const [open, setOpen] = useState(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const enabled = node.items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0);
  const iconOnly = node.variant === 'icon';

  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const focusItem = (index: number): void => { document.getElementById(`${base}-item-${index}`)?.focus(); };
  const openAt = (index: number): void => { setOpen(true); setTimeout(() => focusItem(index), 0); };

  useLayoutEffect(() => {
    if (!open || !list.current) return;
    // A menu near the right edge opens leftwards rather than running out of the panel.
    const rect = list.current.getBoundingClientRect();
    setAlignEnd(rect.right > (document.documentElement.clientWidth || window.innerWidth) - 4);
    focusItem(enabled[0] ?? 0);
    const outside = (e: PointerEvent): void => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
    // Only opening positions the list and moves focus.
  }, [open]);

  const buttonKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (node.disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openAt(e.key === 'ArrowDown' ? enabled[0] ?? 0 : enabled[enabled.length - 1] ?? 0); }
  };
  const itemKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const current = Number((e.target as HTMLElement).id.replace(`${base}-item-`, ''));
    const at = enabled.indexOf(current);
    const step = (delta: number): void => { if (enabled.length) focusItem(enabled[(Math.max(at, 0) + delta + enabled.length) % enabled.length]!); };
    switch (e.key) {
      case 'ArrowDown': step(at < 0 ? 0 : 1); break;
      case 'ArrowUp': step(at < 0 ? 0 : -1); break;
      case 'Home': if (enabled.length) focusItem(enabled[0]!); break;
      case 'End': if (enabled.length) focusItem(enabled[enabled.length - 1]!); break;
      case 'Escape': close(true); break;
      case 'Tab': close(true); return;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const choose = (id: string): void => {
    close(true);
    onEvent({ component: node.id, event: 'select', value: id });
  };

  return (
    <div ref={wrap} className="pf-xui-menu">
      <button ref={button} type="button" id={`${base}-button`} className={`pf-btn pf-xui-button is-${iconOnly ? 'icon' : 'secondary'}`}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${base}-list` : undefined} disabled={node.disabled}
        {...(iconOnly ? { 'aria-label': node.label, title: node.label } : {})}
        onClick={() => (open ? close(false) : openAt(enabled[0] ?? 0))} onKeyDown={buttonKey}>
        <ButtonFace label={node.label} icon={node.icon} iconOnly={iconOnly} />
        {iconOnly ? null : <span className="pf-xui-menu-caret" aria-hidden="true"><Icon name="chevron-down" size={12} /></span>}
      </button>
      {open ? (
        <div ref={list} id={`${base}-list`} className={`pf-xui-menu-list${alignEnd ? ' is-end' : ''}`} role="menu" aria-labelledby={`${base}-button`} onKeyDown={itemKey}>
          {node.items.map((item, i) => (
            <div key={item.id} className={item.separator ? 'has-separator' : undefined}>
              <button type="button" id={`${base}-item-${i}`} role="menuitem" className="pf-xui-menu-item" tabIndex={-1}
                disabled={item.disabled} aria-disabled={item.disabled ? true : undefined} onClick={() => choose(item.id)}>
                {item.label}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Tabs({ node, units, onEvent }: NodeProps<UiNodeOf<'tabs'>>): JSX.Element {
  const base = useId();
  const index = Math.max(0, node.tabs.findIndex((t) => t.id === node.selected));
  const count = node.tabs.length;
  const move = (e: KeyboardEvent, i: number) => {
    const next = e.key === 'ArrowRight' ? (i + 1) % count : e.key === 'ArrowLeft' ? (i - 1 + count) % count
      : e.key === 'Home' ? 0 : e.key === 'End' ? count - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onEvent({ component: node.id, event: 'select', value: node.tabs[next]!.id });
    document.getElementById(`${base}-tab-${next}`)?.focus();
  };
  const panel = node.children[index];
  return (
    <div className="pf-xui-tabs">
      {/* The tabs wrap onto more rows rather than running out of a narrow panel. */}
      <div className="pf-tabs pf-xui-tablist" role="tablist" aria-label={node.label}>
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
/** The rows' viewport before it is measured; the stylesheet sets its real maximum height. */
const TABLE_VIEW_PX = 360;
const OVERSCAN = 8;
/** Room kept below the last row for a scrollbar the browser draws over the content rather than beside it. */
export const OVERLAY_SCROLLBAR_PX = 14;

/**
 * The height of the rows' viewport (without the header or a scrollbar), and whether a horizontal scrollbar would be
 * drawn over the last row, so the table keeps room for it.
 */
function useTableViewport(scroller: RefObject<HTMLDivElement | null>, deps: readonly unknown[]): { view: number; overlayBar: boolean } {
  const [measured, setMeasured] = useState({ view: TABLE_VIEW_PX, overlayBar: false });
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = (): void => {
      const style = getComputedStyle(element);
      const borders = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      const wide = element.scrollWidth > element.clientWidth + 1;
      // A scrollbar beside the content takes height from the box; one drawn over it takes none.
      const overlayBar = wide && element.offsetHeight > 0 && element.offsetHeight - borders - element.clientHeight < 1;
      const view = element.clientHeight > 0 ? Math.max(TABLE_ROW_PX, element.clientHeight - TABLE_ROW_PX) : TABLE_VIEW_PX;
      setMeasured((m) => (m.view === view && m.overlayBar === overlayBar ? m : { view, overlayBar }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
    // The rows and columns shown change what overflows.
  }, deps);
  return measured;
}

function Table({ node, units, onEvent }: NodeProps<UiTable>): JSX.Element {
  const hidden = new Set(node.hiddenColumns ?? []);
  const columns = node.columns.filter((c) => !hidden.has(c.id));
  const selected = useMemo(() => new Set(node.selected ?? []), [node.selected]);
  const [scrollTop, setScrollTop] = useState(0);
  const [editing, setEditing] = useState<{ row: string; column: string } | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const { view, overlayBar } = useTableViewport(scroller, [node.rows.length, columns.length]);
  const first = Math.max(0, Math.floor(scrollTop / TABLE_ROW_PX) - OVERSCAN);
  const last = Math.min(node.rows.length, Math.ceil((scrollTop + view) / TABLE_ROW_PX) + OVERSCAN);
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
      <div ref={scroller} className={`pf-xui-table-scroll${overlayBar ? ' has-overlay-scrollbar' : ''}`}
        style={overlayBar ? { paddingBottom: OVERLAY_SCROLLBAR_PX } : undefined} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
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
