// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Every SketchUp fixture opened, written with the SketchUp export, and opened again: faces, edges and their soft,
// smooth and hidden flags, area, volume, bounds, definitions, placements and materials must come back unchanged. Tags,
// scenes and display settings are not written. A fixture listed in DIFFERENCES may differ only in what is listed there.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDocument, ImageStore, modelStatistics, type DocumentState, type ModelStatistics } from '@pushform/model';
import { readSketchUp } from './sketchup';
import { applySketchUpImport } from './sketchupDocument';
import { exportSkp } from './skpExport';

const folder = new URL('../../testing/assets/sketchup/', import.meta.url);
type Compared = 'faces' | 'edges' | 'area' | 'volume' | 'bounds' | 'definitions' | 'instances' | 'materials' | 'flags';
const COMPARED: Compared[] = ['faces', 'edges', 'area', 'volume', 'bounds', 'definitions', 'instances', 'materials', 'flags'];

/** Known differences, by fixture name prefix, with the reason the written file differs. */
const DIFFERENCES: Record<string, { allowed: Compared[]; reason: string }> = {
  'entity-tags-': { allowed: ['faces', 'edges', 'area', 'bounds', 'definitions', 'instances', 'flags'], reason: 'content on hidden tags is not exported' },
  'tag-attributes-': { allowed: ['edges', 'bounds'], reason: 'an edge on a hidden tag, which sets the bounds, is not exported' },
};
const fixtures = readdirSync(folder).filter(name => name.endsWith('.skp')).sort();

async function openFile(bytes: Uint8Array) {
  const scene = await readSketchUp(bytes);
  const doc = createDocument(), images = new ImageStore();
  doc.transact('Open', draft => applySketchUpImport(draft, scene, { images }));
  return { doc, images };
}

/** Soft, smooth and hidden edges of solids and sheets, every definition once. */
function edgeFlags(state: DocumentState): string {
  let soft = 0, smooth = 0, hidden = 0;
  for (const definition of state.definitions.values()) {
    const edges = [...[...definition.entities.bodies.values()].flatMap(body => [...body.edges.values()]), ...definition.entities.sketch.edges.values()];
    for (const edge of edges) { if (edge.soft) soft++; if (edge.smooth) smooth++; if (edge.hidden) hidden++; }
  }
  return `soft ${soft}, smooth ${smooth}, hidden ${hidden}`;
}

function same(key: Exclude<Compared, 'flags'>, a: ModelStatistics, b: ModelStatistics): boolean {
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
    const flags = [edgeFlags(original.doc.state), edgeFlags(reopened.doc.state)];
    const differing = COMPARED.filter(key => (key === 'flags' ? flags[0] !== flags[1] : !same(key, before, after)));
    expect(differing.filter(key => !known?.allowed.includes(key)), `${name}: ${JSON.stringify({ before, after, flags })}`).toEqual([]);
  });
});
