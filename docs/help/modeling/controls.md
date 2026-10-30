# Modeling toolbar controls and their purpose

## Select, Eraser and drawing tools

**Select** chooses existing model entities. **Lasso**, in Select's stack, chooses with a drawn outline. **Eraser** removes eligible sketch entities and dividing edges; a solid's actual boundary cannot simply be erased away.

Use **Line** for straight edges or **Freehand** for a drawn stroke. The Shape stack offers **Rectangle**, **Rotated Rectangle**, **Circle** and **Polygon** for regular boundaries. The Arc stack offers arc placement variants and **Pie**. Choose a variant according to the points or outline you need, then follow the tool's placement instructions.

## Push/Pull, Offset, Move, Rotate and Scale

**Push/Pull** gives a planar face depth or moves a region of an existing solid. **Offset** derives a parallel boundary from an existing outline. Use them to build from a face or outline instead of manually redrawing every edge.

**Move** changes position, **Rotate** changes orientation, and **Scale** changes size. Work in the intended group or component and check the selection before changing geometry. For **Follow Me**, click the profile face, hover along connected sketch path edges, then click to finish. With path edges preselected, clicking the profile applies the sweep immediately.

## Solid tools

The Solid stack includes **Outer Shell**, **Union**, **Subtract**, **Trim**, **Intersect** and **Split**. These operate on solids, unlike Layout's page-based Boolean tools. Use the tool matching whether you want to combine volumes, remove one volume from another, keep their overlap, or divide them.

The inputs and the result must be valid solids in the current editing context. With no preselection, click the first solid then the second to apply. For Subtract and Trim, pick the cutter first and the target second. Subtract consumes the cutter; Trim keeps it. Two preselected solids apply on activation. A loose edge or zero-thickness sheet is not a solid operand. Undo restores a completed operation.

## Measure, Text, Paint and Tag

**Tape Measure** and **Protractor** help measure distances and angles. **Dimension** adds measured annotations. **Text** annotates the model; **3D Text** creates letter geometry. **Axes** works with the coordinate reference rather than placing ordinary text or geometry.

**Paint Bucket** applies the chosen material. **Tag** is for model organization; tag visibility can hide content from drawing, picking and snapping. Select the appropriate operation instead of treating every visual change as geometry editing.

## Orbit, Pan, Zoom and Zoom Extents

**Orbit** changes the view direction, **Pan** shifts the camera view, and **Zoom** changes framing. **Zoom Window** focuses on a chosen screen region. **Zoom Extents** frames the model and is useful when you have lost sight of it.

These camera controls change what you see, not the model's dimensions. Use Scale when you intend to change geometry size, and a camera control when you only want a closer view.
