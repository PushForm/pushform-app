// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Runs the native kernel for the differential test: framed requests on stdin, framed answers on stdout.
//! Frame in: 1 byte kind (0 = request, 1 = abort), 4 bytes little-endian length, payload. Frame out: 1 byte status
//! (0 = ok, 1 = error, payload is the error as JSON), 4 bytes little-endian length, payload.
use std::io::{Read, Write};

use pushform_native_kernel::Kernel;

fn main() {
  let kernel = Kernel::default();
  let mut input = std::io::stdin().lock();
  let mut output = std::io::stdout().lock();
  loop {
    let mut head = [0u8; 5];
    if input.read_exact(&mut head).is_err() {
      return;
    }
    let len = u32::from_le_bytes(head[1..5].try_into().unwrap()) as usize;
    let mut payload = vec![0u8; len];
    if input.read_exact(&mut payload).is_err() {
      return;
    }
    if head[0] == 1 {
      kernel.abort_all();
      output.write_all(&[0, 0, 0, 0, 0]).unwrap();
      output.flush().unwrap();
      continue;
    }
    let (status, body) = match kernel.handle(&payload) {
      Ok(bytes) => (0u8, bytes),
      Err(e) => (1u8, e.to_json().into_bytes()),
    };
    output.write_all(&[status]).unwrap();
    output.write_all(&(body.len() as u32).to_le_bytes()).unwrap();
    output.write_all(&body).unwrap();
    output.flush().unwrap();
  }
}
