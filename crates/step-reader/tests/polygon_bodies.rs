// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
#![allow(clippy::unwrap_used, clippy::panic)]
//! Bodies built from planar polygon faces: a box, a box with a hole through it, an open sheet
//! and a mirrored copy, each written as STEP and read back.

use solidcraft_geom::Vec3;

use solidcraft_kernel::*;

fn quad(a: usize, b: usize, c: usize, d: usize) -> PolygonFace {
    PolygonFace { outline: vec![a, b, c, d], holes: vec![] }
}

/// A 10 × 20 × 30 box, faces wound outward (or inward when `inward`).
fn cuboid(inward: bool) -> (Vec<Vec3>, Vec<PolygonFace>) {
    let v: Vec<Vec3> = (0..8).map(|i| Vec3::new(if i & 1 == 0 { 0.0 } else { 10.0 }, if i & 2 == 0 { 0.0 } else { 20.0 }, if i & 4 == 0 { 0.0 } else { 30.0 })).collect();
    let mut f = vec![quad(0, 2, 3, 1), quad(4, 5, 7, 6), quad(0, 1, 5, 4), quad(2, 6, 7, 3), quad(0, 4, 6, 2), quad(1, 3, 7, 5)];
    if inward {
        for q in &mut f {
            q.outline.reverse();
        }
    }
    (v, f)
}

fn volume(b: &Body) -> f64 {
    b.volume_at(1e-3).unwrap()
}

fn export(b: &Body) -> String {
    step_export_bodies(&[ExportBody { name: "part".into(), body: b, color: None }], &StepHeader::default()).unwrap()
}

#[test]
fn a_closed_set_of_faces_is_a_solid_whichever_way_it_is_wound() {
    for inward in [false, true] {
        let (v, f) = cuboid(inward);
        let b = body_from_polygons(&v, &f).unwrap();
        assert!(!b.is_surface());
        assert_eq!(b.face_count(), 6);
        assert!((volume(&b) - 6000.0).abs() < 1e-3, "{}", volume(&b));
    }
}

#[test]
fn a_hole_in_a_face_is_kept_whichever_way_it_runs() {
    // A 40 × 40 × 10 plate with a 10 × 10 square hole through it.
    let mut v = Vec::new();
    for z in [0.0, 10.0] {
        for (x, y) in [(0.0, 0.0), (40.0, 0.0), (40.0, 40.0), (0.0, 40.0), (15.0, 15.0), (25.0, 15.0), (25.0, 25.0), (15.0, 25.0)] {
            v.push(Vec3::new(x, y, z));
        }
    }
    let side = |a: usize, b: usize, o: usize| quad(a, b, b + o, a + o);
    for hole_ccw in [false, true] {
        let hole = |base: usize| if hole_ccw { vec![base + 4, base + 5, base + 6, base + 7] } else { vec![base + 7, base + 6, base + 5, base + 4] };
        let mut f = vec![
            PolygonFace { outline: vec![0, 3, 2, 1], holes: vec![hole(0).into_iter().rev().collect()] },
            PolygonFace { outline: vec![8, 9, 10, 11], holes: vec![hole(8).into_iter().rev().collect()] },
        ];
        for k in 0..4 {
            f.push(side(k, (k + 1) % 4, 8));
            f.push(side(4 + (k + 1) % 4, 4 + k, 8));
        }
        let b = body_from_polygons(&v, &f).unwrap();
        assert!(!b.is_surface());
        assert!((volume(&b) - (16000.0 - 1000.0)).abs() < 1e-3, "{}", volume(&b));
    }
}

#[test]
fn faces_that_do_not_close_make_a_surface_that_exports_as_a_shell() {
    let (v, mut f) = cuboid(false);
    f.pop();
    let b = body_from_polygons(&v, &f).unwrap();
    assert!(b.is_surface());
    assert_eq!(b.face_count(), 5);
    let text = export(&b);
    assert!(text.contains("OPEN_SHELL(") && text.contains("SHELL_BASED_SURFACE_MODEL('part'") && !text.contains("CLOSED_SHELL"), "{text}");
    let back = step_import(&text).unwrap();
    assert_eq!(back.bodies.len(), 1);
    assert!(back.bodies[0].body.is_surface());
    assert_eq!(back.bodies[0].body.face_count(), 5);
}

#[test]
fn the_step_a_body_exports_as_reads_back_to_the_same_volume() {
    let (v, f) = cuboid(false);
    let b = body_from_polygons(&v, &f).unwrap();
    let back = step_import(&export(&b)).unwrap();
    assert_eq!(back.bodies.len(), 1);
    assert!((volume(&back.bodies[0].body) - 6000.0).abs() < 1e-3);
}

#[test]
fn a_mirrored_copy_is_a_solid_of_the_same_volume() {
    let (v, f) = cuboid(false);
    let mirrored: Vec<Vec3> = v.iter().map(|p| Vec3::new(-p.x, p.y, p.z)).collect();
    // Mirroring turns the faces inside out, so the placement reverses their loops.
    let flipped: Vec<PolygonFace> = f.iter().map(|q| PolygonFace { outline: q.outline.iter().rev().copied().collect(), holes: vec![] }).collect();
    let b = body_from_polygons(&mirrored, &flipped).unwrap();
    assert!(!b.is_surface());
    assert!((volume(&b) - 6000.0).abs() < 1e-3);
}

#[test]
fn bad_loops_are_refused() {
    let (v, _) = cuboid(false);
    assert!(body_from_polygons(&v, &[]).is_err());
    assert!(body_from_polygons(&v, &[PolygonFace { outline: vec![0, 1], holes: vec![] }]).is_err());
    assert!(body_from_polygons(&v, &[PolygonFace { outline: vec![0, 1, 99], holes: vec![] }]).is_err());
    assert!(body_from_polygons(&v, &[PolygonFace { outline: vec![0, 0, 1], holes: vec![] }]).is_err());
}
