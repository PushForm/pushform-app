// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useRef, useSyncExternalStore, type JSX, type ReactNode } from 'react';
import { DEFAULT_UNITS, type UnitSettings } from '@pushform/core';
import type { ContributionEntry, ExtensionPlatform } from '@pushform/extensions';
import type { DocumentTabStrip } from '../components/DocumentTabs';
import type { ExtensionToolbarItem } from '../components/MainToolbar';
import type { SideRailItem } from '../components/SideRail';
import type { DocumentTab } from '../session';
import { ExtensionActivity, type ExtensionRuns } from './ExtensionActivity';
import { ExtensionIcon } from './ExtensionIcon';
import { ExtensionSidebar } from './ExtensionSidebar';
import { ExtensionTabView } from './ExtensionTabView';
import {
  activityExtensions, extensionPanels, extensionRailId, extensionSidebars, extensionToolbarButtons, isExtensionRailId, railExtensionId,
  syncExtensionCommands, type ExtensionEditor,
} from './extensionContributions';
import type { ExtensionTabs } from './extensionTabs';

/**
 * What enabled extensions add to the open editor, on the model of a code editor's activity bar: one icon per
 * extension in the side rail, after the built-in items, which opens the extension's side panel in the dock (or, for
 * an extension without one, its tab); its panels as tabs in the tab strip, filling the editor area; its toolbar
 * buttons in the modeling toolbar; its commands in the document's registry (and so in command search and the context
 * menu); and the status of commands that are running. Which extension's side panel is open is remembered per
 * account and editor. Extension tabs last for the session.
 */
export function useExtensionWorkspace({ platform, runs, tabs, ownerId, active, openTabs, sidePanel, openPanel, closePanel }: {
  readonly platform: ExtensionPlatform | null;
  readonly runs: ExtensionRuns | null;
  readonly tabs: ExtensionTabs | null;
  readonly ownerId: string;
  /** The open document, or null on Home. */
  readonly active: DocumentTab | null;
  /** The ids of every open document. */
  readonly openTabs: readonly string[];
  readonly sidePanel: string | null;
  readonly openPanel: (id: `extension:${string}`) => void;
  readonly closePanel: () => void;
}): {
  railItems: SideRailItem[];
  /** Handles a click on an extension's activity bar icon. */
  toggleRail: (id: `extension:${string}`) => void;
  panel: JSX.Element | null;
  activity: JSX.Element | null;
  shown: boolean;
  tabStrip: DocumentTabStrip | null;
  /** The content of the extension tab in front, which fills the editor area; null while a document is in front. */
  tabView: JSX.Element | null;
  toolbarItems: readonly ExtensionToolbarItem[];
} {
  const revision = useSyncExternalStore((notify) => platform?.subscribe(notify) ?? (() => {}), () => platform?.revision ?? 0);
  useSyncExternalStore((notify) => tabs?.subscribe(notify) ?? (() => {}), () => tabs?.revision ?? 0);
  const editor: ExtensionEditor | null = active ? (active.type === 'model' ? 'modeling' : 'layout') : null;
  // The revision says when installed or enabled extensions changed.
  const extensions = useMemo(() => (platform && editor ? activityExtensions(platform, editor) : []), [platform, editor, revision]);
  const buttons = useMemo(() => (platform && editor === 'modeling' ? extensionToolbarButtons(platform, editor) : []), [platform, editor, revision]);

  // Commands, selection actions, toolbar buttons and panels of the active document's editor.
  const activeId = active?.id ?? null;
  const registry = active ? (active.type === 'model' ? active.app.commands : active.commands) : null;
  const start = (entry: ContributionEntry): void => {
    if (!activeId) return;
    if (entry.target === 'model.panel') tabs?.open(entry, activeId);
    else void runs?.start(entry, activeId);
  };
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (!platform || !registry || !editor) return;
    return syncExtensionCommands(registry, platform, editor, (entry) => startRef.current(entry));
  }, [platform, registry, editor]);

  // Closing a document cancels whatever extensions were doing with it, and closes its extension tabs.
  const known = useRef<ReadonlySet<string>>(new Set());
  const tabKey = openTabs.join('\u0000');
  useEffect(() => {
    const open = new Set(openTabs);
    for (const id of known.current) if (!open.has(id)) { platform?.closeDocument(id); tabs?.closeDocument(id); }
    known.current = open;
    // tabKey stands for openTabs.
  }, [platform, tabs, tabKey]);
  // Tabs of an extension that was turned off or uninstalled close.
  useEffect(() => {
    if (!platform || !tabs) return;
    const enabled = new Set(platform.extensions().map((e) => e.id));
    tabs.prune((t) => enabled.has(t.entry.extensionId));
  }, [platform, tabs, revision]);
  // The user switched to another document: its editor comes to the front.
  useEffect(() => { if (activeId) tabs?.documentActivated(activeId); }, [tabs, activeId]);

  // The open side panel, remembered per editor.
  const storageKey = editor ? `pushform:extensions:panel:${ownerId}:${editor}` : null;
  const restored = useRef(new Set<string>());
  const extension = sidePanel && isExtensionRailId(sidePanel) ? extensions.find((e) => extensionRailId(e.id) === sidePanel && extensionSidebars(e).length > 0) ?? null : null;
  useEffect(() => {
    if (!storageKey || !platform || restored.current.has(storageKey)) return;
    if (revision === 0) return; // what is installed has not been read yet
    restored.current.add(storageKey);
    const stored = readStorage(storageKey);
    if (stored && sidePanel === null && extensions.some((e) => e.id === stored && extensionSidebars(e).length > 0)) openPanel(extensionRailId(stored));
  }, [storageKey, platform, extensions, revision, sidePanel, openPanel]);
  useEffect(() => {
    if (!storageKey || !restored.current.has(storageKey)) return;
    writeStorage(storageKey, extension?.id ?? null);
  }, [storageKey, extension?.id]);

  const toggleRail = (id: `extension:${string}`): void => {
    const target = extensions.find((e) => e.id === railExtensionId(id));
    if (!target) return;
    if (extensionSidebars(target).length > 0) {
      if (sidePanel === id) closePanel(); else openPanel(id);
      return;
    }
    // Without a side panel, the icon opens the extension's tab directly.
    const [panel] = extensionPanels(target);
    if (panel && activeId) tabs?.open(panel, activeId);
  };

  const railItems = platform ? extensions.map((e): SideRailItem => ({
    id: extensionRailId(e.id), label: e.name,
    icon: <ExtensionIcon platform={platform} extensionId={e.id} icon={e.icon} size={24} alt={e.name} />,
  })) : [];
  const toolbarItems: ExtensionToolbarItem[] = platform ? buttons.map((entry) => ({
    id: entry.id, category: entry.category ?? 'inspect', title: entry.name, accessibleLabel: `${entry.name} — ${entry.extensionName} extension`,
    icon: <ExtensionIcon platform={platform} extensionId={entry.extensionId} icon={entry.icon} size={24} />,
    onPress: () => start(entry),
  })) : [];

  const activeTab = tabs?.activeTab ?? null;
  const tabDocument = (id: string): DocumentTab | null => (active && active.id === id ? active : null);
  const tabStrip: DocumentTabStrip | null = platform && tabs && active ? {
    items: tabs.tabs.map((t) => ({
      id: t.id, title: t.entry.name, extensionName: t.entry.extensionName,
      icon: <ExtensionIcon platform={platform} extensionId={t.entry.extensionId} icon={platform.state(t.entry.extensionId)?.record.manifest.icon} size={16} /> as ReactNode,
    })),
    activeId: tabs.activeId,
    onSelect: (id) => tabs.activate(id),
    onClose: (id) => tabs.close(id),
  } : null;

  return {
    railItems,
    toggleRail,
    shown: !!extension,
    panel: platform && extension && active
      ? <ExtensionSidebar key={`${extension.id}:${active.id}`} platform={platform} extension={extension} units={unitsFor(active)} documentId={active.id} onClose={closePanel} />
      : null,
    activity: runs && platform ? <ExtensionActivity runs={runs} platform={platform} /> : null,
    tabStrip,
    tabView: platform && activeTab && tabDocument(activeTab.documentId)
      ? <ExtensionTabView key={activeTab.id} platform={platform} tab={activeTab} units={unitsFor(tabDocument(activeTab.documentId)!)} />
      : null,
    toolbarItems,
  };
}

/** The units extension panels show quantities in: the model's own, or the closest to a Layout document's. */
export function unitsFor(tab: DocumentTab): UnitSettings {
  if (tab.type === 'model') return tab.app.document.doc.state.meta.units;
  switch (tab.doc.state.settings.units) {
    case 'mm': return { ...DEFAULT_UNITS, format: 'decimal', lengthUnit: 'mm', lengthPrecision: 1, areaUnit: 'm²', volumeUnit: 'm³' };
    case 'inch': return { ...DEFAULT_UNITS, format: 'decimal', lengthUnit: 'in', lengthPrecision: 3 };
    case 'architectural': return DEFAULT_UNITS;
  }
}

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key: string, value: string | null): void {
  try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* Storage may be blocked; the panel still works. */ }
}
