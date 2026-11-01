# Drawing in Modeling

## Draw a face and make it solid

Use Rectangle or Line to create a closed boundary on a plane. Choose **Push/Pull**, click the face or region, move outward to preview its depth, then click again to commit. You can also drag the face and release. While positioning, type a distance and press Enter for an exact depth. Escape cancels the preview.

Keep the face planar and the boundary closed. A loose line does not provide a filled face to push. Push/Pull on an existing solid changes its face while keeping the solid valid; an operation that cannot make a valid result is rejected.

## Draw connected lines in Modeling

Choose **Line** from the Line dropdown. Click a start point, then an endpoint. Continue clicking endpoints to add connected segments. Return to the starting vertex to close a planar boundary into a face. Escape ends the unfinished segment; completed segments remain.

After the start point, the Length and Angle fields beside the line show its size. Type a length and press Enter to place the endpoint along the pointer direction, or press Tab to type an angle as well. Arrow keys lock directions and Shift holds an inference. An open chain is sketch geometry, not a solid.

## Draw a Rectangle or Rotated Rectangle

Choose **Rectangle** from the Shape dropdown. Click the first corner, then the opposite corner, or drag between them and release. After the first corner, type the width, press Tab, type the height and press Enter for exact dimensions. Escape cancels the unfinished rectangle.

For **Rotated Rectangle**, click the first corner, click the second corner to set the first edge, then click a third point to set the width and orientation. The third click completes the face. A rectangle begins as a flat face; use Push/Pull to give it thickness.

## Draw a Freehand curve in Modeling

Choose **Freehand** from the Line dropdown. Press and drag on the drawing plane, then release to finish the curve. Release on the start point to close the boundary and form a face. Escape during the drag discards the unfinished stroke.

Modeling Freehand creates a segmented sketch curve. To turn a closed planar face into a solid, use Push/Pull afterward.

## Draw an Arc, 2 Point Arc, 3 Point Arc or Pie

Open the Arc dropdown and choose the variant matching your reference points. **Arc** uses three clicks: center, start point, then end direction. **2 Point Arc** uses start, end, then bulge. **3 Point Arc** uses start, an intermediate point on the arc, then end. The last click completes the arc.

**Pie** uses center, start and end like Arc, but closes back to the center with two radii to form a face. For Arc and Pie, you can type the circle's diameter after the center, then the angle of the sweep. Escape cancels unfinished placement. Repeated or collinear points cannot define a valid curved arc; choose distinct points.

## Draw an eight-sided polygon in Modeling

Choose **Polygon** from its toolbar stack or command search. Before placing the center, type **8s** and press Enter. Click the center and then the radius point to place the polygon, or type its diameter.

The Modeling Polygon tool starts with six segments. Typing a number followed by **s** changes the segment count even while positioning the radius. For an existing curve, select one of its edges and use **Segments** in Entity Info where available.

## Draw a circle and set its segments

Choose **Circle**. Click its center, then its radius point. You can type a segment count such as **24s** before the first click. After placing the center, a plain length sets the diameter, a value ending in **r** sets the radius and a value ending in **s** changes the segments.

A circle is represented by segments in Modeling. Changing its radius or segments is different from Layout's page-based Circle tool, so use the instructions for the active editor.

## Draw on a solid face

Lines drawn in a solid face can divide it into regions for operations such as Push/Pull. A line crossing the face boundary can leave loose sketch portions outside the face.

Erasing a dividing line drawn on the face merges its regions. An edge that is part of the solid's actual boundary cannot simply be erased; use the offered hiding, softening, or face-editing alternatives.

## Cancel an unfinished drawing

Use Escape to cancel an active placement. Follow the status bar for the tool's current step. A preview is not committed document geometry until the operation finishes.

If a tool appears to ignore a shortcut, check whether a text field, menu, or Object browser currently has keyboard focus.
