# Moving, rotating and arranging in Layout

## Move an object by picking points

Choose **Move** in Transform, or press **M**. Click an editable object to choose it and set the base point. To move several objects together, select them first, then click a selected object or empty paper to set the base point.

Move the pointer to preview the destination, then click again to finish. Hold Shift to constrain movement horizontally or vertically. After the base point, type a length and press Enter for that distance along the pointer direction, or enter two offsets such as **10mm, 5mm**. Positive offsets go right and down the page. Escape cancels the pending move.

## Copy and repeat objects with Move

Choose **Move**, click the object to set its base point, then tap Ctrl (Cmd on a Mac) or click **Copy** in the tool options bar to toggle copying. Check that the status says Copy. Copy stays on for later moves until you choose Move again. Click the destination, or type a distance, to place a copy while leaving the original.

Immediately after that copy, type **3x** and press Enter to make three copies in total at the same spacing. Type **/3** instead for three copies spaced between the original and the first copy's position. Do this before picking another base point or changing tools. One Undo removes the copy array.

## Rotate objects with three clicks

Choose **Rotate** in Transform, or press **Q**. Click the object where you want its pivot; clicking a member of a group rotates the whole group. To rotate several objects together, select them first, then click a selected object or empty paper to set the pivot. Click a second point away from the pivot to set the reference direction. Move the pointer to preview the angle, then click a third time to finish.

After fixing the reference direction, you can instead type an angle such as **30** and press Enter. Positive angles turn clockwise on the page. Escape cancels the preview. Locked objects stay where they are; the reference and final direction points must differ from the pivot.

Labels stay readable as they turn: the arrow and the bend move around the pivot, while the text stays upright at the end of a level leader. A horizontal or vertical dimension becomes a rotated dimension at its new angle.

## Resize with the Scale tool

Choose **Scale** in Transform, then click an object to show its resize handles; clicking a member of a group picks up the whole group, and a selection you already have stays selected. Drag a handle to preview the new size and release to commit. Hold Shift to preserve proportions, or Alt to keep the center fixed. Escape discards an active resize. Double-click a handle to edit the object's text or vertices with Select.

While you drag, the handle snaps to the corners and edges of other objects and to the grid, as drawing does, and shows the snap marker. A handle can't be dragged past the opposite side; use Flip to mirror.

A text box resized on its own keeps its font size and rewraps. Hidden or locked objects must be made editable before resizing.

## Resize or rotate a group or several objects

Select a group, or several objects, with Select or Scale. One box surrounds them all, with resize handles on its corners and sides, and with Select a rotation handle in its middle. Drag a corner or side handle to scale everything together; Shift keeps proportions and Alt scales about the center. Drag the rotation handle to turn everything together.

When several objects are scaled together, the type scales with them by the smaller of the two factors, so shrinking a title block shrinks its text instead of cutting it off. Rotated text boxes and pictures keep their angle. Locked objects stay as they are.

The selection panel's **Arrange** section works on the whole selection too: Rotate, Scale, Flip and the drawing-order buttons act about the center of the selection's box, each as one undoable step.

## Rotate with the frame handle

Select an editable object, a group or several objects to show the frame. The small crosshair is the center of rotation, connected to a round rotation handle. Drag the round handle to rotate around that center. The preview shows an angle; release to commit. Escape cancels.

Drag the crosshair to change the pivot within the frame. Bringing it near the middle snaps it back to the center. The custom pivot resets when the selection changes.

## Offset a line or shape

Choose **Offset** in Modify. Click a visible, unlocked path, move the pointer to preview a parallel copy, then click to place it. The source stays unchanged.

After choosing the source, type a length for an exact offset. A positive value expands a closed shape; a negative value insets it. For an open path, the pointer sets the positive side and a negative value uses the other side. A collapsed or invalid offset creates nothing; correct the distance or press Escape.

## Round or bevel a corner with Corner

Choose **Corner** in Modify (Shift+F starts it on Round, Shift+C on Chamfer). In the tool options bar, choose **Round** (a fillet) or **Chamfer** and set the radius or distance, or type a positive length. Each choice remembers its own size. Click one straight segment, then an adjoining segment to preview and commit the corner.

Round creates a rounded tangent arc. Chamfer creates a straight bevel with equal setbacks. Curved, parallel or unsuitable segments and sizes that consume the shape are rejected. Two separate straight lines must be on the same layer.
