// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Requests that fail on purpose, to test how a kernel build behaves when a failure gets out of the C++ or Rust code.
//! They run through [`crate::Kernel::handle`] exactly as a normal request would, and are compiled only with the
//! `fault-injection` feature, which no shipped build enables.
use std::alloc::{alloc, dealloc, Layout};

use crate::KernelError;

/// First byte of a fault request; a real request starts with a little-endian opcode, so it cannot collide with one.
pub const FAULT_PREFIX: u8 = 0xf0;

const PANIC: u8 = 1;
const RUST_OUT_OF_MEMORY: u8 = 2;
const CXX_EXCEPTION: u8 = 3;
const CXX_OUT_OF_MEMORY: u8 = 4;
const MEASURE_HEAP: u8 = 5;
const ABORT: u8 = 6;
const STACK_OVERFLOW: u8 = 7;

const MEBIBYTE: usize = 1 << 20;

/// Call Manifold's C API with a mesh claiming `n_verts` vertices of three properties, which throws inside its C++ when
/// it allocates the vector for them. No vertex data is read before the allocation is attempted.
fn huge_mesh(n_verts: usize) {
  let values = [0.0f32; 3];
  let tris = [0u32; 3];
  unsafe {
    let mesh = manifold_csg_sys::manifold_alloc_meshgl();
    manifold_csg_sys::manifold_meshgl(mesh, values.as_ptr(), n_verts, 3, tris.as_ptr(), 0);
    // Only reached when the allocation surprisingly succeeded; nothing else is safe to do with this mesh.
    manifold_csg_sys::manifold_delete_meshgl(mesh);
  }
}

/// Allocates from the heap until it is exhausted and returns how many bytes it got. With `keep`, the allocations are
/// left in place so the next allocation fails; otherwise they are freed.
fn exhaust_heap(keep: bool) -> usize {
  let mut held: Vec<(*mut u8, Layout)> = Vec::new();
  let mut total = 0;
  for size in [64 * MEBIBYTE, MEBIBYTE] {
    let layout = Layout::from_size_align(size, 16).unwrap();
    loop {
      let block = unsafe { alloc(layout) };
      if block.is_null() {
        break;
      }
      // Touch every page, so the figure shows memory the engine really committed.
      unsafe { std::ptr::write_bytes(block, 1, size) };
      held.push((block, layout));
      total += size;
    }
  }
  if keep {
    std::mem::forget(held);
  } else {
    for (block, layout) in held {
      unsafe { dealloc(block, layout) };
    }
  }
  total
}

#[inline(never)]
fn recurse(depth: u32) -> u64 {
  let mut frame = [0u8; 64 * 1024];
  std::hint::black_box(&mut frame);
  if depth == 0 { 0 } else { recurse(depth - 1) + u64::from(frame[depth as usize % frame.len()]) }
}

/// Runs the fault request in `bytes`, or `None` when `bytes` is an ordinary request. Only `MEASURE_HEAP` ever returns.
pub fn run(bytes: &[u8]) -> Option<Result<Vec<u8>, KernelError>> {
  let (&FAULT_PREFIX, rest) = bytes.split_first()? else { return None };
  Some(match rest.first().copied().unwrap_or(0) {
    PANIC => panic!("fault injection: panic in the kernel"),
    RUST_OUT_OF_MEMORY => {
      let mut held: Vec<Vec<u8>> = Vec::new();
      loop {
        held.push(vec![1u8; 64 * MEBIBYTE]);
      }
    }
    CXX_EXCEPTION => {
      huge_mesh(1 << 30);
      Err(KernelError::internal("fault injection: the C++ exception was not thrown".to_string()))
    }
    CXX_OUT_OF_MEMORY => {
      let total = exhaust_heap(true);
      huge_mesh(1 << 25);
      Err(KernelError::internal(format!("fault injection: C++ allocated after {total} bytes filled the heap")))
    }
    MEASURE_HEAP => Ok((exhaust_heap(false) as f64).to_le_bytes().to_vec()),
    ABORT => std::process::abort(),
    STACK_OVERFLOW => Ok(recurse(100_000).to_le_bytes().to_vec()),
    other => Err(KernelError::invalid(&format!("unknown fault request {other}"))),
  })
}
