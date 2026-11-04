// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { layoutFillPatternMatrix, type LayoutDocumentState, type LayoutEntity } from '@pushform/layout';
import { importSketchUpLayout } from './sketchupLayout';
import { exportSketchUpLayout } from './sketchupLayoutExport';
import { decodeLayoutDocument, encodeLayoutDocument } from './layoutFile';
import { encodeNativeLayoutFile, decodeNativeLayoutFile } from './native/layoutFile';
import { imagePixelsPerInch } from './imageResolution';

// pattern-fills-2027.layout: one 2 × 2 in shape at (1, 1) in per page, filled with a 40 × 20 px picture.
const FIXTURE = new Uint8Array(readFileSync(new URL('../../testing/assets/layout/pattern-fills-2027.layout', import.meta.url)));
const IN = 25.4;

function shapes(state: LayoutDocumentState): Map<string, LayoutEntity> {
  return new Map(state.pageOrder.map(id => {
    const page = state.pages.get(id)!;
    return [page.name, page.entities.get(page.entityOrder[0]!)!];
  }));
}

/** Where a point of the picture, in its pixels, lands on the page in inches. */
function onPage(entity: LayoutEntity, [px, py]: [number, number], [width, height] = [40, 20]): [number, number] {
  const [a, b, c, d, e, f] = layoutFillPatternMatrix(entity.style!.fillPattern!);
  const u = px / width, v = py / height;
  return [(a * u + c * v + e) / IN, (b * u + d * v + f) / IN];
}

describe('LayOut pattern fills', () => {
  it('imports each shape\'s pattern picture, origin, scale and rotation', () => {
    const { doc, warnings } = importSketchUpLayout(FIXTURE);
    expect(warnings).toEqual([]);
    const byPage = shapes(doc.state);
    const pattern = (name: string) => byPage.get(name)!.style!.fillPattern!;
    const files = unzipSync(FIXTURE);
    const png = files['ref/3993427120_pattern-100dpi_2.png']!;
    expect(pattern('default').src).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
    // 40 × 20 px at 3,937 px per meter, 100 px per inch.
    expect(pattern('default').tileMm[0]).toBeCloseTo(0.4 * IN, 3);
    expect(pattern('default').tileMm[1]).toBeCloseTo(0.2 * IN, 3);
    expect(pattern('default')).toMatchObject({ originMm: [0, 0], scale: 1, rotationDeg: 0 });
    expect(pattern('origin').originMm[0]).toBeCloseTo(1.13 * IN, 4);
    expect(pattern('origin').originMm[1]).toBeCloseTo(1.07 * IN, 4);
    expect(pattern('scale')).toMatchObject({ originMm: [IN, IN], scale: 2, rotationDeg: 0 });
    expect(pattern('rotation')).toMatchObject({ scale: 1, rotationDeg: 30 });
    expect(pattern('combined')).toMatchObject({ scale: 2, rotationDeg: 30 });
    expect(pattern('combined').originMm[0]).toBeCloseTo(1.2 * IN, 4);
    // Without a stored resolution a picture is 96 px per inch.
    expect(pattern('nodpi').tileMm[0]).toBeCloseTo(40 / 96 * IN, 6);
    expect(pattern('nodpi').tileMm[1]).toBeCloseTo(20 / 96 * IN, 6);
    // A JPEG's JFIF density is its resolution.
    expect(pattern('jpeg').src.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(pattern('jpeg').tileMm[0]).toBeCloseTo(0.4 * IN, 6);
    // Shapes share one picture string.
    expect(pattern('scale').src).toBe(pattern('default').src);
    // The pattern goes with no solid fill unless the shape has one; the solid-filled shape keeps its blue.
    expect(byPage.get('default')!.style!.fillColor).toBeNull();
    expect(byPage.get('solid')!.style!.fillColor).toBe('#0000ff');
    expect(byPage.get('solid')!.style!.fillPattern).toBeDefined();
    expect(byPage.get('ellipse')!.style!.fillPattern).toBeDefined();
  });

  it('tiles as the file draws it: tiles from the origin, scaled, and turned counterclockwise about it', () => {
    const byPage = shapes(importSketchUpLayout(FIXTURE).doc.state);
    // Picture pixel (28, 12) is the center of its red square. Each expected page position, in inches, is the center
    // of one red square on that page, to within 0.015 in.
    const near = (entity: LayoutEntity, pixel: [number, number], expected: [number, number], tile: [number, number]) => {
      const [x, y] = onPage(entity, pixel);
      // Some whole tile step away from a measured square.
      const [a, b, c, d] = layoutFillPatternMatrix(entity.style!.fillPattern!).map(n => n / IN);
      const dx = expected[0] - x, dy = expected[1] - y, det = a! * d! - b! * c!;
      const i = (d! * dx - c! * dy) / det, j = (a! * dy - b! * dx) / det;
      expect(Math.abs(i - Math.round(i)) * tile[0]).toBeLessThan(0.015);
      expect(Math.abs(j - Math.round(j)) * tile[1]).toBeLessThan(0.015);
    };
    near(byPage.get('default')!, [28, 12], [1.0775, 1.1175], [0.4, 0.2]);
    near(byPage.get('origin')!, [28, 12], [1.4075, 1.1875], [0.4, 0.2]);
    near(byPage.get('scale')!, [28, 12], [1.5525, 1.2325], [0.8, 0.4]);
    near(byPage.get('rotation')!, [28, 12], [1.3984, 1.1379], [0.4, 0.2]);
    near(byPage.get('combined')!, [28, 12], [1.9939, 1.3732], [0.8, 0.4]);
    // A counterclockwise turn: the tile's x axis rises on the page.
    const [a, b] = layoutFillPatternMatrix(byPage.get('rotation')!.style!.fillPattern!);
    expect(Math.atan2(-b, a) * 180 / Math.PI).toBeCloseTo(30, 6);
  });

  it('reports and leaves out a pattern whose picture is missing, keeping the shape', () => {
    const files = unzipSync(FIXTURE);
    for (const name of Object.keys(files)) if (name.startsWith('ref/') && name.includes('pattern-100dpi')) delete files[name];
    const { doc, warnings } = importSketchUpLayout(zipSync(files));
    expect(warnings.some(warning => /pattern fills whose picture is missing were left out/.test(warning))).toBe(true);
    const byPage = shapes(doc.state);
    expect(byPage.get('default')!.style!.fillPattern).toBeUndefined();
    expect(byPage.get('default')!.style!.strokeColor).not.toBe('#00000000');
    expect(byPage.get('solid')!.style!.fillColor).toBe('#0000ff');
    expect(byPage.get('nodpi')!.style!.fillPattern).toBeDefined();
  });

  it('keeps the pattern on an open path filled as if closed, but not on its stroke', () => {
    const files = unzipSync(FIXTURE);
    const page = Object.keys(files).find(name => name.startsWith('pages/') && strFromU8(files[name]!).includes('fillImageRotation="30" fillImageOriginX'))!;
    const xml = strFromU8(files[page]!).replace(/<e:rectangle id="(\w+)"[^>]*>\s*<e:rectangleBase[^>]*>([\s\S]*?<\/e:graphicEntity>)[\s\S]*?<\/e:rectangle>/,
      (_, id, graphic) => `<e:path id="${id}" rotationAngle="0">${graphic}<e:elements>0,1,1</e:elements><e:points2f>1,1,3,1,3,3</e:points2f></e:path>`);
    files[page] = strToU8(xml);
    const entities = [...importSketchUpLayout(zipSync(files)).doc.state.pages.values()].flatMap(p => [...p.entities.values()])
      .filter(entity => entity.style?.fillPattern?.rotationDeg === 30 || entity.points.length === 3);
    const fill = entities.find(entity => entity.closed && entity.points.length === 3)!, stroke = entities.find(entity => !entity.closed)!;
    expect(fill.style!.fillPattern!.rotationDeg).toBe(30);
    expect(stroke.style!.fillPattern).toBeUndefined();
  });

  it('exports pattern fills to LayOut with one stored picture, and re-imports them unchanged', async () => {
    const { doc } = importSketchUpLayout(FIXTURE);
    const { bytes, warnings } = await exportSketchUpLayout(doc.state);
    expect(warnings).toEqual([]);
    const files = unzipSync(bytes);
    const pictures = Object.keys(files).filter(name => name.startsWith('ref/'));
    // The PNG used by eight shapes is stored once, beside the PNG and JPEG used once each.
    expect(pictures).toHaveLength(3);
    const pages = Object.keys(files).filter(name => name.startsWith('pages/')).map(name => strFromU8(files[name]!)).join('');
    expect(pages.match(/tag="fill\.imagepattern"/g)).toHaveLength(9);
    expect(pages).toContain('shouldFillPattern="1" fillImageRotation="30" fillImageScale="2" fillImageOriginX="1.2" fillImageOriginY="1.1"');
    const before = shapes(doc.state), after = shapes(importSketchUpLayout(bytes).doc.state);
    for (const [name, entity] of before) {
      const pattern = entity.style!.fillPattern!, again = after.get(name)!.style!.fillPattern!;
      expect(again.src, name).toBe(pattern.src);
      expect(again.scale).toBeCloseTo(pattern.scale, 6);
      expect(again.rotationDeg).toBeCloseTo(pattern.rotationDeg, 6);
      for (const i of [0, 1]) {
        expect(again.originMm[i]).toBeCloseTo(pattern.originMm[i]!, 3);
        expect(again.tileMm[i]).toBeCloseTo(pattern.tileMm[i]!, 6);
      }
      expect(after.get(name)!.style!.fillColor).toBe(entity.style!.fillColor);
    }
  });

  it('keeps pattern fills through native and manifest save and reopen', async () => {
    const { doc } = importSketchUpLayout(FIXTURE);
    const bytes = await encodeNativeLayoutFile(doc.state);
    const state = await decodeNativeLayoutFile({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) });
    expect(shapes(state)).toEqual(shapes(doc.state));
    expect(shapes(decodeLayoutDocument(encodeLayoutDocument(doc)).state)).toEqual(shapes(doc.state));
  });

  it('reads stored picture resolutions', () => {
    const files = unzipSync(FIXTURE);
    const at = (part: string) => imagePixelsPerInch(files[Object.keys(files).find(name => name.includes(part))!]!);
    expect(at('pattern-100dpi')![0]).toBeCloseTo(100, 2);
    expect(at('pattern-nodpi')).toBeNull();
    expect(at('pattern-jfif100')).toEqual([100, 100]);
  });
});
