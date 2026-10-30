// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './bootstrap';
import type { AppInstance } from './bootstrap';

let app: AppInstance | null = null;
afterEach(() => {
  app?.dispose();
  app = null;
});

describe('createApp', () => {
  it('wires registry, tools, keymap and demo bodies without a WebGL context', () => {
    app = createApp({ platform: 'mac' });
    expect(app.toolManager.activeToolId).toBe('select');
    expect(app.bodies).toHaveLength(2);
    expect(app.viewport.sceneBounds()).not.toBeNull();
    const toolIds = app.commands.list({ category: 'tool' }).map((c) => c.id);
    expect(toolIds).toContain('tool.pushpull');
    expect(toolIds).toContain('tool.orbit');
    expect(app.keymap.label('tool.pushpull')).toBe('P');
    expect((window as unknown as { pushform?: unknown }).pushform).toBeDefined();
  });

  it('runs scripts through the registry and updates the store', () => {
    app = createApp({ platform: 'win' });
    const before = app.viewport.camera.getState();
    const out = app.scripts.run([{ cmd: 'camera.view.top' }, { cmd: 'tool.zoom' }]);
    expect(out.every((s) => s.ok)).toBe(true);
    const after = app.viewport.camera.getState();
    expect(after.eye[2]).toBeGreaterThan(before.target[2]);
    expect(app.store.getState().activeToolId).toBe('zoom');
    expect(app.store.getState().vcbLabel).toBe('Field of View');
    expect(app.viewport.camera.previousView()).toBe(true);
  });

  it('opens the Materials panel when the Paint Bucket is activated', () => {
    app = createApp({ platform: 'mac' });
    expect(app.store.getState().openPanel).toBeNull();
    expect(app.scripts.run([{ cmd: 'tool.paint' }]).every((s) => s.ok)).toBe(true);
    expect(app.store.getState().activeToolId).toBe('paint');
    expect(app.store.getState().openPanel).toBe('materials');
    // other tools leave whatever panel is open alone
    app.scripts.run([{ cmd: 'tool.select' }]);
    expect(app.store.getState().openPanel).toBe('materials');
  });
});
