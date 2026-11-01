// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
#![allow(clippy::unwrap_used, clippy::panic)]
//! Previews handed out while a file is read: every part and placement of the result arrives in exactly one preview,
//! and each preview decodes as `write_preview` lays it out.

use solidcraft_geom::Vec3;
use solidcraft_kernel::*;

fn quad(a: usize, b: usize, c: usize, d: usize) -> PolygonFace {
    PolygonFace { outline: vec![a, b, c, d], holes: vec![] }
}

/// A box of the given size with its low corner at `at` (millimeters).
fn cuboid(at: [f64; 3], size: [f64; 3]) -> Body {
    let v: Vec<Vec3> = (0..8)
        .map(|i| Vec3::new(at[0] + if i & 1 == 0 { 0.0 } else { size[0] }, at[1] + if i & 2 == 0 { 0.0 } else { size[1] }, at[2] + if i & 4 == 0 { 0.0 } else { size[2] }))
        .collect();
    let f = vec![quad(0, 2, 3, 1), quad(4, 5, 7, 6), quad(0, 1, 5, 4), quad(2, 6, 7, 3), quad(0, 4, 6, 2), quad(1, 3, 7, 5)];
    body_from_polygons(&v, &f).unwrap()
}

struct Reader<'a> { bytes: &'a [u8], at: usize }
impl Reader<'_> {
    fn u32(&mut self) -> u32 { let v = u32::from_le_bytes(self.bytes[self.at..self.at + 4].try_into().unwrap()); self.at += 4; v }
    fn f32(&mut self) -> f32 { let v = f32::from_le_bytes(self.bytes[self.at..self.at + 4].try_into().unwrap()); self.at += 4; v }
    fn f64(&mut self) -> f64 { let v = f64::from_le_bytes(self.bytes[self.at..self.at + 8].try_into().unwrap()); self.at += 8; v }
    fn pad(&mut self) { self.at = (self.at + 7) & !7; }
    /// A counted run of 4-byte values, padded after.
    fn run(&mut self) -> usize { let n = self.u32() as usize; self.at += n * 4; self.pad(); n }
}

/// (part jobs, placement jobs) of one preview buffer.
fn decode_preview(bytes: &[u8]) -> (Vec<u32>, Vec<u32>) {
    assert_eq!(&bytes[..8], b"PFPREV01");
    let mut r = Reader { bytes, at: 8 };
    let parts = r.u32(); r.pad();
    let mut jobs = Vec::new();
    for _ in 0..parts {
        jobs.push(r.u32());
        let red = r.f32(); let _ = (r.f32(), r.f32());
        assert!(red == -1.0 || (0.0..=1.0).contains(&red));
        r.pad();
        let positions = r.run();
        let triangles = r.run();
        let segments = r.run();
        assert!(positions > 0 && positions % 3 == 0 && triangles > 0 && triangles % 3 == 0 && segments % 6 == 0);
    }
    let count = r.u32(); r.pad();
    let mut placed = Vec::new();
    for _ in 0..count {
        placed.push(r.u32()); r.pad();
        let m: Vec<f64> = (0..16).map(|_| r.f64()).collect();
        assert_eq!(m[15], 1.0);
    }
    assert_eq!(r.at, bytes.len());
    (jobs, placed)
}

#[test]
fn every_part_and_placement_arrives_in_one_preview_before_the_result() {
    let a = cuboid([0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let b = cuboid([50.0, 0.0, 0.0], [5.0, 5.0, 5.0]);
    let text = step_export_bodies(
        &[ExportBody { name: "a".into(), body: &a, color: Some([1.0, 0.0, 0.0]) }, ExportBody { name: "b".into(), body: &b, color: None }],
        &StepHeader::default(),
    )
    .unwrap();
    let mut previews = Vec::new();
    let result = pushform_step_reader::convert_native(&text, 7, 0, |_, _, _| true, |buffer| previews.push(buffer)).unwrap();
    assert_eq!(&result[..8], b"PFSTEP01");
    let result_parts = u32::from_le_bytes(result[8..12].try_into().unwrap()) as usize;
    assert!(!previews.is_empty());
    let (mut jobs, mut placed) = (Vec::new(), Vec::new());
    for buffer in &previews {
        let (j, p) = decode_preview(buffer);
        jobs.extend(j);
        placed.extend(p);
    }
    // Each part once, each placement once, and every placement after (or with) its part.
    let mut unique = jobs.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), jobs.len());
    assert_eq!(jobs.len(), result_parts);
    assert_eq!(placed.len(), 2);
    for job in &placed { assert!(jobs.contains(job)); }
}
