// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { defineBuilder, hexColor, length, position } from './spec';

export const countertopBuilder = defineBuilder({
  summary: 'a straight or L-shaped countertop with sink cutouts and a backsplash',
  guidance: 'Use for a countertop over base cabinets. For a whole kitchen, kitchen_run adds its countertops itself. It makes flat slabs with square edges: build a curved or waterfall top by hand.',
  schema: z.object({
    width: length.describe('Along x, the whole top.'),
    depth: length.optional().describe('Front to back. Default 0.635.'),
    thickness: length.optional().describe('Default 0.0381.'),
    at: position.optional().describe('Front left bottom corner of the bounding box. Default [0, -0.04445, 0.8763], which sits on a base cabinet at the origin with a 1 in overhang past its doors.'),
    leg: z.object({ side: z.enum(['left', 'right']), length: length.describe('How far the leg comes forward of the main top.'), depth: length.optional().describe('Across the leg. Default the main depth.'), chamfer: length.optional().describe('Angles the inside corner, for a diagonal corner cabinet: how far along each edge.') }).optional().describe('Makes an L: a leg coming forward at one end.'),
    cutouts: z.array(z.object({ x: length.describe('Left edge, measured from the left of the top.'), width: length, depth: length.optional().describe('Default 0.4064.'), fromFront: length.optional().describe('Default 0.0635.') })).max(4).optional().describe('Openings for sinks or cooktops, in the main top.'),
    backsplash: length.optional().describe('Height of a 3/4 in backsplash along the back. Default none.'),
    finish: z.object({ paint: hexColor.optional(), library: z.string().max(100).optional().describe('A model_material_library key.') }).optional().describe('Default an off-white solid surface.'),
    name: z.string().trim().min(1).max(200).optional(),
  }),
  example: { width: 1.2192, cutouts: [{ x: 0.3, width: 0.6 }], backsplash: 0.1016 },
});
