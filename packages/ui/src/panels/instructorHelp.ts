// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Static Instructor text per tool id. One
 * paragraph plus the modifier keys; the live step hint comes from the tool's `status()`.
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
      'Click to start a line and click again to end it; the tool keeps chaining from the last point until Esc. Type a length in the Measurements box at any time. Lines split the edges and faces they cross, and a closed loop of coplanar lines makes a face.',
    keys: [
      ['Shift', 'Lock the current inference'],
      ['↑ / → / ←', 'Lock to the blue, red or green axis'],
      ['↓', 'Lock parallel / perpendicular to the last edge'],
      ['Alt', 'Cycle inference modes (all / off / parallel-perpendicular)'],
    ],
  },
  rectangle: {
    summary:
      'Click a corner, move diagonally and click the opposite corner; the plane follows the hovered face or the drawing axes. Type length,width (either value may be left out) and negative values flip the direction. Blue dots and a tip show Square and Golden Section inferences.',
    keys: [
      ['Shift', 'Hold the Square / Golden Section inference'],
      ['Ctrl', 'Draw from the center'],
      ['↑ / → / ←', 'Lock the drawing plane to an axis'],
    ],
  },
  circle: {
    summary:
      'Click the center, move to set the radius and click. Before the first click, type the number of sides (24 or 24s); afterwards type a radius. Edit radius and segments later in Entity Info.',
    keys: [
      ['↑ / → / ←', 'Pick the circle normal'],
      ['Shift', 'Lock the drawing plane'],
    ],
  },
  arc2: {
    summary:
      'Click the two endpoints of the arc, then move to set the bulge and click. Half-circle and tangent inferences snap the bulge; type a bulge distance, radius (r) or segment count (s) in the Measurements box.',
    keys: [
      ['Shift', 'Lock the inferred bulge or tangency'],
      ['↑ / → / ←', 'Lock the arc plane'],
    ],
  },
  arc: {
    summary:
      'Click the center, click to set the radius and start angle, then move and click to set the end angle. Type a radius (r) or segment count (s) in the Measurements box.',
    keys: [
      ['Shift', 'Lock the arc plane'],
      ['↑ / → / ←', 'Lock the arc plane to an axis'],
    ],
  },
  pushpull: {
    summary:
      'Click a face, move to extrude it and click again (or type a distance). Pulling adds material; pushing into the body removes it and pushing through to the back face cuts a hole. Hover another face to match its height. Double-click repeats the last distance.',
    keys: [
      ['Ctrl', 'Keep the starting face (stack a new solid)'],
      ['Alt', 'Stretch mode (move the face, stretch neighbors)'],
      ['Shift', 'Lock the push/pull direction'],
    ],
  },
  move: {
    summary:
      'Select, click a reference point, move and click the destination (with nothing selected the hovered entity moves). Type a distance, an absolute [x,y,z] or a relative <x,y,z>. After a copy, type 3x for an external array or 3/ for an internal one.',
    keys: [
      ['Ctrl', 'Tap to toggle copy'],
      ['Alt', 'Autofold (allow faces to fold)'],
      ['Shift', 'Lock the current inference'],
      ['↑ / → / ←', 'Lock to an axis'],
    ],
  },
  rotate: {
    summary:
      'Place the protractor on a face or axis, click the baseline start, then move to the end angle and click. The protractor snaps every 15° near its rim and finer farther out. Type degrees or a rise:run slope.',
    keys: [
      ['Ctrl', 'Rotate a copy (then 3x or 3/ for radial arrays)'],
      ['Shift', 'Lock the protractor plane'],
      ['Alt', 'Free the protractor center'],
      ['↑ / → / ←', 'Pick the rotation axis'],
    ],
  },
  scale: {
    summary:
      'Select, then drag a green grip of the yellow box: corner grips scale uniformly, edge grips scale in two directions, face grips in one. Type a factor, three factors x,y,z, or a length with a unit; negative values mirror.',
    keys: [
      ['Ctrl or Alt', 'Scale about the center'],
      ['Shift', 'Maintain aspect ratio (on a corner grip, scale freely)'],
    ],
  },
  offset: {
    summary:
      'Click a face (or two or more preselected coplanar connected edges), move to set the offset distance and click, or type a distance. Double-click another face to repeat the same offset.',
    keys: [['Alt', 'Allow overlapping offsets']],
  },
  tape: {
    summary:
      'Click two points to measure, or click an edge and move away to drop a parallel guide line; click an endpoint to drop a guide point. Measure a known length, type a new value and confirm to resize the model.',
    keys: [
      ['Ctrl', 'Cycle Guide Lines / Guide Points / Measure'],
      ['↑ / → / ←', 'Lock to an axis'],
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
      ['Ctrl (Mac: Option)', 'Fill adjacent faces with the same material'],
      ['Shift', 'Replace that material everywhere in the context'],
      ['Ctrl+Shift (Mac: Option+Shift)', 'Replace on the same object only'],
      ['Alt (Mac: Cmd)', 'Sample a material'],
    ],
  },
  orbit: { summary: 'Drag to orbit the camera around the model. The middle mouse button orbits from any tool.', keys: [['Shift', 'Pan instead of orbit']] },
  pan: { summary: 'Drag to slide the view. Shift + middle button pans from any tool.', keys: [] },
  zoom: { summary: 'Drag up to zoom in, down to zoom out; the wheel zooms toward the cursor. Type 35deg or 50mm to set the field of view or focal length.', keys: [['Shift', 'Change field of view by dragging']] },
  zoomWindow: { summary: 'Drag a rectangle to fill the view with it.', keys: [] },
  texturePosition: {
    summary:
      'Drag the pins to position the texture on the face: red moves, green scales and rotates about the red pin, blue scales and shears, yellow distorts. Right-click for Done, Reset, Flip and Rotate.',
    keys: [
      ['Enter', 'Done'],
      ['Esc', 'Cancel and restore the previous position'],
    ],
  },
};
