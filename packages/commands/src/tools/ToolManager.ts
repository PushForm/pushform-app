// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { Emitter, PushFormError } from '@pushform/core';
import { z } from 'zod';
import type { CameraHost } from '../camera/CameraHost';
import type { CommandRegistry } from '../registry/CommandRegistry';
import type { ToolHost } from '../registry/Command';
import type { VcbValue } from '../vcb/parse';
import type { OverlayPrimitive } from './overlay';
import type { Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ToolStatus, ToolWheelEvent } from './Tool';
import { OrbitTool } from './impl/Orbit';
import { PanTool } from './impl/Pan';

export interface ToolManagerEvents extends Record<string, unknown> {
  toolChanged: { id: string | null; previous: string | null };
  statusChanged: ToolStatus;
  overlayChanged: undefined;
  renderRequested: undefined;
}

export interface ToolManagerOptions {
  /** Tool activated by Space. Default `select`. */
  readonly selectToolId?: string;
  /** Wheel zoom factor per 100 px of deltaY (< 1 zooms in). Default 0.85. */
  readonly wheelZoomFactor?: number;
  /** Register a `tool.<id>` command per tool (default true). */
  readonly registerCommands?: boolean;
}

const EMPTY_STATUS: ToolStatus = { instructor: '', vcbLabel: '' };

/**
 * Owns the active tool, dispatches viewport events to it, and implements the universal
 * interactions: Space → Select, Esc → cancel, middle-drag → orbit (Shift+middle → pan) while
 * suspending the active tool, wheel → zoom toward the cursor.
 *
 * Choosing a camera tool while another tool is active sets that tool aside (suspended, its state
 * kept) instead of ending it; Select does the same for a tool with an operation in progress. A tool
 * that switches tools from its own event handler is finishing and is never set aside. Choosing it again returns to it, as does Esc in the camera
 * tool or Select; while a camera tool is active the set-aside tool's overlay and preview stay visible and it
 * still receives keys and typed values the camera tool does not take, so Enter applies its
 * operation. Choosing any other tool ends the set-aside tool.
 */
export class ToolManager implements ToolHost {
  readonly events = new Emitter<ToolManagerEvents>();
  private tools = new Map<string, Tool>();
  private active: Tool | null = null;
  /** Temporary camera tool while the middle button is held. */
  private temp: Tool | null = null;
  /** Tool set aside while a camera tool or Select is active. */
  private parked: Tool | null = null;
  /** Depth of calls into a tool's event handlers; a tool switch requested inside one ends that tool. */
  private inTool = 0;
  private readonly selectToolId: string;
  private readonly wheelZoomFactor: number;
  private readonly registerCommands: boolean;
  private readonly ctx: ToolContext;
  private lastStatus: ToolStatus = EMPTY_STATUS;

  constructor(
    readonly commands: CommandRegistry,
    readonly camera: CameraHost,
    opts: ToolManagerOptions = {},
  ) {
    this.selectToolId = opts.selectToolId ?? 'select';
    this.wheelZoomFactor = opts.wheelZoomFactor ?? 0.85;
    this.registerCommands = opts.registerCommands ?? true;
    this.ctx = {
      commands,
      camera,
      requestRender: () => this.events.emit('renderRequested', undefined),
      statusChanged: () => this.emitStatus(),
      overlayChanged: () => this.overlayChanged(),
    };
    commands.register({
      id: 'tool.cancel',
      title: 'Cancel',
      category: 'internal',
      params: z.object({}),
      undoable: false,
      run: () => this.cancel(),
    });
    commands.register({
      id: 'tool.activate',
      title: 'Activate Tool',
      category: 'internal',
      params: z.object({ id: z.string() }),
      undoable: false,
      run: (_ctx, p) => this.activate(p.id),
    });
  }

  get activeToolId(): string | null {
    return this.active?.id ?? null;
  }

  get activeTool(): Tool | null {
    return this.active;
  }

  /** The tool set aside while a camera tool or Select is active, if any. */
  get parkedToolId(): string | null {
    return this.parked?.id ?? null;
  }

  /**
   * The tool whose visuals (hover, preview) the viewport shows: the set-aside tool while a camera
   * tool is active, so a preview stays on screen while orbiting, else the active tool.
   */
  get visualTool(): Tool | null {
    return this.camerasParked() ? this.parked : this.active;
  }

  list(): readonly Tool[] {
    return [...this.tools.values()];
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  /** `command: false` registers a tool other commands start (Paste) without its own `tool.<id>` command. */
  register(tool: Tool, opts: { icon?: string; keybinding?: string; menu?: string; command?: boolean } = {}): void {
    if (this.tools.has(tool.id)) throw new PushFormError('tool.duplicate', `Tool already registered: ${tool.id}`);
    this.tools.set(tool.id, tool);
    if (this.registerCommands && opts.command !== false) {
      this.commands.register({
        id: `tool.${tool.id}`,
        title: tool.title,
        category: 'tool',
        icon: opts.icon ?? `tool-${tool.id}`,
        menu: opts.menu ?? 'Tools',
        keybinding: opts.keybinding,
        params: z.object({}),
        undoable: false,
        run: () => this.activate(tool.id),
      });
    }
  }

  activate(id: string): void {
    const tool = this.tools.get(id);
    if (!tool) throw new PushFormError('tool.unknown', `Unknown tool: ${id}`);
    if (this.active === tool) return;
    this.endTemp();
    const previous = this.active?.id ?? null;
    const current = this.active;
    const finishing = this.inTool > 0;
    if (tool.role && !finishing) {
      // camera tool or Select: set a working tool aside, or replace another camera tool / Select
      if (current && !current.role && (tool.role === 'camera' || current.hasPendingWork?.() === true)) {
        this.parked?.deactivate();
        this.parked = current;
        current.suspend?.();
      } else {
        current?.deactivate();
      }
      this.active = tool;
      tool.activate(this.ctx);
    } else if (tool === this.parked && !finishing) {
      // back to the set-aside tool: it continues unless Select ran and it had nothing in progress
      const fromSelect = current?.role === 'select';
      current?.deactivate();
      this.parked = null;
      this.active = tool;
      if (fromSelect && !tool.hasPendingWork?.()) {
        tool.deactivate();
        tool.activate(this.ctx);
      } else {
        tool.resume?.();
      }
    } else {
      current?.deactivate();
      this.parked?.deactivate();
      this.parked = null;
      this.active = tool;
      tool.activate(this.ctx);
    }
    this.events.emit('toolChanged', { id: tool.id, previous });
    this.emitStatus();
    this.overlayChanged();
  }

  cancel(): void {
    if (this.temp) {
      this.endTemp();
      return;
    }
    if (this.active?.role && this.parked && !this.active.hasPendingWork?.()) {
      // Esc in a camera tool or Select goes back to the set-aside tool (after ending its own drag)
      this.activate(this.parked.id);
      return;
    }
    this.call(() => this.active?.onCancel());
    this.emitStatus();
    this.overlayChanged();
  }

  // --- dispatch -------------------------------------------------------------------------------

  pointerDown(e: ToolPointerEvent): void {
    if (e.button === 1) {
      // Middle button: temporary orbit, or pan with Shift.
      this.beginTemp(e.modifiers.shift ? new PanTool() : new OrbitTool());
      this.call(() => this.temp?.onPointerDown?.(e));
      this.overlayChanged();
      return;
    }
    this.call(() => (this.temp ?? this.active)?.onPointerDown?.(e));
    this.afterInteraction();
  }

  pointerMove(e: ToolPointerEvent): void {
    this.call(() => (this.temp ?? this.active)?.onPointerMove?.(e));
    this.afterInteraction();
  }

  pointerUp(e: ToolPointerEvent): void {
    if (this.temp) {
      this.call(() => this.temp?.onPointerUp?.(e));
      if (e.button === 1 || (e.buttons & 4) === 0) this.endTemp();
      this.overlayChanged();
      return;
    }
    this.call(() => this.active?.onPointerUp?.(e));
    this.afterInteraction();
  }

  click(e: ToolPointerEvent): void {
    if (this.temp || e.button === 1) return;
    this.call(() => this.active?.onClick?.(e));
    this.afterInteraction();
  }

  doubleClick(e: ToolPointerEvent): void {
    if (this.temp || e.button === 1) return;
    this.call(() => this.active?.onDoubleClick?.(e));
    this.afterInteraction();
  }

  wheel(e: ToolWheelEvent): void {
    const consumed = this.call(() => (this.temp ?? this.active)?.onWheel?.(e));
    if (consumed) {
      this.afterInteraction();
      return;
    }
    const notches = e.deltaY / 100;
    const factor = Math.pow(this.wheelZoomFactor, -notches);
    this.camera.zoomAt(e.screen, factor);
    this.ctx.requestRender();
  }

  /** Returns true when the key was consumed by the manager or the active tool. */
  keyDown(e: ToolKeyEvent): boolean {
    if (e.key === 'Escape') {
      this.cancel();
      return true;
    }
    if (this.call(() => this.active?.onKeyDown?.(e) || (this.camerasParked() && this.parked!.onKeyDown?.(e)))) {
      this.afterInteraction();
      return true;
    }
    if (e.code === 'Space' && !e.modifiers.shift && !e.modifiers.ctrl && !e.modifiers.meta && !e.modifiers.alt) {
      if (this.tools.has(this.selectToolId)) {
        this.activate(this.selectToolId);
        return true;
      }
    }
    return false;
  }

  keyUp(e: ToolKeyEvent): boolean {
    const consumed = this.call(() => !!this.active?.onKeyUp?.(e) || (this.camerasParked() && !!this.parked!.onKeyUp?.(e)));
    if (consumed) this.afterInteraction();
    return consumed;
  }

  onVcb(value: VcbValue): void {
    if (value.kind === 'empty') return;
    this.call(() => this.entryTool()?.onVcb?.(value));
    this.afterInteraction();
  }

  /** Apply typed field values (see `Tool.onEntry`); a tool without `onEntry` gets the single value through `onVcb`. */
  onEntry(values: Readonly<Record<string, VcbValue>>): void {
    const entries = Object.entries(values).filter(([, v]) => v.kind !== 'empty');
    const tool = this.entryTool();
    if (!entries.length || !tool) return;
    this.call(() => (tool.onEntry ? tool.onEntry(Object.fromEntries(entries)) : tool.onVcb?.(entries[0]![1])));
    this.afterInteraction();
  }

  lockEntry(id: string, value: VcbValue | null): void {
    const tool = this.entryTool();
    if (!tool?.onEntryLock) return;
    this.call(() => tool.onEntryLock?.(id, value && value.kind !== 'empty' ? value : null));
    this.afterInteraction();
  }

  // --- derived state --------------------------------------------------------------------------

  overlay(): readonly OverlayPrimitive[] {
    const p = this.camerasParked() ? this.parked!.overlay() : [];
    const a = this.active?.overlay() ?? [];
    const t = this.temp?.overlay() ?? [];
    return p.length || t.length ? [...p, ...a, ...t] : a;
  }

  status(): ToolStatus {
    return (this.temp ?? this.active)?.status() ?? EMPTY_STATUS;
  }

  // --- internals ------------------------------------------------------------------------------

  /** Run a tool event handler, marking tool switches it requests as the tool finishing. */
  private call<T>(fn: () => T): T {
    this.inTool++;
    try {
      return fn();
    } finally {
      this.inTool--;
    }
  }

  /** A camera tool is active with a working tool set aside behind it. */
  private camerasParked(): boolean {
    return this.active?.role === 'camera' && this.parked !== null;
  }

  /** The tool typed values go to: the active tool, or the set-aside one behind a camera tool that takes none. */
  private entryTool(): Tool | null {
    const a = this.active;
    if (a && this.camerasParked() && !a.onVcb && !a.onEntry) return this.parked;
    return a;
  }

  private beginTemp(tool: Tool): void {
    this.endTemp();
    this.active?.suspend?.();
    this.temp = tool;
    tool.activate(this.ctx);
    this.emitStatus();
  }

  private endTemp(): void {
    if (!this.temp) return;
    this.temp.deactivate();
    this.temp = null;
    this.active?.resume?.();
    this.emitStatus();
    this.overlayChanged();
  }

  private afterInteraction(): void {
    this.emitStatus();
    this.overlayChanged();
  }

  private emitStatus(): void {
    const s = this.status();
    const prev = this.lastStatus;
    if (s.instructor === prev.instructor && s.vcbLabel === prev.vcbLabel && s.vcbValue === prev.vcbValue && sameFields(s.fields, prev.fields)) return;
    this.lastStatus = s;
    this.events.emit('statusChanged', s);
  }

  private overlayChanged(): void {
    this.events.emit('overlayChanged', undefined);
  }
}

function sameFields(a: ToolStatus['fields'], b: ToolStatus['fields']): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((f, i) => {
    const g = b[i]!;
    return f.id === g.id && f.label === g.label && f.value === g.value && f.locked === g.locked && f.at?.[0] === g.at?.[0] && f.at?.[1] === g.at?.[1] && f.at?.[2] === g.at?.[2];
  });
}
