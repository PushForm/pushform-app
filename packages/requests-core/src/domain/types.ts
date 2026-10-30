// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Domain vocabulary of the feature request pipeline. Pure types; the
 * brief and report shapes mirror `agents/brief.ts`, the request view mirrors `fr_list_my_requests`.
 */

import type { Brief, ChangeClass, ConversationPath, Kind } from '../agents/brief.ts';

/** The brief and report shapes are owned by `agents/brief.ts`; re-exported here so domain code has one import root. */
export type { Kind, Area, ChangeClass, FeatureBrief, ProblemReport, Brief, ReportEnvironment, ConversationPath } from '../agents/brief.ts';
export { AREAS, emptyFeatureBrief, emptyProblemReport } from '../agents/brief.ts';
/** The seven change classes of, ordered from least to most sensitive. */
export const CHANGE_CLASS_ORDER: readonly ChangeClass[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'];
/** Treatment of a class in a scope. */
export type Treatment = 'allowed' | 'review' | 'forbidden';
/** Roles of plus `none` for a host whose default role is None. */
export type Role = 'none' | 'user' | 'builder' | 'maintainer' | 'admin';
export const ROLE_ORDER: readonly Role[] = ['none', 'user', 'builder', 'maintainer', 'admin'];
/** Eligibility label of. */
export type Eligibility = 'auto' | 'gated' | 'none';
/** Keys of the tracker state names in the configuration. */
export type LinearStateKey =
  | 'triage' | 'build' | 'designReview' | 'inProgress' | 'inTrial' | 'needsHuman' | 'readyForReview' | 'done' | 'canceled';
export const LINEAR_STATE_KEYS: readonly LinearStateKey[] =
  ['triage', 'build', 'designReview', 'inProgress', 'inTrial', 'needsHuman', 'readyForReview', 'done', 'canceled'];
/** Requester-facing states. */
export type RequesterState =
  | 'Submitted' | 'Being built' | 'Ready to try' | 'With the team' | 'Under maintainer review' | 'Shipped' | 'Declined' | 'Withdrawn';
/** A role grant row (`fr_roles`); `orgId` null means the global scope. */
export interface RoleGrant { role: Exclude<Role, 'none'>; orgId: string | null }
/** Disable switches of for a host or an organization. */
export interface DisabledParts { filing: boolean; builds: boolean; trials: boolean }

/** One entry of the requester-visible state history. */
export interface RequestHistoryEntry { at: string; requesterState: RequesterState; note: string | null }
/** A request as the requester sees it (`fr_list_my_requests`, `fr_get_request`). */
export interface Request {
  id: string;
  issueKey: string;
  issueUrl: string;
  title: string;
  kind: Kind;
  state: string;
  requesterState: RequesterState;
  estimatedClass: ChangeClass | null;
  eligibility: Eligibility;
  trialUrl: string | null;
  createdAt: string;
  updatedAt: string;
  history: RequestHistoryEntry[];
}
export interface RequestDetail extends Request { brief: Brief | null; transcriptAvailable: boolean }

export type ConversationKind = 'help' | 'intake' | 'feedback';
export type ConversationStatus = 'open' | 'filed' | 'discarded' | 'closed';
/** Screen context the panel sends when a conversation starts (HTTP contract of fr-conversation). */
export interface PanelScreen {
  editor: 'home' | 'model' | 'layout';
  documentType?: string | undefined;
  build: { version: string; commit: string };
  browser: string;
  os: string;
}
/**
 * A turn waiting for the browser to answer document tool calls, stored on the assistant message that ends
 * its first part. A resume replays exactly what the model saw: the same system prompt and tool definitions, the
 * history rebuilt from the `historyLength` messages before the turn's requester message with the same `context`
 * block, and `appended` unchanged (thinking blocks included). Raw Messages API shapes, kept as opaque JSON here.
 */
export interface SuspendedTurn {
  model: string;
  system: string;
  tools: unknown[];
  context: string;
  historyLength: number;
  appended: unknown[];
  pending: { calls: { id: string; name: string; input: unknown }[]; results: unknown[]; order: string[] };
  rounds: number;
  document: { type: 'layout' | 'model'; apiVersion: number; readonly guidance?: 1 | undefined };
}
/** A visible chat message; `tool` messages record the model's tool use and are hidden from the UI. */
export type ConversationMessage =
  | { role: 'user'; text: string; at: string }
  | { role: 'assistant'; text: string; at: string; turn?: SuspendedTurn }
  | { role: 'tool'; name: string; toolUseId: string; input: unknown; output: string; at: string };
export interface Conversation {
  id: string;
  kind: ConversationKind;
  path: ConversationPath;
  status: ConversationStatus;
  title: string | null;
  brief: Brief | null;
  messages: ConversationMessage[];
  messageCount: number;
  requestId: string | null;
  screen: PanelScreen | null;
  startedAt: string;
  updatedAt: string;
}
