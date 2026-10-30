// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState } from 'react';
import type { UsageEvent, UsageKind, UsageSink } from '@pushform/cloud';
import type { BuildInfo } from './buildInfo';
import type { DocumentSession, DocumentTab } from './session';

/** Events are sent at most this often, and on page hide. */
export const USAGE_SEND_MS = 30_000;
/** `app_record_events` takes at most this many events per call. */
export const USAGE_BATCH = 50;
/** What `app_events` accepts as a tool or command id and as an error category; anything else is never sent. */
const TOOL_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/;
const CATEGORY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MINUTE = 60_000;

type DocumentType = 'model' | 'layout';
type PlainKind = Exclude<UsageKind, 'tool_use' | 'error'>;
export interface UsageClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const systemClock: UsageClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The class name of a thrown value, as the error category: `TypeError`, `QuotaExceededError` and the like. Never
 * the message. A value that is not an error, or a name that does not read as an error class, is `UnknownError`.
 */
export function errorCategory(value: unknown): string {
  const name = value instanceof Error || (typeof value === 'object' && value !== null && 'name' in value) ? (value as { name?: unknown }).name : null;
  return typeof name === 'string' && CATEGORY.test(name) && /(Error|Exception)$/.test(name) ? name : 'UnknownError';
}

/**
 * Product usage recorder. Events queue in memory and go to the sink at most every 30 seconds, and at
 * once on page hide, in calls of at most 50. A call that fails is tried once more with the next send and then dropped.
 * Tool and command use and errors are counted per minute: one event per id or category per minute with its count.
 * Events carry kinds, document types, ids, categories and durations only, never document names or content.
 */
export class UsageRecorder {
  private queue: UsageEvent[] = [];
  /** Per-minute counts of tool use and errors not yet queued, by kind, id and minute. */
  private counted = new Map<string, { event: UsageEvent; count: number }>();
  /** Calls that failed once and get one more try. */
  private failed: UsageEvent[][] = [];
  private timer: unknown = null;
  private sending: Promise<void> | null = null;

  constructor(private readonly sink: UsageSink, private readonly app: { readonly version?: string | undefined; readonly build?: string | undefined } = {},
    private readonly clock: UsageClock = systemClock) {}

  record(kind: PlainKind, detail: { documentType?: DocumentType | undefined; durationSeconds?: number | undefined } = {}): void {
    this.queue.push(this.event(kind, this.clock.now(), {
      ...(detail.documentType ? { documentType: detail.documentType } : {}),
      ...(kind === 'document_close' && detail.durationSeconds !== undefined ? { durationSeconds: Math.max(0, Math.round(detail.durationSeconds)) } : {}),
    }));
    this.schedule();
  }
  /** A tool activation or command run (`tool_use`), counted per minute. Ids the table would refuse are skipped. */
  tool(id: string, documentType?: DocumentType): void {
    if (TOOL_ID.test(id)) this.count('tool_use', { tool: id, ...(documentType ? { documentType } : {}) });
  }
  /** A client error (`error`) by category only, counted per minute. */
  error(category: string): void {
    this.count('error', { category: CATEGORY.test(category) ? category : 'UnknownError' });
  }

  /** Send everything queued now (page hide, tests). Calls run one at a time; a later flush waits for the current one. */
  flush(): Promise<void> {
    if (this.timer !== null) { this.clock.clearTimeout(this.timer); this.timer = null; }
    const previous = this.sending ?? Promise.resolve();
    const run = previous.then(() => this.send());
    this.sending = run.finally(() => { if (this.sending === run) this.sending = null; });
    return run;
  }

  /** Flush on page hide and record uncaught errors and unhandled rejections; returns the detach function. */
  attach(target: Pick<Window, 'addEventListener' | 'removeEventListener'> & { document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> }): () => void {
    const hide = (): void => { void this.flush(); };
    const visibility = (): void => { if (target.document?.visibilityState === 'hidden') hide(); };
    const failure = (event: Event): void => {
      const error = (event as ErrorEvent).error;
      this.error(error === undefined || error === null ? 'ScriptError' : errorCategory(error));
    };
    const rejection = (event: Event): void => {
      const reason = (event as PromiseRejectionEvent).reason;
      this.error(reason instanceof Error ? errorCategory(reason) : 'UnhandledRejection');
    };
    target.addEventListener('pagehide', hide);
    target.addEventListener('error', failure);
    target.addEventListener('unhandledrejection', rejection);
    target.document?.addEventListener('visibilitychange', visibility);
    return () => {
      target.removeEventListener('pagehide', hide);
      target.removeEventListener('error', failure);
      target.removeEventListener('unhandledrejection', rejection);
      target.document?.removeEventListener('visibilitychange', visibility);
    };
  }

  private event(kind: UsageKind, at: number, extra: Partial<UsageEvent>): UsageEvent {
    return { kind, at: new Date(at).toISOString(), ...extra,
      ...(this.app.version ? { appVersion: this.app.version } : {}), ...(this.app.build ? { appBuild: this.app.build } : {}) };
  }
  private count(kind: 'tool_use' | 'error', detail: Pick<UsageEvent, 'tool' | 'category' | 'documentType'>): void {
    const minute = Math.floor(this.clock.now() / MINUTE) * MINUTE;
    const key = `${kind}|${detail.tool ?? detail.category}|${detail.documentType ?? ''}|${minute}`;
    const entry = this.counted.get(key);
    if (entry) entry.count++;
    else this.counted.set(key, { event: this.event(kind, minute, detail), count: 1 });
    this.schedule();
  }
  private schedule(): void {
    if (this.timer === null) this.timer = this.clock.setTimeout(() => { this.timer = null; void this.flush(); }, USAGE_SEND_MS);
  }
  private async send(): Promise<void> {
    for (const { event, count } of this.counted.values()) this.queue.push(count === 1 ? event : { ...event, count: Math.min(count, 10_000) });
    this.counted.clear();
    const retries = this.failed;
    const fresh: UsageEvent[][] = [];
    for (let i = 0; i < this.queue.length; i += USAGE_BATCH) fresh.push(this.queue.slice(i, i + USAGE_BATCH));
    this.queue = []; this.failed = [];
    for (const batch of retries) await this.sink.send(batch).catch(() => { /* Tried twice: dropped. */ });
    for (const batch of fresh) await this.sink.send(batch).catch(() => { this.failed.push(batch); });
    if (this.failed.length) this.schedule();
  }
}

/** A new, never-saved document: the name the session gives it, with no cloud identity. */
const UNTITLED = /^Untitled( \d+)?\.[A-Za-z]+$/;

/**
 * Wire product usage into the workspace: `session_start` once the workspace is unlocked, `home_view` each time
 * Home is shown, `document_open`, `document_create` and `document_close` (with how long it was open) as tabs come and
 * go, `tool_use` for every command the active document runs (tool activations are commands), and `help_open` each time
 * AI Chat is opened. The blank document every workspace starts with counts only once it is changed or replaced by
 * another document. Returns the recorder so AI Chat can count `help_message`.
 */
export function useProductUsage(sink: UsageSink | undefined, buildInfo: BuildInfo | undefined, session: DocumentSession,
  state: { locked: boolean; home: boolean; helpOpen: boolean; activeId: string }): UsageRecorder | null {
  const [recorder] = useState(() => sink ? new UsageRecorder(sink, { version: buildInfo?.version, build: buildInfo?.commit }) : null);
  const { locked, home, helpOpen, activeId } = state;
  useEffect(() => {
    if (!recorder || typeof window === 'undefined') return;
    const detach = recorder.attach(window);
    return () => { detach(); void recorder.flush(); };
  }, [recorder]);
  const started = useRef(false);
  useEffect(() => {
    if (!recorder || locked || started.current) return;
    started.current = true;
    recorder.record('session_start');
  }, [recorder, locked]);
  useEffect(() => { if (recorder && !locked && home) recorder.record('home_view'); }, [recorder, locked, home]);
  useEffect(() => { if (recorder && !locked && helpOpen) recorder.record('help_open'); }, [recorder, locked, helpOpen]);
  const tabs = useRef(new Map<string, { type: DocumentType; opened: number; reported: boolean }>());
  useEffect(() => {
    if (!recorder || locked) return;
    const sync = (initial: boolean): void => {
      const now = Date.now(), present = new Set<string>();
      for (const tab of session.tabs) {
        present.add(tab.id);
        const known = tabs.current.get(tab.id);
        if (known?.reported) continue;
        const untitled = !tab.identity && UNTITLED.test(tab.name);
        const blank = untitled && (initial || known !== undefined) && !session.isDirty(tab as DocumentTab);
        if (!known) tabs.current.set(tab.id, { type: tab.type, opened: now, reported: !blank });
        else if (!blank) known.reported = true;
        if (!blank) recorder.record(untitled ? 'document_create' : 'document_open', { documentType: tab.type });
      }
      for (const [id, info] of tabs.current) {
        if (present.has(id)) continue;
        tabs.current.delete(id);
        if (info.reported) recorder.record('document_close', { documentType: info.type, durationSeconds: (now - info.opened) / 1000 });
      }
    };
    sync(true);
    return session.subscribe(() => sync(false));
  }, [recorder, locked, session]);
  useEffect(() => {
    if (!recorder || locked) return;
    const type = session.active.type;
    return session.activeCommands.events.on('executed', ({ id }) => recorder.tool(id, type));
  }, [recorder, locked, session, activeId]);
  return recorder;
}
