// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    if pushform_extension_runtime::child_main().is_err() {
        std::process::exit(1);
    }
}
