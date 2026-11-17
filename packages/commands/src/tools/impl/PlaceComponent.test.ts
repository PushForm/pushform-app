// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it } from 'vitest';
import type { DefId, Id, Vec3 } from '@pushform/core';
import { z } from 'zod';
import { disposeKernels, setupCommands } from '../../commands/transform.fixtures';
import { groupCommands, type MakeResult } from '../../commands/groups';
import { componentCommands, componentPlacement } from '../../commands/components';
import { contextCommands } from '../../commands/context';
import { m4rotationAbout, refsBounds } from '../../commands/transform';
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

  it('inside a rotated group, the outline turns with the group, as the placed component does', async () => {
    const a = setupCommands();
    a.registry.registerAll(groupCommands);
    a.registry.registerAll(componentCommands);
    a.registry.registerAll(contextCommands);
    a.registry.register({ id: 'tool.select', title: 'Select', category: 'tool', params: z.object({}), undoable: false, run: () => {} });
    const box = a.addBox([0, 0, 0], [1, 2, 1]);
    const made = a.registry.execute('component.make', { refs: [{ kind: 'body', path: [], id: box as Id }], name: 'Board' }) as MakeResult;
    const other = a.addBox([5, 5, 0], [6, 6, 1]);
    const group = a.registry.execute('group.make', { refs: [{ kind: 'body', path: [], id: other as Id }] }) as MakeResult;
    const groupId = group.instanceId as Id;
    await a.registry.execute('transform.apply', { refs: [{ kind: 'instance', path: [], id: groupId }], matrix: m4rotationAbout([0, 0, 0], [0, 0, 1], Math.PI / 2) });
    a.registry.execute('context.enter', { path: [groupId] });
    componentPlacement.current = made.definitionId as DefId;
    const tool = new PlaceComponentTool();
    tool.activate({ commands: a.registry, camera: a.camera, requestRender: () => {}, statusChanged: () => {} });
    const point: Vec3 = [4, 0, 0];
    const event = (button: number): ToolPointerEvent => ({
      screen: [0, 0], ray: { origin: [4, 0, 10], dir: [0, 0, -1] }, button, buttons: 0, modifiers: NO_MODIFIERS,
      inference: { point, primary: { kind: 'none', point }, lines: [], hit: null } as never, camera: a.camera.getState(),
    });
    tool.onPointerMove(event(-1));
    const outline = tool.overlay().flatMap((o) => (o.kind === 'polyline' ? o.points : []));
    const span = (axis: number) => [Math.min(...outline.map((p) => p[axis]!)), Math.max(...outline.map((p) => p[axis]!))];
    tool.onPointerDown(event(0));
    const placed = a.host.selection.refs[0]!;
    expect(placed).toMatchObject({ kind: 'instance', path: [groupId] });
    const bounds = refsBounds(a.host.doc.state, [placed])!;
    for (const axis of [0, 1, 2]) {
      expect(span(axis)[0]).toBeCloseTo(bounds.min[axis]!, 9);
      expect(span(axis)[1]).toBeCloseTo(bounds.max[axis]!, 9);
    }
    // the board's 2 m side runs along the group's turned x axis: world -x from the insertion point
    expect(span(0)).toEqual([expect.closeTo(2, 9), expect.closeTo(4, 9)]);
    expect(span(1)).toEqual([expect.closeTo(0, 9), expect.closeTo(1, 9)]);
  });
});
