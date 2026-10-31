// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
#![allow(clippy::unwrap_used, clippy::panic)]
//! A request in the app's wire format becomes a STEP file that reads back with its structure, names and colour.

use pushform_step_reader::export_step;
use solidcraft_kernel::step_import;

fn string(out: &mut Vec<u8>, s: &str) {
    out.extend((s.len() as u32).to_le_bytes());
    out.extend(s.as_bytes());
}

/// A 0.1 × 0.2 × 0.3 m box part named "Block", coloured red.
fn block(out: &mut Vec<u8>) {
    string(out, "Block");
    out.push(1);
    for c in [1.0f32, 0.0, 0.0, 1.0] {
        out.extend(c.to_le_bytes());
    }
    out.extend(8u32.to_le_bytes());
    for i in 0..8u32 {
        for (bit, size) in [(1, 0.1f64), (2, 0.2), (4, 0.3)] {
            out.extend((if i & bit != 0 { size } else { 0.0 }).to_le_bytes());
        }
    }
    let faces: [[u32; 4]; 6] = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    out.extend(6u32.to_le_bytes());
    for (k, f) in faces.into_iter().enumerate() {
        // The top face (the second) is blue.
        out.push((k == 1) as u8);
        if k == 1 {
            for c in [0.0f32, 0.0, 1.0, 1.0] {
                out.extend(c.to_le_bytes());
            }
        }
        out.extend(1u32.to_le_bytes());
        out.extend(4u32.to_le_bytes());
        f.iter().for_each(|i| out.extend(i.to_le_bytes()));
    }
}

fn request() -> Vec<u8> {
    let mut out = b"PFSTEPX1".to_vec();
    for s in ["Shelf.step", "", "", "", ""] {
        string(&mut out, s);
    }
    out.extend(1u32.to_le_bytes()); // root: the second product
    out.extend(2u32.to_le_bytes());
    string(&mut out, "Block");
    out.extend(1u32.to_le_bytes());
    block(&mut out);
    out.extend(0u32.to_le_bytes());
    string(&mut out, "Shelf");
    out.extend(0u32.to_le_bytes());
    out.extend(2u32.to_le_bytes());
    for x in [0.0f64, 1.0] {
        out.extend(0u32.to_le_bytes());
        for (c, row) in [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [x, 0.0, 0.0, 1.0]].iter().enumerate() {
            let _ = c;
            row.iter().for_each(|v| out.extend(f64::to_le_bytes(*v)));
        }
        string(&mut out, "Block placement");
    }
    out
}

#[test]
fn a_request_with_two_placements_of_one_part_reads_back_as_two_bodies() {
    let mut steps = Vec::new();
    let text = export_step(&request(), |done, total| {
        steps.push((done, total));
        true
    })
    .unwrap();
    assert_eq!(steps.last(), Some(&(1, 1)));
    assert!(text.contains("NEXT_ASSEMBLY_USAGE_OCCURRENCE") && text.contains("'Block'"), "{text}");
    let back = step_import(&text).unwrap();
    assert!(back.warnings.is_empty(), "{:?}", back.warnings);
    assert_eq!(back.bodies.len(), 2, "one body per placement");
    assert!(back.bodies.iter().all(|b| b.name == "Block" && b.color.is_some()));
    // The red part keeps one face of its own, blue.
    assert!(text.contains("COLOUR_RGB('',1.0,0.0,0.0)") && text.contains("COLOUR_RGB('',0.0,0.0,1.0)"), "{text}");
    assert_eq!(back.tree.len(), 1);
    let xs: Vec<f64> = back.tree[0].children.iter().map(|c| c.transform[3][0]).collect();
    assert!(xs.iter().any(|x| x.abs() < 1e-9) && xs.iter().any(|x| (x - 1000.0).abs() < 1e-9), "{xs:?}");
    // Millimeters in the file: 100 × 200 × 300.
    for b in &back.bodies {
        assert!((b.body.volume_at(1e-3).unwrap() - 6.0e6).abs() < 1.0);
    }
}

#[test]
fn a_cancelled_export_and_a_damaged_request_fail() {
    assert_eq!(export_step(&request(), |_, _| false).unwrap_err(), "cancelled");
    let r = request();
    assert!(export_step(&r[..r.len() - 5], |_, _| true).is_err());
    assert!(export_step(b"nonsense", |_, _| true).is_err());
}
