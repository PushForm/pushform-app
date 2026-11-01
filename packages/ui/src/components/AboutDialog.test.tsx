// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AboutDialog } from './AboutDialog';
import { UNKNOWN_BUILD, formatBuildDate } from '../buildInfo';

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('AboutDialog', () => {
  it('shows version, build commit, UTC build time and copyright, and closes with its button or Escape', () => {
    const onClose = vi.fn();
    render(<AboutDialog build={{ version: '26.44.42', commit: 'f2c30d4', date: '2026-10-22T14:03:27.000Z' }} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'About PushForm' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Version26.44.42');
    expect(dialog.textContent).toContain('Buildf2c30d4');
    const time = dialog.querySelector('time')!;
    expect(time.getAttribute('datetime')).toBe('2026-10-22T14:03:27.000Z');
    expect(time.textContent).toBe('2026-10-22 14:03 UTC');
    expect(dialog.textContent).toContain('© 2026 JobCraft, Inc.');
    const close = screen.getByRole('button', { name: 'Close about dialog' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: 'Tab' });
    const license = screen.getByRole('link', { name: 'GNU GPLv3 license' });
    expect(document.activeElement).toBe(license);
    expect(license.getAttribute('href')).toBe('https://www.gnu.org/licenses/gpl-3.0.html');
    expect(license.getAttribute('target')).toBe('_blank');
    expect(license.getAttribute('rel')).toBe('noopener noreferrer');
    fireEvent.keyDown(window, { key: 'Tab' });
    const source = screen.getByRole('link', { name: 'Source code on GitHub' });
    expect(document.activeElement).toBe(source);
    expect(source.getAttribute('href')).toBe('https://github.com/PushForm/pushform-app');
    expect(source.getAttribute('target')).toBe('_blank');
    expect(source.getAttribute('rel')).toBe('noopener noreferrer');
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(source);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('reports unknown values when the host supplied no build identity', () => {
    render(<AboutDialog build={UNKNOWN_BUILD} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'About PushForm' });
    expect(dialog.textContent).toContain('Versionunknown');
    expect(dialog.textContent).toContain('Buildunknown');
    expect(dialog.textContent).toContain('Builtunknown');
    expect(dialog.querySelector('time')).toBeNull();
  });

  it('makes the app inert while open and restores the previous focus on close', () => {
    const app = document.createElement('div');
    app.className = 'pf-app';
    const trigger = document.createElement('button');
    app.append(trigger);
    document.body.append(app);
    trigger.focus();
    const { unmount } = render(<AboutDialog build={UNKNOWN_BUILD} onClose={() => {}} />);
    expect(app.inert).toBe(true);
    expect(document.activeElement).not.toBe(trigger);
    unmount();
    expect(app.inert).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});

describe('formatBuildDate', () => {
  it('normalizes any parseable timestamp to UTC minutes and passes other text through', () => {
    expect(formatBuildDate('2026-10-22T16:03:27+02:00')).toBe('2026-10-22 14:03 UTC');
    expect(formatBuildDate('2026-10-22T23:59:59.999Z')).toBe('2026-10-22 23:59 UTC');
    expect(formatBuildDate('not a date')).toBe('not a date');
    expect(formatBuildDate('')).toBe('unknown');
  });
});
