// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Id } from '@pushform/core';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import { createApp } from '../bootstrap';
import { sketchesToRender } from './renderAdapter';

describe('renderAdapter sheet-face shadows (PF-269)', () => {
  it('gives each container\'s sheet faces the Cast/Receive Shadows of every group or component containing them', () => {
    const app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) });
    try {
      const { commands, document: host } = app;
      commands.execute('sketch.rectangle', { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], d: [0, 1, 0] });
      const face = [...host.doc.rootDefinition.entities.sketch.faces.keys()][0]!;
      const inner = (commands.execute('group.make', { refs: [{ kind: 'sketchFace', path: [], id: face }] }) as { instanceId: number }).instanceId as Id;
      const outer = (commands.execute('group.make', { refs: [{ kind: 'instance', path: [], id: inner }] }) as { instanceId: number }).instanceId as Id;
      const sheet = () => sketchesToRender(host.doc.state).find((s) => s.faces.length > 0)!;
      expect(sheet().path).toEqual([outer, inner]);
      expect(sheet().castShadows).toBeUndefined();
      expect(sheet().receiveShadows).toBeUndefined();
      commands.execute('entity.setShadows', { refs: [{ kind: 'instance', path: [outer], id: inner }], cast: false });
      expect(sheet()).toMatchObject({ castShadows: false });
      expect(sheet().receiveShadows).toBeUndefined();
      // The outer group's setting applies to everything inside it.
      commands.execute('entity.setShadows', { refs: [{ kind: 'instance', path: [outer], id: inner }], cast: true });
      commands.execute('entity.setShadows', { refs: [{ kind: 'instance', path: [], id: outer }], receive: false });
      expect(sheet()).toMatchObject({ receiveShadows: false });
      expect(sheet().castShadows).toBeUndefined();
    } finally {
      app.dispose();
    }
  });
});
