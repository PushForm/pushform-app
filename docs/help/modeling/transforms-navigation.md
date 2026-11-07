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

Select the geometry, choose **Move**, and click a base point. Move the pointer to preview the destination, then click again to finish. You can also press, drag and release. While positioning, type a distance and press Enter for an exact move along the current direction. Escape cancels the preview. The moving outline includes geometry inside nested groups and components.

Tap Ctrl, or click **Copy** in the tool options bar, to toggle copying before placement. Move, Rotate and Scale also take guides and text, and Move and Rotate copy them too. Screen text stays where it is on the screen, and edges drawn on a solid's face stay on the face: move the solid to move them. Work inside the group or component you intend to edit. Moving a component instance differs from editing the geometry shared by its instances.

## Rotate geometry around a pivot

Select the geometry and choose **Rotate**. Hover a face to align the protractor, then click the center of rotation. Click a point away from the center to set the starting direction. Move to preview the angle, then click again to commit, or press, drag and release. Escape cancels the pending rotation.

Before setting the center, the Right, Left and Up arrow keys lock the protractor square to the red, green or blue axis, and Shift holds its plane while held. Once the center is set the arrow keys do nothing.

With angle snapping on in **Model Info**, the angle snaps to multiples of the snap angle when the pointer is close to one, and the protractor's ticks show that angle. With snapping off, the angle follows the pointer freely.

After setting the starting direction, type an angle in degrees, such as `45` or `45°`, or a rise:run slope, and press Enter. It turns the way the preview turns, and a negative value turns the other way; before you move the pointer it turns counterclockwise. Typing just after a rotation redoes it.

Tap Ctrl, or click **Copy**, to keep the original in place. After a rotated copy, type `3x` for three more copies at the same step, or `/3` to spread three copies over the angle turned. A copy turned 360° and then `/6` spreads six copies evenly round the whole circle, the last one where the original is.

## Scale with grips

Choose **Scale** for the selection. Its box and grips line up with the model's red, green and blue axes. Drag a grip to resize, then release to commit; Escape cancels the preview. Corner grips keep proportions, and Shift lets a corner scale each axis freely. With an edge or face grip, Shift keeps proportions. Hold Alt or Ctrl to scale about the selection's center instead of the opposite grip. Where grips overlap on screen, the one nearest you is used.

Type a number for a scale factor, or a length with a unit, such as `600mm`, for a size: along a face grip's axis, or for the longest side a corner or edge grip scales, with the other sides following. Type `x,y,z` for a factor per axis; a negative value mirrors. Typing just after a scale redoes it, keeping proportions if the drag did. Scale does not make copies.

Changing the model's display units does not resize geometry and is not a substitute for Scale.

## Use scenes and inspect the view

Scene tabs provide access to saved model views. The current camera, hidden content, styles and section display can all affect the visible result.

To change the order of scenes, drag a scene by its grip (⋮⋮) in the Scenes panel to a new position. A line shows where it will land; release to move it. Releasing outside the scene list cancels the move. Use Undo to restore the previous order. You can also use Move Left and Move Right on a tab's context menu.

A rendering difference does not necessarily mean the geometry changed. Inspect the relevant display or source settings before attempting geometry edits.
