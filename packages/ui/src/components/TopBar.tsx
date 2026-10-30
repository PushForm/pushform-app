// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { registerGuidanceTargets } from '../guidance';
import { useLayoutEffect, useEffect, useRef, useState, type ChangeEvent, type JSX } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { DEFAULT_UNITS, newGuid, type DefId } from '@pushform/core';
import { defineCommand } from '@pushform/commands';
import { z } from 'zod';
import {
  encodeLayoutSnapshot, encodeModelSnapshot, modelArchiveImages, openModelFile, openLayoutFile,
  isSketchUpLayoutFile, nativeDocumentType, type LayoutRecoveryMetadata,
  isModelImportFile, isPictureFile, MAX_PICTURE_BYTES, pictureMime, MAX_SKETCHUP_BYTES, exportStl, stlFileName, STL_EXTENSION, probeMeshImport, exportGlb, exportObj, exportCollada,
  type ImportProgress, type MeshExtent, type MeshFormatKind, type MeshImportOptions, type ModelImportReport,
} from '@pushform/io';
import { importLayoutBytes, importSketchUpBytes, tooLarge, type PickedFile } from '../importFiles';
import { useAppStore } from '../store';
import { layoutContentKey, modelContentKey } from '../documentContent';
import type { DocumentSession, DocumentTab } from '../session';
import { CommandSearch } from './CommandSearch';
import { commandSearchSourceFor } from './commandSearchSource';
import { DocumentTabs } from './DocumentTabs';
import { LayoutTemplateChooser } from './LayoutTemplateChooser';
import { LayoutImportDialog } from './LayoutImportDialog';
import { ModelImportDialog } from './ModelImportDialog';
import { ModelExportDialog, type ModelExportChoice, type ModelExportFormat, type ModelExportDialogFormat, type StlExportChoice } from './ModelExportDialog';
import { MeshImportDialog } from './MeshImportDialog';
import { rememberedMeshOptions, rememberMeshOptions } from '../meshImportOptions';
import { Icon } from './Icon';
import { defaultBrowserFileHandleStore, type BrowserDocumentHandle } from '../browserFileHandles';
import type { CloudSession, CloudFilesApi } from '@pushform/cloud';
import { AccountControl } from './AccountControl';
import { CloudBrowser } from './CloudBrowser';
import { AboutDialog } from './AboutDialog';
import { UNKNOWN_BUILD, type BuildInfo } from '../buildInfo';
import { cloudLocation, saveCloudDocument } from '../cloudDocuments';
import type { CloudAutosave } from '../cloudAutosave';
import { AutosaveIndicator } from './AutosaveIndicator';
import { allowOpeningDocument, desktopUpdates } from '../desktopUpdates';

interface FilePickerWindow {
  showOpenFilePicker?: (options: object) => Promise<BrowserDocumentHandle[]>;
  showSaveFilePicker?: (options: object) => Promise<BrowserDocumentHandle>;
}

const SAVE_PICKER_TYPES = [
  { description: 'PushForm Model', accept: { 'application/octet-stream': ['.pf'] } },
  { description: 'PushForm Layout', accept: { 'application/octet-stream': ['.pfl'] } },
];
function savePickerTypes(tab: DocumentTab): typeof SAVE_PICKER_TYPES {
  return [SAVE_PICKER_TYPES[tab.type === 'model' ? 0 : 1]!];
}

function saveTauriFilters(tab: DocumentTab): { name: string; extensions: string[] }[] {
  return [{ name: tab.type === 'model' ? 'PushForm Model' : 'PushForm Layout',
    extensions: [tab.type === 'model' ? 'pf' : 'pfl'] }];
}

function withExtension(name: string, tab: DocumentTab): string {
  const extension = tab.type === 'model' ? '.pf' : '.pfl';
  return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function download(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function TopBar({ session, cloud, cloudFiles, buildInfo, autosave, onHome, onRequests, onObjects, onClearChat }: {
  session: DocumentSession; cloud?: CloudSession | undefined; cloudFiles?: CloudFilesApi | undefined;
  buildInfo?: BuildInfo | undefined;
  autosave?: CloudAutosave | undefined; onHome?: (() => void) | undefined;
  /**
   * Toggles the AI Chat pane from command search;
   * absent when the host embeds no pipeline entry point.
   */
  onRequests?: ((anchor: HTMLElement | null, mode: 'toggle' | 'open') => void) | undefined;
  onObjects?: (() => void) | undefined;
  /** Clears the active document's AI Chat conversation. */
  onClearChat?: (() => void) | undefined;
}): JSX.Element {
  const requestsRef = useRef(onRequests);
  requestsRef.current = onRequests;
  const clearChatRef = useRef(onClearChat);
  clearChatRef.current = onClearChat;
  const [cloudBrowser, setCloudBrowser] = useState<{ saveTab?: DocumentTab; saveAsTemplate?: boolean } | null>(null);
  useEffect(() => () => { if (cloudBrowser?.saveTab && !cloudBrowser.saveAsTemplate) autosave?.pause(cloudBrowser.saveTab, false); }, [autosave, cloudBrowser]);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const cloudSaving = useRef(false);
  const closingSaves = useRef(new Set<string>());
  const boundOwner = useRef(cloud?.getSnapshot().user?.id);
  const cloudOwner = (): string | null => cloud?.getSnapshot().status === 'signedIn' && cloud.getSnapshot().user?.id === boundOwner.current ? boundOwner.current ?? null : null;
  const menuOpen = useAppStore((s) => s.menuOpen);
  const setMenuOpen = useAppStore((s) => s.setMenuOpen);
  const menuRoot = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const modelImportInput = useRef<HTMLInputElement>(null);
  const importTarget = useRef<{ tabId: string; definitionId: DefId } | null>(null);
  const modelImportRun = useRef<AbortController | null>(null);
  const handles = useRef(new Map<string, BrowserDocumentHandle>());
  const handleStore = useRef(defaultBrowserFileHandleStore());
  const handleLoad = useRef<Promise<void>>(Promise.resolve());
  const [choosingTemplate, setChoosingTemplate] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<{ fileName: string; warnings: string[]; exported?: boolean; format?: string } | null>(null);
  /** The open OBJ, 3DS or unitless DXF import options and how to answer them. */
  const [meshPrompt, setMeshPrompt] = useState<{ fileName: string; kind: MeshFormatKind; extent: MeshExtent | null;
    destination: string | undefined; resolve: (options: MeshImportOptions | null) => void } | null>(null);
  const [modelExport, setModelExport] = useState<{ tabId: string; format: ModelExportDialogFormat } | null>(null);
  const [modelImportNotice, setModelImportNotice] = useState<{
    fileName: string; progress?: ImportProgress; report?: ModelImportReport;
  } | null>(null);
  const [recoveries, setRecoveries] = useState<LayoutRecoveryMetadata[]>([]);
  const picker = window as unknown as FilePickerWindow;

  useEffect(() => () => { modelImportRun.current?.abort(); }, []);

  const importModel = (): void => {
    const active = session.active;
    if (active.type !== 'model' || modelImportRun.current) return;
    importTarget.current = { tabId: active.id, definitionId: active.app.document.context.definitionId };
    modelImportInput.current?.click();
  };
  const importModelRef = useRef(importModel);
  importModelRef.current = importModel;
  useEffect(() => {
    const active = session.active;
    if (active.type !== 'model') return;
    return active.app.commands.register(defineCommand({
      id: 'file.import', title: 'Import Model…', category: 'file', menu: 'File',
      icon: 'folder', params: z.object({}), undoable: false,
      when: () => !modelImportRun.current,
      run: () => importModelRef.current(),
    }));
  }, [session, session.activeId]);
  useEffect(() => {
    const active = session.active;
    if (active.type !== 'model') return;
    return active.app.commands.register(defineCommand({
      id: 'file.exportStl', title: 'Export STL…', category: 'file', menu: 'File',
      icon: 'folder', params: z.object({}), undoable: false,
      run: () => setModelExport({ tabId: active.id, format: 'stl' }),
    }));
  }, [session, session.activeId]);
  useEffect(() => {
    const active = session.active;
    if (active.type !== 'model') return;
    const commands = ([['file.exportGltf', 'Export glTF…', 'gltf'], ['file.exportObj', 'Export OBJ…', 'obj'], ['file.exportCollada', 'Export COLLADA…', 'collada']] as const)
      .map(([id, title, format]) => active.app.commands.register(defineCommand({
        id, title, category: 'file', menu: 'File', icon: 'folder', params: z.object({}), undoable: false,
        run: () => setModelExport({ tabId: active.id, format }),
      })));
    return () => { for (const unregister of commands) unregister(); };
  }, [session, session.activeId]);
  useEffect(() => {
    const active = session.active;
    if (active.type !== 'model') return;
    return active.app.commands.register(defineCommand({
      id: 'file.export2dGraphic', title: 'Export 2D Graphic…', category: 'file', menu: 'File',
      icon: 'folder', params: z.object({}), undoable: false,
      run: () => setModelExport({ tabId: active.id, format: 'image' }),
    }));
  }, [session, session.activeId]);

  // About is app-wide, so command search offers it in whichever document type is active.
  useEffect(() => {
    const active = session.active;
    const registry = active.type === 'model' ? active.app.commands : active.commands;
    return registry.register(defineCommand({
      id: 'help.about', title: 'About PushForm', category: 'help', menu: 'Help',
      icon: 'help', params: z.object({}), undoable: false,
      run: () => setAboutOpen(true),
    }));
  }, [session, session.activeId]);

  useEffect(() => {
    const updates = desktopUpdates();
    if (!updates) return;
    const active = session.active;
    const registry = active.type === 'model' ? active.app.commands : active.commands;
    return registry.register(defineCommand({
      id: 'help.checkUpdates', title: 'Check for updates', category: 'help', menu: 'Help',
      icon: 'check-updates', params: z.object({}), undoable: false,
      when: () => updates.getSnapshot().enabled,
      run: () => { setAboutOpen(true); void updates.check(); },
    }));
  }, [session, session.activeId]);

  // AI Chat is reachable from its icon and from command search in either editor.
  useEffect(() => {
    if (!onRequests) return;
    const active = session.active;
    const registry = active.type === 'model' ? active.app.commands : active.commands;
    return registry.register(defineCommand({
      id: 'help.requests', title: 'AI Chat', category: 'help', menu: 'Help',
      icon: 'chat-ai', params: z.object({}), undoable: false,
      run: () => requestsRef.current?.(null, 'toggle'),
    }));
  }, [session, session.activeId, !onRequests]);

  const objectsRef = useRef(onObjects);
  objectsRef.current = onObjects;
  useEffect(() => {
    if (!onObjects) return;
    const active = session.active;
    const registry = active.type === 'model' ? active.app.commands : active.commands;
    return registry.register(defineCommand({
      id: 'view.objects', title: 'Object browser', category: 'view', menu: 'View',
      icon: 'object-browser', params: z.object({}), undoable: false,
      run: () => objectsRef.current?.(),
    }));
  }, [session, session.activeId, !onObjects]);

  // Clear Chat starts the active document's conversation over from command search.
  useEffect(() => {
    if (!onClearChat) return;
    const active = session.active;
    const registry = active.type === 'model' ? active.app.commands : active.commands;
    return registry.register(defineCommand({
      id: 'help.clearChat', title: 'Clear Chat', category: 'help', menu: 'Help',
      icon: 'chat-delete', params: z.object({}), undoable: false,
      run: () => clearChatRef.current?.(),
    }));
  }, [session, session.activeId, !onClearChat]);

  /** Every import attempt is reported to the cloud log, whatever its outcome. */
  const readSketchUpFile = async (
    readBytes: () => Promise<Uint8Array>, name: string,
    target?: { tabId: string; definitionId: DefId }, picked?: PickedFile,
  ): Promise<DocumentTab> => {
    if (modelImportRun.current) throw new Error('A model import is already running.');
    const controller = new AbortController();
    modelImportRun.current = controller;
    setError(null);
    setModelImportNotice({ fileName: name });
    try {
      const bytes = await readBytes();
      // OBJ and 3DS files record no unit (OBJ no up axis either), nor do some DXF files, so import asks first.
      const probe = probeMeshImport(bytes);
      let mesh: MeshImportOptions | undefined;
      if (probe) {
        setModelImportNotice(null);
        const chosen = await new Promise<MeshImportOptions | null>(resolve =>
          setMeshPrompt({ fileName: name, kind: probe.kind, extent: probe.extent, destination: target?.tabId, resolve }));
        if (!chosen) throw new DOMException('Import cancelled.', 'AbortError');
        rememberMeshOptions(probe.kind, chosen);
        mesh = chosen;
        setModelImportNotice({ fileName: name });
      }
      const result = await importSketchUpBytes(session, bytes, name, { target, signal: controller.signal, cloudFiles, buildInfo, picked, mesh,
        onProgress: progress => { if (!controller.signal.aborted) setModelImportNotice({ fileName: name, progress }); } });
      setModelImportNotice({ fileName: name, report: result.report });
      return result.tab;
    } catch (cause) {
      setModelImportNotice(null);
      throw cause;
    } finally {
      if (modelImportRun.current === controller) modelImportRun.current = null;
    }
  };

  /** A picture is placed as an image in the open group or component, selected, and picked up with Move. */
  const importPicture = async (file: File, tabId: string): Promise<void> => {
    if (file.size > MAX_PICTURE_BYTES) throw new Error(`${file.name}: pictures larger than ${MAX_PICTURE_BYTES / 1048576} MiB are not supported.`);
    const tab = session.tabs.find(candidate => candidate.id === tabId);
    if (tab?.type !== 'model') return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await tab.app.commands.execute('image.import', { bytes, name: file.name, mime: pictureMime(file.name) ?? file.type });
    tab.app.toolManager.activate('move');
  };

  const importModelFallback = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0], target = importTarget.current;
    event.target.value = '';
    if (!file || !target) return;
    try {
      if (isPictureFile(file.name)) return await importPicture(file, target.tabId);
      if (!isModelImportFile(file.name)) throw new Error('Choose a .skp, .skb, .dae, .obj, .3ds, .stl, .dxf, .gltf, .glb, .zip, or .kmz model, or a .png, .jpg, .gif, .bmp or .webp picture.');
      if (file.size > MAX_SKETCHUP_BYTES) throw new Error(tooLarge(file.name));
      await readSketchUpFile(async () => new Uint8Array(await file.arrayBuffer()), file.name, target, file);
    } catch (cause) { if ((cause as Error).name !== 'AbortError') setError((cause as Error).message); }
  };

  useEffect(() => {
    let active = true;
    void session.listLayoutRecoveries().then(
      (records) => { if (active) setRecoveries(records); },
      (cause: unknown) => { if (active) setError((cause as Error).message); },
    );
    return () => { active = false; };
  }, [session]);

  useEffect(() => {
    let mounted = true;
    const store = handleStore.current;
    handleLoad.current = (async () => {
      if (!store) return;
      for (const tab of session.tabs) {
        if (!tab.identity?.startsWith('browser:')) continue;
        try {
          const handle = await store.get(tab.identity);
          if (mounted && handle && session.tabs.includes(tab)) handles.current.set(tab.id, handle);
        } catch {
          // One missing handle does not prevent the other tabs from restoring.
        }
      }
    })();
    return () => { mounted = false; };
  }, [session]);

  const resolveRecovery = async (record: LayoutRecoveryMetadata, restore: boolean): Promise<void> => {
    try {
      if (restore) await session.restoreLayoutRecovery(record);
      else session.discardLayoutRecovery(record.id);
      setRecoveries((items) => items.filter((item) => item.id !== record.id));
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const openBytes = async (bytes: Uint8Array, name: string, identity?: string, picked?: PickedFile, stage?: (label: string) => Promise<void>): Promise<DocumentTab> => {
    if (isModelImportFile(name)) return readSketchUpFile(() => Promise.resolve(bytes), name, undefined, picked);
    if (isSketchUpLayoutFile(name)) {
      const { tab, warnings } = await importLayoutBytes(session, bytes, name, { cloudFiles, buildInfo, picked });
      setImportNotice(warnings.length ? { fileName: name, warnings } : null);
      return tab;
    }
    const type = nativeDocumentType(name);
    if (type === 'model') {
      await stage?.('Reading model…');
      const opened = await openModelFile(bytes);
      await stage?.('Preparing workspace…');
      return session.openModelFile(opened, name, identity);
    }
    if (type === 'layout') {
      await stage?.('Reading drawing…');
      const opened = await openLayoutFile(bytes);
      await stage?.('Preparing workspace…');
      return session.openLayoutFile(opened, name, identity);
    }
    throw new Error('Choose a .pf, .pfl, .layout, .skp, .skb, .dae, .obj, .3ds, .stl, .dxf, .gltf, .glb, .zip, or .kmz file');
  };

  const openHandle = async (handle: BrowserDocumentHandle): Promise<void> => {
    await handleLoad.current;
    if (isSketchUpLayoutFile(handle.name) || isModelImportFile(handle.name)) {
      // Converted documents save as .pf/.pfl, so the original source handle is not kept.
      const file = await handle.getFile();
      if (isModelImportFile(file.name) && file.size > MAX_SKETCHUP_BYTES) throw new Error(tooLarge(file.name));
      if (isModelImportFile(file.name)) await readSketchUpFile(async () => new Uint8Array(await file.arrayBuffer()), file.name, undefined, file);
      else await openBytes(new Uint8Array(await file.arrayBuffer()), handle.name, undefined, file);
      return;
    }
    if (!nativeDocumentType(handle.name)) throw new Error('Choose a .pf, .pfl, .layout, .skp, .skb, .dae, .obj, .3ds, .stl, .dxf, .gltf, .glb, .zip, or .kmz file');
    for (const [id, current] of handles.current) {
      if (await current.isSameEntry?.(handle)) {
        session.activate(id);
        return;
      }
    }
    await session.loading.run(handle.name, 'Reading file…', async stage => {
      const file = await handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      let identity = handleStore.current ? `browser:${newGuid()}` : undefined;
      if (identity) {
        try {
          await handleStore.current!.put(identity, handle);
        } catch {
          // The file still opens when IndexedDB is unavailable.
          identity = undefined;
        }
      }
      let tab: DocumentTab;
      try {
        tab = await openBytes(bytes, file.name, identity, undefined, stage);
      } catch (cause) {
        if (identity) void handleStore.current?.delete(identity).catch(() => {});
        throw cause;
      }
      handles.current.set(tab.id, handle);
    });
  };

  const openDocument = async (): Promise<void> => {
    setError(null);
    if (isTauri()) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const path = await open({ multiple: false, directory: false });
        if (!path || Array.isArray(path)) return;
        const existing = session.tabs.find((tab) => tab.identity === path);
        if (existing) {
          session.activate(existing.id);
          return;
        }
        const { readFile } = await import('@tauri-apps/plugin-fs');
        const name = fileName(path);
        if (nativeDocumentType(name)) await session.loading.run(name, 'Reading file…', async stage => openBytes(await readFile(path), name, path, undefined, stage));
        else await openBytes(await readFile(path), name, path);
      } catch (cause) {
        if ((cause as Error).name !== 'AbortError') setError((cause as Error).message);
      }
      return;
    }
    if (!picker.showOpenFilePicker) {
      inputRef.current?.click();
      return;
    }
    try {
      const [handle] = await picker.showOpenFilePicker({ multiple: false, excludeAcceptAllOption: false });
      if (handle) await openHandle(handle);
    } catch (cause) {
      if ((cause as Error).name !== 'AbortError') setError((cause as Error).message);
    }
  };

  const openFallback = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (isModelImportFile(file.name) && file.size > MAX_SKETCHUP_BYTES) throw new Error(tooLarge(file.name));
      if (isModelImportFile(file.name)) await readSketchUpFile(async () => new Uint8Array(await file.arrayBuffer()), file.name, undefined, file);
      else if (nativeDocumentType(file.name)) await session.loading.run(file.name, 'Reading file…', async stage => openBytes(new Uint8Array(await file.arrayBuffer()), file.name, undefined, file, stage));
      else await openBytes(new Uint8Array(await file.arrayBuffer()), file.name, undefined, file);
      setError(null);
    } catch (cause) {
      if ((cause as Error).name !== 'AbortError') setError((cause as Error).message);
    }
  };

  const saveDocument = async (tab: DocumentTab, saveAs = false): Promise<boolean> => {
    setError(null);
    if (autosave && !saveAs) {
      try { await autosave.saveNow(tab); return true; }
      catch (cause) { setError((cause as Error).message); return false; }
    }
    const location = cloudLocation(tab.identity);
    if (!saveAs && location) {
      if (!cloudFiles) { setError('Cloud file storage is not configured. Use Save as… for a local copy.'); return false; }
      if (cloudSaving.current) return false;
      cloudSaving.current = true;
      try { await saveCloudDocument(cloudFiles, session, tab, cloudOwner, location.projectId, tab.name); return true; }
      catch (cause) { setError((cause as Error).message); return false; }
      finally { cloudSaving.current = false; }
    }
    let savedContent: string;
    let bytes: Uint8Array;
    try {
      savedContent = tab.type === 'model'
        ? modelContentKey(tab.app.document.doc) : layoutContentKey(tab.doc);
      bytes = tab.type === 'model'
        ? await encodeModelSnapshot(tab.app.document.doc.state, modelArchiveImages(tab.app.document.doc.state, tab.app.document.images)) : await encodeLayoutSnapshot(tab.doc.state);
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    }
    const markSaved = (name: string, identity?: string | null): void => {
      if (tab.type === 'model') session.markModelSaved(tab.id, name, identity, savedContent);
      else session.markLayoutSaved(tab.id, name, identity, savedContent);
    };
    if (isTauri()) {
      try {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const chosen = !saveAs && tab.identity
          ? tab.identity
          : await save({ defaultPath: tab.name, filters: saveTauriFilters(tab) });
        if (!chosen) return false;
        const path = withExtension(chosen, tab);
        if (session.tabs.some((other) => other.id !== tab.id && other.identity === path)) {
          setError('This file is already open in another tab');
          return false;
        }
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        await writeFile(path, bytes);
        markSaved(fileName(path), path);
        return true;
      } catch (cause) {
        setError((cause as Error).message);
        return false;
      }
    }
    let handle = saveAs ? undefined : handles.current.get(tab.id);
    let fallbackName = tab.name;
    try {
      if (!handle && picker.showSaveFilePicker) {
        handle = await picker.showSaveFilePicker({ suggestedName: tab.name, types: savePickerTypes(tab) });
      } else if (!handle && saveAs) {
        const requested = window.prompt(`Save ${tab.type === 'model' ? 'Model' : 'Layout'} as`, tab.name);
        if (!requested?.trim()) return false;
        fallbackName = withExtension(requested.trim(), tab);
      }
      if (handle) {
        await handleLoad.current;
        for (const [id, current] of handles.current) {
          if (id !== tab.id && await current.isSameEntry?.(handle)) {
            setError('This file is already open in another tab');
            return false;
          }
        }
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
        const previousIdentity = tab.identity;
        let identity: string | null = null;
        if (handleStore.current) {
          const key = !saveAs && previousIdentity?.startsWith('browser:')
            ? previousIdentity : `browser:${newGuid()}`;
          try {
            await handleStore.current.put(key, handle);
            identity = key;
          } catch {
            // The saved file remains usable in the current session.
          }
        }
        handles.current.set(tab.id, handle);
        markSaved(handle.name, identity);
        if (previousIdentity?.startsWith('browser:') && previousIdentity !== identity)
          void handleStore.current?.delete(previousIdentity).catch(() => {});
      } else {
        download(bytes, fallbackName);
        if (saveAs) handles.current.delete(tab.id);
        if (tab.identity?.startsWith('browser:'))
          void handleStore.current?.delete(tab.identity).catch(() => {});
        markSaved(fallbackName, null);
      }
      return true;
    } catch (cause) {
      if ((cause as Error).name !== 'AbortError') setError((cause as Error).message);
      return false;
    }
  };

  /** Writes the model, or its selection, as STL; the tab keeps its own file, name, and saved state. */
  const exportModelStl = async (tabId: string, choice: StlExportChoice): Promise<void> => {
    const tab = session.tabs.find(candidate => candidate.id === tabId);
    if (tab?.type !== 'model') return;
    setError(null);
    const name = stlFileName(tab.name), host = tab.app.document;
    try {
      const { bytes, notes } = exportStl(host.doc.state, { unit: choice.unit, format: choice.format, name: tab.name,
        selection: choice.selectionOnly ? host.selection.refs : null });
      if (isTauri()) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const chosen = await save({ defaultPath: name, filters: [{ name: 'STL', extensions: ['stl'] }] });
        if (!chosen) return;
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        await writeFile(/\.stl$/i.test(chosen) ? chosen : `${chosen}${STL_EXTENSION}`, bytes);
      } else if (picker.showSaveFilePicker) {
        const handle = await picker.showSaveFilePicker({ suggestedName: name,
          types: [{ description: 'STL', accept: { 'model/stl': [STL_EXTENSION] } }] });
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
      } else download(bytes, name);
      setImportNotice(notes.length ? { fileName: name, warnings: notes, exported: true, format: 'STL' } : null);
    } catch (cause) {
      if ((cause as Error).name !== 'AbortError') setError((cause as Error).message);
    }
  };

  /**
   * Writes the model, or its selection, as glTF, OBJ or COLLADA with its textures; the tab keeps its own file,
   * name, and saved state.
   */
  const exportModelFile = async (tabId: string, format: ModelExportFormat, choice: ModelExportChoice): Promise<void> => {
    const tab = session.tabs.find(candidate => candidate.id === tabId);
    if (tab?.type !== 'model') return;
    setError(null);
    const host = tab.app.document;
    const options = { name: tab.name, selection: choice.selectionOnly ? host.selection.refs : null, image: (id: number) => {
      const blob = host.images.get(id as never), asset = host.images.asset(id as never) ?? host.doc.state.images.get(id as never);
      return blob ? { bytes: blob.bytes, mime: blob.mime, name: asset?.name ?? `image${id}` } : undefined;
    } };
    const label = { gltf: 'glTF', obj: 'OBJ', collada: 'COLLADA' }[format];
    try {
      const { bytes, fileName, notes } = format === 'gltf' ? exportGlb(host.doc.state, options)
        : format === 'obj' ? exportObj(host.doc.state, { ...options, unit: choice.unit, up: choice.up }) : exportCollada(host.doc.state, options);
      const extension = fileName.slice(fileName.lastIndexOf('.'));
      const mime = extension === '.glb' ? 'model/gltf-binary' : extension === '.zip' ? 'application/zip' : 'model/vnd.collada+xml';
      if (isTauri()) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const chosen = await save({ defaultPath: fileName, filters: [{ name: label, extensions: [extension.slice(1)] }] });
        if (!chosen) return;
        const { writeFile } = await import('@tauri-apps/plugin-fs');
        await writeFile(chosen.toLowerCase().endsWith(extension) ? chosen : `${chosen}${extension}`, bytes);
      } else if (picker.showSaveFilePicker) {
        const handle = await picker.showSaveFilePicker({ suggestedName: fileName, types: [{ description: label, accept: { [mime]: [extension] } }] });
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
      } else download(bytes, fileName);
      setImportNotice(notes.length ? { fileName, warnings: notes, exported: true, format: label } : null);
    } catch (cause) {
      if ((cause as Error).name !== 'AbortError') setError((cause as Error).message);
    }
  };

  const closeTab = (id: string): void => {
    const tab = session.tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    if (autosave) {
      if (closingSaves.current.has(id)) return;
      closingSaves.current.add(id);
      void autosave.saveNow(tab).then(() => { session.close(id); }).catch(cause => {
        setError((cause as Error).message); setClosingId(id);
      }).finally(() => closingSaves.current.delete(id));
      return;
    }
    if (session.isDirty(tab)) {
      setClosingId(id);
      return;
    }
    session.close(id);
    handles.current.delete(id);
    if (tab.identity?.startsWith('browser:'))
      void handleStore.current?.delete(tab.identity).catch(() => {});
  };

  const finishClose = async (choice: 'save' | 'discard' | 'cancel'): Promise<void> => {
    if (choice === 'cancel') {
      setClosingId(null);
      return;
    }
    const tab = session.tabs.find((candidate) => candidate.id === closingId);
    if (!tab) {
      setClosingId(null);
      return;
    }
    if (choice === 'save') {
      if (!(await saveDocument(tab))) return;
    }
    session.close(tab.id, true);
    handles.current.delete(tab.id);
    if (tab.identity?.startsWith('browser:'))
      void handleStore.current?.delete(tab.identity).catch(() => {});
    setClosingId(null);
  };

  const active = session.active;
  const closeCloudBrowser = (): void => {
    if (cloudBrowser?.saveTab && !cloudBrowser.saveAsTemplate) autosave?.pause(cloudBrowser.saveTab, false);
    setCloudBrowser(null);
  };
  const makeCloudCopy = (): void => {
    const tab = session.active;
    void (async () => {
      try { await autosave?.saveNow(tab); } catch { /* A stale head may still be saved as a separate file. */ }
      autosave?.pause(tab, true); setCloudBrowser({ saveTab: tab });
    })();
  };
  const saveTemplate = (): void => {
    if (session.active.type === 'layout' && cloudFiles) setCloudBrowser({ saveTab: session.active, saveAsTemplate: true });
  };
  const fileActions = useRef({ saveTemplate, save: () => { void saveDocument(session.active); }, saveAs: () => {
    if (autosave) makeCloudCopy(); else void saveDocument(session.active, true);
  } });
  fileActions.current = { saveTemplate, save: () => { void saveDocument(session.active); }, saveAs: () => {
    if (autosave) makeCloudCopy(); else void saveDocument(session.active, true);
  } };
  useEffect(() => {
    const tab = session.active;
    const registry = tab.type === 'model' ? tab.app.commands : tab.commands;
    const off = [registry.register(defineCommand({
      id: 'file.save', title: 'Save', category: 'file', menu: 'File', icon: 'save',
      params: z.object({}), undoable: false, run: () => fileActions.current.save(),
    })), registry.register(defineCommand({
      id: 'file.saveAs', title: 'Save As…', category: 'file', menu: 'File', icon: 'save-as',
      params: z.object({}), undoable: false, run: () => fileActions.current.saveAs(),
    }))];
    if (tab.type === 'layout') off.push(registry.register(defineCommand({
      id: 'file.saveTemplate', title: 'Save as Template…', category: 'file', menu: 'File', icon: 'document-template',
      params: z.object({}), undoable: false, when: () => !!cloudFiles, run: () => fileActions.current.saveTemplate(),
    })));
    return () => off.forEach(dispose => dispose());
  }, [session, session.activeId, cloudFiles]);
  const closingTab = session.tabs.find((candidate) => candidate.id === closingId);
  /** An update that has waited a week must be installed before another document opens. */
  const newLayout = (): void => { if (allowOpeningDocument()) setChoosingTemplate(true); };
  const menuItems: { label: string; enabled: boolean; action: () => void; command?: string; separated?: boolean }[] = [
    ...(!autosave ? [
      { label: 'Browse Cloud…', enabled: !!cloudFiles, action: () => { if (onHome) onHome(); else setCloudBrowser({}); } },
      { label: 'Save to Cloud…', enabled: !!cloudFiles, action: () => setCloudBrowser({ saveTab: session.active }) },
    ] : []),
    { label: 'New Model', enabled: true, action: () => { if (allowOpeningDocument()) session.newModel(); } },
    { label: 'New Layout', enabled: true, action: newLayout },
    ...(active.type === 'layout' ? [{ label: 'Import...', command: 'layout.import', enabled: active.commands.isEnabled('layout.import'), action: () => active.commands.execute('layout.import') }] : []),
    ...(active.type === 'model' ? [{ label: 'Import...', command: 'file.import', enabled: !modelImportRun.current, action: importModel }] : []),
    ...(active.type === 'layout' ? [{ label: 'Print…', command: 'layout.print', enabled: active.commands.isEnabled('layout.print'), action: () => active.commands.execute('layout.print') }] : []),
    {
      label: 'Open…',
      enabled: true,
      action: () => {
        if (allowOpeningDocument()) void openDocument();
      },
    },
    {
      label: 'Save', command: 'file.save',
      enabled: true,
      action: () => {
        fileActions.current.save();
      },
    },
    {
      label: 'Save As…', command: 'file.saveAs',
      enabled: true,
      action: () => {
        fileActions.current.saveAs();
      },
    },
    ...(active.type === 'layout' ? [{ label: 'Save as Template…', command: 'file.saveTemplate', enabled: !!cloudFiles, action: saveTemplate }] : []),
    { label: 'Export…', enabled: active.type === 'model' || active.commands.isEnabled('layout.export.image'), action: () => {
      if (active.type === 'layout') active.commands.execute('layout.export.image');
      else setModelExport({ tabId: active.id, format: 'stl' });
    } },
  ];

  const menuTargetId = (label: string): string => `menu:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')}`;
  useLayoutEffect(() => {
    if (!menuRoot.current) return;
    return registerGuidanceTargets({ root: menuRoot.current,
      targets: menuItems.map(item => ({ id: menuTargetId(item.label), label: item.label, surface: 'menu' as const,
        route: `Main menu > ${item.label}`, enabled: item.enabled,
        action: item.command ?? `${active.type}:${item.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` })),
      reveal: () => setMenuOpen(true),
    });
  });

  return (
    <header className="pf-topbar">
      <button type="button" className="pf-brand" aria-label="PushForm home" onClick={onHome}>
        <img className="pf-brand-logo" src="/pf-logo-mark.svg" alt="" width={24} height={24} />
        <span className="pf-brand-name">PushForm</span>
      </button>
      <div className="pf-topbar-menu" ref={menuRoot}>
        <button
          type="button"
          className="pf-iconbtn"
          aria-label="Main menu"
          data-guidance-id="menu:main"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <Icon name="menu" />
        </button>
        {menuOpen ? (
          <ul className="pf-menu" role="menu" onMouseLeave={() => setMenuOpen(false)}>
            {menuItems.map((item) => (
              <li key={item.label} role="none" className={item.separated ? 'has-separator' : undefined}>
                <button
                  type="button"
                  role="menuitem"
                  data-guidance-id={menuTargetId(item.label)}
                  data-guidance-action={item.command}
                  data-guidance-route={`Main menu > ${item.label}`}
                  className="pf-menu-item"
                  disabled={!item.enabled}
                  onClick={() => {
                    setMenuOpen(false);
                    item.action();
                  }}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        hidden
        aria-label="Open PushForm file"
        onChange={(event) => {
          void openFallback(event);
        }}
      />
      <input ref={modelImportInput} type="file" hidden accept=".skp,.skb,.dae,.obj,.3ds,.stl,.dxf,.gltf,.glb,.zip,.kmz,.png,.jpg,.jpeg,.gif,.bmp,.webp" aria-label="Import model file"
        onChange={event => { void importModelFallback(event); }} />
      <DocumentTabs session={session} onClose={closeTab} onNewLayout={newLayout} />
      {choosingTemplate ? <LayoutTemplateChooser busy={templateBusy} savedTemplates={cloudFiles ?
        <CloudBrowser api={cloudFiles} session={session} owner={cloudOwner} templatesOnly embedded
          onBusyChange={setTemplateBusy} onClose={() => setChoosingTemplate(false)} /> : undefined} onCancel={() => setChoosingTemplate(false)} onCreate={templateId => {
        session.newLayout(templateId); setChoosingTemplate(false);
      }} /> : null}
      <CommandSearch source={() => commandSearchSourceFor(session.active)} />
      {autosave ? <AutosaveIndicator autosave={autosave} tab={active} onSaveCopy={makeCloudCopy} /> : null}
      <AccountControl cloud={cloud} />
      {aboutOpen ? <AboutDialog build={buildInfo ?? UNKNOWN_BUILD} onClose={() => setAboutOpen(false)} /> : null}
      {cloudBrowser && cloudFiles ? <CloudBrowser api={cloudFiles} session={session} owner={cloudOwner}
        saveTab={cloudBrowser.saveTab} saveAsTemplate={cloudBrowser.saveAsTemplate} forceCopy={!!autosave} onClose={closeCloudBrowser} /> : null}
      {error || session.recoveryError ? (
        <span className="pf-file-error" role="alert">
          {error ?? session.recoveryError}
        </span>
      ) : null}
      {importNotice ? <LayoutImportDialog {...importNotice} onClose={() => setImportNotice(null)} /> : null}
      {meshPrompt ? <MeshImportDialog fileName={meshPrompt.fileName} kind={meshPrompt.kind} extent={meshPrompt.extent}
        initial={rememberedMeshOptions(meshPrompt.kind)} units={(() => {
          // Sizes read in the units of the model receiving the import; a new model starts with the default units.
          const tab = session.tabs.find(candidate => candidate.id === meshPrompt.destination);
          return tab?.type === 'model' ? tab.app.document.doc.state.meta.units : DEFAULT_UNITS;
        })()} onCancel={() => { meshPrompt.resolve(null); setMeshPrompt(null); }}
        onImport={options => { meshPrompt.resolve(options); setMeshPrompt(null); }} /> : null}
      {(() => {
        const tab = modelExport ? session.tabs.find(candidate => candidate.id === modelExport.tabId) : undefined;
        if (!modelExport || tab?.type !== 'model') return null;
        const viewport = tab.app.viewport;
        return <ModelExportDialog modelName={tab.name} initialFormat={modelExport.format} hasSelection={!tab.app.document.selection.isEmpty}
          encodeNative={() => encodeModelSnapshot(tab.app.document.doc.state, modelArchiveImages(tab.app.document.doc.state, tab.app.document.images))}
          view={viewport.size} render={(width, height, options) => viewport.renderImage(width, height, options)}
          onGeometryExport={(format, choice, stlFormat) => {
            setModelExport(null);
            if (format === 'stl') void exportModelStl(tab.id, { unit: choice.unit, format: stlFormat, selectionOnly: choice.selectionOnly });
            else void exportModelFile(tab.id, format, choice);
          }} onClose={() => setModelExport(null)} />;
      })()}
      {modelImportNotice ? <ModelImportDialog {...modelImportNotice} onClose={() => {
        modelImportRun.current?.abort(); setModelImportNotice(null);
      }} /> : null}
      {closingId ? (
        <div className="pf-modal-backdrop">
          <div className="pf-modal" role="dialog" aria-modal="true" aria-label="Unsaved changes">
            <p>
              Save changes before closing this {closingTab?.type === 'layout' ? 'Layout' : 'Modeling'} document?
            </p>
            <div className="pf-modal-actions">
              <button
                type="button"
                onClick={() => {
                  void finishClose('save');
                }}
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  void finishClose('discard');
                }}
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => {
                  void finishClose('cancel');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {!closingId && recoveries.length > 0 ? (
        <div className="pf-modal-backdrop">
          <div className="pf-modal" role="dialog" aria-modal="true" aria-label="Recover Layout document">
            <p>Recover unsaved changes to {recoveries[0]!.name}?</p>
            <div className="pf-modal-actions">
              <button type="button" onClick={() => resolveRecovery(recoveries[0]!, true)}>Recover</button>
              <button type="button" onClick={() => resolveRecovery(recoveries[0]!, false)}>Discard</button>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
