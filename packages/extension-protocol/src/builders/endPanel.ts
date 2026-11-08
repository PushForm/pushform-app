// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { defineBuilder, hexColor, length, position } from './spec';

export const endPanelBuilder = defineBuilder({
  summary: 'a finished panel in the door finish for the exposed end of a cabinet run',
  guidance: 'Use for the exposed side of a base, wall or tall cabinet run. Place it with at, its front left bottom corner, against the cabinet end; the default is against the left side of a cabinet at the origin. The result is one flat panel: it is not a door, a back or a five-piece (shaker) panel, and it does not scribe to a wall. A cabinet with finishedEnds already has a finished side, so use one or the other.',
  schema: z.object({
    type: z.enum(['base', 'wall', 'tall', 'vanity']).optional().describe('The cabinet it covers, which sets its size and position. Default base.'),
    height: length.optional().describe('Default that cabinet\'s overall height: base 0.8763, wall 0.762, tall 2.1336, vanity 0.8001.'),
    depth: length.optional().describe('Along y. Default that cabinet\'s box depth plus 0.01905, so its front edge is flush with the doors: base and tall 0.6096, wall 0.3048, vanity 0.5525.'),
    thickness: length.optional().describe('Default 0.01905; 0.00635 for an applied skin.'),
    toeKick: z.union([z.boolean(), z.object({ height: length.optional().describe('Default 0.1016.'), depth: length.optional().describe('Default 0.0762, from the front edge.') })]).optional().describe('Front bottom notch of a base, tall or vanity panel. Default the notch; false leaves it out. A wall panel takes none.'),
    at: position.optional().describe('Front left bottom corner. Default [-thickness, -0.01905, 0], or z 1.3716 for a wall type: against the left side of a cabinet at the origin, front edge flush with its doors.'),
    finish: z.object({ paint: hexColor.optional(), stain: z.string().max(100).optional().describe('A model_material_library key.') }).optional().describe('Match the cabinet. Default the cabinet off-white paint.'),
    name: z.string().trim().min(1).max(200).optional(),
  }),
  example: { type: 'base', thickness: 0.01905 },
});
