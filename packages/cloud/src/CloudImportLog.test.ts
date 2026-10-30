// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { cloudImportParams, type CloudImportReport } from './CloudImportLog';

const base: CloudImportReport = {
  source: 'sketchup_model', status: 'imported', fileName: ' Chair.skp ', sizeBytes: 2048.4, durationMs: 150.6,
  sourceVersion: '26.2.242', sourceCreatedAt: null, sourceModifiedAt: null, fileModifiedAt: '2026-10-22T12:00:00.000Z',
  counts: { bodies: 3, instances: 2.5, nope: Number.NaN, negative: -1 }, issues: [' Textures are not imported. ', 'Textures are not imported.', '', 'Guides are skipped'],
  error: null, appVersion: '0.1.0', appBuild: 'abc1234-dirty',
};
it('trims, bounds, deduplicates, and rounds report fields into RPC parameters', () => {
  const params = cloudImportParams(base);
  expect(params).toMatchObject({ p_source: 'sketchup_model', p_status: 'imported', p_file_name: 'Chair.skp', p_size_bytes: 2048, p_duration_ms: 151,
    p_source_version: '26.2.242', p_source_created_at: null, p_file_modified_at: '2026-10-22T12:00:00.000Z',
    p_counts: { bodies: 3, instances: 3 }, p_issues: ['Textures are not imported.', 'Guides are skipped'], p_error: null, p_app_build: 'abc1234-dirty' });
});
it('normalizes dates, strips control characters, truncates long text, and caps issue and count lists', () => {
  const params = cloudImportParams({ ...base, fileName: 'a\u0000b\nc', sourceCreatedAt: 'Thu, 08 Dec 2011 21:20:31 GMT', sourceModifiedAt: 'not a date',
    error: 'x'.repeat(5000), issues: Array.from({ length: 300 }, (_, i) => `issue ${i}`),
    counts: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i])) });
  expect(params.p_file_name).toBe('a b c'); expect(params.p_source_created_at).toBe('2011-12-08T21:20:31.000Z'); expect(params.p_source_modified_at).toBeNull();
  expect((params.p_error as string).length).toBe(2000); expect(params.p_issues).toHaveLength(200); expect(Object.keys(params.p_counts as object)).toHaveLength(50);
  expect(cloudImportParams({ ...base, fileName: '\u0001' }).p_file_name).toBe('Untitled');
});
it('refuses unknown sources and statuses before contacting the server', () => {
  expect(() => cloudImportParams({ ...base, source: 'dwg' as CloudImportReport['source'] })).toThrow('Unknown import source');
  expect(() => cloudImportParams({ ...base, status: 'done' as CloudImportReport['status'] })).toThrow('Unknown import status');
});
