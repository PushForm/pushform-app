// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { m4identity, m4invert, m4mul, m4rotationAxis, m4transformPoint, m4translation, type Vec3 } from '@pushform/core';
import { copyModelSelection, pasteModelClipboard } from './clipboard';
import { disposeKernels, setupCommands } from './transform.fixtures';

afterEach(disposeKernels);
it('carries reference coordinates through rigid transforms, undo/redo and cross-document clipboard paste without plugins', async () => {
  const source = setupCommands(), destination = setupCommands();
  const id = source.addBox([0, 0, 0], [.6, .3, .018]);
  const matrix = m4mul(m4translation([2, 3, 1]), m4rotationAxis([1, 1, 0], .63));
  await source.apply({ refs: [{ kind: 'body', path: [], id }], matrix });
  const body = source.body(id);
  expect(body.referenceFrame).toEqual(matrix);
  source.host.undo(); expect(source.body(id).referenceFrame).toBeUndefined();
  source.host.redo(); expect(source.body(id).referenceFrame).toEqual(matrix);
  const clip = copyModelSelection(source.host.doc.state, [], [{ kind: 'body', id: id as never, path: [] }])!;
  destination.host.transact('Paste', () => destination.host.edit('Paste', draft => pasteModelClipboard(draft, clip, [], m4identity())));
  const pasted = destination.bodies()[0]!;
  const originalPoint = [...body.mesh.verts.slice(0, 3)] as unknown as Vec3, pastedPoint = [...pasted.mesh.verts.slice(0, 3)] as unknown as Vec3;
  const before = m4transformPoint(m4invert(body.referenceFrame!)!, originalPoint);
  const after = m4transformPoint(m4invert(pasted.referenceFrame!)!, pastedPoint);
  for (let axis = 0; axis < 3; axis++) expect(after[axis]).toBeCloseTo(before[axis]!, 10);
  expect(destination.host.doc.state.pluginData).toBeUndefined();
});
