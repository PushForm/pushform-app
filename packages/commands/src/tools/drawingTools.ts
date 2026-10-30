// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Tool } from './Tool';
import { ArcTool } from './impl/Arc';
import { CircleTool } from './impl/Circle';
import { FreehandTool } from './impl/Freehand';
import { PieTool } from './impl/Pie';
import { PolygonTool } from './impl/Polygon';
import { RotatedRectangleTool } from './impl/RotatedRectangle';
import { ThreePointArcTool } from './impl/ThreePointArc';
import { TwoPointArcTool } from './impl/TwoPointArc';

/**
 * Fresh instances of the curve / shape drawing tools (ids `circle`, `polygon`, `arc`, `arc2`,
 * `arc3`, `pie`, `freehand`, `rotrect`) for `ToolManager.register`. `defaultKeymap.json` binds
 * C → circle and A → arc2; the others have no default key. They need `curveCommands` registered.
 */
export function drawingTools(): Tool[] {
  return [
    new CircleTool(),
    new PolygonTool(),
    new ArcTool(),
    new TwoPointArcTool(),
    new ThreePointArcTool(),
    new PieTool(),
    new FreehandTool(),
    new RotatedRectangleTool(),
  ];
}
