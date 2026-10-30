// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DesktopUpdates } from './DesktopUpdates';
import { AboutDialog } from './AboutDialog';
import { DesktopUpdates as Updater, UPDATE_GRACE, setDesktopUpdates, type UpdateBackend } from '../desktopUpdates';
import { UNKNOWN_BUILD } from '../buildInfo';

afterEach(() => { cleanup(); document.body.innerHTML = ''; setDesktopUpdates(undefined); });

async function ready(options: { version?: string | null; enabled?: boolean; overdue?: boolean } = {}) {
  let time = Date.parse('2026-10-26T12:00:00Z');
  const data = new Map<string, string>();
  const backend = {
    enabled: vi.fn<UpdateBackend['enabled']>().mockResolvedValue(options.enabled ?? true),
    fetch: vi.fn<UpdateBackend['fetch']>().mockResolvedValue(options.version === null ? null : { version: options.version ?? '26.45.3' }),
    install: vi.fn<UpdateBackend['install']>().mockReturnValue(new Promise(() => {})),
  };
  const updates = new Updater(backend, { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } }, () => time);
  await act(async () => { updates.start(); await new Promise(resolve => setTimeout(resolve, 0)); });
  if (options.overdue) time += UPDATE_GRACE;
  setDesktopUpdates(updates);
  return { updates, backend };
}

describe('DesktopUpdates', () => {
  it('renders nothing in the browser', () => {
    setDesktopUpdates(null);
    const { container } = render(<DesktopUpdates saveAll={async () => {}} />);
    expect(container.innerHTML).toBe('');
    expect(document.body.textContent).toBe('');
  });

  it('shows a non-modal notice once an update is ready, hidden by Later', async () => {
    const { updates } = await ready();
    render(<DesktopUpdates saveAll={async () => {}} updates={updates} />);
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain('PushForm 26.45.3 is ready to install.');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows nothing while the app is current', async () => {
    const { updates } = await ready({ version: null });
    render(<DesktopUpdates saveAll={async () => {}} updates={updates} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('saves before restarting, and keeps the app open with a message when saving fails', async () => {
    const { updates, backend } = await ready();
    const saveAll = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    render(<DesktopUpdates saveAll={saveAll} updates={updates} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restart to update' })); });
    expect(backend.install).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('The update waits until your changes are saved.');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restart to update' })); });
    expect(saveAll).toHaveBeenCalledTimes(2);
    expect(backend.install).toHaveBeenCalledOnce();
    expect((screen.getByRole('button', { name: 'Restarting…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the modal Update required dialog instead of opening a document once overdue; Cancel keeps working', async () => {
    const { updates, backend } = await ready({ overdue: true });
    render(<DesktopUpdates saveAll={async () => {}} updates={updates} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { expect(updates.allowOpening()).toBe(false); });
    const dialog = screen.getByRole('dialog', { name: 'Update required' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('PushForm 26.45.3');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { updates.allowOpening(); });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => { updates.allowOpening(); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restart and update' })); });
    expect(backend.install).toHaveBeenCalledOnce();
  });

  it('shows the update channel in About and switches it', async () => {
    const { updates, backend } = await ready({ version: null });
    render(<AboutDialog build={UNKNOWN_BUILD} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'About PushForm' });
    expect(dialog.textContent).toContain('UpdatesStable');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Switch to Nightly' })); });
    expect(dialog.textContent).toContain('UpdatesNightly');
    expect(backend.fetch).toHaveBeenLastCalledWith('nightly');
    expect(updates.getSnapshot().channel).toBe('nightly');
  });

  it('checks immediately from About, prevents duplicate requests and reports current or failed checks', async () => {
    const { backend } = await ready({ version: null });
    render(<AboutDialog build={UNKNOWN_BUILD} onClose={() => {}} />);
    let finish!: (value: null) => void;
    backend.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const button = screen.getByRole('button', { name: 'Check for updates' });
    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Checking for updates…');
    fireEvent.click(button);
    expect(backend.fetch).toHaveBeenCalledTimes(2); // startup and manual check
    await act(async () => { finish(null); });
    expect(screen.getByRole('status').textContent).toBe('PushForm is up to date.');
    backend.fetch.mockRejectedValueOnce(new Error('private provider details'));
    await act(async () => { fireEvent.click(button); });
    expect(screen.getByRole('status').textContent).toBe('Could not check for updates. Try again.');
    expect(document.body.textContent).not.toContain('private provider details');
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows no channel in About for a build without the updater key', async () => {
    await ready({ enabled: false });
    render(<AboutDialog build={UNKNOWN_BUILD} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'About PushForm' }).textContent).not.toContain('Updates');
  });
});
