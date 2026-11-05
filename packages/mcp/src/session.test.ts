// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { allocId, createDocument, ImageStore } from '@pushform/model';
import type { ImageId } from '@pushform/core';
import { encodeModelSnapshot, modelArchiveImages, modelContentIdentity, openModelFile } from '@pushform/io';
import { HeadlessSession } from './session';
import type { PushPullApplyResult } from '@pushform/commands';

const sessions: HeadlessSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); });
function session(): HeadlessSession { const s = new HeadlessSession(); sessions.push(s); return s; }

const curvedBooleanCases = [8, 24].flatMap(segments =>
  (['subtract', 'trim', 'union', 'intersect', 'split'] as const).flatMap(mode =>
    [false, true].flatMap(curvedFirst =>
      (mode === 'trim' && curvedFirst ? [1, 2] : [2]).map(depth => ({ segments, mode, curvedFirst, depth })))));

it.each(curvedBooleanCases)('round-trips $mode with a $segments-segment cylinder (curved first: $curvedFirst, depth: $depth in)', async ({ segments, mode, curvedFirst, depth }) => {
  const s = session(), { host, registry } = s.model;
  const inch = 0.0254;
  const stud = registry.execute('model.addBox', { min: [0, 0, 1.5 * inch], max: [1.5 * inch, 3.5 * inch, 94.125 * inch] }) as number;
  const radius = 0.5 * inch;
  const center = [-0.25 * inch, 1.75 * inch, 24 * inch];
  registry.execute('sketch.addCurve', {
    points: Array.from({ length: segments }, (_, i) => {
      const angle = i * 2 * Math.PI / segments;
      return [center[0], center[1]! + radius * Math.cos(angle), center[2]! + radius * Math.sin(angle)];
    }),
    closed: true, curve: { kind: 'circle', center, normal: [1, 0, 0], radius, segments },
  });
  const face = [...host.doc.rootDefinition.entities.sketch.faces.values()][0]!;
  const cylinder = await registry.execute('pushpull.apply', { target: { kind: 'sketchFace', id: face.id }, distance: depth * inch, mode: 'newBody' }) as PushPullApplyResult;
  const cylinderId = cylinder.bodyIds[0]!;
  const [a, b] = (curvedFirst ? [cylinderId, stud] : [stud, cylinderId]).map(id => ({ kind: 'body', id }));
  await registry.execute(`solids.${mode}`, { a, b });
  const bodies = [...host.doc.rootDefinition.entities.bodies.values()];
  const area = segments / 2 * radius ** 2 * Math.sin(2 * Math.PI / segments);
  const studVolume = 1.5 * 3.5 * (94.125 - 1.5) * inch ** 3;
  const cylinderVolume = area * depth * inch, overlap = area * Math.min(depth - 0.25, 1.5) * inch;
  const expectedVolume = mode === 'intersect' ? overlap
    : mode === 'subtract' || mode === 'trim' ? (curvedFirst ? studVolume : cylinderVolume) - overlap
    : studVolume + cylinderVolume - overlap;
  const changedBodies = mode === 'trim' ? bodies.filter(body => body.id !== a!.id) : bodies;
  expect(changedBodies.length).toBeGreaterThan(0);
  expect(changedBodies.reduce((sum, body) => sum + body.props.volume, 0)).toBeCloseTo(expectedVolume, 9);
  for (const body of bodies) {
    expect(body.valid).toBe(true);
    for (const surface of body.surfaces.values()) {
      expect(surface.faceIds.length).toBeGreaterThan(0);
      for (const fid of surface.faceIds) expect(body.faces.get(fid)?.surfaceId).toBe(surface.id);
      if (surface.curveId !== null) expect(body.curves.has(surface.curveId)).toBe(true);
    }
  }
  if ((mode === 'subtract' || mode === 'trim') && curvedFirst) {
    const cut = changedBodies[0]!;
    expect(cut.surfaces.size).toBe(1);
    if (depth === 2) expect([...cut.surfaces.values()][0]!.curveId).toBeNull();
    else expect(cut.curves.size).toBeGreaterThan(0);
    expect([...cut.edges.values()].filter(edge => edge.soft)).toHaveLength(segments);
  }
  const reopened = session();
  await reopened.load(await s.model.encode());
  const identity = modelContentIdentity(host.doc.state);
  expect(modelContentIdentity(reopened.model.host.doc.state)).toBe(identity);
  host.undo();
  expect([...host.doc.rootDefinition.entities.bodies.values()]).toHaveLength(2);
  host.redo();
  expect(modelContentIdentity(host.doc.state)).toBe(identity);
});

it('opens application-native bytes with image assets and saves the captured revision', async () => {
  const doc = createDocument(), images = new ImageStore(), bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const asset = doc.transact('image', d => {
    const id = allocId<ImageId>(d), asset = { id, name: 'tile.png', mime: 'image/png', width: 1, height: 1, sha256: 'fixture' };
    d.images.set(id, asset); return asset;
  }).value;
  images.register(asset, bytes);
  const s = session();
  await s.load(await encodeModelSnapshot(doc.state, modelArchiveImages(doc.state, images)), 'input.pf');
  expect(s.path).toBe('input.pf'); expect(s.model.host.images.get(asset.id)!.bytes).toEqual(bytes);
  const captured = modelContentIdentity(s.model.host.doc.state), encoding = s.model.encode();
  s.model.host.doc.transact('later', d => { d.definitions.get(d.rootDefinitionId)!.name = 'Later'; });
  const reopened = await openModelFile(await encoding);
  expect(reopened.contentIdentity).toBe(captured);
  expect(reopened.images.get(asset.id)!.bytes).toEqual(bytes);
  expect(modelContentIdentity(s.model.host.doc.state)).not.toBe(captured);
});

it('keeps the open model and path when native validation rejects a file', async () => {
  const s = session(), native = await s.model.encode();
  await s.load(native, 'existing.pf');
  const model = s.model;
  const invalidHeader = native.slice(); invalidHeader[0] = 0;
  for (const invalid of [native.subarray(0, native.length - 1), invalidHeader]) {
    await expect(s.load(invalid, 'bad.pf')).rejects.toThrow();
    expect(s.model).toBe(model); expect(s.path).toBe('existing.pf');
  }
});

it('registers the edge blend, section plane and 3D text commands the model document API runs', () => {
  const s = session();
  for (const id of ['fillet.apply', 'chamfer.apply', 'sectionPlane.add', 'sectionPlane.setActive', 'text3d.create']) expect(s.model.registry.has(id)).toBe(true);
});
