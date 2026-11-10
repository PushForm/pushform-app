// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { CommandInfo } from '@pushform/commands';
import type { ToolbarCategory } from '@pushform/extension-protocol';
import { useApp } from '../AppContext';
import { useAppStore } from '../store';
import { Icon } from './Icon';
import { ToolButton } from './ToolButton';
import { ToolStack } from './ToolStack';
import { resolveGroups } from './toolbarLayout';

/**
 * A button an extension adds to the toolbar: it joins the end of the group named by `category`, after a thin
 * separator, and pressing it runs the extension's contribution as a user action.
 */
export interface ExtensionToolbarItem {
  readonly id: string;
  readonly category: ToolbarCategory;
  /** The tooltip: the contribution's name. */
  readonly title: string;
  /** The accessible name: the contribution's name, then the extension's. */
  readonly accessibleLabel: string;
  readonly icon: ReactNode;
  readonly onPress: () => void;
}

/** Horizontal tool row beneath document tabs, ordered by `TOOLBAR_LAYOUT`, with extension buttons at the end of their groups. */
export function MainToolbar({ extensionTools = [], onCommons }: { readonly extensionTools?: readonly ExtensionToolbarItem[]; readonly onCommons?: (() => void) | undefined } = {}): JSX.Element {
  const app = useApp();
  const activeToolId = useAppStore((s) => s.activeToolId);
  const [commands, setCommands] = useState<CommandInfo[]>(() => app.commands.list());

  useEffect(() => {
    const refresh = () => setCommands(app.commands.list());
    refresh();
    return app.commands.events.on('registered', refresh);
  }, [app]);

  const groups = useMemo(
    () => resolveGroups(commands, (id) => app.keymap.label(id)),
    [app, commands],
  );

  const activate = (commandId: string) => {
    app.commands.tryExecute(commandId);
    app.viewport.container?.focus();
  };

  return (
    <nav
      className="pf-toolbar pf-modeling-ribbon pf-layout-ribbon"
      data-orientation="horizontal"
      aria-label="Tools"
    >
      {groups.map((group) => {
        const added = extensionTools.filter((item) => item.category === group.title.toLowerCase());
        return (
        <div
          key={group.title}
          className="pf-layout-ribbon-group"
          role="group"
          aria-label={group.title}
        >
          <div className="pf-layout-ribbon-buttons">
            {group.slots.map((slot, i) => {
              if (slot.kind === 'sep') return <div key={`sep-${i}`} className="pf-toolbar-sep" />;
              if (slot.kind === 'stack') {
                return (
                  <ToolStack
                    key={slot.title}
                    title={slot.title}
                    tools={slot.tools}
                    activeId={activeToolId ?? ''}
                    onSelect={(id) => {
                      const item = slot.tools.find((t) => t.id === id);
                      if (item) activate(item.commandId);
                    }}
                  />
                );
              }
              const t = slot.tool;
              return (
                <ToolButton
                  key={t.id}
                  data-guidance-id={`toolbar:${t.id}`}
                  type="button"
                  className={`pf-toolbtn${activeToolId === t.id ? ' is-active' : ''}`}
                  title={t.key ? `${t.title} (${t.key})` : t.title}
                  aria-label={t.title}
                  aria-pressed={activeToolId === t.id}
                  onClick={() => activate(t.commandId)}
                >
                  <Icon name={t.icon} size={24} />
                </ToolButton>
              );
            })}
            {added.length ? <div className="pf-toolbar-sep pf-toolbar-sep-extensions" /> : null}
            {added.map((item) => (
              <ToolButton
                key={item.id}
                data-guidance-id={`toolbar:extension:${item.id}`}
                type="button"
                className="pf-toolbtn pf-toolbtn-extension"
                title={item.title}
                aria-label={item.accessibleLabel}
                onClick={() => { item.onPress(); app.viewport.container?.focus(); }}
              >
                {item.icon}
              </ToolButton>
            ))}
          </div>
          <span className="pf-layout-ribbon-caption" aria-hidden="true">
            {group.title}
          </span>
        </div>
        );
      })}
      {onCommons && <div className="pf-layout-ribbon-group" role="group" aria-label="Import">
        <div className="pf-layout-ribbon-buttons">
          <ToolButton type="button" className="pf-toolbtn" title="From file" aria-label="From file"
            data-guidance-id="toolbar:import" data-guidance-action="file.import" data-guidance-route="Toolbar > Import > From file"
            onClick={() => app.commands.tryExecute('file.import')}><Icon name="import" size={24}/></ToolButton>
          <ToolButton type="button" className="pf-toolbtn" title="Commons" aria-label="Commons"
            data-guidance-id="toolbar:commons" onClick={onCommons}><Icon name="commons" size={24}/></ToolButton>
        </div>
        <span className="pf-layout-ribbon-caption" aria-hidden="true">Import</span>
      </div>}
    </nav>
  );
}
