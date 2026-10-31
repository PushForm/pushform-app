// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { memo, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent } from 'react';
import type { UiEvent, UiVector, UiVectorShape, UiVectorStyle } from '@pushform/extension-protocol';

/**
 * A read-only drawing from an extension, drawn by PushForm as SVG elements built from validated shapes: no markup
 * from the extension reaches the page. The wheel or the + and − buttons zoom about the pointer or the center,
 * dragging pans, and Fit shows the whole drawing. Pointing at a shape with an item reports `hover` and shows its tip;
 * clicking reports `select`. From the keyboard, arrows pan, + and − zoom, 0 fits, ] and [ step through the items,
 * Enter selects the current one and Escape clears it. Drawings show on white paper in both themes, as they print and
 * export, so the extension's colors keep their contrast.
 */

interface ViewBox { x: number; y: number; width: number; height: number }

const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 200;

export function VectorView({ node, onEvent }: { readonly node: UiVector; readonly onEvent: (event: UiEvent) => void }): JSX.Element {
  const svg = useRef<SVGSVGElement>(null);
  const { bounds } = node;
  const fit = useMemo<ViewBox>(() => ({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }), [bounds.x, bounds.y, bounds.width, bounds.height]);
  const [view, setView] = useState<ViewBox>(fit);
  useEffect(() => setView(fit), [fit]);
  const [hover, setHover] = useState<{ item: string; x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; view: ViewBox; moved: boolean } | null>(null);

  const items = useMemo(() => {
    const byItem = new Map<string, UiVectorShape[]>();
    for (const shape of node.shapes) if (shape.item) byItem.set(shape.item, [...(byItem.get(shape.item) ?? []), shape]);
    return byItem;
  }, [node.shapes]);
  const order = useMemo(() => [...items.keys()], [items]);
  const tipOf = (item: string): string => items.get(item)?.find((s) => s.tip)?.tip ?? item;

  const lastHover = useRef<string | null>(null);
  const reportHover = (item: string | null): void => {
    if (lastHover.current === item) return;
    lastHover.current = item;
    onEvent({ component: node.id, event: 'hover', item });
  };

  const zoom = (factor: number, about?: { x: number; y: number }): void => setView((v) => {
    const scale = bounds.width / (v.width / factor);
    if (scale < MIN_ZOOM || scale > MAX_ZOOM) return v;
    const cx = about?.x ?? v.x + v.width / 2, cy = about?.y ?? v.y + v.height / 2;
    const width = v.width / factor, height = v.height / factor;
    return { x: cx - (cx - v.x) / factor, y: cy - (cy - v.y) / factor, width, height };
  });
  const pan = (dx: number, dy: number): void => setView((v) => ({ ...v, x: v.x + dx * v.width, y: v.y + dy * v.height }));

  /** The drawing coordinates under a client point; the view's center where the browser cannot tell. */
  const toDrawing = (clientX: number, clientY: number): { x: number; y: number } | undefined => {
    const matrix = svg.current?.getScreenCTM?.();
    if (!matrix || !svg.current) return undefined;
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  };

  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (e: WheelEvent): void => {
      e.preventDefault();
      zoom(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, toDrawing(e.clientX, e.clientY));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  });

  const itemAt = (target: EventTarget | null): string | null =>
    target instanceof Element ? target.closest('[data-item]')?.getAttribute('data-item') ?? null : null;

  const pointerDown = (e: PointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, view, moved: false };
  };
  const pointerMove = (e: PointerEvent<SVGSVGElement>): void => {
    const d = drag.current;
    if (d && (d.moved || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 3)) {
      if (!d.moved) svg.current?.setPointerCapture?.(e.pointerId);
      d.moved = true;
      const rect = svg.current!.getBoundingClientRect();
      const perPx = Math.max(d.view.width / (rect.width || 1), d.view.height / (rect.height || 1));
      setView({ ...d.view, x: d.view.x - (e.clientX - d.x) * perPx, y: d.view.y - (e.clientY - d.y) * perPx });
      return;
    }
    const item = itemAt(e.target);
    const host = svg.current?.parentElement?.getBoundingClientRect();
    setHover(item ? { item, x: e.clientX - (host?.left ?? 0), y: e.clientY - (host?.top ?? 0) } : null);
    reportHover(item);
  };
  const pointerUp = (e: PointerEvent<SVGSVGElement>): void => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) return;
    const item = itemAt(e.target);
    onEvent({ component: node.id, event: 'select', value: item });
  };
  const keyDown = (e: KeyboardEvent<SVGSVGElement>): void => {
    const step = (delta: number): void => {
      if (!order.length) return;
      const at = cursor === null ? (delta > 0 ? -1 : 0) : order.indexOf(cursor);
      const next = order[(at + delta + order.length) % order.length]!;
      setCursor(next);
      reportHover(next);
    };
    const handled = (() => {
      switch (e.key) {
        case 'ArrowLeft': pan(-0.1, 0); return true;
        case 'ArrowRight': pan(0.1, 0); return true;
        case 'ArrowUp': pan(0, -0.1); return true;
        case 'ArrowDown': pan(0, 0.1); return true;
        case '+': case '=': zoom(ZOOM_STEP); return true;
        case '-': case '_': zoom(1 / ZOOM_STEP); return true;
        case '0': setView(fit); return true;
        case ']': step(1); return true;
        case '[': step(-1); return true;
        case 'Enter': if (cursor) onEvent({ component: node.id, event: 'select', value: cursor }); return cursor !== null;
        case 'Escape': if (cursor) { setCursor(null); reportHover(null); return true; } return false;
        default: return false;
      }
    })();
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  const selected = new Set(node.selected ?? []);
  const highlighted = [...selected, ...(hover ? [hover.item] : []), ...(cursor ? [cursor] : [])];
  return (
    <div className="pf-xui-vector" role="group" aria-label={node.label}>
      <div className="pf-xui-vector-tools">
        <span className="pf-xui-label">{node.label}</span>
        <button type="button" className="pf-btn pf-xui-vector-tool" aria-label="Zoom in" onClick={() => zoom(ZOOM_STEP)}>+</button>
        <button type="button" className="pf-btn pf-xui-vector-tool" aria-label="Zoom out" onClick={() => zoom(1 / ZOOM_STEP)}>−</button>
        <button type="button" className="pf-btn pf-xui-vector-tool" onClick={() => setView(fit)}>Fit</button>
      </div>
      <div className="pf-xui-vector-frame" style={{ height: node.height ?? 300 }}>
        <svg ref={svg} className="pf-xui-vector-canvas" role="img" tabIndex={0}
          aria-label={`${node.label}. Arrow keys pan, plus and minus zoom, 0 fits, ] and [ step through items, Enter selects.`}
          viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`} preserveAspectRatio="xMidYMid meet"
          onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
          onPointerLeave={() => { if (!drag.current) { setHover(null); reportHover(cursor); } }} onKeyDown={keyDown}>
          <Patterns styles={node.styles} bounds={bounds} />
          <Shapes shapes={node.shapes} styles={node.styles} />
          <g className="pf-xui-vector-highlight" aria-hidden="true">
            {highlighted.flatMap((item) => (items.get(item) ?? []).filter((shape) => shape.kind !== 'text').map((shape, i) => (
              <Shape key={`${item}:${i}`} shape={shape} style={{ stroke: '#000000', strokeWidth: selected.has(item) ? 3 : 2 }}
                className={selected.has(item) ? 'is-selected' : 'is-hover'} index={-1} />
            )))}
          </g>
        </svg>
        {hover ? <div className="pf-xui-vector-tip" role="tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>{tipOf(hover.item)}</div> : null}
      </div>
      <p className="pf-xui-vector-live" aria-live="polite">{cursor ? tipOf(cursor) : ''}</p>
    </div>
  );
}

const Patterns = memo(function Patterns({ styles, bounds }: { styles: readonly UiVectorStyle[]; bounds: UiVector['bounds'] }): JSX.Element | null {
  const size = Math.max(bounds.width, bounds.height) / 80;
  const hatched = styles.map((s, i) => (s.hatch ? i : -1)).filter((i) => i >= 0);
  if (!hatched.length) return null;
  return (
    <defs>
      {hatched.map((i) => (
        <pattern key={i} id={`pf-xui-hatch-${i}`} patternUnits="userSpaceOnUse" width={size} height={size} patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={size} stroke={styles[i]!.stroke ?? 'currentColor'} strokeWidth={size / 6} />
        </pattern>
      ))}
    </defs>
  );
});

/** Every shape, drawn once per drawing; zooming and panning change only the view box. */
const Shapes = memo(function Shapes({ shapes, styles }: { shapes: readonly UiVectorShape[]; styles: readonly UiVectorStyle[] }): JSX.Element {
  return <g>{shapes.map((shape, i) => <Shape key={i} shape={shape} style={styles[shape.style]!} index={shape.style} />)}</g>;
});

function Shape({ shape, style, index, className }: { shape: UiVectorShape; style: UiVectorStyle; index: number; className?: string }): JSX.Element {
  const text = shape.kind === 'text';
  const fill = style.hatch && index >= 0 ? `url(#pf-xui-hatch-${index})` : style.fill ?? (text ? 'currentColor' : 'none');
  const stroke = text ? undefined : style.stroke ?? (style.fill || style.hatch ? undefined : 'currentColor');
  const paint = {
    fill: className ? 'none' : fill,
    ...(stroke || className ? { stroke: className ? undefined : stroke, strokeWidth: style.strokeWidth ?? 1, vectorEffect: 'non-scaling-stroke' as const } : {}),
    ...(style.dash === 'dashed' ? { strokeDasharray: '6 4' } : style.dash === 'dotted' ? { strokeDasharray: '1 3' } : {}),
    ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
    ...(shape.item ? { 'data-item': shape.item } : {}),
    ...(className ? { className } : {}),
  };
  switch (shape.kind) {
    case 'rect':
      return <rect x={shape.x} y={shape.y} width={shape.width} height={shape.height} {...paint} />;
    case 'polyline': {
      const points = shape.points.reduce<string[]>((out, v, i) => { if (i % 2) out.push(`${shape.points[i - 1]},${v}`); return out; }, []).join(' ');
      return shape.closed ? <polygon points={points} {...paint} /> : <polyline points={points} {...paint} />;
    }
    case 'text':
      return (
        <text x={shape.x} y={shape.y} fontSize={shape.size} textAnchor={shape.anchor ?? 'start'} fontWeight={style.fontWeight ?? 'normal'}
          transform={shape.angle ? `rotate(${-shape.angle} ${shape.x} ${shape.y})` : undefined} {...paint}
          {...(className ? { fill: 'none' } : {})}>{shape.text}</text>
      );
  }
}
