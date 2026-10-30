// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
use clipboard_rs::{Clipboard, ClipboardContent, ClipboardContext};
use serde::Deserialize;
use std::{collections::HashMap, sync::Mutex};

// Keep the owner alive: X11 clipboard data is served by the owning process.
#[derive(Default)]
pub struct State(Mutex<Option<ClipboardContext>>);

#[derive(Deserialize)]
pub struct Payload {
    native: String,
    svg: String,
    html: String,
    text: String,
}

#[tauri::command]
pub fn layout_clipboard_write(state: tauri::State<'_, State>, payload: Payload) -> Result<(), String> {
    let mut context = state.0.lock().map_err(|error| error.to_string())?;
    if context.is_none() {
        *context = Some(ClipboardContext::new().map_err(|error| error.to_string())?);
    }
    let mut contents = vec![
        ClipboardContent::Text(payload.text),
        ClipboardContent::Html(payload.html),
        ClipboardContent::Other("application/x-pushform-layout".into(), payload.native.into_bytes()),
        ClipboardContent::Other("image/svg+xml".into(), payload.svg.as_bytes().to_vec()),
    ];
    if cfg!(target_os = "macos") {
        contents.push(ClipboardContent::Other("public.svg-image".into(), payload.svg.into_bytes()));
    }
    context.as_ref().unwrap().set(contents).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn layout_clipboard_read(state: tauri::State<'_, State>) -> Result<HashMap<String, String>, String> {
    let mut context = state.0.lock().map_err(|error| error.to_string())?;
    if context.is_none() {
        *context = Some(ClipboardContext::new().map_err(|error| error.to_string())?);
    }
    let context = context.as_ref().unwrap();
    let formats = context.available_formats().map_err(|error| error.to_string())?;
    let mut result = HashMap::new();
    for (format, mime) in [
        ("application/x-pushform-layout", "application/x-pushform-layout"),
        ("image/svg+xml", "image/svg+xml"),
        ("public.svg-image", "image/svg+xml"),
        ("image/x-inkscape-svg", "image/svg+xml"),
        ("org.inkscape.svg", "image/svg+xml"),
    ] {
        if formats.iter().any(|available| available == format) && !result.contains_key(mime) {
            let data = context.get_buffer(format).map_err(|error| error.to_string())?;
            let text = String::from_utf8(data).map_err(|error| error.to_string())?;
            result.insert(mime.into(), text.trim_end_matches('\0').into());
        }
    }
    Ok(result)
}
