// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it, vi } from 'vitest';
import { mainCiDecision, mainCiRetryAt, scheduleMainCi, waitAndScheduleMainCi } from './ci-schedule.mjs';

const now = Date.parse('2026-10-27T12:30:00Z');
const run = (overrides = {}) => ({
  head_branch: 'main', event: 'workflow_dispatch', head_sha: 'old', status: 'completed', conclusion: 'success',
  created_at: '2026-10-27T12:00:00Z', run_started_at: '2026-10-27T12:00:00Z', ...overrides,
});

describe('main CI batching', () => {
  it('runs the first batch and coalesces any number of commits into the latest head', () => {
    expect(mainCiDecision('new', [], now)).toBeNull();
    expect(mainCiDecision('new', [run()], now)).toBeNull();
  });

  it.each(['success', 'failure', 'cancelled'])('does not rebuild an unchanged commit after %s', conclusion => {
    expect(mainCiDecision('old', [run({ conclusion })], now)).toContain('not changed');
  });

  it('enforces the exact 15-minute boundary even when a schedule was delayed', () => {
    const previous = run({ run_started_at: new Date(now - 15 * 60 * 1000 + 1).toISOString() });
    expect(mainCiDecision('new', [previous], now)).toContain('less than 15 minutes');
    expect(mainCiDecision('new', [previous], now + 1)).toBeNull();
  });

  it.each(['queued', 'in_progress', 'waiting', 'pending', 'requested'])('waits for an active %s run even after 15 minutes', status => {
    expect(mainCiDecision('new', [run({ status })], now)).toContain('already queued or running');
  });

  it('ignores PR and other-branch checks and honors the latest main run across trigger types', () => {
    expect(mainCiDecision('new', [run({ event: 'pull_request', status: 'in_progress' }), run({ head_branch: 'feature', status: 'queued' })], now)).toBeNull();
    expect(mainCiDecision('new', [run(), run({ event: 'push', head_sha: 'new', created_at: '2026-10-27T12:10:00Z' })], now)).toContain('not changed');
    expect(mainCiDecision('new', [run({ event: 'push', run_started_at: '2026-10-27T12:29:00Z' }), run()], now)).toContain('less than 15 minutes');
  });

  it('fails closed on invalid run timestamps', () => {
    expect(() => mainCiDecision('new', [run({ created_at: 'invalid' })], now)).toThrow('start time');
  });
});

function client(runs = []) {
  return { rest: {
    git: { getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'new' } } }) },
    actions: {
      listWorkflowRuns: vi.fn(async ({ event }) => ({ data: { workflow_runs: runs.filter(run => run.event === event) } })),
      createWorkflowDispatch: vi.fn().mockResolvedValue({ status: 204 }),
    },
  } };
}
const repo = { owner: 'PushForm', repo: 'PushForm' };

it('checks real main CI runs, then dispatches ci.yml on main once', async () => {
  const github = client([run()]);
  expect(await scheduleMainCi(github, repo, now)).toContain('Dispatched');
  expect(github.rest.git.getRef).toHaveBeenCalledWith({ ...repo, ref: 'heads/main' });
  for (const event of ['workflow_dispatch', 'push']) {
    expect(github.rest.actions.listWorkflowRuns).toHaveBeenCalledWith({ ...repo, workflow_id: 'ci.yml', branch: 'main', event, per_page: 1 });
  }
  expect(github.rest.actions.createWorkflowDispatch).toHaveBeenCalledExactlyOnceWith({ ...repo, workflow_id: 'ci.yml', ref: 'main' });
});

it('does not dispatch on idle ticks or when GitHub cannot supply the run history', async () => {
  const github = client([run({ head_sha: 'new' })]);
  expect(await scheduleMainCi(github, repo, now)).toContain('not changed');
  expect(github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  github.rest.actions.listWorkflowRuns.mockRejectedValue(new Error('API unavailable'));
  await expect(scheduleMainCi(github, repo, now)).rejects.toThrow('API unavailable');
  expect(github.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
});

describe('waiting for the batch window', () => {
  it('reopens a recent batch one second after its 15-minute window and polls a running one each minute', () => {
    expect(mainCiRetryAt([run({ run_started_at: '2026-10-27T12:20:00Z' })], now)).toBe(Date.parse('2026-10-27T12:35:01Z'));
    expect(mainCiRetryAt([run({ status: 'in_progress' })], now)).toBe(now + 60 * 1000);
    expect(mainCiRetryAt([run()], now)).toBeNull();
    expect(mainCiRetryAt([], now)).toBeNull();
  });

  it('waits out the window after a push, then dispatches once', async () => {
    let clock = now;
    const github = client([run({ run_started_at: '2026-10-27T12:20:00Z', created_at: '2026-10-27T12:20:00Z' })]);
    const sleeps = [];
    const message = await waitAndScheduleMainCi(github, repo, { now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } });
    expect(message).toContain('Dispatched');
    expect(sleeps).toEqual([Date.parse('2026-10-27T12:35:01Z') - now]);
    expect(github.rest.actions.createWorkflowDispatch).toHaveBeenCalledOnce();
  });

  it('exits at once on an unchanged main and gives up rather than outlive the job', async () => {
    const idle = client([run({ head_sha: 'new' })]);
    const sleep = vi.fn();
    expect(await waitAndScheduleMainCi(idle, repo, { now: () => now, sleep })).toContain('not changed');
    expect(sleep).not.toHaveBeenCalled();
    let clock = now;
    const stuck = client([run({ status: 'in_progress' })]);
    const message = await waitAndScheduleMainCi(stuck, repo, { now: () => clock, sleep: async ms => { clock += ms; }, maxWaitMs: 5 * 60 * 1000 });
    expect(message).toContain('Gave up waiting');
    expect(stuck.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });
});

