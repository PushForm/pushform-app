// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import type { Box3, Ray, Vec3 } from '@pushform/core';
import type { CameraHost, CameraState } from '../camera/CameraHost';
import { DocumentHost } from '../host/DocumentHost';
import { CommandRegistry } from '../registry/CommandRegistry';
import type { VcbValue } from '../vcb/parse';
import { NO_MODIFIERS, type Tool, type ToolKeyEvent } from './Tool';
import { ToolManager } from './ToolManager';
import { OrbitTool } from './impl/Orbit';
import { PanTool } from './impl/Pan';
import { ZoomTool } from './impl/Zoom';
import { ZoomWindowTool } from './impl/ZoomWindow';

class FakeCamera implements CameraHost {
  state: CameraState = { eye: [10, -10, 10], target: [0, 0, 0], up: [0, 0, 1], fov: 35, projection: 'perspective', orthoHeight: 10 };
  getState(): CameraState {
    return this.state;
  }
  setState(s: CameraState): void {
    this.state = s;
  }
  viewportSize(): { width: number; height: number } {
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
  orbitStart(): void {}
  orbitDrag(): void {}
  orbitEnd(): void {}
  panStart(): void {}
  panDrag(): void {}
  panEnd(): void {}
  zoomAt(): void {}
  zoomExtents(): void {}
  zoomWindow(): void {}
  standardView(): void {}
  setProjection(): void {}
  setFov(): void {}
  setFocalLength(): void {}
  previousView(): boolean {
    return false;
  }
  nextView(): boolean {
    return false;
  }
}

/** A working tool that records its lifecycle and holds a pending operation while `pending` is set. */
class WorkTool implements Tool {
  readonly title: string;
  readonly log: string[] = [];
  pending = false;
  readonly values: VcbValue[] = [];
  constructor(readonly id: string) {
    this.title = id;
  }
  activate(): void {
    this.log.push('activate');
    this.pending = false;
  }
  deactivate(): void {
    this.log.push('deactivate');
    this.pending = false;
  }
  suspend(): void {
    this.log.push('suspend');
  }
  resume(): void {
    this.log.push('resume');
  }
  hasPendingWork(): boolean {
    return this.pending;
  }
  onKeyDown(e: ToolKeyEvent): boolean {
    if (e.key !== 'Enter') return false;
    this.log.push('enter');
    return true;
  }
  onVcb(v: VcbValue): void {
    this.values.push(v);
  }
  onCancel(): void {
    this.log.push('cancel');
  }
  overlay() {
    return this.pending ? [{ kind: 'polyline' as const, points: [[0, 0, 0] as Vec3, [1, 0, 0] as Vec3], color: '#f00', width: 1 }] : [];
  }
  status() {
    return { instructor: this.id, vcbLabel: '' };
  }
}

class SelectStub implements Tool {
  readonly id = 'select';
  readonly title = 'Select';
  readonly role = 'select' as const;
  cancels = 0;
  activate(): void {}
  deactivate(): void {}
  onCancel(): void {
    this.cancels++;
  }
  overlay() {
    return [];
  }
  status() {
    return { instructor: 'select', vcbLabel: '' };
  }
}

const key = (k: string, code = k): ToolKeyEvent => ({ key: k, code, modifiers: NO_MODIFIERS, repeat: false }) as ToolKeyEvent;

function setup() {
  const camera = new FakeCamera();
  const registry = new CommandRegistry({ tx: new DocumentHost(), camera, services: new Map() });
  const tools = new ToolManager(registry, camera);
  const select = new SelectStub();
  const line = new WorkTool('line');
  const move = new WorkTool('move');
  for (const t of [select, line, move, new OrbitTool(), new PanTool(), new ZoomTool(), new ZoomWindowTool()]) tools.register(t);
  return { tools, select, line, move };
}

describe('ToolManager: camera tools and Select set the active tool aside', () => {
  it('choosing Orbit suspends the working tool, keeps its overlay and returns to it with its state on Esc', () => {
    const { tools, line } = setup();
    tools.activate('line');
    line.pending = true;
    tools.activate('orbit');
    expect(tools.activeToolId).toBe('orbit');
    expect(tools.parkedToolId).toBe('line');
    expect(tools.visualTool).toBe(line);
    expect(line.log).toEqual(['activate', 'suspend']);
    expect(tools.overlay()).toHaveLength(1);
    tools.keyDown(key('Escape'));
    expect(tools.activeToolId).toBe('line');
    expect(tools.parkedToolId).toBeNull();
    expect(line.log).toEqual(['activate', 'suspend', 'resume']);
    expect(line.pending).toBe(true);
  });

  it('switches between camera tools without losing the set-aside tool, and choosing it again resumes it', () => {
    const { tools, line } = setup();
    tools.activate('line');
    line.pending = true;
    tools.activate('orbit');
    tools.activate('pan');
    tools.activate('zoom');
    expect(tools.parkedToolId).toBe('line');
    tools.activate('line');
    expect(tools.activeToolId).toBe('line');
    expect(line.log).toEqual(['activate', 'suspend', 'resume']);
    expect(line.pending).toBe(true);
  });

  it('passes Enter and typed values to the set-aside tool while a camera tool that takes none is active', () => {
    const { tools, line } = setup();
    tools.activate('line');
    tools.activate('orbit');
    expect(tools.keyDown(key('Enter'))).toBe(true);
    expect(line.log).toContain('enter');
    tools.onVcb({ kind: 'length', meters: 2, raw: 2, unit: null });
    expect(line.values).toHaveLength(1);
    // Zoom takes typed values itself
    tools.activate('zoom');
    tools.onVcb({ kind: 'angle', degrees: 30 });
    expect(line.values).toHaveLength(1);
  });

  it('Select and Space set the tool aside; returning continues a pending operation and restarts an idle tool', () => {
    const { tools, line, select } = setup();
    tools.activate('line');
    line.pending = true;
    expect(tools.keyDown(key(' ', 'Space'))).toBe(true);
    expect(tools.activeToolId).toBe('select');
    expect(tools.parkedToolId).toBe('line');
    // no preview of the set-aside tool while selecting
    expect(tools.visualTool).toBe(select);
    expect(tools.overlay()).toHaveLength(0);
    tools.activate('line');
    expect(line.log).toEqual(['activate', 'suspend', 'resume']);
    expect(line.pending).toBe(true);

    // an idle tool is ended by Select as before
    line.pending = false;
    line.log.length = 0;
    tools.activate('select');
    expect(tools.parkedToolId).toBeNull();
    tools.activate('line');
    expect(line.log).toEqual(['deactivate', 'activate']);
  });

  it('Esc in Select returns to the set-aside tool; with none it cancels in Select', () => {
    const { tools, line, select } = setup();
    tools.activate('line');
    line.pending = true;
    tools.activate('select');
    tools.keyDown(key('Escape'));
    expect(tools.activeToolId).toBe('line');
    expect(line.pending).toBe(true);
    expect(select.cancels).toBe(0);
    tools.keyDown(key('Escape'));
    expect(line.log.at(-1)).toBe('cancel');
  });

  it('a tool that switches to Select from its own handler is ended, not set aside', () => {
    const { tools, line } = setup();
    tools.activate('line');
    line.pending = true;
    line.onCancel = () => tools.activate('select');
    tools.keyDown(key('Escape'));
    expect(tools.activeToolId).toBe('select');
    expect(tools.parkedToolId).toBeNull();
    expect(line.log.at(-1)).toBe('deactivate');
  });

  it('an idle tool set aside by a camera tool restarts when coming back through Select', () => {
    const { tools, move } = setup();
    tools.activate('move');
    tools.activate('orbit');
    tools.activate('select');
    expect(tools.parkedToolId).toBe('move');
    move.log.length = 0;
    tools.activate('move');
    expect(move.log).toEqual(['deactivate', 'activate']);
  });

  it('choosing another working tool ends the set-aside tool', () => {
    const { tools, line, move } = setup();
    tools.activate('line');
    line.pending = true;
    tools.activate('orbit');
    tools.activate('move');
    expect(tools.activeToolId).toBe('move');
    expect(tools.parkedToolId).toBeNull();
    expect(line.log).toEqual(['activate', 'suspend', 'deactivate']);
    expect(move.log).toEqual(['activate']);
  });

  it('Esc during a Zoom Window drag cancels the window first, then returns to the set-aside tool', () => {
    const { tools } = setup();
    tools.activate('line');
    tools.activate('zoomWindow');
    tools.pointerDown({ screen: [10, 10], ray: { origin: [0, 0, 0], dir: [0, 0, -1] }, button: 0, buttons: 1, modifiers: NO_MODIFIERS, inference: null, camera: new FakeCamera().state });
    tools.keyDown(key('Escape'));
    expect(tools.activeToolId).toBe('zoomWindow');
    tools.keyDown(key('Escape'));
    expect(tools.activeToolId).toBe('line');
  });

  it('Esc in a camera tool with nothing set aside stays in it', () => {
    const { tools } = setup();
    tools.activate('orbit');
    tools.keyDown(key('Escape'));
    expect(tools.activeToolId).toBe('orbit');
  });
});
