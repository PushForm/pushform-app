// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { defineBuilder, hexColor, length, position } from './spec';

export const fillerBuilder = defineBuilder({
  summary: 'a strip in the door finish that closes a gap beside a cabinet',
  guidance: 'Use for the gap between a cabinet and a wall, or between two cabinets, such as beside a blind corner door. Place it with at, its front left bottom corner; the default sits against the left side of a cabinet at the origin, flush with its doors. For a cabinet with no toe kick, or one of a non-default height, give height and at. It makes a plain strip with an optional return, not a tall or wide panel (over 12 in wide, use end_panel or add_cabinet), and it does not scribe to a wall or change the cabinets beside it.',
  schema: z.object({
    width: length.describe('Face width along x. 0.0127 to 0.3048.'),
    type: z.enum(['base', 'wall', 'tall', 'vanity']).optional().describe('The cabinet it matches, which sets its height and position. Default base.'),
    height: length.optional().describe('Default as tall as that cabinet\'s front: base 0.7747, tall 2.032, vanity 0.6985, wall 0.762.'),
    thickness: length.optional().describe('Default 0.01905.'),
    at: position.optional().describe('Front left bottom corner. Default [-width, -thickness, 0.1016], or z 1.3716 for a wall type: against the left side of a cabinet at the origin, flush with its doors.'),
    return: z.object({ side: z.enum(['left', 'right']), depth: length.optional().describe('Default 0.0762, at most 0.6096.') }).optional().describe('A strip behind one edge running back along y, so the filler can turn a corner or back a blind-corner door.'),
    finish: z.object({ paint: hexColor.optional(), stain: z.string().max(100).optional().describe('A model_material_library key.') }).optional().describe('Match the cabinet. Default the cabinet off-white paint.'),
    name: z.string().trim().min(1).max(200).optional(),
  }),
  example: { width: 0.0762, type: 'base', return: { side: 'left', depth: 0.0762 } },
});
