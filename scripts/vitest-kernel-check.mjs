// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Vitest global setup: `pnpm test` runs on the Rust kernel's WebAssembly module, so a missing or out-of-date module has
// to stop the run with one clear message instead of failing in every test file.
import { moduleProblem } from './kernel-wasm-artifact.mjs';

export default function setup() {
  const problem = moduleProblem();
  if (problem) throw new Error(problem);
}
