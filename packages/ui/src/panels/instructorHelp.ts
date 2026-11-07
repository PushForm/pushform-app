// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Static Instructor text per tool id: one paragraph plus the keys the tool handles, other than
 * the Ctrl and Alt taps of its tool options bar toggles, which the Instructor lists from the bar
 * itself. The live step hint comes from the tool's `status()`.
 */
export interface ToolHelp {
  readonly summary: string;
  readonly keys: readonly (readonly [key: string, meaning: string])[];
}

export const TOOL_HELP: Readonly<Record<string, ToolHelp>> = {
  select: {
    summary:
      'Click an entity to select it; click empty space to clear. Double-click a face to add its edges, an edge to add its faces, or a group to open it; triple-click selects everything connected. Drag left-to-right for a window selection (fully enclosed) or right-to-left for a crossing selection (anything touched).',
    keys: [
      ['Ctrl', 'Add to the selection'],
      ['Shift', 'Toggle in or out of the selection'],
      ['Ctrl+Shift', 'Remove from the selection'],
      ['Delete', 'Erase the selection'],
    ],
  },
  line: {
    summary:
      'Click to start a line and click again to end it; the tool keeps chaining from the last point until Esc. Type a length, and Tab to an angle, at any time; Tab locks the value into the preview. Lines split the edges and faces they cross, and a closed loop of coplanar lines makes a face.',
    keys: [
      ['Shift', 'Lock the current inference'],
      ['↑ / → / ←', 'Lock to the blue, red or green axis'],
      ['↓', 'Lock parallel / perpendicular to the last edge'],
      ['Alt', 'Cycle inference modes (all / off / parallel-perpendicular)'],
    ],
  },
  rectangle: {
    summary:
      'Click a corner, move diagonally and click the opposite corner; the plane follows the hovered face or the drawing axes. Type the width, Tab, then the height; a value left with Tab is locked, and negative values flip the side. Blue dots and a tip show Square and Golden Section inferences.',
    keys: [
      ['↑ / → / ←', 'Lock the drawing plane to an axis'],
      ['↓', 'Release the plane lock'],
    ],
  },
  circle: {
    summary:
      'Click the center, move to set the radius and click. Set the number of sides in the tool options bar, or type it as 24s; after the first click type a diameter, or a radius as 12r. Edit radius and segments later in Entity Info.',
    keys: [
      ['↑ / → / ←', 'Pick the circle normal'],
      ['Shift', 'Lock the drawing plane'],
    ],
  },
  arc2: {
    summary:
      'Click the two endpoints of the arc, then move to set the bulge and click. Half-circle and tangent inferences snap the bulge; type a bulge distance, radius (r) or segment count (s).',
    keys: [
      ['Shift', 'Lock the inferred bulge or tangency'],
      ['↑ / → / ←', 'Lock the arc plane'],
    ],
  },
  arc: {
    summary:
      'Click the center, click to set the radius and start angle, then move and click to set the end angle. Type the diameter, a radius (r) or segment count (s), then the angle.',
    keys: [
      ['Shift', 'Lock the arc plane'],
      ['↑ / → / ←', 'Lock the arc plane to an axis'],
    ],
  },
  pushpull: {
    summary:
      'Click a flat face, move to extrude it and click again, or drag and release; type a distance for an exact one. With one face selected, the next click anywhere pulls it. Pulling adds material; pushing into the solid removes it and pushing through to the back face cuts a hole. Hover a face within 30° of parallel to match its height. Type a distance right after a pull to redo it; double-click a face to repeat the last distance.',
    keys: [
    ],
  },
  move: {
    summary:
      'Select, click a base point, move and click the destination. With nothing selected, a press picks up what a Select click there would select; Esc cancels and deselects it. Type a length (lock an axis first if the pointer has not moved), [x,y,z] for the base point or <x,y,z> to move by. After a copy, type 3x or /3 for an array, then a length for its spacing.',
    keys: [
      ['Shift', 'Lock the current inference'],
      ['↓', 'Lock parallel / perpendicular to the last edge'],
      ['↑ / → / ←', 'Lock to the blue, red or green axis'],
    ],
  },
  rotate: {
    summary:
      'Place the protractor on a face or axis, click the center, click the starting direction, then move to the angle and click. With angle snapping on in Model Info the angle snaps to the snap angle shown by the ticks. Type degrees (45) or a rise:run slope; it turns the way the preview turns, a negative value the other way. After a copy, type 3x for more copies at the same step or /3 to spread them over the angle turned.',
    keys: [
      ['Shift', 'Hold the protractor plane (before the center)'],
      ['↑ / → / ←', 'Lock the protractor square to an axis (before the center)'],
    ],
  },
  scale: {
    summary:
      'Select, then drag a green grip of the yellow box: corner grips scale uniformly, edge grips scale in two directions, face grips in one. Type a factor, three factors x,y,z, or a length with a unit (the size along a face grip, or of the longest side for a corner or edge grip); negative values mirror.',
    keys: [
      ['Ctrl or Alt', 'Scale about the center'],
      ['Shift', 'Maintain aspect ratio (on a corner grip, scale freely)'],
    ],
  },
  offset: {
    summary:
      'Click a face of the context you are editing (or two or more preselected connected edges in one plane) and click again, or press, drag and release; inside the face insets, outside outsets. Type a distance for the pointer\'s side, a negative one for the other side; typed right after, it redoes the offset. Double-click a face to repeat the last face offset.',
    keys: [],
  },
  tape: {
    summary:
      'Click two points to measure, or click an edge and move away to drop a parallel guide line; click an endpoint to drop a guide point. Measure a known length, type a new value and choose Resize Model in the tool options bar to resize the model.',
    keys: [
      ['Shift', 'Lock the current inference'],
      ['↑ / → / ←', 'Lock to an axis'],
      ['↓', 'Lock parallel / perpendicular to the last edge'],
    ],
  },
  dimension: {
    summary:
      'Click two points, or an edge, then move the dimension line away and click to place it. Click an arc for its radius or a circle for its diameter, then move the text out and click. Dimensions picked at vertices follow the geometry when it changes.',
    keys: [['Esc', 'Cancel the dimension']],
  },
  eraser: {
    summary:
      'Click or drag across edges to erase them; faces bounded by an erased edge go with it. Faces cannot be erased directly (select them and press Delete). Guides can be erased too.',
    keys: [
      ['Shift', 'Hide instead of erase'],
      ['Ctrl', 'Soften / smooth the edge'],
      ['Ctrl+Shift', 'Unsoften the edge'],
    ],
  },
  paint: {
    summary:
      'Pick a material in the Materials panel, then click a face or an object to paint it. Painting a group or component sets its default material; faces with their own material keep it.',
    keys: [
      ['Ctrl', 'Fill adjacent faces with the same material'],
      ['Shift', 'Replace that material everywhere in the context'],
      ['Ctrl+Shift', 'Replace on the same object only'],
      ['Alt', 'Sample a material'],
    ],
  },
  orbit: {
    summary: 'Drag to orbit the camera around the model. The middle mouse button orbits from any tool.',
    keys: [
      ['Shift', 'Pan instead of orbit (hold before you drag)'],
      ['Ctrl', 'Free orbit: the view can roll, with no up direction kept'],
    ],
  },
  pan: { summary: 'Drag to slide the view. Shift + middle button pans from any tool.', keys: [] },
  zoom: { summary: 'Drag up to zoom in, down to zoom out; the wheel zooms toward the cursor. Type 35deg or 50mm to set the field of view or focal length.', keys: [] },
  zoomWindow: { summary: 'Drag a rectangle to fill the view with it.', keys: [] },
  texturePosition: {
    summary:
      'Drag the pins to position the texture on the face: red moves, green scales and rotates about the red pin, blue scales and shears, yellow distorts. Done, Reset, Flip and Rotate are in the tool options bar and the right-click menu.',
    keys: [
      ['Enter', 'Done'],
      ['Esc', 'Cancel and restore the previous position'],
    ],
  },
};
