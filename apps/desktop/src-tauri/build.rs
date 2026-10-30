// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
fn main() {
  // tauri_build only watches tauri.conf.json and capabilities; rebuild when icons change too.
  println!("cargo:rerun-if-changed=icons");
  tauri_build::build()
}
