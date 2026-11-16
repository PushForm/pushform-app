// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ExtensionFileDialog, FilePrompts } from './extensionFiles';

afterEach(cleanup);
const request = { extensionName: 'Cut List', kind: 'save' as const, purpose: 'Export the parts list', accept: [], suggestedName: 'Parts.csv' };

it('names the extension and purpose, keeps keyboard focus in consent and restores it after cancellation', async () => {
  const previous = document.createElement('button'); document.body.append(previous); previous.focus();
  const prompts = new FilePrompts(); render(<ExtensionFileDialog prompts={prompts} />);
  let result!: Promise<boolean>;
  act(() => { result = prompts.ask(request); });
  expect(screen.getByRole('dialog', { name: 'Save a file from Cut List?' }).textContent).toContain(request.purpose);
  const cancel = screen.getByRole('button', { name: 'Cancel' }), choose = screen.getByRole('button', { name: 'Choose where to save…' });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(choose);
  fireEvent.keyDown(choose, { key: 'Tab' }); expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: 'Escape' }); expect(await result).toBe(false);
  expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(previous);
  previous.remove();
});

it('removes only cancelled requests, advances the queue and cannot accept a stopped runtime request', async () => {
  const prompts = new FilePrompts(), first = new AbortController(), last = new AbortController();
  const cancelled = prompts.ask(request, first.signal), allowed = prompts.ask({ ...request, extensionName: 'Second' });
  const neverShown = prompts.ask({ ...request, extensionName: 'Third' }, last.signal);
  last.abort(); expect(await neverShown).toBe(false); expect(prompts.current()?.request.extensionName).toBe('Cut List');
  first.abort(); expect(await cancelled).toBe(false); expect(prompts.current()?.request.extensionName).toBe('Second');
  prompts.answer(true); expect(await allowed).toBe(true); expect(prompts.current()).toBeNull();
  expect(await prompts.ask(request, first.signal)).toBe(false); expect(prompts.current()).toBeNull();
});
