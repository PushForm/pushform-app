// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { registerGuidanceTargets } from '../guidance';
import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { ToolButton } from './ToolButton';

/** One entry of a stacked toolbar slot. `key` is the shortcut label shown in the flyout. */
export interface StackedTool {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly key?: string | undefined;
}

export interface ToolStackProps {
  /** Group name, used for the flyout's accessible name ("<title> tools"). */
  readonly title: string;
  /** Tools in the slot, in flyout order. Must not be empty. */
  readonly tools: readonly StackedTool[];
  /** Id of the application's active tool (any id; the slot shows pressed only when it owns it). */
  readonly activeId: string;
  readonly onSelect: (id: string) => void;
}

/** Flyout geometry (CSS px); keep in sync with `.pf-tool-stack-menu` in styles.css. */
const MENU_WIDTH = 224;
const MENU_ROW = 36;
const MENU_PADDING = 8;
const MENU_GAP = 6;
const VIEWPORT_MARGIN = 8;
const MENU_ITEM = '[role="menuitemradio"]';

/**
 * A toolbar slot holding several tools behind one button, as a stacked toolbar
 * button. The face shows the active tool when the slot owns it, otherwise the tool last picked
 * from this slot. Clicking the face activates that tool; the small expander (or ArrowRight /
 * ArrowDown on the face) opens a flyout listing every tool with its shortcut. The flyout is a
 * portal so it is not clipped by the toolbar's scroll container, and it closes on selection,
 * Escape, outside click, resize or scroll.
 */
export function ToolStack({
  title,
  tools,
  activeId,
  onSelect,
}: ToolStackProps): JSX.Element | null {
  const menuId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [lastId, setLastId] = useState<string | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const owned = tools.find((tool) => tool.id === activeId);
  const current = owned ?? tools.find((tool) => tool.id === lastId) ?? tools[0];
  const isOpen = position !== null;
  const focusMenu = useRef(true);

  // Remember the last tool activated through this slot, even when it was picked elsewhere
  // (keyboard shortcut, menu), so the face keeps showing it after switching tools.
  useEffect(() => {
    if (owned) setLastId(owned.id);
  }, [owned]);

  useEffect(() => {
    if (!isOpen) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>(MENU_ITEM);
    const index = Math.max(
      0,
      tools.findIndex((tool) => tool.id === current?.id),
    );
    // Pointer-opened flyouts must not steal an active document text selection.
    if (focusMenu.current && !document.activeElement?.closest('.pf-layout-inline-text')) items?.[index]?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!wrapper.current?.contains(target) && !menu.current?.contains(target)) setPosition(null);
    };
    const dismiss = (): void => setPosition(null);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [isOpen, tools, current?.id]);

  useLayoutEffect(() => {
    if (!wrapper.current) return;
    return registerGuidanceTargets({ root: wrapper.current, targets: tools.map(tool => ({ id: `toolbar:${tool.id}`, label: tool.title, surface: 'toolbar' as const, dropdown: title, active: tool.id === activeId, route: `Toolbar > ${title} > ${tool.title}`, enabled: true })),
      reveal: ids => { if (tools.some(tool => ids.includes(`toolbar:${tool.id}`))) open(false); },
    });
  });

  if (!current) return null;

  const close = (refocus = false): void => {
    setPosition(null);
    if (refocus) wrapper.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus();
  };
  const open = (focus = true): void => {
    focusMenu.current = focus;
    const rect = wrapper.current?.getBoundingClientRect();
    if (!rect) return;
    const height = tools.length * MENU_ROW + MENU_PADDING;
    const horizontal = wrapper.current?.closest('[data-orientation="horizontal"]') !== null;
    setPosition({
      left: clamp(
        horizontal ? rect.left : rect.right + MENU_GAP,
        VIEWPORT_MARGIN,
        window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN,
      ),
      top: clamp(horizontal ? rect.bottom + MENU_GAP : rect.top, VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN),
    });
  };
  const pick = (id: string, refocus: boolean): void => {
    setLastId(id);
    onSelect(id);
    close(refocus);
  };

  const onFaceKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      open();
    }
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(MENU_ITEM)];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div className="pf-tool-stack" ref={wrapper}>
      <ToolButton
        type="button"
        className={`pf-toolbtn${owned ? ' is-active' : ''}`}
        title={current.key ? `${current.title} (${current.key})` : current.title}
        data-guidance-skip="true"
        aria-label={current.title}
        aria-pressed={owned !== undefined}
        onClick={() => pick(current.id, false)}
        onKeyDown={onFaceKeyDown}
      >
        <Icon name={current.icon} size={24} />
      </ToolButton>
      <button
        type="button"
        className="pf-tool-stack-expand"
        data-guidance-skip="true"
        aria-label={`${title} tools`}
        title={`${title} tools`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        onClick={() => (isOpen ? close() : open())}
      />
      {isOpen
        ? createPortal(
            <div
              id={menuId}
              ref={menu}
              className="pf-tool-stack-menu"
              role="menu"
              aria-label={`${title} tools`}
              aria-orientation="vertical"
              style={position}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) close();
              }}
              onKeyDown={onMenuKeyDown}
            >
              {tools.map((tool) => (
                <button
                  key={tool.id}
                  data-guidance-id={`toolbar:${tool.id}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={current.id === tool.id}
                  aria-label={tool.title}
                  aria-keyshortcuts={tool.key}
                  onClick={() => pick(tool.id, true)}
                >
                  <Icon name={tool.icon} size={18} />
                  <span>{tool.title}</span>
                  {tool.key ? <kbd aria-hidden="true">{tool.key}</kbd> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
