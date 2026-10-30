// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Id, MaterialId } from '@pushform/core';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import type { EntityRef } from '@pushform/model';
import { createApp } from '../bootstrap';
import { bodiesToRender, faceMaterialsToRender, renderMaterial, setRenderImageStore, sketchesToRender, uvOverrideKey } from './renderAdapter';

function boot() {
  return createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
}

describe('renderAdapter materials', () => {
  it('resolves per-face materials through the body and the instance material; explicit face materials win', async () => {
    const app = boot();
    try {
      const { commands, document: host } = app;
      const bodyId = commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as Id;
      const red = commands.execute('material.create', { name: 'Red', color: [1, 0, 0] }) as number;
      const blue = commands.execute('material.create', { name: 'Blue', color: [0, 0, 1], alpha: 0.5 }) as number;
      const faceId = [...host.doc.rootDefinition.entities.bodies.get(bodyId)!.faces.keys()][0]!;
      const faceRef: EntityRef = { kind: 'face', path: [], id: bodyId, faceId, region: null };
      commands.execute('paint.apply', { refs: [faceRef], materialId: blue });
      // no instance: body default → faces without a material have no render material
      let bodies = bodiesToRender(host.doc.state);
      let fm = bodies[0]!.faceMaterials!;
      expect(fm.get(faceId)?.front).toMatchObject({ id: blue, color: '#0000ff', alpha: 0.5 });
      expect(fm.get(faceId)?.back).toBeNull();
      expect(fm.size).toBe(1);
      // group it and paint the instance red: default faces inherit red, the blue face keeps blue
      const { instanceId } = commands.execute('group.make', { refs: [{ kind: 'body', path: [], id: bodyId }] }) as { instanceId: number };
      commands.execute('paint.apply', { refs: [{ kind: 'instance', path: [], id: instanceId }], materialId: red });
      bodies = bodiesToRender(host.doc.state);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.path).toEqual([instanceId]);
      expect(bodies[0]!.defaultColor).toBe('#ff0000');
      fm = bodies[0]!.faceMaterials!;
      expect(fm.size).toBe(6);
      expect(fm.get(faceId)?.front?.id).toBe(blue);
      expect(fm.get(faceId)?.back?.id).toBe(red);
      for (const [id, e] of fm) if (id !== faceId) expect(e.front?.id).toBe(red);
      // identity-stable while nothing changed; new map after a paint
      const again = bodiesToRender(host.doc.state)[0]!.faceMaterials;
      expect(again).toBe(fm);
      commands.execute('context.enter', { instanceId });
      const inner = [...app.document.doc.state.definitions.values()].find((d) => d.isGroup)!.entities.bodies.values().next().value!;
      commands.execute('paint.apply', { refs: [{ kind: 'body', path: [instanceId], id: inner.id }], materialId: blue });
      const after = bodiesToRender(host.doc.state)[0]!.faceMaterials!;
      expect(after).not.toBe(fm);
      expect(after.get(faceId)?.back?.id).toBe(blue);
      // textures: a material with an image gets a texture URL from the host image store
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      const res = (await commands.execute('material.importImage', { bytes: png, name: 'tex.png' })) as { materialId: number };
      setRenderImageStore(host.images);
      const rm = renderMaterial(host.doc.state, res.materialId as MaterialId)!;
      expect(rm.textureUrl).toMatch(/^(blob:|data:image\/png)/);
      expect(rm).toMatchObject({ widthM: 1, heightM: 1 }); expect(rm.colorize).toBeUndefined();
      // A colorized texture carries SketchUp's colorize type, shift unless set.
      commands.execute('material.update', { id: res.materialId, texture: { colorize: true } });
      expect(renderMaterial(host.doc.state, res.materialId as MaterialId)!.colorize).toBe('shift');
      commands.execute('material.update', { id: res.materialId, texture: { colorizeType: 'tint' } });
      expect(renderMaterial(host.doc.state, res.materialId as MaterialId)!.colorize).toBe('tint');
      expect(renderMaterial(host.doc.state, null)).toBeNull();
      expect(renderMaterial(host.doc.state, host.doc.state.defaultMaterialId)).toBeNull();
    } finally {
      app.dispose();
    }
  });

  it('applies UV overrides (live texture positioning) to bodies and sketch faces', () => {
    const app = boot();
    try {
      const { commands, document: host } = app;
      const bodyId = commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] }) as Id;
      const body = host.doc.rootDefinition.entities.bodies.get(bodyId)!;
      const faceId = [...body.faces.keys()][0]!;
      const ref: EntityRef = { kind: 'face', path: [], id: bodyId, faceId, region: null };
      const key = uvOverrideKey(ref)!;
      const overrides = new Map([[key, { kind: 'affine' as const, matrix: [1, 0, 0.25, 0, 1, 0] as const }]]);
      const fm = faceMaterialsToRender(host.doc.state, body, null, { uvOverrides: overrides });
      expect(fm.get(faceId)?.uv).toEqual({ kind: 'affine', matrix: [1, 0, 0.25, 0, 1, 0] });
      expect(faceMaterialsToRender(host.doc.state, body, null).get(faceId)).toBeUndefined();
      expect(bodiesToRender(host.doc.state, { uvOverrides: overrides })[0]!.faceMaterials!.get(faceId)?.uv.kind).toBe('affine');
      commands.execute('sketch.rectangle', { a: [5, 0, 0], b: [6, 0, 0], c: [6, 1, 0], d: [5, 1, 0] });
      const sf = [...host.doc.rootDefinition.entities.sketch.faces.keys()][0]!;
      const sKey = uvOverrideKey({ kind: 'sketchFace', path: [], id: sf })!;
      const s1 = sketchesToRender(host.doc.state)[0]!;
      const s2 = sketchesToRender(host.doc.state, { uvOverrides: new Map([[sKey, { kind: 'affine' as const, matrix: [2, 0, 0, 0, 2, 0] as const }]]) })[0]!;
      expect(s1.faces[0]!.uv).toEqual({ kind: 'auto' });
      expect(s2.faces[0]!.uv).toEqual({ kind: 'affine', matrix: [2, 0, 0, 0, 2, 0] });
      expect(s2.version).not.toBe(s1.version);
      expect(uvOverrideKey({ kind: 'body', path: [], id: bodyId })).toBeNull();
    } finally {
      app.dispose();
    }
  });
});
