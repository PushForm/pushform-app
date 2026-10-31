// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! A per-thread cache in front of the system allocator for the threaded WebAssembly build. The C library's allocator
//! takes one lock for every call, and meshing makes small allocations by the million on every thread at once, which
//! left eight threads slower than two. Small blocks (up to [`MAX_SMALL`] bytes, alignment at most 16) come from
//! per-thread free lists, refilled a chunk at a time from the system allocator; a freed block goes on the list of the
//! thread that freed it. The chunks are never handed back: a thread that ends leaves at most a few hundred kilobytes
//! behind, and the meshing threads are few and short-lived. Larger blocks go straight to the system allocator.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::UnsafeCell;
use std::ptr;

const GRANULE: usize = 16;
const MAX_SMALL: usize = 1024;
const CLASSES: usize = MAX_SMALL / GRANULE;
/// Bytes taken from the system per refill (at least this much, and room for 32 blocks of the class).
const CHUNK: usize = 16 * 1024;

struct FreeList { head: *mut u8 }

pub struct CachingAlloc;

thread_local! {
    static LISTS: UnsafeCell<[FreeList; CLASSES]> = const { UnsafeCell::new([const { FreeList { head: ptr::null_mut() } }; CLASSES]) };
}

#[inline]
fn class_of(layout: &Layout) -> Option<usize> {
    if layout.size() == 0 || layout.size() > MAX_SMALL || layout.align() > GRANULE { return None; }
    Some(layout.size().div_ceil(GRANULE) - 1)
}

unsafe impl GlobalAlloc for CachingAlloc {
    #[inline]
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let Some(class) = class_of(&layout) else { return unsafe { System.alloc(layout) } };
        LISTS.try_with(|lists| {
            let list = unsafe { &mut (*lists.get())[class] };
            if list.head.is_null() && !unsafe { refill(list, class) } { return ptr::null_mut(); }
            let block = list.head;
            list.head = unsafe { *(block as *mut *mut u8) };
            block
        }).unwrap_or_else(|_| unsafe { System.alloc(layout) })
    }
    #[inline]
    unsafe fn dealloc(&self, block: *mut u8, layout: Layout) {
        let Some(class) = class_of(&layout) else { return unsafe { System.dealloc(block, layout) } };
        // A block freed while its thread's storage is gone cannot be listed; it is leaked rather than misfiled.
        let _ = LISTS.try_with(|lists| {
            let list = unsafe { &mut (*lists.get())[class] };
            unsafe { *(block as *mut *mut u8) = list.head };
            list.head = block;
        });
    }
    #[inline]
    unsafe fn realloc(&self, block: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_layout = unsafe { Layout::from_size_align_unchecked(new_size, layout.align()) };
        match (class_of(&layout), class_of(&new_layout)) {
            (None, None) => unsafe { System.realloc(block, layout, new_size) },
            (Some(old), Some(new)) if old == new => block,
            _ => {
                let out = unsafe { self.alloc(new_layout) };
                if !out.is_null() {
                    unsafe { ptr::copy_nonoverlapping(block, out, layout.size().min(new_size)) };
                    unsafe { self.dealloc(block, layout) };
                }
                out
            }
        }
    }
}

/// Carve a fresh chunk into blocks of `class` and list them; false when the system has no memory.
unsafe fn refill(list: &mut FreeList, class: usize) -> bool {
    let size = (class + 1) * GRANULE;
    let bytes = CHUNK.max(size * 32) / size * size;
    let chunk = unsafe { System.alloc(Layout::from_size_align_unchecked(bytes, GRANULE)) };
    if chunk.is_null() { return false; }
    let mut head = list.head;
    let mut at = bytes;
    while at >= size {
        at -= size;
        let block = unsafe { chunk.add(at) };
        unsafe { *(block as *mut *mut u8) = head };
        head = block;
    }
    list.head = head;
    true
}
