// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Every SketchUp fixture opened, written with the SketchUp export, and opened again: what the export keeps must come
// back unchanged. Faces are written as triangles, so face, edge and vertex counts are not compared; tags, scenes and
// display settings are not written. A fixture listed in DIFFERENCES may differ only in the statistics listed there.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDocument, ImageStore, modelStatistics, type ModelStatistics } from '@pushform/model';
import { readSketchUp } from './sketchup';
import { applySketchUpImport } from './sketchupDocument';
import { exportSkp } from './skpExport';

const folder = new URL('../../testing/assets/sketchup/', import.meta.url);
type Compared = 'area' | 'volume' | 'bounds' | 'definitions' | 'instances' | 'materials';
const COMPARED: Compared[] = ['area', 'volume', 'bounds', 'definitions', 'instances', 'materials'];

/** Known differences, by fixture name prefix, with the reason the written file differs. */
const DIFFERENCES: Record<string, { allowed: Compared[]; reason: string }> = {
  'entity-tags-': { allowed: ['area', 'bounds', 'definitions', 'instances'], reason: 'content on hidden tags is not exported' },
  'tag-attributes-': { allowed: ['area', 'bounds', 'definitions', 'instances'], reason: 'content on hidden tags is not exported' },
  'textures-': { allowed: ['definitions', 'materials'], reason: 'placements painted differently become separate definitions; unused materials are not written' },
  'annotations-': { allowed: ['materials'], reason: 'unused materials are not written' },
  'colorize-': { allowed: ['materials'], reason: 'unused materials are not written' },
  'text-scenes-': { allowed: ['materials'], reason: 'unused materials are not written' },
};
/** Fixtures the reader does not open; they have nothing to export. */
const UNREADABLE = new Set(['scene-styles-2020.skp']);

const fixtures = readdirSync(folder).filter(name => name.endsWith('.skp') && !UNREADABLE.has(name)).sort();

async function openFile(bytes: Uint8Array) {
  const scene = await readSketchUp(bytes);
  const doc = createDocument(), images = new ImageStore();
  doc.transact('Open', draft => applySketchUpImport(draft, scene, { images }));
  return { doc, images };
}

function same(key: Compared, a: ModelStatistics, b: ModelStatistics): boolean {
  if (key === 'bounds') {
    if (!a.bounds || !b.bounds) return a.bounds === b.bounds;
    return [0, 1, 2].every(k => Math.abs(a.bounds!.min[k]! - b.bounds!.min[k]!) < 1e-9 && Math.abs(a.bounds!.max[k]! - b.bounds!.max[k]!) < 1e-9);
  }
  const x = a[key], y = b[key];
  return Math.abs(x - y) <= 1e-9 * Math.max(Math.abs(x), Math.abs(y), 1);
}

describe('SketchUp export round trip of every fixture', () => {
  it('covers the fixtures', () => expect(fixtures.length).toBeGreaterThan(30));

  it.each(fixtures)('%s', async name => {
    const original = await openFile(new Uint8Array(readFileSync(new URL(name, folder))));
    const written = exportSkp(original.doc.state, { name, image: id => {
      const blob = original.images.get(id);
      return blob ? { bytes: blob.bytes, mime: blob.mime, name: `image${id}` } : undefined;
    } });
    const reopened = await openFile(written.bytes);
    const before = modelStatistics(original.doc.state), after = modelStatistics(reopened.doc.state);
    const known = Object.entries(DIFFERENCES).find(([prefix]) => name.startsWith(prefix))?.[1];
    const differing = COMPARED.filter(key => !same(key, before, after));
    expect(differing.filter(key => !known?.allowed.includes(key)), `${name}: ${JSON.stringify({ before, after })}`).toEqual([]);
    // Triangulation never loses a face: the written file has at least as many faces as the original.
    if (!known?.allowed.includes('area')) expect(after.faces).toBeGreaterThanOrEqual(before.faces);
  });
});
