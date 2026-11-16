// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
#![allow(clippy::unwrap_used, clippy::panic)]
//! The parts of a result come in the file's order every time, although the reader converts solids on several threads
//! and finishes them in a different order from run to run.

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
    fn pad(&mut self) { self.at = (self.at + 7) & !7; }
    fn text(&mut self) -> String {
        let n = self.u32() as usize;
        let s = String::from_utf8(self.bytes[self.at..self.at + n].to_vec()).unwrap();
        self.at += n; self.pad(); s
    }
    /// A counted run of values of `size` bytes, padded after (the 8-byte runs are padded before as well).
    fn run(&mut self, size: usize) { let n = self.u32() as usize; if size == 8 { self.pad(); } self.at += n * size; self.pad(); }
}

/// The names and colors (red channel, -1 for none) of the parts of a `PFSTEP01` result, in order.
fn parts(bytes: &[u8]) -> Vec<(String, f32)> {
    assert_eq!(&bytes[..8], b"PFSTEP01");
    let mut r = Reader { bytes, at: 8 };
    let count = r.u32(); r.pad();
    (0..count).map(|_| {
        let name = r.text();
        let _closed = r.u32();
        let red = f32::from_le_bytes(r.bytes[r.at..r.at + 4].try_into().unwrap());
        r.at += 12;
        let _faces = r.u32(); r.pad();
        r.run(8); r.run(4); r.run(4); r.run(4); r.run(8);
        let flags = r.u32() as usize; r.at += flags; r.pad();
        (name, red)
    }).collect()
}

#[test]
fn parts_come_in_file_order_whatever_order_the_threads_finish_them() {
    // Solids of very different weight, so a thread that gets a small one finishes it first.
    let bodies: Vec<(String, Body)> = (0..8).map(|i| (format!("part{i}"), cuboid([i as f64 * 100.0, 0.0, 0.0], [10.0 + 40.0 * ((i * 5) % 8) as f64, 20.0, 30.0]))).collect();
    let export: Vec<ExportBody> = bodies.iter().enumerate()
        .map(|(i, (name, body))| ExportBody { name: name.clone(), body, color: (i % 2 == 1).then_some([0.0, 0.0, 1.0]) })
        .collect();
    let text = step_export_bodies(&export, &StepHeader::default()).unwrap();
    let expected: Vec<(String, f32)> = (0..8).map(|i| (format!("part{i}"), if i % 2 == 1 { 0.0 } else { -1.0 })).collect();
    // Red is 0 for the blue parts and -1 for the uncolored; the same each run.
    let first = parts(&pushform_step_reader::convert_native(&text, 7, 0, |_, _, _| true, |_| {}).unwrap());
    assert_eq!(first, expected);
    for _ in 0..40 {
        let again = parts(&pushform_step_reader::convert_native(&text, 7, 0, |_, _, _| true, |_| {}).unwrap());
        assert_eq!(again, expected);
    }
}
