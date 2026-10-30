// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import { PushFormError } from '@pushform/core';
import { defineCommand } from '../registry/Command';
import type { AnyCommand, CommandContext } from '../registry/Command';
import type { StandardView } from './CameraHost';
import { DocumentHost } from '../host/DocumentHost';
import { hostOf, SERVICE_DOCUMENT } from '../host/services';
import { refsBounds } from '../commands/transform';

const NoParams = z.object({});

function camera(ctx: CommandContext) {
  if (!ctx.camera) throw new PushFormError('camera.unavailable', 'No camera host is attached');
  return ctx.camera;
}

const VIEWS: { view: StandardView; title: string }[] = [
  { view: 'iso', title: 'Iso' },
  { view: 'top', title: 'Top' },
  { view: 'bottom', title: 'Bottom' },
  { view: 'front', title: 'Front' },
  { view: 'back', title: 'Back' },
  { view: 'left', title: 'Left' },
  { view: 'right', title: 'Right' },
];

const viewCommands: AnyCommand[] = VIEWS.map(({ view, title }) =>
  defineCommand({
    id: `camera.view.${view}`,
    title,
    category: 'camera',
    icon: `view-${view}`,
    menu: 'Camera/Standard Views',
    params: NoParams,
    undoable: false,
    when: (ctx) => !!ctx.camera,
    run: (ctx) => camera(ctx).standardView(view),
  }),
);

export const cameraCommands: readonly AnyCommand[] = [
  ...viewCommands,
  defineCommand({
    id: 'camera.zoomExtents',
    title: 'Zoom Extents',
    category: 'camera',
    icon: 'zoom-extents',
    menu: 'Camera',
    keybinding: 'Shift+Z',
    params: NoParams,
    undoable: false,
    when: (ctx) => !!ctx.camera,
    run: (ctx) => camera(ctx).zoomExtents(),
  }),
  defineCommand({
    id: 'camera.zoomSelection',
    title: 'Zoom Selection',
    category: 'camera',
    menu: 'Camera',
    params: NoParams,
    undoable: false,
    // Frames the selection's bounds; available with a selection.
    when: (ctx) => !!ctx.camera?.zoomBox && ctx.services.get(SERVICE_DOCUMENT) instanceof DocumentHost && hostOf(ctx).selection.size > 0,
    run: (ctx): boolean => {
      const host = hostOf(ctx);
      const box = refsBounds(host.doc.state, host.selection.refs);
      if (!box) return false;
      camera(ctx).zoomBox?.(box);
      return true;
    },
  }),
  defineCommand({
    id: 'camera.projection.perspective',
    title: 'Perspective',
    category: 'camera',
    menu: 'Camera',
    params: NoParams,
    undoable: false,
    when: (ctx) => !!ctx.camera,
    run: (ctx) => camera(ctx).setProjection('perspective'),
  }),
  defineCommand({
    id: 'camera.projection.parallel',
    title: 'Parallel Projection',
    category: 'camera',
    menu: 'Camera',
    params: NoParams,
    undoable: false,
    when: (ctx) => !!ctx.camera,
    run: (ctx) => camera(ctx).setProjection('parallel'),
  }),
  defineCommand({
    id: 'camera.previous',
    title: 'Previous',
    category: 'camera',
    icon: 'view-previous',
    menu: 'Camera',
    params: NoParams,
    undoable: false,
    when: (ctx) => !!ctx.camera,
    run: (ctx) => camera(ctx).previousView(),
  }),
  defineCommand({
    id: 'camera.next',
    title: 'Next',
    category: 'camera',
    icon: 'view-next',
    menu: 'Camera',
    params: NoParams,
    undoable: false,
    when: (ctx) => !!ctx.camera,
    run: (ctx) => camera(ctx).nextView(),
  }),
  defineCommand({
    id: 'camera.setFov',
    title: 'Field of View',
    category: 'camera',
    menu: 'Camera',
    params: z.object({ deg: z.number().min(1).max(120) }),
    undoable: false,
    when: (ctx) => !!ctx.camera,
    run: (ctx, p) => camera(ctx).setFov(p.deg),
  }),
  defineCommand({
    id: 'camera.setState',
    title: 'Set Camera',
    category: 'internal',
    params: z.object({
      eye: z.tuple([z.number(), z.number(), z.number()]),
      target: z.tuple([z.number(), z.number(), z.number()]),
      up: z.tuple([z.number(), z.number(), z.number()]).optional(),
      fov: z.number().optional(),
      projection: z.enum(['perspective', 'parallel']).optional(),
      orthoHeight: z.number().optional(),
    }),
    undoable: false,
    when: (ctx) => !!ctx.camera,
    run: (ctx, p) => {
      const cam = camera(ctx);
      const cur = cam.getState();
      cam.setState({
        eye: p.eye,
        target: p.target,
        up: p.up ?? cur.up,
        fov: p.fov ?? cur.fov,
        projection: p.projection ?? cur.projection,
        orthoHeight: p.orthoHeight ?? cur.orthoHeight,
      });
    },
  }),
];
