# Moving and viewing a model

## Orbit, Pan or Zoom without changing geometry

Choose **Orbit** and drag to turn around the model, or choose **Pan** and drag to shift the camera sideways. Release to stop. With **Zoom**, drag upward to zoom in or downward to zoom out. These change the camera without resizing geometry.

Choose **Zoom Window** from the Zoom dropdown, drag a rectangle around the desired area, then release to frame it. Escape cancels an unfinished window. **Zoom Extents** frames the model immediately. If the view still looks empty, check hidden tags, hidden objects and active section cuts.

## Turn the view with the navigation cube

The navigation cube sits in the top right corner of the 3D view and turns with the camera. Its faces are labelled Top, Bottom, Front, Back, Left and Right. Click the middle of a face to look straight at it, click the strip along an edge to look at that edge, or click a corner to look diagonally at it. The camera keeps its target and distance, so the model stays the same size on screen. Use **Camera › Previous** to go back.

The four small arrows around the cube turn the view 45° at a time: the left and right arrows spin it around the vertical axis and the up and down arrows tilt it. Drag the cube itself to orbit around the model, as **Orbit** does, without changing the active tool.

To hide or show the cube, choose **View › Navigation Cube**, or tick **Navigation Cube** in the Display panel. The choice is remembered on this computer and is not saved with the model.

## Move geometry from a base point

Select the geometry, choose **Move**, and click a base point. Move the pointer to preview the destination, then click again to finish. You can also press, drag and release. While positioning, enter a distance in Measurements and press Enter for an exact move along the current direction. Escape cancels the preview.

Tap Ctrl to toggle copying before placement; check for **Copy** in the status. Work inside the group or component you intend to edit. Moving a component instance differs from editing the geometry shared by its instances.

## Rotate geometry around a pivot

Select the geometry and choose **Rotate**. Hover a face to align the protractor, then click the center of rotation. Click a point away from the center to set the baseline. Move to preview the angle, then click again to commit, or type an angle in Measurements and press Enter. Escape cancels the pending rotation.

Before setting the center, arrow keys can lock the rotation axis. Tap Ctrl to toggle copying if you want the original to stay in place. Work in the intended editing context and check the preview before the final click.

## Scale with grips

Choose **Scale** for the selection. Drag a grip to resize it, then release to commit; Escape cancels the preview. Corner grips normally keep proportions; Shift lets a corner scale freely. With an edge or face grip, Shift keeps proportions. Hold Alt to scale around the selection's center.

Read the status text for the current grip's modifier behavior. Changing the model's display units does not resize geometry and is not a substitute for Scale.

## Use scenes and inspect the view

Scene tabs provide access to saved model views. The current camera, hidden content, styles and section display can all affect the visible result.

To change the order of scenes, drag a scene by its grip (⋮⋮) in the Scenes panel to a new position. A line shows where it will land. You can also use Move Left and Move Right on a tab's context menu.

A rendering difference does not necessarily mean the geometry changed. Inspect the relevant display or source settings before attempting geometry edits.
