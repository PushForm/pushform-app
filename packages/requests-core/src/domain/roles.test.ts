// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { capabilities, combineDisabled, effectiveRole, highestRole, isAtLeast, mayGrant, NOTHING_DISABLED } from './roles.ts';
import type { RoleGrant } from './types.ts';

describe('effectiveRole', () => {
  const grants: RoleGrant[] = [{ role: 'builder', orgId: null }, { role: 'admin', orgId: 'org-a' }, { role: 'maintainer', orgId: 'org-b' }];
  it('is the default role without grants', () => {
    expect(effectiveRole([], 'user')).toBe('user');
    expect(effectiveRole([], 'none')).toBe('none');
  });
  it('unions global grants with the grants of the request organization only', () => {
    expect(effectiveRole(grants, 'user', null)).toBe('builder');
    expect(effectiveRole(grants, 'user', 'org-a')).toBe('admin');
    expect(effectiveRole(grants, 'user', 'org-b')).toBe('maintainer');
    expect(effectiveRole(grants, 'user', 'org-c')).toBe('builder');
  });
  it('never drops below the default role', () => { expect(effectiveRole([{ role: 'user', orgId: null }], 'user')).toBe('user'); });
  it('orders roles', () => {
    expect(highestRole(['user', 'admin', 'builder'])).toBe('admin');
    expect(isAtLeast('maintainer', 'builder')).toBe(true);
    expect(isAtLeast('user', 'builder')).toBe(false);
  });
});

describe('capabilities', () => {
  it('matches the role table', () => {
    expect(capabilities('none')).toEqual({ help: true, file: false, feedback: false, eligible: false, triage: false, admin: false });
    expect(capabilities('user')).toEqual({ help: true, file: true, feedback: false, eligible: false, triage: false, admin: false });
    expect(capabilities('builder')).toEqual({ help: true, file: true, feedback: false, eligible: false, triage: false, admin: false });
    expect(capabilities('maintainer')).toEqual({ help: true, file: true, feedback: false, eligible: false, triage: true, admin: false });
    expect(capabilities('admin')).toEqual({ help: true, file: true, feedback: false, eligible: false, triage: true, admin: true });
  });
  it('applies the disable switches: filing, builds, trials', () => {
    expect(capabilities('admin', { filing: true, builds: false, trials: false })).toMatchObject({ file: false, eligible: false, triage: true });
    expect(capabilities('builder', { filing: false, builds: true, trials: false })).toMatchObject({ file: true, eligible: false });
    expect(capabilities('builder', { filing: false, builds: false, trials: true })).toMatchObject({ feedback: false, eligible: false });
    expect(capabilities('none', { filing: true, builds: true, trials: true }).help).toBe(true);
  });
  it('an organization cannot enable what the host disabled', () => {
    expect(combineDisabled({ filing: true, builds: false, trials: false }, { filing: false, builds: true, trials: false })).toEqual({ filing: true, builds: true, trials: false });
    expect(combineDisabled(NOTHING_DISABLED)).toEqual(NOTHING_DISABLED);
  });
});

describe('mayGrant', () => {
  it('global admins act everywhere, organization admins only in their organization', () => {
    expect(mayGrant([{ role: 'admin', orgId: null }], null)).toBe(true);
    expect(mayGrant([{ role: 'admin', orgId: null }], 'org-a')).toBe(true);
    expect(mayGrant([{ role: 'admin', orgId: 'org-a' }], 'org-a')).toBe(true);
    expect(mayGrant([{ role: 'admin', orgId: 'org-a' }], 'org-b')).toBe(false);
    expect(mayGrant([{ role: 'admin', orgId: 'org-a' }], null)).toBe(false);
    expect(mayGrant([{ role: 'maintainer', orgId: null }], null)).toBe(false);
  });
});
