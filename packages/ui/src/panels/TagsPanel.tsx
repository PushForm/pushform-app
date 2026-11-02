// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { AiOutlineFolderAdd } from 'react-icons/ai';
import { TAG_DASHES, tagUsage } from '@pushform/commands';
import type { Tag, TagFolder } from '@pushform/model';
import { useApp } from '../AppContext';
import { Icon } from '../components/Icon';
import { installUiServices } from '../engine/uiServices';
import { useDocumentState } from '../hooks/useDocument';
import { useAppStore } from '../store';
import { cssToRgb, rgbToCss } from './colors';

const DASH_LABELS: Record<string, string> = {
  solid: 'Default',
  dash: 'Dash',
  dot: 'Dot',
  dashDot: 'Dash dot',
  longDash: 'Long dash',
  shortDash: 'Short dash',
};

function InlineName({ value, label, onDone }: { value: string; label: string; onDone: (name: string | null) => void }): JSX.Element {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onDone(text);
    else if (e.key === 'Escape') onDone(null);
    e.stopPropagation();
  };
  return (
    <input
      ref={ref}
      className="pf-outliner-rename"
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => onDone(text)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

interface TagRowProps {
  readonly tag: Tag;
  readonly uses: number;
  readonly active: boolean;
  readonly selected: boolean;
  readonly depth: number;
  readonly renaming: boolean;
  onSelect(): void;
  onStartRename(): void;
  onRename(name: string | null): void;
}

function TagRow(p: TagRowProps): JSX.Element {
  const app = useApp();
  const { tag } = p;
  const run = (id: string, params: unknown) => app.commands.tryExecute(id, params);
  const cls = ['pf-tag-row', p.selected ? 'is-selected' : '', tag.visible ? '' : 'is-hidden', p.active ? 'is-active' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} role="row" aria-selected={p.selected} style={{ paddingLeft: 4 + p.depth * 14 }} onClick={p.onSelect} data-tag-id={tag.id}>
      <button
        type="button"
        className="pf-outliner-eye"
        aria-label={tag.visible ? `Hide ${tag.name}` : `Show ${tag.name}`}
        aria-pressed={!tag.visible}
        onClick={(e) => {
          e.stopPropagation();
          run('tag.setVisible', { ids: [tag.id], visible: !tag.visible });
        }}
      >
        <Icon name={tag.visible ? 'eye' : 'eye-off'} size={14} />
      </button>
      <button
        type="button"
        className={`pf-tag-pencil${p.active ? ' is-active' : ''}`}
        aria-label={p.active ? `${tag.name} is the active tag` : `Make ${tag.name} the active tag`}
        title={p.active ? `New objects use ${tag.name}` : `Use ${tag.name} for new objects`}
        aria-pressed={p.active}
        onClick={(e) => {
          e.stopPropagation();
          run('tag.setActive', { id: tag.id });
        }}
      >
        <Icon name="pencil" size={13} />
      </button>
      {p.renaming ? (
        <InlineName value={tag.name} label="Tag name" onDone={p.onRename} />
      ) : (
        <span className="pf-tag-name" onDoubleClick={p.onStartRename} title={`${tag.name} (${p.uses} ${p.uses === 1 ? 'entity' : 'entities'})`}>
          {tag.name}
        </span>
      )}
      <input
        type="color"
        className="pf-tag-color"
        aria-label={`${tag.name} color`}
        value={rgbToCss(tag.color)}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => run('tag.setColor', { id: tag.id, color: cssToRgb(e.target.value) })}
      />
      <select
        className="pf-tag-dashes"
        aria-label={`${tag.name} dashes`}
        value={tag.dashes ?? 'solid'}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => run('tag.setDashes', { id: tag.id, dashes: e.target.value })}
      >
        {TAG_DASHES.map((d) => (
          <option key={d} value={d}>
            {DASH_LABELS[d] ?? d}
          </option>
        ))}
      </select>
    </div>
  );
}

type DeleteChoice = 'untagged' | 'current' | 'delete';

/**
 * Tags panel: tag and folder rows with visibility, the active-tag pencil, inline
 * rename, color swatch and dash pattern; Add Tag / Add Folder / Delete (with a
 * "what happens to the entities" choice inline); filter; Color by Tag; details menu.
 */
export function TagsPanel(): JSX.Element {
  const app = useApp();
  const state = useDocumentState();
  const activeTagId = useAppStore((s) => s.display.activeTagId);
  useEffect(() => installUiServices(app.commands), [app]);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const [deleting, setDeleting] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const run = (id: string, params?: unknown) => app.commands.tryExecute(id, params);
  /** Run and return a numeric result (new entity id), or undefined on failure. */
  const runId = (id: string, params?: unknown): number | undefined => {
    const r = app.commands.tryExecute(id, params);
    return r.ok && typeof r.result === 'number' ? r.result : undefined;
  };
  const uses = useMemo(() => tagUsage(state), [state]);
  const colorByTag = state.styles.get(state.activeStyleId)?.modeling.colorByTag === true;
  const effectiveActive = activeTagId ?? state.defaultTagId;
  const needle = filter.trim().toLowerCase();
  const matches = (name: string) => !needle || name.toLowerCase().includes(needle);

  const tags = [...state.tags.values()];
  const folders = [...state.tagFolders.values()];
  const selectedTag = selectedId !== null ? state.tags.get(selectedId as never) : undefined;
  const selectedFolder = selectedId !== null && !selectedTag ? state.tagFolders.get(selectedId as never) : undefined;
  const canDelete = (selectedTag && selectedTag.id !== state.defaultTagId) || !!selectedFolder;

  const rows: JSX.Element[] = [];
  const renderTag = (tag: Tag, depth: number) => {
    if (!matches(tag.name)) return;
    rows.push(
      <TagRow
        key={`t${tag.id}`}
        tag={tag}
        uses={uses.get(tag.id) ?? 0}
        active={tag.id === effectiveActive}
        selected={selectedId === tag.id}
        depth={depth}
        renaming={renamingId === tag.id}
        onSelect={() => setSelectedId(tag.id)}
        onStartRename={() => setRenamingId(tag.id)}
        onRename={(name) => {
          setRenamingId(null);
          if (name !== null && name.trim() && name.trim() !== tag.name) run('tag.rename', { id: tag.id, name });
        }}
      />,
    );
  };
  const renderFolder = (folder: TagFolder, depth: number) => {
    const open = !collapsed.has(folder.id);
    const children = tags.filter((t) => t.folderId === folder.id);
    const subs = folders.filter((f) => f.parentId === folder.id);
    rows.push(
      <div
        key={`f${folder.id}`}
        className={`pf-tag-row is-folder${selectedId === folder.id ? ' is-selected' : ''}${folder.visible ? '' : ' is-hidden'}`}
        role="row"
        aria-selected={selectedId === folder.id}
        style={{ paddingLeft: 4 + depth * 14 }}
        onClick={() => setSelectedId(folder.id)}
      >
        <button
          type="button"
          className="pf-outliner-eye"
          aria-label={folder.visible ? `Hide folder ${folder.name}` : `Show folder ${folder.name}`}
          aria-pressed={!folder.visible}
          onClick={(e) => {
            e.stopPropagation();
            run('tag.folder.setVisible', { id: folder.id, visible: !folder.visible });
          }}
        >
          <Icon name={folder.visible ? 'eye' : 'eye-off'} size={14} />
        </button>
        <button
          type="button"
          className="pf-outliner-toggle"
          aria-label={open ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(folder.id)) next.delete(folder.id);
              else next.add(folder.id);
              return next;
            });
          }}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        </button>
        {renamingFolderId === folder.id ? (
          <InlineName
            value={folder.name}
            label="Folder name"
            onDone={(name) => {
              setRenamingFolderId(null);
              if (name !== null && name.trim() && name.trim() !== folder.name) run('tag.folder.rename', { id: folder.id, name });
            }}
          />
        ) : (
          <span className="pf-tag-name is-folder" onDoubleClick={() => setRenamingFolderId(folder.id)}>
            {folder.name}
          </span>
        )}
        <span className="pf-tag-count">{children.length}</span>
      </div>,
    );
    if (open) {
      for (const sub of subs) renderFolder(sub, depth + 1);
      for (const t of children) renderTag(t, depth + 1);
    }
  };
  for (const f of folders.filter((f) => f.parentId === null)) renderFolder(f, 0);
  for (const t of tags.filter((t) => t.folderId === null)) renderTag(t, 0);

  const addTag = () => {
    const id = runId('tag.create', { folderId: selectedFolder ? selectedFolder.id : (selectedTag?.folderId ?? null) });
    if (typeof id === 'number') {
      setSelectedId(id);
      setRenamingId(id);
    }
  };
  const addFolder = () => {
    const id = runId('tag.folder.create', { tagIds: selectedTag && selectedTag.id !== state.defaultTagId ? [selectedTag.id] : [] });
    if (typeof id === 'number') {
      setSelectedId(id);
      setRenamingFolderId(id);
    }
  };
  const confirmDelete = (choice: DeleteChoice) => {
    if (deleting === null) return;
    if (state.tags.has(deleting as never)) run('tag.delete', { id: deleting, contents: choice });
    else run('tag.folder.delete', { id: deleting });
    setDeleting(null);
    setSelectedId(null);
  };

  return (
    <div className="pf-outliner pf-tags" onClick={() => menuOpen && setMenuOpen(false)}>
      <div className="pf-outliner-head">
        <button type="button" className="pf-iconbtn" aria-label="Add Tag" title="Add Tag" onClick={addTag}>
          <Icon name="plus" size={16} />
        </button>
        <button type="button" className="pf-iconbtn" aria-label="Add Folder" title="Add Folder" onClick={addFolder}>
          <AiOutlineFolderAdd size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="pf-iconbtn"
          aria-label="Delete Tag"
          title="Delete"
          disabled={!canDelete}
          onClick={() => {
            if (selectedFolder) setDeleting(selectedFolder.id);
            else if (selectedTag) setDeleting(selectedTag.id);
          }}
        >
          <Icon name="minus" size={16} />
        </button>
        <input className="pf-outliner-filter" placeholder="Filter" aria-label="Filter tags" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="pf-outliner-details">
          <button
            type="button"
            className="pf-iconbtn"
            aria-label="Details"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >
            <Icon name="more-vertical" size={16} />
          </button>
          {menuOpen ? (
            <div className="pf-menu pf-outliner-menu" role="menu">
              <div className="pf-menu-item" role="menuitem" onClick={() => run('tag.selectAll', { id: selectedTag ? selectedTag.id : effectiveActive })}>
                Select All
              </div>
              <div className="pf-menu-item" role="menuitem" onClick={() => run('tag.purge')}>
                Purge
              </div>
              <div className="pf-menu-item" role="menuitemcheckbox" aria-checked={colorByTag} onClick={() => run('view.colorByTag')}>
                {colorByTag ? '✓ ' : ''}Color by Tag
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {deleting !== null ? (
        <div className="pf-tag-delete" role="group" aria-label="Delete tag">
          <div className="pf-form-note">
            {state.tags.has(deleting as never)
              ? `Delete "${state.tags.get(deleting as never)?.name}". Entities on this tag:`
              : `Delete folder "${state.tagFolders.get(deleting as never)?.name}" (its tags move up).`}
          </div>
          <div className="pf-form-actions">
            {state.tags.has(deleting as never) ? (
              <>
                <button type="button" className="pf-btn" onClick={() => confirmDelete('untagged')}>
                  Move to Untagged
                </button>
                <button type="button" className="pf-btn" onClick={() => confirmDelete('current')}>
                  Move to Current
                </button>
                <button type="button" className="pf-btn" onClick={() => confirmDelete('delete')}>
                  Delete Entities
                </button>
              </>
            ) : (
              <button type="button" className="pf-btn" onClick={() => confirmDelete('untagged')}>
                Delete Folder
              </button>
            )}
            <button type="button" className="pf-btn" onClick={() => setDeleting(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <div className="pf-outliner-tree pf-tag-list" role="table" aria-label="Tags">
        {rows.length ? rows : <div className="pf-outliner-empty">No tags match.</div>}
      </div>
      <label className="pf-form-check">
        <input type="checkbox" checked={colorByTag} onChange={(e) => run('view.colorByTag', { value: e.target.checked })} />
        Color by Tag
      </label>
    </div>
  );
}
