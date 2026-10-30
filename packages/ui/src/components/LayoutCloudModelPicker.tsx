// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { CloudFile, CloudFilesApi, CloudProject } from '@pushform/cloud';
import { Icon } from './Icon';

/** The account's models grouped by project, in the library's project order; models of an unlisted project come last. */
export function groupModelsByProject(projects: readonly CloudProject[], files: readonly CloudFile[]): { name: string; files: CloudFile[] }[] {
  const groups = new Map<string, { name: string; files: CloudFile[] }>(projects.map(project => [project.id, { name: project.name, files: [] }]));
  const other: CloudFile[] = [];
  for (const file of files) {
    if (file.kind !== 'model') continue;
    const group = groups.get(file.project_id);
    if (group) group.files.push(file); else other.push(file);
  }
  const listed = [...groups.values()].filter(group => group.files.length);
  return other.length ? [...listed, { name: 'Other projects', files: other }] : listed;
}

/** Choose a cloud model document to link into a drawing. Lists the account's models by project, newest first within each. */
export function LayoutCloudModelPicker({ api, onPick, onClose }: { api: CloudFilesApi; onPick: (file: CloudFile) => void; onClose: () => void }): JSX.Element {
  const [search, setSearch] = useState('');
  const [groups, setGroups] = useState<{ name: string; files: CloudFile[] }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setGroups(null); setError(null);
    Promise.all([api.listProjects(), api.listFiles('', search)]).then(([projects, files]) => { if (live) setGroups(groupModelsByProject(projects, files)); },
      failure => { if (live) { setGroups([]); setError(failure instanceof Error ? failure.message : 'The cloud library could not be read.'); } });
    return () => { live = false; };
  }, [api, search]);
  return <div className="pf-modal-backdrop" onClick={onClose}>
    <div className="pf-modal pf-layout-model-picker" role="dialog" aria-modal="true" aria-label="Choose a cloud model" onClick={event => event.stopPropagation()}>
      <div><h2>Choose a cloud model</h2>
        <button type="button" className="pf-iconbtn" aria-label="Close model chooser" onClick={onClose}><Icon name="close" /></button></div>
      <input type="search" aria-label="Search models" placeholder="Search models" value={search} autoFocus onChange={event => setSearch(event.target.value)} />
      {error ? <p role="alert">{error}</p> : null}
      {groups === null ? <p role="status">Loading models…</p> : groups.length === 0 ? <p>No cloud models{search ? ' match' : ' yet'}. Save a Modeling document to the cloud first.</p> :
        <div className="pf-layout-model-picker-list">{groups.map(group => <section key={group.name} aria-label={group.name}>
          <h3>{group.name}</h3>
          <ul>{group.files.map(file => <li key={file.id}>
            <button type="button" onClick={() => onPick(file)}><Icon name="document-model" size={20} /><span>{file.name.replace(/\.pf$/i, '')}</span><small>Revision {file.revision_number}</small></button>
          </li>)}</ul>
        </section>)}</div>}
      <div className="pf-modal-actions"><button type="button" onClick={onClose}>Cancel</button></div>
    </div>
  </div>;
}
