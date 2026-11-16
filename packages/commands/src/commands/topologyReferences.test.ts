// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { m4identity, m4mul, m4rotationAxis, m4scaling, m4translation, type Id } from '@pushform/core';
import { containerAt, type PluginEntry, type PluginTarget } from '@pushform/model';
import { disposeKernels, setupCommands } from './transform.fixtures';
import { groupCommands, type MakeResult } from './groups';
import { copyModelSelection, pasteModelClipboard } from './clipboard';

afterEach(disposeKernels);
const owner = 'io.example.treatments';
const payload = new Uint8Array([255, 0, 128]);
function setup() {
  const s = setupCommands(); s.registry.registerAll(groupCommands);
  const id = s.addBox([0, 0, 0], [.6, .3, .018]), body = s.body(id);
  const face = [...body.faces.values()].find(face => face.plane.n[2] > .9)!;
  const edge = [...body.edges.values()].find(edge => edge.faceA === face.id || edge.faceB === face.id)!;
  const target: PluginTarget = { kind: 'bodyOccurrence', id, path: [] };
  s.host.doc.transact('Opaque assignments', draft => {
    draft.pluginData = new Map([[owner, { dataVersion: 99, entries: new Map([['part', { target, payload, references: [
      { target, element: { kind: 'face' as const, faceId: face.id, bodyVersion: body.version } },
      { target, element: { kind: 'edge' as const, edgeKey: edge.key, bodyVersion: body.version } },
    ] }]]) }]]);
  });
  const entry = (): PluginEntry => s.host.doc.state.pluginData!.get(owner)!.entries.get('part')!;
  return { ...s, id, face, edge, entry };
}
it('tracks opaque assignments through rigid and affine commands, undo/redo, and a transformed copy', async () => {
  const s = setup(), original = structuredClone(s.entry());
  const ref = { kind: 'body', id: s.id, path: [] };
  await s.apply({ refs: [ref], matrix: m4mul(m4translation([2, 3, 4]), m4rotationAxis([1, 1, 0], .63)) });
  expect(s.entry().references.every(ref => !ref.unresolved && ref.element?.bodyVersion === s.body(s.id).version)).toBe(true);
  await s.apply({ refs: [ref], matrix: m4scaling([-2, 1.5, 1.2]) });
  expect(s.entry().references.every(ref => !ref.unresolved && ref.element?.bodyVersion === s.body(s.id).version)).toBe(true);
  s.host.undo(); s.host.undo(); expect(s.entry()).toEqual(original);
  s.host.redo(); s.host.redo();
  const copy = await s.apply({ refs: [ref], matrix: m4translation([3, 0, 0]), copy: true });
  const copied = [...s.host.doc.state.pluginData!.get(owner)!.entries.values()].find(entry => entry.target.kind === 'bodyOccurrence' && entry.target.id === copy.refs[0]!.id)!;
  expect(copied.payload).toEqual(payload);
  expect(copied.references.every(ref => !ref.unresolved && ref.target.kind === 'bodyOccurrence' && ref.target.id === copy.refs[0]!.id && ref.element?.bodyVersion === s.body(copy.refs[0]!.id).version)).toBe(true);
});
it('retains the cap and uniquely identified edge through the direct kernel whole-face move', async () => {
  const s = setup();
  await s.registry.execute('pushpull.apply', { target: { kind: 'face', path: [], id: s.id, faceId: s.face.id, region: null }, distance: .01, mode: 'merge' });
  expect(s.entry().references[0]!.unresolved).toBeUndefined();
  expect(s.entry().references[0]!.element!.bodyVersion).toBe(s.body(s.id).version);
  const edge = s.entry().references[1]!;
  expect(edge.unresolved).toBeUndefined();
  expect(edge.element?.bodyVersion).toBe(s.body(s.id).version);
  expect(edge.element?.kind === 'edge' && s.body(s.id).edges.has(edge.element.edgeKey as typeof s.edge.key)).toBe(true);
  expect(s.entry().payload).toEqual(payload);
});
it('keeps topology envelopes through regroup, Make Unique and cross-document clipboard paste', async () => {
  const s = setup(), destination = setupCommands();
  const group = s.registry.execute('group.make', { refs: [{ kind: 'body', id: s.id, path: [] }] }) as MakeResult;
  expect(s.entry().references.every(ref => !ref.unresolved && ref.target.kind === 'bodyOccurrence' && ref.target.path[0] === group.instanceId)).toBe(true);
  const copy = await s.apply({ refs: [{ kind: 'instance', id: group.instanceId, path: [] }], matrix: m4translation([2, 0, 0]), copy: true });
  s.registry.execute('component.makeUnique', { refs: [{ kind: 'instance', id: copy.refs[0]!.id, path: [] }] });
  const entries = [...s.host.doc.state.pluginData!.get(owner)!.entries.values()];
  expect(entries.every(entry => entry.references.every(ref => !ref.unresolved))).toBe(true);
  const copied = entries.find(entry => entry.target.kind === 'bodyOccurrence' && entry.target.path[0] === copy.refs[0]!.id)!;
  expect(copied.target.kind === 'bodyOccurrence' && copied.target.id).not.toBe(s.id);
  const clip = copyModelSelection(s.host.doc.state, [], [{ kind: 'instance', id: group.instanceId as Id, path: [] }])!;
  destination.host.transact('Paste', () => destination.host.edit('Paste', draft => pasteModelClipboard(draft, clip, [], m4identity())));
  const pasted = [...destination.host.doc.state.pluginData!.get(owner)!.entries.values()][0]!;
  expect(pasted.payload).toEqual(payload);
  expect(pasted.references.every(ref => !ref.unresolved && ref.target.kind === 'bodyOccurrence' && ref.element?.bodyVersion === containerAt(destination.host.doc.state, ref.target.path as Id[]).bodies.get(ref.target.id as Id)!.version)).toBe(true);
});

it('pastes a standalone transformed solid with topology references into a new document', async () => {
  const s = setup();
  await s.apply({ refs: [{ kind: 'body', id: s.id, path: [] }], matrix: m4translation([2, 3, 0]) });
  const clip = copyModelSelection(s.host.doc.state, [], [{ kind: 'body', id: s.id as Id, path: [] }])!;
  for (const matrix of [m4identity(), m4scaling([-2, 1, 1])]) {
    const destination = setupCommands();
    destination.host.transact('Paste', () => destination.host.edit('Paste', draft => pasteModelClipboard(draft, clip, [], matrix)));
    const entry = [...destination.host.doc.state.pluginData!.get(owner)!.entries.values()][0]!;
    expect(entry.references.every(ref => !ref.unresolved && ref.element?.bodyVersion === destination.bodies()[0]!.version)).toBe(true);
  }
});
