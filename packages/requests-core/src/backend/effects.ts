// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Tracker } from '../adapters/tracker.ts';
import type { Config } from '../config/schema.ts';
import type { LinearStateKey } from '../domain/types.ts';
import type { ServiceDb } from './db.ts';

/**
 * Side effects of the build pipeline on the tracker and the requester's inbox. Tracker calls go straight to the adapter
 * when one is configured, so a run's comments appear within seconds; when there is no adapter or the call
 * fails, the same effect is queued as an outbox row and the sweeper delivers it with backoff. The SQL run functions queue
 * their own comments, state moves and emails; this is for effects decided in the backend (stuck runs, merges).
 */
export interface EffectsDeps {
  db: ServiceDb;
  config: Config;
  tracker: Tracker | null;
  log?: ((message: string) => void) | undefined;
}
export type EffectRoute = 'tracker' | 'outbox';

export class Effects {
  constructor(private readonly deps: EffectsDeps) {}
  private get host(): string { return this.deps.config.host; }
  private fallback(what: string, error: unknown): void {
    this.deps.log?.(`${what} failed on the tracker, queued for the sweeper: ${error instanceof Error ? error.message : String(error)}`);
  }
  /** Post a comment on the issue. */
  async comment(issueId: string, body: string, requestId: string | null): Promise<EffectRoute> {
    if (this.deps.tracker) {
      try { await this.deps.tracker.addComment(issueId, body); return 'tracker'; } catch (error) { this.fallback('comment', error); }
    }
    await this.deps.db.outboxEnqueue('tracker_comment', issueId, { issue_id: issueId, host_id: this.host, body }, requestId);
    return 'outbox';
  }
  /** Move the issue to the configured state named by `key`, with an optional comment posted after the move. */
  async setState(issueId: string, key: LinearStateKey, comment: string | null, requestId: string | null): Promise<EffectRoute> {
    const name = this.deps.config.tracker.states[key];
    if (this.deps.tracker) {
      try {
        await this.deps.tracker.setState(issueId, name);
        if (comment) await this.deps.tracker.addComment(issueId, comment);
        return 'tracker';
      } catch (error) { this.fallback(`state ${name}`, error); }
    }
    await this.deps.db.outboxEnqueue('tracker_state', issueId, { issue_id: issueId, host_id: this.host, state: key, ...(comment ? { comment } : {}) }, requestId);
    return 'outbox';
  }
}
