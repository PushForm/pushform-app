// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { LuFolderInput, LuX } from 'react-icons/lu';
import type { CloudFilesApi, CloudFolder, CloudProject } from '@pushform/cloud';
import type { BuildInfo } from '../buildInfo';
import { findOrCreateDocumentsProject } from '../cloudDocuments';
import { readImportDestination, writeImportDestination } from '../importDestination';
import { convertImportFile, IMPORT_FILE_ACCEPT, IMPORT_FILE_DESCRIPTION, isImportableFile } from '../importFiles';
import { Icon } from './Icon';

export interface ImportOutcome { name: string; status: 'imported' | 'failed'; detail: string }

/** Folders of one project flattened in tree order with their depth, for a select. */
export function folderTree(folders: readonly CloudFolder[]): { folder: CloudFolder; depth: number; path: string }[] {
  const byParent = new Map<string | null, CloudFolder[]>();
  for (const folder of folders) byParent.set(folder.parent_id, [...byParent.get(folder.parent_id) ?? [], folder]);
  const out: { folder: CloudFolder; depth: number; path: string }[] = [];
  const walk = (parent: string | null, depth: number, prefix: string, seen: Set<string>): void => {
    for (const folder of (byParent.get(parent) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen.has(folder.id)) continue;
      const path = prefix ? `${prefix} / ${folder.name}` : folder.name;
      out.push({ folder, depth, path }); walk(folder.id, depth + 1, path, new Set([...seen, folder.id]));
    }
  };
  walk(null, 0, '', new Set()); return out;
}

/**
 * Import SketchUp models and LayOut documents straight into the cloud library: pick or
 * drop files, choose the project and folder, and Continue converts and uploads each file without
 * opening it. The destination starts at the project being browsed, else the last one chosen here,
 * else Documents.
 */
export function ImportDialog({ api, ownerId, buildInfo, projects: initialProjects, currentProject, currentFolder, onClose, onImported }: {
  api: CloudFilesApi; ownerId: string; buildInfo?: BuildInfo | undefined; projects: readonly CloudProject[];
  /** The project and folder Home is browsing, when it is browsing one. */
  currentProject?: string | undefined; currentFolder?: string | null | undefined;
  onClose: () => void;
  /** Called after Continue finishes with at least one upload, so the library can refresh. */
  onImported: (projectId: string, folderId: string | null) => void;
}): JSX.Element {
  const remembered = readImportDestination(ownerId);
  const [projects, setProjects] = useState<CloudProject[]>([...initialProjects]);
  const [projectId, setProjectId] = useState(currentProject ?? (remembered && initialProjects.some(p => p.id === remembered.projectId) ? remembered.projectId : ''));
  const [folderId, setFolderId] = useState<string | null>(currentProject ? currentFolder ?? null : remembered?.folderId ?? null);
  const [folders, setFolders] = useState<{ project: string; items: CloudFolder[] }>({ project: '', items: [] });
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState<{ index: number; stage?: string | undefined } | null>(null);
  const [outcomes, setOutcomes] = useState<ImportOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(!currentProject && !remembered);
  const dialog = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), alive = useRef(true);
  const state = useRef({ onClose, running: false }); state.current.onClose = onClose;
  const busy = running !== null || preparing;
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>('.pf-app'), wasInert = app?.inert ?? false;
    if (app) app.inert = true;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    const key = (event: KeyboardEvent): void => {
      event.stopImmediatePropagation();
      if (event.type === 'keydown' && event.key === 'Escape' && !state.current.running) { event.preventDefault(); state.current.onClose(); }
      if (event.type === 'keydown' && event.key === 'Tab') {
        event.preventDefault();
        const targets = [...dialog.current!.querySelectorAll<HTMLElement>(':is(button,input,select):not(:disabled):not([hidden])')];
        const index = targets.indexOf(document.activeElement as HTMLElement);
        targets[index < 0 ? 0 : (index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length]?.focus();
      }
    };
    window.addEventListener('keydown', key, true); window.addEventListener('keyup', key, true);
    return () => {
      alive.current = false;
      window.removeEventListener('keydown', key, true); window.removeEventListener('keyup', key, true);
      if (app) app.inert = wasInert;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  // Without a browsed or remembered project, Documents is the destination (created when needed).
  useEffect(() => {
    if (!preparing) return;
    let current = true;
    void findOrCreateDocumentsProject(api).then(id => {
      if (!current) return;
      setProjects(items => items.some(p => p.id === id) ? items : [...items, { id, name: 'Documents' }]);
      setProjectId(id);
    }).catch(cause => { if (current) setError((cause as Error).message); }).finally(() => { if (current) setPreparing(false); });
    return () => { current = false; };
  }, [api, preparing]);
  useEffect(() => {
    if (!projectId) return;
    let current = true;
    void api.listFolders(projectId).then(items => { if (current) setFolders({ project: projectId, items }); })
      .catch(cause => { if (current) setError((cause as Error).message); });
    return () => { current = false; };
  }, [api, projectId]);
  const tree = folders.project === projectId ? folderTree(folders.items) : [];
  const effectiveFolder = folderId && tree.some(item => item.folder.id === folderId) ? folderId : null;
  const addFiles = (picked: Iterable<File>): void => {
    const next = [...files], skipped: string[] = [];
    for (const file of picked) {
      if (!isImportableFile(file.name)) { skipped.push(file.name); continue; }
      if (!next.some(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) next.push(file);
    }
    setFiles(next); setRejected(skipped); setOutcomes(null); setError(null);
  };
  const pick = (event: ChangeEvent<HTMLInputElement>): void => { addFiles(event.target.files ?? []); event.target.value = ''; };
  const drop = (event: DragEvent): void => { event.preventDefault(); setDragging(false); if (!busy) addFiles(event.dataTransfer.files); };
  const createFolder = async (name: string): Promise<void> => {
    setError(null);
    try {
      const folder = await api.createFolder(projectId, effectiveFolder, name);
      if (!alive.current) return;
      setFolders(current => ({ project: projectId, items: [...current.items, folder] })); setFolderId(folder.id); setNewFolder(null);
    } catch (cause) { if (alive.current) setError((cause as Error).message); }
  };
  const start = async (): Promise<void> => {
    if (!files.length || !projectId || state.current.running) return;
    state.current.running = true; setError(null); setOutcomes(null);
    writeImportDestination(ownerId, { projectId, folderId: effectiveFolder });
    const results: ImportOutcome[] = [];
    for (const [index, file] of files.entries()) {
      if (!alive.current) break;
      setRunning({ index });
      try {
        const converted = await convertImportFile(file, { cloudFiles: api, buildInfo,
          onProgress: progress => { if (alive.current) setRunning({ index, stage: [progress.total > 1 ? `${progress.stage} ${progress.current.toLocaleString('en-US')} of ${progress.total.toLocaleString('en-US')}` : progress.stage, progress.detail].filter(Boolean).join(' · ') }); } });
        await api.save({ projectId, folderId: effectiveFolder, name: converted.name, kind: converted.kind, bytes: converted.bytes });
        results.push({ name: file.name, status: 'imported', detail: converted.notes.length ? `Saved as ${converted.name} with ${converted.notes.length} note${converted.notes.length === 1 ? '' : 's'}.` : `Saved as ${converted.name}.` });
      } catch (cause) {
        results.push({ name: file.name, status: 'failed', detail: (cause as Error).message || 'Import failed.' });
      }
    }
    state.current.running = false;
    if (!alive.current) return;
    setRunning(null); setOutcomes(results); setFiles([]);
    if (results.some(item => item.status === 'imported')) onImported(projectId, effectiveFolder);
  };
  const project = projects.find(item => item.id === projectId);
  const destination = project ? `${project.name}${effectiveFolder ? ` / ${tree.find(item => item.folder.id === effectiveFolder)?.path ?? ''}` : ''}` : '';
  return createPortal(<div className="pf-modal-backdrop">
    <div ref={dialog} className="pf-modal pf-import-dialog" role="dialog" aria-modal="true" aria-labelledby="pf-import-title" aria-busy={busy}>
      <div className="pf-account-heading"><div><h2 id="pf-import-title">Import files</h2><p className="pf-cloud-privacy">SketchUp and COLLADA models and LayOut drawings are converted and saved to your library.</p></div>
        <button type="button" className="pf-iconbtn" aria-label="Close import" disabled={running !== null} onClick={onClose}><Icon name="close" /></button></div>
      {error ? <p className="pf-account-error" role="alert">{error}</p> : null}
      <div className={`pf-import-drop${dragging ? ' is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }}
        onDragLeave={() => setDragging(false)} onDrop={drop} aria-label="Drop SketchUp or LayOut files here">
        <LuFolderInput size={30} aria-hidden="true" />
        <p>Drag and drop .skp, .skb, .dae, .obj, .3ds, .stl, .dxf, .gltf, .glb, .step, .stp, .zip, .kmz, or .layout files here</p>
        <button type="button" className="pf-account-primary" disabled={busy} onClick={() => input.current?.click()}>Choose files</button>
        <input ref={input} type="file" hidden multiple accept={IMPORT_FILE_ACCEPT} aria-label="Import SketchUp or LayOut files" onChange={pick} />
      </div>
      {rejected.length ? <p className="pf-account-error" role="alert">Skipped {rejected.join(', ')}. {IMPORT_FILE_DESCRIPTION}</p> : null}
      {files.length ? <ul className="pf-import-files" aria-label="Files to import">{files.map((file, index) => <li key={`${file.name}:${file.size}:${file.lastModified}`}>
        <Icon name={/\.layout$/i.test(file.name) ? 'document-layout' : 'document-model'} size={16} />
        <span>{file.name}</span><small>{Math.max(1, Math.round(file.size / 1024))} KiB</small>
        {running?.index === index ? <small role="status">{running.stage ?? 'Converting'}…</small>
          : <button type="button" aria-label={`Remove ${file.name}`} disabled={busy} onClick={() => setFiles(items => items.filter((_, i) => i !== index))}><LuX /></button>}
      </li>)}</ul> : null}
      {outcomes ? <ul className="pf-import-results" aria-label="Import results">{outcomes.map((item, index) => <li key={index} className={item.status === 'failed' ? 'is-failed' : ''}>
        <strong>{item.name}</strong> <span>{item.status === 'failed' ? `Could not import: ${item.detail}` : item.detail}</span></li>)}</ul> : null}
      <div className="pf-import-destination">
        <label>Project<select value={projectId} disabled={busy} onChange={event => { setProjectId(event.target.value); setFolderId(null); setNewFolder(null); }}>
          {!projectId ? <option value="">Choose a project</option> : null}
          {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Folder<select value={effectiveFolder ?? ''} disabled={busy || !projectId} onChange={event => setFolderId(event.target.value || null)}>
          <option value="">Project root</option>
          {tree.map(item => <option key={item.folder.id} value={item.folder.id}>{`${'  '.repeat(item.depth)}${item.folder.name}`}</option>)}</select></label>
        {newFolder === null ? <button type="button" disabled={busy || !projectId} onClick={() => setNewFolder('')}>New folder</button>
          : <form className="pf-import-new-folder" aria-label="New folder" onSubmit={event => { event.preventDefault(); void createFolder(newFolder); }}>
            <input aria-label="Folder name" value={newFolder} maxLength={100} disabled={busy} autoFocus onChange={event => setNewFolder(event.target.value)} />
            <button type="submit" disabled={busy || !newFolder.trim()}>Create</button>
            <button type="button" disabled={busy} onClick={() => setNewFolder(null)}>Cancel</button>
          </form>}
      </div>
      <footer className="pf-cloud-footer">
        <span role="status">{running ? `Importing ${running.index + 1} of ${files.length}…` : preparing ? 'Preparing your library…' : destination ? `Saving to ${destination}` : ''}</span>
        <button type="button" disabled={running !== null} onClick={onClose}>{outcomes ? 'Done' : 'Cancel'}</button>
        <button type="button" className="pf-account-primary" disabled={busy || !files.length || !projectId} onClick={() => { void start(); }}>
          {files.length > 1 ? `Import ${files.length} files` : 'Import'}</button>
      </footer>
    </div>
  </div>, document.body);
}
