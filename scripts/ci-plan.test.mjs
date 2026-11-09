// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { describe, expect, it } from 'vitest';
import { planChanges, readProjects } from './ci-plan.mjs';

const projects = readProjects();
describe('affected CI plan', () => {
  it('limits a Commons screen change to Commons', () => {
    const plan = planChanges(['apps/commons/src/App.tsx'], projects);
    expect(plan.paths).toEqual(['apps/commons']);
    expect(plan.commons).toBe(true); expect(plan.web).toBe(false); expect(plan.wasm).toBe(false);
  });
  it('includes transitive dependents of a shared account component', () => {
    const plan = planChanges(['packages/account-ui/src/index.ts'], projects);
    expect(plan.paths).toEqual(expect.arrayContaining(['packages/account-ui', 'apps/commons', 'packages/ui', 'apps/web']));
    expect(plan.paths).not.toContain('packages/core');
  });
  it('includes STEP consumers when Rust changes', () => {
    const plan = planChanges(['crates/solidcraft/kernel/src/lib.rs'], projects);
    expect(plan.wasm).toBe(true); expect(plan.web).toBe(true);
    expect(plan.paths).toContain('packages/io');
  });
  it.each(['pnpm-lock.yaml', '.github/workflows/ci.yml', 'scripts/new-check.mjs', 'new-unknown-file', 'packages/io/package.json', 'apps/desktop/src-tauri/src/lib.rs'])('falls back to full validation for %s', file => {
    const plan = planChanges([file], projects);
    expect(plan.full).toBe(true); expect(plan.paths).toHaveLength(projects.length);
    expect(plan.tests).toEqual(['.']);
  });
  it('runs everything when no trustworthy baseline exists', () => {
    expect(planChanges(null, projects).full).toBe(true);
    expect(planChanges(null, projects).kernel).toBe(true);
  });
  it('builds the kernel WebAssembly module only when its sources change', () => {
    expect(planChanges(['crates/native-kernel/src/lib.rs'], projects).kernel).toBe(true);
    expect(planChanges(['crates/kernel-wasm/build.rs'], projects).kernel).toBe(true);
    expect(planChanges(['scripts/build-kernel-wasm.mjs'], projects).kernel).toBe(true);
    expect(planChanges(['crates/solidcraft/kernel/src/lib.rs'], projects).kernel).toBe(false);
    expect(planChanges(['apps/web/src/App.tsx'], projects).kernel).toBe(false);
  });
  it('skips application builds for documentation', () => {
    const plan = planChanges(['docs/help/commons.md', 'README.md'], projects);
    expect(plan.paths).toEqual([]); expect(plan.web).toBe(false); expect(plan.commons).toBe(false);
  });
  it('does not drop deletions from affected project checks', () => {
    expect(planChanges(['apps/web/src/deleted.ts'], projects).paths).toEqual(['apps/web']);
  });
});
