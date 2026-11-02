# Materials, tags and styles in Modeling

## Paint a face or selection

Choose **Paint Bucket** to open Materials. Choose a material and click the intended target. If the clicked object belongs to the selection, paint applies to the selected paintable entities; clicking outside the selection affects the clicked entity instead.

On a face, the side facing the camera is painted. Painting a group or component supplies its default material, but explicitly painted faces inside it keep their own materials.

## Sample or replace materials

Use **Sample** in Materials or hold Alt with Paint Bucket and click to sample a material. Choose the replacement material, then hold Ctrl and click to fill edge-connected faces with the same material. Shift+click replaces the clicked material throughout the current editing context; Ctrl+Shift+click replaces it on the clicked object.

On a Mac, Ctrl+click opens the context menu, so the keys differ: Option+click fills edge-connected faces, Option+Shift+click replaces on the clicked object, and Cmd+click samples. The status bar names the keys for your platform.

Check the tool's status and active mode before clicking when you want only one face painted. A broad replacement is different from ordinary painting; Undo reverses the applied change.

## Organize visibility with tags

Assign selected entities to a tag through **Entity Info**. The selection can contain several eligible objects; a mixed tag selection shows no single common tag until one is chosen.

A hidden tag or a hidden folder containing it removes those entities from drawing, selection and snapping. Show the tag and its parent folders to make them available again.

## Assign tags with the Tag tool

In **Tags**, use the pencil control to set the active tag. Choose the **Tag** tool, then click an entity in the current editing context to assign that tag. A group or component receives the tag as a whole. With no active tag selected, the tool assigns **Untagged**.

Check the tag named in the status before clicking. Each click applies immediately; Undo reverses an assignment. To tag a selection together, use its Tag field in Entity Info instead.

## Change the model's display style

Use Styles for the background, face display and supported edge settings. Front and back face colors affect faces using the default material. X-ray opacity affects the translucent view. Selection and guide colors control their overlays.

Settings that are not rendered yet are disabled with an explanation. Changing display colors does not paint the underlying faces.

## Soften, smooth or hide an edge

Select the edge and use **Soft**, **Smooth**, or **Hidden** in Entity Info where available. Hiding an edge changes its display; it does not remove the boundary needed by a solid.

To inspect hidden edges or faces, enable **Hidden Geometry**. Hiding and unhiding can be undone like other document changes.

In **Materials → Select**, materials always appear as square previews. Hover a swatch to see its name, and click it to choose that material. Use the library picker to browse categories; switching libraries keeps your active material.

The library includes 338 tileable image textures:

| Category | Materials |
| --- | ---: |
| Wood | 50 |
| Brick | 30 |
| Ceramic | 26 |
| Concrete & Asphalt | 50 |
| Stone | 50 |
| Metal | 26 |
| Terrain | 50 |
| Textiles (including leather) | 44 |
| Plastic (including rubber) | 6 |
| Organic | 6 |

Colors provides 24 solid colors, and Glass offers six transparent tints. Ceramic replaces the former Tile category. Some paving and block materials now appear under Brick.

The square previews show the actual surface image. Full textures load when you choose a material and use real-world repeat sizes, which you can adjust in **Edit**. Rectangular textures retain their proportions. When you add a library texture, its image is saved with your document. The library ships with the app and needs no external texture service.

The textured finishes use CC0 color maps from [Poly Haven](https://polyhaven.com/license). They provide surface color and pattern; glass tints provide transparency. These presets do not add reflection, refraction, or surface relief.
