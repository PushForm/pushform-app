// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useId, useRef, type JSX, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { UnitSettings } from '@pushform/core';
import type { UiEvent, UiNode } from '@pushform/extension-protocol';
import { Icon } from '../components/Icon';
import { ExtensionUiView } from './ExtensionUi';
import { firstFocusable, trapTab } from './modalFocus';

/**
 * A modal dialog an extension shows over its side panel, tab, inspector or settings block, drawn by PushForm: its
 * frame, title and Close button are the host's, and the body is the extension's tree rendered like the target's. It
 * sits above the editor and below PushForm's own prompts. Focus starts inside it, Tab and Shift+Tab cycle through its
 * controls, keys do not reach the editor, and Escape (unless a field inside used it) or the Close button closes it
 * and returns focus to where it was. Replacing the tree keeps the dialog and its focus in place.
 */
export function ExtensionDialog({ title, tree, units, onEvent, onClose }: {
  readonly title: string;
  readonly tree: UiNode;
  readonly units: UnitSettings;
  readonly onEvent: (event: UiEvent) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (firstFocusable(dialog.current?.querySelector('.pf-xdialog-body')) ?? firstFocusable(dialog.current) ?? dialog.current)?.focus();
    return () => { if (previous?.isConnected && previous !== document.body) previous.focus(); };
  }, []);
  const keyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // The editor's shortcuts must not act on keys meant for the dialog.
    e.stopPropagation();
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose(); return; }
    trapTab(e, dialog.current);
  };
  const root = document.querySelector('.pf-app') ?? document.body;
  return createPortal(
    <div className="pf-xdialog-backdrop">
      <div ref={dialog} className="pf-xdialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={keyDown}>
        <header className="pf-xdialog-head">
          <h2 id={titleId} className="pf-xdialog-title">{title}</h2>
          <button type="button" className="pf-iconbtn" aria-label="Close dialog" title="Close" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="pf-xdialog-body">
          <ExtensionUiView tree={tree} units={units} onEvent={onEvent} />
        </div>
      </div>
    </div>,
    root,
  );
}
