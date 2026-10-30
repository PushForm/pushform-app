// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { CLOUD_PAGE_SIZE, type CloudFile, type CloudFilesApi, type CloudProject } from '@pushform/cloud';
import { newDraftKey, type DocumentSession, type DocumentTab } from '../session';
import { cloudLocation, openCloudDocument, saveCloudDocument, saveCloudLayoutTemplate } from '../cloudDocuments';
import { Icon } from './Icon';

export function CloudBrowser({ api, session, owner, saveTab, forceCopy = false, saveAsTemplate = false, templatesOnly = false, embedded = false, onBusyChange, onClose }: {
  api: CloudFilesApi; session: DocumentSession; owner: () => string | null;
  saveTab?: DocumentTab | undefined; onClose: () => void;
  forceCopy?: boolean | undefined;
  saveAsTemplate?: boolean | undefined;
  templatesOnly?: boolean | undefined;
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
}): JSX.Element {
  const [templateKey] = useState(newDraftKey);
  const location = cloudLocation(saveTab?.identity);
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectId, setProjectId] = useState(location?.ownerId === owner() ? location.projectId : '');
  const [newProject, setNewProject] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [listing, setListing] = useState<{ key: string; files: CloudFile[] }>({ key: '', files: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState(saveTab?.name ?? '');
  const [copy, setCopy] = useState(forceCopy || (!!location && location.ownerId !== owner()));
  const [pending, setPending] = useState<'creating' | 'opening' | 'saving' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const dialog = useRef<HTMLDivElement>(null), alive = useRef(true);
  const actions = useRef({ onClose, pending }); actions.current = { onClose, pending };
  const requestKey = `${projectId}:${search}:${page}:${retry}:${templatesOnly}`;
  const files = listing.key === requestKey ? listing.files : [];
  const loading = !!projectId && listing.key !== requestKey;
  useEffect(() => {
    alive.current = true;
    if (embedded) return () => { alive.current = false; };
    const previous = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>('.pf-app'), wasInert = app?.inert ?? false;
    if (app) app.inert = true;
    dialog.current?.querySelector<HTMLElement>('input')?.focus();
    const key = (event: KeyboardEvent): void => {
      event.stopImmediatePropagation();
      if (event.type === 'keydown' && event.key === 'Escape') { event.preventDefault(); if (!actions.current.pending) actions.current.onClose(); }
      if (event.type === 'keydown' && event.key === 'Tab') {
        event.preventDefault();
        const targets = [...dialog.current!.querySelectorAll<HTMLElement>(':is(button,input,[tabindex="0"]):not(:disabled)')];
        const index = targets.indexOf(document.activeElement as HTMLElement);
        const next = index < 0 ? (event.shiftKey ? targets.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length;
        targets[next]?.focus();
      }
    };
    window.addEventListener('keydown', key, true); window.addEventListener('keyup', key, true);
    return () => {
      alive.current = false;
      window.removeEventListener('keydown', key, true); window.removeEventListener('keyup', key, true);
      if (app) app.inert = wasInert;
      if (previous?.isConnected) previous.focus();
    };
  }, [embedded]);
  useEffect(() => { onBusyChange?.(pending !== null); }, [pending, onBusyChange]);
  useEffect(() => () => { onBusyChange?.(false); }, [onBusyChange]);
  useEffect(() => {
    let current = true; setProjectsLoading(true); setError(null);
    void api.listProjects().then(items => {
      if (!current) return; setProjects(items);
      setProjectId(id => items.some(p => p.id === id) ? id : items[0]?.id ?? '');
    }).catch(cause => { if (current) setError((cause as Error).message); })
      .finally(() => { if (current) setProjectsLoading(false); });
    return () => { current = false; };
  }, [api, retry]);
  useEffect(() => {
    let current = true; setSelected(null);
    if (!projectId) return;
    const listing = templatesOnly ? api.listFiles(projectId, search, page * CLOUD_PAGE_SIZE, undefined, true)
      : api.listFiles(projectId, search, page * CLOUD_PAGE_SIZE);
    void listing.then(items => {
      if (current) setListing({ key: requestKey, files: items });
    }).catch(cause => { if (current) { setError((cause as Error).message); setListing({ key: requestKey, files: [] }); } });
    return () => { current = false; };
  }, [api, projectId, search, page, requestKey, templatesOnly]);
  const busy = pending !== null;
  const run = async (kind: NonNullable<typeof pending>, action: () => Promise<void>): Promise<void> => {
    if (actions.current.pending) return;
    actions.current.pending = kind; setPending(kind); setError(null);
    try { await action(); } catch (cause) { if (alive.current) setError((cause as Error).message); }
    finally { if (alive.current) { actions.current.pending = null; setPending(null); } }
  };
  const open = (file: CloudFile): void => { void run('opening', async () => {
    await openCloudDocument(api, session, file, owner); if (alive.current) onClose();
  }); };
  const save = (): void => { if (!saveTab || !projectId) return; void run('saving', async () => {
    if (saveAsTemplate) {
      if (saveTab.type !== 'layout') throw new Error('Only Layout drawings can be saved as templates.');
      await saveCloudLayoutTemplate(api, saveTab, owner, projectId, name, templateKey);
    } else await saveCloudDocument(api, session, saveTab, owner, projectId, name, copy);
    if (alive.current) onClose();
  }); };
  const create = (event: FormEvent): void => { event.preventDefault(); void run('creating', async () => {
    const project = await api.createProject(newProject);
    if (alive.current) {
      setProjects(items => [...items, project].sort((a, b) => a.name.localeCompare(b.name)));
      setProjectId(project.id); setPage(0); setSearch(''); setNewProject('');
    }
  }); };
  const chooseProject = (id: string): void => { setProjectId(id); setPage(0); setSelected(null); setError(null); };
  const selectedFile = files.find(file => file.id === selected);
  const content = <div ref={dialog} className={embedded ? "pf-cloud-browser pf-cloud-browser-embedded" : "pf-modal pf-cloud-browser"}
      role={embedded ? undefined : "dialog"} aria-modal={embedded ? undefined : true} aria-labelledby={embedded ? undefined : "pf-cloud-title"} aria-busy={busy}>
      {embedded ? null : <div className="pf-account-heading"><div><h2 id="pf-cloud-title">{saveAsTemplate ? 'Save as Template' : templatesOnly ? 'My Layout Templates' : saveTab ? 'Save to Cloud' : 'Cloud files'}</h2>
        <p className="pf-cloud-privacy">Private to your account</p></div>
        <button type="button" className="pf-iconbtn" aria-label="Close cloud files" disabled={busy} onClick={onClose}><Icon name="close" /></button>
      </div>}
      {error ? <p className="pf-account-error" role="alert">{error} <button type="button" disabled={busy} onClick={() => { setError(null); setRetry(v => v + 1); }}>Refresh</button></p> : null}
      <div className="pf-cloud-content">
        <aside className="pf-cloud-projects" aria-label="Cloud projects">
          <h3>Projects</h3>
          {projectsLoading ? <p role="status">Loading projects…</p> : null}
          <div className="pf-cloud-project-list">{projects.map(project => <button key={project.id} type="button" aria-current={project.id === projectId ? 'page' : undefined}
            disabled={busy} onClick={() => chooseProject(project.id)}>{project.name}</button>)}</div>
          <form onSubmit={create}><label htmlFor="pf-cloud-project-name">New project</label>
            <input id="pf-cloud-project-name" value={newProject} maxLength={100} disabled={busy} onChange={e => setNewProject(e.target.value)} />
            <button type="submit" disabled={busy || !newProject.trim()}>{pending === 'creating' ? 'Creating…' : 'Create project'}</button>
          </form>
        </aside>
        <section className="pf-cloud-files" aria-label="Files in project">
          <label htmlFor="pf-cloud-search">Search files</label>
          <input id="pf-cloud-search" type="search" value={search} disabled={busy || !projectId} onChange={e => { setSearch(e.target.value); setPage(0); setError(null); }} />
          <div className="pf-cloud-file-list" role="region" aria-label="Cloud file list" tabIndex={0}>
            {loading ? <p role="status">Loading files…</p> : !projectId ? <p>Create a project to start storing files.</p>
              : files.length === 0 ? <p>{page > 0 ? 'No more files on this page.' : search ? 'No files match your search.' : 'This project has no saved files yet.'}</p> :
                files.map(file => <button type="button" className={`pf-cloud-file${selected === file.id ? ' is-selected' : ''}`} key={file.id}
                  disabled={busy} aria-pressed={selected === file.id} onClick={() => setSelected(file.id)} onDoubleClick={() => { if (!saveTab) open(file); }}>
                  <Icon name={file.is_template ? 'document-template' : file.kind === 'model' ? 'document-model' : 'document-layout'} />
                  <span><strong>{file.name}</strong><small>{file.is_template ? 'Layout template' : file.kind === 'model' ? 'Modeling' : 'Layout'} · Revision {file.revision_number} · {Math.max(1, Math.round(file.size_bytes / 1024))} KiB · {new Date(file.updated_at).toLocaleString()}</small></span>
                </button>)}
          </div>
          <div className="pf-cloud-pagination">
            <button type="button" disabled={busy || page === 0} onClick={() => setPage(v => v - 1)}>Previous</button>
            <span>Page {page + 1}</span>
            <button type="button" disabled={busy || loading || files.length < CLOUD_PAGE_SIZE} onClick={() => setPage(v => v + 1)}>Next</button>
          </div>
        </section>
      </div>
      {saveTab ? <div className="pf-cloud-save-fields"><label htmlFor="pf-cloud-file-name">File name</label>
        <input id="pf-cloud-file-name" value={name} maxLength={200} disabled={busy} onChange={e => setName(e.target.value)} />
        {saveAsTemplate ? <p>Saves a separate template. Opening it creates a new drawing; your current document stays as it is.</p>
          : location ? <label className="pf-cloud-copy"><input type="checkbox" checked={copy} disabled={busy || forceCopy || location.ownerId !== owner()} onChange={e => setCopy(e.target.checked)} />Save as a new cloud file</label> : null}
      </div> : null}
      <footer className="pf-cloud-footer">
        <span role="status">{pending === 'saving' ? 'Saving cloud revision…' : pending === 'opening' ? 'Opening file…' : ''}</span>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="pf-account-primary" type="button" disabled={busy || (saveTab ? !projectId || !name.trim() : !selectedFile)}
          onClick={() => { if (saveTab) save(); else if (selectedFile) open(selectedFile); }}>{saveAsTemplate ? 'Save Template' : saveTab ? 'Save' : selectedFile?.is_template || templatesOnly ? 'Create Layout' : 'Open'}</button>
      </footer>
    </div>;
  return embedded ? content : createPortal(<div className="pf-modal-backdrop">{content}</div>, document.body);
}
