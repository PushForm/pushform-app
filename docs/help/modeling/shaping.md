# Shaping and cutting solids in Modeling

## Sweep a profile with Follow Me

Prepare a profile face and a connected chain of sketch edges for its path in the editing context you intend to change. Choose **Follow Me**, click the profile face, then move the pointer along the connected path edges. The collected edges highlight red. Click to finish the sweep. Escape cancels the pending path.

Alternatively, select the path's sketch edges before choosing Follow Me, then click the profile face to sweep immediately. After picking a profile without preselected edges, Alt+click another face to use its perimeter as a closed path.

A disconnected edge cannot extend the path. If the sweep cannot form a valid solid, the tool reports an error; correct the profile or path before trying again.

## Offset a face or connected edges in Modeling

Choose **Offset** and click the face whose boundary you want to offset. Move inside or outside the face to preview the inset or outset, then click again to commit. While positioning, type a positive length and press Enter to use that distance on the previewed side. Escape cancels the pending offset.

To offset an open chain, preselect at least two connected coplanar sketch edges before activating Offset, click to start, then set the distance. Double-click another face with Offset to repeat the last distance.

This creates offset sketch geometry; it does not by itself give the face depth. Use Push/Pull when you want an extrusion.

## Subtract or Trim one solid with another

Work in the context containing two valid solids. Clear the selection first if you want to choose the picking order. Choose **Subtract** or **Trim** from the Solid dropdown. Click the cutter first, then click the target solid to cut. The second click applies the operation; there is no separate Apply step. Escape before that click cancels the pending pick.

**Subtract** removes the cutter after cutting the target. **Trim** keeps the cutter. **Undo** restores the completed operation. If two solids are already selected, choosing the tool applies it immediately using the selection order.

To bore a round hole, draw a circle outside the target, use **Push/Pull** to make a cylinder that passes through it, then subtract the cylinder. Save the resulting model as a `.pf` file to reopen and continue editing it later.

This is Modeling's cutter-first order. Layout's Difference uses target-first order. A loose edge or a flat sketch face cannot serve as a solid cutter.

## Combine solids with Union

Choose **Union** from the Solid dropdown, click the first solid, then click the second. The second click applies the combination. Use valid solids in the same editing context. Escape cancels before the second pick; Undo restores the original solids after application.

You can also select two or more solids and choose **Union** to combine all of them immediately in one undoable step. Disconnected pieces remain separate solids. With no preselection it works by picking two solids at a time.

## Keep overlapping volume with Intersect or Split

With no solids preselected, choose **Intersect** or **Split** from the Solid dropdown. Click the first solid, then the second; the second click applies. Both must be valid solids in the current editing context. Escape cancels before the second pick. With two solids preselected, activation applies immediately.

**Intersect** replaces the inputs with their shared volume, so nonoverlapping solids can leave no result. **Split** replaces both inputs with separate solid pieces for their overlap and their remaining portions. **Undo** restores the originals.

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

