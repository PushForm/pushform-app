// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { guidanceFor } from '../guidance';
import type { DocumentSession, DocumentTab } from '../session';
import { ToolStack } from './ToolStack';
const tools = [
  { id: 'linear', title: 'Linear Dimension', icon: 'tool-dimension' },
  { id: 'angular', title: 'Angular Dimension', icon: 'tool-angular-dimension' },
];
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('opens a portal menu and remembers the selected tool in the same toolbar slot', () => {
  const onSelect = vi.fn();
  render(<ToolStack title="Dimension" tools={tools} activeId="select" onSelect={onSelect} />);
  expect(screen.queryByRole('button', { name: 'Angular Dimension' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Dimension tools' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Angular Dimension' }));
  expect(onSelect).toHaveBeenCalledWith('angular');
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Angular Dimension' }));
  expect(onSelect).toHaveBeenCalledTimes(2);
});
it('supports keyboard selection and Escape focus return', () => {
  render(<ToolStack title="Dimension" tools={tools} activeId="linear" onSelect={vi.fn()} />);
  fireEvent.keyDown(screen.getByRole('button', { name: 'Linear Dimension' }), { key: 'ArrowRight' });
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Linear Dimension' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Angular Dimension' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dimension tools' }));
});
it('dismisses on outside click', () => {
  render(<ToolStack title="Dimension" tools={tools} activeId="linear" onSelect={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Dimension tools' }));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('menu')).toBeNull();
});

it('opens the flyout and tooltip below a horizontal toolbar', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 50, y: 40, left: 50, top: 40, right: 84, bottom: 74, width: 34, height: 34, toJSON: () => ({}),
  });
  render(<nav data-orientation="horizontal"><ToolStack title="Dimension" tools={tools} activeId="linear" onSelect={vi.fn()} /></nav>);
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'Linear Dimension' }));
  expect(screen.getByRole('tooltip').style.top).toBe('82px');
  expect(screen.getByRole('tooltip').style.transform).toBe('none');
  fireEvent.click(screen.getByRole('button', { name: 'Dimension tools' }));
  expect(screen.getByRole('menu').style.top).toBe('80px');
  expect(screen.getByRole('menu').style.left).toBe('50px');
});


it.each(['fillet', 'chamfer'])('guidance opens and highlights the exact Chamfer choice when the slot face is %s', async activeId => {
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
  const onSelect = vi.fn();
  render(<div className="pf-toolbar"><ToolStack title="Fillet / Chamfer" tools={[
    { id: 'fillet', title: 'Fillet', icon: 'tool-fillet' },
    { id: 'chamfer', title: 'Chamfer', icon: 'tool-chamfer' },
  ]} activeId={activeId} onSelect={onSelect} /></div>);
  const chat = document.createElement('textarea'); document.body.append(chat); chat.focus();
  const tab = { id: 'a', type: 'layout' } as DocumentTab;
  const session = { tabs: [tab], active: tab, subscribe: () => () => {} } as unknown as DocumentSession;
  const guide = guidanceFor(session, tab, vi.fn());
  const listing = JSON.parse((await guide('ui_list_targets', { query: 'chamfer' })).content);
  expect(listing.targets).toHaveLength(1);
  expect(listing.targets.find((target: { id: string }) => target.id === 'toolbar:chamfer')).toMatchObject({ label: 'Chamfer', dropdown: 'Fillet / Chamfer' });
  expect(screen.queryByRole('menu')).toBeNull();
  const controller = new AbortController();
  let pending!: ReturnType<typeof guide>;
  act(() => { pending = guide('ui_highlight', { targets: ['toolbar:chamfer'] }, controller.signal); });
  const choice = await screen.findByRole('menuitemradio', { name: 'Chamfer' });
  await waitFor(() => expect(choice.classList.contains('pf-ai-guidance')).toBe(true));
  expect(document.querySelectorAll('.pf-ai-guidance')).toHaveLength(1);
  expect(onSelect).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(chat);
  controller.abort(); await pending;
  fireEvent.click(choice);
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('chamfer');
  expect(screen.queryByRole('menu')).toBeNull();
  chat.remove();
});
