// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from './db.types';
import type { CloudSession } from './CloudSession';
import { cloudProfileComplete, type CloudProfileStore } from './CloudProfile';

export type ProjectActivityKind = 'project_started' | 'meaningful_edit' | 'save_succeeded' | 'document_closed' | 'reopen_succeeded';
export interface ProjectActivityEvent {
  id: string; kind: ProjectActivityKind; documentKey: string; fingerprint: string;
  documentType: 'model' | 'layout'; at: string; storage: 'local' | 'cloud'; fileId?: string; revisionId?: string;
}
export interface ProjectActivitySink { enabled(): boolean; record(event: ProjectActivityEvent): void }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(['project_started','meaningful_edit','save_succeeded','document_closed','reopen_succeeded']);
export function validProjectActivity(value: unknown): value is ProjectActivityEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as ProjectActivityEvent;
  if (Object.values(e).some(v => typeof v !== 'string') || typeof e.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.at)) return false;
  return Object.keys(e).every(k => ['id','kind','documentKey','fingerprint','documentType','at','storage','fileId','revisionId'].includes(k))
    && UUID.test(e.id) && UUID.test(e.documentKey) && /^[0-9a-f]{64}$/.test(e.fingerprint) && KINDS.has(e.kind)
    && ['model','layout'].includes(e.documentType) && Number.isFinite(Date.parse(e.at)) && ['local','cloud'].includes(e.storage)
    && (e.storage === 'cloud' ? UUID.test(e.fileId ?? '') && UUID.test(e.revisionId ?? '') : e.fileId === undefined && e.revisionId === undefined);
}

/** Each immutable event has its own storage key: other tabs cannot overwrite or erase a new event during acknowledgement. */
export class ProjectActivityQueue implements ProjectActivitySink {
  private readonly prefix: string;
  private memory = new Map<string, ProjectActivityEvent>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending = false;
  constructor(private owner: string, private allowed: () => boolean, private since: () => number,
    private transport: (events: readonly ProjectActivityEvent[], owner: string) => Promise<void>, private storage: Storage | null, private retainWhileDisabled: () => boolean = () => false) {
    this.prefix = `pushform:project-events:${owner}:`;
  }
  enabled = (): boolean => this.allowed();
  private keys(): string[] {
    try { return this.storage ? Array.from({ length: this.storage.length }, (_, i) => this.storage!.key(i)).filter((k): k is string => !!k?.startsWith(this.prefix)) : []; }
    catch { return []; }
  }
  clear(): void {
    this.memory.clear(); clearTimeout(this.timer); this.timer = undefined;
    for (const key of this.keys()) { try { this.storage?.removeItem(key); } catch { /* Optional storage. */ } }
  }
  private eligible(e: ProjectActivityEvent): boolean {
    const at = Date.parse(e.at);
    return at >= this.since() && at >= Date.now() - 30 * 86400_000 && at <= Date.now() + 300_000;
  }
  record(event: ProjectActivityEvent): void {
    if (!this.enabled()) { if (!this.retainWhileDisabled()) this.clear(); return; }
    if (!validProjectActivity(event) || !this.eligible(event) || this.memory.size >= 500 || this.keys().length >= 500) return;
    const copy = { ...event }; this.memory.set(copy.id, copy);
    try { this.storage?.setItem(this.prefix + copy.id, JSON.stringify(copy)); } catch { /* Memory-only evidence may be lost on exit; never fabricate it. */ }
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 250);
  }
  async flush(): Promise<void> {
    if (!this.enabled()) { if (!this.retainWhileDisabled()) this.clear(); return; }
    if (this.sending) return;
    clearTimeout(this.timer); this.timer = undefined;
    for (const key of this.keys().slice(0, 500)) {
      try {
        const e: unknown = JSON.parse(this.storage!.getItem(key) ?? 'null');
        if (validProjectActivity(e) && key === this.prefix + e.id && this.eligible(e)) this.memory.set(e.id, e);
        else this.storage?.removeItem(key);
      } catch { try { this.storage?.removeItem(key); } catch { /* Unavailable. */ } }
    }
    for (const [id, e] of this.memory) if (!this.eligible(e)) this.memory.delete(id);
    const pending = [...this.memory.values()].filter(e => this.eligible(e)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    this.sending = true;
    let failed = false;
    try {
      for (let i = 0; i < pending.length; i += 50) {
        if (!this.enabled()) { if (!this.retainWhileDisabled()) this.clear(); return; }
        const batch = pending.slice(i, i + 50);
        await this.transport(batch, this.owner);
        for (const e of batch) { this.memory.delete(e.id); try { this.storage?.removeItem(this.prefix + e.id); } catch { /* Server deduplicates a replay. */ } }
      }
    } catch { failed = true; /* Retry on next observation, reconnect or page load; retain the same event IDs. */ }
    finally {
      this.sending = false;
      if (!failed && this.memory.size && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 250);
    }
  }
}

export class CloudProjectActivity {
  constructor(private client: Pick<SupabaseClient<Database>, 'rpc'>, private session: Pick<CloudSession, 'getSnapshot' | 'subscribe'>,
    private profiles: CloudProfileStore) {}
  forOwner(owner: string, environment: () => boolean, storage: Storage | null): ProjectActivityQueue {
    const allowed = () => {
      const s = this.session.getSnapshot(), p = this.profiles.getSnapshot();
      return environment() && s.status === 'signedIn' && s.user?.id === owner && p.status === 'ready' && p.ownerId === owner
        && cloudProfileComplete(p.profile) && p.profile?.analyticsOptIn === true;
    };
    const retain = () => {
      const s = this.session.getSnapshot(), p = this.profiles.getSnapshot();
      return environment() && s.status === 'signedIn' && s.user?.id === owner &&
        !(p.status === 'ready' && p.ownerId === owner && p.profile?.analyticsOptIn !== true);
    };
    const queue = new ProjectActivityQueue(owner, allowed, () => Date.parse(this.profiles.getSnapshot().profile?.analyticsUpdatedAt ?? ''), async (events, expected) => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
      try {
        const result = await this.client.rpc('app_record_project_events', { p_expected_owner: expected, p_events: events as unknown as Json }).abortSignal(controller.signal);
        if (result.error) throw new Error('Project measurement unavailable.');
      } finally { clearTimeout(timer); }
    }, storage, retain);
    const check = () => { if (!allowed() && !retain()) queue.clear(); else if (allowed()) void queue.flush(); };
    this.session.subscribe(check); this.profiles.subscribe(check);
    return queue;
  }
}
