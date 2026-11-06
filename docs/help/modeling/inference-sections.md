# Inference and section views in Modeling

## Lock a direction parallel or perpendicular to an edge

While drawing a Line, moving from a base point, or measuring from a first point, hover an edge inference, then press **Down arrow**. This locks the direction parallel or perpendicular to that edge, whichever is nearer the pointer direction. The line is magenta and its tooltip names the lock.

Press Down again to release it. Another arrow key replaces it with an axis lock. Without a starting point or a suitable edge inference, Down releases an existing arrow lock instead.

## Change Line inference modes

With Line active, press **Alt** to cycle through all inferences, no inferences, and parallel/perpendicular only. The status text names a restricted mode. Choosing Line afresh starts with all inferences.

Shift and arrow-key locks remain available in these modes. If expected snaps disappear, check the active inference mode and whether the target geometry is hidden.

## Add a section plane

Choose **Section Plane** in the **Inspect** toolbar group or find it in command search. Point to a face to orient the preview, then click to place the plane. Shift holds the current orientation. Right, Left and Up constrain to the red, green and blue axes; Down releases that constraint. To make the plane keep the other side, switch on **Reverse** in the tool options bar, or tap Ctrl (Cmd on a Mac). It stays on for the next planes until you switch it off. Right after a click, switching Reverse turns the plane you just placed around where it lies. Undo removes a plane you have placed.

To place a plane at an exact distance from what you clicked, type the distance right after the click and press Enter. A positive distance moves the plane the way its arrows point, a negative one the other way. Typing again replaces the distance, and Undo removes the plane and its offset together.

A section plane belongs to the model or to the group or component you are editing. Each such context has at most one active cut. A plane inside a component belongs to its definition, so every copy of that component is cut the same way.

## Move, flip and hide section planes

To move a plane, choose **Move** and point to the plane's outline, or select the plane first. While only section planes move, the move stays square to them, so the plane slides nearer to or farther from what it cuts; type a distance for an exact move. An arrow key locks an axis instead.

Right-click a plane with any tool for **Reverse**, which flips the side it cuts away, **Hide**, **Active Cut** and **Align View**. Double-clicking a plane with Select turns its cut on or off.

A hidden plane still cuts if it is the active one. To find it again, turn on **View › Hidden Geometry**: hidden planes then appear as outlines you can select, and right-clicking one offers **Unhide**.

Copy and paste section planes like other entities; a pasted plane is not active. **Make Group** takes selected planes into the new group, with the active cut if one of them had it.

## Show section planes and cuts

In Styles, **Display Section Planes** controls the plane markers and **Display Section Cuts** controls cutting the view. A hidden plane can still be the active cut. Section Fill and the section line settings control how a cut through a solid looks.

The cut changes what is shown, not the underlying solid. Geometry removed from view by an active cut is not available for picking or snapping. Check nested editing contexts if several cuts combine.
