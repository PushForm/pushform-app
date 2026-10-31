// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './App';
import { useAppStore } from './store';
import { createApp, type AppInstance } from './bootstrap';
import { CloudSession, type AuthApi, type CloudFilesApi } from '@pushform/cloud';

vi.mock('./components/ViewportView', () => ({ ViewportView: () => <div aria-label="3D viewport" /> }));

const build = { version: '1.2.3', commit: 'abc1234', date: '2026-10-22T14:03:00Z' };
const requests = { baseUrl: 'https://project.test/functions/v1/fr-conversation', apikey: 'sb_publishable_test' };
let app: AppInstance, cloud: CloudSession;
const calls: { path: string; headers: Record<string, string>; body: unknown }[] = [];
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const sse = (events: { event: string; data: unknown }[]): Response => new Response(events.map(item => `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
beforeEach(async () => {
  calls.length = 0;
  cloud = new CloudSession({
    initialize: async () => ({ error: null }),
    getSession: async () => ({ data: { session: { access_token: 'jwt-token', user: { id: 'user-1', email: 'artist@example.com' }, expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  } as unknown as AuthApi);
  await cloud.start();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace('/functions/v1/fr-conversation', '');
    const body: unknown = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, headers: (init?.headers as Record<string, string>) ?? {}, body });
    if (path === '/me') return json({ email: 'artist@example.com', roles: [], effective: 'user', filingDisabled: false, buildsDisabled: false, trialsDisabled: false, openRequests: 0, limits: { openRequestsPerAccount: 5, messagesPerConversation: 30 } });
    if (path === '/conversations/open') return json({ conversations: [] });
    if (path === '/conversations/conv-1/attachments') return json({ attachments: [] });
    if (path === '/conversations') return json({ conversation: { id: 'conv-1', kind: 'intake', path: (body as { path: string }).path, status: 'open', title: null, brief: null, messages: [], messageCount: 0, requestId: null } });
    if (path === '/conversations/conv-1/messages') {
      const { intent = 'feature', text } = body as { intent?: string; text: string };
      if (text === 'yes') return sse([{ event: 'filed', data: { request: { id: 'req-1', issueKey: 'CUS-12', issueUrl: 'https://linear.app/pushform/issue/CUS-12', title: 'Mirror', requesterState: 'Submitted', eligibility: 'gated' } } },
        { event: 'text', data: { delta: 'Filed. You will get an email.' } }, { event: 'done', data: { messageCount: 2, limitReached: false, ended: true } }]);
      return sse([{ event: 'text', data: { delta: 'What are you trying to do?' } }, { event: 'brief', data: { brief: null, title: null, path: intent, estimatedClass: null } }, { event: 'done', data: { messageCount: 1, limitReached: false } }]);
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: path } }), { status: 404 });
  }));
  app = createApp({ demo: false, expose: false });
});
afterEach(() => { cleanup(); cloud.dispose(); app.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

const icon = (): HTMLElement => screen.getByRole('button', { name: 'AI Chat' });
const rail = (): HTMLElement => screen.getByRole('navigation', { name: 'Left menu bar' });
const docked = (): HTMLElement | null => screen.queryByRole('region', { name: 'AI Chat' });
/** The shown chat's composer: the conversations of other documents stay mounted, hidden. */
const composerField = (): HTMLElement => within(docked() ?? document.body).getByLabelText('Your message');
const cards = async (): Promise<HTMLElement> => screen.findByRole('group', { name: 'What would you like to do?' });
const newLayout = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'New document' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Layout' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create Layout' }));
};

it('keeps the conversation in memory across hiding and showing within the session', async () => {
  render(<App initialScreen="workspace" app={app} cloud={cloud} buildInfo={build} requests={requests} />);
  fireEvent.click(icon());
  await screen.findByRole('region', { name: 'AI Chat' });
  await cards();
  const composer = composerField();
  fireEvent.change(composer, { target: { value: 'a draft I did not send' } });
  const before = calls.length;
  fireEvent.click(icon());
  await waitFor(() => expect(docked()).toBeNull());
  fireEvent.click(icon());
  await screen.findByRole('region', { name: 'AI Chat' });
  expect((composerField() as HTMLTextAreaElement).value).toBe('a draft I did not send');
  expect(calls.length).toBe(before);
});

it('docks the chat beside the editor from the left menu bar icon, sends the session token, and only the icon or Escape inside hides it', async () => {
  render(<App initialScreen="workspace" app={app} cloud={cloud} buildInfo={build} requests={requests} />);
  expect(app.commands.has('help.requests')).toBe(true);
  const menu = screen.getByRole('button', { name: 'Main menu' });
  expect(within(rail()).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Files', 'AI Chat', 'Object browser']);
  expect(within(screen.getByRole('navigation', { name: 'Tools' })).queryByRole('button', { name: 'AI Chat' })).toBeNull();
  expect(icon().getAttribute('aria-pressed')).toBe('false');
  fireEvent.mouseEnter(icon());
  expect(screen.getByRole('tooltip').textContent).toBe('AI Chat');
  fireEvent.mouseLeave(icon());
  fireEvent.click(menu);
  expect(screen.queryByRole('menuitem', { name: /AI Chat/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Your requests' })).toBeNull();
  fireEvent.click(menu);
  fireEvent.click(icon());
  const region = await screen.findByRole('region', { name: 'AI Chat' });
  expect(screen.queryByRole('dialog', { name: 'AI Chat' })).toBeNull();
  expect(region.classList.contains('pf-fr-docked')).toBe(true);
  expect(region.closest('.pf-side-dock')?.previousElementSibling).toBe(rail());
  expect(region.closest('.pf-side-dock')?.nextElementSibling?.contains(screen.getByLabelText('3D viewport'))).toBe(true);
  expect(icon().getAttribute('aria-pressed')).toBe('true');
  expect(region.textContent).not.toContain('artist@example.com');
  await cards();
  await waitFor(() => expect(document.activeElement).toBe(composerField()));
  expect(calls[0]).toMatchObject({ path: '/me', headers: { Authorization: 'Bearer jwt-token', apikey: 'sb_publishable_test' } });
  expect(calls.find(call => call.path === '/conversations')).toBeUndefined();
  fireEvent.click(within(await cards()).getByRole('button', { name: /^Request a feature or change/ }));
  await waitFor(() => expect(calls.find(call => call.path === '/conversations/conv-1/messages')).toBeTruthy());
  expect(calls.find(call => call.path === '/conversations')?.body).toMatchObject({ kind: 'intake', path: 'open', screen: { editor: 'model', documentType: 'model', build: { version: '1.2.3', commit: 'abc1234' } } });
  expect(calls.find(call => call.path === '/conversations/conv-1/messages')?.body).toEqual({ text: 'Request a feature or change', intent: 'feature', document: { type: 'model', apiVersion: 1, edit: 1, guidance: 1 } });
  await waitFor(() => expect(screen.getByRole('log', { name: 'Conversation' }).textContent).toContain('What are you trying to do?'));
  expect(screen.queryByRole('button', { name: 'File request' })).toBeNull();
  expect(screen.queryByText(/preview/i)).toBeNull();
  expect(screen.queryByText(/of 30 messages/)).toBeNull();
  // Filing happens in the chat: the agent files on an explicit yes and the transcript gets one muted line with a plain ticket reference.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Upload images' }).hasAttribute('disabled')).toBe(false));
  fireEvent.change(composerField(), { target: { value: 'yes' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const filed = (await within(region).findByText('Filed as CUS-12')).closest<HTMLElement>('[role="status"]')!;
  expect(filed.textContent).toBe('Filed as CUS-12');
  expect(within(filed).queryByRole('link')).toBeNull();
  await waitFor(() => expect(screen.getByRole('log', { name: 'Conversation' }).textContent).toContain('You will get an email.'));
  expect(calls.filter(call => call.path.endsWith('/file'))).toHaveLength(0);
  expect(composerField().hasAttribute('disabled')).toBe(false);
  // Working in the editor keeps it open: a press outside and an Escape with focus outside do not hide it.
  fireEvent.pointerDown(screen.getByLabelText('3D viewport'));
  fireEvent.mouseDown(screen.getByLabelText('3D viewport'));
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(docked()).toBe(region);
  fireEvent.click(icon());
  expect(docked()).toBeNull();
  expect(icon().getAttribute('aria-pressed')).toBe('false');
  expect(calls.filter(call => call.path.endsWith('/discard'))).toHaveLength(0);
  fireEvent.click(icon());
  await screen.findByRole('region', { name: 'AI Chat' });
  fireEvent.keyDown(composerField(), { key: 'Escape' });
  expect(docked()).toBeNull();
  expect(document.activeElement).toBe(icon());
  expect(app.commands.ctx.tx.canUndo()).toBe(false);
});

it('offers help.requests, keeps workspace keys out of the composer, and docks the conversation of each document across Model and Layout tabs', async () => {
  render(<App initialScreen="workspace" app={app} cloud={cloud} buildInfo={build} requests={requests} />);
  const keys = vi.fn(); window.addEventListener('keydown', keys);
  act(() => { app.commands.tryExecute('help.requests'); });
  await screen.findByRole('region', { name: 'AI Chat' });
  const composer = await screen.findByLabelText('Your message');
  fireEvent.keyDown(composer, { key: 'r' });
  expect(keys).not.toHaveBeenCalled();
  act(() => { app.commands.tryExecute('help.requests'); });
  expect(docked()).toBeNull();
  act(() => { app.commands.tryExecute('help.requests'); });
  expect(docked()).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Close AI Chat' })).toBeNull();
  fireEvent.keyDown(composer, { key: 'Escape' });
  expect(docked()).toBeNull();
  window.removeEventListener('keydown', keys);
  act(() => { app.commands.tryExecute('help.requests'); });
  fireEvent.change(composer, { target: { value: 'still here' } });
  newLayout();
  // The Layout rail lists the chat, then the object browser; the chat is not in the tool row and stays open across the
  // switch, showing the new document's own conversation.
  expect(within(rail()).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Files', 'AI Chat', 'Object browser']);
  expect(within(screen.getByRole('navigation', { name: 'Layout tools' })).queryByRole('button', { name: 'AI Chat' })).toBeNull();
  expect(docked()).toBeTruthy();
  expect(composerField()).not.toBe(composer);
  // One panel at a time: the object browser replaces the chat.
  const objects = screen.getByRole('button', { name: 'Object browser' });
  fireEvent.click(objects);
  expect(objects.getAttribute('aria-pressed')).toBe('true');
  expect(icon().getAttribute('aria-pressed')).toBe('false');
  expect(docked()).toBeNull();
  expect(document.querySelector('.pf-side-dock-objects')?.hasAttribute('hidden')).toBe(false);
  // The model has its own object browser: the open panel stays open and lists the model instead.
  fireEvent.click(screen.getByRole('button', { name: '3D model: Untitled' }));
  expect(within(rail()).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Files', 'AI Chat', 'Object browser']);
  expect(screen.getByRole('button', { name: 'Object browser' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByText('Solids, groups and components you make appear here.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Object browser' }));
  expect(document.querySelector('.pf-side-dock')?.hasAttribute('hidden')).toBe(true);
  fireEvent.click(icon());
  expect(docked()).toBeTruthy();
  expect(composerField()).toBe(composer);
  expect((composer as HTMLTextAreaElement).value).toBe('still here');
  expect(app.commands.ctx.tx.canUndo()).toBe(false);
});

it('opens the Object browser for a Layout document shown for the first time, and keeps what the user left after that', () => {
  render(<App initialScreen="workspace" app={app} cloud={cloud} buildInfo={build} requests={requests} />);
  const objectsOpen = (): boolean => screen.getByRole('button', { name: 'Object browser' }).getAttribute('aria-pressed') === 'true';
  newLayout();
  expect(objectsOpen()).toBe(true);
  expect(screen.getByRole('tree', { name: 'Object browser' })).toBeTruthy();
  // Closed by the user, it stays closed when the same document is shown again.
  fireEvent.click(screen.getByRole('button', { name: 'Object browser' }));
  fireEvent.click(screen.getByRole('button', { name: '3D model: Untitled' }));
  fireEvent.click(screen.getByRole('button', { name: '2D drawing: Untitled 2' }));
  expect(objectsOpen()).toBe(false);
  // A new document opens it again, but an open chat is not replaced.
  newLayout();
  expect(objectsOpen()).toBe(true);
  fireEvent.click(icon());
  newLayout();
  expect(objectsOpen()).toBe(false);
  expect(docked()).toBeTruthy();
});

it('keeps the docked conversation, transcript and draft of each document when switching from a Model tab to a Layout tab and back', async () => {
  render(<App initialScreen="workspace" app={app} cloud={cloud} buildInfo={build} requests={requests} />);
  newLayout();
  fireEvent.click(screen.getByRole('button', { name: '3D model: Untitled' }));
  fireEvent.click(icon());
  fireEvent.click(within(await cards()).getByRole('button', { name: /^Request a feature or change/ }));
  await waitFor(() => expect(screen.getByRole('log', { name: 'Conversation' }).textContent).toContain('What are you trying to do?'));
  const region = docked()!, composer = composerField();
  fireEvent.change(composer, { target: { value: 'mirror the selection' } });
  expect(region.closest('.pf-main')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '2D drawing: Untitled 2' }));
  const layoutRegion = docked()!;
  expect(layoutRegion).not.toBe(region);
  expect(layoutRegion.closest('.pf-layout-main')).toBeTruthy();
  expect(layoutRegion.textContent).not.toContain('What are you trying to do?');
  fireEvent.click(screen.getByRole('button', { name: '3D model: Untitled' }));
  expect(docked()).toBe(region);
  expect(region.closest('.pf-main')).toBeTruthy();
  expect(composerField()).toBe(composer);
  expect((composer as HTMLTextAreaElement).value).toBe('mirror the selection');
  expect(screen.getByRole('log', { name: 'Conversation' }).textContent).toContain('What are you trying to do?');
});

it('reaches the pop-down from the Home header icon, has no requests card or list, and reports an unconfigured backend', async () => {
  const api: CloudFilesApi = { listProjects: vi.fn().mockResolvedValue([]), createProject: vi.fn(), listFiles: vi.fn().mockResolvedValue([]), open: vi.fn(), head: vi.fn(), openRevision: vi.fn(), recordImport: vi.fn(),
    listFolders: vi.fn().mockResolvedValue([]), createFolder: vi.fn(), save: vi.fn() };
  render(<App app={app} cloud={cloud} cloudFiles={api} buildInfo={build} requests={requests} />);
  expect(screen.queryByRole('group', { name: 'AI Chat' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Your requests' })).toBeNull();
  const header = screen.getByRole('button', { name: 'PushForm home' }).parentElement!;
  expect(within(header).getByRole('button', { name: 'AI Chat' })).toBe(icon());
  fireEvent.click(icon());
  const dialog = await screen.findByRole('dialog', { name: 'AI Chat' });
  await cards();
  expect(dialog.textContent).toContain('How can I help you?');
  expect(calls.find(call => call.path === '/requests')).toBeUndefined();
  expect(calls.find(call => call.path === '/conversations')).toBeUndefined();
  fireEvent.click(icon());
  expect(screen.queryByRole('dialog')).toBeNull();
  cleanup();
  render(<App app={app} cloud={cloud} cloudFiles={api} buildInfo={build} />);
  fireEvent.click(icon());
  expect(screen.getByRole('alert').textContent).toContain('unavailable');
  expect(screen.getByRole('dialog', { name: 'AI Chat' }).getAttribute('aria-modal')).toBeNull();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps a separate conversation for each document tab, offering guidance and document edits in both editors', async () => {
  render(<App initialScreen="workspace" app={app} cloud={cloud} buildInfo={build} requests={requests} />);
  fireEvent.click(icon());
  fireEvent.change(await screen.findByLabelText('Your message'), { target: { value: 'hello from the model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('What are you trying to do?');
  expect(calls.find(call => call.path === '/conversations/conv-1/messages')?.body).toEqual({ text: 'hello from the model', document: { type: 'model', apiVersion: 1, edit: 1, guidance: 1 } });
  fireEvent.click(icon());
  fireEvent.click(screen.getByRole('button', { name: 'New document' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Layout' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create Layout' }));
  fireEvent.click(icon());
  const panel = await screen.findByRole('region', { name: 'AI Chat' });
  await within(panel).findByRole('group', { name: 'What would you like to do?' });
  expect(panel.textContent).not.toContain('hello from the model');
  fireEvent.change(within(panel).getByLabelText('Your message'), { target: { value: 'add a box' } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(calls.filter(call => call.path === '/conversations/conv-1/messages')).toHaveLength(2));
  expect(calls.filter(call => call.path === '/conversations/conv-1/messages')[1]!.body).toEqual({ text: 'add a box', document: { type: 'layout', apiVersion: 1, guidance: 1 } });
  fireEvent.click(icon());
  fireEvent.click(screen.getByRole('button', { name: /^3D model:/ }));
  fireEvent.click(icon());
  const back = await screen.findByRole('region', { name: 'AI Chat' });
  expect(back.textContent).toContain('hello from the model');
  expect(back.textContent).not.toContain('add a box');
});

it('offers Clear Chat in command search, clearing only the active document conversation and opening the chat on the greeting', async () => {
  render(<App initialScreen="workspace" app={app} cloud={cloud} buildInfo={build} requests={requests} />);
  expect(app.commands.get('help.clearChat')).toMatchObject({ title: 'Clear Chat', icon: 'chat-delete' });
  fireEvent.click(icon());
  fireEvent.change(await screen.findByLabelText('Your message'), { target: { value: 'hello from the model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('What are you trying to do?');
  fireEvent.click(icon());
  await waitFor(() => expect(docked()).toBeNull());
  act(() => { app.commands.execute('help.clearChat'); });
  const panel = await screen.findByRole('region', { name: 'AI Chat' });
  await within(panel).findByRole('group', { name: 'What would you like to do?' });
  expect(panel.textContent).not.toContain('hello from the model');
  await waitFor(() => expect(calls.some(call => call.path === '/conversations/conv-1/discard')).toBe(true));
});

it('discovers equivalent menu and toolbar import routes while keeping chat open and the menu closed', async () => {
  const fallback = globalThis.fetch;
  const answers: { results: { content: string }[] }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/messages')) return sse([{ event: 'tool_request', data: { calls: [{ id: 'lookup', name: 'ui_list_targets', input: { query: 'Import' } }] } },
      { event: 'done', data: { messageCount: 1, limitReached: false, ended: false, awaitingTools: true } }]);
    if (url.endsWith('/tool-results')) { answers.push(JSON.parse(init!.body as string)); return sse([{ event: 'text', data: { delta: 'Choose Import in Insert, or Main menu → Import.' } }, { event: 'done', data: { messageCount: 1, limitReached: false } }]); }
    return fallback(input, init);
  }));
  render(<App initialScreen="workspace" app={app} cloud={cloud} buildInfo={build} requests={requests} />);
  newLayout();
  fireEvent.click(icon());
  fireEvent.change(await screen.findByLabelText('Your message'), { target: { value: 'Help me import an image' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Choose Import in Insert, or Main menu → Import.');
  const targets = JSON.parse(answers[0]!.results[0]!.content).targets as { id: string; action: string; route: string; enabled: boolean }[];
  expect(targets).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'toolbar:import', action: 'layout.import', enabled: true, route: 'Toolbar > Insert > Import' }),
    expect.objectContaining({ id: 'menu:import', action: 'layout.import', enabled: true, route: 'Main menu > Import...' }),
  ]));
  expect(docked()).not.toBeNull();
  expect(screen.queryByRole('tree', { name: 'Object browser' })).toBeNull();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.querySelector('.pf-ai-guidance-instruction')).toBeNull();
});

it('keeps the conversation visible when guidance explicitly reveals the Object browser', async () => {
  const fallback = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/messages')) return sse([{ event: 'tool_request', data: { calls: [{ id: 'open', name: 'ui_open_sidebar', input: { panel: 'objects' } }] } },
      { event: 'done', data: { messageCount: 1, limitReached: false, ended: false, awaitingTools: true } }]);
    if (url.endsWith('/tool-results')) return sse([{ event: 'text', data: { delta: 'The Object browser is beside this conversation.' } }, { event: 'done', data: { messageCount: 1, limitReached: false } }]);
    return fallback(input, init);
  }));
  render(<App initialScreen="workspace" app={app} cloud={cloud} buildInfo={build} requests={requests} />);
  fireEvent.click(icon());
  fireEvent.change(await screen.findByLabelText('Your message'), { target: { value: 'Help me find my objects' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('The Object browser is beside this conversation.');
  expect(docked()).not.toBeNull();
  expect(screen.getByRole('tree', { name: 'Object browser' })).toBeTruthy();
});

it('can reveal and highlight a menu alternative without executing it, closing chat or displaying a toast', async () => {
  const fallback = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/messages')) return sse([{ event: 'tool_request', data: { calls: [{ id: 'cue', name: 'ui_highlight', input: { targets: ['menu:import'], instruction: 'Choose Import, then select a PNG or JPEG image.' } }] } },
      { event: 'done', data: { messageCount: 1, limitReached: false, ended: false, awaitingTools: true } }]);
    return fallback(input, init);
  }));
  const picker = vi.spyOn(HTMLInputElement.prototype, 'click');
  render(<App initialScreen="workspace" app={app} cloud={cloud} buildInfo={build} requests={requests} />);
  newLayout();
  fireEvent.click(icon());
  fireEvent.change(await screen.findByLabelText('Your message'), { target: { value: 'Show the menu Import action' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const item = await screen.findByRole('menuitem', { name: 'Import...' });
  await waitFor(() => expect(item.classList.contains('pf-ai-guidance')).toBe(true));
  expect(docked()).not.toBeNull();
  expect(within(docked()!).getByRole('log').textContent).toContain('Choose Import, then select a PNG or JPEG image.');
  expect(picker).not.toHaveBeenCalled();
  expect(document.querySelector('.pf-ai-guidance-instruction, .pf-toast')).toBeNull();
  cleanup(); // Aborts the pending cue rather than waiting for its thirty-second expiry.
});

it('offers matching pane icons and toggles Object browser from command search', () => {
  render(<App initialScreen="workspace" app={app} cloud={cloud} />);
  expect(app.commands.get('help.requests')).toMatchObject({ icon: 'chat-ai' });
  expect(app.commands.get('view.objects')).toMatchObject({ title: 'Object browser', icon: 'object-browser' });
  expect(app.commands.get('file.save')).toMatchObject({ title: 'Save' });
  expect(app.commands.get('file.saveAs')).toMatchObject({ title: 'Save As…' });
  act(() => { app.commands.execute('view.objects'); });
  expect(screen.getByRole('button', { name: 'Object browser' }).getAttribute('aria-pressed')).toBe('true');
  act(() => { app.commands.execute('view.objects'); });
  expect(screen.getByRole('button', { name: 'Object browser' }).getAttribute('aria-pressed')).toBe('false');
});
it('opens Save As from the menu and command in both editors without redundant Home or copy menu items', async () => {
  useAppStore.getState().setMenuOpen(false);
  const api: CloudFilesApi = { listProjects: vi.fn().mockResolvedValue([]), createProject: vi.fn(), listFiles: vi.fn().mockResolvedValue([]), open: vi.fn(), head: vi.fn(), openRevision: vi.fn(), recordImport: vi.fn(),
    listFolders: vi.fn().mockResolvedValue([]), createFolder: vi.fn(), save: vi.fn() };
  render(<App initialScreen="workspace" app={app} cloud={cloud} cloudFiles={api} />);
  fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
  for (const name of ['Home', 'Make a cloud copy…', 'Download a copy…']) expect(screen.queryByRole('menuitem', { name })).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Save As…' }));
  await screen.findByRole('dialog', { name: 'Save to Cloud' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  act(() => { app.commands.execute('file.saveAs'); });
  await screen.findByRole('dialog', { name: 'Save to Cloud' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  newLayout();
  fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
  for (const name of ['Home', 'Make a cloud copy…', 'Download a copy…']) expect(screen.queryByRole('menuitem', { name })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Main menu' }));
  const search = screen.getByRole('combobox');
  fireEvent.focus(search);
  fireEvent.change(search, { target: { value: 'Save As' } });
  fireEvent.keyDown(search, { key: 'Enter' });
  await screen.findByRole('dialog', { name: 'Save to Cloud' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.focus(search);
  fireEvent.change(search, { target: { value: 'Save as Template' } });
  fireEvent.keyDown(search, { key: 'Enter' });
  await screen.findByRole('dialog', { name: 'Save as Template' });
});
