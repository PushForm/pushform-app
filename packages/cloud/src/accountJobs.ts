// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// The cloud-sweeper's work: delete accounts whose 48 hours have run out, build requested
// exports and email their links, and remove exports whose links have expired. It also removes abandoned uploads
// and purges the admin console's shared inboxes. Runs in a Deno Edge Function with the
// service role; everything it touches comes in through `AccountJobsDeps`, so it is tested with fakes. Keep this file
// free of Node and browser imports.
import type { RpcArgs, RpcName } from './rpc';

/** The private bucket the admin console's shared inboxes store attachments in; account deletion removes a user's copies. */
const INBOX_BUCKET = 'admin-inbox';

export const EXPORT_BUCKET = 'cloud-exports';
const FILES_BUCKET = 'cloud-files';
/** An export link stays valid for 24 hours. */
export const EXPORT_LINK_SECONDS = 24 * 60 * 60;
/** Exports are built in memory; past this many bytes of documents the export fails with a message instead. */
export const EXPORT_LIMIT_BYTES = 200 * 1024 * 1024;
/** A claimed export is given up after this many attempts. */
const EXPORT_ATTEMPTS = 3;

export interface AccountJobsDeps {
  /** Service-role RPC: calls `public.<fn>` with named parameters, checked against its contract, and returns its result rows or value. */
  rpc<F extends RpcName>(fn: F, params: RpcArgs<F>): Promise<unknown>;
  storage: {
    download(bucket: string, path: string): Promise<Uint8Array>;
    upload(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void>;
    remove(bucket: string, paths: string[]): Promise<void>;
    signedUrl(bucket: string, path: string, seconds: number): Promise<string>;
  };
  /** Deletes the auth user; resolves when it is already gone. */
  deleteUser(id: string): Promise<void>;
  mail: { send(message: { to: string; subject: string; text: string; html: string }): Promise<unknown> } | null;
  zip(files: Record<string, Uint8Array>): Uint8Array;
  now(): Date;
  log(message: string): void;
}

export interface AccountJobsResult { deleted: number; exported: number; expired: number; uploadsPurged: number; inboxPurged: number; trashPurged: number; failed: number }
const THUMBNAILS_BUCKET = 'cloud-thumbnails';

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** `path` made unique among `taken`: "Plan.pf" then "Plan (2).pf", keeping the extension. */
export function uniqueZipPath(path: string, taken: Set<string>): string {
  let candidate = path, n = 2;
  const dot = path.lastIndexOf('.'), slash = path.lastIndexOf('/');
  const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
  while (taken.has(candidate.toLowerCase())) candidate = `${stem} (${n++})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

async function removeAll(deps: AccountJobsDeps, bucket: string, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 100) await deps.storage.remove(bucket, paths.slice(i, i + 100));
}

/** Objects first, then rows, then the auth user, whose deletion removes the mark. Failures retry next run. */
async function deleteAccounts(deps: AccountJobsDeps, result: AccountJobsResult): Promise<void> {
  const due = (await deps.rpc('cloud_due_account_deletions', { p_limit: 10 })) as string[];
  for (const owner of due) {
    try {
      const objects = (await deps.rpc('cloud_account_objects', { p_owner: owner })) as { bucket: string; path: string }[];
      const byBucket = new Map<string, string[]>();
      for (const { bucket, path } of objects) byBucket.set(bucket, [...byBucket.get(bucket) ?? [], path]);
      for (const [bucket, paths] of byBucket) await removeAll(deps, bucket, paths);
      await deps.rpc('cloud_purge_account', { p_owner: owner });
      await deps.deleteUser(owner);
      result.deleted++;
      deps.log(`deleted account ${owner} (${objects.length} objects)`);
    } catch (error) {
      result.failed++;
      deps.log(`account ${owner} deletion failed: ${errorText(error)}`);
      await deps.rpc('cloud_account_deletion_failed', { p_owner: owner, p_error: errorText(error) }).catch(() => undefined);
    }
  }
}

interface ExportFile { path: string; blob_path: string; size_bytes: number; sha256: string }

function exportEmail(link: string, documents: number, expires: Date): { subject: string; text: string; html: string } {
  const when = `${expires.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const count = `${documents} document${documents === 1 ? '' : 's'}`;
  const text = `Your PushForm export is ready: ${count} as native .pf and .pfl files in one zip.\n\n` +
    `Download it here (the link works until ${when}):\n${link}\n\n` +
    'If you did not ask for this export, you can ignore this email; nobody else can use the link unless you share it.\n';
  const escaped = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const html = `<p>Your PushForm export is ready: ${count} as native .pf and .pfl files in one zip.</p>` +
    `<p><a href="${escaped}">Download your files</a> (the link works until ${when}).</p>` +
    '<p>If you did not ask for this export, you can ignore this email; nobody else can use the link unless you share it.</p>';
  return { subject: 'Your PushForm files are ready to download', text, html };
}

/** One zip of each saved document's current revision under project/folders/name, emailed as a 24-hour link. */
async function buildExports(deps: AccountJobsDeps, result: AccountJobsResult): Promise<void> {
  const claimed = (await deps.rpc('cloud_claim_exports', { p_limit: 2 })) as { id: string; owner_id: string; email: string | null; attempts: number }[];
  for (const job of claimed) {
    const fail = async (message: string): Promise<void> => {
      result.failed++;
      deps.log(`export ${job.id} failed: ${message}`);
      await deps.rpc('cloud_fail_export', { p_export: job.id, p_error: message });
    };
    let uploaded: string | null = null;
    try {
      if (job.attempts > EXPORT_ATTEMPTS) { await fail('The export could not be completed. Try again later.'); continue; }
      if (!job.email) { await fail('Your account has no email address to send the link to.'); continue; }
      if (!deps.mail) { await fail('Exports are not available right now. Try again later.'); continue; }
      const files = (await deps.rpc('cloud_export_files', { p_export: job.id })) as ExportFile[];
      if (!files.length) { await fail('You have no saved documents to export.'); continue; }
      const total = files.reduce((sum, file) => sum + Number(file.size_bytes), 0);
      if (total > EXPORT_LIMIT_BYTES) {
        await fail(`Your documents total ${Math.ceil(total / 1048576)} MB, more than the ${EXPORT_LIMIT_BYTES / 1048576} MB one export can hold. Contact support@pushform.io for a copy.`);
        continue;
      }
      const entries: Record<string, Uint8Array> = {}, taken = new Set<string>();
      for (const file of files) {
        const bytes = await deps.storage.download(FILES_BUCKET, file.blob_path);
        if (bytes.byteLength !== Number(file.size_bytes) || await sha256Hex(bytes) !== file.sha256)
          throw new Error(`stored file ${file.blob_path} does not match its recorded size or checksum`);
        entries[uniqueZipPath(file.path, taken)] = bytes;
      }
      const zip = deps.zip(entries);
      const path = `${job.owner_id}/${job.id}.zip`;
      await deps.storage.upload(EXPORT_BUCKET, path, zip, 'application/zip');
      uploaded = path;
      const expires = new Date(deps.now().getTime() + EXPORT_LINK_SECONDS * 1000);
      const link = await deps.storage.signedUrl(EXPORT_BUCKET, path, EXPORT_LINK_SECONDS);
      await deps.mail.send({ to: job.email, ...exportEmail(link, files.length, expires) });
      await deps.rpc('cloud_finish_export', { p_export: job.id, p_object_path: path, p_document_count: files.length,
        p_size_bytes: zip.byteLength, p_expires_at: expires.toISOString() });
      result.exported++;
      deps.log(`export ${job.id} ready (${files.length} documents, ${zip.byteLength} bytes)`);
    } catch (error) {
      if (uploaded) await deps.storage.remove(EXPORT_BUCKET, [uploaded]).catch(() => undefined);
      await fail(`The export could not be completed (${errorText(error)}). Try again later.`).catch(() => undefined);
    }
  }
}

/** Zips whose 24 hours have passed are removed and their exports marked expired. */
async function expireExports(deps: AccountJobsDeps, result: AccountJobsResult): Promise<void> {
  const expired = (await deps.rpc('cloud_expired_exports', { p_limit: 50 })) as { id: string; object_path: string }[];
  for (const { id, object_path } of expired) {
    try {
      await deps.storage.remove(EXPORT_BUCKET, [object_path]);
      await deps.rpc('cloud_expire_export', { p_export: id });
      result.expired++;
    } catch (error) {
      result.failed++;
      deps.log(`export ${id} could not be expired: ${errorText(error)}`);
    }
  }
}

/** Inbox messages deleted early or older than 90 days; attachment objects first, then the rows. */
/** Pending revisions older than 24 hours: the object through Storage first, then the row (and an empty document). */
async function purgeStaleUploads(deps: AccountJobsDeps, result: AccountJobsResult): Promise<void> {
  const stale = ((await deps.rpc('cloud_stale_pending_revisions', { p_limit: 50 })) ?? []) as { id: string; blob_path: string }[];
  for (const { id, blob_path } of stale) {
    try {
      await deps.storage.remove(FILES_BUCKET, [blob_path]);
      if (await deps.rpc('cloud_purge_pending_revision', { p_revision: id })) result.uploadsPurged++;
    } catch (error) {
      result.failed++;
      deps.log(`pending revision ${id} could not be purged: ${errorText(error)}`);
    }
  }
}

/**
 * Documents whose Trash time is up or that were deleted permanently: every revision object and the thumbnail
 * through Storage first, then the rows; then folders and projects that hold nothing any more.
 */
async function purgeTrash(deps: AccountJobsDeps, result: AccountJobsResult): Promise<void> {
  const due = ((await deps.rpc('cloud_due_trash_documents', { p_limit: 50 })) ?? []) as { id: string; blob_paths: string[]; thumbnail_path: string }[];
  for (const { id, blob_paths, thumbnail_path } of due) {
    try {
      await removeAll(deps, FILES_BUCKET, blob_paths);
      await deps.storage.remove(THUMBNAILS_BUCKET, [thumbnail_path]);
      if (await deps.rpc('cloud_purge_document', { p_document: id })) result.trashPurged++;
    } catch (error) {
      result.failed++;
      deps.log(`trashed document ${id} could not be purged: ${errorText(error)}`);
    }
  }
  result.trashPurged += Number(await deps.rpc('cloud_purge_trashed_containers', {}) ?? 0);
}

async function purgeInbox(deps: AccountJobsDeps, result: AccountJobsResult): Promise<void> {
  const due = ((await deps.rpc('admin_inbox_due', { p_limit: 50 })) ?? []) as { id: string; paths: string[] }[];
  const cleared: string[] = [];
  for (const { id, paths } of due) {
    try {
      await removeAll(deps, INBOX_BUCKET, paths);
      cleared.push(id);
    } catch (error) {
      result.failed++;
      deps.log(`inbox message ${id} could not be purged: ${errorText(error)}`);
    }
  }
  if (cleared.length) result.inboxPurged += Number(await deps.rpc('admin_inbox_purge', { p_ids: cleared }) ?? 0);
}

/** One sweeper pass. Each part runs even when another fails. */
export async function runAccountJobs(deps: AccountJobsDeps): Promise<AccountJobsResult> {
  const result: AccountJobsResult = { deleted: 0, exported: 0, expired: 0, uploadsPurged: 0, inboxPurged: 0, trashPurged: 0, failed: 0 };
  for (const part of [deleteAccounts, buildExports, expireExports, purgeStaleUploads, purgeTrash, purgeInbox]) {
    try { await part(deps, result); } catch (error) { result.failed++; deps.log(`${part.name} failed: ${errorText(error)}`); }
  }
  return result;
}
