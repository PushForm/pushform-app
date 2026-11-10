// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { InlineBackend, KernelClient } from '@pushform/kernel';
import type { EdgeBlendTool } from '@pushform/commands';
import type { EntityRef } from '@pushform/model';
import { freeInference, GROUND_PLANE } from '@pushform/inference';
import { AppContext } from '../AppContext';
import { createApp } from '../bootstrap';
import type { AppInstance } from '../bootstrap';
import { ToolOptionsBar } from './ToolOptionsBar';

let app: AppInstance | null = null;
afterEach(() => {
  cleanup();
  app?.dispose();
  app = null;
});

function mount(): AppInstance {
  const a = (app = createApp({ demo: false, expose: false, kernel: new KernelClient(new InlineBackend()) }));
  render(<AppContext.Provider value={a}><ToolOptionsBar /></AppContext.Provider>);
  return a;
}

const bar = () => document.querySelector('.pf-tob')!;

it('is hidden for tools with nothing to set, such as Select and Rectangle', () => {
  const a = mount();
  act(() => a.toolManager.activate('select'));
  expect(bar().classList.contains('is-shown')).toBe(false);
  expect(bar().getAttribute('aria-hidden')).toBe('true');
  act(() => a.toolManager.activate('rectangle'));
  expect(bar().classList.contains('is-shown')).toBe(false);
  act(() => a.toolManager.activate('circle'));
  expect(bar().classList.contains('is-shown')).toBe(true);
});

it("shows Profile Edges' profiles, size and the chamfer angle, and sets the tool from them", () => {
  const a = mount();
  act(() => a.toolManager.activate('profile'));
  const tool = a.toolManager.get('profile') as EdgeBlendTool;
  const toolbar = screen.getByRole('toolbar', { name: 'Profile Edges options' });
  const profiles = within(toolbar).getByRole('radiogroup', { name: 'Profile' });
  expect(within(profiles).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['Round', 'Chamfer', 'Cove', 'Ogee', 'Bead', 'Step']);
  expect(within(profiles).getByRole('radio', { name: 'Round' }).getAttribute('aria-checked')).toBe('true');
  act(() => { fireEvent.click(within(profiles).getByRole('radio', { name: 'Chamfer' })); });
  expect(tool.profile).toBe('chamfer');
  const size = within(toolbar).getByLabelText('Distance');
  act(() => { fireEvent.change(size, { target: { value: '0.25' } }); });
  act(() => { fireEvent.keyDown(size, { key: 'Enter' }); });
  expect(tool.size).toBeCloseTo(0.25 * 0.0254);
  const angle = within(toolbar).getByLabelText('Angle');
  expect((angle as HTMLInputElement).value).toBe('45°');
  act(() => { fireEvent.change(angle, { target: { value: '20' } }); });
  act(() => { fireEvent.blur(angle); });
  expect(tool.angleDeg).toBe(20);
  // text that is not a length is marked and changes nothing
  act(() => { fireEvent.change(size, { target: { value: 'abc' } }); });
  act(() => { fireEvent.keyDown(size, { key: 'Enter' }); });
  expect(size.getAttribute('aria-invalid')).toBe('true');
  expect(tool.size).toBeCloseTo(0.25 * 0.0254);
});

it('shows toggles with the key that taps them, and toggles from a click', () => {
  const a = mount();
  act(() => a.toolManager.activate('polygon'));
  const toolbar = screen.getByRole('toolbar', { name: 'Polygon options' });
  expect((within(toolbar).getByLabelText('Sides') as HTMLInputElement).value).toBe('6');
  expect(within(toolbar).getByRole('radio', { name: 'Inscribed' }).getAttribute('aria-checked')).toBe('true');
  act(() => { fireEvent.click(within(toolbar).getByRole('radio', { name: 'Circumscribed' })); });
  expect((a.toolManager.get('polygon') as unknown as { circumscribed: boolean }).circumscribed).toBe(true);
  act(() => a.toolManager.activate('pushpull'));
  const newBody = within(screen.getByRole('toolbar', { name: 'Push/Pull options' })).getByRole('button', { name: /New body/ });
  expect(newBody.getAttribute('aria-pressed')).toBe('false');
  expect(newBody.textContent).toMatch(/Ctrl|⌘/);
  act(() => { fireEvent.click(newBody); });
  expect(newBody.getAttribute('aria-pressed')).toBe('true');
});

it('Focus Tool Options moves keyboard focus into the bar and back to the view', () => {
  const a = mount();
  const view = document.createElement('div');
  view.className = 'pf-viewport';
  view.tabIndex = 0;
  document.body.appendChild(view);
  act(() => a.toolManager.activate('circle'));
  act(() => { a.commands.execute('view.focusToolOptions'); });
  expect(document.activeElement).toBe(screen.getByLabelText('Sides'));
  act(() => { a.commands.execute('view.focusToolOptions'); });
  expect(document.activeElement).toBe(view);
  expect(a.keymap.label('view.focusToolOptions')).toMatch(/L/);
  view.remove();
});

it('shows the shape just drawn as applied, and goes back to the next one after an undo', () => {
  const a = mount();
  act(() => a.toolManager.activate('polygon'));
  const ev = (x: number) => ({ screen: [0, 0] as [number, number], ray: { origin: [x, 0, 10] as [number, number, number], dir: [0, 0, -1] as [number, number, number] }, button: 0, buttons: 1, modifiers: { shift: false, ctrl: false, alt: false, meta: false }, inference: freeInference([x, 0, 0], GROUND_PLANE, null), camera: a.viewport.camera.getState() });
  act(() => {
    a.toolManager.click(ev(0));
    a.toolManager.click(ev(1));
  });
  expect(bar().classList.contains('is-applied')).toBe(true);
  expect(screen.getByRole('toolbar').textContent).toMatch(/Polygon applied/);
  act(() => { a.commands.execute('edit.undo'); });
  expect(bar().classList.contains('is-applied')).toBe(false);
});

it('shows a selected model text\'s style row and sets its font size, emphasis and color', () => {
  const a = mount();
  const ref = a.commands.execute('text.add', { kind: 'screen', screen: [0.2, 0.2], text: 'Title' }) as EntityRef;
  act(() => a.toolManager.activate('select'));
  act(() => { a.document.selection.set([ref]); });
  const toolbar = screen.getByRole('toolbar', { name: 'Text options' });
  expect(bar().classList.contains('is-shown')).toBe(true);
  const text = () => a.document.doc.rootDefinition.entities.texts.get(ref.id)!;
  act(() => { fireEvent.click(within(toolbar).getByRole('button', { name: 'Text bold' })); });
  expect(text().bold).toBe(true);
  act(() => { fireEvent.change(within(toolbar).getByLabelText('Text size'), { target: { value: '20' } }); });
  expect(text().fontSizePt).toBe(20);
  act(() => { fireEvent.change(within(toolbar).getByLabelText('Text color'), { target: { value: '#ff0000' } }); });
  expect(text().color).toEqual([1, 0, 0]);
  // nothing selected: no bar for Select
  act(() => { a.document.selection.set([]); });
  expect(bar().classList.contains('is-shown')).toBe(false);
});

it('places shortcut buttons before the operation inputs in DOM and keyboard order', () => {
  const a = mount();
  act(() => a.toolManager.activate('move'));
  const copy = screen.getByRole('button', { name: /Copy/ });
  const distance = screen.getByRole('textbox', { name: 'Distance' });
  expect(copy.compareDocumentPosition(distance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const first = bar().querySelector('button, input, select');
  expect(first).toBe(copy);
});
