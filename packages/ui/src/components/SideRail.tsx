// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, Ref } from 'react';
import { ToolButton } from './ToolButton';

export interface SideRailItem {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly ref?: Ref<HTMLButtonElement> | undefined;
}

/** The left menu bar of both editors, mirroring the right-hand strip: one toggle icon per docked side panel. */
export function SideRail({ items, active, onToggle }: {
  items: readonly SideRailItem[];
  active: string | null;
  onToggle: (id: string) => void;
}): JSX.Element {
  return <nav className="pf-side-rail" aria-label="Left menu bar" data-orientation="vertical">
    {items.map(item => <ToolButton key={item.id} data-guidance-id={`sidebar:${item.id}`} ref={item.ref} type="button" className={`pf-toolbtn pf-side-rail-button${active === item.id ? ' is-active' : ''}`}
      aria-label={item.label} title={item.label} aria-pressed={active === item.id} onClick={() => onToggle(item.id)}>{item.icon}</ToolButton>)}
  </nav>;
}

/** The shared width range of every rail panel, in CSS pixels. */
export const SIDE_PANEL_MIN_WIDTH = 220, SIDE_PANEL_MAX_WIDTH = 560, SIDE_PANEL_DEFAULT_WIDTH = 300;
export const SIDE_PANEL_WIDTH_KEY = 'pushform.sidePanelWidth';
const KEY_STEP = 10, KEY_STEP_LARGE = 50;
const clampWidth = (width: number): number => Math.round(Math.min(SIDE_PANEL_MAX_WIDTH, Math.max(SIDE_PANEL_MIN_WIDTH, width)));
/** The width chosen this session when storage refused it, so tab switches that remount the dock keep it. */
let unsavedWidth: number | null = null;

/** The width this browser remembers; without storage, this session's width, else the default. */
export function readSidePanelWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(SIDE_PANEL_WIDTH_KEY));
    if (stored) return clampWidth(stored);
  } catch { /* fall through */ }
  return unsavedWidth ?? SIDE_PANEL_DEFAULT_WIDTH;
}

function writeSidePanelWidth(width: number): void {
  try { window.localStorage.setItem(SIDE_PANEL_WIDTH_KEY, String(width)); unsavedWidth = null; } catch { unsavedWidth = width; }
}

/** The panel never takes more than 60% of the window, though never less than the minimum width. */
const windowCap = (): number => typeof window === 'undefined' ? SIDE_PANEL_MAX_WIDTH : Math.max(SIDE_PANEL_MIN_WIDTH, Math.floor(window.innerWidth * 0.6));

/**
 * The docked side panel between the rail and the editor. It pushes the editor content, stays
 * mounted while hidden so its panels keep their state, and is resized from its right edge by pointer or arrow keys.
 */
export function SideDock({ open, children }: { open: boolean; children: ReactNode }): JSX.Element {
  const [width, setWidth] = useState(readSidePanelWidth);
  const [cap, setCap] = useState(windowCap);
  const drag = useRef<{ x: number; width: number; cleanup: () => void } | null>(null);
  useEffect(() => () => drag.current?.cleanup(), []);
  useEffect(() => {
    const update = (): void => setCap(windowCap());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  // The handle reports, and steps from, the width actually shown.
  const shown = Math.min(width, cap);
  const resize = (next: number): void => { const value = clampWidth(next); setWidth(value); writeSidePanelWidth(value); };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current?.cleanup();
    const move = (moved: PointerEvent): void => {
      if (drag.current) setWidth(clampWidth(drag.current.width + moved.clientX - drag.current.x));
    };
    const up = (released: PointerEvent): void => {
      if (drag.current) resize(drag.current.width + released.clientX - drag.current.x);
      drag.current?.cleanup();
    };
    const cleanup = (): void => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      drag.current = null;
    };
    drag.current = { x: event.clientX, width: shown, cleanup };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const next = event.key === 'ArrowLeft' ? shown - step : event.key === 'ArrowRight' ? shown + step
      : event.key === 'Home' ? SIDE_PANEL_MIN_WIDTH : event.key === 'End' ? SIDE_PANEL_MAX_WIDTH : null;
    if (next === null) return;
    // Arrow keys here resize the panel; they must not also nudge a selection or move a tool.
    event.preventDefault(); event.stopPropagation();
    resize(next);
  };
  return <div className="pf-side-dock" hidden={!open} style={{ width: shown }}>
    <div className="pf-side-dock-content">{children}</div>
    <div className="pf-side-dock-resize" role="separator" aria-orientation="vertical" aria-label="Resize side panel" tabIndex={0}
      aria-valuenow={shown} aria-valuemin={SIDE_PANEL_MIN_WIDTH} aria-valuemax={Math.min(SIDE_PANEL_MAX_WIDTH, cap)}
      onPointerDown={onPointerDown} onKeyDown={onKeyDown} />
  </div>;
}

/**
 * A dock slot that shows `node` while `attached`: the editors' docks sit at different places in the React
 * tree, so the docked chat is portalled into one stable detached element that the active dock adopts.
 */
export function DockSlot({ node, attached }: { node: HTMLElement; attached: boolean }): JSX.Element {
  const slot = useRef<HTMLDivElement>(null);
  // A layout effect, so the chat is in the document before its own effects move focus into it.
  useLayoutEffect(() => {
    const host = slot.current;
    if (!attached || !host) return;
    host.append(node);
    return () => { if (node.parentNode === host) node.remove(); };
  }, [node, attached]);
  return <div ref={slot} className="pf-side-dock-slot" hidden={!attached} />;
}
