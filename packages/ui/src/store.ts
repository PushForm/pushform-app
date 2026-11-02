// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { create } from 'zustand';
import { readNavigationCubePreference } from './navCubePreference';
import { DEFAULT_DISPLAY } from '@pushform/commands';
import type { DisplayState, EntryField } from '@pushform/commands';
import type { EntityRef } from '@pushform/model';

export const PANEL_IDS = [
  'entityInfo',
  'materials',
  'components',
  'styles',
  'scenes',
  'shadows',
  'display',
  'modelInfo',
  'softenEdges',
  'instructor',
  'lastOperation',
  'fog',
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

/** Modal dialogs the shell can show (opened by `ui.*` commands, rendered by `DialogHost`). */
export type DialogId = 'makeComponent' | 'renameInstance' | 'editText' | 'text3d';

/** A pending right-click menu: viewport-relative CSS px and the refs it is for (empty = empty space). */
export interface ContextMenuRequest {
  readonly x: number;
  readonly y: number;
  readonly refs: readonly EntityRef[];
}

export interface CursorHint {
  readonly text: string;
  readonly screen: readonly [number, number] | null;
}

/** UI-only state. Model/document state never lives in React. */
export interface AppState {
  documentName: string;
  activeToolId: string | null;
  openPanel: PanelId | null;
  instructor: string;
  vcbLabel: string;
  vcbValue: string;
  /** Value fields the active tool draws in the viewport (`ToolStatus.fields`). */
  entryFields: readonly EntryField[];
  /** Text typed into value fields, by field id; a field without a draft shows its live value. */
  entryDrafts: Readonly<Record<string, string>>;
  /** Field being typed in, or null. `value` is the field typing opens beside the pointer. */
  entryFocus: string | null;
  /** Field whose text could not be read. */
  entryError: string | null;
  canUndo: boolean;
  canRedo: boolean;
  cursorHint: CursorHint | null;
  menuOpen: boolean;
  /** Bumped whenever the document selection (or the document) changes; React re-reads the model. */
  selectionVersion: number;
  /** Display toggles; written by `view.*` commands, read by the renderer. */
  display: DisplayState;
  /** Whether the viewport's navigation cube is shown (View › Navigation Cube); a per-browser preference. */
  navigationCube: boolean;
  /** Status-bar notice: a command error or a tool message (e.g. Select's delete message). */
  notice: string | null;
  /** Open modal dialog, if any; `dialogRef` is its subject (e.g. the instance being renamed). */
  dialog: DialogId | null;
  dialogRef: EntityRef | null;
  /** Open right-click menu, if any (rendered by `ContextMenuHost`). */
  contextMenu: ContextMenuRequest | null;
  /** Paint Bucket / Materials panel: the active material id (null = default) and the open tab. */
  activeMaterialId: number | null;
  materialsTab: MaterialsTab;

  setActiveTool(id: string | null): void;
  togglePanel(id: PanelId): void;
  closePanel(): void;
  setStatus(s: { instructor: string; vcbLabel: string; vcbValue?: string | undefined; fields?: readonly EntryField[] | undefined }): void;
  /** Start or continue typing in field `id` with `text`. */
  setEntryDraft(id: string, text: string): void;
  /** Drop a field's typed text. */
  clearEntryDraft(id: string): void;
  setEntryFocus(id: string | null): void;
  setEntryError(id: string | null): void;
  /** Drop every typed value and leave the fields. */
  clearEntry(): void;
  setUndoState(canUndo: boolean, canRedo: boolean): void;
  setCursorHint(hint: CursorHint | null): void;
  setMenuOpen(open: boolean): void;
  setDocumentName(name: string): void;
  bumpSelectionVersion(): void;
  setDisplay(patch: Partial<DisplayState>): void;
  setNavigationCube(visible: boolean): void;
  setNotice(notice: string | null): void;
  showPanel(id: PanelId): void;
  openDialog(id: DialogId, ref?: EntityRef | null): void;
  closeDialog(): void;
  openContextMenu(menu: ContextMenuRequest): void;
  closeContextMenu(): void;
  /** Scene thumbnails (PNG data URLs) by scene id; UI-only, never saved with the document. */
  sceneThumbnails: Record<number, string>;
  setSceneThumbnail(sceneId: number, dataUrl: string | null): void;
  setActiveMaterialId(id: number | null): void;
  setMaterialsTab(tab: MaterialsTab): void;
}

export type MaterialsTab = 'select' | 'edit';

export const useAppStore = create<AppState>()((set) => ({
  documentName: 'Untitled',
  activeToolId: null,
  openPanel: null,
  instructor: '',
  vcbLabel: '',
  vcbValue: '',
  entryFields: [],
  entryDrafts: {},
  entryFocus: null,
  entryError: null,
  canUndo: false,
  canRedo: false,
  cursorHint: null,
  menuOpen: false,
  selectionVersion: 0,
  display: DEFAULT_DISPLAY,
  navigationCube: readNavigationCubePreference(),
  notice: null,
  dialog: null,
  dialogRef: null,
  contextMenu: null,
  activeMaterialId: null,
  materialsTab: 'select',

  setActiveTool: (activeToolId) => set({ activeToolId }),
  togglePanel: (id) => set((s) => ({ openPanel: s.openPanel === id ? null : id })),
  closePanel: () => set({ openPanel: null }),
  setStatus: (st) => set({ instructor: st.instructor, vcbLabel: st.vcbLabel, vcbValue: st.vcbValue ?? '', entryFields: st.fields ?? [] }),
  setEntryDraft: (id, text) => set((s) => ({ entryDrafts: { ...s.entryDrafts, [id]: text }, entryFocus: id, entryError: s.entryError === id ? null : s.entryError })),
  clearEntryDraft: (id) =>
    set((s) => {
      if (!(id in s.entryDrafts)) return {};
      const { [id]: _dropped, ...rest } = s.entryDrafts;
      return { entryDrafts: rest, entryError: s.entryError === id ? null : s.entryError };
    }),
  setEntryFocus: (entryFocus) => set({ entryFocus }),
  setEntryError: (entryError) => set({ entryError }),
  clearEntry: () => set({ entryDrafts: {}, entryFocus: null, entryError: null }),
  setUndoState: (canUndo, canRedo) => set({ canUndo, canRedo }),
  setCursorHint: (cursorHint) => set({ cursorHint }),
  setMenuOpen: (menuOpen) => set({ menuOpen }),
  setDocumentName: (documentName) => set({ documentName }),
  bumpSelectionVersion: () => set((s) => ({ selectionVersion: s.selectionVersion + 1 })),
  setDisplay: (patch) => set((s) => ({ display: { ...s.display, ...patch } })),
  setNavigationCube: (navigationCube) => set({ navigationCube }),
  setNotice: (notice) => set({ notice }),
  showPanel: (openPanel) => set({ openPanel }),
  openDialog: (dialog, ref = null) => set({ dialog, dialogRef: ref, contextMenu: null }),
  closeDialog: () => set({ dialog: null, dialogRef: null }),
  openContextMenu: (contextMenu) => set({ contextMenu }),
  closeContextMenu: () => set({ contextMenu: null }),
  sceneThumbnails: {},
  setSceneThumbnail: (sceneId, dataUrl) =>
    set((s) => {
      const next = { ...s.sceneThumbnails };
      if (dataUrl === null) delete next[sceneId];
      else next[sceneId] = dataUrl;
      return { sceneThumbnails: next };
    }),
  setActiveMaterialId: (activeMaterialId) => set({ activeMaterialId }),
  setMaterialsTab: (materialsTab) => set({ materialsTab }),
}));
