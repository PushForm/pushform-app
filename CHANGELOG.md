# Changelog

Notable changes in each PushForm desktop release. Versions are `<year>.<week>.<build>`.

## 26.44.345

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
