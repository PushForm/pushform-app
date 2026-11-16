// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDxf } from './dxf';
import { dxfLayoutEntities } from './dxfLayout';
import { convertDwg, dwgVersion, isDwgBytes, isDwgFile } from './dwg';
import { isModelImportFile, modelImportBaseName, modelImportFormat, probeMeshImport, readModelImport } from './modelImport';

// The drawings are written by `cargo run --example fixture` in crates/dwg-reader: a line, a circle, an arc and a
// text on the layer Walls, once recording millimeters and once recording no units.
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./__fixtures__/dwg/${name}`, import.meta.url)));

describe('DWG import', () => {
  it('tells DWG files by name and by their leading format version', () => {
    expect(isDwgFile('Site Plan.DWG')).toBe(true);
    expect(isDwgFile('plan.dxf')).toBe(false);
    expect(isDwgBytes(fixture('plan-mm.dwg'))).toBe(true);
    expect(isDwgBytes(new TextEncoder().encode('  0\nSECTION\n'))).toBe(false);
    expect(isDwgBytes(new TextEncoder().encode('ACME'))).toBe(false);
    expect(isModelImportFile('plan.dwg')).toBe(true);
    expect(modelImportFormat('plan.dwg').name).toBe('DWG');
    expect(modelImportBaseName('plan.dwg')).toBe('plan');
    expect(dwgVersion('AC1027')).toBe('AutoCAD 2013 DWG (AC1027)');
    expect(dwgVersion('AC9999')).toBe('DWG (AC9999)');
  });

  it('converts a drawing to DXF text that keeps its units, layers, geometry and text', async () => {
    const converted = await convertDwg(fixture('plan-mm.dwg'));
    expect(converted.version).toBe('AC1027');
    expect(converted.notes).toEqual([]);
    const drawing = parseDxf(converted.dxf);
    expect(drawing.units?.unit).toBe('mm');
    expect(drawing.layers.has('Walls')).toBe(true);
    expect(drawing.items.map(item => item.kind).sort()).toEqual(['path', 'path', 'path', 'text']);
    expect(drawing.items.every(item => item.layer === 'Walls')).toBe(true);
    expect(drawing.items.find(item => item.kind === 'text')).toMatchObject({ text: 'PLAN' });
  });

  it('places a converted drawing in Layout as a DXF drawing is placed', async () => {
    const converted = await convertDwg(fixture('plan-mm.dwg'));
    const placed = dxfLayoutEntities(converted.dxf, [420, 297]);
    expect(placed.unit).toBe('mm');
    expect(placed.unitRecorded).toBe(true);
    // The 4000 mm line spans 4000 mm divided by the drawing scale on paper.
    const xs = placed.entities.filter(entity => !entity.text).flatMap(entity => entity.points.map(point => point[0]));
    expect(placed.scale).toBeGreaterThan(1);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4000 / placed.scale, 6);
    expect(placed.entities.filter(entity => entity.text).map(entity => entity.text!.content)).toEqual(['PLAN']);
    expect(placed.entities.filter(entity => !entity.text)).toHaveLength(3);
  });

  it('imports a drawing as a model, reported as DWG with its AutoCAD release', async () => {
    const bytes = fixture('plan-mm.dwg');
    expect(probeMeshImport(bytes)).toBeNull();
    const scene = await readModelImport(bytes);
    expect(scene.format?.kind).toBe('dwg');
    expect(scene.version).toBe('AutoCAD 2013 DWG (AC1027)');
    expect(scene.tags.map(tag => tag.name)).toEqual(['Walls']);
    expect(scene.root.edges.length).toBeGreaterThan(20);
    expect(scene.warnings.some(warning => warning.startsWith('DWG import:'))).toBe(true);
    expect(scene.warnings.some(warning => warning.includes('does not record its units'))).toBe(false);
    // The 4000 mm line is 4 m long.
    const xs = scene.root.edges.flatMap(edge => [edge.a[0], edge.b[0]]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4, 6);
  });

  it('reads a drawing without units in inches when it was started in imperial units, without asking', async () => {
    const bytes = fixture('plan-unitless.dwg');
    expect(probeMeshImport(bytes)).toBeNull();
    const scene = await readModelImport(bytes);
    expect(scene.warnings).toContain('The drawing does not record its units; it is read in inches.');
    const xs = scene.root.edges.flatMap(edge => [edge.a[0], edge.b[0]]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4000 * 0.0254, 6);
    // A unit the caller chose wins.
    const chosen = await readModelImport(bytes, undefined, { unit: 'mm', up: 'z' });
    expect(chosen.warnings).toContain('The drawing does not record its units; it is read in millimeters.');
  });

  it('rejects files that are not readable DWG drawings', async () => {
    await expect(convertDwg(new TextEncoder().encode('not a drawing'))).rejects.toThrow('not a DWG drawing');
    await expect(convertDwg(new TextEncoder().encode('AC1027 and then nothing a drawing holds'))).rejects.toThrow('could not be read');
    // The reader still works after a rejected file.
    expect((await convertDwg(fixture('plan-mm.dwg'))).version).toBe('AC1027');
  });
});
