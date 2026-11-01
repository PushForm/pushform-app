# Drawing lines and shapes in Layout

## Draw connected straight lines

Choose **Line** from the Draw group. Click a start point, then click each endpoint to continue the path. Click the starting point to close a boundary. Closing creates a filled shape using the current fill style. Press Escape to end an unfinished chain; the straight segments already drawn remain as an open path.

While placing a segment, hold Shift to constrain it horizontally or vertically. After the start point, type an exact length, or a length and an angle, as described in [Type exact values](#type-exact-values).

## Draw a Bézier curve

Open the Line button's arrow and choose **Bézier Curve**. Click to place a sharp corner, or press and drag to pull out smooth curve handles. Continue placing anchors. Click the first anchor to close and fill the path. Press Enter or Escape to finish an open path. Switching tools or pages discards an unfinished Bézier curve.

The finished curve remains editable: select it and enter vertex editing to move its anchors and handles.

## Draw freehand

Choose **Freehand** from the Line button's arrow. Press and drag to draw, then release to finish. The stroke is smoothed into an editable curved path and stays open and unfilled. Freehand follows the pointer without grid or object snapping.

Escape, switching tools, or changing pages cancels an unfinished stroke.

## Draw rectangles, rounded rectangles and lozenges

Open the Rectangle button's arrow and choose **Rectangle**, **Rounded**, **Bulged**, or **Lozenge**. Drag between opposite corners, or click each corner. Hold Shift for square bounds. Hold Ctrl, or Cmd on macOS, to draw outward from the center. The modifiers can be combined.

After the first point, type the width and height. Rounded and Bulged show their radius or bulge controls in the temporary tool pane on the right. Lozenge makes a capsule with fully rounded ends.

## Draw circles and ellipses

Choose **Circle**, click the center, then click a point on the circle. You can also drag from the center. After setting the center, type an exact radius.

Choose **Ellipse** from the Circle button's arrow. Place opposite corners of its bounding box. Shift makes the bounds square, and Ctrl or Cmd draws outward from the center. After the first point, type the width and height.

## Draw an arc or pie

The Arc button's arrow offers **Arc**, **2 Point Arc**, **3 Point Arc**, and **Pie**.

For Arc, click the center, a start point, and an end direction. For 2 Point Arc, click its two ends and then its bulge. For 3 Point Arc, click the start, a point the arc passes through, and its end. Pie uses the center-start-end sequence and closes the arc with two straight radii.

Follow the status bar for the current step. Escape cancels unfinished placement. Repeated or collinear points may not define a valid arc; correct the point instead of expecting an object to be created.

## Repeat the last drawn shape

With a Rectangle variant, Circle, Ellipse, or Polygon active, double-click to place a copy of the last shape drawn with that tool. It keeps its size and shape, but uses the current drawing style. Each tool remembers its own last shape for the open drawing. Before that tool has drawn a shape, double-clicking creates nothing.

## Type exact values

While a tool places a shape, the values it can take appear as small fields on the page, next to the part of the preview they measure. Gray dimension lines tie each field to what it measures, and the fields sit outside the shape so they don't cover it. Each field shows the live value as you move the pointer.

You don't need to click a field. Start typing and the value goes into the first field. Press **Tab** to move to the next field and **Shift+Tab** to go back. Press **Enter** to apply. Any field you didn't type in keeps its live value. Press **Escape** to discard what you typed and cancel the shape. If a value can't be read, its field turns red and the status bar says why.

## Values for each Layout drawing tool

- **Line**: Length and Angle. The angle is measured from the right, and positive angles turn clockwise on the page, as in Rotate.
- **Rectangle, its variants, Ellipse and Table**: Width and Height, on the side of the first corner the pointer is on. Type a negative value to flip a side.
- **Circle and Polygon**: Radius.
- **Arc and Pie**: Radius after the center, then Angle for the sweep. A typed angle keeps the direction you are sweeping; type a negative angle for the other way.
- **2 Point Arc**: Length of the chord, then Bulge, the arc's height over the chord, on the pointer's side.
- **3 Point Arc**: Length to the second point; click the last point.

In Line and the box-shaped tools, a value you leave with **Tab** is locked: the preview keeps it while the pointer sets the other. For example, type a rectangle's width, press Tab, then move the pointer to set its height and click.

A length without a unit uses the document's units; type a unit to override them, for example **10mm** or **2.5in**. You can also type a whole entry into the first field, such as **60mm, 20mm** for a width and height, or **8s** for a polygon's side count.
