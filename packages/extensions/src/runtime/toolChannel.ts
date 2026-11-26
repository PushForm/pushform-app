// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ExtensionError, TOOL_LIMITS, toolPresentSchema, toolSourceSchema, toolStampSchema, type ToolInput, type ToolSource, type ToolStamp, type ToolStopReason, type ToolView } from '@pushform/extension-protocol';

interface Queued { source: ToolSource; stamp: ToolStamp }
export interface ToolChannelOptions {
  readonly session: string;
  readonly stamp: () => ToolStamp;
  readonly publish: (input: ToolInput) => void;
  readonly render: (view: ToolView | null) => void;
  readonly ended: (reason: ToolStopReason) => void;
  readonly acknowledgementMs?: number;
}

/** One host-issued active tool's ordered input and bounded preview lifetime. No extension code runs here. */
export class ToolInputChannel {
  private sequence = 0;
  private waiting: ToolInput | null;
  private readonly queue: Queued[] = [];
  private move: Queued | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly deadline: number;
  readonly activation: ToolInput;
  constructor(private readonly options: ToolChannelOptions) {
    this.deadline = options.acknowledgementMs ?? TOOL_LIMITS.acknowledgementMs;
    if (!Number.isFinite(this.deadline) || this.deadline <= 0) throw new Error('Tool acknowledgement deadline must be positive.');
    this.activation = this.make({ source: { kind: 'activate', data: {} }, stamp: this.snapshot() });
    this.waiting = this.activation;
    this.arm();
  }
  get active(): boolean { return !this.stopped; }
  get buffered(): number { return this.queue.length + (this.move ? 1 : 0); }
  /** Capture the exact input a geometry commit answers. Camera navigation alone does not invalidate its model target. */
  capture(session: string, sequence: number): ToolStamp {
    const waiting = this.assertWaiting(session, sequence), now = this.snapshot();
    if (waiting.revision !== now.revision || waiting.contextVersion !== now.contextVersion)
      throw new ExtensionError('revision.stale', 'The model or edit context changed before this tool operation was ready.');
    return { revision: waiting.revision, contextVersion: waiting.contextVersion, cameraVersion: waiting.cameraVersion, context: [...waiting.context] };
  }
  /** Pointer moves coalesce only between discrete transitions; a click can never overtake its preceding move. */
  input(value: ToolSource): boolean {
    if (this.stopped) return false;
    const source = toolSourceSchema.parse(value), item = { source, stamp: this.snapshot() };
    if (!this.waiting) { this.deliver(item); return true; }
    if (source.kind === 'pointerMove' || source.kind === 'resync') this.move = item;
    else { if (this.move) { this.queue.push(this.move); this.move = null; } this.queue.push(item); }
    if (this.buffered > TOOL_LIMITS.queuedInputs) { this.end('limit.exceeded'); return false; }
    return true;
  }
  /** An acknowledgement may drain exactly its own in-flight input, even when no preview changed. */
  ack(session: string, sequence: number): void {
    this.assertWaiting(session, sequence);
    this.waiting = null;
    this.clearTimer();
    const next = this.queue.shift() ?? this.move;
    if (next) { if (!this.queue.length && next === this.move) this.move = null; this.deliver(next); }
  }
  present(input: unknown): void {
    const parsed = toolPresentSchema.safeParse(input);
    if (!parsed.success) throw new ExtensionError('validation.failed', 'The tool presentation is invalid or exceeds its limits.');
    const { session, sequence, view } = parsed.data;
    const waiting = this.assertWaiting(session, sequence), now = this.snapshot();
    if (waiting.revision !== now.revision || waiting.contextVersion !== now.contextVersion || waiting.cameraVersion !== now.cameraVersion)
      throw new ExtensionError('revision.stale', 'The viewport changed before this tool preview was ready.');
    this.options.render(view);
    this.ack(session, sequence);
  }
  /** Teardown never waits for a worker, acknowledgement, model read or cleanup callback. */
  end(reason: ToolStopReason = 'ended'): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimer(); this.waiting = null; this.queue.length = 0; this.move = null;
    try { this.options.render(null); } finally { this.options.ended(reason); }
  }
  private snapshot(): ToolStamp { return toolStampSchema.parse(this.options.stamp()); }
  private assertWaiting(session: string, sequence: number): ToolInput {
    if (this.stopped) throw new ExtensionError('cancelled', 'The tool session has ended.');
    if (session !== this.options.session) throw new ExtensionError('permission.denied', 'This tool session belongs to another owner.');
    if (!this.waiting || sequence !== this.waiting.sequence) throw new ExtensionError('revision.stale', 'This tool input is no longer awaiting a response.');
    return this.waiting;
  }
  private make(item: Queued): ToolInput { return { ...item.source, ...item.stamp, session: this.options.session, sequence: this.sequence++ }; }
  private deliver(item: Queued): void {
    const input = this.make(item); this.waiting = input; this.arm();
    try { this.options.publish(input); } catch { this.end('runtime.failed'); }
  }
  private clearTimer(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private arm(): void { this.clearTimer(); this.timer = setTimeout(() => this.end('unresponsive'), this.deadline); }
}
