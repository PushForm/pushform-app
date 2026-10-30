// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { CommandRegistry } from '../registry/CommandRegistry';
import { editCommands } from '../registry/editCommands';
import { DocumentHost } from '../host/DocumentHost';
import { registryOf, SERVICE_COMMANDS, SERVICE_DOCUMENT } from '../host/services';
import { modelCommands } from './model';
import { lastOpCommands, lastOperationOf } from './lastop';

function setup() {
  const host = new DocumentHost();
  const registry = new CommandRegistry({ tx: host, services: new Map([[SERVICE_DOCUMENT, host]]) });
  registry.registerAll(editCommands);
  registry.registerAll(modelCommands);
  registry.registerAll(lastOpCommands);
  const bodies = () => [...host.doc.rootDefinition.entities.bodies.values()];
  const maxX = () => {
    const v = bodies()[0]!.mesh.verts;
    let m = -Infinity;
    for (let i = 0; i < v.length; i += 3) m = Math.max(m, v[i]!);
    return m;
  };
  return { host, registry, bodies, maxX };
}

describe('edit.redoWithParams / edit.repeatLast', () => {
  it('the registry publishes itself as a service', () => {
    const { registry } = setup();
    expect(registry.ctx.services.get(SERVICE_COMMANDS)).toBe(registry);
    expect(registryOf(registry.ctx)).toBe(registry);
  });

  it('is disabled until an undo entry carries a commandId', () => {
    const { host, registry } = setup();
    expect(lastOperationOf(host)).toBeNull();
    expect(registry.isEnabled('edit.redoWithParams')).toBe(false);
    expect(registry.isEnabled('edit.repeatLast')).toBe(false);
    host.edit('Manual', (d) => {
      d.meta.nextId += 1;
    });
    expect(lastOperationOf(host)).toMatchObject({ label: 'Manual', commandId: null, editable: false });
    expect(registry.isEnabled('edit.redoWithParams')).toBe(false);
  });

  it('undoes the top entry and re-executes the command with merged params without growing the stack', () => {
    const { host, registry, bodies, maxX } = setup();
    registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] });
    expect(lastOperationOf(host)).toMatchObject({ label: 'Add Box', commandId: 'model.addBox', editable: true });
    expect(host.undoStack.length).toBe(1);
    expect(maxX()).toBe(1);

    registry.execute('edit.redoWithParams', { params: { max: [2, 2, 2] } });
    expect(host.undoStack.length).toBe(1);
    expect(host.canRedo()).toBe(false);
    expect(bodies()).toHaveLength(1);
    expect(maxX()).toBe(2);
    // merged: min kept from the recorded params
    expect(lastOperationOf(host)?.params).toEqual({ min: [0, 0, 0], max: [2, 2, 2] });

    // undo now removes the re-executed version in one step
    host.undo();
    expect(bodies()).toHaveLength(0);
  });

  it('restores the original edit when the re-execution fails', () => {
    const { host, registry, bodies, maxX } = setup();
    registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] });
    expect(() => registry.execute('edit.redoWithParams', { params: { max: 'nope' } })).toThrow(/Invalid params/);
    expect(host.undoStack.length).toBe(1);
    expect(bodies()).toHaveLength(1);
    expect(maxX()).toBe(1);
  });

  it('repeatLast runs the command again with the same params as a new entry', () => {
    const { host, registry, bodies } = setup();
    registry.execute('model.addBox', { min: [0, 0, 0], max: [1, 1, 1] });
    registry.execute('edit.repeatLast');
    expect(bodies()).toHaveLength(2);
    expect(host.undoStack.length).toBe(2);
    expect(lastOperationOf(host)?.commandId).toBe('model.addBox');
  });
});
