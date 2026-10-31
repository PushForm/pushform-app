// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Native STEP conversion for the desktop app: the same reader the web app runs as WebAssembly, run on the
//! machine's cores. The webview writes the file to a temporary path, calls `step_convert`, receives progress on
//! a channel and the result buffer as the response; the temporary file is removed when `cleanup` is set.
use serde::Serialize;
use tauri::ipc::{Channel, Response};

#[derive(Clone, Serialize)]
pub struct StepProgress {
  pub stage: String,
  pub current: u32,
  pub total: u32,
}

#[tauri::command]
pub async fn step_convert(path: String, mode: u32, threshold: u32, cleanup: bool, on_progress: Channel<StepProgress>) -> Result<Response, String> {
  let result = tauri::async_runtime::spawn_blocking(move || {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"));
    if cleanup { let _ = std::fs::remove_file(&path); }
    let text = text?;
    pushform_step_reader::convert_native(&text, mode, threshold, |stage, current, total| {
      on_progress.send(StepProgress { stage: stage.to_string(), current, total }).is_ok()
    })
  })
  .await
  .map_err(|e| e.to_string())??;
  Ok(Response::new(result))
}
