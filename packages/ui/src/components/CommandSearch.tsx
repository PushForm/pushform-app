// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import type { CommandInfo, CommandRegistry, Keymap } from '@pushform/commands';
import { useAppStore } from '../store';
import type { CommandSearchSource } from './commandSearchSource';
import { Icon } from './Icon';

/** DOM id of the search input, so `view.search` can focus it. */
export const COMMAND_SEARCH_INPUT_ID = 'pf-command-search';

const MAX_RESULTS = 12;

export interface CommandSearchProps {
  /**
   * Source for the active document (see `commandSearchSourceFor`); called on every query so a
   * tab switch is picked up without remounting.
   */
  readonly source: () => CommandSearchSource;
}

export interface SearchItem {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly key: string | null;
  readonly enabled: boolean;
}

/**
 * Search box for the top bar: indexes every runnable command of the active document's source
 * (tools and one-shot commands that need no parameters), so each mode only offers its own tools.
 * Cmd/Ctrl+K (and the `view.search` command) focus it; typing filters; ArrowUp/Down move; Enter
 * runs; Escape clears and leaves. Results show icon, name and shortcut.
 */
export function CommandSearch({ source }: CommandSearchProps): JSX.Element {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [tick, setTick] = useState(0);

  // Cmd/Ctrl+K from anywhere, including text fields, focuses the search.
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // Re-index when the active registry gains commands (tools register after mount).
  useEffect(() => {
    const reg = source().registry;
    return reg.events.on('registered', () => setTick((t) => t + 1));
  }, [source, tick, focused]);

  const results = useMemo(
    () => {
      if (!query.trim()) return [];
      const { registry, keymap } = source();
      return searchCommands(registry, keymap, query);
    },
    // `tick` forces a refresh after registrations; `focused` re-reads the active tab's source.
    [source, query, tick, focused],
  );
  const open = focused && results.length > 0;
  const highlighted = Math.min(active, Math.max(0, results.length - 1));

  const close = (): void => {
    setQuery('');
    setActive(0);
    input.current?.blur();
  };
  const run = (item: SearchItem): void => {
    if (!item.enabled) return;
    const { registry, focusWorkspace } = source();
    const outcome = registry.tryExecute(item.id);
    close();
    if (!outcome.ok) {
      useAppStore.getState().setNotice(`${item.title}: ${describe(outcome.error)}`);
      return;
    }
    focusWorkspace();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      source().focusWorkspace();
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActive((highlighted + delta + results.length) % results.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = results[highlighted];
      if (item) run(item);
    }
  };

  return (
    <div className="pf-cmd-search">
      <Icon name="search" size={16} />
      <input
        ref={input}
        id={COMMAND_SEARCH_INPUT_ID}
        className="pf-cmd-search-input"
        type="search"
        role="combobox"
        aria-label="Search tools and commands"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? optionId(listId, highlighted) : undefined}
        placeholder={`Search tools and commands (${shortcutHint()})`}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <ul
          id={listId}
          className="pf-cmd-search-list"
          role="listbox"
          aria-label="Matching commands"
        >
          {results.map((item, i) => (
            <li
              key={item.id}
              id={optionId(listId, i)}
              role="option"
              aria-selected={i === highlighted}
              aria-disabled={!item.enabled}
              className={`pf-cmd-search-item${i === highlighted ? ' is-active' : ''}${item.enabled ? '' : ' is-disabled'}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(item)}
            >
              <Icon name={item.icon} size={16} />
              <span className="pf-cmd-search-title">{item.title}</span>
              {item.key ? <kbd aria-hidden="true">{item.key}</kbd> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const optionId = (listId: string, i: number): string => `${listId}-opt-${i}`;

function shortcutHint(): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return mac ? '⌘K' : 'Ctrl+K';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Commands a user can run from a search box: visible category and no required parameters. The
 * shortcut label comes from the keymap; a document without a keymap shows the command's own
 * keybinding hint.
 */
export function searchableCommands(registry: CommandRegistry, keymap: Keymap | null): SearchItem[] {
  const out: SearchItem[] = [];
  for (const c of registry.list()) {
    if (c.category === 'internal') continue;
    if (!acceptsNoParams(registry, c)) continue;
    out.push({
      id: c.id,
      title: c.title,
      icon: c.icon ?? (c.id.startsWith('tool.') ? `tool-${c.id.slice(5)}` : 'command'),
      key: keymap ? keymap.label(c.id) : (c.keybinding ?? null),
      enabled: c.enabled,
    });
  }
  return out;
}

function acceptsNoParams(registry: CommandRegistry, c: CommandInfo): boolean {
  const cmd = registry.get(c.id);
  if (!cmd) return false;
  try {
    return cmd.params.safeParse({}).success;
  } catch {
    return false;
  }
}

/** Rank commands against a query: exact title > title prefix > word prefix > substring > id substring. */
export function searchCommands(
  registry: CommandRegistry,
  keymap: Keymap | null,
  query: string,
): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { item: SearchItem; score: number }[] = [];
  for (const item of searchableCommands(registry, keymap)) {
    const title = item.title.toLowerCase();
    let score = 0;
    if (title.replace(/(?:…|\.{3})$/, '').trim() === q.replace(/(?:…|\.{3})$/, '').trim()) score = 5;
    else if (title.startsWith(q)) score = 4;
    else if (title.split(/[\s/]+/).some((w) => w.startsWith(q))) score = 3;
    else if (title.includes(q)) score = 2;
    else if (item.id.toLowerCase().includes(q)) score = 1;
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  return scored.slice(0, MAX_RESULTS).map((s) => s.item);
}
