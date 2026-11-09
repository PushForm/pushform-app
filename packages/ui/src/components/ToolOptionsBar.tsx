// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { parseVcb } from '@pushform/commands';
import type { ToolSetting, ToolSettingKey, ToolSettingValue, VcbValue } from '@pushform/commands';
import { typedLengthUnit } from '@pushform/core';
import { useApp } from '../AppContext';
import type { AppInstance } from '../bootstrap';
import { useAppStore } from '../store';
import { Icon } from './Icon';
import { useSelectionRefs } from '../hooks/useSelection';
import { ToolOptionsFields } from './ToolOptions';
import { ModelTextStyleRow } from './ModelTextStyleRow';
import { EntryFields } from './EntryFields';

/** How long the pointer rests over an empty part of the bar before it fades. */
const REST_MS = 150;

/** Class of the bar's root; `focusToolOptions` finds the bar through it. */
export const TOOL_OPTIONS_CLASS = 'pf-tob';

/** How far the bar has folded to fit: 0 full, 1 icon instead of name, 2 icon rows as lists, 3 low-priority controls in More. */
type Fold = 0 | 1 | 2 | 3;

/** What a workspace gives the bar: its tool, controls and how to read typed values. */
export interface ToolOptionsBarProps {
  /** The tool whose settings show (icon `tool-<id>`). */
  readonly tool: { readonly id: string; readonly title: string } | null;
  /** Its settings and mode toggles; none hides the bar. */
  readonly settings: readonly ToolSetting[];
  /** The tool is placing a point: the bar lets the pointer through. */
  readonly placing?: boolean | undefined;
  /** The bar shows the operation just committed. */
  readonly applied?: boolean | undefined;
  readonly mac: boolean;
  onSetting(id: string, value: ToolSettingValue): void;
  /** Read a bar field's text in the document's units. */
  read(quantity: 'length' | 'angle' | 'count', text: string): VcbValue | null;
  /** Give keyboard focus back to the view. */
  onLeave(): void;
  /**
   * Controls a workspace renders itself, after the tool's name, such as Layout's text formatting
   * while text is edited. The bar shows while there are any.
   */
  readonly children?: ReactNode;
}

/**
 * The tool options bar of the 3D modeler: the active tool's settings and mode toggles from the
 * ToolManager.
 */
export function ToolOptionsBar(): JSX.Element {
  const app = useApp();
  const settings = useAppStore((s) => s.toolSettings);
  const optionFields = useAppStore((s) => s.entryFields).filter(field => field.placement === 'options');
  const placing = useAppStore((s) => s.toolPlacing);
  const applied = useAppStore((s) => s.toolApplied);
  const activeToolId = useAppStore((s) => s.activeToolId);
  const dialog = useAppStore((s) => s.dialog);
  const dialogRef = useAppStore((s) => s.dialogRef);
  const selection = useSelectionRefs();
  const fields = useAppStore((s) => s.entryFields);
  const tool = app.toolManager.visualTool;
  // A model text's style row: for the text being edited, or one text selected with Select.
  const styled = dialog === 'editText' && dialogRef?.kind === 'text' ? dialogRef
    : activeToolId === 'select' && selection.length === 1 && selection[0]!.kind === 'text' ? selection[0]! : null;
  return (
    <ToolOptionsBarView
      tool={styled ? { id: 'text', title: 'Text' } : tool ? { id: tool.id, title: tool.title } : null}
      settings={styled ? [] : settings}
      placing={placing}
      applied={applied}
      mac={app.keymap.platform === 'mac'}
      onSetting={(id, value) => app.toolManager.setting(id, value)}
      read={(quantity, text) => readQuantity(app, quantity, text)}
      onLeave={() => app.viewport.container?.focus()}
    >
      {styled ? <ModelTextStyleRow app={app} target={styled} /> : <>
        {fields.some((f) => f.location === 'bar' && f.placement !== 'options') ? <EntryFields inline /> : null}
        {optionFields.length ? <ToolOptionsFields key={activeToolId} app={app} fields={optionFields} /> : null}
      </>}
    </ToolOptionsBarView>
  );
}

/**
 * The tool options bar, for either workspace: settings and mode toggles floating over the top of
 * the view. Hidden when there are none. Only its controls take the pointer; while the tool
 * is placing a point the whole bar lets it through.
 */
export function ToolOptionsBarView({ tool, settings, placing = false, applied: appliedIn = false, mac, onSetting, read, onLeave, children }: ToolOptionsBarProps): JSX.Element {
  const shown = settings.length > 0 || Boolean(children);
  const applied = appliedIn && shown;
  // keep the last controls while fading out
  const last = useRef<{ settings: readonly ToolSetting[]; title: string; id: string }>({ settings: [], title: '', id: '' });
  if (shown && tool) last.current = { settings, title: tool.title, id: tool.id };
  const content = shown ? children : null;
  const view = last.current;
  const root = useRef<HTMLDivElement>(null);
  const [fold, setFold] = useState<Fold>(0);
  const [resting, setResting] = useState(false);
  const [moreAt, setMoreAt] = useState<{ top: number; right: number } | null>(null);

  // Fold until the controls fit; start over when the bar or its controls change. Compared by
  // content, since a workspace may build a new but equal settings list on every render.
  const settingsKey = JSON.stringify(settings);
  useLayoutEffect(() => setFold(0), [settingsKey, view.id]);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const check = () => {
      if (el.scrollWidth > el.clientWidth + 1) setFold((f) => (f < 3 ? ((f + 1) as Fold) : f));
    };
    check();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => setFold(0));
    ro?.observe(el.parentElement ?? el);
    return () => ro?.disconnect();
  }, [fold, settingsKey, view.id]);

  // Fade after the pointer rests over an empty part of the bar.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const onMove = (e: PointerEvent) => {
      const el = root.current;
      if (!el || !shown) return;
      const r = el.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      const onControl = inside && Boolean((e.target as Element | null)?.closest?.('[data-tob-control]'));
      if (!inside || onControl) {
        clear();
        setResting(false);
        return;
      }
      if (!timer) timer = setTimeout(() => setResting(true), REST_MS);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      clear();
      window.removeEventListener('pointermove', onMove);
    };
  }, [shown]);

  const send = (id: string, value: ToolSettingValue, refocus = false) => {
    onSetting(id, value);
    if (refocus) onLeave();
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' || ((e.key === 'l' || e.key === 'L') && (mac ? e.metaKey : e.ctrlKey))) {
      e.preventDefault();
      e.stopPropagation();
      setMoreAt(null);
      onLeave();
    }
  };

  const visible = fold >= 3 ? view.settings.filter((c) => (c.priority ?? 1) < 2) : view.settings;
  const overflow = fold >= 3 ? view.settings.filter((c) => (c.priority ?? 1) >= 2) : [];
  const cls = [TOOL_OPTIONS_CLASS, shown ? 'is-shown' : '', applied ? 'is-applied' : '', placing ? 'is-placing' : '', resting && !placing ? 'is-resting' : ''].filter(Boolean).join(' ');
  return (
    <div ref={root} className={cls} role="toolbar" aria-label={`${view.title} options`} aria-hidden={!shown} onKeyDown={onKeyDown}>
      <span className="pf-tob-tool" title={view.title}>
        <Icon name={`tool-${view.id}`} size={16} />
        {applied ? <span aria-hidden="true">✓</span> : null}
        {fold < 1 ? <span>{applied ? `${view.title} applied` : view.title}</span> : null}
      </span>
      {content ? <span className="pf-tob-custom" data-tob-control>{content}</span> : null}
      {visible.map((c) => <Control key={c.id} read={read} c={c} mac={mac} asList={fold >= 2} send={send} />)}
      {applied && fold < 2 ? <span className="pf-tob-note">Changes redo the last operation · click to go on</span> : null}
      {overflow.length ? (
        <span className="pf-tob-more-wrap">
          <button
            type="button"
            className="pf-tob-more"
            data-tob-control
            aria-expanded={moreAt !== null}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMoreAt((at) => (at ? null : { top: r.bottom + 4, right: window.innerWidth - r.right }));
            }}
          >
            More
          </button>
          {moreAt ? (
            <span className="pf-tob-more-pop" role="group" aria-label="More options" style={moreAt}>
              {overflow.map((c) => <Control key={c.id} read={read} c={c} mac={mac} asList send={send} />)}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** The label printed on a toggle for its modifier tap: Ctrl and Alt, or Cmd and Option on macOS. */
export function keyLabel(key: ToolSettingKey, mac: boolean): string {
  return key === 'primary' ? (mac ? '⌘' : 'Ctrl') : mac ? '⌥' : 'Alt';
}

function Control({ read, c, mac, asList, send }: { read: ToolOptionsBarProps['read']; c: ToolSetting; mac: boolean; asList: boolean; send: (id: string, value: ToolSettingValue, refocus?: boolean) => void }): JSX.Element {
  switch (c.kind) {
    case 'choice': {
      const key = c.key ? <kbd className="pf-tob-key">{keyLabel(c.key, mac)}</kbd> : null;
      if (c.display === 'menu' || (asList && c.display === 'icons')) {
        return (
          <label className="pf-tob-item">
            <span className="pf-tob-label">{c.label}</span>
            <select data-tob-control value={c.value} onChange={(e) => send(c.id, e.target.value, true)}>
              {c.options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
            </select>
            {key}
          </label>
        );
      }
      const icons = c.display === 'icons';
      const picked = c.options.find((o) => o.value === c.value);
      return (
        <span className="pf-tob-item">
          <span className={`pf-tob-seg${icons ? ' is-icons' : ''}`} role="radiogroup" aria-label={c.label}>
            {c.options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                data-tob-control
                aria-checked={o.value === c.value}
                aria-label={o.label}
                title={o.disabled && o.reason ? `${o.label}: ${o.reason}` : o.label}
                disabled={o.disabled}
                onClick={() => send(c.id, o.value, true)}
              >
                {icons ? <Icon name={o.icon ?? o.value} size={18} /> : o.label}
              </button>
            ))}
          </span>
          {icons && picked ? <span className="pf-tob-label">{picked.label}</span> : null}
          {key}
        </span>
      );
    }
    case 'quantity':
      return <QuantityField read={read} c={c} send={send} />;
    case 'toggle':
      return (
        <button type="button" className="pf-tob-toggle" data-tob-control aria-pressed={c.on} onClick={() => send(c.id, !c.on, true)}>
          <span className="pf-tob-check" aria-hidden="true" />
          {c.label}
          {c.key ? <kbd className="pf-tob-key">{keyLabel(c.key, mac)}</kbd> : null}
        </button>
      );
    case 'action':
      return (
        <button type="button" className={`pf-tob-action${c.primary ? ' is-primary' : ''}`} data-tob-control disabled={c.disabled} onClick={() => send(c.id, undefined, true)}>
          {c.label}
        </button>
      );
    case 'note':
      return <span className="pf-tob-note">{c.text}</span>;
  }
}

function QuantityField({ read, c, send }: { read: ToolOptionsBarProps['read']; c: Extract<ToolSetting, { kind: 'quantity' }>; send: (id: string, value: ToolSettingValue, refocus?: boolean) => void }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const commit = (refocus: boolean) => {
    if (draft === null) return;
    const value = read(c.quantity, draft);
    if (value === null) {
      setError(true);
      return;
    }
    setDraft(null);
    setError(false);
    send(c.id, value, refocus);
  };
  return (
    <label className="pf-tob-item">
      <span className="pf-tob-label">{c.label}</span>
      <input
        data-tob-control
        className={`pf-tob-input${error ? ' is-error' : ''}`}
        value={draft ?? c.value}
        disabled={c.disabled}
        size={Math.max(4, (draft ?? c.value).length + 1)}
        aria-invalid={error || undefined}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(true);
          } else if (e.key === 'Escape' && draft !== null) {
            e.stopPropagation();
            setDraft(null);
            setError(false);
          }
        }}
        onBlur={() => commit(false)}
      />
    </label>
  );
}

/** Read a bar field: a whole count, an angle in degrees (with or without °), or a length in the document's units. */
export function readQuantity(app: AppInstance, quantity: 'length' | 'angle' | 'count', text: string): VcbValue | null {
  const t = text.trim();
  if (!t) return null;
  if (quantity === 'count') {
    const m = /^(\d+)\s*s?$/i.exec(t);
    return m ? { kind: 'segments', count: Number(m[1]) } : null;
  }
  const r = parseVcb(t, typedLengthUnit(app.document.doc.state.meta.units));
  if (!r.ok) return null;
  const v = r.value;
  if (quantity === 'angle') {
    if (v.kind === 'angle' || v.kind === 'slope') return v;
    return v.kind === 'length' && v.unit === null ? { kind: 'angle', degrees: v.raw } : null;
  }
  return v.kind === 'length' || v.kind === 'radius' ? v : null;
}
