// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// Time the native conversion of a STEP file as the desktop app runs it, printing progress as it goes.
use std::time::Instant;
fn main() {
    let path = std::env::args().nth(1).expect("usage: native FILE.step");
    let text = std::fs::read_to_string(&path).expect("read");
    let t = Instant::now();
    let mut last = String::new();
    let result = pushform_step_reader::convert_native(&text, 7, 0, |stage, done, total| {
        let line = format!("{stage} {done}/{total}");
        if stage != last || done == total { eprintln!("{:>7} ms  {line}", t.elapsed().as_millis()); last = stage.to_string(); }
        true
    });
    match result {
        Ok(bytes) => eprintln!("done in {} ms: {} bytes of result", t.elapsed().as_millis(), bytes.len()),
        Err(e) => eprintln!("failed: {e}"),
    }
}
