// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { meshBox } from '@pushform/core';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';

let app: AppInstance | null = null;
afterEach(() => {
  app?.dispose();
  app = null;
});

describe('M0 acceptance', () => {
  it('a JSON script builds a cube through the kernel and undo/redo toggles it', async () => {
    app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
    expect(app.bodies).toHaveLength(0);
    const box = meshBox([0, 0, 0], [2, 3, 4]);
    const results = await app.scripts.runAsync([
      { cmd: 'model.fromTriangles', params: { verts: [...box.verts], tris: [...box.tris] } },
    ]);
    expect(results[0]?.ok, results[0]?.error).toBe(true);
    expect(app.bodies).toHaveLength(1);
    const body = app.document.doc.state.definitions.get(app.document.doc.state.rootDefinitionId)!.entities.bodies.values().next().value!;
    expect(body.faces.size).toBe(6);
    expect(body.props?.volume).toBeCloseTo(24, 6);

    expect(app.tx.canUndo()).toBe(true);
    app.commands.execute('edit.undo');
    expect(app.bodies).toHaveLength(0);
    app.commands.execute('edit.redo');
    expect(app.bodies).toHaveLength(1);
  });

  it('model.addBox is undoable and the store reflects undo availability', () => {
    app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
    app.commands.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] });
    expect(app.bodies).toHaveLength(1);
    expect(app.store.getState().canUndo).toBe(true);
    app.commands.execute('edit.undo');
    expect(app.bodies).toHaveLength(0);
    expect(app.store.getState().canRedo).toBe(true);
  });
});
