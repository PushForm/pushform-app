// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, type JSX, type PointerEvent } from 'react';

export interface TableGridBoundary {
  axis: 'row' | 'column';
  index: number;
  position: number;
  size: number;
  extent: number;
  /** Visible portions of a boundary, excluding the interiors of merged cells. */
  runs: [number, number][];
  cursor: string;
}
/** Host-independent boundary gestures. Sizes and pointer coordinates use the same
 * local units; the host translates preview/commit callbacks into its document. */
export function TableGridResizers({
  boundaries,
  pixelsPerUnit,
  minimumSize,
  pointFromClient,
  onPreview,
  onCommit,
}: {
  boundaries: TableGridBoundary[];
  pixelsPerUnit: number;
  minimumSize: number;
  pointFromClient(x: number, y: number): [number, number];
  onPreview(axis: 'row' | 'column', index: number, size: number | null): void;
  onCommit(axis: 'row' | 'column', index: number, size: number): void;
}): JSX.Element {
  const drag = useRef<{
    boundary: TableGridBoundary;
    start: number;
    pointerId: number;
    target: HTMLButtonElement;
  } | null>(null);
  const callbacks = useRef({ onPreview, onCommit });
  callbacks.current = { onPreview, onCommit };
  const cancel = () => {
    const pending = drag.current;
    drag.current = null;
    if (!pending) return;
    callbacks.current.onPreview(pending.boundary.axis, pending.boundary.index, null);
    if (pending.target.hasPointerCapture?.(pending.pointerId))
      pending.target.releasePointerCapture(pending.pointerId);
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancel);
    };
  }, []);
  const sizeAt = (event: PointerEvent<HTMLButtonElement>) => {
    const pending = drag.current!;
    const point = pointFromClient(event.clientX, event.clientY);
    return Math.max(
      minimumSize,
      pending.boundary.size + point[pending.boundary.axis === 'column' ? 0 : 1] - pending.start,
    );
  };
  return (
    <>
      {boundaries.map((boundary) => {
        const column = boundary.axis === 'column',
          position = boundary.position * pixelsPerUnit;
        return (
          <button
            key={`${boundary.axis}:${boundary.index}`}
            type="button"
            className={`pf-table-grid-resizer ${column ? 'is-column' : 'is-row'}`}
            aria-label={`Resize ${boundary.axis} ${boundary.index + 1}`}
            title={`Drag to resize ${boundary.axis} ${boundary.index + 1}`}
            style={
              column
                ? {
                    left: position - 3,
                    top: -8,
                    width: 6,
                    height: boundary.extent * pixelsPerUnit + 8,
                    cursor: boundary.cursor,
                  }
                : {
                    left: -8,
                    top: position - 3,
                    height: 6,
                    width: boundary.extent * pixelsPerUnit + 8,
                    cursor: boundary.cursor,
                  }
            }
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              const point = pointFromClient(event.clientX, event.clientY);
              drag.current = {
                boundary,
                start: point[column ? 0 : 1],
                pointerId: event.pointerId,
                target: event.currentTarget,
              };
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!drag.current) return;
              event.stopPropagation();
              const size = sizeAt(event);
              onPreview(drag.current.boundary.axis, drag.current.boundary.index, size);
            }}
            onPointerUp={(event) => {
              const pending = drag.current;
              if (!pending) return;
              event.stopPropagation();
              const size = sizeAt(event);
              drag.current = null;
              onPreview(pending.boundary.axis, pending.boundary.index, null);
              if (size !== pending.boundary.size)
                onCommit(pending.boundary.axis, pending.boundary.index, size);
              if (event.currentTarget.hasPointerCapture?.(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={cancel}
            onLostPointerCapture={cancel}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (
                event.key === 'Escape' ||
                ((event.ctrlKey || event.metaKey) && /^[zy]$/i.test(event.key))
              )
                return;
              event.stopPropagation();
              // Keyboard equivalents resize in the table's local axes.
              const step = event.shiftKey ? 10 : 1;
              const delta =
                event.key === (column ? 'ArrowRight' : 'ArrowDown')
                  ? step
                  : event.key === (column ? 'ArrowLeft' : 'ArrowUp')
                    ? -step
                    : 0;
              if (delta) {
                event.preventDefault();
                onCommit(
                  boundary.axis,
                  boundary.index,
                  Math.max(minimumSize, boundary.size + delta),
                );
              }
            }}
          >
            <span
              className="pf-table-grid-edge-grip"
              style={column ? { top: 0, height: 8, width: 6 } : { left: 0, width: 8, height: 6 }}
            />
            {boundary.runs.map(([from, to], i) => (
              <span
                key={i}
                style={
                  column
                    ? {
                        left: 0,
                        top: from * pixelsPerUnit + 8,
                        width: 6,
                        height: (to - from) * pixelsPerUnit,
                      }
                    : {
                        top: 0,
                        left: from * pixelsPerUnit + 8,
                        height: 6,
                        width: (to - from) * pixelsPerUnit,
                      }
                }
              />
            ))}
          </button>
        );
      })}
    </>
  );
}
