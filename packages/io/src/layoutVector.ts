// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Paper-space drawing operations shared by SVG and DXF export. Coordinates and weights are millimeters. */
export type VectorPoint = [number, number];
export type VectorMatrix = [number, number, number, number, number, number];
export type VectorSegment = { kind: 'move' | 'line'; point: VectorPoint }
  | { kind: 'cubic'; c1: VectorPoint; c2: VectorPoint; point: VectorPoint } | { kind: 'close' };
export interface VectorPath { segments: VectorSegment[] }
export interface LayoutVectorIdentity { objectId?: number; groupIds?: number[] }
interface VectorBase extends LayoutVectorIdentity { layer: string; clips: VectorPath[]; layerVisible?: boolean }
export type LayoutVectorItem = VectorBase & (
  | { kind: 'path'; path: VectorPath; fill: string | null; stroke: string | null; weight: number; dash: number[]; evenodd: boolean }
  | { kind: 'text'; textBlockId?: number; underline?: boolean; text: string; point: VectorPoint; matrix: VectorMatrix; font: string; color: string;
    align: CanvasTextAlign; baseline: CanvasTextBaseline; bounds: [number, number, number, number] }
  | { kind: 'image'; src: string; matrix: VectorMatrix; x: number; y: number; width: number; height: number });
export interface LayoutVectorPage { paperUnits?: 'mm' | 'in'; name: string; width: number; height: number; background: string; items: LayoutVectorItem[] }
export type LayoutExportArea = 'page' | 'drawing';
export interface LayoutVectorBounds { x: number; y: number; width: number; height: number }

/** Place selected sheets side by side for a single model-space DXF, in document order. */
export function combineLayoutVectorPages(pages: LayoutVectorPage[]): LayoutVectorPage {
  if (!pages.length) throw new Error('Choose at least one page to export.');
  let offset = 0;
  const items: LayoutVectorItem[] = [];
  const shift = (p: VectorPoint): VectorPoint => [p[0] + offset, p[1]];
  const path = (value: VectorPath): VectorPath => ({ segments: value.segments.map(s => s.kind === 'close' ? s : s.kind === 'cubic'
    ? { ...s, point: shift(s.point), c1: shift(s.c1), c2: shift(s.c2) } : { ...s, point: shift(s.point) }) });
  for (const page of pages) {
    for (const item of page.items) items.push(item.kind === 'path' ? { ...item, clips: item.clips.map(path), path: path(item.path) }
      : { ...item, clips: item.clips.map(path), matrix: [item.matrix[0], item.matrix[1], item.matrix[2], item.matrix[3], item.matrix[4] + offset, item.matrix[5]] });
    offset += page.width + 10;
  }
  return { name: pages.map(p => p.name).join(', '), width: offset - 10, height: Math.max(...pages.map(p => p.height)), background: pages[0]!.background, paperUnits: pages[0]!.paperUnits ?? 'mm', items };
}

/** Conservative painted bounds with Bézier extrema, miter joins, transforms and clip bounds. */
export function layoutVectorBounds(page: LayoutVectorPage, area: LayoutExportArea, includeImages = true): LayoutVectorBounds {
  if (area === 'page') return { x: 0, y: 0, width: page.width, height: page.height };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, hasPoints = false;
  const add = ([x, y]: VectorPoint, pad = 0) => {
    minX = Math.min(minX, x - pad, x + pad); minY = Math.min(minY, y - pad, y + pad);
    maxX = Math.max(maxX, x - pad, x + pad); maxY = Math.max(maxY, y - pad, y + pad);
    hasPoints = true;
  };
  const total = { minX, minY, maxX, maxY };
  const clipBounds = new Map<VectorPath, LayoutVectorBounds>();
  for (const item of page.items) {
    minX = minY = Infinity; maxX = maxY = -Infinity;
    if (item.kind === 'path') {
      if ((!item.fill || /00$/i.test(item.fill) && item.fill.length === 9) && (!item.stroke || /00$/i.test(item.stroke) && item.stroke.length === 9)) continue;
      const pad = item.stroke ? item.weight / 2 : 0;
      // Include miter joins (Canvas defaults to a miter limit of 10).
      if (item.stroke && pad > 0) {
        const contours: { a: VectorPoint; b: VectorPoint; start: VectorPoint; end: VectorPoint }[][] = [];
        let from: VectorPoint = [0, 0], start = from;
        const join = (a: VectorPoint, p: VectorPoint, b: VectorPoint) => {
          const al = Math.hypot(...a), bl = Math.hypot(...b);
          if (!al || !bl) return;
          const u: VectorPoint = [a[0] / al, a[1] / al], v: VectorPoint = [b[0] / bl, b[1] / bl];
          const sine = Math.sqrt(Math.max(0, (1 - u[0] * v[0] - u[1] * v[1]) / 2));
          const length = pad / sine, bx = u[0] + v[0], by = u[1] + v[1], bisector = Math.hypot(bx, by);
          if (length <= pad * 10 && bisector) {
            const dx = length * bx / bisector, dy = length * by / bisector;
            add([p[0] + dx, p[1] + dy]); add([p[0] - dx, p[1] - dy]);
          }
        };
        for (const seg of item.path.segments) {
          if (seg.kind === 'move') { start = from = seg.point; contours.push([]); continue; }
          const to = seg.kind === 'close' ? start : seg.point;
          if (from[0] !== to[0] || from[1] !== to[1] || seg.kind === 'cubic') {
            const c1 = seg.kind === 'cubic' ? seg.c1 : to, c2 = seg.kind === 'cubic' ? seg.c2 : from;
            contours.at(-1)?.push({ a: from, b: to,
              start: c1[0] !== from[0] || c1[1] !== from[1] ? c1 : c2,
              end: c2[0] !== to[0] || c2[1] !== to[1] ? c2 : c1 });
          }
          if (seg.kind === 'close') {
            const edges = contours.at(-1)!;
            if (edges.length) {
              const last = edges.at(-1)!, first = edges[0]!;
              join([last.end[0] - last.b[0], last.end[1] - last.b[1]], first.a,
                [first.start[0] - first.a[0], first.start[1] - first.a[1]]);
            }
          }
          from = to;
        }
        for (const edges of contours) for (let i = 1; i < edges.length; i++) {
          const prev = edges[i - 1]!, next = edges[i]!;
          join([prev.end[0] - prev.b[0], prev.end[1] - prev.b[1]], next.a,
            [next.start[0] - next.a[0], next.start[1] - next.a[1]]);
        }
      }
      let from: VectorPoint = [0, 0], start = from;
      for (const segment of item.path.segments) {
        if (segment.kind === 'close') { from = start; continue; }
        if (segment.kind === 'move') start = segment.point;
        add(segment.point, pad);
        if (segment.kind === 'cubic') {
          const values = new Set<number>();
          for (const axis of [0, 1] as const) {
            const p = from[axis], a = -p + 3 * segment.c1[axis] - 3 * segment.c2[axis] + segment.point[axis];
            const b = 2 * (p - 2 * segment.c1[axis] + segment.c2[axis]), c = segment.c1[axis] - p;
            if (a === 0) { if (b !== 0) values.add(-c / b); }
            else {
              const disc = b * b - 4 * a * c;
              if (disc >= 0) { values.add((-b + Math.sqrt(disc)) / (2 * a)); values.add((-b - Math.sqrt(disc)) / (2 * a)); }
            }
          }
          for (const t of values) if (t > 0 && t < 1) {
            const u = 1 - t;
            add([0, 1].map(i => u ** 3 * from[i]! + 3 * u * u * t * segment.c1[i]! + 3 * u * t * t * segment.c2[i]! + t ** 3 * segment.point[i]!) as VectorPoint, pad);
          }
        }
        from = segment.point;
      }
    } else if ((item.kind === 'text' && !(item.color.length === 9 && /00$/i.test(item.color))) || item.kind === 'image' && includeImages) {
      const [x, y, right, bottom] = item.kind === 'text' ? item.bounds : [item.x, item.y, item.x + item.width, item.y + item.height];
      for (const p of [[x, y], [right, y], [right, bottom], [x, bottom]] as VectorPoint[]) add(vectorPoint(item.matrix, ...p));
    }
    // SVG clips are retained; intersect conservative bounds so hidden text overflow does not enlarge a sheet.
    for (const clip of item.clips) {
      let bounds = clipBounds.get(clip);
      if (!bounds) {
        bounds = layoutVectorBounds({ ...page, items: [{ kind: 'path', layer: '', clips: [], path: clip,
          fill: '#000000', stroke: null, weight: 0, dash: [], evenodd: false }] }, 'drawing');
        clipBounds.set(clip, bounds);
      }
      minX = Math.max(minX, bounds.x); minY = Math.max(minY, bounds.y);
      maxX = Math.min(maxX, bounds.x + bounds.width); maxY = Math.min(maxY, bounds.y + bounds.height);
    }
    if (minX <= maxX && minY <= maxY) {
      total.minX = Math.min(total.minX, minX); total.minY = Math.min(total.minY, minY);
      total.maxX = Math.max(total.maxX, maxX); total.maxY = Math.max(total.maxY, maxY);
    }
  }
  ({ minX, minY, maxX, maxY } = total);
  if (!hasPoints || minX === Infinity) throw new Error('There are no drawing elements to export.');
  return { x: minX, y: minY, width: Math.max(maxX - minX, 0.01), height: Math.max(maxY - minY, 0.01) };
}

export const vectorPoint = (m: VectorMatrix, x: number, y: number): VectorPoint => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const vectorNumber = (n: number): string => {
  if (!Number.isFinite(n)) throw new Error('The drawing contains an invalid coordinate.');
  return String(Number(n.toFixed(9)));
};
export const vectorXml = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
export function vectorPathData(path: VectorPath): string {
  return path.segments.map(s => s.kind === 'close' ? 'Z' : s.kind === 'cubic'
    ? `C${[...s.c1, ...s.c2, ...s.point].map(vectorNumber).join(' ')}`
    : `${s.kind === 'move' ? 'M' : 'L'}${s.point.map(vectorNumber).join(' ')}`).join(' ');
}

type VectorTextItem = Extract<LayoutVectorItem, { kind: 'text' }>;

/** One tspan per line/style run, with the source glyph positions retained to prevent reflow. */
function svgTextSpans(items: VectorTextItem[]): string {
  const runs: { first: VectorTextItem; text: string; x: number[] }[] = [];
  for (const item of items) {
    const previous = runs.at(-1);
    if (previous && previous.first.point[1] === item.point[1] && previous.first.font === item.font
      && previous.first.color === item.color && previous.first.underline === item.underline) {
      previous.text += item.text; previous.x.push(item.point[0]);
    } else runs.push({ first: item, text: item.text, x: [item.point[0]] });
  }
  return runs.map(({ first, text, x }) => `<tspan x="${x.map(vectorNumber).join(' ')}" y="${vectorNumber(first.point[1])}" style="font:${vectorXml(first.font)}${first.underline ? ';text-decoration:underline' : ''}" fill="${vectorXml(first.color)}">${vectorXml(text)}</tspan>`).join('');
}

/** A useful initial editor view, independent of the drawing workspace's current zoom and screen size. */
const SVG_INITIAL_VIEW_PX = { width: 1000, height: 700 };
const SVG_PIXELS_PER_MM = 96 / 25.4;

/** SVG retains the paper unit for physical dimensions and editor display, with geometry in a millimeter viewBox. */
export function writeLayoutSvg(page: LayoutVectorPage, area: LayoutExportArea = 'page'): string {
  const bounds = layoutVectorBounds(page, area);
  const unit = page.paperUnits ?? 'mm', millimetersPerUnit = unit === 'in' ? 25.4 : 1;
  // Named-view zoom/center use CSS pixels, regardless of SVG user units or the displayed paper unit.
  const pixelWidth = bounds.width * SVG_PIXELS_PER_MM, pixelHeight = bounds.height * SVG_PIXELS_PER_MM;
  const initialZoom = Math.min(1, SVG_INITIAL_VIEW_PX.width / pixelWidth, SVG_INITIAL_VIEW_PX.height / pixelHeight);
  const xml = vectorXml, n = vectorNumber, defs: string[] = [], body: string[] = [];
  // Collapse each recorded text block before counting objects or constructing SVG groups.
  const elements: { item: LayoutVectorItem; text: VectorTextItem[] }[] = [];
  for (const item of page.items) {
    const previous = elements.at(-1);
    if (item.kind === 'text' && item.textBlockId !== undefined && previous?.item.kind === 'text'
      && previous.item.textBlockId === item.textBlockId) previous.text.push(item);
    else elements.push({ item, text: item.kind === 'text' ? [item] : [] });
  }
  // Layer membership is metadata, never a selection group in the exported drawing.
  const counts = new Map<number, number>();
  for (const { item } of elements) if (item.objectId !== undefined) counts.set(item.objectId, (counts.get(item.objectId) ?? 0) + 1);
  let openGroups: string[] = [];
  for (const { item, text } of elements) {
    const groups = (item.groupIds ?? []).map(id => `data-group-id="${id}"`);
    if (item.objectId !== undefined && counts.get(item.objectId)! > 1) groups.push(`data-object-id="${item.objectId}"`);
    let common = 0;
    while (common < groups.length && common < openGroups.length && groups[common] === openGroups[common]) common++;
    for (let i = openGroups.length; i > common; i--) body.push('</g>');
    for (const group of groups.slice(common)) body.push(`<g ${group}>`);
    openGroups = groups;
    const metadata = ` data-layer="${xml(item.layer)}"${item.objectId !== undefined && counts.get(item.objectId) === 1 ? ` data-object-id="${item.objectId}"` : ''}`;
    for (const clip of item.clips) {
      const id = `clip${defs.length}`;
      defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${vectorPathData(clip)}"/></clipPath>`);
      body.push(`<g clip-path="url(#${id})">`);
    }
    if (item.kind === 'path') body.push(`<path${metadata} d="${vectorPathData(item.path)}" fill="${xml(item.fill ?? 'none')}" fill-rule="${item.evenodd ? 'evenodd' : 'nonzero'}" stroke="${xml(item.stroke ?? 'none')}" stroke-width="${n(item.weight)}" stroke-miterlimit="10"${item.dash.length ? ` stroke-dasharray="${item.dash.map(n).join(' ')}"` : ''}/>`);
    if (item.kind === 'text') {
      const baseline = ({ alphabetic: 'alphabetic', top: 'text-before-edge', hanging: 'hanging', middle: 'central', bottom: 'text-after-edge', ideographic: 'ideographic' } as const)[item.baseline];
      body.push(`<text${metadata} x="${n(item.point[0])}" y="${n(item.point[1])}" transform="matrix(${item.matrix.map(n).join(' ')})" style="font:${xml(item.font)};white-space:pre" fill="${xml(item.color)}" text-anchor="${item.align === 'center' ? 'middle' : item.align === 'right' || item.align === 'end' ? 'end' : 'start'}" dominant-baseline="${baseline}">${item.textBlockId !== undefined ? svgTextSpans(text) : xml(item.text)}</text>`);
    }
    if (item.kind === 'image') {
      if (!item.src.startsWith('data:image/')) throw new Error('An exported picture is not embedded in the document.');
      body.push(`<image${metadata} href="${xml(item.src)}" x="${n(item.x)}" y="${n(item.y)}" width="${n(item.width)}" height="${n(item.height)}" transform="matrix(${item.matrix.map(n).join(' ')})" preserveAspectRatio="none"/>`);
    }
    item.clips.forEach(() => body.push('</g>'));
  }
  openGroups.forEach(() => body.push('</g>'));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" width="${n(bounds.width / millimetersPerUnit)}${unit}" height="${n(bounds.height / millimetersPerUnit)}${unit}" viewBox="${[bounds.x, bounds.y, bounds.width, bounds.height].map(n).join(' ')}" overflow="hidden"><title>${xml(page.name)}</title><sodipodi:namedview id="pf-namedview" inkscape:document-units="${unit}" units="${unit}" inkscape:zoom="${n(initialZoom)}" inkscape:cx="${n(pixelWidth / 2)}" inkscape:cy="${n(pixelHeight / 2)}"/><defs>${defs.join('')}</defs>${area === 'page' ? `<rect width="100%" height="100%" fill="${xml(page.background)}"/>` : ''}${body.join('')}</svg>`;
}
