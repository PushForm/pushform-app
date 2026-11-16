// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { ExtensionError, toolAckSchema, toolApplySchema, toolEndSchema, type ExtensionPermission, type ToolInput, type ToolSource, type ToolStamp, type ToolStopReason, type ToolView } from '@pushform/extension-protocol';
import type { ExtensionSession, ServiceImplementations, ServiceMethod } from './host';
import { ToolInputChannel } from './toolChannel';

/** Trusted viewport integration. It owns native input, snapping, navigation and rendering. */
export interface ExtensionToolViewport {
  stamp(): ToolStamp;
  present(view: ToolView | null): void;
  close(reason: ToolStopReason): void;
}
export interface ExtensionToolRequest {
  readonly documentId: string;
  readonly id: string;
  readonly title: string;
  readonly input: (input: ToolSource) => void;
  readonly ended: (reason: ToolStopReason) => void;
}
export interface ExtensionTools {
  /** Replaces any other extension tool. Throws when this document has no active modeling viewport. */
  open(request: ExtensionToolRequest): ExtensionToolViewport;
}
interface ActiveTool {
  readonly id: string;
  readonly documentId: string;
  readonly channel: ToolInputChannel;
  readonly controller: AbortController;
  committing: boolean;
  lastCommit?: { revision: number; contextVersion: number; context: number[] };
}

/** One runtime generation's tools. No runtime request can activate a tool or choose its owner/document. */
export class ExtensionToolHost {
  private current: ActiveTool | null = null;
  constructor(private readonly adapter: ExtensionTools | undefined, private readonly session: () => ExtensionSession | undefined,
    private readonly edits?: { grants: ReadonlySet<ExtensionPermission>; apply: ServiceMethod | undefined }) {}

  begin(documentId: string, title: string): { input: ToolInput; signal: AbortSignal; end: () => void } {
    const session = this.session();
    if (!this.adapter || !session) throw new ExtensionError('unavailable', 'Interactive extension tools are unavailable in this editor.');
    this.end('replaced');
    const id = `tool_${crypto.randomUUID()}`, controller = new AbortController();
    let channel: ToolInputChannel | undefined;
    const viewport = this.adapter.open({ documentId, id, title,
      input: input => channel?.input(input), ended: reason => channel?.end(reason) });
    try {
      channel = new ToolInputChannel({ session: id, stamp: () => viewport.stamp(),
        publish: input => {
          // Merely hovering must not keep gesture-gated services available indefinitely.
          if (['pointerDown', 'click', 'doubleClick', 'keyDown', 'measurement', 'entry', 'choice'].includes(input.kind)) session.noteUserAction();
          session.notify('tools', 'input', input);
        },
        render: view => viewport.present(view),
        ended: reason => {
          if (this.current?.id === id) this.current = null;
          controller.abort();
          try { viewport.close(reason); } finally {
            try { session.notify('tools', 'ended', { session: id, reason }); } catch { /* A dead runtime cannot delay native teardown. */ }
          }
        },
      });
    } catch (error) { viewport.close('runtime.failed'); throw error; }
    this.current = { id, documentId, channel, controller, committing: false };
    return { input: channel.activation, signal: controller.signal, end: () => channel.end('runtime.failed') };
  }

  services(): ServiceImplementations {
    return {
      'tools.apply': async (input, call) => {
        if (!this.edits?.grants.has('model.write')) throw new ExtensionError('permission.denied', 'Tool edits require model.write.');
        if (!this.edits.apply) throw new ExtensionError('unavailable', 'This editor does not support tool edits.');
        const parsed = this.parse(toolApplySchema, input), channel = this.owned(parsed.session);
        const captured = channel.capture(parsed.session, parsed.sequence), current = this.current!;
        this.assertIdle();
        if (parsed.batch.expectedRevision !== captured.revision) throw new ExtensionError('revision.stale', 'A tool edit must use its input revision.');
        if (parsed.batch.container && (parsed.batch.container.length !== captured.context.length || parsed.batch.container.some((id, index) => id !== captured.context[index])))
          throw new ExtensionError('validation.failed', 'A tool edit must use its captured edit context.');
        if (parsed.amendPrevious && (!current.lastCommit || current.lastCommit.revision !== captured.revision
          || current.lastCommit.contextVersion !== captured.contextVersion || current.lastCommit.context.length !== captured.context.length
          || current.lastCommit.context.some((id, index) => id !== captured.context[index])))
          throw new ExtensionError('revision.stale', "Only this tool session's unchanged last gesture can be corrected.");
        const document = this.session()!.openDocument(current.documentId);
        current.committing = true;
        try {
          const result = await this.edits.apply({ ...parsed.batch, container: captured.context, document }, { ...call, toolSession: current.id, separateUndo: !parsed.amendPrevious, amendToolUndo: !!parsed.amendPrevious, signal: AbortSignal.any([call.signal, current.controller.signal]) });
          const revision = (result as { revision?: unknown })?.revision;
          if (typeof revision === 'number') current.lastCommit = { revision, contextVersion: captured.contextVersion, context: [...captured.context] };
          return result;
        } finally { current.committing = false; }
      },
      'tools.present': input => { const identity = this.parse(toolAckSchema, this.identity(input)); const channel = this.owned(identity.session); this.assertIdle(); channel.present(input); return null; },
      'tools.ack': input => { const parsed = this.parse(toolAckSchema, input); const channel = this.owned(parsed.session); this.assertIdle(); channel.ack(parsed.session, parsed.sequence); return null; },
      'tools.end': input => { const parsed = this.parse(toolEndSchema, input); this.owned(parsed.session).end(); return null; },
    };
  }
  closed(documentId: string): void { if (this.current?.documentId === documentId) this.end('document.closed'); }
  end(reason: ToolStopReason = 'disabled'): void { this.current?.channel.end(reason); }
  private assertIdle(): void { if (this.current?.committing) throw new ExtensionError('unavailable', 'Wait for this tool edit to finish before acknowledging its input.'); }

  private owned(id: string): ToolInputChannel {
    if (!this.current || this.current.id !== id) throw new ExtensionError('cancelled', 'This tool session is no longer active in this runtime.');
    return this.current.channel;
  }
  private identity(input: unknown): unknown {
    if (typeof input !== 'object' || input === null) return input;
    const { session, sequence } = input as Record<string, unknown>;
    return { session, sequence };
  }
  private parse<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new ExtensionError('validation.failed', 'The tool request is invalid.');
    return parsed.data;
  }
}
