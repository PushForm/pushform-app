// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { entitiesForLayer, layoutPaperUnits, isLayoutLayerVisible, layoutPathArrows, layoutPathContours, pathSegment, type LayoutDocumentState, type LayoutPage } from '@pushform/layout';
import { vectorPoint, type LayoutVectorIdentity, type LayoutVectorItem, type LayoutVectorPage, type VectorMatrix, type VectorPath } from '@pushform/io';
import { paintLayoutText, type LayoutPaintedGlyph } from './layoutText';
import { paintLayoutDimension, paintAngularDimension } from './layoutDimension';
import { paintLayoutTable } from './layoutTable';
import { paintLayoutImage } from './layoutImage';
import { layoutViewportPicture } from './layoutViewportRenders';

/** The Canvas2D operations used by Layout's content painters, recorded without rasterizing paths or text. */
export class LayoutVectorRecorder {
  items: LayoutVectorItem[] = [];
  layer = '';
  object: LayoutVectorIdentity = {};
  private nextTextBlock = 1;
  private path: VectorPath = { segments: [] };
  private state = {
    matrix: [1, 0, 0, 1, 0, 0] as VectorMatrix, clips: [] as VectorPath[],
    fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, dash: [] as number[],
    font: '10px sans-serif', textAlign: 'left' as CanvasTextAlign, textBaseline: 'alphabetic' as CanvasTextBaseline,
  };
  private stack: typeof this.state[] = [];
  constructor(private measure: CanvasRenderingContext2D | null) {}
  get fillStyle(): string { return this.state.fillStyle; }
  set fillStyle(value: string) { this.state.fillStyle = value; }
  get strokeStyle(): string { return this.state.strokeStyle; }
  set strokeStyle(value: string) { this.state.strokeStyle = value; }
  get lineWidth(): number { return this.state.lineWidth; }
  set lineWidth(value: number) { this.state.lineWidth = value; }
  get font(): string { return this.state.font; }
  set font(value: string) { this.state.font = value; }
  get textAlign(): CanvasTextAlign { return this.state.textAlign; }
  set textAlign(value: CanvasTextAlign) { this.state.textAlign = value; }
  get textBaseline(): CanvasTextBaseline { return this.state.textBaseline; }
  set textBaseline(value: CanvasTextBaseline) { this.state.textBaseline = value; }
  save(): void { this.stack.push({ ...this.state, matrix: [...this.state.matrix], clips: [...this.state.clips], dash: [...this.state.dash] }); }
  restore(): void { this.state = this.stack.pop() ?? this.state; }
  setLineDash(dash: number[]): void { this.state.dash = [...dash]; }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const m = this.state.matrix;
    this.state.matrix = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, ...vectorPoint(m, e, f)];
  }
  translate(x: number, y: number): void { this.transform(1, 0, 0, 1, x, y); }
  rotate(angle: number): void { this.transform(Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0); }
  // Existing painters use this only to keep zero-weight strokes visible. Vector hairlines are 0.01 mm.
  getTransform(): { a: number; b: number } { return { a: this.state.matrix[0] * 100, b: this.state.matrix[1] * 100 }; }
  beginPath(): void { this.path = { segments: [] }; }
  moveTo(x: number, y: number): void { this.path.segments.push({ kind: 'move', point: vectorPoint(this.state.matrix, x, y) }); }
  lineTo(x: number, y: number): void { this.path.segments.push({ kind: 'line', point: vectorPoint(this.state.matrix, x, y) }); }
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    this.path.segments.push({ kind: 'cubic', c1: vectorPoint(this.state.matrix, x1, y1), c2: vectorPoint(this.state.matrix, x2, y2), point: vectorPoint(this.state.matrix, x, y) });
  }
  closePath(): void { this.path.segments.push({ kind: 'close' }); }
  rect(x: number, y: number, w: number, h: number): void { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath(); }
  arc(x: number, y: number, r: number, start: number, end: number, anticlockwise = false): void {
    const turn = Math.PI * 2, raw = end - start;
    let sweep = raw;
    if (!anticlockwise && raw >= turn) sweep = turn;
    else if (anticlockwise && raw <= -turn) sweep = -turn;
    else { sweep %= turn; if (anticlockwise && sweep > 0) sweep -= turn; if (!anticlockwise && sweep < 0) sweep += turn; }
    const first = [x + r * Math.cos(start), y + r * Math.sin(start)] as const;
    if (this.path.segments.length) this.lineTo(...first); else this.moveTo(...first);
    const steps = Math.ceil(Math.abs(sweep) / (Math.PI / 2));
    for (let i = 0; i < steps; i++) {
      const a = start + sweep * i / steps, b = start + sweep * (i + 1) / steps, k = 4 / 3 * Math.tan((b - a) / 4);
      this.bezierCurveTo(x + r * (Math.cos(a) - k * Math.sin(a)), y + r * (Math.sin(a) + k * Math.cos(a)),
        x + r * (Math.cos(b) + k * Math.sin(b)), y + r * (Math.sin(b) - k * Math.cos(b)), x + r * Math.cos(b), y + r * Math.sin(b));
    }
  }
  clip(): void { this.state.clips.push({ segments: [...this.path.segments] }); }
  private record(fill: string | null, stroke: string | null, evenodd = false): void {
    const scale = Math.hypot(this.state.matrix[0], this.state.matrix[1]);
    const weight = Math.max(this.lineWidth * scale, 0.01), dash = this.state.dash.map(n => n * scale);
    const previous = this.items.at(-1);
    // Canvas paints a shape's fill and stroke separately. SVG can retain both on one editable path.
    if (stroke && previous?.kind === 'path' && previous.fill && !previous.stroke
      && previous.objectId === this.object.objectId && previous.layer === this.layer
      && previous.path.segments.length === this.path.segments.length
      && previous.path.segments.every((segment, i) => segment === this.path.segments[i])
      && previous.clips.length === this.state.clips.length && previous.clips.every((clip, i) => clip === this.state.clips[i])) {
      previous.stroke = stroke; previous.weight = weight; previous.dash = dash;
      return;
    }
    this.items.push({ ...this.object, kind: 'path', path: { segments: [...this.path.segments] }, fill, stroke, evenodd,
      weight, dash, layer: this.layer, clips: [...this.state.clips] });
  }
  fill(rule?: CanvasFillRule): void { this.record(this.fillStyle, null, rule === 'evenodd'); }
  stroke(): void { this.record(null, this.strokeStyle); }
  fillRect(x: number, y: number, w: number, h: number): void {
    const previous = this.path; this.beginPath(); this.rect(x, y, w, h); this.fill(); this.path = previous;
  }
  measureText(text: string): TextMetrics {
    if (!this.measure) throw new Error('The drawing text could not be measured.');
    this.measure.font = this.font; return this.measure.measureText(text);
  }
  fillText(text: string, x: number, y: number): void {
    const metrics = this.measureText(text), size = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 10);
    const width = metrics.width, ascent = metrics.actualBoundingBoxAscent ?? size * 0.905, descent = metrics.actualBoundingBoxDescent ?? size * 0.212;
    const left = x - (this.textAlign === 'center' ? width / 2 : this.textAlign === 'right' || this.textAlign === 'end' ? width : 0);
    const top = this.textBaseline === 'top' || this.textBaseline === 'hanging' ? y : this.textBaseline === 'middle' ? y - (ascent + descent) / 2 : this.textBaseline === 'bottom' ? y - ascent - descent : y - ascent;
    this.items.push({ ...this.object, kind: 'text', text, point: [x, y], matrix: [...this.state.matrix], font: this.font,
      color: this.fillStyle, align: this.textAlign, baseline: this.textBaseline, bounds: [left, top, left + width, top + ascent + descent], layer: this.layer, clips: [...this.state.clips] });
  }
  textBlock = (glyphs: LayoutPaintedGlyph[]): void => {
    const textBlockId = this.nextTextBlock++;
    for (const glyph of glyphs) {
      this.font = glyph.font; this.fillStyle = glyph.color;
      this.fillText(glyph.text, glyph.x, glyph.y);
      const item = this.items.at(-1)!;
      if (item.kind === 'text') { item.textBlockId = textBlockId; item.underline = glyph.underline; }
    }
  };
  drawImage(image: HTMLImageElement | HTMLCanvasElement, x: number, y: number, width: number, height: number): void {
    const src = image instanceof HTMLCanvasElement ? image.toDataURL('image/png') : image.src;
    this.items.push({ ...this.object, kind: 'image', src, matrix: [...this.state.matrix], x, y, width, height, layer: this.layer, clips: [...this.state.clips] });
  }
}

export function drawLayoutVectorPage(state: LayoutDocumentState, page: LayoutPage, options: { includeInvisibleLayers?: boolean; includeImages?: boolean; editableTextBlocks?: boolean; exportDpi?: number; entityIds?: ReadonlySet<number> } = {}): LayoutVectorPage {
  const measure = document.createElement('canvas').getContext('2d');
  const recorder = new LayoutVectorRecorder(measure);
  // Content painters use exactly the Canvas2D subset above; selection and editor overlays are never recorded.
  const ctx = recorder as unknown as CanvasRenderingContext2D;
  const paintTextBlock = options.editableTextBlocks === false ? undefined : recorder.textBlock;
  for (const layerId of state.layerOrder) {
    const visible = isLayoutLayerVisible(page, state, layerId);
    if (!visible && !options.includeInvisibleLayers) continue;
    const layerPage = visible ? page : { ...page, layerVisibility: new Map([...page.layerVisibility ?? [], [layerId, true]]) };
    recorder.layer = state.layers.get(layerId)!.name;
    const firstItem = recorder.items.length;
    for (const entity of entitiesForLayer(layerPage, state, layerId)) {
      if (!entity.points.length || options.entityIds && !options.entityIds.has(entity.id)) continue;
      recorder.object = { objectId: entity.id, groupIds: entity.groupId === undefined ? [] : [entity.groupId, ...(entity.nestedGroupIds ?? [])] };
      if (entity.dimension) { paintLayoutDimension(ctx, entity); continue; }
      if (entity.angularDimension) { paintAngularDimension(ctx, entity); continue; }
      if (entity.table) { paintLayoutTable(ctx, entity, page, state, false, paintTextBlock); continue; }
      if (entity.image) {
        if (options.includeImages === false) recorder.items.push({ ...recorder.object, kind: 'image', src: '', x: 0, y: 0, width: 0, height: 0, matrix: [1, 0, 0, 1, 0, 0], clips: [], layer: recorder.layer });
        else paintLayoutImage(ctx, entity, false, layoutViewportPicture(state, entity, undefined, options.exportDpi === undefined ? undefined : options.exportDpi / 25.4, options.exportDpi !== undefined));
        continue;
      }
      if (entity.text) { paintLayoutText(ctx, entity, page, state, false, paintTextBlock); continue; }
      const arrows = layoutPathArrows(entity.points, entity.handles, entity.closed, entity.style);
      const trace = (openContours?: number[]) => {
        ctx.beginPath();
        for (const contour of layoutPathContours(arrows.points, entity.handles, entity.closed, entity.contourStarts, openContours)) {
          if (!contour.points.length) continue;
          ctx.moveTo(...contour.points[0]!);
          for (let i = 0; i < contour.points.length - (contour.closed ? 0 : 1); i++) {
            const s = pathSegment(contour.points, contour.handles, i, contour.closed);
            if (s.curved) ctx.bezierCurveTo(...s.c1, ...s.c2, ...s.b); else ctx.lineTo(...s.b);
          }
          if (contour.closed) ctx.closePath();
        }
      };
      trace();
      if (entity.closed && entity.style?.fillColor) { ctx.fillStyle = entity.style.fillColor; ctx.fill(entity.contourStarts ? 'evenodd' : 'nonzero'); }
      if (entity.openContours) trace(entity.openContours);
      ctx.strokeStyle = entity.style?.strokeColor ?? state.defaultStyle.strokeColor;
      ctx.lineWidth = (entity.style?.strokeWeightPt ?? state.defaultStyle.strokeWeightPt) * 25.4 / 72;
      ctx.setLineDash(entity.style?.strokeDashMm ?? []); ctx.stroke(); ctx.setLineDash([]);
      for (const arrow of arrows.shapes) {
        ctx.beginPath(); ctx.moveTo(...arrow.points[0]!); arrow.points.slice(1).forEach(p => ctx.lineTo(...p));
        if (arrow.closed) ctx.closePath();
        if (arrow.filled) { ctx.fillStyle = ctx.strokeStyle; ctx.fill(); } ctx.stroke();
      }
    }
    for (let i = firstItem; i < recorder.items.length; i++) recorder.items[i]!.layerVisible = visible;
  }
  return { name: page.name, paperUnits: layoutPaperUnits(state), width: page.size[0], height: page.size[1], background: page.background, items: recorder.items };
}
