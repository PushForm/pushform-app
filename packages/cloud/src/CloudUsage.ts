// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from './db.types';
import { callRpc } from './rpc';
import type { CloudSession } from './CloudSession';

/** The product usage event kinds `app_record_events` accepts. */
export type UsageKind = 'session_start' | 'home_view' | 'document_open' | 'document_create' | 'document_close'
  | 'tool_use' | 'help_open' | 'help_message' | 'error';

/**
 * One product usage event. Identifiers and categories only: never a document name, message or content.
 * `tool` is a tool or command id (tool_use), `category` an error class name (error), `count` how many times in the minute
 * the event stands for, `durationSeconds` how long a document was open (document_close), `at` the client time.
 */
export interface UsageEvent {
  readonly kind: UsageKind;
  readonly documentType?: 'model' | 'layout' | undefined;
  readonly tool?: string | undefined;
  readonly category?: string | undefined;
  readonly count?: number | undefined;
  readonly durationSeconds?: number | undefined;
  readonly appVersion?: string | undefined;
  readonly appBuild?: string | undefined;
  readonly at: string;
}

/** Sends a batch of at most 50 events for the signed-in account; rejects when the batch was not stored. */
export interface UsageSink {
  send(events: readonly UsageEvent[]): Promise<void>;
}

export class CloudUsageError extends Error {
  constructor(readonly code: 'auth' | 'invalid' | 'rate_limited' | 'unavailable', message: string) { super(message); this.name = 'CloudUsageError'; }
}

/** `app_record_events` takes snake_case keys and refuses unknown or empty ones, so only set fields are sent. */
export function usageEventJson(event: UsageEvent): Record<string, Json> {
  const row: Record<string, Json> = { kind: event.kind, client_at: event.at };
  if (event.documentType) row['document_type'] = event.documentType;
  if (event.tool) row['tool'] = event.tool;
  if (event.category) row['category'] = event.category;
  if (event.count !== undefined && event.count !== 1) row['count'] = event.count;
  if (event.durationSeconds !== undefined) row['duration_seconds'] = event.durationSeconds;
  if (event.appVersion) row['app_version'] = event.appVersion;
  if (event.appBuild) row['app_build'] = event.appBuild;
  return row;
}

/**
 * Records the signed-in account's usage events through `app_record_events`. An installation without the
 * function (its migration not applied yet) is asked once; later events are dropped for the rest of the page's life.
 */
export class CloudUsage implements UsageSink {
  private missing = false;
  constructor(private readonly client: Pick<SupabaseClient<Database>, 'rpc'>, private readonly session: Pick<CloudSession, 'getSnapshot'>) {}
  async send(events: readonly UsageEvent[]): Promise<void> {
    if (!events.length || this.missing) return;
    if (this.session.getSnapshot().status !== 'signedIn') throw new CloudUsageError('auth', 'Not signed in.');
    const { error } = await callRpc(this.client, 'app_record_events', { p_events: events.map(usageEventJson) });
    if (!error) return;
    if (error.code === 'PGRST202' || error.code === '42883') { this.missing = true; return; }
    const text = `${error.message ?? ''}`;
    if (text.includes('cloud_auth')) throw new CloudUsageError('auth', 'Not signed in.');
    if (text.includes('cloud_invalid')) throw new CloudUsageError('invalid', 'The events were refused.');
    if (text.includes('cloud_rate_limited')) throw new CloudUsageError('rate_limited', 'Too many events.');
    throw new CloudUsageError('unavailable', 'Usage events could not be sent.');
  }
}
