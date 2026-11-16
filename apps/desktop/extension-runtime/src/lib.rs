// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! A separate native process for each extension's worker environment. No account or Tauri commands enter it.
use serde::Deserialize;
use std::io::{self, BufRead, Read};
#[cfg(windows)]
mod child;
#[cfg(windows)]
mod supervisor;
#[cfg(windows)]
pub use supervisor::Runtime;
pub const LINE_BYTES: usize = 2 * 1024 * 1024;
pub const FRAME_CHARS: usize = 256 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub id: u64,
    pub index: u16,
    pub count: u16,
    pub data: String,
}
pub fn validate_frame(line: &str) -> Result<(), String> {
    if line.len() > LINE_BYTES {
        return Err("limit.exceeded: Native frame is too large.".into());
    }
    let frame: Frame =
        serde_json::from_str(line).map_err(|_| "validation.failed: Invalid native frame.")?;
    if frame.id == 0
        || frame.count == 0
        || frame.count > 769
        || frame.index >= frame.count
        || frame.data.encode_utf16().count() > FRAME_CHARS
    {
        return Err("validation.failed: Invalid native frame bounds.".into());
    }
    Ok(())
}
pub fn read_line_bounded(reader: &mut impl BufRead, maximum: usize) -> io::Result<Option<String>> {
    let mut bytes = Vec::new();
    let length = reader
        .take((maximum + 1) as u64)
        .read_until(b'\n', &mut bytes)?;
    if length == 0 {
        return Ok(None);
    }
    if length > maximum || !bytes.ends_with(b"\n") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Native pipe frame exceeds its limit.",
        ));
    }
    bytes.pop();
    String::from_utf8(bytes).map(Some).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Native pipe frame is not UTF-8.",
        )
    })
}
pub fn child_main() -> Result<(), String> {
    #[cfg(windows)]
    {
        child::run()
    }
    #[cfg(not(windows))]
    {
        Err("extension.unsupported: This native runtime engine is not available.".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_pipe_rejects_partial_and_oversized_frames() {
        assert_eq!(
            read_line_bounded(&mut &b"abc\nnext\n"[..], 4).unwrap(),
            Some("abc".into())
        );
        assert!(read_line_bounded(&mut &b"abcde\n"[..], 4).is_err());
        assert!(read_line_bounded(&mut &b"abc"[..], 4).is_err());
        assert_eq!(read_line_bounded(&mut &b""[..], 4).unwrap(), None);
    }
    #[test]
    fn pipe_frame_identity_and_limits_are_checked() {
        assert!(validate_frame(r#"{"id":1,"index":0,"count":1,"data":"ok"}"#).is_ok());
        for line in [
            r#"{"id":0,"index":0,"count":1,"data":""}"#,
            r#"{"id":1,"index":1,"count":1,"data":""}"#,
            r#"{"id":1,"index":0,"count":770,"data":""}"#,
            r#"{"id":1,"index":0,"count":1,"data":"","owner":"other"}"#,
        ] {
            assert!(validate_frame(line).is_err());
        }
    }
}
