// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! The push/pull kernel as a WebAssembly module: requests and responses are the byte buffers of the kernel's binary
//! protocol (`pushform_native_kernel::wire`), passed through a small C ABI. JavaScript allocates a request with
//! `pf_kernel_alloc`, calls `pf_kernel_call`, reads the response it gets back and frees both with `pf_kernel_free`.
#![no_main]

use std::alloc::{alloc, dealloc, Layout};
use std::cell::UnsafeCell;
use std::sync::OnceLock;

use pushform_native_kernel::Kernel;

static KERNEL: OnceLock<Kernel> = OnceLock::new();

fn kernel() -> &'static Kernel {
  KERNEL.get_or_init(Kernel::default)
}

/// `pf_kernel_call`'s result, read by JavaScript from linear memory: status (0 ok, 1 error as JSON), pointer, length.
struct CallResult(UnsafeCell<[u32; 3]>);
// The module is single-threaded: there is no other thread to race with.
unsafe impl Sync for CallResult {}
static RESULT: CallResult = CallResult(UnsafeCell::new([0; 3]));

fn buffer_layout(len: usize) -> Option<Layout> {
  Layout::from_size_align(len, 1).ok()
}

/// Allocate `len` bytes for a request; null when the heap cannot grow any further. Pair with [`pf_kernel_free`].
#[unsafe(no_mangle)]
pub extern "C" fn pf_kernel_alloc(len: usize) -> *mut u8 {
  match buffer_layout(len) {
    Some(layout) if len > 0 => unsafe { alloc(layout) },
    _ => std::ptr::null_mut(),
  }
}

/// Free a request from [`pf_kernel_alloc`] or a response from [`pf_kernel_call`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pf_kernel_free(ptr: *mut u8, len: usize) {
  if ptr.is_null() || len == 0 {
    return;
  }
  if let Some(layout) = buffer_layout(len) {
    unsafe { dealloc(ptr, layout) };
  }
}

/// Run one request and return a pointer to its `[status, response pointer, response length]`. The request buffer stays
/// owned by the caller; a response is freed with [`pf_kernel_free`] and is valid until then.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pf_kernel_call(request: *const u8, len: usize) -> *const u32 {
  let bytes = unsafe { std::slice::from_raw_parts(request, len) };
  let (status, response): (u32, Box<[u8]>) = match kernel().handle(bytes) {
    Ok(bytes) => (0, bytes.into_boxed_slice()),
    Err(error) => (1, error.to_json().into_bytes().into_boxed_slice()),
  };
  let response_len = response.len();
  let response_ptr = Box::into_raw(response).cast::<u8>();
  unsafe {
    let result = &mut *RESULT.0.get();
    *result = [status, response_ptr as u32, response_len as u32];
    result.as_ptr()
  }
}

/// Drop every cached solid; later requests see `BodyNotCached` and re-upload.
#[unsafe(no_mangle)]
pub extern "C" fn pf_kernel_abort() {
  kernel().abort_all();
}
