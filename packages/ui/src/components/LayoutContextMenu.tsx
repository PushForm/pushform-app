// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export interface LayoutMenuItem {
  label: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  children?: LayoutMenuItem[];
  action?: () => void | Promise<void>;
}

/** A page menu with independent, viewport-constrained submenus. */
export function LayoutContextMenu({ x, y, items, onClose, submenu = false, parent, onBack, label = 'Layout context menu' }: {
  x: number; y: number; items: LayoutMenuItem[]; onClose: () => void;
  submenu?: boolean; parent?: DOMRect; onBack?: () => void;
  /** The menu's accessible name; submenus are always "Layout submenu". */
  label?: string;
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [open, setOpen] = useState<{ index: number; rect: DOMRect } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const bounds = root.current!.getBoundingClientRect();
    const left = parent && x + bounds.width > window.innerWidth - 6 ? parent.left - bounds.width + 2 : x;
    setPosition({ left: Math.max(6, Math.min(left, window.innerWidth - bounds.width - 6)),
      top: Math.max(6, Math.min(y, window.innerHeight - bounds.height - 6)) });
    if (!submenu) root.current?.focus();
  }, [x, y, parent, submenu]);
  useEffect(() => {
    if (submenu) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.pf-layout-context-menu')) closeRef.current();
    };
    const close = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.pf-layout-context-menu')) return;
      closeRef.current();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('wheel', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [submenu]);
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const buttons = Array.from(root.current!.querySelectorAll<HTMLButtonElement>(':scope > .pf-layout-context-row > button:not(:disabled)'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : index < 0 ? event.key === 'ArrowDown' ? 0 : buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      const button = buttons[index];
      if (button?.getAttribute('aria-haspopup') !== 'menu') return;
      button.click();
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.pf-layout-context-menu[data-submenu="true"] button:not(:disabled)')?.focus());
    } else if (event.key === 'ArrowLeft' && submenu) { event.preventDefault(); onBack?.(); }
  };
  return createPortal(<div ref={root} className="pf-layout-context-menu" role="menu" aria-label={submenu ? 'Layout submenu' : label}
    data-submenu={submenu} tabIndex={-1} style={position} onKeyDown={keydown}
    onContextMenu={event => event.preventDefault()}>
    {items.map((item, index) => <div key={item.label} className={`pf-layout-context-row${item.separator ? ' has-separator' : ''}`}
      onPointerEnter={event => setOpen(item.children && !item.disabled ? { index, rect: event.currentTarget.getBoundingClientRect() } : null)}>
      <button type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
        aria-checked={item.checked} disabled={item.disabled}
        aria-haspopup={item.children ? 'menu' : undefined} aria-expanded={item.children ? open?.index === index : undefined}
        onFocus={event => { if (item.children) setOpen({ index, rect: event.currentTarget.getBoundingClientRect() }); else setOpen(null); }}
        onClick={event => {
          if (item.children) { setOpen({ index, rect: event.currentTarget.getBoundingClientRect() }); return; }
          onClose(); void item.action?.();
        }}>
        <span className="pf-layout-context-check" aria-hidden="true">{item.checked ? '✓' : ''}</span>
        <span>{item.label}</span>{item.children ? <Icon name="chevron-right" size={15} /> : null}
      </button>
    </div>)}
    {open && items[open.index]?.children ? <LayoutContextMenu x={open.rect.right - 2} y={open.rect.top - 5} parent={open.rect}
      items={items[open.index]!.children!} submenu onClose={onClose} onBack={() => {
        setOpen(null);
        root.current?.focus();
      }} /> : null}
  </div>, document.body);
}
