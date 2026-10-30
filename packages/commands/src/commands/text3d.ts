// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { Font, Glyph, PathCommand } from 'opentype.js/dist/opentype.mjs';
import { m4translation, MERGE_TOL, PushFormError } from '@pushform/core';
import type { DefId, Id, PlaneBasis, Vec2, Vec3 } from '@pushform/core';
import { polygonInteriorPoint, pointInPolygon, signedArea } from '@pushform/geom';
import type { PolygonsWithHoles } from '@pushform/geom';
import type { KernelComponent } from '@pushform/kernel';
import { bodyFromMesh, FaceFinder, loopPoints, SketchGraph } from '@pushform/model';
import type { DocumentState, Draft, EntityContainer } from '@pushform/model';
import { defineCommand } from '../registry/Command';
import type { AnyCommand, CommandContext } from '../registry/Command';
import { activeTagOpt, hostOf, kernelOf } from '../host/services';
import { currentFrame, draftContainerAt } from './context';
import { createDefinition, newInstance, uniqueDefinitionName } from './groups';
import { componentPlacement } from './components';
import { edgeAngleDeg } from './edges';

/** 3D Text: text set in a bundled font, as faces or solids, in a new component. */

export const TEXT3D_FONTS = ['sans', 'serif', 'mono'] as const;
export type Text3DFont = (typeof TEXT3D_FONTS)[number];
export const TEXT3D_FONT_NAMES: Readonly<Record<Text3DFont, string>> = { sans: 'Roboto', serif: 'Noto Serif', mono: 'Roboto Mono' };

/** Key in `CommandContext.services` for the font files (the UI serves the bundled fonts; tests read them from disk). */
export const SERVICE_FONTS = 'fonts';

/** The font files of one family and weight, in fallback order (Latin first, then Latin Extended). */
export interface FontSource {
  load(font: Text3DFont, bold: boolean): Promise<readonly ArrayBuffer[]>;
}

const parsed = new WeakMap<FontSource, Map<string, Promise<Font[]>>>();

function fontsFor(source: FontSource, font: Text3DFont, bold: boolean): Promise<Font[]> {
  let cache = parsed.get(source);
  if (!cache) parsed.set(source, (cache = new Map()));
  const key = `${font}/${bold ? 'bold' : 'regular'}`;
  let fonts = cache.get(key);
  if (!fonts) {
    // opentype.js loads with the first 3D text, not with the app
    fonts = Promise.all([import('opentype.js/dist/opentype.mjs'), source.load(font, bold)]).then(([{ parse }, buffers]) => buffers.map((b) => parse(b)));
    // a failed download is retried next time
    fonts.catch(() => cache.delete(key));
    cache.set(key, fonts);
  }
  return fonts;
}

export type Text3DAlign = 'left' | 'center' | 'right';

export interface TextOutlineOptions {
  /** Height of a capital letter, in meters. */
  readonly height: number;
  readonly align: Text3DAlign;
}

/** Points closer than this along an outline merge; well above `MERGE_TOL` so sketch vertices never collapse. */
const MIN_SEGMENT = 4 * MERGE_TOL;

/**
 * The text's outlines as polygons with holes (outer ring first), in meters on the XY plane, with the
 * bounds' lower-left corner at the origin. Each line is laid out glyph by glyph with the font's
 * advances and kerning; characters missing from the first font come from the next one; lines are
 * aligned within the widest.
 */
export function textOutlines(fonts: readonly Font[], text: string, opts: TextOutlineOptions): PolygonsWithHoles[] {
  const main = fonts[0];
  if (!main) throw new PushFormError('text3d.font', 'No font loaded');
  const scale = opts.height / capHeight(main);
  const lineAdvance = (main.ascender - main.descender + (main.tables.hhea?.lineGap ?? 0)) * scale;
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const laid = lines.map((line) => layoutLine(fonts, line, scale));
  const width = Math.max(0, ...laid.map((l) => l.width));
  const polys: PolygonsWithHoles[] = [];
  laid.forEach((line, i) => {
    const dx = opts.align === 'left' ? 0 : opts.align === 'center' ? (width - line.width) / 2 : width - line.width;
    const dy = -i * lineAdvance;
    for (const glyph of line.glyphs) for (const poly of groupRings(glyph)) polys.push(poly.map((r) => r.map(([x, y]) => [x! + dx, y! + dy])));
  });
  if (!polys.length) return [];
  let minX = Infinity, minY = Infinity;
  for (const poly of polys) for (const [x, y] of poly[0]!) { minX = Math.min(minX, x!); minY = Math.min(minY, y!); }
  return polys.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x! - minX, y! - minY])));
}

function capHeight(font: Font): number {
  const os2 = font.tables.os2?.sCapHeight;
  if (os2 && os2 > 0) return os2;
  const h = flattenCommands(font.charToGlyph('H').getPath(0, 0, font.unitsPerEm).commands, font.unitsPerEm / 500);
  const top = Math.max(0, ...h.flat().map((p) => p[1]!));
  return top > 0 ? top : font.unitsPerEm * 0.7;
}

/** A laid-out line: each glyph's rings, kept apart because neighbouring glyphs may overlap. */
interface LaidLine { readonly width: number; readonly glyphs: number[][][][] }

function layoutLine(fonts: readonly Font[], line: string, scale: number): LaidLine {
  const glyphs: number[][][][] = [];
  let x = 0;
  let prev: { font: Font; glyph: Glyph } | null = null;
  for (const ch of line) {
    const font = fonts.find((f) => f.charToGlyph(ch).index !== 0) ?? fonts[0]!;
    const glyph = font.charToGlyph(ch);
    if (prev && prev.font === font) x += kerning(font, prev.glyph, glyph) * scale;
    const em = font.unitsPerEm;
    const rings: number[][][] = [];
    for (const ring of flattenCommands(glyph.getPath(0, 0, em).commands, em / 1000)) {
      const cleaned = cleanRing(ring.map(([gx, gy]) => [x + gx! * scale, gy! * scale]));
      if (cleaned) rings.push(cleaned);
    }
    if (rings.length) glyphs.push(rings);
    x += (glyph.advanceWidth ?? 0) * scale;
    prev = { font, glyph };
  }
  return { width: x, glyphs };
}

function kerning(font: Font, left: Glyph, right: Glyph): number {
  try {
    return font.getKerningValue(left, right) || 0;
  } catch {
    // opentype.js does not read every GPOS lookup type; such pairs go unkerned
    return 0;
  }
}

/**
 * Path commands as closed rings with y up. Curves are cut into straight segments whose distance
 * from the curve stays under `tol` (font units).
 */
function flattenCommands(commands: readonly PathCommand[], tol: number): number[][][] {
  const rings: number[][][] = [];
  let ring: number[][] = [];
  let cx = 0, cy = 0;
  const close = (): void => {
    if (ring.length >= 3) rings.push(ring);
    ring = [];
  };
  const pieces = (deviation: number): number => Math.min(24, Math.max(1, Math.ceil(Math.sqrt(deviation / tol))));
  for (const c of commands) {
    const x = c.x ?? 0, y = -(c.y ?? 0);
    switch (c.type) {
      case 'M':
        close();
        ring.push([x, y]);
        break;
      case 'L':
        ring.push([x, y]);
        break;
      case 'Q': {
        const x1 = c.x1 ?? 0, y1 = -(c.y1 ?? 0);
        const n = pieces(Math.hypot(cx - 2 * x1 + x, cy - 2 * y1 + y) / 4);
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          ring.push([u * u * cx + 2 * u * t * x1 + t * t * x, u * u * cy + 2 * u * t * y1 + t * t * y]);
        }
        break;
      }
      case 'C': {
        const x1 = c.x1 ?? 0, y1 = -(c.y1 ?? 0), x2 = c.x2 ?? 0, y2 = -(c.y2 ?? 0);
        const n = pieces(0.75 * Math.max(Math.hypot(cx - 2 * x1 + x2, cy - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x, y1 - 2 * y2 + y)));
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          ring.push([
            u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
            u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
          ]);
        }
        break;
      }
      case 'Z':
        close();
        break;
    }
    if (c.type !== 'Z') { cx = x; cy = y; }
  }
  close();
  return rings;
}

/** A ring without repeated, closing or collinear points; null when nothing with area is left. */
function cleanRing(ring: number[][]): number[][] | null {
  let pts: number[][] = [];
  for (const p of ring) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0]! - last[0]!, p[1]! - last[1]!) > MIN_SEGMENT) pts.push(p);
  }
  while (pts.length > 1 && Math.hypot(pts[0]![0]! - pts[pts.length - 1]![0]!, pts[0]![1]! - pts[pts.length - 1]![1]!) <= MIN_SEGMENT) pts.pop();
  for (let changed = true; changed && pts.length >= 3;) {
    changed = false;
    const kept: number[][] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = kept[kept.length - 1] ?? pts[pts.length - 1]!, b = pts[i]!, c = pts[(i + 1) % pts.length]!;
      const cross = (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
      const len = Math.hypot(c[0]! - a[0]!, c[1]! - a[1]!);
      if (Math.abs(cross) <= MERGE_TOL * len) changed = true;
      else kept.push(b);
    }
    pts = kept;
  }
  if (pts.length < 3 || Math.abs(signedArea(pts)) <= MIN_SEGMENT * MIN_SEGMENT) return null;
  return pts;
}

/**
 * Rings grouped into polygons with holes by nesting depth: a ring inside an even number of others
 * is an outline, one inside an odd number is a hole in the smallest outline around it (the even-odd
 * rule, which reads TrueType and CFF windings alike).
 */
function groupRings(rings: readonly number[][][]): PolygonsWithHoles[] {
  const area = rings.map((r) => Math.abs(signedArea(r)));
  const probe = rings.map((r): Vec2 => polygonInteriorPoint([r]) ?? [r[0]![0]!, r[0]![1]!]);
  const inside = (i: number, j: number): boolean => i !== j && area[j]! > area[i]! && pointInPolygon(probe[i]!, [rings[j]!]);
  const depth = rings.map((_, i) => rings.reduce((n, _r, j) => n + (inside(i, j) ? 1 : 0), 0));
  const polys = new Map<number, number[][][]>();
  rings.forEach((r, i) => { if (depth[i]! % 2 === 0) polys.set(i, [r]); });
  rings.forEach((r, i) => {
    if (depth[i]! % 2 === 0) return;
    let best = -1;
    for (const j of polys.keys()) if (depth[j] === depth[i]! - 1 && inside(i, j) && (best < 0 || area[j]! < area[best]!)) best = j;
    if (best >= 0) polys.get(best)!.push(r);
  });
  return [...polys.values()];
}

const XY: PlaneBasis = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };

/** Side edges of extruded text up to this angle are soft and smooth, so curves read as curves. */
const SOFT_DEG = 20;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const Text3DParamsSchema = z.object({
  text: z.string().max(2000).refine((s) => s.trim().length > 0, 'Enter some text'),
  font: z.enum(TEXT3D_FONTS).default('sans'),
  bold: z.boolean().default(false),
  align: z.enum(['left', 'center', 'right']).default('left'),
  /** Capital height in meters. */
  height: z.number().min(0.001).max(1000).default(0.3048),
  filled: z.boolean().default(true),
  /** Extrusion in meters; 0 leaves flat text. Negative extrudes below the placement plane. */
  extrude: z.number().min(-1000).max(1000).default(0),
  /** World point to place the text at; omitted, the text follows the cursor until a click places it (at the origin without a tool manager). */
  point: vec3.optional(),
});

export interface Text3DResult {
  readonly definitionId: number;
  /** The placed instance, or null while the Place Component tool carries it. */
  readonly instanceId: number | null;
}

/**
 * Create 3D text. The outlines become a new component: solids when extruded,
 * faces when filled, edges otherwise. One undo step creates the component; placing it with the
 * cursor (or at `point`) is the next.
 */
export const text3dCreate = defineCommand({
  id: 'text3d.create',
  title: '3D Text',
  category: 'internal',
  params: Text3DParamsSchema,
  undoable: false,
  async run(ctx: CommandContext, p): Promise<Text3DResult> {
    const host = hostOf(ctx);
    const source = ctx.services.get(SERVICE_FONTS) as FontSource | undefined;
    if (!source) throw new PushFormError('service.missing', 'Font service missing');
    const fonts = await fontsFor(source, p.font, p.bold);
    const polys = textOutlines(fonts, p.text, { height: p.height, align: p.align });
    if (!polys.length) throw new PushFormError('text3d.empty', 'The text has no visible characters');
    const extruded = Math.abs(p.extrude) >= MIN_SEGMENT;
    const solids: KernelComponent[] = [];
    if (extruded) {
      // Manifold's own extrude triangulates the caps robustly; one solid per outline
      const kernel = kernelOf(ctx);
      for (const polygon of polys) {
        const res = await kernel.extrudeSketch({ basis: XY, polygon, distance: p.extrude, nextFaceId: 0 });
        solids.push(...res.components);
      }
    }
    const tag = activeTagOpt(ctx);
    const name = p.text.trim().split(/\r?\n/)[0]!.trim().slice(0, 40);
    const path = host.context.path;
    let definitionId = 0 as DefId;
    let instanceId: Id | null = null;
    host.edit('3D Text', (draft) => {
      const def = createDefinition(draft, { name: uniqueDefinitionName(draft as unknown as DocumentState, name), isGroup: false, description: p.text });
      definitionId = def.id;
      const container = def.entities as unknown as Draft<EntityContainer>;
      if (extruded) {
        for (const c of solids) {
          const body = bodyFromMesh(draft, c.mesh, { container, ...tag });
          for (const e of body.edges.values()) {
            const deg = edgeAngleDeg(body, e);
            if (deg !== null && deg <= SOFT_DEG) { e.soft = true; e.smooth = true; }
          }
        }
      } else {
        drawOutlines(SketchGraph.for(draft, def.id), polys, p.filled, tag);
      }
      const at = p.point ?? (ctx.tools ? null : [0, 0, 0]);
      if (at) {
        const inst = newInstance(draft, def.id, m4translation(currentFrame(host).toLocal(at as Vec3)));
        const into = draftContainerAt(draft, path);
        into.instances.set(inst.id, inst);
        into.order.push(inst.id);
        instanceId = inst.id;
      }
    });
    if (instanceId !== null) host.selection.set([{ kind: 'instance', path, id: instanceId }]);
    else {
      componentPlacement.current = definitionId;
      ctx.tools?.activate('placeComponent');
    }
    return { definitionId, instanceId };
  },
});

/** Outline edges on the XY plane; with `filled`, faces inside the outlines (never inside holes). */
function drawOutlines(g: SketchGraph, polys: readonly PolygonsWithHoles[], filled: boolean, tag: ReturnType<typeof activeTagOpt>): void {
  const edges: Id[] = [];
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
        edges.push(...g.addEdge([a[0]!, a[1]!, 0], [b[0]!, b[1]!, 0], { findFaces: false, ...tag }));
      }
    }
  }
  if (!filled || !edges.length) return;
  for (const faceId of FaceFinder.onEdgesAdded(g, edges)) {
    const face = g.sketch.faces.get(faceId);
    if (!face) continue;
    const rings = face.loops.map((l) => loopPoints(g.sketch, l).map((p) => [p[0], p[1]]));
    const probe = polygonInteriorPoint(rings);
    if (!probe || !polys.some((poly) => pointInPolygon(probe, poly))) g.removeFace(faceId);
  }
}

export const text3dCommands: readonly AnyCommand[] = [text3dCreate];
