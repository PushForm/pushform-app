// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { nativeDocumentType } from './nativeExtensions';

describe('nativeDocumentType', () => {
  it('distinguishes model and layout files', () => {
    expect(nativeDocumentType('House.pf')).toBe('model');
    expect(nativeDocumentType('Sheets.PFL')).toBe('layout');
    expect(nativeDocumentType('House.pf.bak')).toBeNull();
  });
});
