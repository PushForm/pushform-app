// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import type { DefId, Id, Vec3 } from '@pushform/core';
import { z } from 'zod';
import { disposeKernels, setupCommands } from '../../commands/transform.fixtures';
import { groupCommands, type MakeResult } from '../../commands/groups';
import { componentCommands, componentPlacement } from '../../commands/components';
import { PlaceComponentTool } from './PlaceComponent';
import type { ToolContext, ToolPointerEvent } from '../Tool';
import { NO_MODIFIERS } from '../Tool';

afterEach(() => {
  componentPlacement.current = null;
  disposeKernels();
});

describe('PlaceComponentTool', () => {
  it('outlines the component at the cursor and places it with a click, then returns to Select', () => {
    const a = setupCommands();
    a.registry.registerAll(groupCommands);
    a.registry.registerAll(componentCommands);
    let selected = false;
    a.registry.register({ id: 'tool.select', title: 'Select', category: 'tool', params: z.object({}), undoable: false, run: () => { selected = true; } });
    const box = a.addBox([0, 0, 0], [1, 1, 1]);
    const made = a.registry.execute('component.make', { refs: [{ kind: 'body', path: [], id: box as Id }], name: 'Box' }) as MakeResult;
    const definitionId = made.definitionId as DefId;
    componentPlacement.current = definitionId;
    const tool = new PlaceComponentTool();
    const ctx: ToolContext = { commands: a.registry, camera: a.camera, requestRender: () => {}, statusChanged: () => {} };
    tool.activate(ctx);
    expect(tool.status().instructor).toBe('Click to place Box. Esc cancels.');
    const event = (point: Vec3, button: number): ToolPointerEvent => ({
      screen: [0, 0], ray: { origin: [0, 0, 10], dir: [0, 0, -1] }, button, buttons: 0, modifiers: NO_MODIFIERS,
      inference: { point, primary: { kind: 'none', point }, lines: [], hit: null } as never, camera: a.camera.getState(),
    });
    tool.onPointerMove(event([4, 0, 0], -1));
    expect(tool.overlay().length).toBeGreaterThan(0);
    const before = [...a.host.doc.state.definitions.get(a.host.doc.state.rootDefinitionId)!.entities.instances.values()].length;
    tool.onPointerDown(event([4, 0, 0], 0));
    const instances = [...a.host.doc.state.definitions.get(a.host.doc.state.rootDefinitionId)!.entities.instances.values()];
    expect(instances).toHaveLength(before + 1);
    expect([...instances.at(-1)!.transform].slice(12, 15)).toEqual([4, 0, 0]);
    expect(selected).toBe(true);
  });
});
