// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
//! Writes the DWG drawings the tests read (`packages/io/src/__fixtures__/dwg`):
//!   cargo run --example fixture -- ../../packages/io/src/__fixtures__/dwg
//! `plan-mm.dwg` records millimeters; `plan-unitless.dwg` records no units and was started in imperial units.
//! Each holds a line, a circle, an arc and a text on the layer Walls.

use acadrust::entities::{Arc, Circle, EntityType, Line, Text};
use acadrust::tables::Layer;
use acadrust::types::{Color, Vector3};
use acadrust::{CadDocument, DwgWriter, DxfVersion};

fn drawing(units: i16, measurement: i16) -> CadDocument {
    let mut document = CadDocument::with_version(DxfVersion::AC1027);
    document.header.insertion_units = units;
    document.header.measurement = measurement;
    document
        .layers
        .add(Layer::with_color("Walls", Color::from_index(1)))
        .unwrap();
    let on_walls = |mut entity: EntityType| {
        entity.common_mut().layer = "Walls".to_string();
        entity
    };
    let entities = [
        EntityType::Line(Line::from_coords(0.0, 0.0, 0.0, 4000.0, 0.0, 0.0)),
        EntityType::Circle(Circle::from_coords(1000.0, 1000.0, 0.0, 250.0)),
        EntityType::Arc(Arc::from_coords(
            3000.0,
            1000.0,
            0.0,
            500.0,
            0.0,
            std::f64::consts::FRAC_PI_2,
        )),
        EntityType::Text(
            Text::with_value("PLAN", Vector3::new(500.0, 2000.0, 0.0)).with_height(200.0),
        ),
    ];
    for entity in entities {
        document.add_entity(on_walls(entity)).unwrap();
    }
    document
}

fn main() {
    let directory = std::env::args()
        .nth(1)
        .expect("the directory to write the drawings to");
    std::fs::create_dir_all(&directory).unwrap();
    DwgWriter::write_to_file(format!("{directory}/plan-mm.dwg"), &drawing(4, 1)).unwrap();
    DwgWriter::write_to_file(format!("{directory}/plan-unitless.dwg"), &drawing(0, 0)).unwrap();
}
