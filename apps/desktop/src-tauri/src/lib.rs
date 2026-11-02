// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
mod updates;
mod clipboard;
mod step;
mod window_fit;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage(updates::Pending::default())
    .manage(clipboard::State::default())
    .invoke_handler(tauri::generate_handler![
      clipboard::layout_clipboard_write,
      clipboard::layout_clipboard_read,
      updates::update_enabled,
      updates::update_fetch,
      updates::update_install,
      step::step_convert,
      step::step_export,
      step::step_cancel
    ])
    .setup(|app| {
      use tauri::Manager;
      if let Some(window) = app.get_webview_window("main") {
        // macOS keeps its traffic lights over the overlay title bar; elsewhere the app draws its own window controls.
        #[cfg(not(target_os = "macos"))]
        window.set_decorations(false)?;
        // Without a native title bar the window cannot be dragged back once its edge is off screen, so it opens inside the screen.
        window_fit::fit_to_monitor(&window);
      }
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
