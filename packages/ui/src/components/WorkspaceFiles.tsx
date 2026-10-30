// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { CLOUD_PAGE_SIZE, type CloudFile, type CloudFilesApi, type CloudFolder, type CloudProject } from '@pushform/cloud';
import { LuArrowLeft, LuChevronRight, LuFolder, LuFolderPlus, LuPlus, LuRefreshCw } from 'react-icons/lu';
import { WorkspaceFileActions, type WorkspaceFileItem } from './WorkspaceFileActions';
import { useThumbnails } from '../useThumbnails';
import { Icon } from './Icon';
import { displayDocumentName } from '../documentName';

interface Location {
  project: CloudProject | null;
  folder: CloudFolder | null;
  search: string;
  page: number;
  scroll: number;
}
const root = (): Location => ({ project: null, folder: null, search: '', page: 0, scroll: 0 });
interface Listing { key: string; projects: CloudProject[]; folders: CloudFolder[]; files: CloudFile[]; error?: string }

/** The editor's project → root → folder navigation stack. */
export function WorkspaceFiles({ api, open, onOpen, onClose, onRenamed, onMoved, onForgetRecents }: {
  api: CloudFilesApi | undefined;
  open: boolean;
  onOpen: (file: CloudFile) => Promise<void>;
  onClose: () => void;
  onRenamed: (fileId: string, name: string) => void;
  onMoved: (fileId: string, projectId: string, folderId: string | null) => void;
  onForgetRecents: (ids: string[]) => void;
}): JSX.Element {
  const [stack, setStack] = useState<Location[]>([root()]);
  const location = stack.at(-1)!;
  const [refresh, setRefresh] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const alive = useRef(true), pending = useRef(false);
  const scroller = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const { project, folder, search, page } = location;
  const key = JSON.stringify([project?.id, folder?.id, search, page, refresh]);
  const current = listing?.key === key ? listing : null;
  const loading = !!api && !current;
  const title = folder?.name ?? project?.name ?? 'Projects';
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!open || !api) return;
    let active = true;
    const load = async (): Promise<void> => {
      try {
        let result: Listing;
        if (project) {
          const [folders, files] = await Promise.all([api.listFolders(project.id), api.listFiles(project.id, search, page * CLOUD_PAGE_SIZE, folder?.id ?? null)]);
          result = { key, projects: [], folders, files };
        } else result = { key, projects: await api.listProjects(), folders: [], files: [] };
        if (active) setListing(result);
      } catch (cause) { if (active) setListing({ key, projects: [], folders: [], files: [], error: (cause as Error).message }); }
    };
    void load();
    return () => { active = false; };
  }, [api, open, key, project?.id, folder?.id, search, page]);
  const previews = useThumbnails(current?.files ?? [], open);
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollTop = location.scroll; }, [key, loading]);
  useEffect(() => { if (open) heading.current?.focus(); }, [open, stack.length]);
  const update = (patch: Partial<Location>): void => setStack(items => [...items.slice(0, -1), { ...items.at(-1)!, ...patch }]);
  const push = (next: Location): void => {
    setError(null); setCreating(false);
    setStack(items => [...items.slice(0, -1), { ...items.at(-1)!, scroll: scroller.current?.scrollTop ?? 0 }, next]);
  };
  const back = (): void => {
    setError(null); setCreating(false);
    setStack(items => items.length > 1 ? items.slice(0, -1) : items);
  };
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await action(); }
    catch (cause) { if (alive.current) setError((cause as Error).message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const create = (): void => {
    if (!api || !name.trim()) return;
    void run(async () => {
      if (project) {
        await api.createFolder(project.id, folder?.id ?? null, name.trim());
        if (alive.current) { setCreating(false); setRefresh(value => value + 1); }
      } else {
        const created = await api.createProject(name.trim());
        if (alive.current) push({ ...root(), project: created });
      }
    });
  };
  const changed = (item: WorkspaceFileItem, change: { name?: string; projectId?: string; folderId?: string | null; trashed?: boolean }): void => {
    if (!alive.current) return;
    if (item.kind === 'document') {
      if (change.name) onRenamed(item.id, change.name);
      if (change.projectId) onMoved(item.id, change.projectId, change.folderId ?? null);
      if (change.trashed) onForgetRecents([item.id]);
    }
    setRefresh(value => value + 1);
  };
  const entry = (item: WorkspaceFileItem, children: ReactNode): JSX.Element => <WorkspaceFileActions key={item.id} api={api!} item={item} disabled={busy} onRun={run} onChanged={changed}>{children}</WorkspaceFileActions>;
  const folders = search ? [] : current?.folders.filter(item => item.parent_id === (folder?.id ?? null)) ?? [];
  const projects = current?.projects.filter(item => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  const files = current?.files ?? [];
  return <section className="pf-workspace-files" aria-label="Files" aria-busy={busy} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) { if (creating) setCreating(false); else onClose(); } }
    if (event.altKey && event.key === 'ArrowLeft' && !busy) { event.preventDefault(); back(); }
  }} onKeyUp={event => event.stopPropagation()} onCopy={event => event.stopPropagation()} onCut={event => event.stopPropagation()} onPaste={event => event.stopPropagation()}>
    <header className="pf-files-header">
      {stack.length > 1 ? <button type="button" className="pf-iconbtn" aria-label={`Back to ${stack.at(-2)!.folder?.name ?? stack.at(-2)!.project?.name ?? 'Projects'}`} disabled={busy} onClick={back}><LuArrowLeft /></button> : null}
      <div><small>Files{project ? ` · ${project.name}` : ''}</small><h2 ref={heading} tabIndex={-1}>{title}</h2></div>
      <button type="button" className="pf-iconbtn" aria-label="Refresh files" disabled={busy || !api} onClick={() => { setError(null); setRefresh(value => value + 1); }}><LuRefreshCw /></button>
    </header>
    {!api ? <p role="alert">Cloud files are unavailable for this installation.</p> : <>
      <div className="pf-files-tools">
        <input type="search" aria-label={project ? 'Search project files' : 'Search projects'} placeholder={project ? 'Search project files' : 'Search projects'} value={search} disabled={busy}
          onChange={event => { setError(null); update({ search: event.target.value, page: 0, scroll: 0 }); }} />
        <button type="button" disabled={busy} onClick={() => { setCreating(value => !value); setName(''); setError(null); }}>
          {project ? <LuFolderPlus /> : <LuPlus />}{project ? 'New folder' : 'New project'}
        </button>
      </div>
      {creating ? <form className="pf-files-form" onSubmit={event => { event.preventDefault(); create(); }}>
        <label>{project ? 'Folder name' : 'Project name'}<input autoFocus value={name} maxLength={100} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <div><button type="submit" disabled={busy || !name.trim()}>Create</button><button type="button" disabled={busy} onClick={() => setCreating(false)}>Cancel</button></div>
      </form> : null}
      {error || current?.error ? <div className="pf-files-error" role="alert">{error ?? current?.error}<button type="button" disabled={busy} onClick={() => { setError(null); setRefresh(value => value + 1); }}>Retry</button></div> : null}
      <div ref={scroller} className="pf-files-list" aria-label={project ? 'Files and folders' : 'Projects'}>
        {loading ? <p role="status">Loading {project ? 'files' : 'projects'}…</p> : <>
          {projects.map(item => entry({ kind: 'project', id: item.id, name: item.name, projectId: item.id, folderId: null }, <button className="pf-files-folder" type="button" key={item.id} disabled={busy} aria-label={`Open project ${item.name}`} onClick={() => push({ ...root(), project: item })}>
            <LuFolder /><span>{item.name}<small>Project</small></span><LuChevronRight />
          </button>))}
          {folders.map(item => entry({ kind: 'folder', id: item.id, name: item.name, projectId: item.project_id, folderId: item.parent_id }, <button className="pf-files-folder" type="button" key={item.id} disabled={busy} aria-label={`Open folder ${item.name}`} onClick={() => push({ ...root(), project, folder: item })}>
            <LuFolder /><span>{item.name}<small>Folder</small></span><LuChevronRight />
          </button>))}
          {files.map(file => entry({ kind: 'document', id: file.id, name: file.name, projectId: file.project_id, folderId: file.folder_id, fileKind: file.kind }, <button className="pf-files-document" type="button" key={file.id} disabled={busy} aria-label={`Open ${file.name}`} onClick={() => { void run(() => onOpen(file)); }}>
            <FilePreview file={file} url={previews.get(file.id)} />
            <span><strong>{displayDocumentName({ name: file.name, type: file.kind })}</strong><small>{file.is_template ? 'Layout template' : file.kind === 'model' ? 'Modeling' : 'Layout'}</small></span>
          </button>))}
          {!projects.length && !folders.length && !files.length && !current?.error ? <p className="pf-files-empty">{search ? 'No matches found.' : project ? 'This folder is empty.' : 'No projects yet. Create a project to get started.'}</p> : null}
        </>}
      </div>
      {project ? <footer className="pf-files-pagination">
        <button type="button" disabled={busy || page === 0} onClick={() => update({ page: page - 1, scroll: 0 })}>Previous</button><span>Page {page + 1}</span>
        <button type="button" disabled={busy || loading || files.length < CLOUD_PAGE_SIZE} onClick={() => update({ page: page + 1, scroll: 0 })}>Next</button>
      </footer> : null}
      {busy ? <p className="pf-files-status" role="status">Working…</p> : null}
    </>}
  </section>;
}

function FilePreview({ file, url }: { file: CloudFile; url: string | undefined }): JSX.Element {
  const [failed, setFailed] = useState<string>();
  return <span className="pf-files-preview">{url && failed !== url
    ? <img src={url} alt={`Preview of ${displayDocumentName({ name: file.name, type: file.kind })}`} loading="lazy" crossOrigin="anonymous" onError={() => setFailed(url)} />
    : <Icon name={file.is_template ? 'document-template' : file.kind === 'model' ? 'document-model' : 'document-layout'} />}</span>;
}
