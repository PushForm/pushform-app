// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { createDocument } from '@pushform/model';
import { m4transformPoint, type Mat4 } from '@pushform/core';
import { isColladaModelFile, readCollada } from './collada';
import { isModelImportFile, modelImportBaseName, readModelImport } from './modelImport';
import { applySketchUpImport } from './sketchupDocument';
import { decodeModelDocument, encodeModelDocument } from './modelFile';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const CUBE_POSITIONS = '0 0 0 1 0 0 1 1 0 0 1 0 0 0 1 1 0 1 1 1 1 0 1 1';
// Outward, counterclockwise: bottom, top, front, back, left, right.
const CUBE_TRIANGLES = '0 3 2 0 2 1 4 5 6 4 6 7 0 1 5 0 5 4 3 7 6 3 6 2 0 4 7 0 7 3 1 2 6 1 6 5';

function mesh(id: string, positions: string, primitives: string, normals = ''): string {
  const count = positions.trim().split(/\s+/).length;
  return `<geometry id="${id}" name="${id}"><mesh>
    <source id="${id}-p"><float_array id="${id}-pa" count="${count}">${positions}</float_array>
      <technique_common><accessor source="#${id}-pa" count="${count / 3}" stride="3"/></technique_common></source>
    ${normals ? `<source id="${id}-n"><float_array id="${id}-na" count="${normals.trim().split(/\s+/).length}">${normals}</float_array>
      <technique_common><accessor source="#${id}-na" count="${normals.trim().split(/\s+/).length / 3}" stride="3"/></technique_common></source>` : ''}
    <vertices id="${id}-v"><input semantic="POSITION" source="#${id}-p"/></vertices>
    ${primitives}</mesh></geometry>`;
}

function dae(options: { unit?: number; up?: string; geometries: string; nodes?: string; scene: string; materials?: string }): Uint8Array {
  return text(`<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><contributor><authoring_tool>Test exporter</authoring_tool></contributor>
    <unit meter="${options.unit ?? 1}" name="unit"/><up_axis>${options.up ?? 'Z_UP'}</up_axis></asset>
  ${options.materials ?? ''}
  <library_geometries>${options.geometries}</library_geometries>
  ${options.nodes ? `<library_nodes>${options.nodes}</library_nodes>` : ''}
  <library_visual_scenes><visual_scene id="scene">${options.scene}</visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>`);
}

const RED = `<library_effects><effect id="red-fx"><profile_COMMON><technique sid="common"><lambert>
    <diffuse><color>1 0 0 1</color></diffuse>
    <transparent opaque="A_ONE"><color>1 1 1 0.5</color></transparent><transparency><float>1</float></transparency>
  </lambert></technique></profile_COMMON></effect>
  <effect id="blue-fx"><profile_COMMON><technique sid="common"><phong><diffuse><color>0 0 1 1</color></diffuse></phong></technique></profile_COMMON></effect>
  <effect id="photo-fx"><profile_COMMON><technique sid="common"><lambert><diffuse><texture texture="photo-sampler" texcoord="uv"/></diffuse></lambert></technique></profile_COMMON></effect>
</library_effects>
<library_materials><material id="red" name="Red"><instance_effect url="#red-fx"/></material>
  <material id="blue" name="Blue"><instance_effect url="#blue-fx"/></material>
  <material id="photo" name="Photo"><instance_effect url="#photo-fx"/></material></library_materials>`;
const bind = (...pairs: [string, string][]): string =>
  `<bind_material><technique_common>${pairs.map(([symbol, target]) => `<instance_material symbol="${symbol}" target="#${target}"/>`).join('')}</technique_common></bind_material>`;

describe('COLLADA import', () => {
  it('recognizes .dae names and routes XML bytes to the COLLADA reader', async () => {
    expect(isColladaModelFile('Chair.DAE')).toBe(true);
    expect(isModelImportFile('Chair.dae') && isModelImportFile('Chair.skp') && !isModelImportFile('Chair.fbx')).toBe(true);
    expect(modelImportBaseName('Chair.Dae')).toBe('Chair');
    await expect(readModelImport(text('﻿  <?xml version="1.0"?><svg/>'))).rejects.toThrow('Not a COLLADA model');
    await expect(readModelImport(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow('Not a SketchUp model');
  });

  it('imports a SketchUp-style export: an inch-unit component placed by a wrapper node becomes one shared solid', async () => {
    const bytes = dae({
      unit: 0.0254, materials: RED,
      geometries: mesh('cube', CUBE_POSITIONS.split(' ').map(v => Number(v) * 10).join(' '),
        `<triangles material="paint" count="12"><input semantic="VERTEX" source="#cube-v" offset="0"/><p>${CUBE_TRIANGLES}</p></triangles>`),
      nodes: `<node id="box" name="Box"><instance_geometry url="#cube">${bind(['paint', 'red'])}</instance_geometry></node>`,
      scene: `<node name="SketchUp">
        <node name="First"><matrix>1 0 0 20 0 1 0 0 0 0 1 0 0 0 0 1</matrix><instance_node url="#box"/></node>
        <node name="Second"><translate>0 30 0</translate><rotate>0 0 1 90</rotate><instance_node url="#box"/></node>
      </node>`,
    });
    const scene = await readCollada(bytes);
    expect(scene.version).toBe('1.4.1, Test exporter');
    // The wrapper node is the model; each placement is an instance of the one component.
    expect(scene.root.instances.map(i => i.name)).toEqual(['First', 'Second']);
    expect(scene.definitions.size).toBe(1);
    const box = [...scene.definitions.values()][0]!;
    expect(box).toMatchObject({ name: 'Box', group: false, sheets: [] });
    expect(box.solids).toHaveLength(1);
    // Twelve triangles merge into the six square faces of the cube.
    expect(box.solids[0]!.faces.map(f => f.loops[0]!.length)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(box.solids[0]!.faces.every(f => f.front !== null && scene.materials.get(f.front)?.name === 'Red')).toBe(true);
    expect(scene.materials.get(box.solids[0]!.faces[0]!.front!)).toMatchObject({ color: [1, 0, 0], alpha: 0.5 });
    // Inches convert to meters in geometry and placements.
    expect(Math.max(...box.solids[0]!.mesh.verts)).toBeCloseTo(0.254, 10);
    expect(m4transformPoint(scene.root.instances[0]!.transform, [0, 0, 0])).toEqual([expect.closeTo(0.508, 10), 0, 0]);
    expect(m4transformPoint(scene.root.instances[1]!.transform, [0.254, 0, 0]).map(v => +v.toFixed(10))).toEqual([0, 1.016, 0]);

    const doc = createDocument();
    const report = doc.transact('Open fixture', draft => applySketchUpImport(draft, scene)).value;
    expect(report).toMatchObject({ bodies: 1, sheetFaces: 0, definitions: 1, instances: 2, materials: 1 });
    const component = [...doc.state.definitions.values()].find(d => d.id !== doc.state.rootDefinitionId)!;
    expect([...component.entities.bodies.values()][0]!.props.volume).toBeCloseTo(0.254 ** 3, 10);
    expect(decodeModelDocument(encodeModelDocument(doc)).definitions.size).toBe(doc.state.definitions.size);
  });

  it('turns Y-up meshes in their own nodes into Z-up groups and keeps loose lines', async () => {
    const scene = await readCollada(dae({
      up: 'Y_UP', unit: 0.01,
      geometries: mesh('tri', '0 0 0 100 0 0 0 100 0 100 100 0',
        `<triangles count="1"><input semantic="VERTEX" source="#tri-v" offset="0"/><p>0 1 2</p></triangles>
         <lines count="2"><input semantic="VERTEX" source="#tri-v" offset="0"/><p>0 1 1 3</p></lines>`),
      scene: `<node name="Camera"><instance_camera url="#none"/></node><node name="Sheet"><translate>0 200 0</translate><instance_geometry url="#tri"/></node>`,
    }));
    expect(scene.root.instances.map(i => i.name)).toEqual(['Sheet']);
    const sheet = [...scene.definitions.values()][0]!;
    expect(sheet.group).toBe(true);
    // Y (up) becomes Z; centimeters become meters.
    expect(sheet.sheets[0]!.loops[0]!).toContainEqual([0, 0, 1]);
    expect(sheet.sheets[0]!.normal.map(v => +v.toFixed(12))).toEqual([0, -1, 0]);
    expect(m4transformPoint(scene.root.instances[0]!.transform as Mat4, [0, 0, 0]).map(v => +v.toFixed(12))).toEqual([0, 0, 2]);
    // The line along the triangle's edge is that edge; the other one is loose.
    expect(sheet.edges.map(e => [e.a, e.b])).toEqual([[[1, 0, 0], [1, 0, 1]]]);
    expect(scene.warnings).toContain('Cameras and lights are not imported.');
  });

  it('keeps faces split where the file draws an edge, joins two-sided copies, and smooths shared vertex normals', async () => {
    const s = Math.SQRT1_2;
    const scene = await readCollada(dae({
      materials: RED,
      geometries:
        mesh('quad', '0 0 0 1 0 0 1 1 0 0 1 0',
          `<triangles material="front" count="2"><input semantic="VERTEX" source="#quad-v" offset="0"/><p>0 1 2 0 2 3</p></triangles>
           <triangles material="back" count="2"><input semantic="VERTEX" source="#quad-v" offset="0"/><p>0 2 1 0 3 2</p></triangles>
           <lines count="1"><input semantic="VERTEX" source="#quad-v" offset="0"/><p>0 2</p></lines>`) +
        mesh('fold', '0 0 0 1 0 0 1 1 1 0 1 1 1 2 0 0 2 0',
          `<triangles count="4"><input semantic="VERTEX" source="#fold-v" offset="0"/><input semantic="NORMAL" source="#fold-n" offset="1"/>
             <p>0 0 1 0 2 1 0 0 2 1 3 1 3 1 2 1 4 2 3 1 4 2 5 2</p></triangles>`, `0 -${s} ${s} 0 0 1 0 ${s} ${s}`),
      scene: `<node name="Quad"><instance_geometry url="#quad">${bind(['front', 'red'], ['back', 'blue'])}</instance_geometry></node>
              <node name="Fold"><instance_geometry url="#fold"/></node>`,
    }));
    const quad = [...scene.definitions.values()].find(d => d.name === 'Quad')!;
    // The drawn diagonal keeps the two triangles apart; their reversed copies are the backs.
    expect(quad.sheets.map(f => f.loops[0]!.length)).toEqual([3, 3]);
    expect(quad.sheets.map(f => [scene.materials.get(f.front!)?.name, scene.materials.get(f.back!)?.name]))
      .toEqual([['Red', 'Blue'], ['Red', 'Blue']]);
    expect(quad.edges).toEqual([]);
    const fold = [...scene.definitions.values()].find(d => d.name === 'Fold')!;
    // Two planes of two triangles each: the crease between them shares its vertex normals, so it is soft and smooth.
    expect(fold.sheets).toHaveLength(2);
    const flags = fold.sheets.flatMap(f => f.edgeFlags.flat()), crease = flags.filter(f => f.soft && f.smooth);
    expect(crease).toHaveLength(2);
    expect(new Set(crease.map(f => f.edge)).size).toBe(1);
  });

  it('keeps the points zero-area sliver triangles carry along a face edge, so the shell still closes', async () => {
    // The top is split at (0.5, 0, 1); the front's triangulation reaches that point only through a sliver.
    const scene = await readCollada(dae({
      geometries: mesh('box', `${CUBE_POSITIONS} 0.5 0 1`,
        `<triangles count="14"><input semantic="VERTEX" source="#box-v" offset="0"/>
          <p>0 3 2 0 2 1 4 8 7 8 6 7 8 5 6 0 1 5 0 5 4 5 8 4 3 7 6 3 6 2 0 4 7 0 7 3 1 2 6 1 6 5</p></triangles>`),
      scene: '<node name="Box"><instance_geometry url="#box"/></node>',
    }));
    expect(scene.root.sheets).toEqual([]);
    expect(scene.root.solids).toHaveLength(1);
    const faces = scene.root.solids[0]!.faces;
    expect(faces.map(f => f.loops[0]!.length).sort()).toEqual([4, 4, 4, 4, 5, 5]);
    expect(scene.warnings.some(w => /enclose no area/.test(w))).toBe(false);
  });

  it('treats a triangle on one line far from the origin as a sliver, though rounding leaves it some area', async () => {
    // From 3dw-rooftop-garden's model.dae: SketchUp's export fans a wall's bottom edge from a point 1.6 km away, and
    // the fan's triangles on that line keep about 2e-10 m² from rounding. They used to become faces that were skipped.
    const scene = await readCollada(dae({
      unit: 0.0254,
      geometries: mesh('wall', '65174.45 -51881.93 -50409.8 7977.554 -51881.93 -50409.8 8434.754 -51881.93 -50409.8 8434.754 -51881.93 -50108',
        `<triangles count="2"><input semantic="VERTEX" source="#wall-v" offset="0"/><p>0 1 2 1 2 3</p></triangles>`),
      scene: '<node name="Wall"><instance_geometry url="#wall"/></node>',
    }));
    expect(scene.root.sheets).toHaveLength(1);
    expect(scene.warnings.some(w => /skipped: empty triangulation/.test(w))).toBe(false);
    expect(scene.warnings).toContain('1 polygon that encloses no area is skipped.');
  });

  it('imports a polygon with holes as one face with those holes', async () => {
    // A 4 m square with two holes whose edges line up, as windows with one sill height do; one is wound like the
    // outline and one against it.
    const scene = await readCollada(dae({
      geometries: mesh('wall', '0 0 0 4 0 0 4 4 0 0 4 0  1 1 0 2 1 0 2 2 0 1 2 0  3 3 0 3 2 0 2.5 2 0 2.5 3 0',
        `<polygons count="1"><input semantic="VERTEX" source="#wall-v" offset="0"/><ph><p>0 1 2 3</p><h>4 5 6 7</h><h>8 9 10 11</h></ph></polygons>`),
      scene: '<node name="Wall"><instance_geometry url="#wall"/></node>',
    }));
    expect(scene.root.sheets).toHaveLength(1);
    expect(scene.root.sheets[0]!.loops.map(loop => loop.length)).toEqual([4, 4, 4]);
    expect(scene.warnings.some(w => /holes|enclose no area|nonplanar/.test(w))).toBe(false);
  });

  it('reports what it does not import and fails without geometry', async () => {
    const scene = await readCollada(dae({
      materials: RED,
      geometries: mesh('poly', '0 0 0 2 0 0 2 2 0 0 2 0 1 1 0',
        `<polylist material="m" count="1"><input semantic="VERTEX" source="#poly-v" offset="0"/><vcount>4</vcount><p>0 1 2 3</p></polylist>`),
      scene: `<node name="Poly"><instance_geometry url="#poly">${bind(['m', 'photo'])}</instance_geometry></node>`,
    }));
    expect(scene.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^COLLADA import: geometry, nodes/),
      '1 textured material uses its color: textures are imported from a .zip or .kmz archive that holds the model with its images.',
    ]));
    // The scene's one node at the origin is the model itself.
    expect(scene.root.sheets[0]!.loops[0]).toHaveLength(4);
    await expect(readCollada(dae({ geometries: '', scene: '<node name="Empty"/>' }))).rejects.toThrow('No supported geometry was found in this COLLADA file');
    await expect(readCollada(text('<COLLADA><library_geometries></COLLADA>'))).rejects.toThrow('Could not read this COLLADA file');
  });
});

// A 1×1 PNG.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

/** A 2 m × 1 m wall of two triangles painted with a textured Brick material whose image is at `image`. */
function texturedWall(image: string, uvs = '0 0 2 0 2 1 0 1', second = '0 0 2 2 3 3'): Uint8Array {
  return dae({

    materials: `<library_images><image id="brick-img"><init_from>${image}</init_from></image></library_images>
      <library_effects><effect id="brick-fx"><profile_COMMON>
        <newparam sid="brick-surface"><surface type="2D"><init_from>brick-img</init_from></surface></newparam>
        <newparam sid="brick-sampler"><sampler2D><source>brick-surface</source></sampler2D></newparam>
        <technique sid="common"><lambert><diffuse><texture texture="brick-sampler" texcoord="UVSET0"/></diffuse></lambert></technique>
      </profile_COMMON></effect>
      <effect id="default-fx"><profile_COMMON><technique sid="common"><lambert><diffuse><color>0.64 0.72 0.78 1</color></diffuse></lambert></technique></profile_COMMON></effect></library_effects>
      <library_materials><material id="brick" name="Brick"><instance_effect url="#brick-fx"/></material>
        <material id="default" name="material"><instance_effect url="#default-fx"/></material></library_materials>`,
    geometries: `<geometry id="wall"><mesh>
      <source id="wall-p"><float_array id="wall-pa" count="12">0 0 0 2 0 0 2 1 0 0 1 0</float_array>
        <technique_common><accessor source="#wall-pa" count="4" stride="3"/></technique_common></source>
      <source id="wall-uv"><float_array id="wall-uva" count="${uvs.split(' ').length}">${uvs}</float_array>
        <technique_common><accessor source="#wall-uva" count="${uvs.split(' ').length / 2}" stride="2"/></technique_common></source>
      <vertices id="wall-v"><input semantic="POSITION" source="#wall-p"/></vertices>
      <triangles material="paint" count="2"><input semantic="VERTEX" source="#wall-v" offset="0"/>
        <input semantic="TEXCOORD" source="#wall-uv" offset="1" set="0"/><p>0 0 1 1 2 2 ${second}</p></triangles>
      <triangles material="plain" count="2"><input semantic="VERTEX" source="#wall-v" offset="0"/>
        <input semantic="TEXCOORD" source="#wall-uv" offset="1" set="0"/><p>0 0 2 2 1 1 0 0 3 3 2 2</p></triangles></mesh></geometry>`,
    scene: `<node name="Wall"><instance_geometry url="#wall"><bind_material><technique_common>
      <instance_material symbol="paint" target="#brick"><bind_vertex_input semantic="UVSET0" input_semantic="TEXCOORD" input_set="0"/></instance_material>
      <instance_material symbol="plain" target="#default"/></technique_common></bind_material></instance_geometry></node>`,
  });
}

describe('COLLADA archives', () => {
  it('reads a .zip with its texture image and places the texture by the file\'s coordinates', async () => {
    expect(isModelImportFile('Wall.ZIP') && isModelImportFile('Wall.kmz') && modelImportBaseName('Wall.KMZ') === 'Wall').toBe(true);
    const bytes = zipSync({ 'Wall/model.dae': texturedWall('model%20images/brick.png'), 'Wall/model images/brick.png': PNG });
    const scene = await readModelImport(bytes);
    expect(scene.images).toEqual([expect.objectContaining({ name: 'brick.png', mime: 'image/png', width: 1, height: 1 })]);
    const brick = [...scene.materials.values()].find(m => m.name === 'Brick')!;
    // One image spans 1 m: the coordinates run 0–2 along the 2 m wall.
    expect(brick.texture).toMatchObject({ image: 0, widthM: expect.closeTo(1, 9), heightM: expect.closeTo(1, 9) });
    const [face] = scene.root.sheets;
    expect(scene.root.sheets).toHaveLength(1);
    expect(scene.materials.get(face!.front!)?.name).toBe('Brick');
    const at = (p: [number, number, number]): number[] => [face!.frontUv!.s, face!.frontUv!.t]
      .map(m => +(m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3]).toFixed(9));
    expect(at([2, 1, 0])).toEqual([2, 1]);
    expect(at([0, 1, 0])).toEqual([0, 1]);
    // The reversed copy is its untextured back.
    expect(scene.materials.get(face!.back!)?.name).toBe('material');
    const doc = createDocument();
    expect(doc.transact('Open', draft => applySketchUpImport(draft, scene)).value).toMatchObject({ sheetFaces: 1, materials: 2 });
  });

  it('keeps a texture seam inside a plane as an edge', async () => {
    const scene = await readModelImport(zipSync({ 'model.dae': texturedWall('brick.png', '0 0 2 0 2 1 0 1 5 5 7 6 5 6', '0 3 2 5 3 6'), 'brick.png': PNG }));
    expect(scene.root.sheets.map(f => f.loops[0]!.length)).toEqual([3, 3]);
  });

  it('reads the model a .kmz names in doc.kml and reports what it leaves out', async () => {
    const kml = '<kml><Placemark><Model><Location><longitude>1</longitude></Location><Link><href>models/house.dae</href></Link></Model></Placemark></kml>';
    const scene = await readModelImport(zipSync({ 'doc.kml': strToU8(kml), 'models/house.dae': texturedWall('house/brick.png'),
      'models/house/brick.png': PNG, 'models/other.dae': text('<COLLADA/>') }));
    expect(scene.images).toHaveLength(1);
    expect(scene.warnings).toEqual(expect.arrayContaining(['1 other model in the archive is not imported.',
      'The Google Earth location of a .kmz model is not imported.']));
  });

  it('uses the color of a material whose image the archive lacks', async () => {
    const scene = await readModelImport(zipSync({ 'model.dae': texturedWall('missing.png') }));
    expect(scene.images).toEqual([]);
    expect(scene.warnings).toContain('1 texture image is missing from the archive; its material uses its color.');
    expect(scene.materials.get(scene.root.sheets[0]!.front!)).toMatchObject({ name: 'Brick', texture: null });
    await expect(readModelImport(zipSync({ 'notes.txt': strToU8('none') }))).rejects.toThrow('No COLLADA, OBJ, 3DS or glTF model (.dae, .obj, .3ds, .gltf or .glb) was found in this archive.');
  });
});
