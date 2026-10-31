// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { contextMenu, modelClipboard } from '@pushform/commands';
import type { ContextMenuItem } from '@pushform/commands';
import type { EntityRef } from '@pushform/model';
import { useApp } from '../AppContext';
import { installUiCommands } from '../engine/uiCommands';
import { useEditContext } from '../hooks/useEditContext';
import { useAppStore } from '../store';
import type { ContextMenuRequest } from '../store';
import { selectionActionGroups } from '../extensions/extensionContributions';
import { Icon } from './Icon';

export interface ContextMenuProps {
  /** Position in CSS px relative to the positioned ancestor (the app shell: use viewport-relative client coordinates). */
  readonly x: number;
  readonly y: number;
  /** Refs the menu is for; empty = the empty-space menu. */
  readonly refs: readonly EntityRef[];
  onClose(): void;
}

const MENU_W = 220;
const ROW_H = 24;

/**
 * Right-click menu. Items come from `contextMenu.itemsFor` in `@pushform/commands`;
 * clicking one executes its command through the registry. Items whose command is not registered
 * are disabled. Esc, outside click or scrolling closes it.
 */
export function ContextMenu({ x, y, refs, onClose }: ContextMenuProps): JSX.Element {
  const app = useApp();
  const context = useEditContext();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const items = [
    ...contextMenu.itemsFor(app.document.doc.state, refs, { contextPath: context.path, activeToolId: app.toolManager.activeToolId, canPaste: modelClipboard.current !== null }),
    // Extensions' actions for the selection, each extension's under its own name.
    ...(refs.length ? selectionActionGroups(app.commands) : []),
  ];

  useLayoutEffect(() => {
    // Keep the menu inside the window.
    const w = typeof window !== 'undefined' ? window.innerWidth : Infinity;
    const h = typeof window !== 'undefined' ? window.innerHeight : Infinity;
    const height = ref.current?.offsetHeight || items.length * ROW_H;
    const width = ref.current?.offsetWidth || MENU_W;
    setPos({ left: Math.max(0, Math.min(x, w - width - 4)), top: Math.max(0, Math.min(y, h - height - 4)) });
  }, [x, y, items.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('wheel', onClose, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('wheel', onClose);
    };
  }, [onClose]);

  const activate = (item: ContextMenuItem) => {
    onClose();
    app.commands.tryExecute(item.command, item.params);
  };

  const renderItem = (item: ContextMenuItem, i: number): JSX.Element => {
    const disabled = item.disabled === true || (!item.children && !app.commands.has(item.command));
    if (item.children) {
      return (
        <div key={i} className={`pf-ctxmenu-item has-children${item.separator ? ' has-separator' : ''}`} role="none">
          <button type="button" className="pf-ctxmenu-btn" role="menuitem" aria-haspopup="menu" disabled={disabled}>
            <span>{item.label}</span>
            <Icon name="chevron-right" size={14} />
          </button>
          <div className="pf-ctxmenu pf-ctxmenu-sub" role="menu" aria-label={item.label}>
            {item.children.map(renderItem)}
          </div>
        </div>
      );
    }
    return (
      <div key={i} className={`pf-ctxmenu-item${item.separator ? ' has-separator' : ''}`} role="none">
        <button
          type="button"
          className="pf-ctxmenu-btn"
          role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
          aria-checked={item.checked}
          disabled={disabled}
          onClick={() => activate(item)}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span>{item.checked ? '✓ ' : ''}{item.label}</span>
        </button>
      </div>
    );
  };

  return (
    <div
      ref={ref}
      className="pf-ctxmenu"
      role="menu"
      aria-label="Context menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map(renderItem)}
    </div>
  );
}

/**
 * Open/close the shell's context menu. `open` goes through `ui.contextMenu.open`, which selects
 * the right-clicked refs when they are not part of the selection and stores the request.
 */
export function useContextMenu(): {
  readonly menu: ContextMenuRequest | null;
  open(req: ContextMenuRequest): void;
  close(): void;
} {
  const app = useApp();
  const menu = useAppStore((s) => s.contextMenu);
  const close = useAppStore((s) => s.closeContextMenu);
  useEffect(() => installUiCommands(app.commands), [app]);
  return {
    menu,
    open: (req) => {
      installUiCommands(app.commands);
      app.commands.tryExecute('ui.contextMenu.open', { x: req.x, y: req.y, refs: req.refs });
    },
    close,
  };
}

/** Renders the pending context menu from the store. The integrator mounts this once in the app shell. */
export function ContextMenuHost(): JSX.Element | null {
  const { menu, close } = useContextMenu();
  if (!menu) return null;
  return <ContextMenu x={menu.x} y={menu.y} refs={menu.refs} onClose={close} />;
}
