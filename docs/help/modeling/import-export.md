# Importing and exporting models

## Open or import a SketchUp model

Open a supported **.skp** or **.skb** file to make it the model you work on, or use Import to bring content into the current model. Review the conversion report for unsupported data or changes.

Imported models can retain hierarchy, materials, textures, curves, annotations, images and section information where supported. A successful import is not a guarantee that every SketchUp feature is editable in PushForm. Keep the source file for comparison.

## Import other model formats

Model import supports formats including COLLADA, OBJ, 3DS, STL, glTF and DXF. For OBJ, 3DS and unitless DXF, check the import units so the model is the intended size. Supply related material and picture files with the source where its format requires them.

Read the import notes for omitted annotations, materials or unsupported objects. DXF import handles supported drawing geometry and blocks but does not import every CAD entity type.

## Save an editable native copy

Use **Main menu > Download a copy…** to keep an editable `.pf` model on your computer. Open that file through the same menu to restore its components, materials and stored images. Cloud saves and downloaded model copies use the same native format. Keep the original imported file if you also need to open it in its source application.

Opening a native model or restoring a binary recovery checkpoint fits the model into view. Saved scene views remain available; the previous unsaved camera position is not restored.

## Export for 3D printing

Use **Export…** and choose **STL**. Choose units and binary or ASCII output. Millimeters are the default because STL does not store its own unit.

You can export only selected geometry when a selection exists. Check the export notes if the model contains sheet faces: those are not closed solids. Hidden items are omitted; a visible solid exports all faces needed to remain closed.

## Export a model to another 3D application

In Export, choose **glTF**, **OBJ**, or **COLLADA**. The dialog offers the format's options and a save destination. Supported visible geometry and materials are exported; guides, dimensions, model text and section planes are not part of these geometry exports.

Review export notes for unavailable textures or other omissions. Exporting does not replace the native document or change its saved identity.

## Export the current model view as a picture

Choose **PNG** or **JPEG** in Export for a 2D image of the model view. Check framing and output settings before saving. A picture is a rendered view, not editable 3D geometry.

Use a native model file when you need to continue editing the model later.

## Export a native editable copy

Choose **Main menu → Export…**, select **PushForm Model (.pf)** in **Format**, then click **Export…** and choose where to save. Browsers without a save picker download the file. This exports the entire document with its embedded assets. It keeps the open document’s name, cloud destination and saved state. There is no separate Download a copy menu item.
