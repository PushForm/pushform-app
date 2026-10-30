// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import type { AnyCommand, CommandContext } from '../registry/Command';
import { defineCommand } from '../registry/Command';

/** Service key under which a mounted Layout workspace publishes itself (see `LayoutWorkspaceHost`). */
export const SERVICE_LAYOUT_WORKSPACE = 'layoutWorkspace';

/** What the Layout workspace offers to one-shot commands beyond tool activation. */
export interface LayoutWorkspaceHost {
  /** Open the current page in Presentation mode. */
  present(): void;
  /** Open print setup for this document. */
  print(): void;
  /** Open export setup for this document. */
  exportImage(): void;
  /** Choose an image file and embed it on the active page. */
  importImage(): void;
  zoomToPage(): void;
  fitContent(): void;
  addLayer(): void;
  /** Open the Document Settings dialog. */
  documentSettings(): void;

}

const workspaceOf = (ctx: CommandContext): LayoutWorkspaceHost | undefined =>
  ctx.services.get(SERVICE_LAYOUT_WORKSPACE) as LayoutWorkspaceHost | undefined;

/** Drawing and editing tools of a Layout document, in toolbar order. */
export const LAYOUT_TOOL_IDS = [
  'select',
  'lasso',
  'eraser',
  'line',
  'bezier',
  'freehand',
  'arc',
  'arc2',
  'arc3',
  'pie',
  'rectangle',
  'rounded-rectangle',
  'bulged-rectangle',
  'lozenge',
  'circle',
  'ellipse',
  'polygon',
  'circumscribed-polygon',
  'offset',
  'fillet',
  'chamfer',
  'move',
  'rotate',
  'scale',
  'shape-builder',
  'boolean-union',
  'boolean-subtract',
  'boolean-intersect',
  'boolean-exclude',
  'boolean-division',
  'boolean-cut-path',
  'text',
  'dimension',
  'angular-dimension',
  'label',
  'table',
  'viewport',
] as const;

export type LayoutToolId = (typeof LAYOUT_TOOL_IDS)[number];

export interface LayoutToolInfo {
  readonly id: LayoutToolId;
  readonly title: string;
  /** Display label of the shortcut the Layout workspace handles for this tool. */
  readonly keybinding?: string;
}

/** Titles and shortcut labels shown by menus and command search. */
export const LAYOUT_TOOLS: readonly LayoutToolInfo[] = [
  { id: 'select', title: 'Select', keybinding: 'Space' },
  { id: 'lasso', title: 'Lasso', keybinding: 'Shift+Space' },
  { id: 'eraser', title: 'Eraser', keybinding: 'E' },
  { id: 'line', title: 'Line', keybinding: 'L' },
  { id: 'bezier', title: 'Bézier Curve' },
  { id: 'freehand', title: 'Freehand' },
  { id: 'arc', title: 'Arc' },
  { id: 'arc2', title: '2 Point Arc', keybinding: 'A' },
  { id: 'arc3', title: '3 Point Arc' },
  { id: 'pie', title: 'Pie' },
  { id: 'rectangle', title: 'Rectangle', keybinding: 'R' },
  { id: 'rounded-rectangle', title: 'Rounded Rectangle' },
  { id: 'bulged-rectangle', title: 'Bulged Rectangle' },
  { id: 'lozenge', title: 'Lozenge' },
  { id: 'circle', title: 'Circle', keybinding: 'C' },
  { id: 'ellipse', title: 'Ellipse' },
  { id: 'polygon', title: 'Polygon' },
  { id: 'circumscribed-polygon', title: 'Circumscribed Polygon' },
  { id: 'offset', title: 'Offset' },
  { id: 'fillet', title: 'Fillet', keybinding: 'Shift+F' },
  { id: 'chamfer', title: 'Chamfer', keybinding: 'Shift+C' },
  { id: 'move', title: 'Move', keybinding: 'M' },
  { id: 'rotate', title: 'Rotate', keybinding: 'Q' },
  { id: 'scale', title: 'Scale' },
  { id: 'shape-builder', title: 'Shape Builder', keybinding: 'X' },
  { id: 'boolean-union', title: 'Union' },
  { id: 'boolean-subtract', title: 'Difference' },
  { id: 'boolean-intersect', title: 'Intersection' },
  { id: 'boolean-exclude', title: 'Exclusion' },
  { id: 'boolean-division', title: 'Division' },
  { id: 'boolean-cut-path', title: 'Cut Path' },
  { id: 'text', title: 'Text', keybinding: 'T' },
  { id: 'dimension', title: 'Linear Dimension', keybinding: 'D' },
  { id: 'angular-dimension', title: 'Angular Dimension', keybinding: 'Shift+D' },
  { id: 'label', title: 'Label' },
  { id: 'table', title: 'Table' },
  { id: 'viewport', title: 'Model View' },
];

/** Command id that activates a Layout tool: `tool.<id>`, the same scheme as modeling tools. */
export const layoutToolCommandId = (id: LayoutToolId): string => `tool.${id}`;

/**
 * One `tool.*` command per Layout tool. The Layout workspace installs itself as `ctx.tools`
 * while it is mounted; until then the commands are registered but disabled, so command search
 * can list them without being able to run them into nothing.
 */
export const layoutToolCommands: AnyCommand[] = LAYOUT_TOOLS.map((tool) =>
  defineCommand({
    id: layoutToolCommandId(tool.id),
    title: tool.title,
    category: 'tool',
    icon: `tool-${tool.id}`,
    menu: 'Tools',
    keybinding: tool.keybinding,
    params: z.object({}),
    undoable: false,
    when: (ctx) => ctx.tools !== undefined,
    run: (ctx) => {
      ctx.tools?.activate(tool.id);
    },
  }),
);

/** Opens Presentation mode on the mounted Layout workspace. */
export const layoutPresentCommand = defineCommand({
  id: 'layout.present',
  title: 'Presentation Mode',
  category: 'view',
  icon: 'presentation',
  menu: 'View',
  params: z.object({}),
  undoable: false,
  when: (ctx) => workspaceOf(ctx) !== undefined,
  run: (ctx) => {
    workspaceOf(ctx)?.present();
  },
});

/** Opens the Document Settings dialog on the mounted Layout workspace. */
export const layoutDocumentSettingsCommand = defineCommand({
  id: 'layout.document.settings', title: 'Document Settings', category: 'file', icon: 'document-layout', menu: 'File',
  params: z.object({}), undoable: false,
  when: (ctx) => workspaceOf(ctx) !== undefined,
  run: (ctx) => { workspaceOf(ctx)?.documentSettings(); },
});

export const layoutPrintCommand = defineCommand({
  id: 'layout.print', title: 'Print Layout', category: 'file', icon: 'print', menu: 'File',
  keybinding: 'Ctrl/Cmd+P', params: z.object({}), undoable: false,
  when: (ctx) => workspaceOf(ctx) !== undefined,
  run: (ctx) => { workspaceOf(ctx)?.print(); },
});

export const layoutExportImageCommand = defineCommand({
  id: 'layout.export.image', title: 'Export', category: 'file', icon: 'image', menu: 'File',
  params: z.object({}), undoable: false,
  when: (ctx) => workspaceOf(ctx) !== undefined,
  run: (ctx) => { workspaceOf(ctx)?.exportImage(); },
});

export const layoutImportCommand = defineCommand({
  id: 'layout.import', title: 'Import', category: 'file', icon: 'image', menu: 'File',
  params: z.object({}), undoable: false,
  when: (ctx) => workspaceOf(ctx) !== undefined,
  run: (ctx) => { workspaceOf(ctx)?.importImage(); },
});

export const layoutZoomToPageCommand = defineCommand({
  id: 'layout.zoom.page', title: 'Zoom to Page', category: 'view', icon: 'zoom-extents', menu: 'View',
  params: z.object({}), undoable: false,
  when: (ctx) => workspaceOf(ctx) !== undefined,
  run: (ctx) => { workspaceOf(ctx)?.zoomToPage(); },
});

export const layoutFitContentCommand = defineCommand({
  id: 'layout.zoom.content', title: 'Fit Content', category: 'view', icon: 'zoom-extents', menu: 'View',
  params: z.object({}), undoable: false,
  when: (ctx) => workspaceOf(ctx) !== undefined,
  run: (ctx) => { workspaceOf(ctx)?.fitContent(); },
});

/** Open the existing layer form without requiring parameters in command search. */
export const layoutAddLayerCommand = defineCommand({
  id: 'layout.layer.new', title: 'Add Layer', category: 'layout', icon: 'plus', menu: 'Layers',
  params: z.object({}), undoable: false,
  when: (ctx) => workspaceOf(ctx) !== undefined,
  run: (ctx) => { workspaceOf(ctx)?.addLayer(); },
});

/** Tools and one-shot actions offered by a mounted Layout workspace. */
export const layoutWorkspaceCommands: AnyCommand[] = [
  ...layoutToolCommands, layoutPresentCommand, layoutPrintCommand, layoutExportImageCommand, layoutDocumentSettingsCommand, layoutImportCommand, layoutZoomToPageCommand, layoutFitContentCommand, layoutAddLayerCommand,
];
