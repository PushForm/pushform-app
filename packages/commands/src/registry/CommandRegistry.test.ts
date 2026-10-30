// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Box3, Ray, Vec2, Vec3 } from '@pushform/core';
import { CommandRegistry } from './CommandRegistry';
import { MemoryTransactionHost } from './Command';
import { editCommands } from './editCommands';
import { cameraCommands } from '../camera/cameraCommands';
import type { CameraHost, CameraState, Projection, StandardView } from '../camera/CameraHost';
import { ToolManager } from '../tools/ToolManager';
import { SelectTool } from '../tools/impl/Select';
import { ZoomWindowTool } from '../tools/impl/ZoomWindow';
import { ScriptRunner } from '../scripting/ScriptRunner';
import { NO_MODIFIERS } from '../tools/Tool';
import type { ToolPointerEvent } from '../tools/Tool';

class FakeCamera implements CameraHost {
  calls: string[] = [];
  state: CameraState = { eye: [10, -10, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 35, projection: 'perspective', orthoHeight: 10 };
  getState(): CameraState {
    return this.state;
  }
  setState(s: CameraState): void {
    this.state = s;
    this.calls.push('setState');
  }
  viewportSize() {
    return { width: 800, height: 600 };
  }
  screenToRay(): Ray {
    return { origin: [0, 0, 0], dir: [0, 0, -1] };
  }
  pick(): Vec3 | null {
    return null;
  }
  sceneBounds(): Box3 | null {
    return null;
  }
  orbitStart(): void {
    this.calls.push('orbitStart');
  }
  orbitDrag(): void {
    this.calls.push('orbitDrag');
  }
  orbitEnd(): void {
    this.calls.push('orbitEnd');
  }
  panStart(): void {
    this.calls.push('panStart');
  }
  panDrag(): void {
    this.calls.push('panDrag');
  }
  panEnd(): void {
    this.calls.push('panEnd');
  }
  zoomAt(_s: Vec2 | null, f: number): void {
    this.calls.push(`zoomAt:${f.toFixed(3)}`);
  }
  zoomExtents(): void {
    this.calls.push('zoomExtents');
  }
  zoomWindow(): void {
    this.calls.push('zoomWindow');
  }
  standardView(v: StandardView): void {
    this.calls.push(`view:${v}`);
  }
  setProjection(p: Projection): void {
    this.calls.push(`proj:${p}`);
  }
  setFov(d: number): void {
    this.calls.push(`fov:${d}`);
  }
  setFocalLength(mm: number): void {
    this.calls.push(`focal:${mm}`);
  }
  previousView(): boolean {
    this.calls.push('prev');
    return true;
  }
  nextView(): boolean {
    this.calls.push('next');
    return true;
  }
}

function setup() {
  const tx = new MemoryTransactionHost();
  const camera = new FakeCamera();
  const registry = new CommandRegistry({ tx, camera, services: new Map() });
  registry.registerAll(editCommands);
  registry.registerAll(cameraCommands);
  const tools = new ToolManager(registry, camera);
  registry.ctx.tools = tools;
  tools.register(new SelectTool());
  tools.register(new ZoomWindowTool());
  return { tx, camera, registry, tools };
}

const pe = (x: number, y: number, button: number, extra: Partial<ToolPointerEvent> = {}): ToolPointerEvent => ({
  screen: [x, y],
  ray: { origin: [0, 0, 0], dir: [0, 0, -1] },
  button,
  buttons: button === 1 ? 4 : button === 0 ? 1 : 0,
  modifiers: NO_MODIFIERS,
  inference: null,
  camera: { eye: [0, 0, 0], target: [0, 0, -1], up: [0, 0, 1], fov: 35, projection: 'perspective', orthoHeight: 1 },
  ...extra,
});

describe('CommandRegistry', () => {
  it('validates params, checks enablement and emits executed', () => {
    const { registry, camera, tx } = setup();
    const executed: string[] = [];
    registry.events.on('executed', (e) => executed.push(e.id));
    registry.execute('camera.view.top');
    expect(camera.calls).toContain('view:top');
    expect(executed).toEqual(['camera.view.top']);
    expect(() => registry.execute('camera.setFov', { deg: 'x' })).toThrow(/Invalid params/);
    expect(() => registry.execute('nope')).toThrow(/Unknown command/);
    expect(registry.isEnabled('edit.undo')).toBe(false);
    expect(() => registry.execute('edit.undo')).toThrow(/not enabled/);
    registry.register({
      id: 'test.mutate',
      title: 'Mutate',
      category: 'edit',
      params: z.object({ n: z.number() }),
      undoable: true,
      run: (_ctx, p) => p.n * 2,
    });
    expect(registry.execute('test.mutate', { n: 21 })).toBe(42);
    expect(tx.canUndo()).toBe(true);
    registry.execute('edit.undo');
    expect(tx.canRedo()).toBe(true);
  });

  it('lists tool commands for toolbar generation', () => {
    const { registry } = setup();
    const ids = registry.list({ category: 'tool' }).map((c) => c.id);
    expect(ids).toEqual(['tool.select', 'tool.zoomWindow']);
  });
});

describe('ToolManager', () => {
  it('activates tools via commands and Space, cancels on Escape', () => {
    const { registry, tools } = setup();
    registry.execute('tool.zoomWindow');
    expect(tools.activeToolId).toBe('zoomWindow');
    tools.pointerDown(pe(10, 10, 0));
    tools.pointerMove(pe(50, 60, -1));
    expect(tools.overlay()).toHaveLength(1);
    expect(tools.keyDown({ key: 'Escape', code: 'Escape', modifiers: NO_MODIFIERS, repeat: false })).toBe(true);
    expect(tools.overlay()).toHaveLength(0);
    expect(tools.keyDown({ key: ' ', code: 'Space', modifiers: NO_MODIFIERS, repeat: false })).toBe(true);
    expect(tools.activeToolId).toBe('select');
  });

  it('middle-drag orbits (Shift pans) while suspending the active tool, wheel zooms', () => {
    const { camera, tools } = setup();
    tools.activate('zoomWindow');
    tools.pointerDown(pe(10, 10, 1));
    tools.pointerMove(pe(20, 20, -1, { buttons: 4 }));
    tools.pointerUp(pe(20, 20, 1, { buttons: 0 }));
    expect(camera.calls).toEqual(['orbitStart', 'orbitDrag', 'orbitEnd']);
    expect(tools.status().instructor).toMatch(/rectangle/);
    camera.calls = [];
    tools.pointerDown(pe(10, 10, 1, { modifiers: { ...NO_MODIFIERS, shift: true } }));
    tools.pointerMove(pe(20, 20, -1, { buttons: 4 }));
    tools.pointerUp(pe(20, 20, 1, { buttons: 0 }));
    expect(camera.calls).toEqual(['panStart', 'panDrag', 'panEnd']);
    camera.calls = [];
    tools.wheel({ screen: [5, 5], deltaY: -100, modifiers: NO_MODIFIERS });
    expect(camera.calls).toEqual(['zoomAt:0.850']);
  });
});

describe('ScriptRunner', () => {
  it('runs steps sequentially and reports failures', () => {
    const { registry, camera } = setup();
    const runner = new ScriptRunner(registry);
    const out = runner.run([
      { cmd: 'camera.view.iso' },
      { cmd: 'camera.setFov', params: { deg: 45 } },
      { cmd: 'does.not.exist' },
      { cmd: 'camera.zoomExtents' },
    ]);
    expect(out.map((s) => s.ok)).toEqual([true, true, false]);
    expect(camera.calls).toEqual(['view:iso', 'fov:45']);
  });

  it('captures the active registry once for an entire script', () => {
    const first = setup();
    const second = setup();
    let active = first.registry;
    const runner = new ScriptRunner(() => active);
    first.registry.events.on('executed', () => { active = second.registry; });
    expect(runner.run([
      { cmd: 'camera.view.top' },
      { cmd: 'camera.view.iso' },
    ]).every((step) => step.ok)).toBe(true);
    expect(first.camera.calls).toEqual(['view:top', 'view:iso']);
    expect(second.camera.calls).toEqual([]);
    runner.run([{ cmd: 'camera.view.front' }]);
    expect(second.camera.calls).toEqual(['view:front']);
  });
});
