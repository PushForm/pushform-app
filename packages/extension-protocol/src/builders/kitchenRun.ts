// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { defineBuilder, hexColor, length, position } from './spec';

const doorStyle = z.enum(['slab', 'shaker', 'raised', 'glass', 'none']);
const item = z.object({
  width: length, appliance: z.enum(['dishwasher', 'range', 'refrigerator']).optional().describe('An opening instead of a cabinet. A dishwasher keeps the countertop going; a range or refrigerator breaks it.'),
  name: z.string().trim().min(1).max(200).optional(),
  doors: z.number().int().min(0).max(2).optional(), drawers: z.number().int().min(0).max(4).optional(), drawerBoxes: z.boolean().optional(), drawerFronts: z.enum(['auto', 'slab', 'match']).optional(), sinkFront: z.boolean().optional().describe('Also cuts a sink opening in the countertop above.'), shelves: z.number().int().min(0).max(8).optional(), doorStyle: doorStyle.optional(),
  glass: z.object({ pattern: z.enum(['single', 'grid', 'prairie', 'mission']).optional(), across: z.number().int().min(1).max(6).optional(), down: z.number().int().min(1).max(6).optional(), type: z.enum(['clear', 'frosted', 'seeded', 'reeded']).optional() }).optional(),
  stackedDoors: z.boolean().optional(), upperDoorHeight: length.optional(), upperDoorStyle: z.enum(['slab', 'shaker', 'raised', 'glass']).optional(), finishedInterior: z.boolean().optional(),
});

export const kitchenRunBuilder = defineBuilder({
  summary: 'a whole kitchen: base and wall cabinets, a corner, returns and countertops',
  guidance: 'Use when a request lays out several cabinets along a wall or around one corner. Items run left to right along the back wall, with fronts facing -y; a return runs away from the corner along the side wall. For one cabinet use add_cabinet. It handles one straight wall or one L. Build U-shaped kitchens and islands as separate runs and move them into place, and add hardware afterwards. Appliances are openings: it draws no appliance. Keep a base cabinet at least 9 in wide between every appliance opening and an inside corner, on both runs; a corner cabinet or filler alone is insufficient. Apply this rule across separate runs too, including U-shaped kitchens.',
  schema: z.object({
    at: position.optional().describe('Floor level at the front left of the back wall row. Default the origin.'),
    base: z.array(item).min(1).max(30).describe('Base row, left to right.'),
    wall: z.array(item).max(30).optional().describe('Wall row. Left-aligned, or against the corner when there is one. Use an opening item to leave a gap over a range.'),
    corner: z.object({
      style: z.enum(['blind', 'diagonal', 'l_shaped']), side: z.enum(['left', 'right']).optional().describe('Which end of the back wall. Default left.'),
      width: length.optional().describe('Base corner cabinet. Default 0.9144, or 1.0668 for blind.'), wallWidth: length.optional().describe('Wall corner cabinet. Default 0.6096, or 0.762 for blind.'), filler: length.optional().describe('Blind corners: filler strip at the return. Default 0.0762.'), lazySusan: z.boolean().optional(),
      returnBase: z.array(item).max(30).describe('Base row along the side wall, starting at the corner.'), returnWall: z.array(item).max(30).optional(),
    }).optional(),
    frame: z.enum(['frameless', 'face_frame']).optional(), overlay: z.enum(['full', 'partial', 'inset']).optional(), doorStyle: doorStyle.optional().describe('Default for every cabinet.'),
    boxFinish: z.object({ paint: hexColor.optional(), library: z.string().max(100).optional() }).optional(), beadedFrame: z.boolean().optional(), hardware: z.enum(['none', 'bar', 'knob']).optional(), hardwareFinish: hexColor.optional(),
    finish: z.object({ paint: hexColor.optional(), stain: z.string().max(100).optional() }).optional(), wallHeight: length.optional().describe('Default 0.762.'),
    countertop: z.boolean().optional().describe('Default true.'), countertopFinish: z.object({ paint: hexColor.optional(), library: z.string().max(100).optional() }).optional(), backsplash: length.optional(),
    name: z.string().trim().min(1).max(200).optional(),
  }),
  example: { base: [{ width: 0.6096 }, { width: 0.762, sinkFront: true }, { width: 0.6096, appliance: 'dishwasher' }, { width: 0.4572, doors: 0, drawers: 3 }], wall: [{ width: 0.762 }, { width: 0.762 }] },
});
