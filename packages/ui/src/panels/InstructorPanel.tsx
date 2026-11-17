// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { JSX } from 'react';
import { useApp } from '../AppContext';
import { useAppStore } from '../store';
import type { ToolSetting } from '@pushform/commands';
import { TOOL_HELP } from './instructorHelp';
import { platformKeyText } from '../platformKeys';

/** Instructor: the active tool's title, its live step hint, and a static help blurb. */
export function InstructorPanel(): JSX.Element {
  const app = useApp();
  const toolId = useAppStore((s) => s.activeToolId);
  const instructor = useAppStore((s) => s.instructor);
  const settings = useAppStore((s) => s.toolSettings);
  const tool = toolId ? app.toolManager.get(toolId) : undefined;
  const help = toolId ? TOOL_HELP[toolId] : undefined;
  const mac = app.keymap.platform === 'mac';
  // the Ctrl and Alt taps come from the bar's own toggles, so the help names exactly the keys handled
  const keys = [...barKeys(settings), ...(help?.keys ?? [])].map(([k, m]) => [platformKeyText(k, mac), m] as const);
  return (
    <div className="pf-instructor">
      <h3 className="pf-instructor-title">{tool?.title ?? toolId ?? 'No tool'}</h3>
      {instructor ? <p className="pf-instructor-status">{instructor}</p> : null}
      {help ? (
        <>
          <p className="pf-instructor-summary">{help.summary}</p>
          {keys.length ? (
            <dl className="pf-instructor-keys" aria-label="Modifier keys">
              {keys.map(([key, meaning]) => (
                <div key={key} style={{ display: 'contents' }}>
                  <dt>{key}</dt>
                  <dd>{meaning}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      ) : (
        <p className="pf-ei-muted">No help is written for this tool yet.</p>
      )}
    </div>
  );
}

/** Key rows for the bar's toggles and keyed choices: "Ctrl" taps toggle Copy, "Alt" taps cycle a mode. */
export function barKeys(settings: readonly ToolSetting[]): (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  for (const c of settings) {
    if ((c.kind !== 'toggle' && c.kind !== 'choice') || !c.key) continue;
    const key = c.key === 'primary' ? 'Ctrl' : 'Alt';
    out.push([key, c.kind === 'toggle' ? `Tap to turn ${c.label} on or off` : `Tap to switch ${c.label.toLowerCase()}: ${c.options.map((o) => o.label).join(', ')}`]);
  }
  return out;
}

