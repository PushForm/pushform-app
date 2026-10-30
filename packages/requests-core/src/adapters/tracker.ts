// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { HeadersLike } from './signature.ts';
import type { Kind } from '../domain/types.ts';

/** Input of `createIssue`; `kind` selects the problem destination. */
export interface TrackerIssueInput { id?: string; title: string; body: string; labels: readonly string[]; kind: Kind }
/** An issue as the tracker reports it. */
export interface TrackerIssue {
  id: string;
  /** Human identifier such as `FRQ-123`. */
  key: string;
  url: string;
  title: string;
  state: string;
  labels: string[];
  body: string | null;
}
/** Events the webhook parser produces for `fr_tracker_event`; `deliveryId` makes them idempotent. */
export type TrackerEvent =
  | { kind: 'state'; issueId: string; issueKey: string | null; stateName: string; previousStateName: string | null; actor: TrackerActor; deliveryId: string; at: string }
  | { kind: 'comment'; issueId: string; issueKey: string | null; commentId: string; body: string; actor: TrackerActor; deliveryId: string; at: string }
  | { kind: 'label'; issueId: string; issueKey: string | null; labels: string[]; previousLabels: string[] | null; actor: TrackerActor; deliveryId: string; at: string };
export interface TrackerActor { id: string | null; name: string | null; email: string | null; type: 'user' | 'integration' | 'unknown' }
export interface WebhookInput { body: string; headers: HeadersLike }

export class TrackerError extends Error {
  constructor(readonly code: 'auth' | 'rate_limited' | 'unavailable' | 'invalid' | 'not_found', message: string, override readonly cause?: unknown) {
    super(message); this.name = 'TrackerError';
  }
}

/** Adapter contract of the architecture §6.3; the Linear implementation is `LinearTracker`. */
export interface Tracker {
  uploadImage(name: string, mime: string, bytes: Blob): Promise<string>;
  createIssue(input: TrackerIssueInput): Promise<TrackerIssue>;
  addComment(issueId: string, body: string): Promise<{ id: string }>;
  setState(issueId: string, stateName: string): Promise<void>;
  setLabels(issueId: string, labels: readonly string[]): Promise<void>;
  getIssue(issueId: string): Promise<TrackerIssue | null>;
  /** Open issues of the team whose title or body match the text. */
  searchOpen(query: string): Promise<TrackerIssue[]>;
  /** State names the team defines. */
  listStateNames(): Promise<string[]>;
  /** Project names reachable from the team (the filing destination must exist). */
  listProjectNames(): Promise<string[]>;
  verifyWebhook(input: WebhookInput): Promise<boolean>;
  /** Parse a verified payload; null for events the pipeline ignores. */
  parseWebhook(input: WebhookInput): TrackerEvent | null;
}

/** `Requester:` first line marks a comment for relay; returns the rest of the comment or null. */
export function relayedCommentBody(body: string): string | null {
  const m = /^\s*Requester:[ \t]*(.*)\r?\n?([\s\S]*)$/.exec(body);
  if (!m) return null;
  const text = [m[1] ?? '', m[2] ?? ''].join('\n').trim();
  return text || null;
}
