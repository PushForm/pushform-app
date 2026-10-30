// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { meshBox, type Id } from '@pushform/core';
import { bodyFromMesh } from '@pushform/model';
import type { EntityRef } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT } from '../host/services';
import { sketchCommands } from './sketch';

function setup() {
  const host = new DocumentHost();
  const commands = new CommandRegistry({ tx: host, services: new Map([[SERVICE_DOCUMENT, host]]) });
  commands.registerAll(sketchCommands);
  let bodyId = 0 as Id;
  host.doc.transact('box', (draft) => {
    const root = draft.definitions.get(draft.rootDefinitionId)!;
    bodyId = bodyFromMesh(draft, meshBox([0, 0, 0], [2, 2, 1]), { container: root.entities }).id;
  });
  commands.execute('sketch.addEdge', { a: [0.5, 1, 1], b: [1.5, 1, 1] });
  const body = () => host.doc.rootDefinition.entities.bodies.get(bodyId)!;
  const [faceId, g] = [...body().imprints][0]!;
  const edgeId = [...g.edges.keys()][0]!;
  const ref: EntityRef = { kind: 'imprintEdge', path: [], id: bodyId, faceId, edgeId };
  return { host, commands, body, ref };
}

describe('imprint edges: delete and flags', () => {
  it('edit.delete removes a selected imprint edge and undo restores it', () => {
    const { host, commands, body, ref } = setup();
    host.selection.set([ref]);
    const r = commands.execute('edit.delete') as { removed: number; skipped: number };
    expect(r).toMatchObject({ removed: 1, skipped: 0 });
    expect(body().imprints.size).toBe(0);
    host.undo();
    expect(body().imprints.size).toBe(1);
  });
  it('imprint.erase and edges.setFlags work on imprint edges', () => {
    const { commands, body, ref } = setup();
    commands.execute('edges.setFlags', { refs: [ref], hidden: true });
    expect(body().imprints.get(ref.faceId)!.edges.get(ref.edgeId)!.hidden).toBe(true);
    commands.execute('imprint.erase', { refs: [ref] });
    expect(body().imprints.size).toBe(0);
  });
  it('edges.setFlags softens a body edge', () => {
    const { commands, body } = setup();
    const edgeKey = [...body().edges.keys()][0]!;
    commands.execute('edges.setFlags', { refs: [{ kind: 'edge', path: [], id: body().id, edgeKey }], soft: true, smooth: true });
    expect(body().edges.get(edgeKey)!.soft).toBe(true);
  });
});
