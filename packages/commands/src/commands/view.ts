// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { PushFormError } from '@pushform/core';
import { defineCommand } from '../registry/Command';
import type { AnyCommand, CommandContext } from '../registry/Command';
import { displayOf } from '../host/services';
import { DISPLAY_KEYS, FACE_STYLES } from '../host/DisplayHost';
import type { DisplayKey, DisplayState } from '../host/DisplayHost';
import { DocumentHost } from '../host/DocumentHost';
import { SERVICE_DOCUMENT } from '../host/services';
import { patchActiveStyle, styleDisplayPatch } from './styles';

/**
 * View › Display commands (Display panel). Display state is runtime state (not on
 * the undo stack) kept by the `DisplayHost` service; the renderer reads it from the UI store.
 */

const toggleParams = z.object({ value: z.boolean().optional() });

/** Back Edges and X-ray are mutually exclusive. */
function exclusive(key: DisplayKey, value: boolean): Partial<DisplayState> {
  const patch: Partial<DisplayState> = { [key]: value };
  if (value && key === 'backEdges') patch.xray = false;
  if (value && key === 'xray') patch.backEdges = false;
  return patch;
}

function setDisplay(ctx: CommandContext, key: DisplayKey, value: boolean | string): DisplayState {
  const display = displayOf(ctx);
  if (key === 'faceStyle') {
    if (typeof value !== 'string' || !(FACE_STYLES as readonly string[]).includes(value)) {
      throw new PushFormError('view.badValue', `faceStyle must be one of ${FACE_STYLES.join(', ')}`);
    }
    display.set({ faceStyle: value as DisplayState['faceStyle'] });
  } else {
    if (typeof value !== 'boolean') throw new PushFormError('view.badValue', `${key} must be a boolean`);
    display.set(exclusive(key, value));
  }
  mirrorToStyle(ctx, key, value);
  return display.get();
}

/**
 * The active style is the authoritative display source when a document is attached: every
 * `view.*` toggle also patches it (`displayToRender` in the UI adapter reads the style), so the
 * Display panel and the Styles › Edit tab never disagree. Not an undo entry (view state).
 */
function mirrorToStyle(ctx: CommandContext, key: DisplayKey, value: boolean | string): void {
  const host = ctx.services.get(SERVICE_DOCUMENT);
  if (!(host instanceof DocumentHost)) return;
  patchActiveStyle(host, 'Display', (style) => styleDisplayPatch(style, key, value));
}

function toggleCommand(key: Exclude<DisplayKey, 'faceStyle'>, title: string, keybinding?: string): AnyCommand {
  return defineCommand({
    id: `view.${key}`,
    title,
    category: 'view',
    icon: `view-${key}`,
    menu: key === 'backEdges' || key === 'profiles' || key === 'edges' ? 'View/Edge Style' : key === 'xray' ? 'View/Face Style' : 'View',
    keybinding,
    params: toggleParams,
    undoable: false,
    run: (ctx, { value }) => setDisplay(ctx, key, value ?? !displayOf(ctx).get()[key]),
  });
}

export const viewSet = defineCommand({
  id: 'view.set',
  title: 'Set Display Option',
  category: 'view',
  params: z.object({ key: z.enum(DISPLAY_KEYS), value: z.union([z.boolean(), z.enum(FACE_STYLES)]) }),
  undoable: false,
  run: (ctx, { key, value }) => setDisplay(ctx, key, value),
});

export const viewGet = defineCommand({
  id: 'view.get',
  title: 'Get Display Options',
  category: 'view',
  params: z.object({}),
  undoable: false,
  run: (ctx) => displayOf(ctx).get(),
});

export const viewFaceStyle = defineCommand({
  id: 'view.faceStyle',
  title: 'Face Style',
  category: 'view',
  menu: 'View/Face Style',
  params: z.object({ style: z.enum(FACE_STYLES) }),
  undoable: false,
  run: (ctx, { style }) => setDisplay(ctx, 'faceStyle', style),
});

export const viewCommands: readonly AnyCommand[] = [
  viewSet,
  viewGet,
  viewFaceStyle,
  toggleCommand('hiddenGeometry', 'Hidden Geometry'),
  toggleCommand('edges', 'Edges'),
  toggleCommand('profiles', 'Profiles'),
  toggleCommand('guides', 'Guides'),
  toggleCommand('axes', 'Axes'),
  toggleCommand('backEdges', 'Back Edges', 'K'),
  toggleCommand('xray', 'X-ray', 'I'),
];
