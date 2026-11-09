// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

/** Trade dimensions of US kitchen casework, in meters. */

export const inches = (n: number): number => n * 0.0254;

export const STOCK = inches(3 / 4);
export const BACK = inches(1 / 4);
export const BACK_RABBET = inches(3 / 8);
export const STRETCHER = inches(4);

export const TOE_KICK_HEIGHT = inches(4);
export const TOE_KICK_DEPTH = inches(3);
export const WALL_HANG_HEIGHT = inches(54);

export const FRAME_WIDTH = inches(1.5);
export const REVEAL = inches(1 / 16);
export const GAP = inches(1 / 8);
export const PARTIAL_OVERLAY = inches(1 / 2);
export const FULL_OVERLAY = inches(1.25);

export const STILE = inches(2.25);
export const GROOVE_WIDTH = inches(1 / 4);
export const GROOVE_DEPTH = inches(3 / 8);
export const GROOVE_SHOULDER = (STOCK - GROOVE_WIDTH) / 2;
export const PANEL = inches(1 / 4);
export const PANEL_CLEARANCE = inches(1 / 8);
export const MIN_PANEL_OPENING = inches(2);

export const RAISED_PANEL = inches(5 / 8);
export const RAISED_TONGUE = inches(1 / 4);
export const RAISED_BEVEL = inches(1.5);
/** How far the back relief and the front bevel start in from the panel's edge: past the groove, with room to move. */
export const RAISED_RELIEF = inches(3 / 8);

export const GLASS = inches(1 / 8);
export const GLASS_RABBET = inches(3 / 8);
export const GLASS_KEYS = { clear: 'Translucent_Glass_Clear', frosted: 'Translucent_Glass_Frosted', seeded: 'Translucent_Glass_Seeded', reeded: 'Translucent_Glass_Reeded' } as const;
export const MULLION = inches(5 / 8);
export const MIN_LITE = inches(1.5);
export const PRAIRIE_CORNER = inches(2);
export const MISSION_BAND_SHARE = 0.28;
export const DEFAULT_LITES_ACROSS = 2;
export const DEFAULT_LITES_DOWN = 3;

export const UPPER_DOOR_SHARE = 0.3;
export const MIN_CORNER_FACE = inches(9);
export const MIN_BLIND = inches(6);
export const DEFAULT_BLIND_DOOR = inches(18);
export const TRAY_SEGMENTS = 48;

export const DRAWER_FRONT = inches(6);
export const SLAB_DRAWER_BELOW = inches(7);
export const DRAWER_SIDE = inches(1 / 2);
export const DRAWER_BOTTOM = inches(1 / 4);
export const DRAWER_SLIDES = inches(1);
export const DRAWER_CLEARANCE = inches(1 / 2);
export const DRAWER_BOTTOM_INSET = inches(1 / 2);
export const MIN_DRAWER_HEIGHT = inches(2);
export const MIN_DRAWER_LENGTH = inches(6);

export const SHELF_SIDE_CLEARANCE = inches(1 / 32);
export const SHELF_BACK_CLEARANCE = inches(1 / 16);
export const SHELF_SETBACK = inches(1 / 2);
export const MIN_SHELF_SPACE = inches(2);

export const MIN_SLAB = inches(3);
export const MIN_DOOR_HEIGHT = inches(8);

export const WIDTH_RANGE = [inches(9), inches(48)] as const;
export const HEIGHT_RANGE = [inches(12), inches(108)] as const;
export const DEPTH_RANGE = [inches(9), inches(30)] as const;

export const DEFAULT_HEIGHT = { base: inches(34.5), wall: inches(30), tall: inches(84) } as const;
export const DEFAULT_DEPTH = { base: inches(23.25), wall: inches(11.25), tall: inches(23.25) } as const;
export const SINGLE_DOOR_UP_TO = inches(24);

/** Library key of the prefinished maple the box and drawer boxes are made of. */
export const BOX_MATERIAL_KEY = 'Wood_white_maple_veneer';
export const DEFAULT_PAINT = '#f2efe6';
