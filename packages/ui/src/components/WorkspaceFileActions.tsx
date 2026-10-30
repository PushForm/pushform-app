// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { cloudFileName, type CloudFilesApi, type CloudFolder, type CloudItemKind, type CloudProject } from '@pushform/cloud';
import { displayDocumentName } from '../documentName';
import { folderTree } from './ImportDialog';

export interface WorkspaceFileItem {
  kind: CloudItemKind;
  id: string;
  name: string;
  projectId: string;
  folderId: string | null;
  fileKind?: 'model' | 'layout';
}

/** Existing cloud management operations, with inline forms that stay in the file panel. */
export function WorkspaceFileActions({ api, item, disabled, onRun, onChanged, children }: {
  api: CloudFilesApi;
  children: ReactNode;
  item: WorkspaceFileItem;
  disabled: boolean;
  onRun: (action: () => Promise<void>) => Promise<void>;
  onChanged: (item: WorkspaceFileItem, change: { name?: string; projectId?: string; folderId?: string | null; trashed?: boolean }) => void;
}): JSX.Element | null {
  const [mode, setMode] = useState<'rename' | 'move' | null>(null);
  const [name, setName] = useState('');
  const [project, setProject] = useState(item.projectId);
  const [folder, setFolder] = useState(item.folderId ?? '');
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [folders, setFolders] = useState<{ project: string; items: CloudFolder[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [projectsReady, setProjectsReady] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const entry = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null), form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (mode) (form.current?.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled)') ?? form.current)?.focus(); }, [mode]);
  const closeMenu = (): void => { setMenuAt(null); entry.current?.querySelector<HTMLButtonElement>(':scope > button')?.focus(); };
  useLayoutEffect(() => {
    if (!menuAt || !menu.current) return;
    const bounds = menu.current.getBoundingClientRect();
    menu.current.style.left = `${Math.max(4, Math.min(menuAt.x, window.innerWidth - bounds.width - 4))}px`;
    menu.current.style.top = `${Math.max(4, Math.min(menuAt.y, window.innerHeight - bounds.height - 4))}px`;
    menu.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [menuAt]);
  useEffect(() => {
    if (!menuAt) return;
    const outside = (event: PointerEvent): void => { if (!menu.current?.contains(event.target as Node)) setMenuAt(null); };
    const dismiss = (): void => setMenuAt(null);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', dismiss); window.removeEventListener('scroll', dismiss, true); };
  }, [menuAt]);
  const label = item.kind === 'document' ? displayDocumentName({ name: item.name, type: item.fileKind ?? 'model' }) : item.name;
  useEffect(() => {
    if (mode !== 'move') return;
    let current = true;
    setProjectsReady(false); setError(null);
    void api.listProjects().then(items => { if (current) { setProjects(items); setProjectsReady(true); } }, cause => { if (current) setError((cause as Error).message); });
    return () => { current = false; };
  }, [api, mode, retry]);
  useEffect(() => {
    if (mode !== 'move') return;
    let current = true;
    setFolders(null); setError(null);
    void api.listFolders(project).then(items => { if (current) setFolders({ project, items }); }, cause => { if (current) setError((cause as Error).message); });
    return () => { current = false; };
  }, [api, mode, project, retry]);
  const close = (): void => { setMode(null); closeMenu(); };
  const moveReady = projectsReady && folders?.project === project && !error;
  const descendants = new Set(item.kind === 'folder' ? [item.id] : []);
  // A folder cannot be moved into itself or one of its descendants.
  let added = true;
  while (added) {
    added = false;
    for (const candidate of folders?.items ?? []) if (candidate.parent_id && descendants.has(candidate.parent_id) && !descendants.has(candidate.id)) {
      descendants.add(candidate.id); added = true;
    }
  }
  const canManage = !!(api.rename || api.trash || api.moveFile || api.moveFolder);
  return <div ref={entry} className="pf-files-entry" onContextMenu={event => {
    if (event.target instanceof Element && event.target.closest('input, select, form')) return;
    event.preventDefault(); event.stopPropagation();
    if (!disabled && canManage) { setMode(null); setMenuAt({ x: event.clientX, y: event.clientY }); }
  }} onKeyDown={event => {
    if (!disabled && canManage && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) {
      event.preventDefault(); event.stopPropagation();
      const bounds = entry.current!.getBoundingClientRect();
      setMode(null); setMenuAt({ x: bounds.left + 12, y: bounds.top + 24 });
    } else if (event.key === 'Escape' && (mode || menuAt)) {
      event.preventDefault(); event.stopPropagation(); if (!disabled) close();
    }
  }}>
    {children}
    {menuAt ? <div ref={menu} className="pf-files-context-menu" role="menu" aria-label={`Actions for ${label}`} style={{ left: menuAt.x, top: menuAt.y }} onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
      {api.rename ? <button type="button" role="menuitem" disabled={disabled} onClick={() => { setMenuAt(null); setName(label); setMode('rename'); }}>Rename</button> : null}
      {(item.kind === 'document' && api.moveFile) || (item.kind === 'folder' && api.moveFolder) ? <button type="button" role="menuitem" disabled={disabled} onClick={() => {
        setMenuAt(null); setProject(item.projectId); setFolder(item.folderId ?? ''); setMode('move');
      }}>Move…</button> : null}
      {api.trash ? <button type="button" role="menuitem" disabled={disabled} onClick={() => { setMenuAt(null); void onRun(async () => {
        await api.trash!(item.kind, item.id); onChanged(item, { trashed: true }); close();
      }); }}>Move to Trash</button> : null}
    </div> : null}
    {mode ? <form ref={form} tabIndex={-1} className="pf-files-form" aria-label={`${mode === 'rename' ? 'Rename' : 'Move'} ${label}`} onSubmit={event => {
      event.preventDefault();
      void onRun(async () => {
        if (mode === 'rename') {
          const next = item.fileKind ? cloudFileName(name, item.fileKind) : name.trim();
          await api.rename!(item.kind, item.id, next); onChanged(item, { name: next });
        } else {
          if (!moveReady) return;
          if (item.kind === 'document') await api.moveFile!(item.id, project, folder || null);
          else await api.moveFolder!(item.id, folder || null);
          onChanged(item, { projectId: project, folderId: folder || null });
        }
        close();
      });
    }}>
      {mode === 'rename' ? <label>Name<input autoFocus value={name} maxLength={item.kind === 'document' ? 200 : 100} disabled={disabled} onChange={event => setName(event.target.value)} /></label> : <>
        {item.kind === 'document' ? <label>Project<select aria-label="Project" value={project} disabled={disabled || !projectsReady} onChange={event => { setProject(event.target.value); setFolder(''); }}>
          {projects.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}
        </select></label> : null}
        <label>Folder<select aria-label="Folder" value={folder} disabled={disabled || !moveReady} onChange={event => setFolder(event.target.value)}>
          <option value="">Project root</option>{folderTree((folders?.items ?? []).filter(value => !descendants.has(value.id))).map(({ folder: value, depth }) => <option key={value.id} value={value.id}>{'— '.repeat(depth)}{value.name}</option>)}
        </select></label>
        {error ? <p role="alert">{error} <button type="button" disabled={disabled} onClick={() => setRetry(value => value + 1)}>Retry destinations</button></p> : !moveReady ? <p role="status">Loading destinations…</p> : null}
      </>}
      <div><button type="submit" disabled={disabled || (mode === 'rename' ? !name.trim() : !moveReady)}>{mode === 'rename' ? 'Save name' : 'Move here'}</button><button type="button" disabled={disabled} onClick={close}>Cancel</button></div>
    </form> : null}
  </div>;
}
