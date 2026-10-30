// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Tool } from './Tool';
import { SectionPlaneTool } from './impl/SectionPlane';
import { AxesTool } from './impl/AxesTool';
import { DimensionTool } from './impl/Dimension';
import { TextTool } from './impl/TextTool';
import { FollowMeTool } from './impl/FollowMe';
import { OffsetTool } from './impl/Offset';
import { ProtractorTool } from './impl/Protractor';
import { solidTools } from './impl/SolidTool';
import { edgeBlendTools } from './impl/EdgeBlend';
import { TapeTool } from './impl/Tape';

/**
 * Fresh instances of the construction / solid tools for `ToolManager.register`: Tape Measure (T),
 * Dimension, Protractor, Axes, Offset (F), Follow Me, Fillet, Chamfer and one Solid Tool per mode (`solid.union`,
 * `solid.subtract`, `solid.trim`, `solid.intersect`, `solid.split`, `solid.outerShell`).
 * They need the `guideCommands`, `dimensionCommands`, `axesCommands`, `offsetCommands`, `followMeCommands`,
 * `edgeBlendCommands` and `solidCommands` arrays registered on the same registry.
 */
export function constructionTools(): Tool[] {
  return [new TapeTool(), new DimensionTool(), new TextTool(), new ProtractorTool(), new SectionPlaneTool(), new AxesTool(), new OffsetTool(), new FollowMeTool(), ...edgeBlendTools(), ...solidTools()];
}
