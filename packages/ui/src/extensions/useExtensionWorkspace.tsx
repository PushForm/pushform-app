// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useRef, useSyncExternalStore, type JSX } from 'react';
import { LuPuzzle } from 'react-icons/lu';
import { DEFAULT_UNITS, type UnitSettings } from '@pushform/core';
import type { ExtensionPlatform } from '@pushform/extensions';
import type { SideRailItem } from '../components/SideRail';
import type { DocumentTab } from '../session';
import { ExtensionActivity, type ExtensionRuns } from './ExtensionActivity';
import { ExtensionPanel } from './ExtensionPanel';
import { extensionPanelId, extensionPanels, isExtensionPanelId, syncExtensionCommands, type ExtensionEditor } from './extensionContributions';

/**
 * What enabled extensions add to the open editor: a side rail tab per panel that supports the editor, the panel shown
 * in the side dock, their commands in the document's registry (and so in command search and the context menu), and
 * the status of commands that are running. Which extension panel is open is remembered per account and editor.
 */
export function useExtensionWorkspace({ platform, runs, ownerId, active, openTabs, sidePanel, openPanel, closePanel }: {
  readonly platform: ExtensionPlatform | null;
  readonly runs: ExtensionRuns | null;
  readonly ownerId: string;
  /** The open document, or null on Home. */
  readonly active: DocumentTab | null;
  /** The ids of every open document. */
  readonly openTabs: readonly string[];
  readonly sidePanel: string | null;
  readonly openPanel: (id: `extension:${string}`) => void;
  readonly closePanel: () => void;
}): { railItems: SideRailItem[]; panel: JSX.Element | null; activity: JSX.Element | null; shown: boolean } {
  const revision = useSyncExternalStore((notify) => platform?.subscribe(notify) ?? (() => {}), () => platform?.revision ?? 0);
  const editor: ExtensionEditor | null = active ? (active.type === 'model' ? 'modeling' : 'layout') : null;
  // The revision says when installed or enabled extensions changed.
  const panels = useMemo(() => (platform && editor ? extensionPanels(platform, editor) : []), [platform, editor, revision]);

  // Commands and selection actions of the active document's editor.
  const activeId = active?.id ?? null;
  const registry = active ? (active.type === 'model' ? active.app.commands : active.commands) : null;
  useEffect(() => {
    if (!platform || !runs || !registry || !editor || !activeId) return;
    return syncExtensionCommands(registry, platform, editor, (entry) => { void runs.start(entry, activeId); });
  }, [platform, runs, registry, editor, activeId]);

  // Closing a document cancels whatever extensions were doing with it.
  const known = useRef<ReadonlySet<string>>(new Set());
  const tabKey = openTabs.join('\u0000');
  useEffect(() => {
    const open = new Set(openTabs);
    for (const id of known.current) if (!open.has(id)) platform?.closeDocument(id);
    known.current = open;
    // tabKey stands for openTabs.
  }, [platform, tabKey]);

  // The open extension panel, remembered per editor.
  const storageKey = editor ? `pushform:extensions:panel:${ownerId}:${editor}` : null;
  const restored = useRef(new Set<string>());
  const panel = sidePanel && isExtensionPanelId(sidePanel) ? panels.find((p) => extensionPanelId(p.id) === sidePanel) ?? null : null;
  useEffect(() => {
    if (!storageKey || !platform || restored.current.has(storageKey)) return;
    if (revision === 0) return; // what is installed has not been read yet
    restored.current.add(storageKey);
    const stored = readStorage(storageKey);
    if (stored && sidePanel === null && panels.some((p) => p.id === stored)) openPanel(extensionPanelId(stored));
  }, [storageKey, platform, panels, revision, sidePanel, openPanel]);
  useEffect(() => {
    if (!storageKey || !restored.current.has(storageKey)) return;
    writeStorage(storageKey, panel?.id ?? null);
  }, [storageKey, panel?.id]);

  const railItems = panels.map((p): SideRailItem => ({ id: extensionPanelId(p.id), label: `${p.name} (${p.extensionName})`, icon: <LuPuzzle aria-hidden="true" /> }));
  return {
    railItems,
    shown: !!panel,
    panel: platform && panel && active
      ? <ExtensionPanel key={`${panel.id}:${active.id}`} platform={platform} entry={panel} units={unitsFor(active)} documentId={active.id} onClose={closePanel} />
      : null,
    activity: runs ? <ExtensionActivity runs={runs} /> : null,
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
