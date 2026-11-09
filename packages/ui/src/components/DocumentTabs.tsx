// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { TbVector } from 'react-icons/tb';
import type { DocumentSession } from '../session';
import { displayDocumentName } from '../documentName';
import { allowOpeningDocument } from '../desktopUpdates';
import { Icon } from './Icon';

/**
 * Extension tabs shown after the document tabs: each is one extension panel, with the extension's icon, the panel's
 * name and a close button. While one is in front (`activeId`), no document tab is marked current.
 */
export interface DocumentTabStrip {
  readonly items: readonly { readonly id: string; readonly title: string; readonly extensionName: string; readonly icon: ReactNode }[];
  readonly activeId: string | null;
  /** Puts an extension tab in front, or, with null, the active document. */
  readonly onSelect: (id: string | null) => void;
  readonly onClose: (id: string) => void;
}

export function DocumentTabs({
  session,
  onClose,
  onNewLayout, extensionTabs, extraTab, activeExtra, onActivate,
}: {
  extraTab?: ReactNode; activeExtra?: boolean | undefined; onActivate?: (() => void) | undefined;
  session: DocumentSession;
  onClose?: (id: string) => void;
  onNewLayout: () => void;
  extensionTabs?: DocumentTabStrip | null | undefined;
}): JSX.Element {
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const cancelRename = useRef(false);
  const commitRename = (): void => {
    if (editing && !cancelRename.current) session.rename(editing.id, editing.name);
    setEditing(null);
  };
  return (
    <nav className="pf-document-tabs" aria-label="Open documents" data-tauri-drag-region>
      <NewDocumentButton onNewModel={() => { if (allowOpeningDocument()) session.newModel(); }} onNewLayout={onNewLayout} />
      {session.tabs.map((tab) => {
        const name = displayDocumentName(tab);
        const typeLabel = tab.type === 'model' ? '3D model' : '2D drawing';
        const current = !activeExtra && tab.id === session.activeId && !extensionTabs?.activeId;
        return (
          <div
            key={tab.id}
            className={`pf-document-tab${current ? ' is-active' : ''}`}
          >
            {editing?.id === tab.id ? <input
              className="pf-document-tab-rename"
              aria-label="Document name"
              autoFocus
              value={editing.name}
              onFocus={event => event.currentTarget.select()}
              onChange={event => setEditing({ id: tab.id, name: event.target.value })}
              onBlur={commitRename}
              onKeyDown={event => {
                event.stopPropagation();
                if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
                if (event.key === 'Escape') { cancelRename.current = true; setEditing(null); }
              }}
            /> : <button
              type="button"
              className="pf-document-tab-select"
              data-guidance-id={`tab:${tab.id}`}
              aria-label={`${typeLabel}: ${name}`}
              aria-current={current ? 'page' : undefined}
              onClick={() => { session.activate(tab.id); extensionTabs?.onSelect(null); onActivate?.(); }}
              onDoubleClick={() => { cancelRename.current = false; setEditing({ id: tab.id, name }); }}
            >
              {tab.type === 'model' ? (
                <Icon name="document-model" size={16} />
              ) : (
                <TbVector size={16} aria-hidden="true" />
              )}
              <span className="pf-document-tab-name">{name}</span>
              {session.isDirty(tab) ? <span className="pf-document-tab-dirty" aria-label="Unsaved changes">{'\u2022'}</span> : null}
            </button>}
            {session.tabs.length > 1 ? (
              <button
                type="button"
                className="pf-document-tab-close"
                aria-label={`Close ${name}`}
                onClick={() => {
                  if (onClose) onClose(tab.id);
                  else if (!session.isDirty(tab)) session.close(tab.id);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            ) : null}
          </div>
        );
      })}
      {extensionTabs?.items.map((tab) => {
        const current = !activeExtra && tab.id === extensionTabs.activeId;
        return (
          <div key={tab.id} className={`pf-document-tab pf-extension-tab${current ? ' is-active' : ''}`}>
            <button
              type="button"
              className="pf-document-tab-select"
              data-guidance-id={`tab:${tab.id}`}
              aria-label={`${tab.title}, from ${tab.extensionName}`}
              aria-current={current ? 'page' : undefined}
              onClick={() => { extensionTabs.onSelect(tab.id); onActivate?.(); }}
            >
              {tab.icon}
              <span className="pf-document-tab-name">{tab.title}</span>
            </button>
            <button type="button" className="pf-document-tab-close" aria-label={`Close ${tab.title}`} onClick={() => extensionTabs.onClose(tab.id)}><Icon name="close" size={12} /></button>
          </div>
        );
      })}
      {extraTab}
    </nav>
  );
}

/**
 * The tab bar's single + button. It opens a menu with a Model and a Layout entry, each
 * carrying its document-type icon. The menu is fixed-positioned under the button because the tab
 * strip scrolls horizontally and would clip an absolutely positioned dropdown.
 */
function NewDocumentButton({
  onNewModel,
  onNewLayout,
}: {
  onNewModel: () => void;
  onNewLayout: () => void;
}): JSX.Element {
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  const choose = (action: () => void): void => {
    setMenu(null);
    action();
  };

  return (
    <div ref={ref} className="pf-document-new-wrap">
      <button
        type="button"
        className="pf-document-new"
        aria-label="New document"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={(e) => {
          if (menu) {
            setMenu(null);
            return;
          }
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ left: rect.left, top: rect.bottom + 2 });
        }}
      >
        <Icon name="plus" size={16} />
      </button>
      {menu ? (
        <ul
          className="pf-menu pf-document-new-menu"
          role="menu"
          aria-label="New document"
          style={{ left: menu.left, top: menu.top }}
        >
          <li role="none">
            <button type="button" role="menuitem" className="pf-menu-item" onClick={() => choose(onNewModel)}>
              <Icon name="document-model" size={16} />
              <span>Model</span>
            </button>
          </li>
          <li role="none">
            <button type="button" role="menuitem" className="pf-menu-item" onClick={() => choose(onNewLayout)}>
              <TbVector size={16} aria-hidden="true" />
              <span>Layout</span>
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
