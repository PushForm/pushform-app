// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { CommandInfo } from '@pushform/commands';
import { useApp } from '../AppContext';
import { useAppStore } from '../store';
import { Icon } from './Icon';
import { ToolButton } from './ToolButton';
import { ToolStack } from './ToolStack';
import { resolveGroups } from './toolbarLayout';

/** Horizontal tool row beneath document tabs, ordered by `TOOLBAR_LAYOUT`. */
export function MainToolbar(): JSX.Element {
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
      {groups.map((group) => (
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
          </div>
          <span className="pf-layout-ribbon-caption" aria-hidden="true">
            {group.title}
          </span>
        </div>
      ))}
    </nav>
  );
}
