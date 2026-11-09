# Shaping and cutting solids in Modeling

## Push or pull a face with Push/Pull

Choose **Push/Pull** and hover a flat face of a solid, or a face that isn't part of a solid yet, in the group or component you are editing. The face highlights; on a face divided by drawn edges, only the region under the pointer is highlighted and pulled. Then click the face, move to preview the result, and click again to commit. You can also press, drag and release. Escape cancels the preview. If exactly one face is selected when you choose Push/Pull, your next click anywhere in the view pulls that face.

While pulling, hover another face within 30° of parallel to match its height: the pull ends where that face's plane crosses the pull line. A snap to a point on the way, such as an endpoint, wins over a matched height. With the pointer over the face you are pushing, the push follows how far the pointer moves.

Pulling a solid's face outward extends the solid. Pushing a region in makes a pocket, or a hole when it reaches the other side; a push that cuts a solid apart leaves separate solids, each keeping its materials. Pulling a loose face makes a new solid in its place. Pulled circles and arcs get smooth sides, with **New body** too. A whole face whose neighbours are square to it, such as the top of a box or a cylinder, moves while its sides stretch or shorten, so pushing and pulling it again and again adds no extra faces or edges and smooth sides stay smooth. Each pull is one Undo step.

## Exact Push/Pull lengths, double-click and New body

While pulling, type a distance and press Enter to end the pull there: positive pulls out of the solid, negative pushes in. For a loose face, it goes the way you are pulling. A typed 0 changes nothing. Typing a distance right after a pull, before anything else changes, redoes it at that distance in the same direction. With nothing in progress, a typed distance pulls the face under the pointer; with no face there, the status bar asks you to point to one.

Double-click a face to repeat the last distance: out if the last pull went out, in if it went in, whichever way the face points.

Turn on **New body** in the tool options bar, or tap Ctrl (Cmd on macOS), to make the pulled region a separate solid and leave the original as it was; a loose face stays too. It is off each time you choose the tool. Switching it right after a pull redoes that pull the other way.

Push/Pull refuses, says why and changes nothing when pushing a whole face to or past the opposite side would leave nothing, and on a face of a smooth surface, such as a cylinder's side: it works on flat faces. In a group or component, distances are in the model, as the preview shows, even when it is scaled.

## Sweep a profile with Follow Me

Prepare a profile face and a connected chain of sketch edges for its path in the editing context you intend to change. Choose **Follow Me**, click the profile face, then move the pointer along the connected path edges. The collected edges highlight red. Click to finish the sweep. Escape cancels the pending path.

Alternatively, select the path's sketch edges before choosing Follow Me, then click the profile face to sweep immediately. After picking a profile without preselected edges, Alt+click another face to use its perimeter as a closed path.

A disconnected edge cannot extend the path. If the sweep cannot form a valid solid, the tool reports an error; correct the profile or path before trying again.

## Turn a profile around an axis with Revolve

Use **Revolve** for turned legs, bowls, knobs and other rotational shapes. You can also ask the in-app agent to revolve an existing profile or draw and revolve one, specifying the axis and angle. Open the **Sweep** dropdown beside Offset in the Modify toolbar and choose **Revolve**, or find it in command search.

Click a flat profile face in the group or component you are editing. Then click a straight edge for the axis, or click two different points in the profile plane to define its direction. The profile must stay on one side of the axis; it may touch it. For a turned leg, draw half of its side outline with its straight inner boundary on the axis.

A solid preview appears after you choose the axis. The default angle is **360°**. Type an angle such as `90` or `90°` and press Enter to update the preview; a partial turn has flat, closed ends. Set **Segments** in the options bar, or type `48s`, to control the resolution of the curved shape. Counts run from 3 to 720 per full turn; the default is 48.

To make a **sphere**, draw a filled semicircle: use **2 Point Arc** for the curved half, then use **Line** to join its endpoints with a straight diameter. Choose **Revolve**, click inside that semicircle, then click the diameter and apply a **360°** turn. A full circular face crosses its diameter and cannot be revolved around it; use half the circle. Curved regions are smoothed automatically, including the sphere's poles and closing seam. Rims and corners in the profile stay sharp. More profile arc segments and more Revolve segments make the silhouette rounder.

Click **Apply**, click in the view, or press Enter with no value being edited to finish. Revolving a loose face replaces that face with the new solid. Using a face of an existing solid creates separate solids and keeps the original. The operation is one **Undo** step. Escape cancels the pending operation. If an axis is outside the profile plane or crosses the profile, the tool explains the problem; cancel and choose a suitable axis. If the model changes while you are previewing, cancel and pick the profile and axis again before applying.

## Offset a face or connected edges in Modeling

Choose **Offset**, click the face to offset in the context you're editing, move to where the offset should reach and click again to commit, or press on the face, drag and release. The distance runs from the pointer to the face's nearest edge and snaps to vertices and edges on the face's plane: inside the face insets, outside outsets. The distance box shows the length and the status bar says which way it goes. Type a length and press Enter to use it on the pointer's side (inward before you move); a negative length goes the other way. Typing a new length or switching **Allow overlaps** right after an offset redoes it; a click in the view ends that. Escape cancels. Double-click a face to repeat the last face offset.

Every loop of the face is offset, so holes grow as the face shrinks, and arcs and circles stay arcs. Overlapping loops are merged unless **Allow overlaps** (Alt, Option on macOS) is on; it is off each time you choose Offset. An offset that would leave nothing, or run past the edges of a solid's face, is refused with a message.

On a loose face an inset adds a face inside with the original's material and tag; an outset adds a ring around it. On a solid's face the offset divides the face. New edges go on the active tag.

To offset a chain, select two or more connected coplanar edges before choosing Offset, click, then move to a side; type the length if you like. Offset adds outlines only; use Push/Pull to give a face depth.

## Subtract or Trim one solid with another

Work in the context containing two valid solids. Clear the selection first if you want to choose the picking order. Choose **Subtract** or **Trim** from the Solid dropdown. Click the cutter first, then click the target solid to cut. The second click applies the operation; there is no separate Apply step. Escape before that click cancels the pending pick.

**Subtract** removes the cutter after cutting the target. **Trim** keeps the cutter. **Undo** restores the completed operation. If two solids are already selected, choosing the tool applies it immediately using the selection order. When the cutter covers the whole target, nothing would be left, so Subtract and Trim refuse, say why in the status bar and change nothing.

To bore a round hole, draw a circle outside the target, use **Push/Pull** to make a cylinder that passes through it, then subtract the cylinder. Save the resulting model as a `.pf` file to reopen and continue editing it later.

This is Modeling's cutter-first order. Layout's Difference uses target-first order. A loose edge or a flat sketch face cannot serve as a solid cutter.

## Combine solids with Union

Choose **Union** from the Solid dropdown, click the first solid, then click the second. The second click applies the combination. Use valid solids in the same editing context. Escape cancels before the second pick; Undo restores the original solids after application.

You can also select two or more solids and choose **Union** to combine all of them immediately in one undoable step. Disconnected pieces remain separate solids. With no preselection it works by picking two solids at a time.

## Keep overlapping volume with Intersect or Split

With no solids preselected, choose **Intersect** or **Split** from the Solid dropdown. Click the first solid, then the second; the second click applies. Both must be valid solids in the current editing context. Escape cancels before the second pick. With two solids preselected, activation applies immediately.

**Intersect** replaces the inputs with their shared volume. Solids that do not overlap share nothing, so Intersect refuses them, says why in the status bar and changes nothing. **Split** replaces both inputs with separate solid pieces for their overlap and their remaining portions. **Undo** restores the originals.

## Round, bevel or shape edges with Profile Edges

Choose **Profile Edges** in the Modify group of the toolbar, or search for **Fillet**, **Round**, **Chamfer** or **Profile Edges** by name. Pick a profile from the row of profile buttons in the tool options bar at the top of the view:

- **Round**: a rounded edge, also called a fillet or roundover. The size is its radius.
- **Chamfer**: a flat bevel. The size is how far it reaches back from the edge; set **Angle** in the bar, or type an angle such as `20°`, for a wide, shallow bevel, as on a raised panel.
- **Cove**: a hollow quarter round. The size is its radius.
- **Ogee**: an S curve, rounded near the edge and hollow near the face. The size is its width and depth.
- **Bead**: a half round on the edge with a small groove beside it, as on a beaded face frame. The size is the bead's radius.
- **Step**: a square rabbet. The size is its width and depth.

## Pick edges and apply Profile Edges

Hover a solid in the group or component you are editing: the edge under the pointer highlights. Click edges to add them to the set; picked edges stay highlighted. Shift+click a picked edge to remove it again. Clicking any segment of a circle or arc, such as the rim of a cylinder, picks the whole curve. Edges you selected before choosing the tool start out picked.

Type the size, for example `5mm` or `1/4"`, or set it in the bar. A preview of the result replaces the solid while you pick. Then press Enter, or double-click, to apply. The whole operation is one Undo step, named after the profile. Escape clears the picked edges; a second Escape returns to Select. Only hard edges are offered: soft, smooth and hidden edges cannot be shaped.

## Profile Edges settings

Each profile remembers its own size until the app is closed; a profile you have not used yet starts with the size of the one you switch from. **Round**, **Cove**, **Ogee** and **Bead** share **Segments** in the bar, or type a number followed by `s` (for example `12s`): the number of segments a full circle of their curved faces would have. The default is 24, so a right-angle edge gets 6 faces. Curved faces form one smooth surface.

Right after you apply, you can still change the profile, size, angle or segments in the bar: the edges you just shaped are redone with the new values.

## Round and Chamfer on any edge

**Round**, and **Chamfer** at its usual 45°, work on any hard edge, whatever the angle between its faces. Outside edges are cut away and inside corners are filled. Picked edges that meet end to end are joined with a mitre, as in a picture frame. Where picked edges turn from an outside edge to an inside corner, each part is rounded or beveled on its own and ends flat on the face across its end. Chamfer can also bevel three picked edges that meet at one corner, such as all twelve edges of a box: the three bevels cut into each other and meet in a point. Round cannot round such a corner. When the value is too large for the faces beside an edge, when the curves of two edges would run into each other, or when three picked edges meet at one corner for Round, nothing changes: the status bar explains why and the picked edges stay so you can try a smaller value.

## Cove, Ogee, Bead, Step and angled Chamfer like a router bit


A profile is measured from one face beside each edge, as a router rides on it: for edges round a face, that face; for a single edge, its larger face. These profiles, and Chamfer at an angle other than 45°, shape square outside edges, where two faces meet at a right angle; when your pick includes another kind of edge, their buttons are disabled and the bar says why. Use Round or Chamfer at 45° for those edges. Picked edges that meet end to end are mitred, also round the inside of an opening, as on a beaded face frame. Inside corners in your pick are left alone, and the bar says how many: the profile stops flat against the face it runs into there, as a router's bearing stops. When the size is too large, nothing changes and the status bar explains why.

