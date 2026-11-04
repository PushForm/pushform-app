// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import { parseModelAttributions, type ModelAttribution } from './attribution';

const notice: ModelAttribution = { modelId: 'gate', revision: 'r1', assetId: 'a1', title: 'Garden gate', creator: 'Maker', source: null,
  licenses: [{ name: 'Custom license', url: null, commercialUse: 'unknown', conditions: ['Personal use only.'] }],
  credits: [{ name: 'Maker', url: null, text: 'Original model by Maker.' }], file: { name: 'gate.stl', sizeBytes: 3, sha256: 'a'.repeat(64) } };

it('keeps licenses written as the publisher’s own terms, which have no license link', () => {
  expect(parseModelAttributions([notice])).toEqual([notice]);
});
it('still refuses an unsafe license link', () => {
  expect(() => parseModelAttributions([{ ...notice, licenses: [{ ...notice.licenses[0]!, url: 'javascript:alert(1)' }] }])).toThrow();
});
