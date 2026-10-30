// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DockSlot, SIDE_PANEL_DEFAULT_WIDTH, SIDE_PANEL_MAX_WIDTH, SIDE_PANEL_MIN_WIDTH, SIDE_PANEL_WIDTH_KEY, SideDock, SideRail, readSidePanelWidth } from './SideRail';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

const items = [{ id: 'objects', label: 'Object browser', icon: <svg /> }, { id: 'requests', label: 'AI Chat', icon: <svg /> }];
const separator = (): HTMLElement => screen.getByRole('separator', { name: 'Resize side panel' });
const dock = (): HTMLElement => separator().parentElement!;

describe('SideRail', () => {
  it('shows one labelled toggle per panel in order with a pressed state', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<SideRail items={items} active={null} onToggle={onToggle} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map(button => [button.getAttribute('aria-label'), button.getAttribute('aria-pressed')]))
      .toEqual([['Object browser', 'false'], ['AI Chat', 'false']]);
    expect(screen.getByRole('navigation', { name: 'Left menu bar' }).getAttribute('data-orientation')).toBe('vertical');
    fireEvent.mouseEnter(buttons[0]!);
    expect(screen.getByRole('tooltip').textContent).toBe('Object browser');
    fireEvent.mouseLeave(buttons[0]!);
    fireEvent.click(buttons[1]!);
    expect(onToggle).toHaveBeenCalledWith('requests');
    rerender(<SideRail items={items} active="requests" onToggle={onToggle} />);
    expect(screen.getByRole('button', { name: 'AI Chat' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'AI Chat' }).classList.contains('is-active')).toBe(true);
    expect(screen.getByRole('button', { name: 'Object browser' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('SideDock', () => {
  it('starts at the default width, hides without unmounting its content, and exposes a vertical separator', () => {
    const { rerender } = render(<SideDock open><textarea aria-label="kept" defaultValue="draft" /></SideDock>);
    expect(dock().style.width).toBe(`${SIDE_PANEL_DEFAULT_WIDTH}px`);
    expect(separator().getAttribute('aria-orientation')).toBe('vertical');
    expect([separator().getAttribute('aria-valuenow'), separator().getAttribute('aria-valuemin'), separator().getAttribute('aria-valuemax')])
      .toEqual(['300', '220', '560']);
    expect(separator().tabIndex).toBe(0);
    const field = screen.getByLabelText('kept');
    rerender(<SideDock open={false}><textarea aria-label="kept" defaultValue="draft" /></SideDock>);
    expect(field.closest('.pf-side-dock')?.hasAttribute('hidden')).toBe(true);
    expect(field.isConnected).toBe(true);
  });

  it('resizes with the arrow keys within 220 to 560 px, remembers the width, and keeps the keys from workspace shortcuts', () => {
    const shortcuts = vi.fn(); window.addEventListener('keydown', shortcuts);
    render(<SideDock open><p>panel</p></SideDock>);
    fireEvent.keyDown(separator(), { key: 'ArrowRight' });
    expect(separator().getAttribute('aria-valuenow')).toBe('310');
    fireEvent.keyDown(separator(), { key: 'ArrowLeft', shiftKey: true });
    expect(separator().getAttribute('aria-valuenow')).toBe('260');
    fireEvent.keyDown(separator(), { key: 'Home' });
    fireEvent.keyDown(separator(), { key: 'ArrowLeft' });
    expect(separator().getAttribute('aria-valuenow')).toBe(String(SIDE_PANEL_MIN_WIDTH));
    fireEvent.keyDown(separator(), { key: 'End' });
    fireEvent.keyDown(separator(), { key: 'ArrowRight' });
    expect(separator().getAttribute('aria-valuenow')).toBe(String(SIDE_PANEL_MAX_WIDTH));
    expect(dock().style.width).toBe(`${SIDE_PANEL_MAX_WIDTH}px`);
    expect(shortcuts).not.toHaveBeenCalled();
    window.removeEventListener('keydown', shortcuts);
    expect(localStorage.getItem(SIDE_PANEL_WIDTH_KEY)).toBe('560');
    cleanup();
    render(<SideDock open><p>panel</p></SideDock>);
    expect(separator().getAttribute('aria-valuenow')).toBe('560');
  });

  it('resizes by dragging its right edge and stores the width on release', () => {
    render(<SideDock open><p>panel</p></SideDock>);
    fireEvent.pointerDown(separator(), { button: 0, clientX: 400 });
    fireEvent.pointerMove(window, { clientX: 450 });
    expect(dock().style.width).toBe('350px');
    expect(localStorage.getItem(SIDE_PANEL_WIDTH_KEY)).toBeNull();
    fireEvent.pointerMove(window, { clientX: 2000 });
    expect(dock().style.width).toBe('560px');
    fireEvent.pointerUp(window, { clientX: 380 });
    expect(dock().style.width).toBe('280px');
    expect(localStorage.getItem(SIDE_PANEL_WIDTH_KEY)).toBe('280');
    fireEvent.pointerMove(window, { clientX: 600 });
    expect(dock().style.width).toBe('280px');
  });

  it('falls back to the default width when storage is unreadable or holds junk', () => {
    localStorage.setItem(SIDE_PANEL_WIDTH_KEY, 'wide');
    expect(readSidePanelWidth()).toBe(SIDE_PANEL_DEFAULT_WIDTH);
    localStorage.setItem(SIDE_PANEL_WIDTH_KEY, '9000');
    expect(readSidePanelWidth()).toBe(SIDE_PANEL_MAX_WIDTH);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<SideDock open><p>panel</p></SideDock>);
    expect(separator().getAttribute('aria-valuenow')).toBe(String(SIDE_PANEL_DEFAULT_WIDTH));
    fireEvent.keyDown(separator(), { key: 'ArrowRight' });
    expect(separator().getAttribute('aria-valuenow')).toBe('310');
    // A remount, as on a tab switch, keeps the width chosen this session.
    cleanup();
    render(<SideDock open><p>panel</p></SideDock>);
    expect(separator().getAttribute('aria-valuenow')).toBe('310');
    expect(readSidePanelWidth()).toBe(310);
  });

  it('never shows the panel wider than 60% of the window and reports the width shown', () => {
    localStorage.setItem(SIDE_PANEL_WIDTH_KEY, '500');
    const width = window.innerWidth;
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
      render(<SideDock open><p>panel</p></SideDock>);
      expect(dock().style.width).toBe('360px');
      expect([separator().getAttribute('aria-valuenow'), separator().getAttribute('aria-valuemax')]).toEqual(['360', '360']);
      fireEvent.keyDown(separator(), { key: 'ArrowLeft' });
      expect(separator().getAttribute('aria-valuenow')).toBe('350');
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 300 });
      fireEvent(window, new Event('resize'));
      expect(separator().getAttribute('aria-valuenow')).toBe(String(SIDE_PANEL_MIN_WIDTH));
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2000 });
      fireEvent(window, new Event('resize'));
      expect(dock().style.width).toBe('350px');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });
});

describe('DockSlot', () => {
  it('adopts the shared node only while attached and hands it to the next slot without recreating it', () => {
    const node = document.createElement('div'); node.textContent = 'chat';
    const { rerender } = render(<div><DockSlot key="a" node={node} attached={false} /></div>);
    expect(node.isConnected).toBe(false);
    rerender(<div><DockSlot key="a" node={node} attached /></div>);
    const first = node.parentElement;
    expect(node.isConnected).toBe(true);
    rerender(<div><DockSlot key="b" node={node} attached /></div>);
    expect(node.isConnected).toBe(true);
    expect(node.parentElement).not.toBe(first);
    rerender(<div><DockSlot key="b" node={node} attached={false} /></div>);
    expect(node.isConnected).toBe(false);
  });
});
