# Moving, rotating and arranging in Layout

## Move an object by picking points

Choose **Move** in Transform, or press **M**. Click an editable object to choose it and set the base point. To move several objects together, select them first, then click a selected object or empty paper to set the base point.

Move the pointer to preview the destination, then click again to finish. Hold Shift to constrain movement horizontally or vertically. After the base point, type a length in Measurements and press Enter for that distance along the pointer direction, or enter two offsets such as **10mm, 5mm**. Positive offsets go right and down the page. Escape cancels the pending move.

## Copy and repeat objects with Move

Choose **Move**, click the object to set its base point, then tap Ctrl or Alt/Option to toggle **Copy**. Check that the status says Copy. Click the destination, or enter a distance in Measurements, to place a copy while leaving the original.

Immediately after that copy, type **3x** in Measurements and press Enter to make three copies in total at the same spacing. Type **/3** instead for three copies spaced between the original and the first copy's position. Do this before picking another base point or changing tools. One Undo removes the copy array.

## Rotate an object with three clicks

Choose **Rotate** in Transform, or press **Q**. Click the object where you want its pivot. Click a second point away from the pivot to set the reference direction. Move the pointer to preview the angle, then click a third time to finish.

After fixing the reference direction, you can instead type an angle such as **30** in Measurements and press Enter. Positive angles turn clockwise on the page. Escape cancels the preview. Use visible, unlocked objects; the reference and final direction points must differ from the pivot.

## Resize with the Scale tool

Choose **Scale** in Transform, then click the editable object to show its resize handles. Drag a handle to preview its new size and release to commit. Hold Shift to preserve proportions, or Alt to keep the center fixed. Escape discards an active resize.

Text boxes resize their bounds without changing the font size. Hidden or locked objects must be made editable before resizing.

## Rotate with the frame handle

Select one editable object to show its frame. The small crosshair is its center of rotation, connected to a round rotation handle. Drag the round handle to rotate around that center. The preview shows an angle; release to commit. Escape cancels.

Drag the crosshair to change the pivot within the object's bounds. Bringing it near the middle snaps it back to the center. The custom pivot resets when the object is deselected.

## Offset a line or shape

Choose **Offset** in Modify. Click a visible, unlocked path, move the pointer to preview a parallel copy, then click to place it. The source stays unchanged.

After choosing the source, enter a length in Measurements for an exact offset. A positive value expands a closed shape; a negative value insets it. For an open path, the pointer sets the positive side and a negative value uses the other side. A collapsed or invalid offset creates nothing; correct the distance or press Escape.

## Round or bevel a corner

Choose **Fillet** or **Chamfer** from the shared button in Modify. Set the radius or distance in its temporary right-side pane, or enter a positive length in Measurements. Click one straight segment, then an adjoining segment to preview and commit the corner.

Fillet creates a rounded tangent arc. Chamfer creates a straight bevel with equal setbacks. Curved, parallel or unsuitable segments and sizes that consume the shape are rejected. Two separate straight lines must be on the same layer.
