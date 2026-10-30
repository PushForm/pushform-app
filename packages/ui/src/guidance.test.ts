// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guidanceFor, registerGuidanceTargets } from './guidance';
import type { DocumentSession, DocumentTab } from './session';

let notify: () => void;
let session: DocumentSession;
let tab: DocumentTab;
let root: HTMLButtonElement;
let cleanups: (() => void)[];
let onClick: (event: MouseEvent) => void;
let onKey: (event: KeyboardEvent) => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 0; });
  tab = { id: 'a', type: 'layout' } as DocumentTab;
  session = { tabs: [tab], active: tab, subscribe: vi.fn((fn: () => void) => { notify = fn; return vi.fn(); }) } as unknown as DocumentSession;
  root = document.createElement('button'); root.dataset['guidanceId'] = 'toolbar:line'; document.body.append(root);
  cleanups = [];
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'click') onClick = listener as typeof onClick;
    if (type === 'keydown') onKey = listener as typeof onKey;
    add(type, listener, options);
  });
});
afterEach(() => { for (const cleanup of cleanups) cleanup(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const result = async (promise: ReturnType<ReturnType<typeof guidanceFor>>) => JSON.parse((await promise).content) as Record<string, unknown>;
// Browsers alone mint trusted events; unit tests exercise the captured native listener with that browser boundary supplied.
const click = (target: Element, isTrusted = true) => onClick({ target, isTrusted } as unknown as MouseEvent);

describe('private AI Chat guidance', () => {
  it('ends glow after five seconds but reports the first trusted activation at twenty seconds', async () => {
    const pending = guidanceFor(session, tab, vi.fn())('ui_highlight', { targets: ['toolbar:line'] });
    await flush();
    expect(root.classList.contains('pf-ai-guidance')).toBe(true);
    root.click(); // Programmatic clicks cannot drive the tutorial.
    await vi.advanceTimersByTimeAsync(5000);
    expect(root.classList.contains('pf-ai-guidance')).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    click(root);
    expect(await result(pending)).toMatchObject({ status: 'interacted', target: 'toolbar:line', tabId: 'a' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a click during the glow and identifies a particular target in a group', async () => {
    const second = document.createElement('button'); second.dataset['guidanceId'] = 'toolbar:rectangle'; document.body.append(second);
    const pending = guidanceFor(session, tab, vi.fn())('ui_highlight', { targets: ['toolbar:line', 'toolbar:rectangle'] });
    await flush(); click(second); click(root);
    expect(await result(pending)).toMatchObject({ status: 'interacted', target: 'toolbar:rectangle' });
    expect(root.classList.contains('pf-ai-guidance')).toBe(false);
    expect(second.classList.contains('pf-ai-guidance')).toBe(false);
  });

  it('expires at thirty seconds without a user activation', async () => {
    const pending = guidanceFor(session, tab, vi.fn())('ui_highlight', { targets: ['toolbar:line'] });
    await flush(); await vi.advanceTimersByTimeAsync(30_000);
    expect(await result(pending)).toMatchObject({ status: 'expired' });
    click(root);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts keyboard activation of a browser treeitem without changing focus or selection', async () => {
    root.setAttribute('role', 'treeitem');
    const pending = guidanceFor(session, tab, vi.fn())('ui_highlight', { targets: ['toolbar:line'] });
    await flush();
    onKey({ key: 'Enter', target: root, isTrusted: true } as unknown as KeyboardEvent);
    expect(await result(pending)).toMatchObject({ status: 'interacted' });
    expect(document.activeElement).toBe(document.body);
  });

  it('cancels on abort and tab changes, and rejects a stale turn before opening a panel', async () => {
    const abort = new AbortController();
    const open = vi.fn();
    const guide = guidanceFor(session, tab, open);
    const pending = guide('ui_highlight', { targets: ['toolbar:line'] }, abort.signal);
    await flush(); abort.abort();
    expect(await result(pending)).toMatchObject({ status: 'cancelled' });
    const switched = guide('ui_highlight', { targets: ['toolbar:line'] });
    await flush(); Object.defineProperty(session, 'active', { value: { id: 'b' } }); notify();
    expect(await result(switched)).toMatchObject({ status: 'cancelled' });
    expect(await result(guide('ui_open_sidebar', { panel: 'objects' }))).toMatchObject({ status: 'cancelled' });
    expect(open).not.toHaveBeenCalled();
  });

  it('reports deleted and unknown targets without leaving timers behind', async () => {
    const guide = guidanceFor(session, tab, vi.fn());
    expect(await result(guide('ui_highlight', { targets: ['absent'] }))).toMatchObject({ status: 'unavailable' });
    const pending = guide('ui_highlight', { targets: ['toolbar:line'] });
    await flush(); root.remove(); await flush();
    expect(await result(pending)).toMatchObject({ status: 'unavailable' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discovers and reveals collapsed browser nodes before starting the timers', async () => {
    const open = vi.fn();
    const reveal = vi.fn(() => { const row = document.createElement('div'); row.dataset['guidanceId'] = 'object:body:7'; root.append(row); });
    cleanups.push(registerGuidanceTargets({ root, targets: [{ id: 'object:body:7', label: 'Solid 7' }], reveal }));
    const guide = guidanceFor(session, tab, open);
    expect(await result(guide('ui_list_targets', {}))).toMatchObject({ targets: expect.arrayContaining([expect.objectContaining({ id: 'object:body:7', label: 'Solid 7' })]) });
    const abort = new AbortController();
    const pending = guide('ui_highlight', { targets: ['object:body:7'] }, abort.signal);
    await flush();
    expect(open).toHaveBeenCalledWith('objects');
    expect(reveal).toHaveBeenCalledWith(['object:body:7']);
    expect(root.firstElementChild?.classList.contains('pf-ai-guidance')).toBe(true);
    abort.abort(); await pending;
  });
});


it('discovers toolbar controls without opening panels or moving focus, and never creates guidance messages', async () => {
  const open = vi.fn();
  root.setAttribute('aria-label', 'Import');
  root.dataset['guidanceAction'] = 'layout.import';
  root.dataset['guidanceRoute'] = 'Toolbar > Insert > Import';
  root.focus();
  const guide = guidanceFor(session, tab, open);
  const listed = await result(guide('ui_list_targets', { query: 'Import' }));
  expect(listed).toMatchObject({ editor: 'layout', targets: [expect.objectContaining({ label: 'Import', action: 'layout.import', enabled: true, route: 'Toolbar > Insert > Import' })] });
  expect(open).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(root);
  const abort = new AbortController();
  const pending = guide('ui_highlight', { targets: ['toolbar:line'], instruction: 'This is Import.' }, abort.signal);
  await flush();
  expect(document.querySelector('.pf-ai-guidance-instruction, [role="status"], [role="alert"]')).toBeNull();
  expect(document.body.textContent).not.toContain('This is Import');
  abort.abort(); await pending;
  expect((await guide('ui_show_toast', { message: 'Forbidden toast' })).isError).toBe(true);
  expect(document.body.textContent).not.toContain('Forbidden toast');
});
