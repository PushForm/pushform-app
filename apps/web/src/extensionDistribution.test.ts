// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { readExtensionDistribution } from './extensionDistribution';

const point = btoa(String.fromCharCode(4, ...new Array<number>(64).fill(1)));
const config = { keys: [{ id: 'release-2026', publicKey: point, notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' }],
  registryUrl: 'https://plugins.example/index.json', revocationsUrl: 'https://plugins.example/revocations.json', origins: ['https://plugins.example'] };
const read = (value: unknown) => readExtensionDistribution(JSON.stringify(value), '2026.45.1');
describe('public distribution build configuration', () => {
  it('stays off without explicit pinned keys and endpoints', () => {
    expect(readExtensionDistribution(undefined, '2026.45.1')).toBeUndefined();
    expect(readExtensionDistribution('', '2026.45.1')).toBeUndefined();
    expect(readExtensionDistribution('bad JSON', '2026.45.1')).toBeUndefined();
    expect(read({ ...config, keys: [] })).toBeUndefined();
    expect(readExtensionDistribution(JSON.stringify(config), 'unknown')).toBeUndefined();
  });
  it('accepts only a bounded public-key configuration with matching allowed HTTPS origins', () => {
    expect(read(config)).toEqual({ ...config, appVersion: '2026.45.1' });
    for (const patch of [{ privateKey: 'never accepted' }, { origins: ['https://elsewhere.example'] }, { registryUrl: 'http://plugins.example/index.json' },
      { keys: [config.keys[0], config.keys[0]] }, { origins: ['https://plugins.example/path'] },
      { keys: [{ ...config.keys[0], publicKey: 'AAAA' }] }, { keys: [{ ...config.keys[0], notAfter: config.keys[0]!.notBefore }] }])
      expect(read({ ...config, ...patch })).toBeUndefined();
  });
});
