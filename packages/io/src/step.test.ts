// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { createDocument } from '@pushform/model';
import { modelImportBaseName, modelImportFormat, probeMeshImport, readModelImport } from './modelImport';
import { applySketchUpImport } from './sketchupDocument';
import { makeMeshPartEditable } from './meshPartEditable';
import { readSketchUpInWorker } from './sketchupClient';
import { MAX_DESKTOP_STEP_BYTES, isStepBytes, readStep, stepHeader } from './step';
import type { StepPreview } from './stepWasm';

type P = [number, number, number];
interface Box { size: P; at?: P; name?: string; color?: P }

/** A STEP AP214 file holding axis-aligned boxes as manifold B-rep solids of one part, in millimeters, meters or inches. */
function boxesStep(boxes: Box[], unit: 'mm' | 'm' | 'in' = 'mm', system = 'PushForm tests'): Uint8Array {
  const lines: string[] = [];
  const e = (entity: string): string => { lines.push(`#${lines.length + 1}=${entity};`); return `#${lines.length}`; };
  const pt = (p: readonly number[]): string => e(`CARTESIAN_POINT('',(${p.map(v => v.toFixed(6)).join(',')}))`);
  const dir = (d: readonly number[]): string => e(`DIRECTION('',(${d.map(v => v.toFixed(1)).join(',')}))`);
  let length: string;
  if (unit === 'in') {
    const mm = e('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
    const inch = e(`LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),${mm})`);
    length = e(`(CONVERSION_BASED_UNIT('INCH',${inch})LENGTH_UNIT()NAMED_UNIT(${e('DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.)')}))`);
  } else length = e(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(${unit === 'mm' ? '.MILLI.' : '$'},.METRE.))`);
  const angle = e('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))'), solidAngle = e('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const uncertainty = e(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${length},'distance_accuracy_value','')`);
  const context = e(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${length},${angle},${solidAngle}))REPRESENTATION_CONTEXT('',''))`);
  const application = e("APPLICATION_CONTEXT('automotive design')");
  e(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${application})`);
  const productContext = e(`PRODUCT_CONTEXT('',${application},'mechanical')`);
  const definitionContext = e(`PRODUCT_DEFINITION_CONTEXT('part definition',${application},'design')`);
  const solids: string[] = [], styled: string[] = [];
  for (const box of boxes) {
    const [x, y, z] = box.at ?? [0, 0, 0], [dx, dy, dz] = box.size;
    const corner = (i: number): P => [x + (i & 1 ? dx : 0), y + (i & 2 ? dy : 0), z + (i & 4 ? dz : 0)];
    const vertices = Array.from({ length: 8 }, (_, i) => e(`VERTEX_POINT('',${pt(corner(i))})`));
    const edges = new Map<string, string>();
    const oriented = (a: number, b: number): string => {
      const [i, j] = a < b ? [a, b] : [b, a], key = `${i},${j}`;
      let edge = edges.get(key);
      if (!edge) {
        const along = corner(j).map((v, k) => Math.sign(v - corner(i)[k]!));
        edge = e(`EDGE_CURVE('',${vertices[i]},${vertices[j]},${e(`LINE('',${pt(corner(i))},${e(`VECTOR('',${dir(along)},1.)`)})`)},.T.)`);
        edges.set(key, edge);
      }
      return e(`ORIENTED_EDGE('',*,*,${edge},${a < b ? '.T.' : '.F.'})`);
    };
    // Corner rings counterclockwise seen from outside, with each face's outward normal.
    const faces: [number[], P][] = [[[0, 2, 3, 1], [0, 0, -1]], [[4, 5, 7, 6], [0, 0, 1]], [[0, 1, 5, 4], [0, -1, 0]],
      [[2, 6, 7, 3], [0, 1, 0]], [[0, 4, 6, 2], [-1, 0, 0]], [[1, 3, 7, 5], [1, 0, 0]]];
    const advanced = faces.map(([ring, normal]) => {
      const loop = e(`EDGE_LOOP('',(${ring.map((a, i) => oriented(a, ring[(i + 1) % 4]!)).join(',')}))`);
      const plane = e(`PLANE('',${e(`AXIS2_PLACEMENT_3D('',${pt(corner(ring[0]!))},${dir(normal)},${dir(normal[0] ? [0, 1, 0] : [1, 0, 0])})`)})`);
      return e(`ADVANCED_FACE('',(${e(`FACE_OUTER_BOUND('',${loop},.T.)`)}),${plane},.T.)`);
    });
    const solid = e(`MANIFOLD_SOLID_BREP('${box.name ?? ''}',${e(`CLOSED_SHELL('',(${advanced.join(',')}))`)})`);
    solids.push(solid);
    if (box.color) {
      const fill = e(`FILL_AREA_STYLE('',(${e(`FILL_AREA_STYLE_COLOUR('',${e(`COLOUR_RGB('',${box.color.map(v => v.toFixed(3)).join(',')})`)})`)}))`);
      const side = e(`SURFACE_SIDE_STYLE('',(${e(`SURFACE_STYLE_FILL_AREA(${fill})`)}))`);
      styled.push(e(`STYLED_ITEM('color',(${e(`PRESENTATION_STYLE_ASSIGNMENT((${e(`SURFACE_STYLE_USAGE(.BOTH.,${side})`)}))`)}),${solid})`));
    }
  }
  const origin = e(`AXIS2_PLACEMENT_3D('',${pt([0, 0, 0])},${dir([0, 0, 1])},${dir([1, 0, 0])})`);
  const representation = e(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${[...solids, origin].join(',')}),${context})`);
  const product = e(`PRODUCT('Bracket','Bracket','',(${productContext}))`);
  const definition = e(`PRODUCT_DEFINITION('design','',${e(`PRODUCT_DEFINITION_FORMATION('','',${product})`)},${definitionContext})`);
  e(`SHAPE_DEFINITION_REPRESENTATION(${e(`PRODUCT_DEFINITION_SHAPE('','',${definition})`)},${representation})`);
  if (styled.length) e(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styled.join(',')}),${context})`);
  return new TextEncoder().encode(['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    `FILE_NAME('bracket.step','2026-10-30T00:00:00',('Author'),(''),'Preprocessor 1.0','${system}','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", 'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n'));
}

const highest = (points: readonly (readonly number[])[]): number => Math.max(...points.map(p => p[2]!));

describe('STEP import', () => {
  it('recognizes STEP files by name and content and reads the header', () => {
    const bytes = boxesStep([{ size: [10, 10, 10] }]);
    expect(isStepBytes(bytes)).toBe(true);
    expect(isStepBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('\r\nISO-10303-21;\r\n')]))).toBe(true);
    expect(isStepBytes(new TextEncoder().encode('solid cube\nendsolid cube\n'))).toBe(false);
    expect(modelImportFormat('Bracket.STP').kind).toBe('step');
    expect(modelImportFormat('Bracket.step').kind).toBe('step');
    expect(modelImportBaseName('Bracket.step')).toBe('Bracket');
    // STEP records its unit, so import asks for no options.
    expect(probeMeshImport(bytes)).toBeNull();
    expect(stepHeader(bytes)).toEqual({ schema: 'AP214', system: 'PushForm tests' });
  });

  it('imports a lone part as one mesh part of the model in meters, its flat faces whole and its color as its material', async () => {
    const scene = await readModelImport(boxesStep([{ size: [100, 200, 300], color: [0.8, 0.2, 0.4] }]));
    expect(scene.format?.kind).toBe('step');
    expect(scene.version).toBe('AP214, PushForm tests');
    expect(scene.root.solids).toHaveLength(0);
    expect(scene.root.meshParts).toHaveLength(1);
    const part = scene.root.meshParts![0]!;
    expect(part.geometry.triangles.length / 3).toBe(12);
    expect(part.geometry.faceCount).toBe(6);
    expect(part.geometry.edgeOffsets.length - 1).toBe(12);
    expect(highest([...Array(part.geometry.positions.length / 3).keys()].map(i => [...part.geometry.positions.subarray(i * 3, i * 3 + 3)]))).toBeCloseTo(0.3, 9);
    expect(scene.materials.get(part.material!)?.name).toBe('Color CC3366');
    expect(part.source).toEqual({ format: 'STEP', system: 'PushForm tests' });
    const doc = createDocument();
    expect(doc.transact('Open', d => applySketchUpImport(d, scene)).value).toMatchObject({ format: 'STEP', bodies: 0, meshParts: 1, meshPartTriangles: 12 });
    // Make Editable builds the solid straight from the mesh: six faces, the color as the body's material.
    const id = [...doc.rootDefinition.entities.meshParts.keys()][0]!;
    expect(doc.transact('Make Editable', d => makeMeshPartEditable(d, [], id)).value).toMatchObject({ bodies: 1, sheetFaces: 0 });
    const body = [...doc.rootDefinition.entities.bodies.values()][0]!;
    expect(body.faces.size).toBe(6);
    expect(body.valid).toBe(true);
    expect(doc.state.materials.get(body.materialId!)?.name).toBe('Color CC3366');
  });

  it('converts the file unit to meters', async () => {
    const scene = await readStep(boxesStep([{ size: [1, 2, 3] }], 'in'));
    expect(Math.max(...scene.root.meshParts![0]!.geometry.positions)).toBeCloseTo(3 * 0.0254, 9);
  });

  it('places the solids of one product as separate parts, numbered, even where they touch', async () => {
    const scene = await readStep(boxesStep([{ size: [10, 10, 10] }, { size: [10, 10, 10], at: [10, 0, 0], color: [0, 0, 1] }]));
    expect(scene.root.meshParts).toBeUndefined();
    expect(scene.root.instances.map(i => i.name)).toEqual(['Bracket 1', 'Bracket 2']);
    const parts = [...scene.definitions.values()].map(d => d.meshParts![0]!);
    expect(parts.map(p => p.name)).toEqual(['Bracket 1', 'Bracket 2']);
    expect(parts[0]!.material).toBeNull();
    expect(scene.materials.get(parts[1]!.material!)?.name).toBe('Color 0000FF');
    const doc = createDocument();
    expect(doc.transact('Import', d => applySketchUpImport(d, scene)).value).toMatchObject({ meshParts: 2, meshPartTriangles: 24, definitions: 2, instances: 2 });
    for (const def of doc.state.definitions.values()) for (const id of [...def.entities.meshParts.keys()]) {
      const instance = [...doc.rootDefinition.entities.instances.values()].find(i => i.definitionId === def.id)!;
      expect(doc.transact('Make Editable', d => makeMeshPartEditable(d, [instance.id], id)).value).toMatchObject({ bodies: 1, sheetFaces: 0 });
    }
  });

  it('hands out every part and placement in previews while it reads, matching the result', async () => {
    const bytes = boxesStep([{ size: [10, 10, 10] }, { size: [20, 10, 10], at: [30, 0, 0], color: [0, 0, 1] }, { size: [5, 5, 5], at: [0, 40, 0] }]);
    const previews: StepPreview[] = [];
    const scene = await readStep(bytes, undefined, undefined, undefined, p => previews.push(p));
    const parts = previews.flatMap(p => p.parts), placements = previews.flatMap(p => p.placements);
    expect(new Set(parts.map(p => p.id)).size).toBe(parts.length);
    expect(parts).toHaveLength(scene.definitions.size);
    expect(placements).toHaveLength(scene.root.instances.length);
    // A placement never comes before its part.
    const seen = new Set<number>();
    for (const preview of previews) {
      for (const part of preview.parts) seen.add(part.id);
      for (const placement of preview.placements) expect(seen.has(placement.part)).toBe(true);
    }
    const blue = parts.find(p => p.color?.[2] === 1)!;
    expect(blue.color).toEqual([0, 0, 1]);
    for (const part of parts) {
      expect(part.positions.length % 3).toBe(0);
      expect(part.triangles.length).toBeGreaterThanOrEqual(36);
      expect(Math.max(...part.triangles)).toBeLessThan(part.positions.length / 3);
      // A box's twelve hard edges, as one or more segments each.
      expect(part.edges.length % 6).toBe(0);
      expect(part.edges.length).toBeGreaterThanOrEqual(12 * 6);
    }
    // Placed, in meters, the parts span the boxes: x to 50 mm, y to 45 mm, z to 10 mm.
    const max = [-Infinity, -Infinity, -Infinity];
    for (const placement of placements) {
      const part = parts.find(p => p.id === placement.part)!, m = placement.matrix;
      for (let i = 0; i < part.positions.length; i += 3) {
        const [x, y, z] = [part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!];
        for (let k = 0; k < 3; k++) max[k] = Math.max(max[k]!, m[k]! * x + m[4 + k]! * y + m[8 + k]! * z + m[12 + k]!);
      }
    }
    expect(max[0]).toBeCloseTo(0.05, 6);
    expect(max[1]).toBeCloseTo(0.045, 6);
    expect(max[2]).toBeCloseTo(0.01, 6);
  });

  it('fails without changes on a file that is not readable STEP', async () => {
    await expect(readStep(new TextEncoder().encode('not a step file'))).rejects.toThrow(/Not a STEP model/);
    await expect(readStep(new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=GARBAGE(;\nENDSEC;\nEND-ISO-10303-21;\n'))).rejects.toThrow();
  });

  it('reads files over the shared limit only when the caller allows more, as the desktop app does', async () => {
    const MIB = 1024 * 1024;
    // A valid file padded past 128 MiB with trailing white space, which Part 21 allows after END-ISO-10303-21.
    const box = boxesStep([{ size: [10, 10, 10] }]), big = new Uint8Array(128 * MIB + 1);
    big.set(box); big.fill(0x20, box.length);
    await expect(readStep(big)).rejects.toThrow('STEP files larger than 128 MiB are not supported yet.');
    await expect(readSketchUpInWorker(big)).rejects.toThrow('STEP files larger than 128 MiB are not supported yet.');
    expect(MAX_DESKTOP_STEP_BYTES).toBe(256 * MIB);
    const scene = await readSketchUpInWorker(big, { maxStepBytes: MAX_DESKTOP_STEP_BYTES });
    expect(scene.root.meshParts).toHaveLength(1);
  }, 60_000);
});
