# Modeling toolbar controls and their purpose

The modeling ribbon groups tools into **Transform**, **Draw**, **Modify**, **Inspect**, **Organize**, and **Navigate**, with names below the buttons. Open a button’s arrow for related tools. Scroll horizontally if the ribbon does not fit your window. Additional tools appear in **More** when available.

## Tool options bar

When the tool you choose has settings, such as Polygon's number of sides or Move's Copy mode, a bar with those settings floats over the top of the 3D view. Tools with nothing to set, such as Select, Rectangle and Orbit, show no bar. Change a setting by clicking it, or type in its box and press Enter; lengths use the model's units. A toggle shows the key that switches it while you work, for example Ctrl for Copy: tap the key, pressing and releasing it on its own. On a Mac, Cmd takes the place of Ctrl in every tool, and Option is Alt.

Right after you finish a shape or an operation, the bar turns green and reads, for example, **Polygon applied**. Changing a setting then changes what you just made, as one Undo step: a polygon's sides, a fillet's radius, or whether a move made a copy. Clicking in the model, choosing another tool or undoing goes back to settings for the next operation.

While you are placing a point, the bar fades and lets the pointer through, so you can click geometry underneath it. Empty parts of the bar always let clicks through; rest the pointer there briefly and the bar fades so you can see what is underneath. Press Ctrl+L (Cmd+L on a Mac) to move the keyboard into the bar, Tab between its controls, and Escape to return to the model.

## Select, Eraser and drawing tools

**Select** chooses existing model entities. **Lasso**, in Select's stack, chooses with a drawn outline. **Eraser** removes eligible sketch entities and dividing edges; a solid's actual boundary cannot simply be erased away.

Use **Line** for straight edges or **Freehand** for a drawn stroke. The Shape stack offers **Rectangle**, **Rotated Rectangle**, **Circle** and **Polygon** for regular boundaries. The Arc stack offers arc placement variants and **Pie**. Choose a variant according to the points or outline you need, then follow the tool's placement instructions.

## Push/Pull, Offset, Move, Rotate and Scale

**Push/Pull** gives a planar face depth or moves a region of an existing solid. **Offset** derives a parallel boundary from an existing outline. **Profile Edges** rounds, bevels or shapes the edges of a solid: choose Round, Chamfer or a router profile in its tool options bar. Use them to build from a face or outline instead of manually redrawing every edge.

**Move** changes position, **Rotate** changes orientation, and **Scale** changes size. Work in the intended group or component and check the selection before changing geometry. For **Follow Me**, click the profile face, hover along connected sketch path edges, then click to finish. With path edges preselected, clicking the profile applies the sweep immediately.

## Solid tools

The Solid stack includes **Union**, **Subtract**, **Trim**, **Intersect** and **Split**. These operate on solids, unlike Layout's page-based Boolean tools. Use the tool matching whether you want to combine volumes, remove one volume from another, keep their overlap, or divide them.

The inputs and the result must be valid solids in the current editing context. With no preselection, click the first solid then the second to apply. For Subtract and Trim, pick the cutter first and the target second. Subtract consumes the cutter; Trim keeps it. Union accepts two or more preselected solids; the other operations accept exactly two. The operation applies on activation. A loose edge or zero-thickness sheet is not a solid operand. Undo restores a completed operation.

## Inspect, Paint and Tag

The **Inspect** group contains the **Measure** dropdown and a **Section Plane** button. Section Plane creates a cutaway view to inspect the model’s interior.

**Tape Measure** and **Protractor** help measure distances and angles. **Dimension** adds measured annotations. **Axes**, which moves the drawing axes, is not on the toolbar; find it in command search.

The **Text** dropdown in **Draw** contains **Text** for model annotations and **3D Text** for letter geometry.

**Paint Bucket** applies the chosen material. **Tag** is for model organization; tag visibility can hide content from drawing, picking and snapping. Select the appropriate operation instead of treating every visual change as geometry editing.

## Orbit, Pan, Zoom and Zoom Extents

**Orbit** changes the view direction, **Pan** shifts the camera view, and **Zoom** changes framing. **Zoom Window** focuses on a chosen screen region. **Zoom Extents** frames the model and is useful when you have lost sight of it.

These camera controls change what you see, not the model's dimensions. Use Scale when you intend to change geometry size, and a camera control when you only want a closer view.

For **Revolve**, choose it from the **Sweep** dropdown, click the profile face, then click a straight axis edge or two points in the profile plane. Set the angle in the preview (360° by default), then click **Apply** or press Enter. Escape cancels.
