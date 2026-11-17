// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
const template = z.object({ definitionId: z.number().int().positive(), sourceTransform: z.array(z.number().finite()).length(16).optional(), width: z.number().finite().positive(), height: z.number().finite().positive(), kind: z.enum(['knob', 'pull']) }).strict();
export const cabinetHardwarePlacement = z.object({
  doors: template.optional(), drawers: template.optional(),
  doorEdgeInset: z.number().finite().positive().optional(), doorEndInset: z.number().finite().positive().optional(),
  drawerPosition: z.enum(['center', 'top']).optional(), drawerTopInset: z.number().finite().positive().optional(),
  wideDrawers: z.enum(['single', 'double', 'auto']).optional(),
}).strict().describe('Existing front-mounted component definitions, origin at mounting center, projecting toward local -y. Dimensions in meters. Doors use opening stile and accessible end; drawers center, with two pulls above 24 inches in auto mode.');
