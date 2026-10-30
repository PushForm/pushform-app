// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import { m4transformPoint } from '@pushform/core';
import { createDocument } from '@pushform/model';
import { aciColor, isDxfBytes, mtextPlain, nurbsPoints, parseDxf, parseDxfHeader } from './dxf';
import { dxfLayoutEntities } from './dxfLayout';
import { readDxf } from './dxfModel';
import { modelImportFormat, probeMeshImport, readModelImport } from './modelImport';
import { applySketchUpImport } from './sketchupDocument';

type Group = [number, string | number];
/** An ASCII DXF file from its header variables, layers, blocks and entities, each a list of group code pairs. */
function dxf({ header = [], layers = [], linetypes = [], blocks = [], entities = [] }: {
  header?: Group[]; layers?: Group[][]; linetypes?: Group[][]; blocks?: { name: string; base?: [number, number]; entities: Group[][] }[]; entities?: Group[][];
}): Uint8Array {
  const out: Group[] = [[999, 'test'], [0, 'SECTION'], [2, 'HEADER'], ...header, [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'TABLES'],
    [0, 'TABLE'], [2, 'LTYPE'], ...linetypes.flatMap(l => [[0, 'LTYPE'] as Group, ...l]), [0, 'ENDTAB'],
    [0, 'TABLE'], [2, 'LAYER'], ...layers.flatMap(l => [[0, 'LAYER'] as Group, ...l]), [0, 'ENDTAB'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'BLOCKS'], ...blocks.flatMap(b => [[0, 'BLOCK'] as Group, [2, b.name] as Group, [70, 0] as Group, [10, b.base?.[0] ?? 0] as Group,
      [20, b.base?.[1] ?? 0] as Group, [30, 0] as Group, ...b.entities.flatMap(e => e), [0, 'ENDBLK'] as Group]), [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], ...entities.flatMap(e => e), [0, 'ENDSEC'], [0, 'EOF']];
  return strToU8(out.map(([code, value]) => `${String(code).padStart(3)}\r\n${value}`).join('\r\n') + '\r\n');
}
const line = (layer: string, a: [number, number], b: [number, number]): Group[] =>
  [[0, 'LINE'], [8, layer], [10, a[0]], [20, a[1]], [30, 0], [11, b[0]], [21, b[1]], [31, 0]];
const circle = (layer: string, c: [number, number], r: number): Group[] => [[0, 'CIRCLE'], [8, layer], [10, c[0]], [20, c[1]], [30, 0], [40, r]];
const arc = (layer: string, c: [number, number], r: number, start: number, end: number): Group[] =>
  [[0, 'ARC'], [8, layer], [10, c[0]], [20, c[1]], [30, 0], [40, r], [50, start], [51, end]];
const insert = (block: string, at: [number, number], extra: Group[] = [], layer = '0'): Group[] => [[0, 'INSERT'], [8, layer], [2, block], [10, at[0]], [20, at[1]], [30, 0], ...extra];
const MM: Group[] = [[9, '$ACADVER'], [1, 'AC1032'], [9, '$INSUNITS'], [70, 4]];

describe('DXF reading', () => {
  it('recognizes ASCII and binary DXF, and reads units and extent from the header', () => {
    const file = dxf({ header: [...MM, [9, '$EXTMIN'], [10, -1], [20, -2], [30, 0], [9, '$EXTMAX'], [10, 3], [20, 4], [30, 0]], entities: [line('0', [0, 0], [1, 0])] });
    expect(isDxfBytes(file)).toBe(true);
    expect(isDxfBytes(strToU8('AutoCAD Binary DXF\r\n\x1a\0'))).toBe(true);
    expect(isDxfBytes(strToU8('v 0 0 0\n'))).toBe(false);
    expect(parseDxfHeader(file)).toEqual({ units: { unit: 'mm', meters: 0.001 }, extent: { min: [-1, -2, 0], max: [3, 4, 0] } });
    expect(parseDxfHeader(dxf({ entities: [line('0', [0, 0], [1, 0])] }))).toEqual({ units: null, extent: null });
    expect(modelImportFormat('Plan.DXF').name).toBe('DXF');
    expect(() => parseDxf(strToU8('AutoCAD Binary DXF\r\n\x1a\0'))).toThrow(/Binary DXF/);
  });

  it('reads polyline bulges as arcs and resolves the arbitrary axis of mirrored entities', () => {
    // A 2 × 2 slot: straight bottom, semicircular right end (bulge 1), straight top, closed by a straight left side.
    const drawing = parseDxf(dxf({ entities: [
      [[0, 'LWPOLYLINE'], [8, '0'], [90, 4], [70, 1], [10, 0], [20, 0], [10, 2], [20, 0], [42, 1], [10, 2], [20, 2], [10, 0], [20, 2]],
      // A circle drawn in a mirrored OCS (extrusion -Z) is centred at x = -5 in the world.
      [...circle('0', [5, 0], 1), [210, 0], [220, 0], [230, -1]],
    ] }));
    const slot = drawing.items[0]!, mirrored = drawing.items[1]!;
    expect(slot).toMatchObject({ kind: 'path', closed: true });
    const curves = slot.kind === 'path' ? slot.curves : [];
    expect(curves.map(c => c.kind)).toEqual(['line', 'arc', 'line', 'line']);
    const bend = curves[1]!;
    expect(bend.kind === 'arc' && [bend.center, bend.end - bend.start]).toEqual([[2, 1, 0], Math.PI]);
    const center = mirrored.kind === 'path' && mirrored.curves[0]!.kind === 'arc' ? mirrored.curves[0]!.center : null;
    expect(center?.map(v => v + 0)).toEqual([-5, 0, 0]);
  });

  it('reads text control codes, MTEXT formatting, colors and splines', () => {
    expect(mtextPlain('{\\fArial|b1|i0;Room}\\P\\H2.5;Area \\S1^2; m%%c')).toBe('Room\nArea 1/2 mØ');
    expect(aciColor(1)).toEqual([255, 0, 0]);
    expect(aciColor(7)).toEqual([0, 0, 0]);
    expect(aciColor(21)).toEqual([255, 159, 127]);
    expect(aciColor(22)).toEqual([165, 41, 0]);
    // A clamped quadratic B-spline through its end control points.
    const points = nurbsPoints(2, [0, 0, 0, 1, 1, 1], [[0, 0, 0], [1, 2, 0], [2, 0, 0]], null, 2)!;
    expect(points[0]).toEqual([0, 0, 0]);
    expect(points[1]).toEqual([1, 1, 0]);
    expect(points[2]).toEqual([2, 0, 0]);
  });
});

describe('DXF model import', () => {
  it('imports lines, arcs and circles in the file units, with layers as tags and circles as curves', async () => {
    const file = dxf({ header: MM, layers: [[[2, 'Walls'], [70, 0], [62, 1], [6, 'CONTINUOUS']], [[2, 'Off'], [70, 0], [62, -3], [6, 'CONTINUOUS']]],
      entities: [line('Walls', [0, 0], [1000, 0]), circle('0', [0, 0], 100), arc('Off', [0, 0], 200, 0, 90), [[0, 'POINT'], [8, '0'], [10, 0], [20, 0], [30, 0]]] });
    expect(probeMeshImport(file)).toBeNull();
    const scene = await readModelImport(file);
    expect(scene.format?.kind).toBe('dxf');
    expect(scene.version).toBe('AutoCAD 2018 DXF (AC1032)');
    expect(scene.tags).toEqual([{ name: 'Walls', color: [1, 0, 0], visible: true }, { name: 'Off', color: [0, 1, 0], visible: false }]);
    const kinds = scene.root.curves.map(c => [c.kind, c.segments, +c.radius.toFixed(6)]);
    expect(kinds).toEqual(expect.arrayContaining([['circle', 24, 0.1], ['arc', 6, 0.2]]));
    const wall = scene.root.edges.find(e => e.tag === 'Walls')!;
    expect(Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1])).toBeCloseTo(1, 12);
    expect(scene.warnings).toContain('1 entity is not imported: 1 POINT.');
    const doc = createDocument();
    const report = doc.transact('Open', d => applySketchUpImport(d, scene)).value;
    expect(report).toMatchObject({ format: 'DXF', looseEdges: 1 + 24 + 6, tags: 2 });
    const walls = [...doc.state.tags.values()].find(t => t.name === 'Walls')!;
    const sketch = doc.state.definitions.get(doc.state.rootDefinitionId)!.entities.sketch;
    expect([...sketch.edges.values()].filter(e => e.tagId === walls.id)).toHaveLength(1);
    expect([...sketch.curves.values()].map(c => c.kind).sort()).toEqual(['arc', 'circle']);
  });

  it('imports blocks as components placed by their inserts, and 3D faces as faces', async () => {
    const square = [line('0', [0, 0], [1, 0]), line('0', [1, 0], [1, 1]), line('0', [1, 1], [0, 1]), line('0', [0, 1], [0, 0])];
    const file = dxf({ header: [[9, '$INSUNITS'], [70, 6]],
      blocks: [{ name: 'Tile', base: [1, 1], entities: [...square, [[0, '3DFACE'], [8, '0'], [10, 0], [20, 0], [30, 0], [11, 1], [21, 0], [31, 0], [12, 1], [22, 1], [32, 0], [13, 0], [23, 1], [33, 0]]] },
        { name: 'Loop', entities: [insert('Loop', [0, 0])] }],
      entities: [insert('Tile', [10, 0]), insert('Tile', [20, 0], [[50, 90], [41, 2], [42, 2], [43, 1]]), insert('Loop', [0, 0]), line('0', [0, 0], [0, 5])] });
    const scene = await readDxf(file);
    expect(scene.root.instances).toHaveLength(2);
    const tile = scene.definitions.get(scene.root.instances[0]!.definition)!;
    expect(tile.name).toBe('Tile');
    expect(tile.sheets).toHaveLength(1);
    // Base point (1, 1) lands on the insertion point; the second insert is turned 90° and doubled.
    expect(m4transformPoint(scene.root.instances[0]!.transform, [1, 1, 0]).map(v => +v.toFixed(9))).toEqual([10, 0, 0]);
    expect(m4transformPoint(scene.root.instances[1]!.transform, [2, 1, 0]).map(v => +v.toFixed(9))).toEqual([20, 2, 0]);
    expect(scene.warnings).toContain('1 block insert that places its own block is not imported.');
  });

  it('asks for units only when the drawing records none, and reads it in the chosen unit', async () => {
    const file = dxf({ header: [[9, '$EXTMIN'], [10, 0], [20, 0], [30, 0], [9, '$EXTMAX'], [10, 10], [20, 5], [30, 0]], entities: [line('0', [0, 0], [10, 0])] });
    expect(probeMeshImport(file)).toEqual({ kind: 'dxf', extent: { min: [0, 0, 0], max: [10, 5, 0] } });
    const scene = await readModelImport(file, undefined, { unit: 'in', up: 'z' });
    const edge = scene.root.edges[0]!;
    expect(Math.abs(edge.b[0] - edge.a[0])).toBeCloseTo(0.254, 12);
    expect(scene.warnings).toContain('The drawing does not record its units; it is read in inches.');
  });
});

describe('DXF Layout import', () => {
  it('converts model space to grouped paper paths and text at a standard scale that fits the page', () => {
    const file = dxf({ header: MM, layers: [[[2, 'A'], [70, 0], [62, 5], [6, 'DASHED'], [370, 50]], [[2, 'Defpoints'], [70, 0], [62, 7], [6, 'CONTINUOUS']]],
      linetypes: [[[2, 'DASHED'], [70, 0], [73, 2], [40, 15], [49, 10], [49, -5]]],
      blocks: [{ name: 'Door', entities: [arc('0', [0, 0], 900, 0, 90)] }],
      entities: [line('A', [0, 0], [10000, 0]), line('Defpoints', [0, 0], [1, 1]), circle('0', [5000, 2000], 500), insert('Door', [2000, 0], [], 'A'),
        [[0, 'TEXT'], [8, '0'], [10, 0], [20, 3000], [30, 0], [40, 250], [1, 'Plan %%c'], [50, 90]],
        [[0, 'HATCH'], [8, '0'], [10, 0], [20, 0], [30, 0], [2, 'SOLID'], [70, 1], [71, 0], [91, 1], [92, 2], [72, 0], [73, 1], [93, 3],
          [10, 0], [20, 0], [10, 100], [20, 0], [10, 0], [20, 100], [97, 0], [75, 0], [76, 1], [98, 0]]] });
    // A 10 m drawing on an A4 landscape page fits at 1:50 (200 mm wide).
    const result = dxfLayoutEntities(file, [297, 210]);
    expect(result).toMatchObject({ scale: 50, unit: 'mm', unitRecorded: true });
    const [wall, round, door, text, fill] = result.entities;
    expect(wall).toMatchObject({ kind: 'path', points: [[0, -0], [200, -0]], groupId: 1, style: { strokeColor: '#0000ff', strokeDashMm: [0.2, 0.1] } });
    expect(wall!.style!.strokeWeightPt).toBeCloseTo(0.5 / (25.4 / 72), 9);
    // A circle is four Bézier quarters; its by-layer color on layer 0 is layer 0's (black, none defined).
    expect(round).toMatchObject({ kind: 'path', closed: true, style: { strokeColor: '#000000' } });
    expect(round!.points).toHaveLength(4);
    expect(round!.handles).toHaveLength(4);
    // Block contents on layer 0 take the insert's layer, and the insert is a group inside the drawing's group.
    expect(door).toMatchObject({ kind: 'path', groupId: 1, nestedGroupIds: [2], style: { strokeColor: '#0000ff' } });
    expect(text).toMatchObject({ kind: 'text', text: { content: 'Plan Ø', rotationDeg: -90, fontFamily: 'Arial' } });
    expect(fill).toMatchObject({ kind: 'path', closed: true, style: { fillColor: '#000000' } });
    expect(result.entities).toHaveLength(5);
    expect(result.warnings).toContain('1 entity on a layer that is off, frozen or Defpoints is not imported.');
  });

  it('reads a unitless drawing in millimeters, or inches when it was started imperial, and uses imperial scales', () => {
    const plain = dxfLayoutEntities(dxf({ entities: [line('0', [0, 0], [100, 0])] }), [297, 210]);
    expect(plain).toMatchObject({ scale: 1, unit: 'mm', unitRecorded: false });
    // 100 ft does not fit at 1:96 (1/8" = 1'-0", 317.5 mm) but does at 1:120 (1" = 10').
    const feet = dxfLayoutEntities(dxf({ header: [[9, '$INSUNITS'], [70, 2]], entities: [line('0', [0, 0], [100, 0])] }), [297, 210]);
    expect(feet.scale).toBe(120);
    const imperial = dxfLayoutEntities(dxf({ header: [[9, '$MEASUREMENT'], [70, 0]], entities: [line('0', [0, 0], [10, 0])] }), [297, 210]);
    expect(imperial).toMatchObject({ unit: 'in', scale: 1 });
    expect(() => dxfLayoutEntities(dxf({ entities: [] }), [297, 210])).toThrow(/no lines, curves, fills or text/);
  });
});
