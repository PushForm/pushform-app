# Full-size scale drawings

Choose **+ → Drawing** to open a full-size 2D drawing. Drawing uses a vector outline icon; Layout uses a paper-sheet icon in the New menu, document tabs, and Home’s Continue working list. Use the existing line, shape, snapping, offset, dimension and editing tools. Typed lengths are real dimensions: enter `6000mm` for a six-meter edge. Drawing documents use the native `.pfl` format, including cloud saves and recovery.

Drawing is an unbounded canvas with no page size, orientation, or margins. The origin **(0, 0)** starts at the center of the workspace. Draw in any direction, including negative coordinates. Drag with the middle mouse button to pan and use the wheel to zoom around the pointer. Choose **Return to Origin** in the zoom menu to recenter the axes, or **Fit Content** to frame your drawing. Set grid spacing and metric or imperial units in **Document Settings**. Paper sizes are chosen in Layout.

Drawing annotations use a 1:50 reference size. Font controls show their printed sizes; geometry and dimension values remain full size. For example, a 10 pt dimension stays 10 pt when the drawing is placed on a sheet at either 1:50 or 1:100.

**Stroke width** uses real-world millimeters or inches, following the drawing’s grid units, for new shapes and selected objects. Switching units preserves the width. Strokes and dash lengths scale with the drawing when placed in a layout: a 10 mm stroke becomes 0.2 mm on paper at 1:50, or 0.1 mm at 1:100. Layout’s own stroke controls use points.

## Add a drawing to a layout

Open or create a Layout tab. Return to the Drawing, then choose **Add to layout** in the right panel. Select the destination document and page, enter the scale denominator, and set the drawing origin's paper coordinates and rotation. The dialog shows the geometry's full-size and paper bounds before placement. At 1:50, a 6000 mm edge occupies 120 mm on paper.

**Place view** creates a locked vector group. The drawing can be placed multiple times at different scales. In the Layout's **Drawing views** panel, choose **Update / placement** to refresh a view from its open source drawing or change its placement. Updates are explicit and use the source's current working content. Keep the source open, or reopen it before updating. If the source is unavailable, the last placed appearance remains in the layout.

Choose **Detach** to turn a view into an ordinary editable group. It no longer updates from the drawing. Placement, updates and detaching support undo.

## Insert drawing geometry into a model

Open a Model tab, return to the Drawing, and choose **Insert into model**. Select the model and a ground (XY), front (XZ), or side (YZ) plane. Enter the drawing origin's model coordinates in millimeters and its rotation. The drawing origin is the intersection of the axes; drawing X points right and Y points down and is converted to the model plane's negative second axis.

**Insert sketch** adds visible path geometry at full size in the model's current editing context. It creates an independent copy; later source edits do not change it. Text, dimensions, tables and images are excluded. Curves become segmented paths. Closed contours can form faces for Push/Pull; open contours remain edges. Existing sketch geometry can intersect or join the inserted geometry. Bodies are not changed by insertion.

One Undo removes the entire insertion. The source drawing is preserved.

## Initial limits

This version selects destinations from open documents and uses numeric placement on principal model planes. Layout views retain native vector content and source identity; updating requires the source drawing to be open. Calibrated image/PDF tracing, drawing-view crops, linked model references and automatic solid rebuilding are not part of this workflow yet.
