// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DocumentTabs } from './DocumentTabs';
import { DocumentSession } from '../session';
import { createApp } from '../bootstrap';

afterEach(cleanup);
it.each(['model', 'layout'] as const)('edits %s tab names inline, commits nonempty names and cancels with Escape', type => {
  const session = new DocumentSession(createApp({ demo: false, expose: false }), () => createApp({ demo: false, expose: false }), true, null);
  try {
    const tab = type === 'layout' ? session.newLayout() : session.active;
    const original = tab.name;
    const view = render(<DocumentTabs session={session} onNewLayout={() => {}} />);
    const open = () => fireEvent.doubleClick(screen.getByRole('button', { name: new RegExp(`${type === 'model' ? '3D model' : '2D drawing'}:`) }));
    open();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  New name  ' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(tab.name).toBe(type === 'model' ? 'New name.pf' : 'New name.pfl');
    view.rerender(<DocumentTabs session={session} onNewLayout={() => {}} />);
    open();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: original } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(tab.name).toContain('New name');
    open();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' ' } });
    fireEvent.blur(screen.getByRole('textbox'));
    expect(tab.name).toContain('New name');
    open();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Blurred' } });
    fireEvent.blur(screen.getByRole('textbox'));
    expect(tab.name).toContain('Blurred');
  } finally { session.dispose(); }
});
