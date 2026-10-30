// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { SceneFlags } from '@pushform/model';
import { useApp } from '../AppContext';
import { Icon } from '../components/Icon';
import { installUiServices } from '../engine/uiServices';
import { useDocumentState, useSceneRuntime } from '../hooks/useDocument';
import { useAppStore } from '../store';

export const THUMB_W = 160;
export const THUMB_H = 100;

const FLAG_LABELS: readonly (readonly [keyof SceneFlags, string])[] = [
  ['useCamera', 'Camera Location'],
  ['useHiddenGeometry', 'Hidden Geometry'],
  ['useHiddenObjects', 'Hidden Objects'],
  ['useTags', 'Visible Tags'],
  ['useSectionPlanes', 'Active Section Planes'],
  ['useStyle', 'Style and Fog'],
  ['useShadows', 'Shadow Settings'],
  ['useAxes', 'Axes Location'],
];

/**
 * Scenes panel: scene list (or thumbnails), Add / Update / Remove / Move Up / Move
 * Down, Show Details (name, description, Include in Animation, saved properties), search, play.
 * Thumbnails are captured from the viewport and kept in the UI store (not in the document).
 */
export function ScenesPanel(): JSX.Element {
  const app = useApp();
  const state = useDocumentState();
  const runtime = useSceneRuntime();
  const thumbnails = useAppStore((s) => s.sceneThumbnails);
  useEffect(() => installUiServices(app.commands), [app]);
  const [search, setSearch] = useState('');
  const [thumbs, setThumbs] = useState(false);
  const [details, setDetails] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const run = (id: string, params?: unknown) => app.commands.tryExecute(id, params);
  /** Run and return a numeric result (new entity id), or undefined on failure. */
  const runId = (id: string, params?: unknown): number | undefined => {
    const r = app.commands.tryExecute(id, params);
    return r.ok && typeof r.result === 'number' ? r.result : undefined;
  };
  const scenes = state.sceneOrder.map((id) => state.scenes.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
  // The active scene (tabs, activation) wins; the panel's own selection survives deletion/stop.
  const current = runtime.activeSceneId ?? selectedId;
  const scene = current !== null ? state.scenes.get(current as never) : undefined;
  const index = scene ? state.sceneOrder.indexOf(scene.id) : -1;
  const needle = search.trim().toLowerCase();
  const shown = scenes.filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle));

  const capture = (id: number) => {
    void app.viewport.captureThumbnail(THUMB_W, THUMB_H).then((url) => {
      if (url) useAppStore.getState().setSceneThumbnail(id, url);
    });
  };
  const add = () => {
    const id = runId('scene.add');
    if (typeof id === 'number') {
      setSelectedId(id);
      capture(id);
    }
  };
  const update = () => {
    if (!scene) return;
    run('scene.update', { id: scene.id });
    capture(scene.id);
  };
  const remove = () => {
    if (!scene) return;
    run('scene.delete', { id: scene.id });
    useAppStore.getState().setSceneThumbnail(scene.id, null);
    setSelectedId(null);
  };
  const move = (dir: -1 | 1) => {
    if (!scene || index < 0) return;
    run('scene.move', { id: scene.id, toIndex: index + dir });
  };
  const activate = (id: number) => {
    setSelectedId(id);
    run('scene.activate', { id, animate: true });
  };

  return (
    <div className="pf-outliner pf-scenes">
      <div className="pf-outliner-head">
        <button type="button" className="pf-iconbtn" aria-label="Add Scene" title="Add Scene" onClick={add}>
          <Icon name="plus" size={16} />
        </button>
        <button type="button" className="pf-iconbtn" aria-label="Update Scene" title="Update Scene" disabled={!scene} onClick={update}>
          <Icon name="refresh" size={16} />
        </button>
        <button type="button" className="pf-iconbtn" aria-label="Remove Scene" title="Remove Scene" disabled={!scene} onClick={remove}>
          <Icon name="trash" size={16} />
        </button>
        <button type="button" className="pf-iconbtn" aria-label="Move Scene Up" title="Move Up" disabled={!scene || index <= 0} onClick={() => move(-1)}>
          <Icon name="arrow-up" size={16} />
        </button>
        <button
          type="button"
          className="pf-iconbtn"
          aria-label="Move Scene Down"
          title="Move Down"
          disabled={!scene || index < 0 || index >= scenes.length - 1}
          onClick={() => move(1)}
        >
          <Icon name="arrow-down" size={16} />
        </button>
        <button
          type="button"
          className={`pf-iconbtn${details ? ' is-active' : ''}`}
          aria-label="Show Details"
          aria-pressed={details}
          title="Show Details"
          onClick={() => setDetails((v) => !v)}
        >
          <Icon name="info" size={16} />
        </button>
        <button
          type="button"
          className={`pf-iconbtn${thumbs ? ' is-active' : ''}`}
          aria-label={thumbs ? 'Show list' : 'Show thumbnails'}
          aria-pressed={thumbs}
          title={thumbs ? 'List' : 'Thumbnails'}
          onClick={() => setThumbs((v) => !v)}
        >
          <Icon name={thumbs ? 'list' : 'image'} size={16} />
        </button>
        <button
          type="button"
          className="pf-iconbtn"
          aria-label={runtime.playing ? 'Stop animation' : 'Play animation'}
          title={runtime.playing ? 'Stop' : 'Play'}
          disabled={scenes.length === 0}
          onClick={() => run('scene.play', { play: !runtime.playing })}
        >
          <Icon name={runtime.playing ? 'stop' : 'play'} size={16} />
        </button>
      </div>
      <input className="pf-outliner-filter" placeholder="Search" aria-label="Search scenes" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className={`pf-outliner-tree pf-scene-list${thumbs ? ' is-thumbs' : ''}`} role="listbox" aria-label="Scenes">
        {shown.length === 0 ? (
          <div className="pf-outliner-empty">{scenes.length ? 'No scenes match.' : 'No scenes. Click + to save the current view.'}</div>
        ) : (
          shown.map((s) => {
            const active = s.id === runtime.activeSceneId;
            const selected = s.id === current;
            const thumb = thumbnails[s.id as number];
            return (
              <div
                key={s.id}
                role="option"
                aria-selected={selected}
                className={`pf-scene-item${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}`}
                onClick={() => activate(s.id)}
                title={s.description || s.name}
              >
                {thumbs ? (
                  thumb ? (
                    <img className="pf-scene-thumb" src={thumb} alt="" width={THUMB_W / 2} height={THUMB_H / 2} />
                  ) : (
                    <div className="pf-scene-thumb is-empty" aria-hidden="true" />
                  )
                ) : null}
                <span className="pf-scene-name">{s.name}</span>
                {s.includeInAnimation === false ? <span className="pf-tag-count" title="Not in animation">—</span> : null}
              </div>
            );
          })
        )}
      </div>
      {details && scene ? (
        <div className="pf-form pf-scene-details">
          <div className="pf-form-row">
            <span className="pf-form-label">Name</span>
            <input
              className="pf-form-input"
              aria-label="Scene name"
              value={scene.name}
              onChange={(e) => run('scene.rename', { id: scene.id, name: e.target.value || scene.name })}
            />
          </div>
          <div className="pf-form-row">
            <span className="pf-form-label">Description</span>
            <textarea
              className="pf-form-textarea"
              aria-label="Scene description"
              value={scene.description}
              onChange={(e) => run('scene.rename', { id: scene.id, name: scene.name, description: e.target.value })}
            />
          </div>
          <label className="pf-form-check">
            <input
              type="checkbox"
              checked={scene.includeInAnimation !== false}
              onChange={(e) => run('scene.setIncludeInAnimation', { id: scene.id, value: e.target.checked })}
            />
            Include in Animation
          </label>
          <div className="pf-form-section">Properties to save</div>
          {FLAG_LABELS.map(([key, label]) => (
            <label key={key} className="pf-form-check">
              <input
                type="checkbox"
                checked={scene.flags[key]}
                onChange={(e) => run('scene.update', { id: scene.id, flags: { [key]: e.target.checked }, recapture: false })}
              />
              {label}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
