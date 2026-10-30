# Shaping and cutting solids in Modeling

## Sweep a profile with Follow Me

Prepare a profile face and a connected chain of sketch edges for its path in the editing context you intend to change. Choose **Follow Me**, click the profile face, then move the pointer along the connected path edges. The collected edges highlight red. Click to finish the sweep. Escape cancels the pending path.

Alternatively, select the path's sketch edges before choosing Follow Me, then click the profile face to sweep immediately. After picking a profile without preselected edges, Alt+click another face to use its perimeter as a closed path.

A disconnected edge cannot extend the path. If the sweep cannot form a valid solid, the tool reports an error; correct the profile or path before trying again.

## Offset a face or connected edges in Modeling

Choose **Offset** and click the face whose boundary you want to offset. Move inside or outside the face to preview the inset or outset, then click again to commit. While positioning, type a positive length in Measurements and press Enter to use that distance on the previewed side. Escape cancels the pending offset.

To offset an open chain, preselect at least two connected coplanar sketch edges before activating Offset, click to start, then set the distance. Double-click another face with Offset to repeat the last distance.

This creates offset sketch geometry; it does not by itself give the face depth. Use Push/Pull when you want an extrusion.

## Subtract or Trim one solid with another

Work in the context containing two valid solids. Clear the selection first if you want to choose the picking order. Choose **Subtract** or **Trim** from the Solid dropdown. Click the cutter first, then click the target solid to cut. The second click applies the operation; there is no separate Apply step. Escape before that click cancels the pending pick.

**Subtract** removes the cutter after cutting the target. **Trim** keeps the cutter. **Undo** restores the completed operation. If two solids are already selected, choosing the tool applies it immediately using the selection order.

This is Modeling's cutter-first order. Layout's Difference uses target-first order. A loose edge or a flat sketch face cannot serve as a solid cutter.

## Combine solids with Union or Outer Shell

Choose **Union** or **Outer Shell** from the Solid dropdown, click the first solid, then click the second. The second click applies the combination. Use valid solids in the same editing context. Escape cancels before the second pick; Undo restores the original solids after application.

You can also preselect two solids and choose Union to apply immediately. Outer Shell accepts two or more preselected solids and applies on activation. With no preselection it works by picking two solids at a time.

## Keep overlapping volume with Intersect or Split

With no solids preselected, choose **Intersect** or **Split** from the Solid dropdown. Click the first solid, then the second; the second click applies. Both must be valid solids in the current editing context. Escape cancels before the second pick. With two solids preselected, activation applies immediately.

**Intersect** replaces the inputs with their shared volume, so nonoverlapping solids can leave no result. **Split** replaces both inputs with separate solid pieces for their overlap and their remaining portions. **Undo** restores the originals.

## Round or bevel edges of a solid with Fillet or Chamfer

Choose **Fillet** (rounded edge) or **Chamfer** (flat bevel) from the Edge dropdown in the toolbar, or search for it by name. Hover a solid in the group or component you are editing: the edge under the pointer highlights. Click edges to add them to the set; picked edges stay highlighted. Shift+click a picked edge to remove it again. Clicking any segment of a circle or arc, such as the rim of a cylinder, picks the whole curve.

Type the fillet radius or the chamfer distance in Measurements, for example `5mm`, and press Enter. A preview of the result replaces the solid while you pick. Then press Enter, or double-click, to apply. The whole operation is one Undo step.

Edges you selected before choosing the tool start out picked. Escape clears the picked edges; a second Escape returns to Select. Only hard edges are offered: soft, smooth and hidden edges cannot be rounded.

## Fillet and Chamfer settings and limits

The radius or distance you type is remembered until the app is closed, also when you switch tools. For a fillet, type a number followed by `s` (for example `12s`) to set how many segments a full circle of fillet faces would have; the default is 24, so a right-angle edge gets 6 faces. Fillet faces form one smooth surface.

Outside edges are cut away and inside corners are filled. Picked edges that meet end to end are joined with a mitre, as in a picture frame. When the value is too large for the faces beside an edge, when the fillets of two edges would run into each other, or when three picked edges meet at one corner, nothing changes: the status bar explains why and the picked edges stay so you can type a smaller value. An edge can only end at a corner where three faces meet.
