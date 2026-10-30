// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { TrackerStates } from '../config/schema.ts';
import { LINEAR_STATE_KEYS, type Eligibility, type LinearStateKey, type RequesterState } from './types.ts';

/** Mapping of tracker state keys to requester-facing states; Canceled depends on who moved it. */
export const REQUESTER_STATE_BY_KEY: Readonly<Record<Exclude<LinearStateKey, 'canceled'>, RequesterState>> = {
  triage: 'Submitted',
  build: 'Being built',
  designReview: 'Being built',
  inProgress: 'Being built',
  inTrial: 'Ready to try',
  needsHuman: 'With the team',
  readyForReview: 'Under maintainer review',
  done: 'Shipped',
};

/** Configuration key of a tracker state name (vocabulary mapping); null for states the pipeline does not use. */
export function stateKeyOf(states: TrackerStates, stateName: string): LinearStateKey | null {
  return LINEAR_STATE_KEYS.find(key => states[key] === stateName) ?? null;
}
/** Done and Canceled are closed; everything else counts toward the open-request limit. */
export function isOpenStateKey(key: LinearStateKey): boolean { return key !== 'done' && key !== 'canceled'; }
export function isOpenState(states: TrackerStates, stateName: string): boolean {
  const key = stateKeyOf(states, stateName);
  return key === null ? true : isOpenStateKey(key);
}
/** A build has started once the issue left Triage; Withdraw is no longer offered. */
export function buildStarted(key: LinearStateKey): boolean { return key !== 'triage' && key !== 'canceled'; }

export interface RequesterStateInput {
  states: TrackerStates;
  stateName: string;
  eligibility: Eligibility;
  /** True when the requester withdrew the request; decides Declined vs Withdrawn. */
  withdrawn: boolean;
}
/**
 * Requester-facing state. An `eligible:none` request shows Submitted for every state before
 * Done except Canceled. Unknown state names map to null so callers keep the previous value.
 */
export function requesterStateOf({ states, stateName, eligibility, withdrawn }: RequesterStateInput): RequesterState | null {
  const key = stateKeyOf(states, stateName);
  if (key === null) return null;
  return requesterStateOfKey(key, eligibility, withdrawn);
}
export function requesterStateOfKey(key: LinearStateKey, eligibility: Eligibility, withdrawn: boolean): RequesterState {
  if (key === 'canceled') return withdrawn ? 'Withdrawn' : 'Declined';
  if (eligibility === 'none' && key !== 'done') return 'Submitted';
  return REQUESTER_STATE_BY_KEY[key];
}
/**
 * Withdraw is available only while the issue is still in Triage, before any build. `state` is the
 * canonical pipeline state as stored in `fr_requests.state` and returned by the HTTP contract, never the host's own
 * tracker vocabulary, which `fr_tracker_event` translates on the way in.
 */
export function withdrawAllowed(state: string): boolean { return state === 'Triage'; }
/** States in which the requester receives no further emails. */
export function isClosedRequesterState(state: RequesterState): boolean { return state === 'Shipped' || state === 'Declined' || state === 'Withdrawn'; }
