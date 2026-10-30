// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { CloudSession, type AuthApi } from './CloudSession';
import type { CloudImportRecord } from './CloudImportLog';
import { CloudFiles, cloudChecksum, cloudFileName, type CloudSavedFile } from './CloudFiles';

const active: Array<{ files: CloudFiles; session: CloudSession; shutdown: () => Promise<void> }> = [];
afterEach(async () => { for (const item of active.splice(0)) { item.files.dispose(); item.session.dispose(); await item.shutdown(); } });
const bytes = new Uint8Array([1, 2, 3]);
async function setup() {
  let listener!: (event: string, session: unknown) => void;
  const userSession = { user: { id: 'alice', email: 'alice@example.com' }, expires_at: Math.floor(Date.now() / 1000) + 3600 };
  const session = new CloudSession({ initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session: userSession }, error: null }),
    onAuthStateChange: (callback: typeof listener) => { listener = callback; return { data: { subscription: { unsubscribe: () => {} } } }; },
  } as unknown as AuthApi);
  await session.start();
  const saved: CloudSavedFile = { file: { id: 'file-1', project_id: 'project-1', folder_id: null, name: 'Test.pf', kind: 'model',
    current_revision_id: 'revision-1', revision_number: 1, size_bytes: 3, updated_at: '2026-10-22T00:00:00Z' },
    revision: { id: 'revision-1', document_id: 'file-1', blob_path: 'alice/file-1/revision-1.pf', size_bytes: 3, sha256: await cloudChecksum(bytes), number: 1 } };
  const handler = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>(async (url, init) => {
    if (url.pathname.includes('/cloud_begin_save')) return Response.json(saved.revision);
    if (url.pathname.includes('/cloud_commit_save') || url.pathname.includes('/cloud_open_file') || url.pathname.includes('/cloud_open_revision')) return Response.json(saved);
    if (url.pathname.includes('/cloud_abort_save')) return Response.json(null);
    if (url.pathname.includes('/cloud_create_project')) return Response.json({ id: 'project-1', name: 'Project' });
    if (url.pathname.includes('/cloud_record_import')) return Response.json({ id: 'report-1', owner_id: 'alice', status: 'imported' });
    if (url.pathname.includes('/cloud_create_folder')) return Response.json({ id: 'folder-1', project_id: 'project-1', parent_id: null, name: 'Plans' });
    if (url.pathname.includes('/storage/v1/object/') && init.method === 'GET') return new Response(bytes);
    return Response.json([]);
  });
  const client = createClient('https://test.supabase.co', 'sb_publishable_test', {
    global: { fetch: async (input, init) => handler(new URL(String(input)), init ?? {}) },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const files = new CloudFiles(client, session); active.push({ files, session, shutdown: () => client.auth.dispose() });
  return { files, session, handler, saved, emit: (name: string, value: unknown) => listener(name, value) };
}
it('uses paged, escaped filename queries and stable ordering through the Supabase SDK', async () => {
  const { files, handler } = await setup(); await files.listProjects(); await files.listFiles('project-1', '50%_off', 50);
  const url = handler.mock.calls[1]![0];
  expect(url.searchParams.get('project_id')).toBe('eq.project-1');
  expect(url.searchParams.get('name')).toBe('ilike.%50\\%\\_off%');
  expect(url.searchParams.get('current_revision_id')).toBe('not.is.null');
  expect(url.searchParams.get('offset')).toBe('50'); expect(url.searchParams.get('limit')).toBe('50');
});
it('lists the account library without a project filter while requiring a valid session', async () => {
  const { files, handler, emit } = await setup(); await files.listFiles('', 'Building');
  expect(handler.mock.calls[0]![0].searchParams.has('project_id')).toBe(false);
  expect(handler.mock.calls[0]![0].searchParams.get('current_revision_id')).toBe('not.is.null');
  emit('SIGNED_OUT', null);
  await expect(files.listFiles('')).rejects.toThrow('account session changed');
  expect(handler).toHaveBeenCalledOnce();
});
it('saves via reserve, immutable upload, and commit in order', async () => {
  const { files, handler, saved } = await setup();
  expect(await files.save({ projectId: 'project-1', name: 'Test', kind: 'model', bytes })).toEqual(saved);
  expect(handler.mock.calls.map(([url]) => url.pathname)).toEqual(['/rest/v1/rpc/cloud_begin_save',
    '/storage/v1/object/cloud-files/alice/file-1/revision-1.pf', '/rest/v1/rpc/cloud_commit_save']);
  const begin = JSON.parse(String(handler.mock.calls[0]![1].body));
  expect(begin.p_name).toBe('Test.pf'); expect(begin.p_parent).toBeNull(); expect(begin.p_sha256).toBe(saved.revision.sha256);
  const upload = handler.mock.calls[1]![1]; expect(new Headers(upload.headers).get('x-upsert')).toBe('false');
});

it('filters saved templates on the server and marks only new Layout template saves', async () => {
  const { files, handler } = await setup();
  await files.listFiles('project-1', 'Office', 50, undefined, true);
  expect(handler.mock.calls[0]![0].searchParams.get('is_template')).toBe('eq.true');
  expect(handler.mock.calls[0]![0].searchParams.get('offset')).toBe('50');
  handler.mockClear();
  await files.save({ projectId: 'project-1', name: 'Office', kind: 'layout', bytes, isTemplate: true, clientKey: 'key' });
  expect(JSON.parse(String(handler.mock.calls[0]![1].body))).toMatchObject({ p_is_template: true, p_kind: 'layout', p_name: 'Office.pfl', p_client_key: 'key', p_document: null });
  handler.mockClear();
  await expect(files.save({ projectId: 'project-1', name: 'No', kind: 'model', bytes, isTemplate: true })).rejects.toThrow('new cloud file');
  await expect(files.save({ projectId: 'project-1', name: 'No', kind: 'layout', bytes, isTemplate: true, fileId: 'existing' })).rejects.toThrow('new cloud file');
  expect(handler).not.toHaveBeenCalled();
  handler.mockImplementationOnce(async () => Response.json({ code: 'PGRST202' }, { status: 404 }));
  await expect(files.save({ projectId: 'project-1', name: 'Office', kind: 'layout', bytes, isTemplate: true, clientKey: 'key' })).rejects.toThrow('not set up');
  // Never silently downgrade a template save on an older database.
  expect(handler).toHaveBeenCalledOnce();
});
it('sends a new document first-save key and commits a head the key already holds without uploading', async () => {
  const { files, handler, saved } = await setup();
  const key = '33333333-3333-4333-8333-333333333333';
  handler.mockImplementationOnce(async () => Response.json({ ...saved.revision, status: 'ready' }));
  expect(await files.save({ projectId: 'project-1', name: 'Test', kind: 'model', bytes, clientKey: key })).toEqual(saved);
  expect(handler.mock.calls.map(([url]) => url.pathname)).toEqual(['/rest/v1/rpc/cloud_begin_save', '/rest/v1/rpc/cloud_commit_save']);
  expect(JSON.parse(String(handler.mock.calls[0]![1].body)).p_client_key).toBe(key);
  expect(JSON.parse(String(handler.mock.calls[1]![1].body)).p_revision).toBe(saved.revision.id);
  // A failed commit of that ready head never removes its stored object.
  handler.mockClear();
  handler.mockImplementationOnce(async () => Response.json({ ...saved.revision, status: 'ready' }))
    .mockImplementationOnce(async () => Response.json({ message: 'cloud_conflict' }, { status: 400 }));
  await expect(files.save({ projectId: 'project-1', name: 'Test', kind: 'model', bytes, clientKey: key })).rejects.toThrow();
  expect(handler.mock.calls.map(([url]) => url.pathname)).toEqual(['/rest/v1/rpc/cloud_begin_save', '/rest/v1/rpc/cloud_commit_save']);
  // A database that predates the key argument still saves, without it.
  handler.mockClear();
  handler.mockImplementationOnce(async () => Response.json({ code: 'PGRST202', message: 'Could not find the function' }, { status: 404 }));
  expect(await files.save({ projectId: 'project-1', name: 'Test', kind: 'model', bytes, clientKey: key })).toEqual(saved);
  expect(handler.mock.calls.map(([url]) => url.pathname)).toEqual(['/rest/v1/rpc/cloud_begin_save', '/rest/v1/rpc/cloud_begin_save',
    '/storage/v1/object/cloud-files/alice/file-1/revision-1.pf', '/rest/v1/rpc/cloud_commit_save']);
  expect(JSON.parse(String(handler.mock.calls[1]![1].body))).not.toHaveProperty('p_client_key');
  // Saves of an existing document never send the key.
  handler.mockClear();
  await files.save({ projectId: 'project-1', name: 'Test', kind: 'model', bytes, fileId: 'file-1', parentRevisionId: 'revision-1', clientKey: key });
  expect(JSON.parse(String(handler.mock.calls[0]![1].body)).p_client_key).toBeNull();
});
it('verifies downloaded file length and checksum before returning bytes', async () => {
  const { files, saved } = await setup();
  expect((await files.open('file-1')).bytes).toEqual(bytes);
  saved.revision.sha256 = '0'.repeat(64); await expect(files.open('file-1')).rejects.toThrow('integrity check');
  saved.revision.size_bytes = 4; await expect(files.open('file-1')).rejects.toThrow('incomplete');
});
it('reads a document head without downloading, and downloads a pinned revision with the same checks', async () => {
  const { files, handler, saved } = await setup();
  expect(await files.head('file-1')).toEqual(saved);
  expect(handler.mock.calls.some(([url]) => url.pathname.includes('/storage/v1/object/'))).toBe(false);
  const opened = await files.openRevision('revision-1');
  expect(opened.bytes).toEqual(bytes);
  const rpc = handler.mock.calls.find(([url]) => url.pathname.includes('/cloud_open_revision'))!;
  expect(JSON.parse(String(rpc[1].body))).toEqual({ p_revision: 'revision-1' });
  handler.mockImplementation(async url => url.pathname.includes('/cloud_open_revision')
    ? Response.json({ ...saved, revision: { ...saved.revision, sha256: 'f'.repeat(64) } }) : new Response(bytes));
  await expect(files.openRevision('revision-1')).rejects.toThrow('integrity check');
});
it('never commits an upload that failed, and attempts pending-only cleanup', async () => {
  const { files, handler } = await setup();
  const original = handler.getMockImplementation()!;
  handler.mockImplementation(async (url, init) => url.pathname.includes('/storage/') && init.method === 'POST'
    ? Response.json({ message: 'upload failed', statusCode: '500' }, { status: 500 }) : original(url, init));
  await expect(files.save({ projectId: 'project-1', name: 'Test.pf', kind: 'model', bytes })).rejects.toThrow('cloud request');
  expect(handler.mock.calls.some(([url]) => url.pathname.includes('cloud_commit_save'))).toBe(false);
  expect(handler.mock.calls.some(([url]) => url.pathname.includes('cloud_abort_save'))).toBe(true);
});
it('stops after sign-out and rejects stale account responses', async () => {
  const { files, handler, emit } = await setup();
  handler.mockImplementation(async () => { emit('SIGNED_OUT', null); return Response.json([]); });
  await expect(files.listProjects()).rejects.toThrow('account session changed');
  expect(handler).toHaveBeenCalledOnce(); await expect(files.listProjects()).rejects.toThrow('account session changed');
});
it('does not commit or clean up under a different account after an upload finishes late', async () => {
  const { files, handler, emit } = await setup(); const original = handler.getMockImplementation()!;
  handler.mockImplementation(async (url, init) => {
    if (url.pathname.includes('/storage/')) { emit('SIGNED_OUT', null); return Response.json({}); }
    return original(url, init);
  });
  await expect(files.save({ projectId: 'project-1', name: 'Test.pf', kind: 'model', bytes })).rejects.toThrow('account session changed');
  expect(handler.mock.calls.some(([url]) => url.pathname.includes('cloud_commit_save'))).toBe(false);
  expect(handler.mock.calls).toHaveLength(2);
});
it('returns setup, conflict, and permission failures without provider details', async () => {
  const { files, handler } = await setup();
  for (const [code, message, expected] of [['PGRST202', 'private SQL text', 'not set up'], ['P0001', 'cloud_conflict', 'newer cloud revision'], ['42501', 'private policy details', 'do not have access']]) {
    handler.mockResolvedValueOnce(Response.json({ code, message }, { status: 400 }));
    await expect(files.createProject('Project')).rejects.toThrow(expected);
  }
});
it.each([
  ['23505', 'duplicate key private_index', 'invalid', 'already exists'],
  ['23514', 'check constraint private_check', 'invalid', 'Check the project, file name, and file size'],
  ['P0001', 'cloud_invalid: private detail', 'invalid', 'Check the project, file name, and file size'],
  ['P0001', 'cloud_auth', 'auth', 'Sign in again to use cloud files.'],
  ['P0001', 'cloud_not_found', 'not_found', 'no longer available'],
  ['PGRST205', 'relation private_table', 'unavailable', 'not set up'],
  ['42P01', 'relation private_table', 'unavailable', 'not set up'],
  ['42501', 'policy private_policy', 'forbidden', 'do not have access'],
  ['XX000', 'private internal error', 'network', 'Could not complete the cloud request'],
] as const)('maps database error %s (%s) to %s without provider details (files review TST-104)', async (code, message, expected, text) => {
  const { files, handler } = await setup();
  handler.mockResolvedValueOnce(Response.json({ code, message, details: 'private', hint: null }, { status: 400 }));
  const error = await files.createProject('Project').catch((cause: unknown) => cause);
  expect(error).toMatchObject({ name: 'CloudFilesError', code: expected });
  expect((error as Error).message).toContain(text);
  expect((error as Error).message).not.toContain('private');
});
it.each([
  [413, 'Payload too large', 'invalid', 'exceeds the cloud storage size limit'],
  [401, 'Unauthorized', 'auth', 'Sign in again'],
  [403, 'new row violates row-level security policy', 'forbidden', 'do not have access'],
] as const)('maps a storage upload answered %s to %s and never commits (files review TST-104)', async (status, error, expected, text) => {
  const { files, handler } = await setup();
  handler.mockImplementation(async url => url.pathname.startsWith('/storage/v1/object/cloud-files/')
    ? Response.json({ statusCode: String(status), error, message: error }, { status })
    : url.pathname.includes('/cloud_begin_save') ? Response.json({ id: 'revision-1', document_id: 'file-1', blob_path: 'alice/file-1/revision-1.pf', size_bytes: 3, sha256: await cloudChecksum(bytes), number: 1 })
    : Response.json(null));
  const failure = await files.save({ projectId: 'project-1', name: 'Test', kind: 'model', bytes }).catch((cause: unknown) => cause);
  expect(failure).toMatchObject({ name: 'CloudFilesError', code: expected });
  expect((failure as Error).message).toContain(text);
  expect(handler.mock.calls.some(([url]) => url.pathname.includes('/cloud_commit_save'))).toBe(false);
});
it('rejects unsafe names and oversized or empty uploads without a request', async () => {
  const { files, handler } = await setup();
  await expect(files.save({ projectId: 'project-1', name: '../Test.pf', kind: 'model', bytes })).rejects.toThrow('file name');
  await expect(files.save({ projectId: 'project-1', name: 'Test.pf', kind: 'model', bytes: new Uint8Array() })).rejects.toThrow('100 MiB');
  expect(handler).not.toHaveBeenCalled(); expect(cloudFileName('Drawing.PFL', 'layout')).toBe('Drawing.pfl');
});
it('retries a lost commit response using the same revision instead of uploading another copy', async () => {
  const { files, handler, saved } = await setup(); const original = handler.getMockImplementation()!;
  let failed = false;
  handler.mockImplementation(async (url, init) => {
    if (url.pathname.includes('cloud_commit_save') && !failed) { failed = true; return Response.json({ message: 'Lost response' }, { status: 503 }); }
    return original(url, init);
  });
  expect(await files.save({ projectId: 'project-1', name: 'Test', kind: 'model', bytes })).toEqual(saved);
  const commits = handler.mock.calls.filter(([url]) => url.pathname.includes('cloud_commit_save'));
  expect(commits).toHaveLength(2); expect(commits[0]![1].body).toEqual(commits[1]![1].body);
  expect(handler.mock.calls.filter(([url]) => url.pathname.includes('cloud_begin_save'))).toHaveLength(1);
});
it('records import reports through the restricted RPC and only for the current session', async () => {
  const { files, handler, emit } = await setup();
  const report = { source: 'sketchup_model' as const, status: 'imported' as const, fileName: 'Chair.skp', sizeBytes: 3, durationMs: 20,
    sourceVersion: '26.2.242', sourceCreatedAt: null, sourceModifiedAt: null, fileModifiedAt: null, counts: { bodies: 1 },
    issues: ['Textures are not imported.'], error: null, appVersion: '0.1.0', appBuild: 'abc1234' };
  expect((await files.recordImport(report)).id).toBe('report-1');
  expect(handler.mock.calls[0]![0].pathname).toBe('/rest/v1/rpc/cloud_record_import');
  const body = JSON.parse(String(handler.mock.calls[0]![1].body));
  expect(body).toMatchObject({ p_source: 'sketchup_model', p_file_name: 'Chair.skp', p_counts: { bodies: 1 }, p_issues: ['Textures are not imported.'], p_error: null });
  emit('SIGNED_OUT', null);
  await expect(files.recordImport(report)).rejects.toThrow('account session changed');
  expect(handler).toHaveBeenCalledOnce();
});
it('lists and creates folders, filters a project listing by folder, and sends the folder with a new save', async () => {
  const { files, handler } = await setup();
  await files.listFolders('project-1');
  expect(handler.mock.calls[0]![0].pathname).toBe('/rest/v1/cloud_folders');
  expect(handler.mock.calls[0]![0].searchParams.get('project_id')).toBe('eq.project-1');
  expect(await files.createFolder('project-1', null, ' Plans ')).toMatchObject({ id: 'folder-1', name: 'Plans' });
  expect(JSON.parse(String(handler.mock.calls[1]![1].body))).toEqual({ p_project: 'project-1', p_parent: null, p_name: 'Plans' });
  await expect(files.createFolder('project-1', null, 'a/b')).rejects.toThrow('without slashes');
  await files.listFiles('project-1', '', 0, null); await files.listFiles('project-1', '', 0, 'folder-1'); await files.listFiles('project-1', 'x', 0, 'folder-1');
  expect(handler.mock.calls[2]![0].searchParams.get('folder_id')).toBe('is.null');
  expect(handler.mock.calls[3]![0].searchParams.get('folder_id')).toBe('eq.folder-1');
  expect(handler.mock.calls[4]![0].searchParams.has('folder_id')).toBe(false);
  await files.save({ projectId: 'project-1', name: 'Test', kind: 'model', bytes, folderId: 'folder-1' });
  expect(JSON.parse(String(handler.mock.calls[5]![1].body)).p_folder).toBe('folder-1');
  const original = handler.getMockImplementation()!;
  handler.mockImplementation(async (url, init) => url.pathname.includes('/cloud_create_folder')
    ? Response.json({ code: '23505', message: 'duplicate key' }, { status: 409 }) : original(url, init));
  await expect(files.createFolder('project-1', null, 'Plans')).rejects.toThrow('folder with that name already exists');
});
it('replaces a document thumbnail in the owner-scoped thumbnails bucket', async () => {
  const { files, handler } = await setup();
  await files.saveThumbnail('file-1', new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  const [url, init] = handler.mock.calls[0]!;
  expect(url.pathname).toBe('/storage/v1/object/cloud-thumbnails/alice/file-1.jpg');
  expect(new Headers(init.headers).get('x-upsert')).toBe('true');
  await expect(files.saveThumbnail('file-1', new Uint8Array(512 * 1024 + 1))).rejects.toThrow('too large');
  await expect(files.saveThumbnail('file-1', new Uint8Array())).rejects.toThrow('empty');
  expect(handler).toHaveBeenCalledOnce();
});
it('signs thumbnail URLs together and leaves out documents without one', async () => {
  const { files, handler } = await setup();
  handler.mockImplementation(async (url, init) => {
    if (!url.pathname.endsWith('/storage/v1/object/sign/cloud-thumbnails')) return Response.json([]);
    expect(JSON.parse(String(init.body))).toMatchObject({ paths: ['alice/file-1.jpg', 'alice/file-2.jpg'], expiresIn: 600 });
    return Response.json([
      { path: 'alice/file-1.jpg', signedURL: '/object/sign/cloud-thumbnails/alice/file-1.jpg?token=t', error: null },
      { path: 'alice/file-2.jpg', signedURL: null, error: 'Either the requested object does not exist or you do not have access to it' },
    ]);
  });
  const urls = await files.thumbnailUrls(['file-1', 'file-2']);
  expect([...urls.keys()]).toEqual(['file-1']);
  expect(urls.get('file-1')).toContain('/storage/v1/object/sign/cloud-thumbnails/alice/file-1.jpg?token=t');
  expect(await files.thumbnailUrls([])).toEqual(new Map());
  expect(handler).toHaveBeenCalledOnce();
});
it('leaves trashed rows out of listings, and lists everything once a database without the trash columns says so', async () => {
  const { files, handler } = await setup();
  await files.listProjects(); await files.listFolders('project-1'); await files.listFiles('project-1');
  for (const call of handler.mock.calls.slice(0, 3)) expect(call[0].searchParams.get('trashed_at')).toBe('is.null');
  handler.mockImplementationOnce(async () => Response.json({ code: '42703', message: 'column cloud_documents.trashed_at does not exist' }, { status: 400 }));
  expect(await files.listFiles('')).toEqual([]);
  expect(handler.mock.calls[3]![0].searchParams.get('trashed_at')).toBe('is.null');
  expect(handler.mock.calls[4]![0].searchParams.has('trashed_at')).toBe(false);
  await files.listProjects();
  expect(handler.mock.calls[5]![0].searchParams.has('trashed_at')).toBe(false);
});
it('renames, moves, trashes, restores, deletes and lists the Trash through the owner-only functions', async () => {
  const { files, handler } = await setup();
  handler.mockImplementation(async url => {
    if (url.pathname.includes('/cloud_list_trash')) return Response.json([{ kind: 'document', id: 'file-1', name: 'Test.pf', project_id: 'project-1', project_name: 'Project', folder_id: null, trashed_at: '2026-10-29T00:00:00Z', purge_after: '2026-11-28T00:00:00Z', document_kind: 'model' }]);
    if (url.pathname.includes('/cloud_trashed_documents')) return Response.json(['file-2']);
    if (url.pathname.includes('/cloud_restore')) return Response.json({ code: '23505', message: 'duplicate key value violates unique constraint' }, { status: 409 });
    if (url.pathname.includes('/cloud_rename_document')) return Response.json({ message: 'cloud_trashed' }, { status: 400 });
    return Response.json({});
  });
  await files.rename('project', 'project-1', ' Homes ');
  await files.rename('folder', 'folder-1', 'Plans');
  await files.moveFile('file-1', 'project-2', 'folder-2');
  await files.moveFolder('folder-1', null);
  await files.trash('document', 'file-1'); await files.trash('folder', 'folder-1'); await files.trash('project', 'project-1');
  await files.deleteForever('document', 'file-1');
  const bodies = handler.mock.calls.map(call => `${call[0].pathname.split('/').pop()} ${String(call[1].body ?? '')}`);
  expect(bodies).toEqual([
    'cloud_rename_project {"p_project":"project-1","p_name":"Homes"}', 'cloud_rename_folder {"p_folder":"folder-1","p_name":"Plans"}',
    'cloud_move_document {"p_document":"file-1","p_project":"project-2","p_folder":"folder-2"}', 'cloud_move_folder {"p_folder":"folder-1","p_parent":null}',
    'cloud_trash_document {"p_document":"file-1"}', 'cloud_trash_folder {"p_folder":"folder-1"}', 'cloud_trash_project {"p_project":"project-1"}',
    'cloud_delete_forever {"p_kind":"document","p_id":"file-1"}',
  ]);
  expect((await files.listTrash())[0]).toMatchObject({ kind: 'document', name: 'Test.pf' });
  expect(await files.trashedFiles(['file-1', 'file-2'])).toEqual(new Set(['file-2']));
  expect(await files.trashedFiles([])).toEqual(new Set());
  await expect(files.rename('document', 'file-1', 'Bad/name.pf')).rejects.toThrow('without slashes');
  await expect(files.rename('document', 'file-1', 'Trashed.pf')).rejects.toMatchObject({ code: 'trashed' });
  await expect(files.restore('folder', 'folder-1')).rejects.toThrow('that name exists there now');
});

it('stores failed imports in immutable account-scoped storage and rejects cross-account evidence', async () => {
  const { files, handler } = await setup();
  const report = { id: 'report-1', owner_id: 'alice', status: 'failed', size_bytes: 3 } as CloudImportRecord;
  await files.saveFailedImport(report, bytes);
  expect(handler.mock.calls[0]![0].pathname).toBe('/storage/v1/object/cloud-import-failures/alice/.import-failures/report-1/source');
  expect(new Headers(handler.mock.calls[0]![1].headers).get('x-upsert')).toBe('false');
  await expect(files.saveFailedImport({ ...report, owner_id: 'bob' }, bytes)).rejects.toThrow('account or file');
  await expect(files.saveFailedImport({ ...report, status: 'cancelled' }, bytes)).rejects.toThrow('account or file');
  expect(handler).toHaveBeenCalledOnce();
});
