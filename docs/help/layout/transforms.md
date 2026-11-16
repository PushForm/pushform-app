# Moving, rotating and arranging in Layout

## Move an object by picking points

Choose **Move** in Transform, or press **M**. Click an editable object to choose it and set the base point. To move several objects together, select them first, then click a selected object or empty paper to set the base point.

Move the pointer to preview the destination, then click again to finish. The distance shows beside the pointer. Hold Shift to constrain movement horizontally or vertically. Escape cancels the pending move.

## Type exact offsets, a distance or an angle for Move

After you click the base point, the tool options bar shows **X**, **Y**, **Distance** and **Angle** for the move, and the cursor is in **X**. Type a horizontal offset and press Enter to move that far across, keeping the pointer's vertical offset. Positive X goes right and positive Y goes down the page. Press Tab to keep a value and go to the next field: the pointer then sets only what is left, so typing **0** in X and pressing Tab moves straight up or down. You can also type both offsets in any field, such as **10mm, 5mm**.

Type a **Distance** to move that far in the pointer's direction, or a Distance and an **Angle** to set both. Angles are measured from the right and turn clockwise, so 90 is straight down the page. Typing a distance or angle releases the X and Y values, and typing an offset releases the distance and angle. Escape cancels the move.

## Copy and repeat objects with Move

Choose **Move**, click the object to set its base point, then tap Ctrl (Cmd on a Mac) or click **Copy** in the tool options bar to toggle copying. Check that the status says Copy. Copy stays on for later moves until you choose Move again. Click the destination, or type offsets or a distance, to place a copy while leaving the original.

Immediately after that copy, type **3x** and press Enter to make three copies in total at the same spacing. Type **/3** instead for three copies spaced between the original and the first copy's position. Do this before picking another base point or changing tools. One Undo removes the copy array.

## Rotate objects with three clicks

Choose **Rotate** in Transform, or press **Q**. Click the object where you want its pivot; clicking a member of a group rotates the whole group. To rotate several objects together, select them first, then click a selected object or empty paper to set the pivot. Click a second point away from the pivot to set the reference direction. Move the pointer to preview the angle, then click a third time to finish.

The tool options bar shows **Angle**, disabled until you fix the reference direction. It then displays the live preview angle. Enter a signed angle such as **30** or **-45** and press Enter to finish. Positive angles turn clockwise on the page. Escape cancels the preview. Locked objects stay where they are; the reference and final direction points must differ from the pivot.

Labels stay readable as they turn: the arrow and the bend move around the pivot, while the text stays upright at the end of a level leader. A horizontal or vertical dimension becomes a rotated dimension at its new angle.

## Scale with the Scale tool

Choose **Scale** in Transform. Click the object at the point that should stay put, such as a corner; clicking a member of a group picks up the whole group. To scale several objects together, select them first, then click a selected object or empty paper to set that base point. Then move the pointer: it drags the far corner of the box around what you are scaling, keeping its proportions, as a resize handle would with the base point held still. Click again to finish. The percentage shows beside the pointer.

The base point snaps to the corners and edges of objects, including the ones you are scaling, and to the grid; the point that finishes snaps only to other objects. Escape cancels a pending scale. Type scales with the drawing, so a text box scaled to 200% has twice its font size. Hidden or locked objects stay as they are.

## Type a scale, width or height for Scale

After you click the base point, the tool options bar shows **Scale**, **Width** and **Height**, and the cursor is in **Scale**. Type a factor such as **2** or **0.5**, or a percentage such as **50%**, and press Enter. To make what you are scaling a set size, type its new **Width** or **Height** instead, such as **600** for a drawing that should be 600 wide; the other side keeps its proportion.

Press Tab to keep a value: the preview holds it, and your next click finishes the scale. All three fields set the same factor, so typing in one releases the others.

## Resize with the handles

With Select, a selected object shows resize handles on its box. Drag a handle to preview the new size and release to commit. Hold Shift to preserve proportions, or Alt to keep the center fixed. Escape discards an active resize.

While you drag, the handle snaps to the corners and edges of other objects and to the grid, as drawing does, and shows the snap marker. A handle can't be dragged past the opposite side; use Flip to mirror.

A text box resized on its own with its handles keeps its font size and rewraps. Hidden or locked objects must be made editable before resizing.

## Resize or rotate a group or several objects

Select a group, or several objects, with Select. One box surrounds them all, with resize handles on its corners and sides and a rotation handle in its middle. Drag a corner or side handle to scale everything together; Shift keeps proportions and Alt scales about the center. Drag the rotation handle to turn everything together.

When several objects are scaled together, the type scales with them by the smaller of the two factors, so shrinking a title block shrinks its text instead of cutting it off. Rotated text boxes and pictures keep their angle. Locked objects stay as they are.

The selection panel's **Arrange** section works on the whole selection too: Rotate, Scale, Flip and the drawing-order buttons act about the center of the selection's box, each as one undoable step.

## Rotate with the frame handle

Select an editable object, a group or several objects to show the frame. The small crosshair is the center of rotation, connected to a round rotation handle. Drag the round handle to rotate around that center. The preview shows an angle; release to commit. Escape cancels.

Drag the crosshair to change the pivot within the frame. Bringing it near the middle snaps it back to the center. The custom pivot resets when the selection changes.

## Offset a line or shape

Choose **Offset** in Modify. Click a visible, unlocked path, move the pointer to preview a parallel copy, then click to place it. The source stays unchanged.

Offset shows **Distance** in the tool options bar. It waits disabled until you choose the source, then follows the live preview and remains editable while placing the offset. Enter a signed length there and press Enter for an exact offset. A positive value expands a closed shape; a negative value insets it. For an open path, the pointer sets the positive side and a negative value uses the other side. A collapsed or invalid offset creates nothing; correct the distance or press Escape.

## Round or bevel a corner with Corner

Choose **Corner** in Modify (Shift+F starts it on Round, Shift+C on Chamfer). In the tool options bar, choose **Round** (a fillet) or **Chamfer** and set the radius or distance, or type a positive length. Each choice remembers its own size. Click one straight segment, then an adjoining segment to preview and commit the corner.

Round creates a rounded tangent arc. Chamfer creates a straight bevel with equal setbacks. Curved, parallel or unsuitable segments and sizes that consume the shape are rejected. Two separate straight lines must be on the same layer.
