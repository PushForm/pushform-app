// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { checkTrackerStates, configHash, loadConfig, validateConfig } from './load.ts';
import { SAMPLE_CONFIG_INPUT } from './sample.ts';

describe('validateConfig', () => {
  it('returns the parsed configuration for valid input', () => {
    const result = validateConfig(SAMPLE_CONFIG_INPUT);
    expect(result.ok).toBe(true);
    expect(result.ok && result.config.tracker.states.triage).toBe('Triage');
    expect(result.errors).toEqual([]);
  });
  it('names missing keys as Required with their path', () => {
    const { triage: _t, ...states } = SAMPLE_CONFIG_INPUT.tracker.states;
    const result = validateConfig({ ...SAMPLE_CONFIG_INPUT, tracker: { ...SAMPLE_CONFIG_INPUT.tracker, states } });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['tracker.states.triage: Required']);
  });
  it('reports several readable errors at once', () => {
    const result = validateConfig({
      ...SAMPLE_CONFIG_INPUT, host: undefined, roles: { defaultRole: 'owner', admins: ['not-an-email'] }, limits: { rounds: -1 }, typo: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('host: Required');
    expect(result.errors).toContain('roles.defaultRole: Expected one of "user", "none"');
    expect(result.errors.some(e => e.startsWith('roles.admins.0: '))).toBe(true);
    expect(result.errors.some(e => e.startsWith('limits.rounds: '))).toBe(true);
    expect(result.errors).toContain('(root): Unknown key "typo"');
  });
  it('explains a wrong adapter kind through the union', () => {
    const result = validateConfig({ ...SAMPLE_CONFIG_INPUT, mail: { kind: 'sendgrid', from: 'a@b.co', replyTo: 'c@d.co' } });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/^mail(\.kind)?: /);
  });
  it('rejects non-objects', () => {
    expect(validateConfig(null).ok).toBe(false);
    expect(validateConfig('x').errors[0]).toMatch(/^\(root\): /);
  });
  it('loadConfig throws with every error listed', () => {
    expect(() => loadConfig({})).toThrow(/feature-requests.config.json is invalid:\n {2}host: Required\n {2}name: Required/);
    expect(loadConfig(SAMPLE_CONFIG_INPUT).host).toBe('pushform');
  });
  it('configHash is stable for equal configurations', async () => {
    const a = await configHash(loadConfig(SAMPLE_CONFIG_INPUT));
    const b = await configHash(loadConfig({ ...SAMPLE_CONFIG_INPUT }));
    const c = await configHash(loadConfig({ ...SAMPLE_CONFIG_INPUT, name: 'Other' }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('checkTrackerStates', () => {
  const config = loadConfig(SAMPLE_CONFIG_INPUT);
  const team = ['Triage', 'Backlog', 'Build', 'Design review', 'In Progress', 'In Trial', 'Needs Human', 'Ready for Review', 'Done', 'Canceled', 'Duplicate'];
  it('passes when every configured state exists', () => { expect(checkTrackerStates(config, team)).toEqual([]); });
  it('reports each missing state with a case hint when one differs only by case', () => {
    const errors = checkTrackerStates(config, team.filter(s => s !== 'Done' && s !== 'Canceled').concat('done'));
    expect(errors).toEqual([
      'tracker.states.done: state "Done" does not exist in team FRQ (the team has "done"; state names are case-sensitive)',
      'tracker.states.canceled: state "Canceled" does not exist in team FRQ',
    ]);
  });
});
