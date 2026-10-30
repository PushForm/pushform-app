// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { produce } from 'immer';
import { cloneLayoutValue, layoutValuesEqual } from './nativeValues';

it('copies native values from drafts and compares exact content independently of key order', () => {
  const source = { optional: undefined, fields: new Map([['a', [new Uint8Array([1, 2])]], ['b', [new Uint8Array([3])]]]) };
  let copy = source;
  produce(source, draft => { copy = cloneLayoutValue(draft); });
  expect(copy).toEqual(source); expect(copy).not.toBe(source);
  expect(copy.fields.get('a')![0]).not.toBe(source.fields.get('a')![0]);
  expect(layoutValuesEqual(source, { fields: new Map([...copy.fields].reverse()), optional: undefined })).toBe(true);
  expect(layoutValuesEqual(source, { fields: copy.fields })).toBe(false);
  copy.fields.set('a', [new Uint8Array([1, 4])]);
  expect(layoutValuesEqual(source, copy)).toBe(false);
  expect(layoutValuesEqual([1, 2], [2, 1])).toBe(false);
  expect(layoutValuesEqual(-0, 0)).toBe(false);
});

it('keeps prototype-like keys safe for replacement patches inside nested copied values', () => {
  const fields = Object.assign(Object.create(null) as Record<string, string>, { constructor: 'authored' });
  fields['__proto__'] = 'value';
  const source = { entries: new Map([[1, { fields }]]), bytes: new Uint8Array([1, 2]) };
  const copy = cloneLayoutValue(source), copiedFields = copy.entries.get(1)!.fields;
  expect(Object.getPrototypeOf(copiedFields)).toBeNull();
  expect(Object.hasOwn(copiedFields, '__proto__')).toBe(true);
  expect(copiedFields['__proto__']).toBe('value');
  expect(copiedFields).not.toBe(fields);
  expect(copy.bytes).toEqual(source.bytes);
  expect(copy.bytes).not.toBe(source.bytes);
  expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
});
