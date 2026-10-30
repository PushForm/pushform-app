// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { Color } from 'three';

/** Default face front color (white), back color, and selection blue, until a style sets them. */
export const FRONT_COLOR = 0xffffff;
export const BACK_COLOR = 0x9fb4cb;
export const SELECT_COLOR = 0x2d5bd1;

/**
 * The style colors renderables read: the front and back of faces painted with the default material,
 * baked into vertex colors when a body or sketch is built, and the selection color, which shaders share by reference
 * so changing it needs no rebuild.
 */
export const palette = {
  front: new Color(FRONT_COLOR),
  back: new Color(BACK_COLOR),
  select: new Color(SELECT_COLOR),
};
