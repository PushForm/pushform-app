// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db.types';
import { callRpc, type RpcArgs } from './rpc';
import type { CloudSession } from './CloudSession';
import { cloudImportParams, type CloudImportRecord, type CloudImportReport } from './CloudImportLog';

export const CLOUD_FILE_LIMIT = 100 * 1024 * 1024;
/** Largest stored thumbnail; the bucket refuses anything bigger. */
export const CLOUD_THUMBNAIL_LIMIT = 512 * 1024;
/** How long a thumbnail's signed URL stays valid. */
export const CLOUD_THUMBNAIL_URL_SECONDS = 600;
const THUMBNAILS_BUCKET = 'cloud-thumbnails';
export const CLOUD_PAGE_SIZE = 50;
export interface CloudProject { id: string; name: string }
/** A folder inside a project; `parent_id` is null at the project root. */
export interface CloudFolder { id: string; project_id: string; parent_id: string | null; name: string }
export interface CloudFile {
  id: string; project_id: string; folder_id: string | null; name: string; kind: 'model' | 'layout'; current_revision_id: string;
  revision_number: number; size_bytes: number; updated_at: string;
  is_template?: boolean;
}
export interface CloudRevision {
  id: string; document_id: string; blob_path: string; size_bytes: number; sha256: string; number: number | null;
  status?: 'pending' | 'ready' | undefined;
}
export interface CloudSavedFile { file: CloudFile; revision: CloudRevision }
/** What can be renamed, moved, trashed and restored. */
export type CloudItemKind = 'project' | 'folder' | 'document';
/** An item in the Trash: trashed directly, with where it was and when it will be removed. */
export interface CloudTrashItem {
  kind: CloudItemKind; id: string; name: string; project_id: string; project_name: string; folder_id: string | null;
  trashed_at: string; purge_after: string;
  /** Documents only. */
  document_kind?: 'model' | 'layout'; is_template?: boolean;
}
export interface CloudSaveInput {
  projectId: string; name: string; kind: 'model' | 'layout'; bytes: Uint8Array;
  fileId?: string | undefined; parentRevisionId?: string | undefined;
  /** Folder for a new document; null or absent places it at the project root. Existing documents keep their folder. */
  folderId?: string | null | undefined;
  /**
   * A new document's first-save key (a UUID), kept by the caller until the save is recorded. Retrying with the same
   * key continues the document it created instead of creating another.
   */
  clientKey?: string | undefined;
  /** Save a separate Layout template; never convert an existing document. */
  isTemplate?: boolean;
}
export interface CloudFilesApi {
  listProjects(): Promise<CloudProject[]>;
  createProject(name: string): Promise<CloudProject>;
  /** All folders of a project. */
  listFolders(projectId: string): Promise<CloudFolder[]>;
  createFolder(projectId: string, parentId: string | null, name: string): Promise<CloudFolder>;
  /**
   * Files of a project, or of the whole library when `projectId` is empty. `folderId` restricts a
   * project listing to one folder (null = the project root); it is ignored while searching, which
   * spans the project.
   */
  listFiles(projectId: string, search?: string, offset?: number, folderId?: string | null, templatesOnly?: boolean): Promise<CloudFile[]>;
  open(fileId: string): Promise<CloudSavedFile & { bytes: Uint8Array }>;
  /** Current revision metadata of an owned document, without downloading its bytes. */
  head(fileId: string): Promise<CloudSavedFile>;
  /** An owned ready revision by id, current or not, with its verified bytes. */
  openRevision(revisionId: string): Promise<CloudSavedFile & { bytes: Uint8Array }>;
  save(input: CloudSaveInput): Promise<CloudSavedFile>;
  /** Store one import report for the signed-in account. */
  recordImport(report: CloudImportReport): Promise<CloudImportRecord>;
  /** Replace an owned document's thumbnail with a JPEG. */
  saveThumbnail?(fileId: string, jpeg: Uint8Array): Promise<void>;
  /** Short-lived URLs of the thumbnails these documents have; documents without one are left out. */
  thumbnailUrls?(fileIds: readonly string[]): Promise<Map<string, string>>;
  /** Rename a project, folder or file; a file keeps its extension. */
  rename?(kind: CloudItemKind, id: string, name: string): Promise<void>;
  /** Move a file to a folder (null: the root) of any owned project, keeping its ids. */
  moveFile?(fileId: string, projectId: string, folderId: string | null): Promise<void>;
  /** Move a folder under another folder (null: the root) of its project. */
  moveFolder?(folderId: string, parentId: string | null): Promise<void>;
  /** Move an item and its contents to the Trash. */
  trash?(kind: CloudItemKind, id: string): Promise<void>;
  /** Restore an item and everything trashed with it. */
  restore?(kind: CloudItemKind, id: string): Promise<void>;
  /** Delete a trashed item permanently. */
  deleteForever?(kind: CloudItemKind, id: string): Promise<void>;
  /** The account's Trash. */
  listTrash?(): Promise<CloudTrashItem[]>;
  /** Which of these files are gone or in the Trash, so Recently opened can drop them. */
  trashedFiles?(fileIds: readonly string[]): Promise<Set<string>>;
}
export class CloudFilesError extends Error {
  constructor(readonly code: 'auth' | 'unavailable' | 'conflict' | 'invalid' | 'network' | 'forbidden' | 'not_found' | 'trashed', message: string) {
    super(message); this.name = 'CloudFilesError';
  }
}
function failure(error: unknown): CloudFilesError {
  if (error instanceof CloudFilesError) return error;
  const e = error as { code?: string; message?: string; status?: number; statusCode?: string | number } | null;
  const status = Number(e?.status ?? e?.statusCode);
  if (status === 413) return new CloudFilesError('invalid', 'This file exceeds the cloud storage size limit. Save a local copy instead.');
  if (e?.message?.includes('cloud_conflict')) return new CloudFilesError('conflict', 'This file has a newer cloud revision. Save a new cloud copy to keep your changes.');
  if (e?.code === '23505') return new CloudFilesError('invalid', 'A project or folder with that name already exists. Choose another name.');
  if (e?.code === '42P01' || e?.code === 'PGRST202' || e?.code === 'PGRST205')
    return new CloudFilesError('unavailable', 'Cloud file storage is not set up for this installation yet.');
  if (status === 401 || e?.message?.includes('cloud_auth')) return new CloudFilesError('auth', 'Sign in again to use cloud files.');
  if (e?.message?.includes('cloud_not_found')) return new CloudFilesError('not_found', 'This cloud file is no longer available. Refresh the list and try again.');
  if (e?.message?.includes('cloud_trashed_parent')) return new CloudFilesError('invalid', 'Its project is in the Trash. Restore the project first.');
  if (e?.message?.includes('cloud_not_trashed')) return new CloudFilesError('invalid', 'This item is not in the Trash. Refresh the list and try again.');
  if (e?.message?.includes('cloud_trashed')) return new CloudFilesError('trashed', 'This file is in the Trash. Restore it from Home to open or save it.');
  if (e?.code === '42501' || status === 403) return new CloudFilesError('forbidden', 'You do not have access to this cloud file or project.');
  if (e?.code === '23514' || e?.message?.includes('cloud_invalid')) return new CloudFilesError('invalid', 'Check the project, file name, and file size, then try again.');
  return new CloudFilesError('network', 'Could not complete the cloud request. Check your connection and try again.');
}
function hasControl(value: string): boolean { return [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127); }
export function cloudFileName(value: string, kind: 'model' | 'layout'): string {
  const extension = kind === 'model' ? '.pf' : '.pfl';
  const name = value.trim();
  const result = name.toLowerCase().endsWith(extension) ? name.slice(0, -extension.length) + extension : name + extension;
  if (!name || result.length > 200 || hasControl(result) || /[/\\]/.test(result)) throw new CloudFilesError('invalid', 'Enter a file name without slashes or control characters (up to 200 characters).');
  return result;
}
export async function cloudChecksum(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

/** Shared auth client; all authorization and revision invariants are also enforced by SQL/RLS. */
export class CloudFiles implements CloudFilesApi {
  private epoch = 0;
  private owner: string | null;
  private readonly unsubscribe: () => void;
  constructor(private readonly client: SupabaseClient<Database>, private readonly session: CloudSession) {
    this.owner = session.getSnapshot().user?.id ?? null;
    this.unsubscribe = session.subscribe(() => {
      const user = session.getSnapshot().status === 'signedIn' ? session.getSnapshot().user?.id ?? null : null;
      if (user !== this.owner) { this.owner = user; this.epoch++; }
    });
  }
  private guard(): () => void {
    const owner = this.owner, epoch = this.epoch;
    const check = (): void => {
      if (!owner || owner !== this.owner || epoch !== this.epoch || this.session.getSnapshot().status !== 'signedIn')
        throw new CloudFilesError('auth', 'Your account session changed. Sign in and try again.');
    };
    check(); return check;
  }
  /** True once a listing failed because the database has no trash columns yet (the migration not applied there). */
  private noTrashColumns = false;
  /**
   * Runs a listing that leaves out trashed rows; a database without the trash columns (error 42703) lists everything,
   * as before the Trash existed, and is not asked again.
   */
  private async live<T>(query: (filtered: boolean) => PromiseLike<{ data: T | null; error: { code?: string } | null }>): Promise<{ data: T | null; error: { code?: string } | null }> {
    if (!this.noTrashColumns) {
      const result = await query(true);
      if (result.error?.code !== '42703') return result;
      this.noTrashColumns = true;
    }
    return query(false);
  }
  async listProjects(): Promise<CloudProject[]> {
    const check = this.guard();
    try {
      const { data, error } = await this.live<CloudProject[]>(filtered => {
        const query = this.client.from('cloud_projects').select('id,name');
        return (filtered ? query.is('trashed_at', null) : query).order('name').order('id').limit(1000).returns<CloudProject[]>();
      });
      check(); if (error) throw error; return data ?? [];
    } catch (error) { throw failure(error); }
  }
  async createProject(value: string): Promise<CloudProject> {
    const check = this.guard(), name = value.trim();
    if (!name || name.length > 100 || hasControl(name)) throw new CloudFilesError('invalid', 'Enter a project name up to 100 characters.');
    try {
      const { data, error } = await callRpc(this.client, 'cloud_create_project', { p_name: name });
      check(); if (error) throw error; return data as CloudProject;
    } catch (error) { throw failure(error); }
  }
  async listFolders(projectId: string): Promise<CloudFolder[]> {
    const check = this.guard();
    try {
      const { data, error } = await this.live<CloudFolder[]>(filtered => {
        const query = this.client.from('cloud_folders').select('id,project_id,parent_id,name').eq('project_id', projectId);
        return (filtered ? query.is('trashed_at', null) : query).order('name').order('id').limit(1000).returns<CloudFolder[]>();
      });
      check(); if (error) throw error; return data ?? [];
    } catch (error) { throw failure(error); }
  }
  async createFolder(projectId: string, parentId: string | null, value: string): Promise<CloudFolder> {
    const check = this.guard(), name = value.trim();
    if (!name || name.length > 100 || hasControl(name) || /[/\\]/.test(name))
      throw new CloudFilesError('invalid', 'Enter a folder name without slashes or control characters (up to 100 characters).');
    try {
      const { data, error } = await callRpc(this.client, 'cloud_create_folder', { p_project: projectId, p_parent: parentId, p_name: name });
      check(); if (error) throw error; return data as CloudFolder;
    } catch (error) {
      if ((error as { code?: string } | null)?.code === '23505') throw new CloudFilesError('invalid', 'A folder with that name already exists here. Choose another name.');
      throw failure(error);
    }
  }
  async listFiles(projectId: string, search = '', offset = 0, folderId?: string | null, templatesOnly = false): Promise<CloudFile[]> {
    const check = this.guard();
    try {
      const { data, error } = await this.live<CloudFile[]>(filtered => {
        // The additive template marker may not be deployed yet; ordinary browsing still works without it.
        let query = this.client.from('cloud_documents').select('*')
          .not('current_revision_id', 'is', null);
        if (filtered) query = query.is('trashed_at', null);
        if (templatesOnly) query = query.eq('is_template', true);
        // An empty project selects the account's library; RLS still enforces ownership.
        if (projectId) query = query.eq('project_id', projectId);
        if (search.trim()) query = query.ilike('name', `%${search.trim().replace(/[\\%_]/g, '\\$&')}%`);
        else if (projectId && folderId !== undefined) query = folderId === null ? query.is('folder_id', null) : query.eq('folder_id', folderId);
        return query.order('updated_at', { ascending: false }).order('id').range(offset, offset + CLOUD_PAGE_SIZE - 1).returns<CloudFile[]>();
      });
      check(); if (error) throw error; return data ?? [];
    } catch (error) { throw failure(error); }
  }
  async open(fileId: string): Promise<CloudSavedFile & { bytes: Uint8Array }> {
    return this.download('cloud_open_file', { p_document: fileId });
  }
  async head(fileId: string): Promise<CloudSavedFile> {
    const check = this.guard();
    try {
      const { data, error } = await callRpc(this.client, 'cloud_open_file', { p_document: fileId });
      check(); if (error) throw error;
      return data as CloudSavedFile;
    } catch (error) { throw failure(error); }
  }
  async openRevision(revisionId: string): Promise<CloudSavedFile & { bytes: Uint8Array }> {
    return this.download('cloud_open_revision', { p_revision: revisionId });
  }
  private async download<F extends 'cloud_open_file' | 'cloud_open_revision'>(fn: F, params: RpcArgs<F>): Promise<CloudSavedFile & { bytes: Uint8Array }> {
    const check = this.guard();
    try {
      const { data, error } = await callRpc(this.client, fn, params);
      check(); if (error) throw error;
      const saved = data as CloudSavedFile;
      const { data: blob, error: downloadError } = await this.client.storage.from('cloud-files').download(saved.revision.blob_path);
      check(); if (downloadError) throw downloadError;
      if (!blob || blob.size > CLOUD_FILE_LIMIT || blob.size !== saved.revision.size_bytes)
        throw new CloudFilesError('invalid', 'The cloud file is incomplete or too large. Your open documents have not changed.');
      const bytes = new Uint8Array(await blob.arrayBuffer()); check();
      const sha256 = await cloudChecksum(bytes); check();
      if (sha256 !== saved.revision.sha256) throw new CloudFilesError('invalid', 'The cloud file failed its integrity check. Your open documents have not changed.');
      return { ...saved, bytes };
    } catch (error) { throw failure(error); }
  }
  async save(input: CloudSaveInput): Promise<CloudSavedFile> {
    const check = this.guard();
    if (input.isTemplate && (input.kind !== 'layout' || input.fileId || input.parentRevisionId))
      throw new CloudFilesError('invalid', 'Save a Layout template as a new cloud file.');
    if (!input.bytes.length || input.bytes.length > CLOUD_FILE_LIMIT) throw new CloudFilesError('invalid', 'Cloud files must be between 1 byte and 100 MiB. Save a local copy of larger files.');
    const bytes = new Uint8Array(input.bytes); // One immutable upload snapshot, even if the caller edits its buffer.
    const name = cloudFileName(input.name, input.kind);
    let ticket: CloudRevision | null = null;
    try {
      const sha256 = await cloudChecksum(bytes); check();
      const args = { p_project: input.projectId,
        p_name: name, p_kind: input.kind, p_size: bytes.length, p_sha256: sha256,
        p_document: input.fileId ?? null, p_parent: input.parentRevisionId ?? null, p_folder: input.folderId ?? null };
      const clientKey = input.fileId ? null : input.clientKey ?? null;
      let { data, error } = await callRpc(this.client, 'cloud_begin_save', { ...args, p_client_key: clientKey,
        ...(input.isTemplate ? { p_is_template: true } : {}) });
      // A database without the key argument yet (20261027132533 not applied) saves as before, without it.
      if (error?.code === 'PGRST202' && clientKey && !input.isTemplate) ({ data, error } = await callRpc(this.client, 'cloud_begin_save', args));
      check(); if (error) throw error;
      const begun = data as CloudRevision;
      // A retried first save whose earlier attempt committed these bytes: commit the head again (idempotent).
      if (begun.status === 'ready') return await this.commit(begun.id, check);
      ticket = begun;
      const uploaded = await this.client.storage.from('cloud-files').upload(ticket.blob_path, new Blob([bytes.buffer]),
        { contentType: 'application/octet-stream', upsert: false });
      check(); if (uploaded.error) throw uploaded.error;
      return await this.commit(ticket.id, check);
    } catch (error) {
      if (ticket) {
        // Only pending objects may be removed. A lost successful commit response cannot delete a ready revision.
        try {
          check(); const removed = await this.client.storage.from('cloud-files').remove([ticket.blob_path]);
          check(); if (!removed.error) await callRpc(this.client, 'cloud_abort_save', { p_revision: ticket.id });
        } catch { /* Keep failed cleanup records for operator maintenance; never mask the save failure. */ }
      }
      throw failure(error);
    }
  }
  private async commit(revision: string, check: () => void): Promise<CloudSavedFile> {
    let committed = await callRpc(this.client, 'cloud_commit_save', { p_revision: revision });
    check();
    if (committed.error && (committed.status === 0 || committed.status >= 500)) {
      // Retrying the same revision is idempotent, including a lost successful commit response.
      committed = await callRpc(this.client, 'cloud_commit_save', { p_revision: revision }); check();
    }
    if (committed.error) throw committed.error;
    return committed.data as CloudSavedFile;
  }
  async recordImport(report: CloudImportReport): Promise<CloudImportRecord> {
    const check = this.guard();
    const params = cloudImportParams(report);
    try {
      const { data, error } = await callRpc(this.client, 'cloud_record_import', params);
      check(); if (error) throw error; return data as CloudImportRecord;
    } catch (error) { throw failure(error); }
  }
  async saveThumbnail(fileId: string, jpeg: Uint8Array): Promise<void> {
    const check = this.guard();
    if (!jpeg.length || jpeg.length > CLOUD_THUMBNAIL_LIMIT) throw new CloudFilesError('invalid', 'The thumbnail is empty or too large.');
    try {
      const uploaded = await this.client.storage.from(THUMBNAILS_BUCKET).upload(`${this.owner}/${fileId}.jpg`,
        new Blob([new Uint8Array(jpeg).buffer], { type: 'image/jpeg' }), { contentType: 'image/jpeg', upsert: true, cacheControl: '60' });
      check(); if (uploaded.error) throw uploaded.error;
    } catch (error) { throw failure(error); }
  }
  async thumbnailUrls(fileIds: readonly string[]): Promise<Map<string, string>> {
    const check = this.guard(), urls = new Map<string, string>();
    if (!fileIds.length) return urls;
    try {
      const { data, error } = await this.client.storage.from(THUMBNAILS_BUCKET)
        .createSignedUrls(fileIds.map(id => `${this.owner}/${id}.jpg`), CLOUD_THUMBNAIL_URL_SECONDS);
      check(); if (error) throw error;
      // A document without a thumbnail comes back with an error and no URL.
      for (const item of data ?? []) {
        const id = /\/([^/]+)\.jpg$/.exec(item.path ?? '')?.[1];
        if (id && item.signedUrl && !item.error) urls.set(id, item.signedUrl);
      }
      return urls;
    } catch (error) { throw failure(error); }
  }
  async rename(kind: CloudItemKind, id: string, value: string): Promise<void> {
    const check = this.guard(), name = value.trim();
    if (kind === 'document') {
      if (!name || name.length > 200 || hasControl(name) || /[/\\]/.test(name) || !/\.(pf|pfl)$/i.test(name))
        throw new CloudFilesError('invalid', 'Enter a file name without slashes or control characters (up to 200 characters).');
    } else if (!name || name.length > 100 || hasControl(name) || /[/\\]/.test(name)) {
      throw new CloudFilesError('invalid', `Enter a ${kind} name without slashes or control characters (up to 100 characters).`);
    }
    try {
      const { error } = kind === 'project' ? await callRpc(this.client, 'cloud_rename_project', { p_project: id, p_name: name })
        : kind === 'folder' ? await callRpc(this.client, 'cloud_rename_folder', { p_folder: id, p_name: name })
        : await callRpc(this.client, 'cloud_rename_document', { p_document: id, p_name: name });
      check(); if (error) throw error;
    } catch (error) { throw failure(error); }
  }
  async moveFile(fileId: string, projectId: string, folderId: string | null): Promise<void> {
    const check = this.guard();
    try {
      const { error } = await callRpc(this.client, 'cloud_move_document', { p_document: fileId, p_project: projectId, p_folder: folderId });
      check(); if (error) throw error;
    } catch (error) { throw failure(error); }
  }
  async moveFolder(folderId: string, parentId: string | null): Promise<void> {
    const check = this.guard();
    try {
      const { error } = await callRpc(this.client, 'cloud_move_folder', { p_folder: folderId, p_parent: parentId });
      check(); if (error) throw error;
    } catch (error) {
      if ((error as { message?: string } | null)?.message?.includes('cloud_invalid')) throw new CloudFilesError('invalid', 'A folder cannot move into itself or one of its folders, or into another project.');
      throw failure(error);
    }
  }
  async trash(kind: CloudItemKind, id: string): Promise<void> {
    const check = this.guard();
    try {
      const { error } = kind === 'project' ? await callRpc(this.client, 'cloud_trash_project', { p_project: id })
        : kind === 'folder' ? await callRpc(this.client, 'cloud_trash_folder', { p_folder: id })
        : await callRpc(this.client, 'cloud_trash_document', { p_document: id });
      check(); if (error) throw error;
    } catch (error) { throw failure(error); }
  }
  async restore(kind: CloudItemKind, id: string): Promise<void> {
    const check = this.guard();
    try {
      const { error } = await callRpc(this.client, 'cloud_restore', { p_kind: kind, p_id: id });
      check(); if (error) throw error;
    } catch (error) {
      if ((error as { code?: string } | null)?.code === '23505') throw new CloudFilesError('invalid', 'Something with that name exists there now. Rename it, then restore again.');
      throw failure(error);
    }
  }
  async deleteForever(kind: CloudItemKind, id: string): Promise<void> {
    const check = this.guard();
    try {
      const { error } = await callRpc(this.client, 'cloud_delete_forever', { p_kind: kind, p_id: id });
      check(); if (error) throw error;
    } catch (error) { throw failure(error); }
  }
  async listTrash(): Promise<CloudTrashItem[]> {
    const check = this.guard();
    try {
      const { data, error } = await callRpc(this.client, 'cloud_list_trash', {});
      check(); if (error) throw error;
      return Array.isArray(data) ? data as CloudTrashItem[] : [];
    } catch (error) { throw failure(error); }
  }
  async trashedFiles(fileIds: readonly string[]): Promise<Set<string>> {
    const check = this.guard();
    if (!fileIds.length) return new Set();
    try {
      const { data, error } = await callRpc(this.client, 'cloud_trashed_documents', { p_ids: [...fileIds] });
      check(); if (error) throw error;
      return new Set(Array.isArray(data) ? data as string[] : []);
    } catch (error) { throw failure(error); }
  }
  dispose(): void { this.epoch++; this.owner = null; this.unsubscribe(); }
}
