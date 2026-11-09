// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { defineBuilder, hexColor, length, position } from './spec';

export const cabinetDoorBuilder = defineBuilder({
  summary: 'one cabinet door on its own: slab, shaker, raised panel or glass',
  guidance: 'Use when the request is for a door or a door sample, not a whole cabinet; add_cabinet already makes the doors of a cabinet. The door stands upright with its face toward -y. It has a square top: build an arched door by hand.',
  schema: z.object({
    width: length, height: length,
    style: z.enum(['slab', 'shaker', 'raised', 'glass', 'beadboard']).optional().describe('Default shaker.'),
    stileWidth: length.optional().describe('Stiles and rails. Default 0.05715.'),
    glass: z.object({ pattern: z.enum(['single', 'grid', 'prairie', 'mission']).optional(), across: z.number().int().min(1).max(6).optional(), down: z.number().int().min(1).max(6).optional(), type: z.enum(['clear', 'frosted', 'seeded', 'reeded']).optional() }).optional(),
    at: position.optional().describe('Front left bottom corner. Default the origin.'),
    finish: z.object({ paint: hexColor.optional(), stain: z.string().max(100).optional().describe('A model_material_library key.') }).optional().describe('Default off-white paint.'),
    name: z.string().trim().min(1).max(200).optional(),
  }),
  example: { width: 0.4572, height: 0.762, style: 'raised' },
});
