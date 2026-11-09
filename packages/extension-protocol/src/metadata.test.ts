// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { isMetadataSchema, metadataValueMatches, metadataApplySchema, modelExtensionBatchSchema, type MetadataSchema } from './metadata.ts';

it('allows an explicit upgrade beside model operations while refusing empty or implicit metadata edits',()=>{
  const batch={expectedRevision:1,label:'Place native module',operations:[{op:'place_fragment',fragment:'fragment_'+'a'.repeat(32),worldMatrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}],metadata:{expectedDataVersion:1,upgradeCompatible:true}};
  expect(modelExtensionBatchSchema.safeParse(batch).success).toBe(true);
  expect(modelExtensionBatchSchema.safeParse({...batch,operations:[]}).success).toBe(false);
  expect(modelExtensionBatchSchema.safeParse({...batch,metadata:{expectedDataVersion:1}}).success).toBe(false);
});

it('accepts bounded declarative schemas and rejects code, references and unsupported keywords', () => {
  const schema: MetadataSchema = { type: 'object', properties: { label: { type: 'string', maxLength: 100 }, copies: { type: 'integer', minimum: 1 } }, required: ['label'] };
  expect(isMetadataSchema(schema)).toBe(true);
  expect(metadataValueMatches(schema, { label: 'Shelf', copies: 2 })).toBe(true);
  for (const value of [{ label: 12 }, { copies: 2 }, { label: 'Door', extra: true }, { label: 'Door', copies: 0 }]) expect(metadataValueMatches(schema, value)).toBe(false);
  for (const value of [{ $ref: 'https://example.com/schema' }, { type: 'string', pattern: '(a+)+' }, { type: 'string', validate: () => true }, { type: 'integer', minimum: 10, maximum: 2 }]) expect(isMetadataSchema(value)).toBe(false);
  const cyclic: Record<string, unknown> = { type: 'array' }; cyclic.items = cyclic;
  expect(isMetadataSchema(cyclic)).toBe(false);
});
it('validates dynamic object fields, arrays, finite numbers and safe integers', () => {
  const schema: MetadataSchema = { type: 'object', additionalProperties: { type: 'array', maxItems: 2, items: { type: 'string', enum: ['a', 'b'] } } };
  expect(metadataValueMatches(schema, { drawers: ['a', 'b'] })).toBe(true);
  expect(metadataValueMatches(schema, { drawers: ['c'] })).toBe(false);
  expect(metadataValueMatches({ type: 'number' }, Infinity)).toBe(false);
  expect(metadataValueMatches({ type: 'integer' }, Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  expect(metadataValueMatches({ type: 'array', maxItems: 0, items: { type: 'null' } }, [null])).toBe(false);
});
it('does not accept a caller-supplied metadata owner or schema', () => {
  const base = { expectedRevision: 0, expectedDataVersion: null, upserts: [{ id: 'job', target: { kind: 'document' }, value: {} }] };
  expect(metadataApplySchema.safeParse(base).success).toBe(true);
  expect(metadataApplySchema.safeParse({ expectedRevision: 0, expectedDataVersion: null }).success).toBe(false);
  expect(metadataApplySchema.safeParse({ ...base, owner: 'com.someone.else' }).success).toBe(false);
  expect(metadataApplySchema.safeParse({ ...base, schema: { type: 'string' } }).success).toBe(false);
  expect(metadataApplySchema.safeParse({ ...base, upserts: [{ id: 'part', target: { kind: 'bodyOccurrence', id: 1, path: [-1] }, value: {} }] }).success).toBe(false);
});
