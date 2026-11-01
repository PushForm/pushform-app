# Changelog

Notable changes in each PushForm desktop release. Versions are `<year>.<week>.<build>`.

## 26.44.367

### Import and export

- **SketchUp export.** Choose **Export… → SketchUp (.skp)** to save the visible model, or only the selected geometry. The file is written on your device in the 2017 format. Each face is written as one face with its holes, and soft, smooth and hidden edges keep their settings, so curved surfaces stay smooth and flat faces show no diagonals. Components keep their placements, names and per-placement paint. Every material is included, with colours and PNG/JPEG textures. Tags, scenes, guides, dimensions, text and section planes are not exported; the export notes list what was left out or simplified.
- Older `.skp` files saved in the 2020 format without components now open with their geometry. Before, they could open empty.

### Typing values in the viewport

- **Value fields replace the Measurements box.** Drawing tools show their values in fields next to the geometry, linked to it by gray dimension lines. Line takes a length and an angle, Rectangle a width and height, Circle and Polygon a diameter, and Arc and Pie a diameter and then an angle. Start typing to fill the first field. Tab moves to the next field and locks the value you leave, Enter applies and Escape cancels.
- **The same fields in Layout.** Line, the rectangle tools, Ellipse, Table, Circle, Polygon and the arc tools take values on the page. Move, Rotate and Offset show their value next to the pointer.
- Fields size to their text, sit outside the shape they label so they don't cover it, and have a translucent background.
- Push/Pull shows a loose face's distance as positive in either direction, and a typed distance goes the way you are pulling.

### Modeling

- **Chamfer all edges of a box.** Chamfer now works where three picked edges meet at a corner, and the three bevels meet in a point. Fillet still can't round such a corner.
- **Orbit without losing your work.** Choosing Orbit, Pan, Zoom or Zoom Window no longer ends the tool you're using. Picked edges, a line in progress and previews all stay, and Esc or choosing the tool again takes you back. Enter still applies, so you can orbit while picking chamfer edges. Select and Space set a tool aside the same way when it has an operation in progress.

### Layout

- **Draw past the page edge.** Objects that run off the paper are drawn in full on the gray area around the page, and every tool works there. Printing, export and presentation still show only what's on the paper.
- **Linked units.** A paper preset sets the page to landscape and picks inches for US sizes or millimeters for international ones. A new Orientation option turns the page. The grid units now set the units of drawing values and new dimensions, and templates start in their paper's units.
- The Models list in the Layout panel can now be collapsed like the other sections.

## 26.44.356

### Import and export

- **Faster STEP import.** STEP files are converted on your device by a new reader. The desktop app uses every core and reads files up to 256 MiB. The browser converts on background threads. While a file converts, PushForm shows the part count, meshing progress and how long a slow step has been running. Cancel stops the conversion.
- **STEP export.** Export a model as STEP from the Export dialog, including on desktop. Face colours and opacity are kept.
- **Large mesh imports.** Large STL, OBJ, 3DS, glTF, COLLADA and STEP files now import as mesh parts, which stay fast in big models. You can select, move, copy, group, tag, hide, erase and paint them.
- **Make Editable.** Turn a mesh part into ordinary faces and edges when you need to model on it.
- **More `.layout` files open.** Dimensions and viewport cameras that can't be read are skipped instead of stopping the import.
- **Older `.skp` files.** Radial dimensions are now read from files saved before 2021.

### Modeling viewport

- A navigation cube in the corner of the viewport shows the view direction. Click a face, edge or corner to turn the view.
- Fog now covers the ground and sky as well as the model. It fades edges and blends into the horizon.
- New views start from a standing viewpoint with the sky at the top. The ground grid is hidden by default.
- Selecting a face or edge of a solid outlines the solid's edges and marks it in the Object browser.

### Interface

- Modeling tools are grouped into a labeled ribbon. Section planes sit with the measurement tools under Inspect, and the View group is now Navigate.
- On desktop, document tabs share the title bar.
- New app icon on macOS and new installer artwork.
- The Layout panels match the look of the Modeling workspace.
- On a Mac, Paint Bucket's adjacent-fill and replace modes now work: Option stands in for Ctrl, and Cmd samples a material.
- Several toolbar icons were redrawn, including Shape Builder.

### AI Chat

- AI Chat can edit 3D models, create and update scenes, and frame the camera.

### Scenes

- Scenes save and restore the visibility of objects inside groups and components.
- Dragging a scene's grip to reorder it works again.

### Reliability

- Saving a large model no longer freezes the editor while its thumbnail is made, and recovery checkpoints are spaced out so they interrupt work less.
- When an import fails, the source file can be captured privately for the support report.
