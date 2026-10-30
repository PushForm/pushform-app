# Drawing lines and shapes in Layout

## Draw connected straight lines

Choose **Line** from the Draw group. Click a start point, then click each endpoint to continue the path. Click the starting point to close a boundary. Closing creates a filled shape using the current fill style. Press Escape to end an unfinished chain; the straight segments already drawn remain as an open path.

While placing a segment, hold Shift to constrain it horizontally or vertically. Enter an exact length in Measurements after placing the start point.

## Draw a Bézier curve

Open the Line button's arrow and choose **Bézier Curve**. Click to place a sharp corner, or press and drag to pull out smooth curve handles. Continue placing anchors. Click the first anchor to close and fill the path. Press Enter or Escape to finish an open path. Switching tools or pages discards an unfinished Bézier curve.

The finished curve remains editable: select it and enter vertex editing to move its anchors and handles.

## Draw freehand

Choose **Freehand** from the Line button's arrow. Press and drag to draw, then release to finish. The stroke is smoothed into an editable curved path and stays open and unfilled. Freehand follows the pointer without grid or object snapping.

Escape, switching tools, or changing pages cancels an unfinished stroke.

## Draw rectangles, rounded rectangles and lozenges

Open the Rectangle button's arrow and choose **Rectangle**, **Rounded**, **Bulged**, or **Lozenge**. Drag between opposite corners, or click each corner. Hold Shift for square bounds. Hold Ctrl, or Cmd on macOS, to draw outward from the center. The modifiers can be combined.

After the first point, Measurements accepts width and height. Rounded and Bulged show their radius or bulge controls in the temporary tool pane on the right. Lozenge makes a capsule with fully rounded ends.

## Draw circles and ellipses

Choose **Circle**, click the center, then click a point on the circle. You can also drag from the center. After setting the center, enter an exact radius in Measurements.

Choose **Ellipse** from the Circle button's arrow. Place opposite corners of its bounding box. Shift makes the bounds square, and Ctrl or Cmd draws outward from the center. Measurements accepts width and height after the first point.

## Draw an arc or pie

The Arc button's arrow offers **Arc**, **2 Point Arc**, **3 Point Arc**, and **Pie**.

For Arc, click the center, a start point, and an end direction. For 2 Point Arc, click its two ends and then its bulge. For 3 Point Arc, click the start, a point the arc passes through, and its end. Pie uses the center-start-end sequence and closes the arc with two straight radii.

Follow the status bar for the current step. Escape cancels unfinished placement. Repeated or collinear points may not define a valid arc; correct the point instead of expecting an object to be created.

## Repeat the last drawn shape

With a Rectangle variant, Circle, Ellipse, or Polygon active, double-click to place a copy of the last shape drawn with that tool. It keeps its size and shape, but uses the current drawing style. Each tool remembers its own last shape for the open drawing. Before that tool has drawn a shape, double-clicking creates nothing.
