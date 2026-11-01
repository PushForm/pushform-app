// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { UnitSettings } from '@pushform/core';
import type { UiPresentation } from '@pushform/extension-protocol';
import type { ContributionEntry, ExtensionPlatform, ExtensionUiHost } from '@pushform/extensions';
import { Icon } from '../components/Icon';
import { ExtensionTarget } from './ExtensionUi';
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
          : content}
      </div>
      {inWindow ? <ExtensionWindow entry={entry} onReturn={() => choose('dock')}>{content}</ExtensionWindow> : null}
    </section>
  );
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

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * The large window an extension panel can be shown in: nearly the whole viewport, over the editor, with PushForm's
 * header. It is modal: focus starts inside it and Tab and Shift+Tab cycle through its controls, keys do not reach the editor's shortcuts, and
 * Escape (unless a field inside used it) returns the panel to the dock and focus to where it was.
 */
function ExtensionWindow({ entry, onReturn, children }: { entry: ContributionEntry; onReturn: () => void; children: ReactNode }): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = (within: Element | null | undefined): HTMLElement | undefined =>
      [...(within?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find((el) => el.tabIndex >= 0);
    (first(dialog.current?.querySelector('.pf-xwindow-body')) ?? first(dialog.current) ?? dialog.current)?.focus();
    return () => { if (previous?.isConnected && previous !== document.body) previous.focus(); };
  }, []);
  const keyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // The editor's shortcuts must not act on keys meant for the panel.
    e.stopPropagation();
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onReturn(); return; }
    if (e.key !== 'Tab' || !dialog.current) return;
    // Tab moves through the window's controls in order and wraps, whatever the browser's own Tab order would skip.
    e.preventDefault();
    const controls = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((el) => el.tabIndex >= 0 && (el.getClientRects().length > 0 || el === document.activeElement));
    if (!controls.length) return;
    const at = controls.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (e.shiftKey ? controls.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + controls.length) % controls.length;
    controls[next]!.focus();
  };
  // Inside the app's root, so PushForm's own prompts (print, export) still show above it.
  const root = document.querySelector('.pf-app') ?? document.body;
  return createPortal(
    <div className="pf-xwindow-backdrop">
      <div ref={dialog} className="pf-xwindow" role="dialog" aria-modal="true" aria-label={`${entry.name}, from ${entry.extensionName}`} tabIndex={-1}
        data-extension={entry.extensionId} onKeyDown={keyDown}>
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
