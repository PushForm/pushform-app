// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import type { CloudFile } from '@pushform/cloud';
import { forgetCloudRecents, readCloudRecents, recordCloudRecent, updateCloudRecent } from './cloudRecents';
afterEach(() => localStorage.clear());
const file: CloudFile = { id: 'file', project_id: 'project', folder_id: null, name: 'Model.pf', kind: 'model', revision_number: 1,
  current_revision_id: 'revision', size_bytes: 1, updated_at: '2026-10-22T12:00:00Z' };
it('scopes recent metadata to the account and bounds browser history to twelve documents', () => {
  for (let i = 0; i < 15; i++) recordCloudRecent('alice', { ...file, id: String(i) });
  expect(readCloudRecents('alice')).toHaveLength(12); expect(readCloudRecents('bob')).toEqual([]);
  expect(readCloudRecents('alice')[0]!.id).toBe('14');
});
it('updates saved metadata without making background saves look like newly opened files', () => {
  recordCloudRecent('alice', file); recordCloudRecent('alice', { ...file, id: 'later' });
  updateCloudRecent('alice', { ...file, revision_number: 2 });
  expect(readCloudRecents('alice').map(item => item.id)).toEqual(['later', 'file']);
  expect(readCloudRecents('alice')[1]!.revision_number).toBe(2);
});
it('forgets files that are gone or in the Trash, for that account only', () => {
  recordCloudRecent('alice', file); recordCloudRecent('alice', { ...file, id: 'later' }); recordCloudRecent('bob', file);
  expect(forgetCloudRecents('alice', ['file', 'unknown']).map(item => item.id)).toEqual(['later']);
  expect(readCloudRecents('alice').map(item => item.id)).toEqual(['later']);
  expect(readCloudRecents('bob').map(item => item.id)).toEqual(['file']);
});
