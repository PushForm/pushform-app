# Materials, tags and styles in Modeling

## Paint a face or selection

Choose **Paint Bucket** to open Materials. Choose a material and click the intended target. If the clicked object belongs to the selection, paint applies to the selected paintable entities; clicking outside the selection affects the clicked entity instead.

On a face, the side facing the camera is painted. Painting a group or component supplies its default material, but explicitly painted faces inside it keep their own materials. Exploding a painted group or component keeps every color as it was: faces, parts and nested groups that showed its material are painted with it, and anything with a material of its own keeps that one. A line drawn across a painted face divides it into faces that all keep its material, with the texture continuing across them.

## Sample or replace materials

Use **Sample** in Materials or hold Alt with Paint Bucket and click to sample a material. Choose the replacement material, then hold Ctrl and click to fill edge-connected faces with the same material. Shift+click replaces the clicked material throughout the current editing context; Ctrl+Shift+click replaces it on the clicked object.

On a Mac, use Cmd wherever these steps say Ctrl, and Option for Alt: Cmd+click fills edge-connected faces, Cmd+Shift+click replaces on the clicked object, and Option+click samples. The status bar names the keys for your platform.

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

**Styles → Edit → Environment** contains studio lighting, sun and sky settings, skyboxes and placed scene lights. See [Lighting and environments](lighting.md) for previewing, saving and reusing a look.

## Soften, smooth or hide an edge

Select the edge and use **Soft**, **Smooth**, or **Hidden** in Entity Info where available. Hiding an edge changes its display; it does not remove the boundary needed by a solid.

To inspect hidden edges or faces, enable **Hidden Geometry**. Hiding and unhiding can be undone like other document changes.

## Browse the materials library

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

## Adjust and save library textures

The square previews show the actual surface image. Full textures load when you choose a material and use real-world repeat sizes, which you can adjust in **Materials → Edit**. Rectangular textures retain their proportions. When you add a library texture, its image is saved with your document. The library ships with the app and needs no external texture service.

The textured finishes use CC0 color maps from [Poly Haven](https://polyhaven.com/license). They provide surface color and pattern; glass tints provide transparency. These presets do not add reflection, refraction, or surface relief. A texture image with transparent areas, such as a PNG cutout of a plant or a hatch pattern, shows what lies behind the face through those areas.

## Edit a material finish

Choose a material in **Materials → Select**, then open **Edit**. The **Studio preview** shows a sphere and a flat sample under neutral lighting. Drag to rotate it, use Left/Right arrows while the sample has focus, or choose **Reset view**. The modeling viewport uses the model's lighting environment.

Choose **Matte**, **Satin**, **Polished**, or **Metal** from **Finish** as a starting point. These presets preserve the material's name, base color, opacity, texture placement and images. They reset emission to off. Individual edits show **Custom** when they do not match a preset.

**Roughness** runs from 0 for a polished surface to 1 for matte. **Metalness** runs from 0 for a nonmetal to 1 for a metal. Painted or coated metal usually needs a nonmetal outer finish. Environment reflections show the lighting environment; they do not mirror nearby modeled objects.

Move a surface slider to preview the change on the studio sample. Release it to apply one undoable change to the model. Escape cancels the gesture. Numeric fields commit on Enter or leaving the field; invalid values leave the saved material unchanged. **Color and texture** contains the existing color, opacity and texture controls.

## Add a normal image to a material

In **Surface**, choose a PNG or JPEG **Normal image** to add apparent pores, grain or bumps. This changes lighting only, without changing geometry, dimensions or cut lists. Use **Normal strength** to adjust its effect and **Flip green channel** for images using the opposite normal convention. It follows the color texture's placement and tile size. Without a color texture, edit the normal tile dimensions directly. Removing the color image retains normal mapping. Normal images are limited to 16 MiB, 8192 pixels per side and 16 megapixels.

## Make a material self lit

Enable **Emission** to make the surface self-lit, then set its color and strength. Emission does not light surrounding surfaces. **Open scene lights** opens the lighting controls when you need illumination on nearby objects. Emission strength is a relative value, not lumens.

## View and save material finishes

Round surfaces follow the model’s Smooth edge settings, while caps and hard edges remain sharp. Roughness controls reflections without changing those edge settings.

Surface finishes appear in shaded and textured modeling views. Normal maps appear in the textured view. Hidden Line, Monochrome and Color by Tag retain their display overrides. Materials without appearance settings retain their earlier shading until you apply a finish or edit a surface property.

Native model saves, recovery, duplication and copying between documents retain appearance settings and normal images. Mesh exchange exports currently include base color, opacity and color textures, with a note that the new surface properties are omitted. Commons previews have not changed in this release. Clearcoat, refractive glass, live mirrors and ray tracing are not included.
