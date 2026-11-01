// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { installDesktopStepReader } from './desktopStepReader';
import { meshBox } from '@pushform/core';
import {
  CommandRegistry,
  Keymap,
  OrbitTool,
  PanTool,
  PasteTool,
  PlaceComponentTool,
  ComponentAxesTool,
  ScriptRunner,
  ToolManager,
  ZoomTool,
  ZoomWindowTool,
  cameraCommands,
  clipboardCommands,
  sectionPlaneCommands,
  imageCommands,
  text3dCommands,
  SERVICE_FONTS,
  detectPlatform,
  editCommands,
  placeholderTool,
} from '@pushform/commands';
import type { DisplayState, Platform, Tool } from '@pushform/commands';
import type { Mat4, MeshData } from '@pushform/core';
import { InlineBackend, KernelClient, WorkerBackend } from '@pushform/kernel';
import { bodyFromMesh } from '@pushform/model';
import { Viewport, renderKey } from '@pushform/render';
import type { RenderBody, RenderDisplay } from '@pushform/render';
import { useAppStore } from './store';
import {
  DocumentHost,
  SERVICE_DOCUMENT,
  SERVICE_INFERENCE,
  SERVICE_KERNEL,
  modelCommands,
  pushPullCommands,
  pushPullTools,
  sketchCommands,
  sketchTools,
  curveCommands,
  drawingTools,
  transformCommands,
  transformTools,
  viewCommands,
  lastOpCommands,
  edgeCommands,
  guideCommands,
  dimensionCommands,
  textCommands,
  axesCommands,
  offsetCommands,
  followMeCommands,
  edgeBlendCommands,
  solidCommands,
  intersectCommands,
  contextCommands,
  groupCommands,
  componentBehaviorCommands,
  constructionTools,
  materialCommands,
  paintTools,
  tagCommands,
  sceneCommands,
  styleCommands,
  shadowCommands,
  fogCommands,
  modelInfoCommands,
  componentCommands,
  tagTools,
} from '@pushform/commands';
import { applyDocumentView, syncDisplayStoreFromStyle } from './engine/viewSync';
import type { EntityRef } from '@pushform/model';
import { createInferenceEngine } from '@pushform/inference';
import type { InferenceEngine } from '@pushform/inference';
import { axesToRender, backgroundToRender, bodiesToRender, dimensionsToRender, editContextToRender, guidesToRender, highlightsFor, imagesToRender, sketchesToRender, textsToRender } from './engine/renderAdapter';
import { setRenderImageStore, uvOverrideKey } from './engine/renderAdapter';
import type { UvMapping } from '@pushform/model';
import { installUiCommands } from './engine/uiCommands';
import { sectionsToRender } from './engine/sectionAdapter';
import { installUiServices, storeDisplayHost } from './engine/uiServices';
import { bundledFonts } from './engine/text3dFonts';

export interface AppInstance {
  readonly commands: CommandRegistry;
  readonly toolManager: ToolManager;
  readonly viewport: Viewport;
  readonly keymap: Keymap;
  readonly tx: DocumentHost;
  readonly document: DocumentHost;
  readonly kernel: KernelClient;
  readonly inference: InferenceEngine;
  readonly scripts: ScriptRunner;
  readonly store: typeof useAppStore;
  /** Bodies currently handed to the renderer (derived from the document). */
  readonly bodies: readonly RenderBody[];
  dispose(): void;
}

export interface CreateAppOptions {
  /** Load the two demo boxes (default true). */
  readonly demo?: boolean;
  readonly platform?: Platform;
  /** Expose `window.pushform` (default true). */
  readonly expose?: boolean;
  /** Kernel client override (tests). Default: Web Worker in browsers, inline elsewhere. */
  readonly kernel?: KernelClient;
}

/** Longest slice of inference index building in idle time; a frame keeps the rest. */
const INDEX_SLICE_MS = 30;

/** Placeholder tools so the toolbar/keymap are complete before the real tools land. */
const PLACEHOLDER_TOOLS: [id: string, title: string, vcbLabel: string][] = [
  ['eraser', 'Eraser', ''],
  ['paint', 'Paint Bucket', ''],
  ['line', 'Line', 'Length'],
  ['rectangle', 'Rectangle', 'Dimensions'],
  ['circle', 'Circle', 'Radius'],
  ['arc2', '2 Point Arc', 'Bulge'],
  ['move', 'Move', 'Distance'],
  ['pushpull', 'Push/Pull', 'Distance'],
  ['rotate', 'Rotate', 'Angle'],
  ['scale', 'Scale', 'Scale'],
  ['offset', 'Offset', 'Distance'],
  ['tape', 'Tape Measure', 'Length'],
];

export function createApp(opts: CreateAppOptions = {}): AppInstance {
  const store = useAppStore;
  const tx = new DocumentHost();
  const kernel =
    opts.kernel ?? new KernelClient(typeof Worker !== 'undefined' ? new WorkerBackend() : new InlineBackend());
  const viewport = new Viewport();
  const inference = createInferenceEngine();
  inference.setState(tx.doc.state);
  const services = new Map<string, unknown>([
    [SERVICE_DOCUMENT, tx],
    [SERVICE_KERNEL, kernel],
    [SERVICE_INFERENCE, inference],
    [SERVICE_FONTS, bundledFonts],
  ]);
  const commands = new CommandRegistry({ tx, camera: viewport.camera, services });
  commands.registerAll(editCommands);
  commands.registerAll(cameraCommands);
  commands.registerAll(modelCommands);
  commands.registerAll(sketchCommands);
  commands.registerAll(clipboardCommands);
  commands.registerAll(sectionPlaneCommands);
  commands.registerAll(imageCommands);
  commands.registerAll(text3dCommands);
  commands.registerAll(pushPullCommands);
  commands.registerAll(curveCommands);
  commands.registerAll(transformCommands);
  commands.registerAll(viewCommands);
  commands.registerAll(lastOpCommands);
  commands.registerAll(edgeCommands);
  commands.registerAll(guideCommands);
  commands.registerAll(dimensionCommands);
  commands.registerAll(textCommands);
  commands.registerAll(axesCommands);
  commands.registerAll(offsetCommands);
  commands.registerAll(followMeCommands);
  commands.registerAll(edgeBlendCommands);
  commands.registerAll(solidCommands);
  commands.registerAll(intersectCommands);
  commands.registerAll(contextCommands);
  commands.registerAll(groupCommands);
  commands.registerAll(componentBehaviorCommands);
  commands.registerAll(tagCommands);
  commands.registerAll(sceneCommands);
  commands.registerAll(styleCommands);
  commands.registerAll(shadowCommands);
  commands.registerAll(fogCommands);
  commands.registerAll(materialCommands);
  commands.registerAll(modelInfoCommands);
  commands.registerAll(componentCommands);
  installUiServices(commands);
  installUiCommands(commands);
  installDesktopStepReader();
  const toolManager = new ToolManager(commands, viewport.camera);
  commands.ctx.tools = toolManager;
  const isWeb = typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window);
  const keymap = new Keymap(opts.platform ?? detectPlatform(), undefined, isWeb);
  const scripts = new ScriptRunner(commands);

  for (const t of sketchTools()) toolManager.register(t);
  for (const t of pushPullTools()) toolManager.register(t);
  for (const t of drawingTools()) toolManager.register(t);
  for (const t of transformTools()) toolManager.register(t);
  for (const t of constructionTools()) toolManager.register(t);
  for (const t of tagTools()) toolManager.register(t);
  for (const t of paintTools()) toolManager.register(t);
  for (const [id, title, vcb] of PLACEHOLDER_TOOLS) {
    if (!toolManager.get(id)) toolManager.register(placeholderTool(id, title, vcb));
  }
  toolManager.register(new OrbitTool(), { menu: 'Camera' });
  toolManager.register(new PanTool(), { menu: 'Camera' });
  toolManager.register(new ZoomTool(), { menu: 'Camera' });
  toolManager.register(new ZoomWindowTool(), { menu: 'Camera' });
  toolManager.register(new PasteTool(), { command: false });
  toolManager.register(new PlaceComponentTool(), { command: false });
  toolManager.register(new ComponentAxesTool(), { command: false });

  // --- wiring: engine events → UI store / viewport ---------------------------------------------
  const offs: (() => void)[] = [];
  offs.push(
    toolManager.events.on('toolChanged', ({ id }) => {
      store.getState().setActiveTool(id);
      store.getState().clearEntry();
      // Picking up the Paint Bucket opens the Materials panel.
      if (id === 'paint') store.getState().showPanel('materials');
    }),
  );
  offs.push(toolManager.events.on('statusChanged', (s) => store.getState().setStatus(s)));
  offs.push(toolManager.events.on('overlayChanged', () => viewport.setOverlay(toolManager.overlay())));
  offs.push(toolManager.events.on('renderRequested', () => viewport.requestRender()));
  const syncUndo = () => store.getState().setUndoState(tx.canUndo(), tx.canRedo());
  offs.push(tx.onChange(syncUndo));
  let bodies: readonly RenderBody[] = [];
  let hoverRef: EntityRef | null = null;
  const syncHighlights = () => {
    viewport.setHighlight(highlightsFor(tx.doc.state, hoverRef, tx.selection.refs));
    viewport.setDimensions(dimensionsToRender(tx.doc.state, tx.selection.refs));
    viewport.setTexts(textsToRender(tx.doc.state, tx.selection.refs));
    viewport.setSections(sectionsToRender(tx.doc.state, tx.selection.refs));
  };
  setRenderImageStore(tx.images);
  // The inference index catches up with the document in short slices between frames, so that opening a large model
  // never builds it in one long task on the first hover (PF-189).
  let indexSlice: ReturnType<typeof setTimeout> | null = null;
  const buildIndexInBackground = () => {
    if (indexSlice !== null || !inference.index.building) return;
    const step = () => {
      indexSlice = null;
      if (!inference.index.ensureFor(INDEX_SLICE_MS)) indexSlice = setTimeout(step, 0);
    };
    indexSlice = setTimeout(step, 0);
  };
  offs.push(() => { if (indexSlice !== null) clearTimeout(indexSlice); });
  const syncBodies = () => {
    const state = tx.doc.state;
    inference.setState(state);
    buildIndexInBackground();
    bodies = bodiesToRender(state);
    viewport.setBodies(bodies);
    viewport.setSketches(sketchesToRender(state));
    viewport.setGuides(guidesToRender(state));
    viewport.setImages(imagesToRender(state));
    viewport.setAxes(axesToRender(state));
    viewport.setSky(backgroundToRender(state));
    applyDocumentView(viewport, state);
    syncDisplayStoreFromStyle(state);
    viewport.setEditContext(editContextToRender(state, tx.context.path));
    syncHighlights();
  };
  offs.push(
    tx.events.on('contextChanged', ({ context }) => {
      inference.setContext(context.path);
      viewport.setEditContext(editContextToRender(tx.doc.state, context.path));
      syncHighlights();
    }),
  );
  // Display toggles (Display panel / view.* commands) live in the UI store; mirror them to the viewport.
  const toRenderDisplay = (d: DisplayState): RenderDisplay => ({
    ...d,
    faceStyle: d.faceStyle === 'shadedTextures' ? 'shadedTextured' : d.faceStyle,
  });
  viewport.setDisplay(toRenderDisplay(storeDisplayHost.get()));
  offs.push(storeDisplayHost.onChange((d) => viewport.setDisplay(toRenderDisplay(d))));
  offs.push(tx.doc.events.on('change', syncBodies));
  offs.push(tx.selection.events.on('change', syncHighlights));
  // Tool-driven visuals: hover highlight (Select/Eraser) and push/pull real preview.
  const syncToolVisuals = () => {
    const tool = toolManager.activeTool as
      | (Tool & { hoverRef?: EntityRef | null; previewMeshes?: readonly MeshData[]; previewReplacesBodyId?: number | null; previewMatrix?: Mat4 })
      | null;
    const nextHover = tool?.hoverRef ?? null;
    if (nextHover !== hoverRef) {
      hoverRef = nextHover;
      syncHighlights();
    }
    const preview = tool?.previewMeshes ?? [];
    const replaced = preview.length ? (tool?.previewReplacesBodyId ?? null) : null;
    viewport.setPreview(preview.length ? preview : null, tool?.previewMatrix);
    const replacedKey = replaced === null ? null : renderKey(tx.context.path, replaced);
    viewport.setBodies(replacedKey === null ? bodies : bodies.filter((b) => b.id !== replacedKey));
    // Position Texture: live UV mapping while a pin is dragged (materials agent).
    const live = (tool as (Tool & { liveUv?: { ref: EntityRef; uv: UvMapping } | null }) | null)?.liveUv ?? null;
    const liveKey = live ? uvOverrideKey(live.ref) : null;
    if (live && liveKey) {
      const overrides = new Map<string, UvMapping>([[liveKey, live.uv]]);
      viewport.setBodies(bodiesToRender(tx.doc.state, { uvOverrides: overrides }));
      viewport.setSketches(sketchesToRender(tx.doc.state, { uvOverrides: overrides }));
      liveUvActive = true;
    } else if (liveUvActive) {
      liveUvActive = false;
      viewport.setBodies(bodies);
      viewport.setSketches(sketchesToRender(tx.doc.state));
    }
  };
  let liveUvActive = false;
  offs.push(toolManager.events.on('overlayChanged', syncToolVisuals));
  offs.push(toolManager.events.on('toolChanged', syncToolVisuals));
  offs.push(viewport.events.on('cursorHint', (h) => store.getState().setCursorHint(h)));
  offs.push(viewport.events.on('render', () => {
    // Zoom tool shows the live FOV; refresh status after camera-driven renders.
    const s = toolManager.status();
    const cur = store.getState();
    if (s.vcbValue !== cur.vcbValue || s.instructor !== cur.instructor) cur.setStatus(s);
  }));

  const app: AppInstance = {
    commands,
    toolManager,
    viewport,
    keymap,
    tx,
    document: tx,
    kernel,
    inference,
    scripts,
    store,
    get bodies() {
      return bodies;
    },
    dispose() {
      for (const off of offs) off();
      kernel.dispose();
      viewport.dispose();
      if (opts.expose !== false && typeof window !== 'undefined') delete (window as { pushform?: unknown }).pushform;
    },
  };

  if (opts.demo ?? true) loadDemo(tx);
  syncBodies();
  toolManager.activate('select');
  syncUndo();

  if (opts.expose !== false && typeof window !== 'undefined') {
    (window as unknown as { pushform: unknown }).pushform = {
      commands,
      toolManager,
      viewport,
      keymap,
      scripts,
      store,
      app,
      document: tx,
      kernel,
      inference,
    };
  }
  return app;
}

/** Two boxes so the M0 viewport shows faces, edges and back faces. Not recorded on the undo stack. */
export function loadDemo(host: DocumentHost): void {
  host.doc.transact('Demo', (draft) => {
    const root = draft.definitions.get(draft.rootDefinitionId);
    if (!root) return;
    bodyFromMesh(draft, meshBox([0, 0, 0], [1, 1, 1]), { container: root.entities });
    bodyFromMesh(draft, meshBox([1.6, -0.4, 0], [3.2, 1.4, 0.5]), { container: root.entities });
  });
}
