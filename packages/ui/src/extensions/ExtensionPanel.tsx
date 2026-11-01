// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { UnitSettings } from '@pushform/core';
import type { UiPresentation } from '@pushform/extension-protocol';
import type { ContributionEntry, ExtensionPlatform, ExtensionUiHost } from '@pushform/extensions';
import { Icon } from '../components/Icon';
import { ExtensionTarget } from './ExtensionTarget';
import { firstFocusable, trapTab } from './modalFocus';
import { INTEGRITY_TEXT } from './permissionText';

/**
 * An extension panel docked in the side panel area, or shown in a large window over the editor. PushForm draws its
 * frame in both places: the header names the panel and the extension and, for a side-loaded one, says it is unsigned,
 * so the extension's own content can never pass for PushForm's. Opening the panel runs its contribution, which starts
 * the extension if needed and mounts its interface; closing it, or switching documents, cancels that run and removes
 * the interface.
 *
 * The panel opens where the extension asked when it mounted its interface (docked unless it asked for a window). The
 * header moves it either way; once the user has moved it, that choice is remembered under `presentationKey` and the
 * extension's request no longer applies. While it is in the window, the dock keeps a short note with a button that
 * brings it back. Escape, or the window's own button, returns it to the dock.
 *
 * The interface is one live subtree wherever it is shown: moving the panel moves its rendered content between the
 * dock and the window rather than drawing it again, so typing in progress, open menus and other local state survive
 * the move. The window can be resized from its corner, and its size is remembered with the presentation choice.
 */
export function ExtensionPanel({ platform, entry, units, documentId, onClose, presentationKey }: {
  readonly platform: ExtensionPlatform;
  readonly entry: ContributionEntry;
  readonly units: UnitSettings;
  /** The document the panel acts on. */
  readonly documentId: string;
  readonly onClose: () => void;
  /** Where the user's choice of dock or window is remembered; without one it lasts while the panel is open. */
  readonly presentationKey?: string | undefined;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const revision = useSyncExternalStore((notify) => platform.subscribe(notify), () => platform.revision);
  // The revision says when the state changed.
  const state = useMemo(() => platform.state(entry.extensionId), [platform, entry.extensionId, revision]);
  // The interface host exists only while the extension runs; it changes after a restart.
  const host = state?.run === 'running' ? platform.ui(entry.extensionId) : null;
  const requested = useRequestedPresentation(host, entry.id);
  const [choice, setChoice] = useState<UiPresentation | null>(() => (presentationKey ? readPresentation(presentationKey) : null));
  const presentation = choice ?? requested ?? 'dock';
  const choose = useCallback((next: UiPresentation) => {
    setChoice(next);
    if (presentationKey) writePresentation(presentationKey, next);
  }, [presentationKey]);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    platform.invoke(entry.extensionId, entry.id, {}, { signal: controller.signal, userAction: true, scopes: [`panel:${entry.id}`], document: documentId })
      .catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => {
      controller.abort();
      platform.ui(entry.extensionId)?.close(entry.id);
    };
    // A restart (a new generation) runs the panel again.
  }, [platform, entry.extensionId, entry.id, documentId, state?.generation]);

  const failure = state?.run === 'failed' ? state.failure?.error.message ?? 'The extension stopped.' : error;
  const status = state?.run === 'starting' || !host ? 'Starting…' : 'Loading…';
  const content = failure ? <div className="pf-xpanel-failed">
      <p className="pf-xinstall-error" role="alert">{failure}</p>
      {state?.run === 'failed' && state.failure?.kind !== 'verification-failed' ? <button type="button" className="pf-btn" onClick={() => void platform.restart(entry.extensionId)}>Restart {entry.extensionName}</button> : null}
    </div>
    : host ? <ExtensionTarget host={host} target={entry.id} units={units} empty={<p className="pf-xpanel-status" role="status">{status}</p>} />
    : <p className="pf-xpanel-status" role="status">{status}</p>;
  const inWindow = presentation === 'window';
  // The content renders once, into this element, which the dock or the window adopts.
  const slot = useMemo(() => { const el = document.createElement('div'); el.className = 'pf-xpanel-content'; return el; }, []);
  return (
    <section className="pf-xpanel" aria-label={`${entry.name}, from ${entry.extensionName}`} data-extension={entry.extensionId}>
      <PanelHeader entry={entry}>
        {inWindow
          ? <button type="button" className="pf-iconbtn" aria-label={`Return ${entry.name} to the side panel`} title="Return to side panel" onClick={() => choose('dock')}>
              <Icon name="dock-side" size={16} />
            </button>
          : <button type="button" className="pf-iconbtn" aria-label={`Open ${entry.name} in a window`} title="Open in window" onClick={() => choose('window')}>
              <Icon name="open-window" size={16} />
            </button>}
        <button type="button" className="pf-iconbtn" aria-label={`Close ${entry.name}`} title="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </PanelHeader>
      <div className="pf-xpanel-body">
        {inWindow
          ? <div className="pf-xpanel-away">
              <p className="pf-xpanel-status">{entry.name} is open in a window.</p>
              <button type="button" className="pf-btn" onClick={() => choose('dock')}>Return to side panel</button>
            </div>
          : <ContentSlot content={slot} />}
      </div>
      {inWindow ? <ExtensionWindow entry={entry} sizeKey={presentationKey ? `${presentationKey}:size` : undefined} onReturn={() => choose('dock')}><ContentSlot content={slot} /></ExtensionWindow> : null}
      {createPortal(content, slot)}
    </section>
  );
}

/** Adopts the panel's content element: the dock's body or the window's body shows it, whichever is on screen. */
function ContentSlot({ content }: { content: HTMLElement }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { ref.current?.appendChild(content); }, [content]);
  return <div ref={ref} className="pf-xpanel-slot" />;
}

function PanelHeader({ entry, children }: { entry: ContributionEntry; children: ReactNode }): JSX.Element {
  return (
    <header className="pf-xpanel-head">
      <span className="pf-xpanel-icon" aria-hidden="true"><Icon name="extensions" size={14} /></span>
      <div className="pf-xpanel-title">
        <h2>{entry.name}</h2>
        <span className="pf-xpanel-source">{entry.extensionName}
          {entry.integrity === 'unsigned' ? <span className="pf-xpanel-unsigned"> · {INTEGRITY_TEXT.unsigned}</span> : null}</span>
      </div>
      {children}
    </header>
  );
}

/** The smallest window the user can resize to, in pixels. */
export const WINDOW_MIN_PX = { width: 360, height: 240 } as const;

/**
 * The large window an extension panel can be shown in: nearly the whole viewport, over the editor, with PushForm's
 * header. It is modal: focus starts inside it and Tab and Shift+Tab cycle through its controls, keys do not reach the editor's shortcuts, and
 * Escape (unless a field inside used it) returns the panel to the dock and focus to where it was. Its corner resizes
 * it; a size the user set is kept under `sizeKey` and used the next time, within the viewport.
 */
function ExtensionWindow({ entry, sizeKey, onReturn, children }: { entry: ContributionEntry; sizeKey?: string | undefined; onReturn: () => void; children: ReactNode }): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null);
  const [size] = useState(() => (sizeKey ? readSize(sizeKey) : null));
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (firstFocusable(dialog.current?.querySelector('.pf-xwindow-body')) ?? firstFocusable(dialog.current) ?? dialog.current)?.focus();
    return () => { if (previous?.isConnected && previous !== document.body) previous.focus(); };
  }, []);
  useEffect(() => {
    const element = dialog.current;
    if (!sizeKey || !element || typeof ResizeObserver === 'undefined') return;
    // The first measurement is the size given by the stylesheet or the stored size; only a change after it is the user's.
    let initial: { width: number; height: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      const measured = { width: Math.round(element.offsetWidth), height: Math.round(element.offsetHeight) };
      if (!initial) { initial = measured; return; }
      if (measured.width === initial.width && measured.height === initial.height) return;
      clearTimeout(timer);
      timer = setTimeout(() => writeSize(sizeKey, measured), 250);
    });
    observer.observe(element);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [sizeKey]);
  const keyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // The editor's shortcuts must not act on keys meant for the panel.
    e.stopPropagation();
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onReturn(); return; }
    // Tab moves through the window's controls in order and wraps, whatever the browser's own Tab order would skip.
    trapTab(e, dialog.current);
  };
  // Inside the app's root, so PushForm's own prompts (print, export) still show above it.
  const root = document.querySelector('.pf-app') ?? document.body;
  return createPortal(
    <div className="pf-xwindow-backdrop">
      <div ref={dialog} className="pf-xwindow" role="dialog" aria-modal="true" aria-label={`${entry.name}, from ${entry.extensionName}`} tabIndex={-1}
        data-extension={entry.extensionId} onKeyDown={keyDown} style={size ? { width: size.width, height: size.height } : undefined}>
        <PanelHeader entry={entry}>
          <button type="button" className="pf-btn pf-xwindow-return" onClick={onReturn}>
            <Icon name="dock-side" size={14} /> Return to side panel
          </button>
        </PanelHeader>
        <div className="pf-xwindow-body">{children}</div>
      </div>
    </div>,
    root,
  );
}

/** Where the extension asked for its panel to be shown, kept current as it mounts and updates it. */
function useRequestedPresentation(host: ExtensionUiHost | null, target: string): UiPresentation | undefined {
  return useSyncExternalStore(
    (notify) => host?.subscribe((changed) => { if (changed === target) notify(); }) ?? (() => {}),
    () => host?.get(target)?.presentation,
  );
}

function readPresentation(key: string): UiPresentation | null {
  try {
    const stored = localStorage.getItem(key);
    return stored === 'dock' || stored === 'window' ? stored : null;
  } catch { return null; }
}

function writePresentation(key: string, value: UiPresentation): void {
  try { localStorage.setItem(key, value); } catch { /* Storage may be blocked; the choice lasts while the panel is open. */ }
}

/** A window size the user set, if a sensible one is stored. */
export function readSize(key: string): { width: number; height: number } | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { width, height } = parsed as { width?: unknown; height?: unknown };
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { width: Math.max(WINDOW_MIN_PX.width, Math.round(width)), height: Math.max(WINDOW_MIN_PX.height, Math.round(height)) };
  } catch { return null; }
}

function writeSize(key: string, size: { width: number; height: number }): void {
  try { localStorage.setItem(key, JSON.stringify(size)); } catch { /* Storage may be blocked; the size lasts while the window is open. */ }
}
