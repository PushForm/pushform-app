// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useState } from 'react';
import type { JSX, MouseEvent } from 'react';
import type { DefId } from '@pushform/core';
import { entityCounts } from '@pushform/model';
import type { ComponentBehaviors, ComponentDefinition, DocumentState, EntityCounts } from '@pushform/model';
import { useApp } from '../AppContext';
import { useDocumentState } from '../hooks/useDocument';
import { cachedComponentThumbnail, renderComponentThumbnail } from './componentThumbnails';

/** Components panel: the model's components, placing and replacing them, their properties and statistics. */

type Tab = 'select' | 'edit' | 'statistics';
type MenuAction = 'selectInstances' | 'replace' | 'delete' | 'properties';

/** The model's component definitions, by name: neither groups nor the model itself. */
export function inModelComponents(state: DocumentState): ComponentDefinition[] {
  return [...state.definitions.values()].filter((d) => d.id !== state.rootDefinitionId && !d.isGroup).sort((a, b) => a.name.localeCompare(b.name));
}

/** Thumbnails for the listed components, drawn one per task so a long list does not hold up the page. */
function useThumbnails(state: DocumentState, components: readonly ComponentDefinition[]): Map<DefId, string> {
  const [, setDrawn] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const missing = components.filter((d) => cachedComponentThumbnail(d) === undefined);
    const next = (): void => {
      const def = missing.shift();
      if (cancelled || !def) return;
      renderComponentThumbnail(state, def.id);
      setDrawn((n) => n + 1);
      setTimeout(next, 0);
    };
    if (missing.length) setTimeout(next, 0);
    return () => { cancelled = true; };
  }, [state, components]);
  return new Map(components.map((d) => [d.id, cachedComponentThumbnail(d) ?? ''] as const));
}

export function ComponentsPanel(): JSX.Element {
  const app = useApp();
  const state = useDocumentState();
  const components = useMemo(() => inModelComponents(state), [state]);
  const thumbnails = useThumbnails(state, components);
  const [tab, setTab] = useState<Tab>('select');
  const [selectedId, setSelectedId] = useState<DefId | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: DefId } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = components.find((d) => d.id === selectedId) ?? null;

  const run = (id: string, params: unknown): unknown => {
    const r = app.commands.tryExecute(id, params);
    if (!r.ok) {
      setError(r.error instanceof Error ? r.error.message : String(r.error));
      return undefined;
    }
    setError(null);
    return r.result;
  };
  const place = (id: DefId): void => {
    setSelectedId(id);
    run('component.startPlacing', { definitionId: id });
  };
  const onContextMenu = (e: MouseEvent, id: DefId): void => {
    e.preventDefault();
    setSelectedId(id);
    setMenu({ x: e.clientX, y: e.clientY, id });
  };
  const menuAction = (action: MenuAction): void => {
    const id = menu?.id;
    setMenu(null);
    if (id === undefined) return;
    if (action === 'selectInstances') run('component.selectInstances', { definitionId: id });
    else if (action === 'replace') run('component.replaceSelected', { definitionId: id });
    else if (action === 'delete') { if (run('component.delete', { definitionId: id }) !== undefined || selectedId === id) setSelectedId(null); }
    else setTab('edit');
  };

  return (
    <div className="pf-materials pf-components" onClick={() => menu && setMenu(null)}>
      <div className="pf-materials-head">
        <div className="pf-materials-active" aria-label="Selected component">
          <span className="pf-materials-name">{selected ? selected.name : 'No component selected'}</span>
        </div>
      </div>
      <div className="pf-materials-tabs" role="tablist" aria-label="Components">
        {(['select', 'edit', 'statistics'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`pf-materials-tab${tab === t ? ' is-active' : ''}`} onClick={() => setTab(t)}>
            {t === 'select' ? 'Select' : t === 'edit' ? 'Edit' : 'Statistics'}
          </button>
        ))}
      </div>
      {error ? <p className="pf-form-note pf-dialog-error" role="alert">{error}</p> : null}
      {tab === 'select' ? (
        <>
          {components.length ? (
            <div className="pf-materials-grid is-large pf-components-grid" role="listbox" aria-label="In Model">
              {components.map((d) => {
                const thumbnail = thumbnails.get(d.id);
                return (
                  <button key={d.id} type="button" role="option" aria-selected={selectedId === d.id} title={`${d.name}: click to place`}
                    className={`pf-material-item${selectedId === d.id ? ' is-active' : ''}`} onClick={() => place(d.id)} onContextMenu={(e) => onContextMenu(e, d.id)}>
                    {thumbnail ? <img className="pf-component-thumb" src={thumbnail} alt="" /> : <span className="pf-component-thumb is-empty" aria-hidden="true" />}
                    <span className="pf-material-label">{d.name}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="pf-form-note">No components in this model. Select geometry and choose Make Component (G).</p>
          )}
          {menu ? (
            <ul className="pf-menu pf-materials-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
              <li className="pf-menu-item" role="menuitem" onClick={() => menuAction('selectInstances')}>Select Instances</li>
              <li className="pf-menu-item" role="menuitem" onClick={() => menuAction('replace')}>Replace Selected</li>
              <li className="pf-menu-item" role="menuitem" onClick={() => menuAction('delete')}>Delete</li>
              <li className="pf-menu-item" role="menuitem" onClick={() => menuAction('properties')}>Properties</li>
            </ul>
          ) : null}
        </>
      ) : tab === 'edit' ? (
        selected ? <EditTab key={selected.id} definition={selected} run={run} /> : <p className="pf-form-note">Select a component in the Select tab.</p>
      ) : selected ? (
        <StatisticsTab state={state} definition={selected} />
      ) : (
        <p className="pf-form-note">Select a component in the Select tab.</p>
      )}
    </div>
  );
}

const GLUE: readonly [ComponentBehaviors['glueTo'], string][] = [['none', 'None'], ['any', 'Any'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['sloped', 'Sloped']];

/** Edit tab: name and description, committed on Enter or leaving the field, and the behaviors Make Component sets. */
function EditTab({ definition, run }: { definition: ComponentDefinition; run: (id: string, params: unknown) => unknown }): JSX.Element {
  const [name, setName] = useState(definition.name);
  const [description, setDescription] = useState(definition.description);
  useEffect(() => setName(definition.name), [definition.name]);
  useEffect(() => setDescription(definition.description), [definition.description]);
  const set = (patch: Record<string, unknown>): void => { run('definition.setProperties', { definitionId: definition.id, ...patch }); };
  const commitName = (): void => {
    const trimmed = name.trim();
    if (!trimmed) { setName(definition.name); return; }
    if (trimmed !== definition.name && run('definition.setProperties', { definitionId: definition.id, name: trimmed }) === undefined) setName(definition.name);
  };
  const behaviors = definition.behaviors;
  return (
    <div className="pf-form">
      <div className="pf-form-row">
        <span className="pf-form-label">Name</span>
        <input className="pf-form-input" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName}
          onKeyDown={(e) => { if (e.key === 'Enter') commitName(); else if (e.key === 'Escape') setName(definition.name); e.stopPropagation(); }} />
      </div>
      <div className="pf-form-row">
        <span className="pf-form-label">Description</span>
        <textarea className="pf-form-input" aria-label="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)}
          onBlur={() => { if (description !== definition.description) set({ description }); }} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="pf-form-section">Alignment</div>
      <div className="pf-form-row">
        <span className="pf-form-label">Glue to</span>
        <select className="pf-form-select" aria-label="Glue to" value={behaviors.glueTo} onChange={(e) => set({ glueTo: e.target.value })}>
          {GLUE.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <label className="pf-form-check">
        <input type="checkbox" checked={behaviors.cutsOpening} disabled={behaviors.glueTo === 'none'} onChange={(e) => set({ cutsOpening: e.target.checked })} />
        Cut opening
      </label>
      <label className="pf-form-check">
        <input type="checkbox" checked={behaviors.alwaysFaceCamera} onChange={(e) => set({ alwaysFaceCamera: e.target.checked, ...(e.target.checked ? {} : { shadowsFaceSun: false }) })} />
        Always face camera
      </label>
      <label className="pf-form-check">
        <input type="checkbox" checked={behaviors.shadowsFaceSun} disabled={!behaviors.alwaysFaceCamera} onChange={(e) => set({ shadowsFaceSun: e.target.checked })} />
        Shadows face sun
      </label>
    </div>
  );
}

const STATISTICS: readonly [keyof EntityCounts, string][] = [
  ['solids', 'Solids'], ['solidFaces', 'Solid faces'], ['sheetFaces', 'Sheet faces'], ['edges', 'Edges'], ['groups', 'Groups'],
  ['componentInstances', 'Component instances'], ['guides', 'Guides'], ['dimensions', 'Dimensions'], ['texts', 'Texts'], ['images', 'Images'],
  ['sectionPlanes', 'Section planes'],
];

/** Statistics tab: what the component holds, as Model Info counts it. */
function StatisticsTab({ state, definition }: { state: DocumentState; definition: ComponentDefinition }): JSX.Element {
  const [nested, setNested] = useState(false);
  const counts = useMemo(() => entityCounts(state, nested, definition.id), [state, nested, definition.id]);
  return (
    <>
      <label className="pf-form-check">
        <input type="checkbox" checked={nested} onChange={(e) => setNested(e.target.checked)} />
        Show nested components
      </label>
      <table className="pf-model-stats" aria-label="Component statistics">
        <tbody>
          {STATISTICS.map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td>{counts[key]}</td></tr>)}
        </tbody>
      </table>
    </>
  );
}
