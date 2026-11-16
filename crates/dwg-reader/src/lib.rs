// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! PushForm's DWG reader. A DWG drawing is read from memory and written out as ASCII DXF text, which PushForm's DXF
//! importers then read, so DWG and DXF drawings import by the same rules. The module exposes a small C ABI: the host
//! copies the file into memory from [`pf_alloc`], calls [`pf_dwg_convert`], and copies out the DXF text and the
//! notes. One conversion is held at a time.

use std::cell::RefCell;
use std::io::Cursor;

use acadrust::{DwgReadOptions, DwgReader, DxfWriter};

/// The most a drawing's sections may decompress to in one read. A damaged or hostile file can declare far more than
/// it holds, and the module's memory ends at 4 GiB.
const MAX_DECOMPRESSED_BYTES: usize = 1024 * 1024 * 1024;

/// A converted drawing.
pub struct Converted {
    /// ASCII DXF text.
    pub dxf: Vec<u8>,
    /// The drawing's format version, such as `AC1027`.
    pub version: String,
    /// Notes for the user about content that could not be read.
    pub notes: Vec<String>,
}

/// Whether the bytes start as a DWG file does: `AC` and four version characters, such as `AC1027`.
pub fn is_dwg(bytes: &[u8]) -> bool {
    bytes.len() >= 6
        && &bytes[..2] == b"AC"
        && bytes[2..6]
            .iter()
            .all(|byte| byte.is_ascii_digit() || *byte == b'.')
}

/// Convert a DWG drawing to DXF text.
pub fn convert(bytes: &[u8]) -> Result<Converted, String> {
    if !is_dwg(bytes) {
        return Err("This file is not a DWG drawing.".into());
    }
    let read = |options: DwgReadOptions| {
        DwgReader::from_stream_with_options(
            Cursor::new(bytes),
            options.with_max_decompressed_bytes(MAX_DECOMPRESSED_BYTES),
        )
        .read()
    };
    let mut notes = Vec::new();
    let mut document = match read(DwgReadOptions::default()) {
        Ok(document) => document,
        // A damaged drawing is read again keeping what can be recovered; with nothing recovered it is rejected.
        Err(error) => match read(DwgReadOptions::failsafe()) {
            Ok(document) if document.entity_count() > 0 => {
                notes.push(
                    "This DWG drawing is damaged. What could be read of it is imported."
                        .to_string(),
                );
                document
            }
            _ => return Err(format!("This DWG drawing could not be read: {error}")),
        },
    };
    // Non-graphical objects (dictionaries, plot settings, application records) are often most of a drawing's DXF text
    // and the importers read none of them.
    document.objects.clear();
    let version = document.version.as_str().to_string();
    let dxf = DxfWriter::new(&document)
        .write_to_vec()
        .map_err(|error| format!("This DWG drawing could not be converted: {error}"))?;
    Ok(Converted {
        dxf,
        version,
        notes,
    })
}

#[derive(Default)]
struct State {
    dxf: Vec<u8>,
    info: Vec<u8>,
    error: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// Allocate `len` bytes for the host to fill; 0 when there is no memory.
#[unsafe(no_mangle)]
pub extern "C" fn pf_alloc(len: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::new();
    if bytes.try_reserve_exact(len.max(1)).is_err() {
        return std::ptr::null_mut();
    }
    let pointer = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    pointer
}

/// Free a block from [`pf_alloc`].
///
/// # Safety
/// `pointer` and `len` must be those of one earlier [`pf_alloc`] call, not yet freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pf_free(pointer: *mut u8, len: usize) {
    if !pointer.is_null() {
        drop(unsafe { Vec::from_raw_parts(pointer, 0, len.max(1)) });
    }
}

/// Convert the DWG file at `pointer`; 1 on success, 0 on failure (see [`pf_error_ptr`]). The DXF text and the notes
/// stay available until the next call or [`pf_dwg_release`].
///
/// # Safety
/// `pointer` must address `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pf_dwg_convert(pointer: *const u8, len: usize) -> i32 {
    let bytes = if pointer.is_null() {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(pointer, len) }
    };
    let result = convert(bytes);
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        *state = State::default();
        match result {
            Ok(converted) => {
                // The version on the first line, then one note per line.
                let mut info = converted.version;
                for note in &converted.notes {
                    info.push('\n');
                    info.push_str(&note.replace('\n', " "));
                }
                state.dxf = converted.dxf;
                state.info = info.into_bytes();
                1
            }
            Err(message) => {
                state.error = message.into_bytes();
                0
            }
        }
    })
}

/// Free the last conversion's results.
#[unsafe(no_mangle)]
pub extern "C" fn pf_dwg_release() {
    STATE.with(|state| *state.borrow_mut() = State::default());
}

macro_rules! buffer_exports {
    ($pointer:ident, $len:ident, $field:ident) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn $pointer() -> *const u8 {
            STATE.with(|state| state.borrow().$field.as_ptr())
        }
        #[unsafe(no_mangle)]
        pub extern "C" fn $len() -> usize {
            STATE.with(|state| state.borrow().$field.len())
        }
    };
}
buffer_exports!(pf_dwg_dxf_ptr, pf_dwg_dxf_len, dxf);
buffer_exports!(pf_dwg_info_ptr, pf_dwg_info_len, info);
buffer_exports!(pf_error_ptr, pf_error_len, error);
