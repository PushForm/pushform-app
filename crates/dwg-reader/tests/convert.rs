// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
use acadrust::entities::{Circle, EntityType, Line};
use acadrust::{CadDocument, DwgWriter, DxfVersion};
use pushform_dwg_reader::{convert, is_dwg};

/// A small drawing written as DWG in the given format version.
fn drawing(version: DxfVersion) -> Vec<u8> {
    let mut document = CadDocument::with_version(version);
    document
        .add_entity(EntityType::Line(Line::from_coords(
            0.0, 0.0, 0.0, 100.0, 50.0, 0.0,
        )))
        .unwrap();
    document
        .add_entity(EntityType::Circle(Circle::from_coords(
            10.0, 20.0, 0.0, 5.0,
        )))
        .unwrap();
    DwgWriter::write_to_vec(&document).unwrap()
}

#[test]
fn converts_each_format_version_to_dxf_text() {
    for version in [
        DxfVersion::AC1015,
        DxfVersion::AC1018,
        DxfVersion::AC1024,
        DxfVersion::AC1027,
        DxfVersion::AC1032,
    ] {
        let bytes = drawing(version);
        assert!(is_dwg(&bytes));
        let converted = convert(&bytes).unwrap();
        assert_eq!(converted.version, version.as_str());
        let text = String::from_utf8_lossy(&converted.dxf);
        assert!(text.trim_start().starts_with("0\r\nSECTION"), "{version:?}");
        assert!(
            text.contains("\nLINE\r\n") && text.contains("\nCIRCLE\r\n"),
            "{version:?}"
        );
        assert!(converted.notes.is_empty(), "{:?}", converted.notes);
    }
}

#[test]
fn rejects_other_files() {
    assert!(!is_dwg(b"0\nSECTION"));
    assert!(convert(b"not a drawing").is_err());
    assert!(convert(b"AC1027 and then nothing a drawing holds").is_err());
}

#[test]
fn a_truncated_drawing_is_rejected_or_reported() {
    let bytes = drawing(DxfVersion::AC1027);
    for cut in [2, 3, 10] {
        match convert(&bytes[..bytes.len() / cut]) {
            Ok(converted) => assert!(
                !converted.notes.is_empty(),
                "missing content must be reported"
            ),
            Err(message) => assert!(message.contains("DWG")),
        }
    }
}
