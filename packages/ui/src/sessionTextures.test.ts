// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { basisToLocal } from '@pushform/core';
import { readSketchUp } from '@pushform/io';
import { createApp } from './bootstrap';
import { IDBFactory } from 'fake-indexeddb';
import { DocumentSession } from './session';
import { loadRefreshImages } from './refreshImages';
import { renderMaterial, sketchesToRender } from './engine/renderAdapter';

// jsdom gives tests an http import.meta.url; vitest runs from the repository root.
const asset = (name: string): Buffer => readFileSync(join(process.cwd(), 'packages/testing/assets/sketchup', name));
interface TruthFace { definition: string; front?: { uvs: [number, number][] }; back?: { uvs: [number, number][] } }

class MemoryStorage {
  values = new Map<string, string>();
  /** Keys whose writes fail as if over quota. */
  full = (_key: string): boolean => false;
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.full(key)) throw new Error('QuotaExceededError');
    this.values.set(key, value);
  }
  removeItem(key: string): void { this.values.delete(key); }
}

let session: DocumentSession | null = null;
afterEach(() => {
  session?.dispose();
  session = null;
});

describe('SketchUp textures in the app', () => {
  it('opens textures, keeps them in definition coordinates under instance transforms, and saves them in the .pf', async () => {
    session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true);
    const { tab } = session.openSketchUpModel(await readSketchUp(asset('textures-2027.skp')), 'textures-2027.skp');
    const store = tab.app.document.images, state = tab.app.document.doc.state;
    expect(store.size).toBe(3);
    const quadrants = [...state.materials.values()].find(m => m.name === 'Quadrants')!;
    expect(renderMaterial(state, quadrants.id, store)?.textureUrl).toBeTruthy();

    // The panel is placed twice, once rotated 60° about X and scaled 1.5 × 2; both show SketchUp's coordinates.
    const truth = (JSON.parse(asset('textures-uv.json').toString()) as { faces: TruthFace[] }).faces.find(f => f.definition === 'Textured panel')!;
    const panels = sketchesToRender(state, { images: store }).filter(s => s.path.length === 1 && s.faces.some(f => f.frontMaterial?.id === quadrants.id && f.uv?.kind === 'affine'));
    expect(panels).toHaveLength(2);
    expect(panels.filter(s => s.faces[0]!.uvBasis)).toHaveLength(2);
    for (const sketch of panels) {
      const face = sketch.faces[0]!;
      const tiles = face.loops[0]!.map(p => {
        const [u, v] = basisToLocal(face.uvBasis ?? face.basis, p);
        const front = face.uv!.kind === 'affine' ? face.uv!.matrix : [0, 0, 0, 0, 0, 0];
        const back = face.uvBack?.kind === 'affine' ? face.uvBack.matrix : null;
        const width = face.backMaterial!.widthM!, height = face.backMaterial!.heightM!;
        return { front: [front[0]! * u + front[1]! * v + front[2]!, front[3]! * u + front[4]! * v + front[5]!],
          back: back ? [back[0] * u + back[1] * v + back[2], back[3] * u + back[4] * v + back[5]] : [u / width, v / height] };
      });
      // Match corners by their front coordinates; SketchUp lists the same corners in its own order.
      for (const [i, expected] of truth.front!.uvs.entries()) {
        const corner = tiles.find(t => Math.hypot(t.front[0]! - expected[0], t.front[1]! - expected[1]) < 1e-6);
        expect(corner, `front corner ${i}`).toBeDefined();
        expect(corner!.back[0]).toBeCloseTo(truth.back!.uvs[i]![0], 6);
        expect(corner!.back[1]).toBeCloseTo(truth.back!.uvs[i]![1], 6);
      }
    }

    const reopened = await session.openModelBytes(await session.saveModelBytes(tab.id, 'textures.pf'), 'textures copy.pf');
    expect(reopened.app.document.images.size).toBe(3);
    for (const [id, entry] of store.entries()) expect(reopened.app.document.images.get(id)!.bytes).toEqual(entry.blob.bytes);
    const copy = reopened.app.document.doc.state;
    expect(renderMaterial(copy, quadrants.id, reopened.app.document.images)?.textureUrl).toBeTruthy();
  });

  it('keeps the image bytes through a page refresh, so saving afterwards still stores them', async () => {
    const storage = new MemoryStorage();
    const make = (): DocumentSession => new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null, storage);
    session = make();
    const { tab } = session.openSketchUpModel(await readSketchUp(asset('textures-2027.skp')), 'textures-2027.skp');
    const original = new Map([...tab.app.document.images.entries()].map(([id, entry]) => [id, entry.blob.bytes]));
    expect(original.size).toBe(3);
    session.dispose();

    session = make();
    const restored = session.active;
    expect(restored.type).toBe('model');
    if (restored.type !== 'model') return;
    expect(restored.app.document.images.size).toBe(3);
    for (const [id, bytes] of original) expect(restored.app.document.images.get(id)!.bytes).toEqual(bytes);
    const quadrants = [...restored.app.document.doc.state.materials.values()].find(m => m.name === 'Quadrants')!;
    expect(renderMaterial(restored.app.document.doc.state, quadrants.id, restored.app.document.images)?.textureUrl).toBeTruthy();
    const saved = await session.openModelBytes(await session.saveModelBytes(restored.id, 'textures.pf'), 'textures copy.pf');
    expect(saved.app.document.images.size).toBe(3);

    // Closing the tabs drops the kept bytes with the next (coalesced) refresh snapshot.
    expect([...storage.values.keys()].filter(k => k.includes(':image:'))).toHaveLength(3);
    session.close(saved.id, true);
    session.close(restored.id, true);
    session.flushRefreshPersistence();
    expect([...storage.values.keys()].filter(k => k.includes(':image:'))).toHaveLength(0);
  });

  it('keeps image bytes in IndexedDB, so a full session storage loses none across a refresh', async () => {
    const storage = new MemoryStorage(), factory = new IDBFactory();
    storage.full = key => key.includes(':image:');
    const make = async (): Promise<DocumentSession> => {
      const images = await loadRefreshImages(storage, factory);
      return new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null, storage, images);
    };
    session = await make();
    const { tab } = session.openSketchUpModel(await readSketchUp(asset('textures-2027.skp')), 'textures-2027.skp');
    const original = new Map([...tab.app.document.images.entries()].map(([id, entry]) => [id, entry.blob.bytes]));
    session.flushRefreshPersistence();
    session.dispose();
    // Writes run in the background; the next page load opens the database after they finish.
    await new Promise(resolve => setTimeout(resolve, 50));

    session = await make();
    const restored = session.active;
    if (restored.type !== 'model') throw new Error('expected the model tab');
    expect(restored.app.document.images.size).toBe(3);
    for (const [id, bytes] of original) expect(restored.app.document.images.get(id)!.bytes).toEqual(bytes);
    expect([...storage.values.keys()].filter(k => k.includes(':image:'))).toEqual([]);
    const saved = await session.openModelBytes(await session.saveModelBytes(restored.id, 'textures.pf'), 'textures copy.pf');
    expect(saved.app.document.images.size).toBe(3);
  });

  it('restores a tab without the images that did not fit the refresh storage', async () => {
    const storage = new MemoryStorage();
    storage.full = key => key.includes(':image:');
    const make = (): DocumentSession => new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null, storage);
    session = make();
    session.openSketchUpModel(await readSketchUp(asset('textures-2027.skp')), 'textures-2027.skp');
    session.dispose();
    session = make();
    expect(session.active.type).toBe('model');
    if (session.active.type !== 'model') return;
    expect(session.active.app.document.images.size).toBe(0);
    expect(session.active.app.document.doc.state.images.size).toBe(3);
  });
});
