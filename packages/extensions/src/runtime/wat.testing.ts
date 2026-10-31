// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import wabtInit from 'wabt';

/** Compiles WebAssembly text to a module binary, for tests. */
export async function wat(source: string): Promise<Uint8Array> {
  const wabt = await wabtInit();
  const module = wabt.parseWat('test.wat', source, { bulk_memory: true });
  try {
    return new Uint8Array(module.toBinary({}).buffer);
  } finally {
    module.destroy();
  }
}

// Imports must come before any definition, so modules put their own imports between these two.
const memory = '(import "pf" "memory" (memory 1))';
const abi = '(func (export "pf_abi_version") (result i32) i32.const 1)';

/** Test modules following the compute ABI. */
export const MODULES = {
  /** Returns its input; reports progress 0.5 and the input as a partial result first. */
  echo: `(module ${memory}
    (import "pf" "progress" (func $progress (param f64)))
    (import "pf" "partial" (func $partial (param i32 i32)))
    ${abi}

    (global $heap (mut i32) (i32.const 1024))
    (func (export "pf_alloc") (param $len i32) (result i32) (local $p i32)
      (local.set $p (global.get $heap)) (global.set $heap (i32.add (global.get $heap) (local.get $len))) (local.get $p))
    (func (export "pf_run") (param $ptr i32) (param $len i32) (result i32) (local $out i32)
      (call $progress (f64.const 0.5))
      (call $partial (local.get $ptr) (local.get $len))
      (local.set $out (global.get $heap))
      (i32.store (local.get $out) (local.get $len))
      (memory.copy (i32.add (local.get $out) (i32.const 4)) (local.get $ptr) (local.get $len))
      (local.get $out)))`,
  /** Tries to grow its memory by 10 pages and returns the result of memory.grow as one i32 (-1 on failure). */
  grow: `(module ${memory}
    ${abi}

    (func (export "pf_alloc") (param i32) (result i32) i32.const 1024)
    (func (export "pf_run") (param i32 i32) (result i32)
      (i32.store (i32.const 2048) (i32.const 4))
      (i32.store (i32.const 2052) (memory.grow (i32.const 10)))
      i32.const 2048))`,
  /** Spins until pf.should_stop() is true, then returns the JSON string "best". */
  soft: `(module ${memory}
    (import "pf" "should_stop" (func $stop (result i32)))
    ${abi}

    (data (i32.const 2048) "\\06\\00\\00\\00\\22best\\22")
    (func (export "pf_alloc") (param i32) (result i32) i32.const 1024)
    (func (export "pf_run") (param i32 i32) (result i32)
      (block $done (loop $spin (br_if $done (call $stop)) (br $spin)))
      i32.const 2048))`,
  /** Counts its calls and returns the count as one byte, keeping the count between calls. */
  counter: `(module ${memory}
    ${abi}

    (global $n (mut i32) (i32.const 0))
    (func (export "pf_alloc") (param i32) (result i32) i32.const 1024)
    (func (export "pf_run") (param i32 i32) (result i32)
      (global.set $n (i32.add (global.get $n) (i32.const 1)))
      (i32.store (i32.const 2048) (i32.const 1))
      (i32.store8 (i32.const 2052) (global.get $n))
      i32.const 2048))`,
  /** Returns the three bytes "abc", which are not JSON. */
  notJson: `(module ${memory}
    ${abi}

    (data (i32.const 2048) "\\03\\00\\00\\00abc")
    (func (export "pf_alloc") (param i32) (result i32) i32.const 1024)
    (func (export "pf_run") (param i32 i32) (result i32) i32.const 2048))`,
  /** Asks for a host function outside the compute interface. */
  fetches: `(module ${memory}
    (import "env" "fetch" (func))
    ${abi}

    (func (export "pf_alloc") (param i32) (result i32) i32.const 1024)
    (func (export "pf_run") (param i32 i32) (result i32) i32.const 0))`,
} as const;
