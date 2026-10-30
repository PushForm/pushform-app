// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/load.ts';
import { SAMPLE_CONFIG_INPUT } from '../config/sample.ts';
import { buildStarted, isClosedRequesterState, isOpenState, requesterStateOf, requesterStateOfKey, stateKeyOf, withdrawAllowed } from './states.ts';
import { LINEAR_STATE_KEYS } from './types.ts';

const states = loadConfig(SAMPLE_CONFIG_INPUT).tracker.states;
const map = (stateName: string, eligibility: 'auto' | 'gated' | 'none' = 'gated', withdrawn = false) => requesterStateOf({ states, stateName, eligibility, withdrawn });

describe('requesterStateOf', () => {
  it('maps every configured state for an eligible requester', () => {
    expect(map('Triage')).toBe('Submitted');
    expect(map('Build')).toBe('Being built');
    expect(map('Design review')).toBe('Being built');
    expect(map('In Progress')).toBe('Being built');
    expect(map('In Trial')).toBe('Ready to try');
    expect(map('Needs Human')).toBe('With the team');
    expect(map('Ready for Review')).toBe('Under maintainer review');
    expect(map('Done')).toBe('Shipped');
    expect(map('Done', 'auto')).toBe('Shipped');
  });
  it('shows Canceled as Declined when a maintainer moved it and Withdrawn when the requester did', () => {
    expect(map('Canceled')).toBe('Declined');
    expect(map('Canceled', 'gated', true)).toBe('Withdrawn');
    expect(map('Canceled', 'none', true)).toBe('Withdrawn');
    expect(map('Canceled', 'none')).toBe('Declined');
  });
  it('shows Submitted for every state before Done except Canceled when eligibility is none', () => {
    for (const key of LINEAR_STATE_KEYS.filter(k => k !== 'done' && k !== 'canceled')) expect(map(states[key], 'none')).toBe('Submitted');
    expect(map('Done', 'none')).toBe('Shipped');
  });
  it('returns null for state names the configuration does not map', () => {
    expect(map('Backlog')).toBeNull();
    expect(stateKeyOf(states, 'Duplicate')).toBeNull();
    expect(stateKeyOf(states, 'In Trial')).toBe('inTrial');
  });
  it('uses the host vocabulary from the configuration', () => {
    const custom = { ...states, triage: 'Inbox', canceled: 'Closed' };
    expect(requesterStateOf({ states: custom, stateName: 'Inbox', eligibility: 'auto', withdrawn: false })).toBe('Submitted');
    expect(requesterStateOf({ states: custom, stateName: 'Closed', eligibility: 'auto', withdrawn: false })).toBe('Declined');
    expect(requesterStateOf({ states: custom, stateName: 'Triage', eligibility: 'auto', withdrawn: false })).toBeNull();
  });
  it('requesterStateOfKey covers every key', () => {
    for (const key of LINEAR_STATE_KEYS) expect(typeof requesterStateOfKey(key, 'auto', false)).toBe('string');
  });
});

describe('open, withdraw and closed helpers', () => {
  it('Done and Canceled are closed; unknown states count as open', () => {
    expect(isOpenState(states, 'Triage')).toBe(true);
    expect(isOpenState(states, 'Done')).toBe(false);
    expect(isOpenState(states, 'Canceled')).toBe(false);
    expect(isOpenState(states, 'Mystery')).toBe(true);
  });
  it('withdraw is offered only while Submitted', () => {
    expect(withdrawAllowed('Triage')).toBe(true);
    expect(withdrawAllowed('Build')).toBe(false);
    expect(withdrawAllowed('Ready for review')).toBe(false);
    expect(buildStarted('triage')).toBe(false);
    expect(buildStarted('build')).toBe(true);
    expect(buildStarted('canceled')).toBe(false);
  });
  it('closed requester states end emails', () => {
    expect(isClosedRequesterState('Shipped')).toBe(true);
    expect(isClosedRequesterState('Declined')).toBe(true);
    expect(isClosedRequesterState('Withdrawn')).toBe(true);
    expect(isClosedRequesterState('With the team')).toBe(false);
  });
});
