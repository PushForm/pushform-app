// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ExtensionError, uiExportSchema, uiPrintSchema, type ExtensionManifest, type UiNode, type UiVector, type UiVectorStyle } from '@pushform/extension-protocol';
import { writeLayoutDxf, writeLayoutSvg, type LayoutVectorItem, type LayoutVectorPage, type VectorPath, type VectorPoint } from '@pushform/io/vector';
import type { ServiceImplementations } from './host';
import type { FilePicker } from './io';
import { findNode as findInTree, type ExtensionUiHost } from './ui';

/**
 * Exports of a vector view, written by the host from the validated drawing on screen with the same SVG and DXF writers
 * as Layout's exports. The extension never supplies SVG or DXF text, so nothing it sends can become markup or a file
 * entity it did not describe as a shape.
 *
 * The drawing becomes one page in millimeters (`length` coordinates are meters; `plain` ones are taken as
 * millimeters), with one layer per style. Stroke widths of 1 screen pixel become 0.25 mm. Hatched styles are written
 * as a light fill, because DXF keeps no clipping for hatch lines.
 */

const MM_PER_M = 1000;
const PX_MM = 0.25;
const HATCH_FILL = '#e6e6e6';

/**
 * The drawing as one page in millimeters. With `paper` (millimeters), the page has that size and the drawing is
 * centered on it: a `length` drawing at its real size when it fits and scaled down when it does not, a `plain` one
 * scaled to fit.
 */
export function vectorPage(vector: UiVector, paper?: { width: number; height: number }): LayoutVectorPage {
  const units = vector.units === 'length' ? MM_PER_M : 1;
  const { x: ox, y: oy } = vector.bounds;
  const drawn = { width: vector.bounds.width * units, height: vector.bounds.height * units };
  const fit = paper ? Math.min(paper.width / drawn.width, paper.height / drawn.height) : 1;
  const scale = units * (paper && vector.units === 'length' ? Math.min(1, fit) : fit);
  const dx = paper ? (paper.width - vector.bounds.width * scale) / 2 : 0;
  const dy = paper ? (paper.height - vector.bounds.height * scale) / 2 : 0;
  const at = (x: number, y: number): VectorPoint => [(x - ox) * scale + dx, (y - oy) * scale + dy];
  const alpha = (color: string, style: UiVectorStyle): string =>
    style.opacity === undefined ? color : `${color}${Math.round(style.opacity * 255).toString(16).padStart(2, '0')}`;
  const items: LayoutVectorItem[] = [];
  for (const shape of vector.shapes) {
    const style = vector.styles[shape.style]!;
    const layer = `Style ${shape.style + 1}`;
    if (shape.kind === 'text') {
      const radians = ((shape.angle ?? 0) * Math.PI) / 180;
      const [px, py] = at(shape.x, shape.y);
      const size = shape.size * scale;
      items.push({ kind: 'text', layer, clips: [], text: shape.text, point: [0, 0],
        matrix: [Math.cos(radians), -Math.sin(radians), Math.sin(radians), Math.cos(radians), px, py],
        font: `${style.fontWeight === 'bold' ? 'bold ' : ''}${size}px "Arial"`, color: alpha(style.fill ?? '#000000', style),
        align: shape.anchor === 'middle' ? 'center' : shape.anchor === 'end' ? 'end' : 'start', baseline: 'alphabetic',
        bounds: [px, py - size, size * shape.text.length * 0.6, size] });
      continue;
    }
    const corners: VectorPoint[] = shape.kind === 'rect'
      ? [at(shape.x, shape.y), at(shape.x + shape.width, shape.y), at(shape.x + shape.width, shape.y + shape.height), at(shape.x, shape.y + shape.height)]
      : Array.from({ length: shape.points.length / 2 }, (_, i) => at(shape.points[2 * i]!, shape.points[2 * i + 1]!));
    const closed = shape.kind === 'rect' || !!shape.closed;
    const segments: VectorPath['segments'] = corners.map((point, i) => ({ kind: i ? 'line' : 'move', point }));
    if (closed) segments.push({ kind: 'close' });
    const fill = style.hatch ? HATCH_FILL : style.fill ?? null;
    const stroke = style.stroke ?? (fill ? null : '#000000');
    items.push({ kind: 'path', layer, clips: [], path: { segments }, evenodd: false,
      fill: fill && closed ? alpha(fill, style) : null, stroke: stroke ? alpha(stroke, style) : null,
      weight: (style.strokeWidth ?? 1) * PX_MM, dash: style.dash === 'dashed' ? [4, 2] : style.dash === 'dotted' ? [0.5, 1.5] : [] });
  }
  const size = paper ?? { width: vector.bounds.width * scale, height: vector.bounds.height * scale };
  return { paperUnits: 'mm', name: vector.label, width: size.width, height: size.height, background: '#ffffff', items };
}

export const vectorToSvg = (vector: UiVector): string => writeLayoutSvg(vectorPage(vector), 'page');
export const vectorToDxf = (vector: UiVector): string => writeLayoutDxf(vectorPage(vector), 'page').text;

/** `ui.export`: writes a vector view the extension has on screen, as SVG or DXF, where the user chooses. */
export function vectorExportServices(manifest: ExtensionManifest, ui: () => ExtensionUiHost, picker: FilePicker): ServiceImplementations {
  return {
    'ui.export': async (input) => {
      const parsed = uiExportSchema.safeParse(input);
      if (!parsed.success) throw new ExtensionError('validation.failed', 'ui.export needs a target, a component, a format ("svg" or "dxf") and a purpose.');
      const { target, component, format, purpose, suggestedName } = parsed.data;
      const shown = ui().get(target);
      const node: UiNode | undefined = shown ? findInTree(shown.tree, component) : undefined;
      if (!node || node.type !== 'vector') throw new ExtensionError('validation.failed', `"${component}" is not a vector view shown in "${target}".`);
      const text = format === 'svg' ? vectorToSvg(node) : vectorToDxf(node);
      // File names keep no path separators, reserved characters or control characters.
      // eslint-disable-next-line no-control-regex
      const unsafe = /[/\\:*?"<>|\u0000-\u001f]/g;
      const name = suggestedName && suggestedName.replace(unsafe, '') === suggestedName ? suggestedName : `${node.label}.${format}`.replace(unsafe, '-');
      const saved = await picker.save({
        extensionName: manifest.name, kind: 'save', purpose,
        accept: [format === 'svg' ? { description: 'SVG drawing', extensions: ['svg'] } : { description: 'DXF drawing', extensions: ['dxf'] }],
        suggestedName: name,
      }, new TextEncoder().encode(text));
      if (!saved) throw new ExtensionError('cancelled', 'The drawing was not saved.');
      return { name: saved.name };
    },
  };
}

/** What PushForm shows and prints for `ui.print`; the extension never sees the pages or the outcome's details. */
export interface PrintRequest {
  readonly extensionName: string;
  readonly purpose: string;
  readonly title: string;
  /** Page size in millimeters. */
  readonly page: { readonly width: number; readonly height: number };
  readonly pages: readonly LayoutVectorPage[];
}

/** The host's print dialog: resolves with what the user did, or null when they cancelled. */
export interface ViewPrinter {
  print(request: PrintRequest): Promise<'printed' | 'saved' | null>;
}

/** `ui.print`: prints or saves as PDF vector views the extension has on screen, one page each. */
export function vectorPrintServices(manifest: ExtensionManifest, ui: () => ExtensionUiHost, printer: ViewPrinter | null): ServiceImplementations {
  return {
    'ui.print': async (input) => {
      const parsed = uiPrintSchema.safeParse(input);
      if (!parsed.success) throw new ExtensionError('validation.failed', 'ui.print needs a target, vector view components, a page size in meters (0.02 to 2) and a purpose.');
      const { target, components, page, purpose, title } = parsed.data;
      if (!printer) throw new ExtensionError('unavailable', 'Printing is not available here.');
      const shown = ui().get(target);
      const paper = { width: page.width * MM_PER_M, height: page.height * MM_PER_M };
      const pages = components.map((component) => {
        const node: UiNode | undefined = shown ? findInTree(shown.tree, component) : undefined;
        if (!node || node.type !== 'vector') throw new ExtensionError('validation.failed', `"${component}" is not a vector view shown in "${target}".`);
        return vectorPage(node, paper);
      });
      const outcome = await printer.print({ extensionName: manifest.name, purpose, title: title ?? pages[0]!.name, page: paper, pages });
      if (!outcome) throw new ExtensionError('cancelled', 'Nothing was printed.');
      return { outcome };
    },
  };
}
