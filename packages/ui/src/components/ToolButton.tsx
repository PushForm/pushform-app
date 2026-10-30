// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useId, useState, type ComponentProps, type JSX } from 'react';
import { createPortal } from 'react-dom';

/**
 * Toolbar button with a tooltip outside the toolbar's scrolling container. A disabled button
 * stays hoverable and focusable (`aria-disabled`, no click) so its tooltip can explain why it
 * is unavailable; browsers send no pointer events to a natively disabled control.
 */
export function ToolButton({
  title,
  'data-guidance-id': guidanceId,
  disabled,
  onClick,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  onKeyDown,
  ...props
}: ComponentProps<'button'> & { title: string; 'data-guidance-id'?: string | undefined }): JSX.Element {
  const id = useId();
  const [position, setPosition] = useState<{ left?: number; right?: number; top: number; transform?: string } | null>(
    null,
  );
  const show = (button: HTMLButtonElement): void => {
    const rect = button.getBoundingClientRect();
    if (button.closest('[data-orientation="horizontal"]')) {
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)),
        top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 40)), transform: 'none' });
      return;
    }
    setPosition({
      ...(rect.right + 240 > window.innerWidth
        ? { right: window.innerWidth - rect.left + 8 }
        : { left: rect.right + 8 }),
      top: Math.max(8, Math.min(rect.top + rect.height / 2, window.innerHeight - 24)),
    });
  };

  return (
    <>
      <button
        {...props}
        data-guidance-id={guidanceId ?? `control:${props['aria-label'] ?? title}`}
        aria-disabled={disabled || undefined}
        onClick={(event) => {
          if (disabled) { event.preventDefault(); return; }
          onClick?.(event);
        }}
        aria-describedby={
          position
            ? [props['aria-describedby'], id].filter(Boolean).join(' ')
            : props['aria-describedby']
        }
        onMouseEnter={(event) => {
          show(event.currentTarget);
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event) => {
          setPosition(null);
          onMouseLeave?.(event);
        }}
        onFocus={(event) => {
          show(event.currentTarget);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setPosition(null);
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setPosition(null);
          onKeyDown?.(event);
        }}
      />
      {position &&
        createPortal(
          <span id={id} role="tooltip" className="pf-tool-tooltip" style={position}>
            {title}
          </span>,
          document.body,
        )}
    </>
  );
}
