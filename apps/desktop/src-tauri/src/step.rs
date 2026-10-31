// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Native STEP conversion for the desktop app: the same reader the web app runs as WebAssembly, run on the
//! machine's cores. The webview writes the file to a temporary path, calls `step_convert` with a job id, receives
//! progress on a channel and the result buffer as the response; the temporary file is removed when `cleanup` is
//! set. `step_cancel` with the same id stops the conversion at its next progress report.
use std::collections::HashSet;
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::{Channel, Response};

#[derive(Clone, Serialize)]
pub struct StepProgress {
  pub stage: String,
  pub current: u32,
  pub total: u32,
}

/// Jobs told to stop (cleared when the job ends).
static CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn cancelled(job: &str) -> bool {
  CANCELLED.lock().map(|set| set.as_ref().is_some_and(|s| s.contains(job))).unwrap_or(false)
}

#[tauri::command]
pub async fn step_convert(path: String, job: String, mode: u32, threshold: u32, cleanup: bool, on_progress: Channel<StepProgress>) -> Result<Response, String> {
  let id = job.clone();
  let result = tauri::async_runtime::spawn_blocking(move || {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"));
    if cleanup { let _ = std::fs::remove_file(&path); }
    let text = text?;
    pushform_step_reader::convert_native(&text, mode, threshold, |stage, current, total| {
      !cancelled(&job) && on_progress.send(StepProgress { stage: stage.to_string(), current, total }).is_ok()
    })
  })
  .await
  .map_err(|e| e.to_string());
  if let Ok(mut set) = CANCELLED.lock() { if let Some(s) = set.as_mut() { s.remove(&id); } }
  Ok(Response::new(result??))
}

/// Stop the conversion `job` (nothing happens when it is unknown or already over).
#[tauri::command]
pub fn step_cancel(job: String) {
  if let Ok(mut set) = CANCELLED.lock() { set.get_or_insert_with(HashSet::new).insert(job); }
}

/// Write the STEP file for a request the webview saved at `path` (the format of `pushform_step_reader::export_step`),
/// reporting the parts built so far; the response is the file's text. `step_cancel` stops it at its next report.
#[tauri::command]
pub async fn step_export(path: String, job: String, cleanup: bool, on_progress: Channel<StepProgress>) -> Result<Response, String> {
  let id = job.clone();
  let result = tauri::async_runtime::spawn_blocking(move || {
    let request = std::fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"));
    if cleanup { let _ = std::fs::remove_file(&path); }
    pushform_step_reader::export_step(&request?, |current, total| {
      !cancelled(&job) && on_progress.send(StepProgress { stage: "Writing parts".to_string(), current, total }).is_ok()
    })
  })
  .await
  .map_err(|e| e.to_string());
  if let Ok(mut set) = CANCELLED.lock() { if let Some(s) = set.as_mut() { s.remove(&id); } }
  Ok(Response::new(result??.into_bytes()))
}
