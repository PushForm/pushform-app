// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createToastStore } from '../toasts';
import { ToastHost } from './ToastHost';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('announces politely outside editor clipping, preserves focus and expires', () => {
  const store = createToastStore();
  const view = render(<><button>Keep working</button><ToastHost store={store} /></>);
  screen.getByRole('button', { name: 'Keep working' }).focus();
  act(() => { store.show('Select an object first.'); });
  expect(screen.getByRole('region', { name: 'Notifications' }).getAttribute('aria-live')).toBe('polite');
  expect(screen.getByText('Select an object first.')).toBeTruthy();
  expect(view.container.querySelector('.pf-toasts')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep working' }));
  act(() => { vi.advanceTimersByTime(5000); });
  expect(screen.queryByText('Select an object first.')).toBeNull();
});

it('deduplicates repeated messages and refreshes their duration', () => {
  const store = createToastStore(); render(<ToastHost store={store} />);
  act(() => { store.show('Select an object first.'); });
  act(() => { vi.advanceTimersByTime(4000); });
  act(() => { store.show('Select an object first.'); });
  expect(screen.getAllByText('Select an object first.')).toHaveLength(1);
  act(() => { vi.advanceTimersByTime(4000); });
  expect(screen.getByText('Select an object first.')).toBeTruthy();
  act(() => { vi.advanceTimersByTime(1000); });
  expect(screen.queryByText('Select an object first.')).toBeNull();
});

it('pauses while hovered or focused and resumes with the remaining time', () => {
  const store = createToastStore(); render(<ToastHost store={store} />);
  act(() => { store.show('A message worth reading.'); });
  act(() => { vi.advanceTimersByTime(4000); });
  const notification = screen.getByRole('group', { name: 'Notification' });
  fireEvent.mouseEnter(notification);
  act(() => { vi.advanceTimersByTime(10000); });
  expect(screen.getByText('A message worth reading.')).toBeTruthy();
  fireEvent.focus(screen.getByRole('button', { name: 'Dismiss notification' }));
  fireEvent.mouseLeave(notification);
  act(() => { vi.advanceTimersByTime(10000); });
  expect(screen.getByText('A message worth reading.')).toBeTruthy();
  fireEvent.blur(notification, { relatedTarget: document.body });
  act(() => { vi.advanceTimersByTime(999); });
  expect(screen.getByText('A message worth reading.')).toBeTruthy();
  act(() => { vi.advanceTimersByTime(1); });
  expect(screen.queryByText('A message worth reading.')).toBeNull();
});

it('bounds the stack and supports manual dismissal and cleanup', () => {
  const store = createToastStore(); const view = render(<ToastHost store={store} />);
  act(() => { ['First', 'Second', 'Third', 'Fourth'].forEach(message => store.show(message)); });
  expect(screen.queryByText('First')).toBeNull();
  expect(screen.getAllByRole('group', { name: 'Notification' })).toHaveLength(3);
  fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss notification' })[0]!);
  expect(screen.queryByText('Second')).toBeNull();
  view.unmount();
  expect(store.getSnapshot()).toEqual([]);
  act(() => { vi.advanceTimersByTime(5000); });
  expect(store.getSnapshot()).toEqual([]);
});
