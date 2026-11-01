# Measuring and construction guides in Modeling

## Measure a distance with Tape Measure

Choose **Tape Measure** from the Measure dropdown. Tap Ctrl or Alt until the status says **Measure**; the other modes create guides. Click the start point, then the endpoint, and read the Length field beside the pointer. Hovering an edge also displays its length. Escape cancels an unfinished measurement.

Typing a new length after a completed measurement proposes resizing the whole model. Confirm that resize only when you intend to change model size; measuring alone does not resize anything.

## Make a guide line or guide point with Tape Measure

Choose **Tape Measure** and tap Ctrl or Alt to cycle to **Guide Lines**. Click along an edge, away from its endpoints, move to the desired side, then click to place a parallel guide. For exact spacing, move toward that side and type a distance, then press Enter instead of the second click.

For a guide point, cycle to **Guide Points**, click a starting point, then click the guide point's position or enter its distance. Clicking an endpoint in Guide Lines mode also starts a guide point. Escape cancels unfinished placement; Undo removes a completed guide.

## Measure an angle or make a guide with Protractor

Choose **Protractor** from the Measure dropdown. Hover a face to orient the protractor; hold Shift to keep that plane. Click the angle's vertex, then click a point along its baseline. Move to read the angle, and click a third time to finish, or type an angle and press Enter.

By default, finishing creates a guide line at that angle. Tap Ctrl or Alt to toggle guide creation before finishing; the status says **Guide creation off** when you are only measuring. Escape cancels the pending angle. Right, Left and Up lock the plane normal to the red, green and blue axes; Down releases the axis lock.

## Place the drawing Axes

Choose **Axes** from the Measure dropdown. Click the new origin, click a point in the red-axis direction, then click toward the green-axis direction to finish. The third direction is set automatically. Use points that give distinct directions. Escape cancels unfinished placement.

Double-click a new origin instead to retain the current orientation. Ctrl or Alt cycles which axis is placed first; check the named axis in the status before clicking. This changes the drawing axes in the current editing context; it does not move the geometry. Undo restores the previous axes.
