# Inference and section views in Modeling

## Lock a direction parallel or perpendicular to an edge

While drawing a Line, moving from a base point, or measuring from a first point, hover an edge inference, then press **Down arrow**. This locks the direction parallel or perpendicular to that edge, whichever is nearer the pointer direction. The line is magenta and its tooltip names the lock.

Press Down again to release it. Another arrow key replaces it with an axis lock. Without a starting point or a suitable edge inference, Down releases an existing arrow lock instead.

## Change Line inference modes

With Line active, press **Alt** to cycle through all inferences, no inferences, and parallel/perpendicular only. The status text names a restricted mode. Choosing Line afresh starts with all inferences.

Shift and arrow-key locks remain available in these modes. If expected snaps disappear, check the active inference mode and whether the target geometry is hidden.

## Add a section plane

Find **Section Plane** in command search. Point to a face to orient the preview, then click to place the plane. Shift holds the current orientation. Right, Left and Up constrain to the red, green and blue axes; Down releases that constraint. Undo removes a plane you have placed.

A section plane belongs to the model or to the group or component you are editing. Each such context has at most one active cut.

## Show section planes and cuts

In Styles, **Display Section Planes** controls the plane markers and **Display Section Cuts** controls cutting the view. A hidden plane can still be the active cut. Section Fill and the section line settings control how a cut through a solid looks.

The cut changes what is shown, not the underlying solid. Geometry removed from view by an active cut is not available for picking or snapping. Check nested editing contexts if several cuts combine.
