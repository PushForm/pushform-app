// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Keep the startup window on screen: a window larger than the monitor's work area (the screen minus the taskbar) is
//! shrunk to fit and centered in it, so its edges and its title bar are always reachable.

use tauri::{PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

/// A rectangle in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
  pub x: i32,
  pub y: i32,
  pub width: u32,
  pub height: u32,
}

/// The window's new frame when its outer frame does not fit inside the work area, or None when it already fits.
pub fn fit(window: Rect, work: Rect) -> Option<Rect> {
  let inside = window.x >= work.x
    && window.y >= work.y
    && i64::from(window.x) + i64::from(window.width) <= i64::from(work.x) + i64::from(work.width)
    && i64::from(window.y) + i64::from(window.height) <= i64::from(work.y) + i64::from(work.height);
  if inside {
    return None;
  }
  let width = window.width.min(work.width);
  let height = window.height.min(work.height);
  let x = work.x + ((work.width - width) / 2) as i32;
  let y = work.y + ((work.height - height) / 2) as i32;
  Some(Rect { x, y, width, height })
}

/// Shrink and center the window inside the work area of the monitor it opened on. Failures leave the window as it is.
pub fn fit_to_monitor<R: Runtime>(window: &WebviewWindow<R>) {
  let Ok(Some(monitor)) = window.current_monitor().or_else(|_| window.primary_monitor()) else { return };
  let (Ok(position), Ok(outer), Ok(inner)) = (window.outer_position(), window.outer_size(), window.inner_size()) else { return };
  let area = monitor.work_area();
  let work = Rect { x: area.position.x, y: area.position.y, width: area.size.width, height: area.size.height };
  let frame = Rect { x: position.x, y: position.y, width: outer.width, height: outer.height };
  let Some(next) = fit(frame, work) else { return };
  // set_size sets the inner size; keep any border the platform adds outside it.
  let border_w = outer.width.saturating_sub(inner.width);
  let border_h = outer.height.saturating_sub(inner.height);
  let _ = window.set_size(PhysicalSize::new(next.width.saturating_sub(border_w), next.height.saturating_sub(border_h)));
  let _ = window.set_position(PhysicalPosition::new(next.x, next.y));
}

#[cfg(test)]
mod tests {
  use super::*;

  const WORK: Rect = Rect { x: 0, y: 0, width: 1920, height: 1032 };

  #[test]
  fn leaves_a_window_that_fits_alone() {
    assert_eq!(fit(Rect { x: 100, y: 50, width: 1400, height: 900 }, WORK), None);
  }

  #[test]
  fn shrinks_a_window_taller_than_the_screen_and_centers_it() {
    // A 1400 × 900 logical window at 150% scaling on a 1080p screen whose taskbar takes 48 px.
    let work = Rect { x: 0, y: 0, width: 1920, height: 1032 };
    let next = fit(Rect { x: 210, y: 90, width: 2100, height: 1350 }, work).unwrap();
    assert_eq!(next, Rect { x: 0, y: 0, width: 1920, height: 1032 });
  }

  #[test]
  fn keeps_the_size_that_fits_and_moves_the_window_back_on_screen() {
    let next = fit(Rect { x: 900, y: 300, width: 1400, height: 900 }, WORK).unwrap();
    assert_eq!(next, Rect { x: 260, y: 66, width: 1400, height: 900 });
  }

  #[test]
  fn fits_inside_a_secondary_monitor_with_a_negative_origin() {
    let work = Rect { x: -1366, y: 0, width: 1366, height: 728 };
    let next = fit(Rect { x: -1366, y: 0, width: 1400, height: 900 }, work).unwrap();
    assert_eq!(next, work);
  }
}
