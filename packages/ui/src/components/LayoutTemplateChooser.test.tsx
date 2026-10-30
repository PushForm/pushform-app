// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LayoutTemplateChooser } from './LayoutTemplateChooser';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('starts with A4 landscape, offers all categories, and creates only the selected template', () => {
  const create = vi.fn(); render(<LayoutTemplateChooser onCreate={create} onCancel={vi.fn()} />);
  expect(screen.getByRole('dialog', { name: 'Choose a Template' })).toBeTruthy();
  const initial = screen.getByRole('radio', { name: 'Graph Paper: A4 Landscape' });
  expect(initial.getAttribute('aria-checked')).toBe('true'); expect(document.activeElement).toBe(initial);
  expect(screen.getAllByRole('radio')).toHaveLength(20);
  fireEvent.click(screen.getByRole('tab', { name: 'Storyboard' }));
  expect(screen.getAllByRole('radio')).toHaveLength(4);
  expect(screen.getByRole('radio', { name: 'Storyboard: 4 Frames' }).querySelectorAll('polyline')).toHaveLength(4);
  fireEvent.click(screen.getByRole('radio', { name: 'Storyboard: 9 Frames' }));
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Create Layout' })); expect(create).toHaveBeenCalledWith('storyboard-3x3');
  fireEvent.click(screen.getByRole('tab', { name: 'Titleblock' }));
  expect(screen.getByRole('radio', { name: 'Titleblock: A3 Landscape' }).querySelectorAll('polyline')).toHaveLength(4);
  fireEvent.doubleClick(screen.getByRole('radio', { name: 'Titleblock: A3 Landscape' }));
  expect(create).toHaveBeenLastCalledWith('titleblock-a3');
  fireEvent.click(screen.getByRole('tab', { name: 'Paper' }));
  expect(screen.getByRole('radio', { name: 'Graph Paper: A4 Landscape' }).getAttribute('aria-checked')).toBe('true');
});

it.each(['en-US', 'es-US'])('puts US sizes first within each group for %s and navigates in display order', locale => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(locale);
  const create = vi.fn(); render(<LayoutTemplateChooser onCreate={create} onCancel={vi.fn()} />);
  const cards = screen.getAllByRole('radio');
  expect(cards[0]!.getAttribute('aria-label')).toBe('Graph Paper: Letter Landscape div4');
  expect(cards[12]!.getAttribute('aria-label')).toBe('Plain Paper: Letter Landscape');
  fireEvent.keyDown(screen.getByRole('radio', { name: 'Graph Paper: A4 Landscape' }), { key: 'Home' });
  expect(document.activeElement).toBe(cards[0]);
  fireEvent.keyDown(cards[0]!, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(cards[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Create Layout' }));
  expect(create).toHaveBeenCalledWith('graph-letter-landscape-div8');
  fireEvent.click(screen.getByRole('tab', { name: 'Titleblock' }));
  expect(screen.getAllByRole('radio').map(card => card.getAttribute('aria-label'))).toEqual([
    'Titleblock: Letter Landscape', 'Titleblock: Tabloid Landscape', 'Titleblock: A3 Landscape', 'Titleblock: A4 Landscape',
  ]);
});

it.each(['en-GB', 'de-DE', 'en', 'invalid_locale'])('retains international-first ordering for %s', locale => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(locale);
  render(<LayoutTemplateChooser onCreate={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getAllByRole('radio')[0]!.getAttribute('aria-label')).toBe('Graph Paper: A3 Landscape');
});
it('supports arrow-key selection, focus containment, and cancellation', () => {
  const create = vi.fn(), cancel = vi.fn(); render(<LayoutTemplateChooser onCreate={create} onCancel={cancel} />);
  const initial = screen.getByRole('radio', { name: 'Graph Paper: A4 Landscape' });
  fireEvent.keyDown(initial, { key: 'ArrowRight' });
  const portrait = screen.getByRole('radio', { name: 'Graph Paper: A4 Portrait' });
  expect(portrait.getAttribute('aria-checked')).toBe('true'); expect(document.activeElement).toBe(portrait);
  const last = screen.getByRole('button', { name: 'Create Layout' }); last.focus(); fireEvent.keyDown(last, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close template chooser' }));
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); expect(cancel).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled();
});
