// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { createLayoutDocument } from '@pushform/layout';
import type * as IoModule from '@pushform/io';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createApp } from '../bootstrap';
import { DocumentSession } from '../session';
import { TopBar } from './TopBar';
import { LayoutImportDialog } from './LayoutImportDialog';

vi.mock('@pushform/io', async original => ({ ...await original<typeof IoModule>(), importSketchUpLayoutInWorker: vi.fn(async () => ({
  doc: createLayoutDocument(), warnings: [], properties: { version: null, created: null, modified: null, revision: null, pageCount: null } })) }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([true, false])('opens import notes in a modal only when there are limitations: %s', async hasWarnings => {
  const app = createApp({ demo: false, expose: false });
  const session = new DocumentSession(app, () => createApp({ demo: false, expose: false }), false, null);
  const warnings = hasWarnings ? ['Unsupported content was skipped (2×)', 'A viewport had no cached render'] : [];
  vi.spyOn(session, 'importSketchUpLayout').mockImplementation(() => ({ tab: session.newLayout(), warnings,
    properties: { version: null, created: null, modified: null, revision: null, pageCount: null } }));
  vi.stubGlobal('showOpenFilePicker', vi.fn().mockResolvedValue([{ name: 'Sheet.layout',
    getFile: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) }]));
  const view = render(<TopBar session={session} />);
  fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open…' }));
  await waitFor(() => expect(session.importSketchUpLayout).toHaveBeenCalledOnce());
  if (hasWarnings) {
    const dialog = await screen.findByRole('dialog', { name: 'LayOut import notes' });
    expect(dialog.closest('header')).toBeNull();
    expect(within(dialog).getAllByRole('listitem').map(item => item.textContent)).toEqual(warnings);
    expect(dialog.textContent).toContain('Sheet.layout');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Continue' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
  }
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(view.container.querySelector('.pf-file-notice')).toBeNull();
  view.unmount(); session.dispose(); app.dispose();
});

it('traps focus, blocks drafting shortcuts, and dismisses on Escape without changing the document', () => {
  const close = vi.fn(), shortcut = vi.fn();
  const view = render(<><button type="button">Previous</button></>);
  const previous = screen.getByRole('button', { name: 'Previous' }); previous.focus();
  view.rerender(<><button type="button">Previous</button><LayoutImportDialog fileName="Sheet.layout" warnings={['A limitation']} onClose={close} /></>);
  window.addEventListener('keydown', shortcut);
  fireEvent.keyDown(window, { key: 'l' }); expect(shortcut).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Import compatibility messages' }));
  fireEvent.keyDown(window, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.keyDown(window, { key: 'Escape' }); expect(close).toHaveBeenCalledOnce();
  view.rerender(<button type="button">Previous</button>);
  expect(document.activeElement).toBe(previous);
  window.removeEventListener('keydown', shortcut);
});
