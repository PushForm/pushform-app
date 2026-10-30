// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { layoutVectorBounds, vectorNumber, vectorPoint, type LayoutExportArea, type LayoutVectorItem, type LayoutVectorPage, type VectorPath, type VectorPoint } from './layoutVector';

type Edge = { a: VectorPoint; b: VectorPoint; controls?: [VectorPoint, VectorPoint] };
function contours(path: VectorPath): { edges: Edge[]; closed: boolean }[] {
  const result: { edges: Edge[]; closed: boolean }[] = [];
  let start: VectorPoint = [0, 0], from = start;
  for (const s of path.segments) {
    if (s.kind === 'move') { start = from = s.point; result.push({ edges: [], closed: false }); }
    else if (s.kind === 'close') {
      if (from[0] !== start[0] || from[1] !== start[1]) result.at(-1)?.edges.push({ a: from, b: start });
      if (result.length) result.at(-1)!.closed = true;
      from = start;
    } else {
      result.at(-1)?.edges.push({ a: from, b: s.point, ...(s.kind === 'cubic' ? { controls: [s.c1, s.c2] as [VectorPoint, VectorPoint] } : {}) });
      from = s.point;
    }
  }
  return result.filter(c => c.edges.length);
}

/** DXF R2010, UTF-8, model space in millimeters. A scale denominator of 50 converts 1:50 paper geometry to real size. */
export interface LayoutDxfOptions { createLayers: boolean; colorByLayer: boolean; ignoreFills: boolean }
export function writeLayoutDxf(page: LayoutVectorPage, area: LayoutExportArea = 'page', scale = 1,
  options: LayoutDxfOptions = { createLayers: true, colorByLayer: false, ignoreFills: false }): { text: string; warnings: string[] } {
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('Enter a positive drawing scale denominator.');
  const bounds = layoutVectorBounds({ ...page, items: page.items.map(item => ({ ...item, clips: [] })) }, area, false), output: string[] = [], warnings = new Set<string>();
  const pair = (code: number, value: string | number) => { output.push(String(code), typeof value === 'number' ? vectorNumber(value) : value.replace(/[\r\n]/g, ' ')); };
  let nextHandle = 256;
  const handle = () => (nextHandle++).toString(16).toUpperCase();
  const section = (name: string) => { pair(0, 'SECTION'); pair(2, name); };
  const end = () => pair(0, 'ENDSEC');
  const layers = new Map<string, string>(), usedNames = new Set(['0']);
  for (const item of page.items) if (!layers.has(item.layer)) {
    const base = options.createLayers ? [...item.layer].map(c => c < ' ' || '<>/\\":;?*|='.includes(c) ? '_' : c).join('').trim().slice(0, 200) || 'Layer' : '0';
    let name = base, suffix = 1;
    if (base === '0') name = '0';
    else { while (usedNames.has(name.toUpperCase())) name = `${base}_${suffix++}`; usedNames.add(name.toUpperCase()); }
    layers.set(item.layer, name);
  }
  const dashPatterns = new Map<string, { name: string; values: number[] }>();
  for (const item of page.items) if (item.kind === 'path' && item.dash.length) {
    const key = item.dash.join(',');
    if (!dashPatterns.has(key)) dashPatterns.set(key, { name: `PF_DASH_${dashPatterns.size + 1}`, values: item.dash });
  }
  const fonts = new Map<string, string>();
  for (const item of page.items) if (item.kind === 'text' && !fonts.has(item.font)) fonts.set(item.font, `PF_TEXT_${fonts.size + 1}`);
  section('HEADER');
  pair(9, '$ACADVER'); pair(1, 'AC1024'); pair(9, '$INSUNITS'); pair(70, 4); pair(9, '$MEASUREMENT'); pair(70, 1);
  pair(9, '$LWDISPLAY'); pair(290, 1);
  pair(9, '$EXTMIN'); pair(10, 0); pair(20, 0); pair(30, 0);
  pair(9, '$EXTMAX'); pair(10, bounds.width * scale); pair(20, bounds.height * scale); pair(30, 0);
  end();
  const tables = { ltype: handle(), layer: handle(), style: handle(), block: handle() }, model = handle(), paper = handle();
  section('TABLES');
  const table = (name: string, id: string, count: number) => { pair(0, 'TABLE'); pair(2, name); pair(5, id); pair(100, 'AcDbSymbolTable'); pair(70, count); };
  table('LTYPE', tables.ltype, dashPatterns.size + 3);
  for (const pattern of [{ name: 'ByBlock', values: [] }, { name: 'ByLayer', values: [] }, { name: 'Continuous', values: [] }, ...dashPatterns.values()]) {
    pair(0, 'LTYPE'); pair(5, handle()); pair(330, tables.ltype); pair(100, 'AcDbSymbolTableRecord'); pair(100, 'AcDbLinetypeTableRecord');
    pair(2, pattern.name); pair(70, 0); pair(3, pattern.name); pair(72, 65); pair(73, pattern.values.length);
    pair(40, pattern.values.reduce((sum, value) => sum + value, 0) * scale);
    pattern.values.forEach((value, index) => { pair(49, value * scale * (index % 2 ? -1 : 1)); pair(74, 0); });
  }
  pair(0, 'ENDTAB');
  const layerNames = new Set(['0', ...layers.values()]);
  table('LAYER', tables.layer, layerNames.size);
  for (const name of layerNames) {
    pair(0, 'LAYER'); pair(5, handle()); pair(330, tables.layer); pair(100, 'AcDbSymbolTableRecord'); pair(100, 'AcDbLayerTableRecord');
    const members = page.items.filter(item => layers.get(item.layer) === name);
    pair(2, name); pair(70, 0); pair(62, members.length && members.every(item => item.layerVisible === false) ? -7 : 7); pair(6, 'Continuous');
    if (options.colorByLayer) {
      const first = members.find(item => item.kind !== 'image');
      const color = first?.kind === 'path' ? first.stroke ?? first.fill : first?.kind === 'text' ? first.color : null;
      if (color && /^#[\da-f]{6}/i.test(color)) pair(420, parseInt(color.slice(1, 7), 16));
    }
  }
  pair(0, 'ENDTAB');
  table('STYLE', tables.style, fonts.size + 1);
  for (const [font, name] of [['10px "Arial"', 'Standard'], ...fonts.entries()]) {
    pair(0, 'STYLE'); pair(5, handle()); pair(330, tables.style); pair(100, 'AcDbSymbolTableRecord'); pair(100, 'AcDbTextStyleTableRecord');
    pair(2, name!); pair(70, 0); pair(40, 0); pair(41, 1); pair(50, /italic/.test(font!) ? 12 : 0); pair(71, 0); pair(42, 2.5);
    pair(3, `${font!.match(/"([^"]+)"/)?.[1] ?? 'Arial'}.ttf`); pair(4, '');
  }
  pair(0, 'ENDTAB');
  table('BLOCK_RECORD', tables.block, 2);
  for (const [name, id] of [['*Model_Space', model], ['*Paper_Space', paper]]) {
    pair(0, 'BLOCK_RECORD'); pair(5, id!); pair(330, tables.block); pair(100, 'AcDbSymbolTableRecord'); pair(100, 'AcDbBlockTableRecord'); pair(2, name!); pair(70, 0);
  }
  pair(0, 'ENDTAB'); end();
  section('BLOCKS');
  for (const [name, id] of [['*Model_Space', model], ['*Paper_Space', paper]]) {
    pair(0, 'BLOCK'); pair(5, handle()); pair(330, id!); pair(100, 'AcDbEntity'); pair(8, '0'); pair(100, 'AcDbBlockBegin');
    pair(2, name!); pair(70, 0); pair(10, 0); pair(20, 0); pair(30, 0); pair(3, name!); pair(1, '');
    pair(0, 'ENDBLK'); pair(5, handle()); pair(330, id!); pair(100, 'AcDbEntity'); pair(8, '0'); pair(100, 'AcDbBlockEnd');
  }
  end(); section('ENTITIES');
  const xy = (p: VectorPoint, code = 10) => { pair(code, (p[0] - bounds.x) * scale); pair(code + 10, (bounds.y + bounds.height - p[1]) * scale); };
  const colorOf = (color: string) => {
    const hex = color.replace('#', '');
    if (!/^[\da-f]{6}([\da-f]{2})?$/i.test(hex)) throw new Error(`Cannot export DXF color ${color}.`);
    return { rgb: parseInt(hex.slice(0, 6), 16), alpha: hex.length === 8 ? parseInt(hex.slice(6), 16) : 255 };
  };
  const common = (type: string, item: LayoutVectorItem, color: string, subclass: string) => {
    const { rgb, alpha } = colorOf(color);
    if (!alpha) return false;
    pair(0, type); pair(5, handle()); pair(330, model); pair(100, 'AcDbEntity'); pair(8, layers.get(item.layer)!);
    if (options.colorByLayer) pair(62, 256); else pair(420, rgb);
    if (item.layerVisible === false && !options.createLayers) pair(60, 1);
    if (alpha !== 255) pair(440, 0x02000000 | alpha);
    if (item.kind === 'path' && item.stroke) {
      // DXF lineweight is one of a fixed set of hundredths of a millimeter; keep the closest supported weight.
      const weights = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
      pair(370, weights.reduce((best, w) => Math.abs(w - item.weight * 100) < Math.abs(best - item.weight * 100) ? w : best, 0));
      if (item.dash.length) pair(6, dashPatterns.get(item.dash.join(','))!.name);
    }
    pair(100, subclass); return true;
  };
  const spline = (edge: Edge, hatch: boolean) => {
    if (hatch) { pair(72, 4); pair(94, 3); pair(73, 0); pair(74, 0); pair(95, 8); pair(96, 4); }
    else { pair(70, 8); pair(71, 3); pair(72, 8); pair(73, 4); pair(74, 0); }
    for (const knot of [0, 0, 0, 0, 1, 1, 1, 1]) pair(40, knot);
    for (const p of [edge.a, ...edge.controls!, edge.b]) { xy(p); if (!hatch) pair(30, 0); }
    if (hatch) pair(97, 0);
  };
  for (const item of page.items) {
    if (item.kind === 'image') { warnings.add('Pictures and raster model views are omitted from DXF.'); continue; }
    if (item.clips.length) warnings.add('DXF does not retain text-box or picture clipping; clipped content can extend beyond its frame.');
    if (item.kind === 'text') {
      if (!item.text.trim()) continue;
      if (!common('TEXT', item, item.color, 'AcDbText')) continue;
      const point = vectorPoint(item.matrix, ...item.point);
      xy(point); pair(30, 0);
      const size = Number(item.font.match(/([\d.]+)px/)?.[1] ?? 10) * Math.hypot(item.matrix[2], item.matrix[3]) * scale;
      pair(40, size); pair(1, item.text.replace(/%/g, '%%037')); pair(50, -Math.atan2(item.matrix[1], item.matrix[0]) * 180 / Math.PI);
      pair(7, fonts.get(item.font)!);
      pair(72, item.align === 'center' ? 1 : item.align === 'right' || item.align === 'end' ? 2 : 0);
      xy(point, 11); pair(31, 0); pair(100, 'AcDbText');
      pair(73, item.baseline === 'middle' ? 2 : item.baseline === 'top' || item.baseline === 'hanging' ? 3 : item.baseline === 'bottom' ? 1 : 0);
      warnings.add('Text uses CAD fonts, which may substitute for the document fonts. Dimensions, labels, and tables are exported as drawing geometry and text.');
      continue;
    }
    const loops = contours(item.path);
    if (!options.ignoreFills && item.fill && loops.length && common('HATCH', item, item.fill, 'AcDbHatch')) {
      pair(10, 0); pair(20, 0); pair(30, 0); pair(210, 0); pair(220, 0); pair(230, 1);
      pair(2, 'SOLID'); pair(70, 1); pair(71, 0); pair(91, loops.length);
      for (const loop of loops) {
        const edges = [...loop.edges], first = edges[0]!.a, last = edges.at(-1)!.b;
        if (last[0] !== first[0] || last[1] !== first[1]) edges.push({ a: last, b: first });
        pair(92, 0); pair(93, edges.length);
        for (const edge of edges) {
          if (edge.controls) spline(edge, true);
          else { pair(72, 1); xy(edge.a); xy(edge.b, 11); }
        }
        pair(97, 0);
      }
      pair(75, 0); pair(76, 1); pair(98, 0);
    }
    if (item.stroke) for (const loop of loops) {
      if (loop.edges.every(e => !e.controls)) {
        if (!common('LWPOLYLINE', item, item.stroke, 'AcDbPolyline')) continue;
        const points = loop.edges.map(e => e.a);
        if (!loop.closed) points.push(loop.edges.at(-1)!.b);
        pair(90, points.length); pair(70, loop.closed ? 1 : 0); points.forEach(p => xy(p));
      } else for (const edge of loop.edges) {
        if (!common(edge.controls ? 'SPLINE' : 'LINE', item, item.stroke, edge.controls ? 'AcDbSpline' : 'AcDbLine')) continue;
        if (edge.controls) spline(edge, false);
        else { xy(edge.a); pair(30, 0); xy(edge.b, 11); pair(31, 0); }
      }
    }
  }
  end(); pair(0, 'EOF');
  return { text: `${output.join('\r\n')}\r\n`, warnings: [...warnings] };
}
