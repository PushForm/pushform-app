// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Id, StyleId } from '@pushform/core';
import { environmentPreset, defaultSceneLight } from '@pushform/model';
import { CommandRegistry } from '../registry/CommandRegistry';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT } from '../host/services';
import { environmentCommands } from './environment';
import { styleCommands } from './styles';
import { sceneCommands } from './scenes';
import { shadowCommands } from './shadows';

function setup() {
  const host = new DocumentHost(),
    commands = new CommandRegistry({ tx: host, services: new Map([[SERVICE_DOCUMENT, host]]) });
  commands.registerAll(environmentCommands);
  commands.registerAll(styleCommands);
  commands.registerAll(sceneCommands);
  commands.registerAll(shadowCommands);
  return { host, commands, style: () => host.doc.state.styles.get(host.doc.state.activeStyleId)! };
}
describe('style environments and model lights', () => {
  it('updates and duplicates environments without changing project location or placed lights, and supports undo', () => {
    const { host, commands, style } = setup();
    const location = host.doc.state.shadows,
      original = style().id;
    const id = commands.execute('light.create', { position: [1, 2, 3] }) as number;
    commands.execute('environment.saveStyle', {
      name: 'Evening',
      patch: environmentPreset('night'),
    });
    expect(style().environment?.preset).toBe('night');
    expect(style().id).not.toBe(original);
    expect(host.doc.state.styles.get(original)?.environment?.preset).toBe('bright');
    expect(host.doc.state.shadows).toEqual(location);
    expect(host.doc.state.sceneLights?.[0]?.id).toBe(id);
    host.undo();
    expect(style().id).toBe(original);
    expect(host.doc.state.sceneLights).toHaveLength(1);
    commands.execute('environment.set', { patch: { fill: 0.2, followCamera: false } });
    expect(style().environment).toMatchObject({ fill: 0.2, followCamera: false });
    host.undo();
    expect(style().environment?.fill).toBe(0.8);
  });
  it('creates, edits and deletes point/spot/area lights through undoable commands and rejects invalid bounds', () => {
    const { host, commands } = setup();
    const id = commands.execute('light.create', {
      type: 'spot',
      position: [1, 2, 3],
      target: [0, 0, 0],
    }) as Id;
    commands.execute('light.update', { id, patch: { lumens: 1200, temperature: 4000 } });
    expect(host.doc.state.sceneLights?.[0]).toMatchObject({ id, lumens: 1200, temperature: 4000 });
    expect(() => commands.execute('light.update', { id, patch: { target: [1, 2, 3] } })).toThrow();
    expect(() => commands.execute('light.update', { id, patch: { temperature: -10 } })).toThrow();
    commands.execute('light.delete', { id });
    expect(host.doc.state.sceneLights).toBeUndefined();
    host.undo();
    expect(host.doc.state.sceneLights?.[0]?.id).toBe(id);
  });
  it('enforces the shadow budget atomically and preserves style settings when switching', () => {
    const { host, commands, style } = setup();
    commands.execute('light.create', defaultSceneLight('area'));
    const count = host.doc.state.sceneLights?.length;
    expect(() => commands.execute('light.create', defaultSceneLight('area'))).toThrow(
      /shadow-casting/,
    );
    expect(host.doc.state.sceneLights).toHaveLength(count!);
    const bright = style().id;
    const dark = commands.execute('environment.saveStyle', {
      name: 'Night',
      patch: environmentPreset('night'),
    }) as StyleId;
    commands.execute('style.setActive', { id: bright });
    expect(style().environment?.preset).toBe('bright');
    commands.execute('style.setActive', { id: dark });
    expect(style().environment?.preset).toBe('night');
  });
  it('restores a scene environment and sun time without moving model lights', () => {
    const { host, commands, style } = setup();
    commands.execute('environment.set', { patch: environmentPreset('daylight') });
    commands.execute('shadows.set', { patch: { time: 600 } });
    const scene = commands.execute('scene.add', { name: 'Morning' });
    commands.execute('light.create', { position: [1, 2, 3] });
    commands.execute('environment.saveStyle', { name: 'Night', patch: environmentPreset('night') });
    commands.execute('shadows.set', { patch: { time: 1200 } });
    commands.execute('scene.activate', { id: scene });
    expect(style().environment?.preset).toBe('daylight');
    expect(host.doc.state.shadows.time).toBe(600);
    expect(host.doc.state.sceneLights?.[0]?.position).toEqual([1, 2, 3]);
  });
});
