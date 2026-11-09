# Moving and viewing a model

## Orbit, Pan or Zoom without changing geometry

Choose **Orbit** and drag to turn around the model, or choose **Pan** and drag to shift the camera sideways. Release to stop. In Orbit, hold Shift as you start a drag to pan instead, or hold Ctrl to orbit freely, letting the view roll. With **Zoom**, drag upward to zoom in or downward to zoom out. These change the camera without resizing geometry.

You can switch to **Orbit**, **Pan**, **Zoom** or **Zoom Window** in the middle of another tool, for example with edges picked for a chamfer or halfway through a line. The tool you were using waits with everything you picked, and its preview stays visible while you move the view. Press Escape, or choose that tool again, to go back to it. Enter and typed values still reach it while Orbit or Pan is active, so you can apply a chamfer without leaving Orbit. **Select** (or the Space bar) works the same way for a tool with something in progress: select what you need, then press Escape or choose the tool again to carry on. Choosing any other tool ends the waiting one.

Choose **Zoom Window** from the Zoom dropdown, drag a rectangle around the desired area, then release to frame it. Escape cancels an unfinished window. **Zoom Extents** frames the model immediately. If the view still looks empty, check hidden tags, hidden objects and active section cuts.

## Turn the view with the navigation cube

The navigation cube sits in the top right corner of the 3D view and turns with the camera. Its faces are labelled Top, Bottom, Front, Back, Left and Right. Click the middle of a face to look straight at it, click the strip along an edge to look at that edge, or click a corner to look diagonally at it. The camera keeps its target and distance, so the model stays the same size on screen. Use **Camera › Previous** to go back.

The four small arrows around the cube turn the view 45° at a time: the left and right arrows spin it around the vertical axis and the up and down arrows tilt it. Drag the cube itself to orbit around the model, as **Orbit** does, without changing the active tool.

To hide or show the cube, choose **View › Navigation Cube**, or tick **Navigation Cube** in the Display panel. The choice is remembered on this computer and is not saved with the model.

## Move geometry from a base point

Select the geometry, choose **Move**, and click a base point. Move the pointer to preview the destination, then click again to finish, or press, drag and release. With nothing selected, pressing on something picks up what a Select click there would select, such as a whole solid, group or component; to move a single face or edge, select it first. Escape, or a second click on the base point before the pointer moves, cancels the move, and anything picked up that way is no longer selected. The moving outline includes geometry inside nested groups and components.

Both gestures show the same live outline and commit the previewed destination as one Undo step. Moving a smooth solid, including a surface that covers the entire solid, preserves its smooth shading and softened edges. Escape cancels either gesture without moving anything.

## Constrain a Move direction

The Right, Left and Up arrow keys lock the move to a straight rail through the base point along the red, green and blue axes of the model. The same key again releases the rail; another axis key replaces it. Down fixes a parallel or perpendicular direction from the last inferred edge and keeps that direction until you press Down again or choose another axis. Infer an edge first if Down reports that none is available. Hold Shift to freeze the current direction of travel or inferred direction; releasing Shift restores any arrow lock. Passing the base point moves smoothly to the other side. Hovering a face does not change the rail's distance calculation. The locks end with the move.

## Set Move distance and offsets

The tool options bar shows **Distance**, **ΔX**, **ΔY** and **ΔZ** in the model's units, plus **Copy** and the current constraint. The offsets are relative to the base point along the model's axes. Pick a base point to enable the fields. Type an offset and press Tab to hold it in the preview while setting the other offsets; press Enter to finish. A typed offset releases direction locks; a typed Distance releases held offsets and follows the current travel direction, including the negative side of an axis. Invalid text keeps the move pending. Just after a move, editing a field adjusts that move as one Undo step.

While moving, type a length and press Enter to move that far in the locked direction or the way the pointer has moved. Before the pointer has moved, lock an axis first. Type [x,y,z] to put the base point at those model coordinates, or <x,y,z> to move by that much. Typed just after a move, a value redoes it as one Undo step.

A selection with anything locked, with entities from different groups or components, or outside the group or component you have open is not moved: the status says why. Work inside the group or component you intend to edit. Moving a component instance differs from editing the geometry its instances share.

## Copy with Move and make arrays

Tap Ctrl (Cmd on a Mac), or click **Copy** in the tool options bar, to copy instead of moving, at any time during a move. Just after a move, tapping Ctrl or clicking **Copy** redoes it as a copy, or back as a plain move. The copies are selected afterwards and are never locked, and the preview shows only the copies. Selecting every complete face of a solid also copies the whole solid. Individual faces and edges of a solid cannot be copied on their own: copy the solid. Sketch vertices are copied only with their edges.

After a copy, type 3x and press Enter for three copies at the same spacing, or /3 for three copies spread evenly up to where the copy went. Then type a length to change their spacing; the number of copies stays. If an array cannot be made, the copies stay as they were.

Move, Rotate and Scale also take guides and text, and Move and Rotate copy them too. Screen text stays where it is on the screen, and edges drawn on a solid's face stay on the face: move the solid to move them.

## Move sketch geometry and glued components

Moving sketch vertices or edges stretches the edges connected to them, as drawing does: a vertex that lands on another joins it, edges that collapse are removed, edges the moved ones cross are split, and new faces form where edges close. A face that can no longer be flat is tilted to fit or split into flat pieces; a face with holes that cannot stay flat is replaced by its edges, and the status says so. Moving a face or edge of a solid folds the solid so it stays closed, and a move that cannot leave a valid solid is refused.

A component that glues to faces slides onto the face under the pointer, keeping the pointer's place on the component. A component already glued moves only within its glue plane, typed values included. Typing a value while over a face moves by that value instead of gluing.

## Rotate geometry around a pivot

Select the geometry and choose **Rotate**. Hover a face to align the protractor, then click the center of rotation. Click a point away from the center to set the starting direction. Move to preview the angle, then click again to commit, or press, drag and release. Escape cancels the pending rotation.

Before setting the center, the Right, Left and Up arrow keys lock the protractor square to the red, green or blue axis, and Shift holds its plane while held. Once the center is set the arrow keys do nothing.

With angle snapping on in **Model Info**, the angle snaps to multiples of the snap angle when the pointer is close to one, and the protractor's ticks show that angle. With snapping off, the angle follows the pointer freely.

After setting the starting direction, type an angle in degrees, such as `45` or `45°`, or a rise:run slope, and press Enter. It turns the way the preview turns, and a negative value turns the other way; before you move the pointer it turns counterclockwise. Typing just after a rotation redoes it.

Tap Ctrl, or click **Copy**, to keep the original in place. After a rotated copy, type `3x` for three more copies at the same step, or `/3` to spread three copies over the angle turned. A copy turned 360° and then `/6` makes six evenly round the whole circle, the original counting as one, so no copy lands on it.

## Scale with grips

Choose **Scale** for the selection. Its box and grips line up with the model's red, green and blue axes. Drag a grip to resize, then release to commit, or click a grip, move and click again. Both gestures show a live outline of the resized geometry and bounding box, and commit the displayed result as one Undo step. Escape cancels the preview. Corner grips keep proportions, and Shift lets a corner scale each axis freely. With an edge or face grip, Shift keeps proportions. Hold Alt or Ctrl to scale about the selection's center instead of the opposite grip. These keys update the preview immediately. Where grips overlap on screen, the one nearest you is used.

## Set Scale factors and sizes

The tool options bar shows **Scale**, **Size X**, **Size Y** and **Size Z**. Pick a grip to enable the fields; sizes are the selection's extents along the model's axes, in its display units. Type a size and press Tab to hold it in the preview, then Enter or a placement click to finish. A uniform grip changes the other sizes proportionally. With a free grip, you can hold sizes for separate axes while moving the pointer to set the remaining axes. A typed Scale replaces held sizes. Fields for a flat selection's missing axis stay disabled. Invalid text or a zero scale keeps the operation pending. Editing a field just after a resize adjusts that resize as one Undo step.

Resizing a smooth solid preserves its smooth shading and softened edges, including when stretching one axis or mirroring. Undo and Redo restore its appearance as well as its dimensions.

Type a number for a scale factor, or a length with a unit, such as `600mm`, for a size: along a face grip's axis, or for the longest side a corner or edge grip scales, with the other sides following. Type `x,y,z` for a factor per axis; a negative value mirrors. Typing just after a scale redoes it, keeping proportions if the drag did. Scale does not make copies.

Changing the model's display units does not resize geometry and is not a substitute for Scale.

## Use scenes and inspect the view

Scene tabs provide access to saved model views. The current camera, hidden content, styles and section display can all affect the visible result.

To change the order of scenes, drag a scene by its grip (⋮⋮) in the Scenes panel to a new position. A line shows where it will land; release to move it. Releasing outside the scene list cancels the move. Use Undo to restore the previous order. You can also use Move Left and Move Right on a tab's context menu.

A rendering difference does not necessarily mean the geometry changed. Inspect the relevant display or source settings before attempting geometry edits.
