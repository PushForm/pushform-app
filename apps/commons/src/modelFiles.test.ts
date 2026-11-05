// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { sortedModelFiles } from './modelFiles';

it('orders native, exchange, notice and FreeCAD downloads without changing catalog data', () => {
  const names = ['notices.zip', 'part.FCStd', 'part.stl', 'part.STEP', 'part.pf'];
  const files = names.map(name => ({ id: name, name, format: name.split('.').at(-1)!, sizeBytes: 1, sha256: 'a'.repeat(64) }));
  expect(sortedModelFiles(files).map(file => file.name)).toEqual(['part.pf', 'part.STEP', 'part.stl', 'notices.zip', 'part.FCStd']);
  expect(files.map(file => file.name)).toEqual(names);
});
