// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { JSX } from 'react';
import { useApp } from '../AppContext';
import { useAppStore } from '../store';
import { TOOL_HELP } from './instructorHelp';

/** Instructor: the active tool's title, its live step hint, and a static help blurb. */
export function InstructorPanel(): JSX.Element {
  const app = useApp();
  const toolId = useAppStore((s) => s.activeToolId);
  const instructor = useAppStore((s) => s.instructor);
  const tool = toolId ? app.toolManager.get(toolId) : undefined;
  const help = toolId ? TOOL_HELP[toolId] : undefined;
  return (
    <div className="pf-instructor">
      <h3 className="pf-instructor-title">{tool?.title ?? toolId ?? 'No tool'}</h3>
      {instructor ? <p className="pf-instructor-status">{instructor}</p> : null}
      {help ? (
        <>
          <p className="pf-instructor-summary">{help.summary}</p>
          {help.keys.length ? (
            <dl className="pf-instructor-keys" aria-label="Modifier keys">
              {help.keys.map(([key, meaning]) => (
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
