# Importing and exporting models

## Open or import a SketchUp model

Open a supported **.skp** or **.skb** file to make it the model you work on, or use Import to bring content into the current model. Review the conversion report for unsupported data or changes.

Imported models can retain hierarchy, materials, textures, curves, annotations, images and section information where supported. A successful import is not a guarantee that every SketchUp feature is editable in PushForm. Keep the source file for comparison.

## Import other model formats

Model import supports formats including COLLADA, OBJ, 3DS, STL, glTF, DXF and STEP. For OBJ, 3DS and unitless DXF, check the import units so the model is the intended size. Supply related material and picture files with the source where its format requires them.

Read the import notes for omitted annotations, materials or unsupported objects. DXF import handles supported drawing geometry and blocks but does not import every CAD entity type.

## Import STEP files from CAD tools

Open or import **.step** and **.stp** files from mechanical CAD tools. STEP files store their units, so there are no import options. Each distinct part becomes a component named after the part, placed wherever the file places it, and assemblies become groups that hold their parts. Part colors become materials. STEP parts always come in as mesh parts (see below), so even large assemblies open quickly; right-click a part and choose **Make Editable** when you want to push/pull or paint its faces. Curved surfaces become smoothed facets, with 24 per full circle; flat faces stay whole.

The first STEP import in the browser downloads the reader, about 2 MB; it then converts on several of your processor's cores. The desktop app converts with code built into the app, on all cores, which is faster still. A part the file places many times becomes one component placed many times. The file is converted on your computer and is not uploaded. Large assemblies can take a minute or more; the import dialog shows how many parts are converted and meshed and how much memory the reader is using, and Cancel stops the import at any point. The desktop app opens STEP files up to 256 MB; in the browser the limit is 128 MB. Very large assemblies can still be too big for the reader, and the import then stops with a message.

A part that does not form a closed solid is imported as editable faces, and the import notes name it. Very small detail, below about 0.03 mm, can be lost. Product data, tolerances and annotations are not imported.

## Large models import as mesh parts

A STEP file, and any other model file with more than 250,000 triangles in total, imports as **mesh parts** instead of editable faces, so large CAD assemblies open in seconds and stay light. A mesh part is drawn like any other object, with its colors and edges, and you can select, move, rotate, scale, copy, hide, tag and paint it as a whole, and export it. It has no individual faces or edges to pick until it is made editable: right-click it and choose **Make Editable** to turn that part into ordinary faces and edges (solids where it is closed, loose faces where it is not), keeping its colors, tag and material. Only that part is converted, so a large assembly stays light. Entity Info shows that an object is a mesh part, where it came from and how many triangles it holds. Files with mesh parts need this version of PushForm or newer to open.

## Save an editable native copy

Use **Main menu > Download a copy…** to keep an editable `.pf` model on your computer. Open that file through the same menu to restore its components, materials and stored images. Cloud saves and downloaded model copies use the same native format. Keep the original imported file if you also need to open it in its source application.

Opening a native model or restoring a binary recovery checkpoint fits the model into view. Saved scene views remain available; the previous unsaved camera position is not restored.

## Export for 3D printing

Use **Export…** and choose **STL**. Choose units and binary or ASCII output. Millimeters are the default because STL does not store its own unit.

You can export only selected geometry when a selection exists. Check the export notes if the model contains sheet faces: those are not closed solids. Hidden items are omitted; a visible solid exports all faces needed to remain closed.

## Export a model to another 3D application

In Export, choose **glTF**, **OBJ**, or **COLLADA** (see below for STEP). The dialog offers the format's options and a save destination. Supported visible geometry and materials are exported; guides, dimensions, model text and section planes are not part of these geometry exports.

Review export notes for unavailable textures or other omissions. Exporting does not replace the native document or change its saved identity.

## Export a STEP file for CAD tools

In Export, choose **STEP** to write a **.step** file that FreeCAD and other CAD tools open. Parts keep their names and colors, components become assemblies with their placements, and a component placed many times is written once. The file is in millimeters. Check **Export selected geometry only** to write just the selection.

The file is written on your computer and is not uploaded. The first STEP export in the browser downloads the converter, about 2 MB; the desktop app converts with code built into the app. The dialog stays open while the model is converted, and Cancel stops it.

STEP exports are approximate in a few ways, and the export notes list them:

- Curved surfaces are written as flat facets, as they are drawn, so a cylinder is a ring of narrow strips rather than a true cylinder. CAD tools can measure and cut it, but cannot edit it as a cylinder.
- Mesh parts, such as imported STEP parts that were not made editable, are written as faceted solids. The notes name them and give their triangle counts, and large ones make large files.
- Solids that close are written as solids. Faces that do not close, such as sheet faces, are written as surfaces.
- A component placed with a mirror or a different scale is written already moved, so it is no longer shared with the component it came from.
- Guides, dimensions, model text, section planes and loose edges are not exported.

## Export the current model view as a picture

Choose **PNG** or **JPEG** in Export for a 2D image of the model view. Check framing and output settings before saving. A picture is a rendered view, not editable 3D geometry.

Use a native model file when you need to continue editing the model later.

## Export a native editable copy

Choose **Main menu → Export…**, select **PushForm Model (.pf)** in **Format**, then click **Export…** and choose where to save. Browsers without a save picker download the file. This exports the entire document with its embedded assets. It keeps the open document’s name, cloud destination and saved state. There is no separate Download a copy menu item.

### Failed imports

If a supported file fails during import, PushForm automatically saves the original file and import report in a hidden, private folder on your account and queues a support ticket. Your file stays in PushForm and can be retrieved only by you and authorized administrators; it is not attached to the ticket or shared with other users. Cancelled imports do not create tickets. If you are offline or the upload cannot finish, the original error still appears, but the file may not be saved for support.

## Export a SketchUp model

Choose **Export… → SketchUp (.skp)** to write visible geometry, or check **Export selected geometry only**. The file is written locally in the 2017 format, with meters converted to inches. Each face is written as one face with its holes, and soft, smooth and hidden edges keep their settings, so curved surfaces look smooth. Components retain placements, names and the paint on each placement; every material of the model is included (a selection includes the materials it uses), with colors and PNG/JPEG textures. Arcs and circles become plain edges. Hidden content is omitted. A face that encloses no area is left out, a face that is not quite flat is written as triangles with hidden edges between them, and a texture whose placement cannot be written uses its default placement; the export notes count these. Tags, scenes, display settings, guides, dimensions, text and section planes are not preserved; review the export notes. Exporting keeps the native document and its saved state.
