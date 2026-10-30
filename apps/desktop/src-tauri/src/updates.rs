// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Desktop updates. The web app asks for the latest release of a channel; a newer one
//! is downloaded and its signature verified here, then held until the user restarts to install it. Release builds get
//! the updater's public key from .github/workflows/desktop.yml, merged over tauri.conf.json's empty `pubkey`; a build
//! without it (local builds) reports updates as disabled and never checks.
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Each channel's update manifest is `<base>/<channel>/latest.json`, published by scripts/desktop-release.mjs.
const MANIFESTS: &str = "https://downloads.pushform.io/desktop";

/// The downloaded, verified update waiting to be installed.
#[derive(Default)]
pub struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

#[derive(Clone, Serialize)]
pub struct ReadyUpdate {
  version: String,
}

fn error(cause: impl std::fmt::Display) -> String {
  cause.to_string()
}

/// Whether this build carries the updater's public key.
#[tauri::command]
pub fn update_enabled(app: AppHandle) -> bool {
  app
    .config()
    .plugins
    .0
    .get("updater")
    .and_then(|updater| updater.get("pubkey"))
    .and_then(|key| key.as_str())
    .is_some_and(|key| !key.trim().is_empty())
}

/// Checks `channel` and downloads a newer release, returning it once it is ready to install; `None` when the running
/// version is current, which also drops an update held from another channel.
#[tauri::command]
pub async fn update_fetch(
  app: AppHandle,
  pending: State<'_, Pending>,
  channel: String,
) -> Result<Option<ReadyUpdate>, String> {
  if !update_enabled(app.clone()) {
    return Ok(None);
  }
  if channel != "stable" && channel != "nightly" {
    return Err(format!("Unknown update channel {channel}"));
  }
  let manifest = Url::parse(&format!("{MANIFESTS}/{channel}/latest.json")).map_err(error)?;
  let found = app
    .updater_builder()
    .endpoints(vec![manifest])
    .map_err(error)?
    .build()
    .map_err(error)?
    .check()
    .await
    .map_err(error)?;
  let Some(update) = found else {
    *pending.0.lock().unwrap() = None;
    return Ok(None);
  };
  let ready = ReadyUpdate { version: update.version.clone() };
  // A version is one commit, so a held download of the same version is the same build.
  if pending.0.lock().unwrap().as_ref().is_some_and(|(held, _)| held.version == update.version) {
    return Ok(Some(ready));
  }
  // `download` verifies the signature against the public key before returning the bytes.
  let bytes = update.download(|_, _| {}, || {}).await.map_err(error)?;
  *pending.0.lock().unwrap() = Some((update, bytes));
  Ok(Some(ready))
}

/// Installs the held update and restarts into it. On Windows the installer closes the app itself.
#[tauri::command]
pub fn update_install(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
  let Some((update, bytes)) = pending.0.lock().unwrap().take() else {
    return Err("No update is ready to install.".into());
  };
  update.install(&bytes).map_err(error)?;
  app.restart()
}
