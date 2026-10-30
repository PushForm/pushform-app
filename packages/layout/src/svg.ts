// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import paper from 'paper/dist/paper-core';
import { LENGTH_TOL } from '@pushform/core';
import { LAYOUT_DEFAULT_TEXT } from './text';
import type { LayoutEntity, LayoutPathHandle } from './LayoutDocument';

/** Convert SVG artwork to editable geometry; unsupported effects fail without flattening the drawing. */
export function importLayoutSvg(root: SVGElement, maxSize: readonly [number, number]): LayoutEntity[] | null {
  const unsupported = (feature: string): never => { throw new Error(`Editable SVG paste does not yet support ${feature}. Use Import to place this artwork as an image.`); };
  const referenced = new Set<Element>();
  const inspect = (node: Element): void => {
    if (referenced.has(node)) return;
    referenced.add(node);
    if (node.localName === 'image') unsupported('embedded images');
    for (const name of ['mask', 'filter']) {
      const value = node.getAttribute(name) || (node as SVGElement).style?.getPropertyValue(name);
      if (value && value !== 'none') unsupported(`${name} effects`);
    }
    for (const name of ['fill', 'stroke', 'clip-path']) {
      const value = node.getAttribute(name) || (node as SVGElement).style?.getPropertyValue(name) || '';
      const reference = value.match(/url\(\s*['"]?#([^)'"\s]+)/)?.[1];
      const target = reference ? root.ownerDocument.getElementById(reference) : null;
      if (target && ['linearGradient', 'radialGradient', 'pattern'].includes(target.localName)) unsupported('gradients or patterns');
      if (target?.getAttribute('clipPathUnits') === 'objectBoundingBox') unsupported('object-bounding-box clips');
    }
    if (node.localName === 'use') {
      const reference = node.getAttribute('href') || node.getAttribute('xlink:href');
      const target = reference?.startsWith('#') ? root.ownerDocument.getElementById(reference.slice(1)) : null;
      if (target) inspect(target);
    }
    for (const child of Array.from(node.children)) if (!['defs', 'clipPath', 'metadata', 'namedview'].includes(child.localName)) inspect(child);
  };
  inspect(root);
  root = root.cloneNode(true) as SVGElement;
  root.querySelectorAll('defs linearGradient, defs radialGradient, defs pattern, defs filter, defs mask').forEach(node => node.remove());
  const engine = new paper.PaperScope();
  engine.setup(new paper.Size(1, 1));
  engine.view.autoUpdate = false;
  engine.settings.insertItems = false;
  engine.settings.applyMatrix = false;
  const entities: LayoutEntity[] = [];
  const xy = (point: paper.Point): [number, number] => [point.x, point.y];
  const color = (value: paper.Color | null, opacity: number): string | null => {
    if (!value) return null;
    const copy = value.clone(); copy.alpha *= opacity;
    return copy.toCSS(true);
  };
  const worldPath = (item: paper.PathItem): paper.PathItem => {
    const paths = item instanceof engine.Path ? [item] : item.children as paper.Path[];
    const result = paths.map(path => new engine.Path({ insert: false, closed: path.closed,
      segments: path.segments.map(segment => {
        const point = path.localToGlobal(segment.point);
        return new engine.Segment(point, path.localToGlobal(segment.point.add(segment.handleIn)).subtract(point),
          path.localToGlobal(segment.point.add(segment.handleOut)).subtract(point));
      }) }));
    const shape = result.length === 1 ? result[0]! : new engine.CompoundPath({ children: result, insert: false });
    shape.fillRule = item.fillRule;
    return shape;
  };
  const emit = (geometry: paper.PathItem, style: NonNullable<LayoutEntity['style']>): void => {
    const contours = (geometry instanceof engine.Path ? [geometry] : geometry.children as paper.Path[]).filter(path => path.segments.length >= 2);
    const points: [number, number][] = [], handles: LayoutPathHandle[] = [], contourStarts: number[] = [], openContours: number[] = [];
    contours.forEach(path => {
      // Closed two-arc lenses need a third anchor in the native document format.
      if (path.closed && path.segments.length === 2) path.curves[0]!.divideAtTime(0.5);
      contourStarts.push(points.length);
      if (!path.closed) openContours.push(contourStarts.length - 1);
      for (const segment of path.segments) {
        points.push(xy(segment.point));
        handles.push({ ...(segment.handleIn.isZero() ? {} : { in: xy(segment.point.add(segment.handleIn)) }),
          ...(segment.handleOut.isZero() ? {} : { out: xy(segment.point.add(segment.handleOut)) }) });
      }
    });
    if (!points.length) return;
    entities.push({ id: 0, layerId: 0, kind: 'path', points, handles, closed: contours.length > 1 || contours[0]!.closed,
      ...(contourStarts.length > 1 ? { contourStarts, ...(openContours.length ? { openContours } : {}) } : {}), style });
  };
  const visit = (item: paper.Item, opacity: number, clip: paper.PathItem | null = null): void => {
    if (!item.visible || item.opacity === 0 || item.clipMask) return;
    opacity *= item.opacity;
    if (item instanceof engine.Path || item instanceof engine.CompoundPath) {
      if (item.fillColor?.type === 'gradient' || item.strokeColor?.type === 'gradient') unsupported('gradients');
      const geometry = worldPath(item);
      const scale = item.globalMatrix.scaling;
      const style = { fillColor: color(item.fillColor, opacity), strokeColor: color(item.strokeColor, opacity) ?? '#00000000',
        strokeWeightPt: item.strokeWidth * Math.max(Math.abs(scale.x), Math.abs(scale.y)) * 0.75,
        ...(item.dashArray.length ? { strokeDashMm: item.dashArray.map(n => n * Math.max(Math.abs(scale.x), Math.abs(scale.y))) } : {}) };
      // Preserve the original object when the clip covers it entirely (including ordinary root viewBox clips).
      const bounds = new engine.Path.Rectangle({ rectangle: geometry.bounds, insert: false });
      const corners = [geometry.bounds.topLeft, geometry.bounds.topRight, geometry.bounds.bottomLeft, geometry.bounds.bottomRight];
      const boundary = clip;
      // A horizontal/vertical line has an empty bounds area, so subtraction alone cannot prove containment.
      if (!boundary || corners.every(point => boundary.contains(point)) && bounds.subtract(boundary, { insert: false }).isEmpty()) emit(geometry, style);
      else {
        if (style.fillColor) emit(geometry.intersect(boundary, { insert: false }), { ...style, strokeColor: '#00000000' });
        if (item.strokeColor) emit(geometry.intersect(boundary, { insert: false, trace: false }), { ...style, fillColor: null });
      }
    } else if (item instanceof engine.PointText) {
      if (!item.content) return;
      const frame = new engine.Path.Rectangle({ rectangle: item.bounds, insert: false });
      if (item.parent) frame.transform(item.parent.globalMatrix);
      if (clip && !frame.subtract(clip, { insert: false }).isEmpty()) unsupported('partially clipped text');
      const bounds = frame.bounds, point = item.localToGlobal(item.point);
      const size = (Number(item.fontSize) || 12) * Math.abs(item.globalMatrix.scaling.y);
      const width = Math.max(bounds.width, size), height = Math.max(bounds.height, size);
      entities.push({ id: 0, layerId: 0, kind: 'text', closed: false,
        points: [[bounds.left, point.y - size], [bounds.left + width, point.y - size + height]],
        text: { ...LAYOUT_DEFAULT_TEXT, content: item.content, fontFamily: item.fontFamily || 'sans-serif', fontSizePt: size * 0.75,
          color: color(item.fillColor, opacity) ?? '#000000', bold: item.fontWeight === 'bold', italic: false, underline: false,
          bounded: false, align: item.justification === 'center' ? 'center' : item.justification === 'right' ? 'right' : 'left',
          vertical: 'top', leader: 'none', endpoint: 'none', rotationDeg: item.globalMatrix.rotation } });
    } else if (item instanceof engine.Raster) unsupported('embedded images');
    else {
      const mask = item.children?.find(child => child.clipMask);
      if (mask) {
        const clipPath = mask instanceof engine.Shape ? mask.toPath(false) : mask;
        if (mask instanceof engine.Shape && mask.parent) clipPath.transform(mask.parent.globalMatrix);
        if (!(clipPath instanceof engine.Path || clipPath instanceof engine.CompoundPath)) unsupported('this clipping geometry');
        const boundary = worldPath(clipPath as paper.PathItem);
        clip = clip ? clip.intersect(boundary, { insert: false }) : boundary;
      }
      item.children?.forEach(child => visit(child, opacity, clip));
    }
  };
  try {
    const item = engine.project.importSVG(root, { insert: false, expandShapes: true, applyMatrix: false });
    if (!item) throw new Error('The pasted SVG is invalid.');
    visit(item, 1);
    if (!entities.length) return null;
    const all = entities.flatMap(entity => [...entity.points, ...(entity.handles ?? []).flatMap(handle => [handle.in, handle.out].filter((p): p is [number, number] => Boolean(p)))]);
    if (!all.every(point => point.every(Number.isFinite))) throw new Error('The pasted SVG has invalid geometry.');
    const minX = Math.min(...all.map(p => p[0])), minY = Math.min(...all.map(p => p[1]));
    const width = Math.max(...all.map(p => p[0])) - minX, height = Math.max(...all.map(p => p[1])) - minY;
    const scale = Math.min(25.4 / 96, maxSize[0] / Math.max(width, LENGTH_TOL * 1000), maxSize[1] / Math.max(height, LENGTH_TOL * 1000));
    const transform = (p: [number, number]): [number, number] => [(p[0] - minX) * scale, (p[1] - minY) * scale];
    return entities.map(entity => ({ ...entity, points: entity.points.map(transform),
      ...(entity.handles ? { handles: entity.handles.map(handle => ({ ...(handle.in ? { in: transform(handle.in) } : {}), ...(handle.out ? { out: transform(handle.out) } : {}) })) } : {}),
      ...(entity.style ? { style: { ...entity.style, strokeWeightPt: entity.style.strokeWeightPt * scale / (25.4 / 96),
        ...(entity.style.strokeDashMm ? { strokeDashMm: entity.style.strokeDashMm.map(n => n * scale) } : {}) } } : {}),
      ...(entity.text ? { text: { ...entity.text, fontSizePt: entity.text.fontSizePt * scale / (25.4 / 96) } } : {}) }));
  } finally { engine.project.remove(); }
}
