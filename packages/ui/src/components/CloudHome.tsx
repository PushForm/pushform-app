// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import { CLOUD_PAGE_SIZE, cloudFileName, type CloudFile, type CloudFilesApi, type CloudFolder, type CloudItemKind, type CloudProject, type CloudSession, type CloudTrashItem } from '@pushform/cloud';
import { LuArrowRight, LuChevronRight, LuClock3, LuEllipsis, LuFolder, LuFolderInput, LuFolderPlus, LuGrid2X2, LuList, LuPencil, LuPlus, LuRefreshCw, LuSearch, LuShieldCheck, LuTrash2, LuUndo2 } from 'react-icons/lu';
import { RiChatAiLine } from 'react-icons/ri';
import { useThumbnails } from '../useThumbnails';
import { AccountControl } from './AccountControl';
import { Icon } from './Icon';
import { ImportDialog, folderTree } from './ImportDialog';
import { displayDocumentName } from '../documentName';
import type { BuildInfo } from '../buildInfo';
import type { DocumentTab } from '../session';

export function CloudHome({ api, cloud, recents, openTabs, ownerId, buildInfo, onResume, onOpen, onCreate, onRequests, requestsOpen = false, onForgetRecents, onRenamed, onMoved, onExtensions }: {
  api: CloudFilesApi | undefined; cloud: CloudSession | undefined; recents: CloudFile[];
  openTabs: readonly DocumentTab[]; onResume: (tab: DocumentTab) => void;
  /** The signed-in account, which scopes the remembered import destination. */
  ownerId?: string | undefined; buildInfo?: BuildInfo | undefined;
  onOpen: (file: CloudFile) => Promise<void>;
  onCreate: (kind: 'model' | 'layout', name: string, projectId?: string, folderId?: string | null) => Promise<void>;
  /** Toggles the AI Chat pop-down under the header icon. */
  onRequests?: ((anchor: HTMLElement | null) => void) | undefined;
  requestsOpen?: boolean | undefined;
  /** Recently opened entries to drop: files gone or in the Trash. */
  onForgetRecents?: ((ids: string[]) => void) | undefined;
  /** A file renamed or moved from Home, so an open editor follows it. */
  onRenamed?: ((fileId: string, name: string) => void) | undefined;
  onMoved?: ((fileId: string, projectId: string, folderId: string | null) => void) | undefined;
  /** Opens the extension manager from the account dialog. */
  onExtensions?: (() => void) | undefined;
}): JSX.Element {
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [scope, setScope] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [listing, setListing] = useState<{ key: string; files: CloudFile[] }>({ key: '', files: [] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<'model' | 'layout' | 'project' | null>(null);
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [createMenu, setCreateMenu] = useState(false);
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folders, setFolders] = useState<{ project: string; items: CloudFolder[] }>({ project: '', items: [] });
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // Row actions and the Trash.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ kind: CloudItemKind; id: string; name: string } | null>(null);
  const [moving, setMoving] = useState<{ kind: CloudItemKind; id: string; project: string; folder: string | null } | null>(null);
  const [trashItems, setTrashItems] = useState<{ key: string; items: CloudTrashItem[] } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const forget = useRef(onForgetRecents); forget.current = onForgetRecents;
  const pending = useRef(false), alive = useRef(true), nameInput = useRef<HTMLInputElement>(null);
  const createBox = useRef<HTMLDivElement>(null), requestsButton = useRef<HTMLButtonElement>(null);
  const savedKey = recents.map(file => `${file.id}:${file.revision_number}:${file.updated_at}`).join('|');
  const recent = scope === '@recent', inTrash = scope === '@trash';
  const project = projects.find(item => item.id === scope);
  const tree = project && folders.project === project.id ? folderTree(folders.items) : [];
  const currentFolder = project && folderId && tree.some(item => item.folder.id === folderId) ? folderId : null;
  const crumbs = ((): CloudFolder[] => {
    const out: CloudFolder[] = []; let id: string | null = currentFolder;
    while (id) { const found = folders.items.find(item => item.id === id); if (!found) break; out.unshift(found); id = found.parent_id; }
    return out;
  })();
  const subfolders = project && !search.trim() ? tree.filter(item => item.folder.parent_id === currentFolder).map(item => item.folder) : [];
  const key = `${scope}:${search}:${page}:${refresh}:${savedKey}:${project ? currentFolder ?? 'root' : ''}`;
  const files = recent ? recents.filter(file => file.name.toLowerCase().includes(search.trim().toLowerCase())) : listing.key === key ? listing.files : [];
  const loading = !!api && !recent && !inTrash && listing.key !== key;
  const title = recent ? 'Recently opened' : inTrash ? 'Trash' : projects.find(project => project.id === scope)?.name ?? 'Owned by me';
  const date = (value: string): string => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const itemName = (kind: CloudItemKind, name: string): string => kind === 'document' ? name.replace(/\.(pf|pfl)$/i, '') : name;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const thumbnails = useThumbnails(files, view === 'grid');
  const thumbnail = (id: string): string | undefined => thumbnails.get(id);
  useEffect(() => {
    if (!api?.listTrash || !inTrash) return;
    let current = true;
    const trashKey = String(refresh);
    void api.listTrash().then(items => { if (current && alive.current) setTrashItems({ key: trashKey, items }); })
      .catch(cause => { if (current && alive.current) { setError((cause as Error).message); setTrashItems({ key: trashKey, items: [] }); } });
    return () => { current = false; };
  }, [api, inTrash, refresh]);
  // Recently opened drops files that are gone or in the Trash, here or in another browser.
  const recentIds = recents.map(file => file.id).join('|');
  useEffect(() => {
    if (!api?.trashedFiles || !recentIds) return;
    let current = true;
    void api.trashedFiles(recentIds.split('|')).then(gone => { if (current && alive.current && gone.size) forget.current?.([...gone]); }).catch(() => {});
    return () => { current = false; };
  }, [api, recentIds, refresh]);
  useEffect(() => {
    if (!api) return;
    let current = true;
    void api.listProjects().then(items => { if (current) setProjects(items); })
      .catch(cause => { if (current) setError((cause as Error).message); });
    return () => { current = false; };
  }, [api, refresh, savedKey]);
  useEffect(() => {
    if (!api || recent || inTrash) return;
    let current = true;
    const request = project ? api.listFiles(scope, search, page * CLOUD_PAGE_SIZE, currentFolder) : api.listFiles(scope, search, page * CLOUD_PAGE_SIZE);
    void request.then(items => {
      if (current) setListing({ key, files: items });
    }).catch(cause => { if (current) { setError((cause as Error).message); setListing({ key, files: [] }); } });
    return () => { current = false; };
  }, [api, scope, search, page, key, recent, inTrash, project, currentFolder]);
  useEffect(() => {
    if (!api || !project) return;
    let current = true;
    void api.listFolders(project.id).then(items => { if (current) setFolders({ project: project.id, items }); })
      .catch(cause => { if (current) setError((cause as Error).message); });
    return () => { current = false; };
  }, [api, project, refresh]);
  useEffect(() => { if (creating) nameInput.current?.focus(); }, [creating]);
  useEffect(() => {
    if (!createMenu) return;
    const box = createBox.current;
    box?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent): void => { if (!box?.contains(event.target as Node)) setCreateMenu(false); };
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); setCreateMenu(false); box?.querySelector<HTMLElement>('button')?.focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const items = [...box!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
        const index = items.indexOf(document.activeElement as HTMLElement);
        items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener('pointerdown', outside); window.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', keydown); };
  }, [createMenu]);
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await action(); } catch (cause) { if (alive.current) setError((cause as Error).message); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const choose = (value: string, folder: string | null = null): void => {
    setScope(value); setFolderId(folder); setPage(0); setError(null); setCreating(null); setNewFolder(null);
    setRenaming(null); setMoving(null); setMenuFor(null); setConfirmDelete(null);
  };
  const [destinationFolder, setDestinationFolder] = useState<string | null>(null);
  const [destinationFolders, setDestinationFolders] = useState<{ project: string; items: CloudFolder[] }>({ project: '', items: [] });
  const destinationProject = destination || projects.find(item => item.name.toLowerCase() === 'documents')?.id || '';
  // The folders of the project a new document or a moved item goes to.
  const wantedProject = creating && creating !== 'project' ? destinationProject : moving?.project ?? '';
  useEffect(() => {
    if (!api || !wantedProject) return;
    if (wantedProject === folders.project) { setDestinationFolders(folders); return; }
    let current = true;
    void api.listFolders(wantedProject).then(items => { if (current) setDestinationFolders({ project: wantedProject, items }); })
      .catch(cause => { if (current) setError((cause as Error).message); });
    return () => { current = false; };
  }, [api, wantedProject, folders]);
  const destinationTree = destinationFolders.project === wantedProject ? folderTree(destinationFolders.items) : [];
  // A folder cannot move into itself or one of its own folders.
  const under = (folder: CloudFolder, ancestor: string): boolean => {
    for (let id: string | null = folder.id; id;) { if (id === ancestor) return true; id = destinationFolders.items.find(item => item.id === id)?.parent_id ?? null; }
    return false;
  };
  const moveTree = moving?.kind === 'folder' ? destinationTree.filter(item => !under(item.folder, moving.id)) : destinationTree;
  const startCreate = (kind: NonNullable<typeof creating>): void => {
    setCreateMenu(false); setCreating(kind); setName(kind === 'project' ? '' : kind === 'model' ? 'Untitled model' : 'Untitled drawing');
    setDestination(projects.some(project => project.id === scope && project.name.toLowerCase() !== 'documents') ? scope : '');
    setDestinationFolder(project ? currentFolder : null); setError(null);
  };
  const createFolder = (event: FormEvent): void => {
    event.preventDefault(); if (!api || !project || newFolder === null) return;
    const name = newFolder;
    void run(async () => {
      const folder = await api.createFolder(project.id, currentFolder, name);
      if (alive.current) { setFolders(current => ({ project: project.id, items: [...current.items, folder] })); setNewFolder(null); }
    });
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault(); if (!creating || !api) return;
    void run(async () => {
      if (creating === 'project') {
        const project = await api.createProject(name);
        if (alive.current) { setProjects(items => [...items, project]); choose(project.id); }
      } else {
        const fileName = cloudFileName(name, creating);
        const folder = destinationFolder && destinationTree.some(item => item.folder.id === destinationFolder) ? destinationFolder : null;
        await onCreate(creating, fileName, destination || undefined, folder);
        if (alive.current) setCreating(null);
      }
    });
  };
  const open = (file: CloudFile): void => { void run(() => onOpen(file)); };
  const startImport = (): void => { setCreateMenu(false); setCreating(null); setError(null); setImporting(true); };
  const startRename = (kind: CloudItemKind, id: string, current: string): void => { setMenuFor(null); setMoving(null); setError(null); setRenaming({ kind, id, name: itemName(kind, current) }); };
  const startMove = (kind: CloudItemKind, id: string, projectId: string, folder: string | null): void => { setMenuFor(null); setRenaming(null); setError(null); setMoving({ kind, id, project: projectId, folder }); };
  const submitRename = (event: FormEvent): void => {
    event.preventDefault(); if (!api?.rename || !renaming) return;
    const { kind, id } = renaming;
    const fileKind = kind === 'document' ? [...files, ...recents].find(file => file.id === id)?.kind ?? 'model' : 'model';
    void run(async () => {
      const name = kind === 'document' ? cloudFileName(renaming.name, fileKind) : renaming.name.trim();
      await api.rename!(kind, id, name);
      if (!alive.current) return;
      setRenaming(null); setRefresh(value => value + 1);
      if (kind === 'document') onRenamed?.(id, name);
      if (kind === 'project') setProjects(items => items.map(item => item.id === id ? { ...item, name } : item));
    });
  };
  const submitMove = (event: FormEvent): void => {
    event.preventDefault(); if (!api || !moving) return;
    const { kind, id, project: target, folder } = moving;
    void run(async () => {
      if (kind === 'document') { await api.moveFile!(id, target, folder); onMoved?.(id, target, folder); }
      else await api.moveFolder!(id, folder);
      if (!alive.current) return;
      setMoving(null); setRefresh(value => value + 1);
    });
  };
  const trashItem = (kind: CloudItemKind, id: string): void => {
    setMenuFor(null); setRenaming(null); setMoving(null);
    void run(async () => {
      await api!.trash!(kind, id);
      if (!alive.current) return;
      if (kind === 'document') onForgetRecents?.([id]);
      if (kind === 'project') { setProjects(items => items.filter(item => item.id !== id)); if (scope === id) choose(''); }
      setRefresh(value => value + 1);
    });
  };
  const restoreItem = (item: CloudTrashItem): void => { void run(async () => { await api!.restore!(item.kind, item.id); if (alive.current) setRefresh(value => value + 1); }); };
  const deleteItem = (item: CloudTrashItem): void => { setConfirmDelete(null); void run(async () => { await api!.deleteForever!(item.kind, item.id); if (alive.current) setRefresh(value => value + 1); }); };
  /** The row menu of a file or folder: Rename, Move…, Move to Trash. */
  const actions = (kind: 'document' | 'folder', id: string, current: string, projectId: string, folder: string | null): JSX.Element | null => {
    if (!api?.rename) return null;
    const menuKey = `${kind}:${id}`, label = itemName(kind, current);
    return <div className="pf-home-actions">
      <button type="button" aria-label={`Actions for ${label}`} aria-haspopup="menu" aria-expanded={menuFor === menuKey} disabled={busy}
        onClick={() => setMenuFor(value => value === menuKey ? null : menuKey)}><LuEllipsis aria-hidden="true" /></button>
      {menuFor === menuKey ? <div className="pf-home-actions-menu" role="menu">
        <button type="button" role="menuitem" onClick={() => startRename(kind, id, current)}>Rename</button>
        <button type="button" role="menuitem" onClick={() => startMove(kind, id, projectId, folder)}>Move…</button>
        <button type="button" role="menuitem" onClick={() => trashItem(kind, id)}>Move to Trash</button>
      </div> : null}
    </div>;
  };
  return <div className="pf-app pf-home">
    <header className="pf-home-header">
      <button className="pf-home-brand" type="button" aria-label="PushForm home" onClick={() => choose('')}>
        <img src="/pf-logo-mark.svg" alt="" width={28} height={28} /><span>PushForm</span>
      </button>
      <label className="pf-home-search"><LuSearch aria-hidden="true" /><input type="search" aria-label="Search cloud files"
        placeholder="Search your documents" value={search} onChange={event => { setSearch(event.target.value); setPage(0); setError(null); }} /></label>
      <div className="pf-home-header-actions">
        {onRequests ? <button ref={requestsButton} type="button" className="pf-home-requests-button" aria-label="AI Chat" title="AI Chat"
          aria-haspopup="dialog" aria-expanded={requestsOpen} onClick={() => onRequests(requestsButton.current)}><RiChatAiLine aria-hidden="true" /></button> : null}
        <AccountControl cloud={cloud} onExtensions={onExtensions} />
      </div>
    </header>
    <div className="pf-home-body">
      <aside className="pf-home-sidebar" aria-label="Library navigation">
        <div className="pf-home-create" ref={createBox}>
          <button className="pf-home-primary" type="button" disabled={!api || busy} aria-haspopup="menu" aria-expanded={createMenu} onClick={() => setCreateMenu(value => !value)}><LuPlus /> Create <span>⌄</span></button>
          {createMenu ? <div className="pf-home-create-menu" role="menu" onKeyDown={event => { if (event.key === 'Escape') setCreateMenu(false); }}>
            <button type="button" role="menuitem" onClick={() => startCreate('model')}>New model</button>
            <button type="button" role="menuitem" onClick={() => startCreate('layout')}>New drawing</button>
            <button type="button" role="menuitem" onClick={() => startCreate('project')}>New project</button>
            <button type="button" role="menuitem" onClick={startImport}>Import files…</button>
          </div> : null}
        </div>
        <nav>
          <button type="button" aria-current={scope === '' ? 'page' : undefined} onClick={() => choose('')}><Icon name="account" /> Owned by me</button>
          <button type="button" aria-current={recent ? 'page' : undefined} onClick={() => choose('@recent')}><LuClock3 /> Recently opened</button>
          {api?.listTrash ? <button type="button" aria-current={inTrash ? 'page' : undefined} onClick={() => choose('@trash')}><LuTrash2 /> Trash</button> : null}
        </nav>
        <div className="pf-home-project-heading"><span>PROJECTS</span><button type="button" aria-label="New project" disabled={!api || busy} onClick={() => startCreate('project')}><LuPlus /></button></div>
        <nav className="pf-home-project-nav" aria-label="Projects">{projects.map(project => <button key={project.id} type="button" aria-current={scope === project.id ? 'page' : undefined} onClick={() => choose(project.id)}><LuFolder /><span>{project.name}</span></button>)}</nav>
        <div className="pf-home-private"><LuShieldCheck /><div><strong>Your private workspace</strong><p>Only you can access your files.</p></div></div>
      </aside>
      <main className="pf-home-main" aria-label="Cloud document library" aria-busy={busy}>
        <div className="pf-home-title"><div><p className="pf-home-eyebrow">YOUR WORKSPACE</p><h1>{title}</h1></div>
          <div className="pf-home-title-actions">
            {project && api?.rename ? <>
              <button type="button" disabled={busy} onClick={() => startRename('project', project.id, project.name)}><LuPencil /> Rename project</button>
              <button type="button" disabled={busy} onClick={() => trashItem('project', project.id)}><LuTrash2 /> Move project to Trash</button>
            </> : null}
            <button type="button" className="pf-home-refresh" disabled={!api || busy} onClick={() => { setError(null); setRefresh(value => value + 1); }}><LuRefreshCw /> Refresh</button>
          </div></div>
        {!api ? <p className="pf-home-error" role="alert">Cloud storage is unavailable for this installation. Please contact the administrator.</p> : null}
        {error ? <p className="pf-home-error" role="alert">{error} <button type="button" onClick={() => { setError(null); setRefresh(value => value + 1); }}>Try again</button></p> : null}
        {creating ? <form className="pf-home-new" onSubmit={submit} aria-label={creating === 'project' ? 'Create project' : 'Create document'}>
          <div><h2>{creating === 'project' ? 'New project' : creating === 'model' ? 'New model' : 'New drawing'}</h2><p>{creating === 'project' ? 'Keep related documents together.' : 'Your work will save automatically to your private cloud library.'}</p></div>
          <label>{creating === 'project' ? 'Project name' : 'Document name'}<input ref={nameInput} value={name} maxLength={creating === 'project' ? 100 : 200} disabled={busy} onChange={event => setName(event.target.value)} required /></label>
          {creating !== 'project' ? <label>Project<select value={destination} disabled={busy} onChange={event => { setDestination(event.target.value); setDestinationFolder(null); }}><option value="">Documents</option>{projects.filter(project => project.name.toLowerCase() !== 'documents').map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label> : null}
          {creating !== 'project' ? <label>Folder<select value={destinationFolder ?? ''} disabled={busy} onChange={event => setDestinationFolder(event.target.value || null)}><option value="">Project root</option>{destinationTree.map(item => <option value={item.folder.id} key={item.folder.id}>{`${'\u00a0\u00a0'.repeat(item.depth)}${item.folder.name}`}</option>)}</select></label> : null}
          <div className="pf-home-new-actions"><button type="button" disabled={busy} onClick={() => setCreating(null)}>Cancel</button><button type="submit" className="pf-home-primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : creating === 'project' ? 'Create project' : 'Create document'}</button></div>
        </form> : null}
        {renaming ? <form className="pf-home-inline-form" aria-label="Rename" onSubmit={submitRename}>
          <label>New name <input aria-label="New name" value={renaming.name} maxLength={renaming.kind === 'document' ? 200 : 100} disabled={busy} autoFocus onChange={event => setRenaming({ ...renaming, name: event.target.value })} /></label>
          <button type="submit" className="pf-home-primary" disabled={busy || !renaming.name.trim()}>Rename</button>
          <button type="button" disabled={busy} onClick={() => setRenaming(null)}>Cancel</button></form> : null}
        {moving ? <form className="pf-home-inline-form" aria-label="Move" onSubmit={submitMove}>
          {moving.kind === 'document' ? <label>Project <select aria-label="Destination project" value={moving.project} disabled={busy} onChange={event => setMoving({ ...moving, project: event.target.value, folder: null })}>{projects.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label> : null}
          <label>Folder <select aria-label="Destination folder" value={moving.folder ?? ''} disabled={busy} onChange={event => setMoving({ ...moving, folder: event.target.value || null })}><option value="">Project root</option>{moveTree.map(item => <option value={item.folder.id} key={item.folder.id}>{`${'  '.repeat(item.depth)}${item.folder.name}`}</option>)}</select></label>
          <button type="submit" className="pf-home-primary" disabled={busy}>Move</button>
          <button type="button" disabled={busy} onClick={() => setMoving(null)}>Cancel</button></form> : null}
        {!creating && !search && !recent && !scope ? <section className="pf-home-welcome" aria-label="Welcome to PushForm">
          <div><p className="pf-home-eyebrow">A PLACE FOR YOUR IDEAS</p><h2>Welcome to PushForm</h2><p>Start with a model. Bring it together in a drawing.<br />Your changes save automatically as you work.</p></div>
          <button type="button" className="pf-home-start" aria-label="Create a model" disabled={!api || busy} onClick={() => startCreate('model')}><span className="pf-home-start-icon"><Icon name="document-model" size={42} /></span><span><strong>Create a model</strong><small>Shape your next idea in 3D</small></span><LuArrowRight /></button>
          <button type="button" className="pf-home-start" aria-label="Create a drawing" disabled={!api || busy} onClick={() => startCreate('layout')}><span className="pf-home-start-icon is-layout"><Icon name="document-layout" size={42} /></span><span><strong>Create a drawing</strong><small>Plan, document and present</small></span><LuArrowRight /></button>
          <button type="button" className="pf-home-start" aria-label="Import files" disabled={!api || busy} onClick={startImport}><span className="pf-home-start-icon is-import"><LuFolderInput size={38} /></span><span><strong>Import files</strong><small>SketchUp models and LayOut drawings</small></span><LuArrowRight /></button>
        </section> : null}
        {openTabs.length ? <section className="pf-home-open"><h2>Continue working</h2><div>{openTabs.map(tab => <button type="button" key={tab.id} aria-label={`Continue ${displayDocumentName(tab)}`} disabled={busy} onClick={() => onResume(tab)}><Icon name={tab.type === 'model' ? 'document-model' : 'document-layout'} /><span>{displayDocumentName(tab)}</span><LuArrowRight /></button>)}</div></section> : null}
        {!search && !scope && recents.length ? <section className="pf-home-recents"><h2><LuClock3 /> Last opened by me</h2><div>{recents.slice(0, 3).map(file => <button key={file.id} type="button" aria-label={`Open recent ${file.name}`} disabled={busy} onClick={() => open(file)}><span className={`pf-home-file-art ${file.is_template ? 'template' : file.kind}`}><Icon name={file.is_template ? 'document-template' : file.kind === 'model' ? 'document-model' : 'document-layout'} size={28} /></span><span>{file.name.replace(/\.(pf|pfl)$/i, '')}{file.is_template ? <small>Layout template</small> : null}</span></button>)}</div></section> : null}
        <section className="pf-home-library" aria-label="Cloud files">
          {project ? <nav className="pf-home-crumbs" aria-label="Folder path">
            <button type="button" aria-current={!currentFolder ? 'page' : undefined} disabled={busy} onClick={() => choose(project.id)}>{project.name}</button>
            {crumbs.map(folder => <span key={folder.id}><LuChevronRight aria-hidden="true" /><button type="button" aria-current={folder.id === currentFolder ? 'page' : undefined} disabled={busy} onClick={() => choose(project.id, folder.id)}>{folder.name}</button></span>)}
            {newFolder === null ? <button type="button" className="pf-home-new-folder" disabled={!api || busy} onClick={() => { setNewFolder(''); setError(null); }}><LuFolderPlus /> New folder</button>
              : <form className="pf-home-new-folder-form" aria-label="New folder" onSubmit={createFolder}>
                <input aria-label="Folder name" value={newFolder} maxLength={100} disabled={busy} autoFocus onChange={event => setNewFolder(event.target.value)} />
                <button type="submit" className="pf-home-primary" disabled={busy || !newFolder.trim()}>Create</button>
                <button type="button" disabled={busy} onClick={() => setNewFolder(null)}>Cancel</button></form>}
          </nav> : null}
          <div className="pf-home-list-heading"><h2>{recent ? 'Recently opened in this browser' : inTrash ? 'In the Trash' : 'Documents'}</h2>{!inTrash ? <div className="pf-home-view" aria-label="File view"><button type="button" aria-label="List view" aria-pressed={view === 'list'} onClick={() => setView('list')}><LuList /></button><button type="button" aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => setView('grid')}><LuGrid2X2 /></button></div> : null}</div>
          {inTrash ? (trashItems?.key !== String(refresh) ? <p className="pf-home-empty" role="status">Loading the Trash…</p> : trashItems.items.length ?
            <div className="pf-home-table-wrap"><table><thead><tr><th>Name</th><th>Was in</th><th>Trashed</th><th>Deleted after</th><th></th></tr></thead><tbody>{trashItems.items.map(item => <tr key={`${item.kind}:${item.id}`}>
              <td><span className={`pf-home-file-art ${item.kind === 'document' ? (item.is_template ? 'template' : item.document_kind ?? 'model') : 'folder'}`}>{item.kind === 'document' ? <Icon name={item.is_template ? 'document-template' : item.document_kind === 'layout' ? 'document-layout' : 'document-model'} size={24} /> : <LuFolder size={22} />}</span><span><strong>{itemName(item.kind, item.name)}</strong><small>{item.kind === 'project' ? 'Project' : item.kind === 'folder' ? 'Folder' : item.is_template ? 'Layout template' : item.document_kind === 'layout' ? 'Drawing' : '3D model'}</small></span></td>
              <td>{item.kind === 'project' ? '—' : item.project_name}</td><td>{date(item.trashed_at)}</td><td>{date(item.purge_after)}</td>
              <td>{confirmDelete === item.id ? <span className="pf-home-inline-form"><span>Delete permanently? This cannot be undone.</span><button type="button" className="pf-home-danger" aria-label={`Confirm deleting ${itemName(item.kind, item.name)}`} disabled={busy} onClick={() => deleteItem(item)}>Delete</button><button type="button" disabled={busy} onClick={() => setConfirmDelete(null)}>Cancel</button></span>
                : <span className="pf-home-inline-form"><button type="button" aria-label={`Restore ${itemName(item.kind, item.name)}`} disabled={busy} onClick={() => restoreItem(item)}><LuUndo2 /> Restore</button><button type="button" className="pf-home-danger" aria-label={`Delete ${itemName(item.kind, item.name)} permanently`} disabled={busy} onClick={() => setConfirmDelete(item.id)}>Delete permanently</button></span>}</td>
            </tr>)}</tbody></table></div>
            : <div className="pf-home-empty"><LuTrash2 size={36} /><h3>The Trash is empty</h3><p>Items you move to the Trash stay here for 30 days, then they are deleted.</p></div>)
          : loading ? <p className="pf-home-empty" role="status">Loading your documents…</p> : files.length || subfolders.length ? view === 'list' ?
            <div className="pf-home-table-wrap"><table><thead><tr><th>Name</th><th>Modified</th><th>Project</th><th>Owned by</th><th></th></tr></thead><tbody>{subfolders.map(folder => <tr key={folder.id}>
              <td><button type="button" aria-label={`Open folder ${folder.name}`} disabled={busy} onClick={() => choose(project!.id, folder.id)}><span className="pf-home-file-art folder"><LuFolder size={22} /></span><span><strong>{folder.name}</strong><small>Folder</small></span></button></td>
              <td>—</td><td>{project!.name}</td><td>me</td><td>{actions('folder', folder.id, folder.name, folder.project_id, folder.parent_id)}</td>
            </tr>)}{files.map(file => <tr key={file.id}>
              <td><button type="button" aria-label={`Open ${file.name}`} disabled={busy} onClick={() => open(file)}><span className={`pf-home-file-art ${file.is_template ? 'template' : file.kind}`}><Icon name={file.is_template ? 'document-template' : file.kind === 'model' ? 'document-model' : 'document-layout'} size={24} /></span><span><strong>{file.name.replace(/\.(pf|pfl)$/i, '')}</strong><small>{file.is_template ? 'Layout template' : file.kind === 'model' ? '3D model' : 'Drawing'} · Revision {file.revision_number}</small></span></button></td>
              <td>{date(file.updated_at)}</td><td>{projects.find(project => project.id === file.project_id)?.name ?? '—'}</td><td>me</td><td>{actions('document', file.id, file.name, file.project_id, file.folder_id)}</td>
            </tr>)}</tbody></table></div> : <div className="pf-home-grid">{subfolders.map(folder => <div key={folder.id}><button type="button" aria-label={`Open folder ${folder.name}`} disabled={busy} onClick={() => choose(project!.id, folder.id)}><span className="pf-home-file-art folder"><LuFolder size={44} /></span><strong>{folder.name}</strong><small>Folder</small></button>{actions('folder', folder.id, folder.name, folder.project_id, folder.parent_id)}</div>)}{files.map(file => <div key={file.id}><button type="button" aria-label={`Open ${file.name}`} disabled={busy} onClick={() => open(file)}><span className={`pf-home-file-art ${file.is_template ? 'template' : file.kind}`}>{thumbnail(file.id)
              ? <img className="pf-home-thumbnail" src={thumbnail(file.id)} alt="" crossOrigin="anonymous" />
              : <Icon name={file.is_template ? 'document-template' : file.kind === 'model' ? 'document-model' : 'document-layout'} size={48} />}</span><strong>{file.name.replace(/\.(pf|pfl)$/i, '')}</strong><small>{file.is_template ? 'Layout template' : file.kind === 'model' ? '3D model' : 'Drawing'} · Revision {file.revision_number}</small></button>{actions('document', file.id, file.name, file.project_id, file.folder_id)}</div>)}</div>
            : <div className="pf-home-empty"><LuFolder size={36} /><h3>{search ? 'No matching documents' : recent ? 'Nothing opened yet' : currentFolder ? 'This folder is empty' : 'Room for your next idea'}</h3><p>{search ? 'Try another name or choose a different project.' : recent ? 'Documents you open will appear here.' : currentFolder ? 'Create a document here or import files into this folder.' : 'Create a model or drawing to get started.'}</p></div>}
          {!recent && !inTrash ? <footer className="pf-home-pagination"><span>Private to your account</span><button type="button" disabled={busy || loading || page === 0} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {page + 1}</span><button type="button" disabled={busy || loading || files.length < CLOUD_PAGE_SIZE} onClick={() => setPage(value => value + 1)}>Next</button></footer> : null}
        </section>
      </main>
    </div>
    {importing && api && ownerId ? <ImportDialog api={api} ownerId={ownerId} buildInfo={buildInfo} projects={projects}
      currentProject={project?.id} currentFolder={project ? currentFolder : undefined}
      onClose={() => setImporting(false)}
      onImported={(projectId, folder) => { if (!alive.current) return; setRefresh(value => value + 1); if (scope !== projectId || currentFolder !== folder) choose(projectId, folder); }} /> : null}
  </div>;
}
