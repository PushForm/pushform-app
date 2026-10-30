// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { EXPORT_LIMIT_BYTES, runAccountJobs, uniqueZipPath, type AccountJobsDeps } from './accountJobs';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const NOW = new Date('2026-10-27T12:00:00Z');

/** Fakes for the sweeper's dependencies, recording every call; `rpcs` answers each function by name. */
function fakes(rpcs: Record<string, (params: Record<string, unknown>) => unknown>, options: { mail?: boolean } = {}) {
  const calls: string[] = [], mails: { to: string; subject: string; text: string }[] = [];
  const objects = new Map<string, Uint8Array>([['cloud-files/a/plan', bytes('plan')], ['cloud-files/a/door', bytes('door')]]);
  const deps: AccountJobsDeps = {
    async rpc<T>(fn: string, params: Record<string, unknown>): Promise<T> {
      calls.push(`rpc ${fn} ${JSON.stringify(params)}`);
      const answer = rpcs[fn];
      return (answer ? answer(params) : null) as T;
    },
    storage: {
      async download(bucket, path) { const data = objects.get(`${bucket}/${path}`); if (!data) throw new Error(`missing ${path}`); return data; },
      async upload(bucket, path, data) { calls.push(`upload ${bucket}/${path}`); objects.set(`${bucket}/${path}`, data); },
      async remove(bucket, paths) { calls.push(`remove ${bucket} ${paths.join(',')}`); for (const p of paths) objects.delete(`${bucket}/${p}`); },
      async signedUrl(bucket, path, seconds) { return `https://storage.test/${bucket}/${path}?expires=${seconds}`; },
    },
    async deleteUser(id) { calls.push(`deleteUser ${id}`); },
    mail: options.mail === false ? null : { async send(message) { mails.push(message); return { id: 'm1' }; } },
    zip: files => bytes(Object.keys(files).join('|')),
    now: () => NOW,
    log: () => undefined,
  };
  return { deps, calls, mails, objects };
}

it('deletes a due account: its objects by bucket, then its rows, then its auth user', async () => {
  const { deps, calls } = fakes({
    cloud_due_account_deletions: () => ['u1'],
    cloud_account_objects: () => [{ bucket: 'cloud-files', path: 'a/plan' }, { bucket: 'fr-attachments', path: 'r/x.png' }, { bucket: 'cloud-files', path: 'a/door' }],
    cloud_claim_exports: () => [], cloud_expired_exports: () => [],
  });
  expect(await runAccountJobs(deps)).toEqual({ deleted: 1, exported: 0, expired: 0, uploadsPurged: 0, inboxPurged: 0, trashPurged: 0, failed: 0 });
  expect(calls.filter(c => !c.startsWith('rpc cloud_due') && !c.includes('claim') && !c.includes('expired') && !c.includes('inbox') && !c.includes('pending') && !c.includes('trash'))).toEqual([
    'rpc cloud_account_objects {"p_owner":"u1"}', 'remove cloud-files a/plan,a/door', 'remove fr-attachments r/x.png',
    'rpc cloud_purge_account {"p_owner":"u1"}', 'deleteUser u1',
  ]);
});

it('records a failed deletion and still runs the other jobs', async () => {
  const { deps, calls } = fakes({
    cloud_due_account_deletions: () => ['u1'], cloud_account_objects: () => [],
    cloud_purge_account: () => { throw new Error('purge broke'); },
    cloud_claim_exports: () => [], cloud_expired_exports: () => [{ id: 'e1', object_path: 'u2/e1.zip' }],
  });
  expect(await runAccountJobs(deps)).toEqual({ deleted: 0, exported: 0, expired: 1, uploadsPurged: 0, inboxPurged: 0, trashPurged: 0, failed: 1 });
  expect(calls).toContain('rpc cloud_account_deletion_failed {"p_owner":"u1","p_error":"purge broke"}');
  expect(calls).not.toContain('deleteUser u1');
  expect(calls).toContain('remove cloud-exports u2/e1.zip');
  expect(calls).toContain('rpc cloud_expire_export {"p_export":"e1"}');
});

it('zips each current revision under its project and folders, uploads it privately and emails a 24-hour link', async () => {
  const plan = bytes('plan'), door = bytes('door');
  const { deps, calls, mails, objects } = fakes({
    cloud_due_account_deletions: () => [], cloud_expired_exports: () => [],
    cloud_claim_exports: () => [{ id: 'e1', owner_id: 'u1', email: 'ada@example.com', attempts: 1 }],
    cloud_export_files: () => [
      { path: 'Kitchen/Plan.pfl', blob_path: 'a/plan', size_bytes: plan.byteLength, sha256: sha(plan) },
      { path: 'Kitchen/plan.pfl', blob_path: 'a/door', size_bytes: door.byteLength, sha256: sha(door) },
    ],
  });
  expect(await runAccountJobs(deps)).toEqual({ deleted: 0, exported: 1, expired: 0, uploadsPurged: 0, inboxPurged: 0, trashPurged: 0, failed: 0 });
  expect(new TextDecoder().decode(objects.get('cloud-exports/u1/e1.zip'))).toBe('Kitchen/Plan.pfl|Kitchen/plan (2).pfl');
  expect(mails).toHaveLength(1);
  expect(mails[0]).toMatchObject({ to: 'ada@example.com', subject: 'Your PushForm files are ready to download' });
  expect(mails[0]!.text).toContain('https://storage.test/cloud-exports/u1/e1.zip?expires=86400');
  expect(mails[0]!.text).toContain('2 documents');
  expect(mails[0]!.text).toContain('2026-10-28 12:00 UTC');
  const finish = calls.find(c => c.startsWith('rpc cloud_finish_export'))!;
  expect(JSON.parse(finish.slice('rpc cloud_finish_export '.length))).toMatchObject({ p_export: 'e1', p_object_path: 'u1/e1.zip',
    p_document_count: 2, p_expires_at: '2026-10-28T12:00:00.000Z' });
});

it('fails an export with a reason: no documents, too large, no mail, a corrupt file, or a mail error', async () => {
  const plan = bytes('plan');
  const base = { cloud_due_account_deletions: () => [], cloud_expired_exports: () => [],
    cloud_claim_exports: () => [{ id: 'e1', owner_id: 'u1', email: 'ada@example.com', attempts: 1 }] };
  const failure = (calls: string[]): string => JSON.parse(calls.find(c => c.startsWith('rpc cloud_fail_export'))!.slice('rpc cloud_fail_export '.length)).p_error;

  let run = fakes({ ...base, cloud_export_files: () => [] });
  await runAccountJobs(run.deps);
  expect(failure(run.calls)).toBe('You have no saved documents to export.');

  run = fakes({ ...base, cloud_export_files: () => [{ path: 'P/Big.pf', blob_path: 'a/plan', size_bytes: EXPORT_LIMIT_BYTES + 1, sha256: sha(plan) }] });
  await runAccountJobs(run.deps);
  expect(failure(run.calls)).toMatch(/more than the 200 MB one export can hold/);

  run = fakes({ ...base, cloud_export_files: () => [{ path: 'P/Plan.pf', blob_path: 'a/plan', size_bytes: 4, sha256: sha(plan) }] }, { mail: false });
  await runAccountJobs(run.deps);
  expect(failure(run.calls)).toBe('Exports are not available right now. Try again later.');

  run = fakes({ ...base, cloud_export_files: () => [{ path: 'P/Plan.pf', blob_path: 'a/plan', size_bytes: 4, sha256: '0'.repeat(64) }] });
  await runAccountJobs(run.deps);
  expect(failure(run.calls)).toMatch(/does not match its recorded size or checksum/);
  expect(run.calls.some(c => c.startsWith('upload'))).toBe(false);

  run = fakes({ ...base, cloud_export_files: () => [{ path: 'P/Plan.pf', blob_path: 'a/plan', size_bytes: 4, sha256: sha(plan) }] });
  run.deps.mail = { async send() { throw new Error('Resend 500'); } };
  expect(await runAccountJobs(run.deps)).toMatchObject({ exported: 0, failed: 1 });
  expect(failure(run.calls)).toMatch(/Resend 500/);
  expect(run.calls).toContain('remove cloud-exports u1/e1.zip');
  expect(run.objects.has('cloud-exports/u1/e1.zip')).toBe(false);

  run = fakes({ ...base, cloud_claim_exports: () => [{ id: 'e1', owner_id: 'u1', email: 'ada@example.com', attempts: 4 }] });
  await runAccountJobs(run.deps);
  expect(failure(run.calls)).toBe('The export could not be completed. Try again later.');
});

it('purges due inbox messages: objects first, then the rows, keeping a message whose objects could not be removed', async () => {
  const { deps, calls } = fakes({
    cloud_due_account_deletions: () => [], cloud_claim_exports: () => [], cloud_expired_exports: () => [],
    admin_inbox_due: () => [{ id: 'm1', paths: ['m1/1', 'm1/2'] }, { id: 'm2', paths: [] }, { id: 'm3', paths: ['m3/1'] }],
    admin_inbox_purge: params => (params['p_ids'] as string[]).length,
  });
  const remove = deps.storage.remove;
  deps.storage.remove = async (bucket, paths) => { if (paths.includes('m3/1')) throw new Error('storage 500'); await remove(bucket, paths); };
  expect(await runAccountJobs(deps)).toEqual({ deleted: 0, exported: 0, expired: 0, uploadsPurged: 0, inboxPurged: 2, trashPurged: 0, failed: 1 });
  expect(calls.filter(c => c.includes('inbox'))).toEqual([
    'rpc admin_inbox_due {"p_limit":50}', 'remove admin-inbox m1/1,m1/2', 'rpc admin_inbox_purge {"p_ids":["m1","m2"]}',
  ]);
});

it('removes abandoned uploads: the object through Storage, then the row, and keeps a revision whose object could not be removed', async () => {
  const { deps, calls } = fakes({
    cloud_due_account_deletions: () => [], cloud_claim_exports: () => [], cloud_expired_exports: () => [], admin_inbox_due: () => [],
    cloud_stale_pending_revisions: () => [{ id: 'r1', blob_path: 'u1/r1' }, { id: 'r2', blob_path: 'u1/r2' }, { id: 'r3', blob_path: 'u1/r3' }],
    cloud_purge_pending_revision: params => params['p_revision'] !== 'r2',
  });
  const remove = deps.storage.remove;
  deps.storage.remove = async (bucket, paths) => { if (paths.includes('u1/r3')) throw new Error('storage 500'); await remove(bucket, paths); };
  expect(await runAccountJobs(deps)).toEqual({ deleted: 0, exported: 0, expired: 0, uploadsPurged: 1, inboxPurged: 0, trashPurged: 0, failed: 1 });
  expect(calls.filter(c => c.includes('pending') || c.startsWith('remove cloud-files'))).toEqual([
    'rpc cloud_stale_pending_revisions {"p_limit":50}',
    'remove cloud-files u1/r1', 'rpc cloud_purge_pending_revision {"p_revision":"r1"}',
    'remove cloud-files u1/r2', 'rpc cloud_purge_pending_revision {"p_revision":"r2"}',
  ]);
});

it('purges trashed documents that are due: every revision object and the thumbnail through Storage, then the rows, then empty containers', async () => {
  const { deps, calls } = fakes({
    cloud_due_account_deletions: () => [], cloud_claim_exports: () => [], cloud_expired_exports: () => [], admin_inbox_due: () => [],
    cloud_stale_pending_revisions: () => [],
    cloud_due_trash_documents: () => [{ id: 'd1', blob_paths: ['a/d1/r1.pf', 'a/d1/r2.pf'], thumbnail_path: 'a/d1.jpg' }, { id: 'd2', blob_paths: ['a/d2/r1.pf'], thumbnail_path: 'a/d2.jpg' }],
    cloud_purge_document: params => params['p_document'] === 'd1',
    cloud_purge_trashed_containers: () => 3,
  });
  const remove = deps.storage.remove;
  deps.storage.remove = async (bucket, paths) => { if (paths.includes('a/d2/r1.pf')) throw new Error('storage 500'); await remove(bucket, paths); };
  expect(await runAccountJobs(deps)).toEqual({ deleted: 0, exported: 0, expired: 0, uploadsPurged: 0, inboxPurged: 0, trashPurged: 4, failed: 1 });
  expect(calls.filter(c => c.includes('trash') || c.includes('purge_document') || c.startsWith('remove cloud-'))).toEqual([
    'rpc cloud_due_trash_documents {"p_limit":50}',
    'remove cloud-files a/d1/r1.pf,a/d1/r2.pf', 'remove cloud-thumbnails a/d1.jpg', 'rpc cloud_purge_document {"p_document":"d1"}',
    // d2's object removal failed, so nothing of it is purged; the containers still run.
    'rpc cloud_purge_trashed_containers {}',
  ]);
});

it('keeps zip paths unique without regard to case, before the extension', () => {
  const taken = new Set<string>();
  expect(['A/Plan.pf', 'A/plan.pf', 'A/PLAN.pf', 'A/Notes', 'A/Notes'].map(p => uniqueZipPath(p, taken)))
    .toEqual(['A/Plan.pf', 'A/plan (2).pf', 'A/PLAN (3).pf', 'A/Notes', 'A/Notes (2)']);
});
