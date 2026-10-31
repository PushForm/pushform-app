// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { COMPUTE_BOOTSTRAP_ENTRY, bundleWorkerBootstrap } from './extensionRuntime';

describe('extension worker bootstrap bundle', () => {
  it('is one self-contained classic script', async () => {
    const { source } = await bundleWorkerBootstrap();
    expect(source.length).toBeGreaterThan(1000);
    // A classic worker cannot contain static module syntax; the entry module is loaded with import() instead.
    expect(source).not.toMatch(/^\s*(import|export)\s/m);
    expect(source).toMatch(/^\(\(\)=>\{|^"use strict";\(\(\)=>\{/);
    expect(source).toContain('import(');
    expect(source).not.toMatch(/@pushform\//);
  }, 30_000);

  it('bundles the compute bootstrap as a classic script too, without the extension runtime', async () => {
    const { source } = await bundleWorkerBootstrap(COMPUTE_BOOTSTRAP_ENTRY);
    expect(source).not.toMatch(/^\s*(import|export)\s/m);
    expect(source).toContain('pf_run');
    expect(source).not.toContain('activation-failed');
  }, 30_000);
});
