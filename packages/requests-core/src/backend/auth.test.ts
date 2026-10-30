// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/load.ts';
import { SAMPLE_CONFIG_INPUT } from '../config/sample.ts';
import { bearerToken, enforceRate, errorResponse, hasJobsSecret, HttpError, httpErrorOf, lookupRoles, validateSession } from './auth.ts';
import { DbError, ServiceDb, UserDb } from './db.ts';
import { ALICE, FakeRpc, FakeSessions, myRoles, TOKEN } from './fakes.ts';

const config = loadConfig(SAMPLE_CONFIG_INPUT);
const req = (auth?: string) => new Request('http://x/me', { headers: auth ? { Authorization: auth } : {} });

describe('bearer sessions', () => {
  it('extracts the bearer token case-insensitively and rejects other schemes', () => {
    expect(bearerToken(req('Bearer abc.def'))).toBe('abc.def');
    expect(bearerToken(req('bearer abc'))).toBe('abc');
    expect(bearerToken(req('Basic abc'))).toBeNull();
    expect(bearerToken(req())).toBeNull();
  });
  it('validates the session through the injected validator and lower-cases the email', async () => {
    const sessions = new FakeSessions({ [TOKEN]: ALICE, mixed: { id: 'u2', email: ' Bob@Example.COM ' } });
    expect(await validateSession(req(`Bearer ${TOKEN}`), sessions)).toEqual(ALICE);
    expect((await validateSession(req('Bearer mixed'), sessions)).email).toBe('bob@example.com');
    await expect(validateSession(req(), sessions)).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    await expect(validateSession(req('Bearer nope'), sessions)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(validateSession(req('Bearer x'), { getUser: async () => { throw new Error('network'); } })).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('checks the jobs secret in constant time and refuses an empty secret', () => {
    expect(hasJobsSecret(req('Bearer s3cret'), 's3cret')).toBe(true);
    expect(hasJobsSecret(req('Bearer s3cret!'), 's3cret')).toBe(false);
    expect(hasJobsSecret(req('Bearer '), '')).toBe(false);
    expect(hasJobsSecret(req(), 's3cret')).toBe(false);
  });
});

describe('errors', () => {
  it('maps DbError codes to the HTTP contract and renders the JSON error body with CORS', async () => {
    expect(httpErrorOf(new DbError('auth', 'x'))).toMatchObject({ code: 'unauthorized', status: 401 });
    expect(httpErrorOf(new DbError('forbidden', 'x'))).toMatchObject({ code: 'forbidden', status: 403 });
    expect(httpErrorOf(new DbError('forbidden', 'x'), 'not_found')).toMatchObject({ code: 'not_found', status: 404 });
    expect(httpErrorOf(new DbError('invalid', 'x'))).toMatchObject({ code: 'invalid', status: 400 });
    expect(httpErrorOf(new DbError('limit', 'x'))).toMatchObject({ code: 'limit', status: 409 });
    expect(httpErrorOf(new Error('boom'))).toMatchObject({ code: 'unavailable', status: 503 });
    const res = errorResponse(new HttpError('config_invalid', 'bad', ['tracker.states.build: missing']));
    expect(res.status).toBe(500); expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ error: { code: 'config_invalid', message: 'bad', details: ['tracker.states.build: missing'] } });
    const limited = errorResponse(new HttpError('rate_limited', 'slow down'));
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
  });
});

describe('roles and rate limiting', () => {
  it('reads roles through the user-scoped RPC', async () => {
    const rpc = new FakeRpc({ fr_my_roles: myRoles({ effective: 'builder', roles: [{ role: 'builder', org_id: null }] }) });
    const me = await lookupRoles(new UserDb(rpc), config);
    expect(me.effective).toBe('builder'); expect(rpc.calls).toEqual([{ name: 'fr_my_roles', params: { p_host: 'pushform' } }]);
    await expect(lookupRoles(new UserDb(new FakeRpc({ fr_my_roles: () => { throw new DbError('auth', 'fr_auth'); } })), config)).rejects.toMatchObject({ code: 'unauthorized' });
  });
  it('answers 429 once fr_rate_check says no', async () => {
    let n = 0;
    const db = new ServiceDb(new FakeRpc({ fr_rate_check: (params) => { n += 1; expect(params).toEqual({ p_owner: ALICE.id, p_limit: 20 }); return n <= 2; } }));
    await enforceRate(db, ALICE.id, 20); await enforceRate(db, ALICE.id, 20);
    await expect(enforceRate(db, ALICE.id, 20)).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
  });
});
