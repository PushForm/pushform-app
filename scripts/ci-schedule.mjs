// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/** Main's automatic CI batches. PRs keep their own immediate checks in ci.yml. */
const INTERVAL_MS = 15 * 60 * 1000;
const WORKFLOW = 'ci.yml';

export function mainCiDecision(sha, runs, now = Date.now()) {
  const mainRuns = runs.filter(run => run.head_branch === 'main' && ['push', 'workflow_dispatch'].includes(run.event));
  if (mainRuns.some(run => run.status !== 'completed')) return 'Main CI is already queued or running.';
  // Include the legacy push trigger during the transition and manual dispatches/reruns in the cooldown.
  // Use the actual run start as well as creation time so delayed starts do not shorten the interval.
  if (mainRuns.some(run => {
    const started = Math.max(Date.parse(run.created_at), Date.parse(run.run_started_at ?? run.created_at));
    if (!Number.isFinite(started)) throw new Error('Cannot determine the previous main CI start time.');
    return now - started < INTERVAL_MS;
  })) return 'The previous main CI started less than 15 minutes ago.';
  const latest = mainRuns.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  // A failed commit stays failed. A new commit or an explicit rerun retries it, not every timer tick.
  if (latest?.head_sha === sha) return 'Main has not changed since its last CI run.';
  return null;
}

export async function scheduleMainCi(github, repo, now = Date.now()) {
  const { data: ref } = await github.rest.git.getRef({ ...repo, ref: 'heads/main' });
  const runs = [];
  // The lightweight scheduler has its own workflow, so idle ticks never hide the last real CI run.
  // Separate event filters exclude pull-request merge checks, even when their base is main.
  for (const event of ['workflow_dispatch', 'push']) {
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...repo, workflow_id: WORKFLOW, branch: 'main', event, per_page: 1,
    });
    runs.push(...data.workflow_runs);
  }
  const reason = mainCiDecision(ref.object.sha, runs, now);
  if (reason) return reason;
  // Dispatch by branch: if a commit arrives during the check, include it in this batch. Every job in
  // ci.yml checks out the resulting event SHA, so test and both deployments use the same commit.
  await github.rest.actions.createWorkflowDispatch({ ...repo, workflow_id: WORKFLOW, ref: 'main' });
  return 'Dispatched CI for the latest main commit.';
}
