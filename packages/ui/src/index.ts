// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// @pushform/ui: React shell, menus, toolbars, trays, panels
export const PACKAGE = '@pushform/ui';

export { App, default } from './App';
export { ToastHost } from './components/ToastHost';
export { createToastStore, showToast, toasts } from './toasts';
export type { Toast, ToastStore } from './toasts';
export type { AppProps, RequestsConfig } from './App';
export type { BuildInfo } from './buildInfo';
export { syncDesktopTitleBar, desktopTitleBarColor, desktopPlatform, markDesktopShell } from './desktopShell';
export { createApp, loadDemo } from './bootstrap';
export type { AppInstance, CreateAppOptions } from './bootstrap';
export { useAppStore } from './store';
export type { AppState, PanelId, CursorHint } from './store';
export { AppContext, useApp } from './AppContext';
export { installUiServices, storeDisplayHost } from './engine/uiServices';
export { useCommandNotices } from './hooks/useCommandNotices';
export { describeSchema } from './panels/zodForm';
export type { FieldSpec } from './panels/zodForm';
export { TOOL_HELP } from './panels/instructorHelp';
export type { ToolHelp } from './panels/instructorHelp';
export { ModelObjectBrowser } from './components/ModelObjectBrowser';
export { modelBrowserTree } from './components/modelBrowserTree';
export type { ModelBrowserNode, ModelBrowserKind } from './components/modelBrowserTree';
export { describeSelection, describeRef, describeInstance } from './panels/entityInfo';
export type { EntityInfo, InstanceInfo } from './panels/entityInfo';
export { ContextMenu, ContextMenuHost, useContextMenu } from './components/ContextMenu';
export type { ContextMenuProps } from './components/ContextMenu';
export { DialogHost, MakeComponentDialog, RenameInstanceDialog } from './components/MakeComponentDialog';
export type { MakeComponentParams } from './components/MakeComponentDialog';
export { uiCommands, installUiCommands } from './engine/uiCommands';
export { useEditContext } from './hooks/useEditContext';
export { useSelectionRefs } from './hooks/useSelection';
export type { DialogId, ContextMenuRequest } from './store';
export { SceneTabs } from './components/SceneTabs';
export { TagsPanel } from './panels/TagsPanel';
export { ScenesPanel, THUMB_W, THUMB_H } from './panels/ScenesPanel';
export { StylesPanel } from './panels/StylesPanel';
export { ShadowsPanel, formatTime, parseTime, formatDate, parseDate } from './panels/ShadowsPanel';
export { FogPanel } from './panels/FogPanel';
export { useDocumentState, useSceneRuntime } from './hooks/useDocument';
export { applyDocumentView, syncDisplayStoreFromStyle } from './engine/viewSync';
export { shadowsToRender, fogToRender, taggedBodyEdges, colorByTagOn, tagColor, tagStyleToken } from './engine/renderAdapter';
export { MaterialsPanel, cssToRgb01, rgbToHls, hlsToRgb } from './panels/MaterialsPanel';
export { storeActiveMaterialHost } from './engine/uiServices';
export { setRenderImageStore, uvOverrideKey, renderMaterial, faceMaterialsToRender } from './engine/renderAdapter';
export type { RenderAdapterOptions } from './engine/renderAdapter';
export type { MaterialsTab } from './store';
// Offscreen rendering for tools/sample-check, which renders models and pages as the app does.
export { bodiesToRender, dimensionsToRender, displayToRender, imagesToRender, sketchesToRender, textsToRender, withRenderImageStore } from './engine/renderAdapter';
export { sectionsToRender } from './engine/sectionAdapter';
export { paintPrintPage } from './components/LayoutWorkspace';
export { prepareLayoutFonts } from './components/layoutFonts';
export { prepareLayoutImages } from './components/layoutImage';
export { layoutViewportPicture, settleLayoutViewportRenders } from './components/layoutViewportRenders';
export type { ExtensionRuntimeSources } from './extensions/browserExtensionPlatform';
