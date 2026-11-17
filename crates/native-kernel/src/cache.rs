// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Least-recently-used cache of solids keyed by body id and version. Ids are JavaScript numbers, matched as a
//! `Map` with `"id:version"` string keys would match them.
use std::collections::VecDeque;
use std::sync::Arc;

use manifold_csg::Manifold;

use crate::meshio::ReadMesh;
use crate::normalize::number_key;

pub struct CacheEntry {
  pub manifold: Manifold,
  pub run_id: u32,
  pub mesh: ReadMesh,
}

pub struct BodyCache {
  capacity: usize,
  entries: VecDeque<(f64, f64, Arc<CacheEntry>)>,
}

fn same(a: f64, b: f64) -> bool {
  number_key(a) == number_key(b)
}

impl BodyCache {
  pub fn new(capacity: usize) -> Self {
    Self { capacity, entries: VecDeque::new() }
  }

  /// The entry, marked most recently used.
  pub fn get(&mut self, body_id: f64, version: f64) -> Option<Arc<CacheEntry>> {
    let i = self.entries.iter().position(|(b, v, _)| same(*b, body_id) && same(*v, version))?;
    let hit = self.entries.remove(i).unwrap();
    let entry = hit.2.clone();
    self.entries.push_back(hit);
    Some(entry)
  }

  /// Inserts, replacing any previous entry for the key and evicting the least recently used entries past capacity.
  pub fn set(&mut self, body_id: f64, version: f64, entry: Arc<CacheEntry>) {
    self.entries.retain(|(b, v, _)| !(same(*b, body_id) && same(*v, version)));
    self.entries.push_back((body_id, version, entry));
    while self.entries.len() > self.capacity {
      self.entries.pop_front();
    }
  }

  /// Removes one version, or every version of a body when `version` is `None`; returns how many.
  pub fn release(&mut self, body_id: f64, version: Option<f64>) -> usize {
    let before = self.entries.len();
    self.entries.retain(|(b, v, _)| !(same(*b, body_id) && version.is_none_or(|want| same(want, *v))));
    before - self.entries.len()
  }

  pub fn clear(&mut self) {
    self.entries.clear();
  }

  pub(crate) fn len(&self) -> usize {
    self.entries.len()
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use manifold_csg::Manifold;

  fn entry() -> Arc<CacheEntry> {
    Arc::new(CacheEntry { manifold: Manifold::cube(1.0, 1.0, 1.0, false), run_id: 1, mesh: ReadMesh { verts: vec![], tris: vec![], run_id: vec![], face_id: vec![] } })
  }

  #[test]
  fn evicts_least_recently_used_and_refreshes_on_get() {
    let mut cache = BodyCache::new(2);
    cache.set(1.0, 1.0, entry());
    cache.set(2.0, 1.0, entry());
    assert!(cache.get(1.0, 1.0).is_some());
    cache.set(3.0, 1.0, entry());
    assert!(cache.get(2.0, 1.0).is_none());
    assert!(cache.get(1.0, 1.0).is_some());
    assert!(cache.get(3.0, 1.0).is_some());
  }

  #[test]
  fn releases_versions() {
    let mut cache = BodyCache::new(4);
    cache.set(1.0, 1.0, entry());
    cache.set(1.0, 2.0, entry());
    cache.set(2.0, 1.0, entry());
    assert_eq!(cache.release(1.0, Some(2.0)), 1);
    assert_eq!(cache.release(1.0, None), 1);
    assert_eq!(cache.len(), 1);
  }
}
