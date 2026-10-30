// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RequestsClient, type Brief, type ScreenInfo } from './client';
import { readDrafts, rememberDraft } from './drafts';
import { BASE, FAKE_OPENER, fakeBackend, filedTurn, makeFiledRequest, type FakeBackendOptions, type FakeTurn } from './fakeBackend';
import { Chat, GREETING } from './Chat';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); document.body.innerHTML = ''; });
const account = { id: 'alice', email: 'artist@example.com' };
const screenInfo: ScreenInfo = { editor: 'model', documentType: 'model', build: { version: '1.2.3', commit: 'abc1234' }, browser: 'TestBrowser', os: 'TestOS' };
const featureBrief: Brief = { kind: 'feature', problem: 'I cannot mirror a selection', workaround: null, desired: null, acceptance: [], mustNotChange: null, area: 'Modeling', importance: null, estimatedClass: null };
const done = (messageCount: number, limitReached = false): FakeTurn => ({ event: 'done', data: { messageCount, limitReached } });
const text = (delta: string): FakeTurn => ({ event: 'text', data: { delta } });
const briefEvent = (brief: Brief | null, title: string | null, path = 'feature'): FakeTurn => ({ event: 'brief', data: { brief, title, path, estimatedClass: brief?.estimatedClass ?? null } });
const CARD_NAMES = ['Get help', 'Report a problem', 'Request a feature or change'];
const CARDS = 'What would you like to do?';

function setup(options: FakeBackendOptions = {}, props: Partial<Parameters<typeof Chat>[0]> = {}) {
  const backend = fakeBackend(options);
  const client = new RequestsClient({ baseUrl: BASE, apikey: 'k', getToken: async () => 'jwt-token', fetch: backend.fetch });
  const onClose = vi.fn();
  const app = document.createElement('div'); app.className = 'pf-app'; document.body.append(app);
  const anchor = document.createElement('button'); anchor.setAttribute('aria-label', 'AI Chat'); app.append(anchor);
  const workspaceKeys = vi.fn(); window.addEventListener('keydown', workspaceKeys);
  const view = render(<Chat client={client} account={account} screen={screenInfo} anchor={anchor} onClose={onClose} {...props} />);
  return { backend, client, onClose, app, anchor, workspaceKeys, view };
}
const cards = async (): Promise<HTMLElement[]> => within(await screen.findByRole('group', { name: CARDS })).getAllByRole('button');
const log = (): HTMLElement => screen.getByRole('log', { name: 'Conversation' });
const settled = async (): Promise<void> => { await waitFor(() => expect(document.querySelector('.is-streaming')).toBeNull()); };
const pick = async (name: string): Promise<void> => {
  fireEvent.click((await cards()).find(button => button.textContent?.startsWith(name))!);
  await waitFor(() => expect(log().textContent).toContain(name));
  await settled();
};
const say = async (message: string): Promise<void> => {
  fireEvent.change(await screen.findByLabelText('Your message'), { target: { value: message } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(log().textContent).toContain(message));
  await settled();
};
const messagePaths = (backend: ReturnType<typeof fakeBackend>): string[] => backend.calls.filter(call => call.path.endsWith('/messages')).map(call => call.path);

describe('Chat', () => {
  it('opens as a pop-down (no backdrop, nothing inert, no header) with the greeting, three cards and the composer', async () => {
    const { app, anchor, onClose } = setup();
    const dialog = await screen.findByRole('dialog', { name: 'AI Chat' });
    expect(dialog.getAttribute('aria-modal')).toBeNull();
    expect(dialog.classList.contains('pf-fr-popover')).toBe(true);
    expect(document.querySelector('.pf-modal-backdrop, .pf-fr-backdrop')).toBeNull();
    expect(app.hasAttribute('inert')).toBe(false);
    expect(dialog.textContent).not.toContain('artist@example.com');
    expect(within(log()).getAllByText(GREETING)).toHaveLength(1);
    expect((await cards()).map(button => button.querySelector('strong')?.textContent)).toEqual(CARD_NAMES);
    expect((await cards()).every(button => !button.hasAttribute('disabled'))).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Your message')));
    expect(dialog.querySelector('header')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close AI Chat' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New conversation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'File request' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    expect(document.activeElement).toBe(anchor);
  });
  it('closes on Escape and on a click outside, never on a click inside or on its icon, and keeps the conversation', async () => {
    const { anchor, onClose, backend } = setup({ turns: [[text('Hi.'), briefEvent(featureBrief, 'Mirror'), done(1)]] });
    await pick('Request a feature');
    fireEvent.pointerDown(screen.getByLabelText('Your message'));
    fireEvent.pointerDown(anchor);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByLabelText('Your message'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(backend.conversations.get('conv-1')?.status).toBe('open');
    expect(backend.calls.filter(call => call.path.endsWith('/discard'))).toHaveLength(0);
  });
  it('stops workspace shortcuts for keys typed inside it, sends on Enter and keeps Shift+Enter as a newline', async () => {
    const { workspaceKeys, backend } = setup();
    const composer = await screen.findByLabelText('Your message');
    fireEvent.keyDown(composer, { key: 'r' });
    fireEvent.keyUp(composer, { key: 'r' });
    expect(workspaceKeys).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'r' });
    expect(workspaceKeys).toHaveBeenCalledTimes(1);
    fireEvent.change(composer, { target: { value: 'line one' } });
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
    expect(backend.calls.filter(call => call.path === '/conversations')).toHaveLength(0);
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(messagePaths(backend)).toHaveLength(1));
    await settled();
    expect(backend.calls.find(call => call.path === '/conversations')?.body).toEqual({ kind: 'intake', path: 'open', screen: screenInfo });
  });
  it('sends a card as a message with its intent, hides the cards, and remembers the path from the brief event without previewing the brief', async () => {
    const { backend } = setup();
    await pick('Report a problem');
    const messages = backend.calls.filter(call => call.path.endsWith('/messages'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ method: 'POST', path: '/conversations/conv-1/messages', body: { text: 'Report a problem', intent: 'problem' } });
    expect(screen.queryByRole('group', { name: CARDS })).toBeNull();
    expect(log().textContent).toContain(GREETING);
    expect(log().textContent).toContain(FAKE_OPENER.problem);
    expect(screen.queryByText(/preview/i)).toBeNull();
    expect(screen.queryByText(/Not provided/)).toBeNull();
    expect(screen.queryByText(/of 30 messages/)).toBeNull();
    expect(readDrafts(account.id)[0]).toMatchObject({ conversationId: 'conv-1', path: 'problem' });
  });
  it('starts from a typed message without a card and sends no intent', async () => {
    const { backend } = setup({ turns: [[text('Tell me more.'), briefEvent(featureBrief, 'Mirror', 'feature'), done(1)]] });
    await screen.findByRole('group', { name: CARDS });
    await say('I want to mirror a selection');
    expect(backend.calls.filter(call => call.path === '/conversations')).toHaveLength(1);
    expect(backend.calls.find(call => call.path.endsWith('/messages'))?.body).toEqual({ text: 'I want to mirror a selection' });
    expect(screen.queryByRole('group', { name: CARDS })).toBeNull();
    expect(log().textContent).toContain('Tell me more.');
    // The brief event only sets the path and title of the remembered draft; nothing of the brief is rendered.
    expect(screen.queryByText(/I cannot mirror a selection/)).toBeNull();
    expect(readDrafts(account.id)[0]).toMatchObject({ conversationId: 'conv-1', path: 'feature', title: 'Mirror' });
  });
  it('disables the two filing cards with the explanation for the None role while typing and Get help still work', async () => {
    const { backend } = setup({ me: { effective: 'none' } });
    const buttons = await cards();
    expect(buttons.map(button => button.hasAttribute('disabled'))).toEqual([false, true, true]);
    expect(screen.getAllByText('Filing is not available in this product for your account. You can still get help.')).toHaveLength(2);
    expect(screen.getByLabelText('Your message').hasAttribute('disabled')).toBe(false);
    await pick('Get help');
    expect(backend.calls.at(-1)).toMatchObject({ path: '/conversations/conv-1/messages', body: { text: 'Get help', intent: 'help' } });
    cleanup();
    setup({ me: { filingDisabled: true } });
    expect((await cards()).map(button => button.hasAttribute('disabled'))).toEqual([false, true, true]);
  });
  it('streams the agent reply and shows the requester in bubbles; the brief event changes nothing on screen', async () => {
    const { backend } = setup({ turns: [
      [text('What are '), text('you trying to do?'), briefEvent(null, null, 'feature'), done(1)],
      [text('Noted. Here is the brief:\nProblem: I cannot mirror a selection.\nSend it?'), briefEvent(featureBrief, 'Add a mirror tool'), done(2)],
    ] });
    await pick('Request a feature');
    expect(log().textContent).toContain('What are you trying to do?');
    await say('I want to mirror things');
    expect(log().textContent).toContain('Send it?');
    expect(log().querySelectorAll('.pf-fr-message.is-user')).toHaveLength(2);
    expect(log().querySelectorAll('.pf-fr-message.is-assistant')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'File request' })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(backend.calls.filter(call => call.path.endsWith('/file'))).toHaveLength(0);
    expect(readDrafts(account.id)[0]).toMatchObject({ conversationId: 'conv-1', title: 'Add a mirror tool' });
  });
  it('renders the agent\'s replies as Markdown and the requester\'s words as typed, without raw HTML, images or unsafe links', async () => {
    setup({ turns: [[
      text('## Steps\n\n**Select** the `Push/Pull` tool, then:\n\n1. Click a face\n2. Drag\n\n| Key | Does |\n| --- | --- |\n| Ctrl | Copy |\n\n'),
      text('See [the guide](https://example.com/guide). <b>raw</b> ![x](https://example.com/x.png) [bad](javascript:alert(1))'),
      done(1),
    ]] });
    await say('make it *bigger*');
    const reply = log().querySelectorAll('.pf-fr-message.is-assistant')[1]!;
    expect(reply.querySelector('h2')?.textContent).toBe('Steps');
    expect(reply.querySelector('strong')?.textContent).toBe('Select');
    expect(reply.querySelector('code')?.textContent).toBe('Push/Pull');
    expect([...reply.querySelectorAll('ol > li')].map(li => li.textContent)).toEqual(['Click a face', 'Drag']);
    expect(reply.querySelector('td')?.textContent).toBe('Ctrl');
    const links = [...reply.querySelectorAll('a')];
    expect(links[0]).toMatchObject({ href: 'https://example.com/guide', target: '_blank' });
    expect(links[1]!.getAttribute('href')).toBe('');
    // Raw HTML stays text and images are not loaded.
    expect(reply.querySelector('b')).toBeNull();
    expect(reply.textContent).toContain('<b>raw</b>');
    expect(reply.querySelector('img')).toBeNull();
    const mine = log().querySelector('.pf-fr-message.is-user p')!;
    expect(mine.textContent).toBe('make it *bigger*');
    expect(mine.querySelector('em')).toBeNull();
  });

  it('shows one muted "Filed as" line with a plain ticket reference, forgets the draft, and starts a new conversation on the next send', async () => {
    const { backend } = setup({ turns: [
      [text('Send it?'), briefEvent(featureBrief, 'Mirror'), done(1)],
      filedTurn(makeFiledRequest({ issueKey: 'CUS-12' }), 2),
      [text('Second conversation.'), done(1)],
    ] });
    await say('Mirror');
    await say('yes');
    const filed = screen.getByRole('status');
    expect(filed.textContent).toBe('Filed as CUS-12');
    expect(filed.classList.contains('pf-fr-muted')).toBe(true);
    expect(within(filed).queryByRole('link')).toBeNull();
    // The agent's closing text follows the line; no filed screen, no "What happens next".
    expect(log().textContent).toContain('You will get an email shortly.');
    expect(log().textContent).not.toContain('What happens next');
    expect(backend.conversations.get('conv-1')?.status).toBe('filed');
    expect(readDrafts(account.id)).toEqual([]);
    // The transcript stays and the cards do not come back, but the composer is live.
    expect(screen.queryByRole('group', { name: CARDS })).toBeNull();
    expect(screen.getByLabelText('Your message').hasAttribute('disabled')).toBe(false);
    await say('Something else');
    expect(backend.calls.filter(call => call.path === '/conversations')).toHaveLength(2);
    expect(backend.calls.at(-2)).toMatchObject({ path: '/conversations', body: { kind: 'intake', path: 'open' } });
    expect(backend.calls.at(-1)).toMatchObject({ path: '/conversations/conv-2/messages', body: { text: 'Something else' } });
    expect(log().textContent).toContain('Filed as CUS-12');
    expect(log().textContent).toContain('Second conversation.');
    expect(readDrafts(account.id)[0]).toMatchObject({ conversationId: 'conv-2', path: 'open' });
  });
  it('shows "Added you to" for an add-me outcome, without a link when the request has none, and files nothing', async () => {
    const { backend } = setup({ turns: [[
      text('CUS-7 Mirror tool already tracks this. Add you to it?'), done(1)],
      [{ event: 'added', data: { request: makeFiledRequest({ id: 'req-7', issueKey: 'CUS-7', issueUrl: null }) } }, text('Done, you are on CUS-7.'), { event: 'done', data: { messageCount: 2, limitReached: false, ended: true } }],
    ] });
    await say('Mirror');
    await say('yes please');
    const added = screen.getByRole('status');
    expect(added.textContent).toBe('Added you to CUS-7');
    expect(within(added).queryByRole('link')).toBeNull();
    expect(log().textContent).toContain('Done, you are on CUS-7.');
    expect(backend.conversations.get('conv-1')?.status).toBe('closed');
    expect(backend.calls.filter(call => call.path.endsWith('/file') || call.path.endsWith('/add-me'))).toHaveLength(0);
    expect(readDrafts(account.id)).toEqual([]);
    expect(screen.queryByRole('group', { name: CARDS })).toBeNull();
  });
  it('clears the transcript and greets again when the agent started over (done with reason start_over)', async () => {
    const { backend } = setup({ turns: [
      [text('What are you trying to do?'), done(1)],
      [text('Starting over.'), { event: 'done', data: { messageCount: 2, limitReached: false, ended: true, reason: 'start_over' } }],
    ] });
    await say('Mirror');
    fireEvent.change(screen.getByLabelText('Your message'), { target: { value: 'start over' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('group', { name: CARDS });
    expect(log().textContent).toBe(`Agent${GREETING}` + CARD_NAMES.map((name, index) => name + ['Ask how something works. Answers come from the product documentation.', 'Something does not work as expected. The report includes your build and browser.', 'Describe what you cannot do today and what should change.'][index]).join(''));
    expect(backend.conversations.get('conv-1')?.status).toBe('discarded');
    expect(backend.calls.filter(call => call.path.endsWith('/discard'))).toHaveLength(0);
    expect(readDrafts(account.id)).toEqual([]);
    await say('again');
    expect(backend.calls.at(-1)?.path).toBe('/conversations/conv-2/messages');
  });
  it('ignores offer and duplicate events the server may still send', async () => {
    setup({ turns: [[text('Keep going.'), { event: 'offer', data: { kind: 'switch_path', data: { to: 'feature' } } },
      { event: 'duplicate', data: { issueKey: 'CUS-7', title: 'Mirror', requestId: 'req-7', notes: '' } }, { event: 'offer', data: { kind: 'add_me', data: { requestId: 'req-7' } } }, done(1)]] });
    await say('hello');
    expect(log().textContent).toContain('Keep going.');
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Notes/ })).toBeNull();
  });
  it('shows an error line with Retry when the tracker is unavailable and asks the user to wait when rate limited', async () => {
    const { backend } = setup({ turns: [
      [text('Send it?'), briefEvent({ ...featureBrief, desired: 'Mirror' }, 'Mirror'), done(1)],
      [{ event: 'error', data: { code: 'tracker_unavailable', message: 'The issue tracker could not be reached. Nothing was filed.' } }],
      filedTurn(),
      [{ event: 'error', data: { code: 'rate_limited', message: 'slow down' } }, done(3)],
    ] });
    await say('Mirror please');
    await say('yes');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('could not be reached');
    // The rejected confirmation left the transcript; Retry sends it again and the filing goes through.
    expect(log().textContent).not.toContain('yes');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Filed as CUS-12'));
    expect(messagePaths(backend)).toHaveLength(3);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('Your message'), { target: { value: 'again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(/wait a minute/);
    expect((screen.getByLabelText('Your message') as HTMLTextAreaElement).value).toBe('again');
    // The server never received the rejected message, so it is not shown as sent (it is back in the composer only).
    expect(log().textContent).not.toContain('again');
    expect(log().textContent).toContain('Mirror please');
    expect(messagePaths(backend)).toHaveLength(4);
  });
  it('removes a rejected first message, shows the cards again, and keeps one the server answered', async () => {
    setup({ turns: [[{ event: 'error', data: { code: 'unavailable', message: 'The assistant is not configured.' } }], [text('Noted.'), done(1)]] });
    await screen.findByRole('group', { name: CARDS });
    fireEvent.change(screen.getByLabelText('Your message'), { target: { value: 'lost one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toContain('not configured');
    expect(log().textContent).not.toContain('lost one');
    expect(await screen.findByRole('group', { name: CARDS })).toBeTruthy();
    await say('kept one');
    expect(log().textContent).toContain('kept one');
    expect(screen.queryByRole('group', { name: CARDS })).toBeNull();
  });
  it('reports an unauthorized stream as an error line and a conversation the server closed as ended', async () => {
    const { backend } = setup({ turns: [
      [{ event: 'error', data: { code: 'unauthorized', message: 'Sign in again.' } }],
      [text('I cannot continue with this content.'), { event: 'done', data: { messageCount: 1, limitReached: false, ended: true } }],
      [text('Fresh start.'), done(1)],
    ] });
    await screen.findByRole('group', { name: CARDS });
    fireEvent.change(screen.getByLabelText('Your message'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Sign in again.');
    await say('abuse');
    expect(log().textContent).toContain('I cannot continue');
    expect(readDrafts(account.id)).toEqual([]);
    expect(screen.getByLabelText('Your message').hasAttribute('disabled')).toBe(false);
    await say('sorry');
    expect(backend.calls.at(-1)?.path).toBe('/conversations/conv-2/messages');
  });
  it('aborts the in-flight turn when the panel unmounts', async () => {
    const backend = fakeBackend();
    let signal: AbortSignal | undefined;
    const hanging: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/messages')) return backend.fetch(input, init);
      signal = init?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('event: text\ndata: {"delta":"thinking"}\n\n')); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const client = new RequestsClient({ baseUrl: BASE, apikey: 'k', getToken: async () => 'jwt-token', fetch: hanging });
    const view = render(<Chat client={client} account={account} screen={screenInfo} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Your message'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(document.querySelector('.is-streaming')?.textContent).toContain('thinking'));
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
  it('shows a short muted notice when the message limit is reached and never a message counter', async () => {
    setup({ turns: [[text('That is all I can take; send it or stop?'), briefEvent({ ...featureBrief, desired: 'x' }, 'T'), done(30, true)]] });
    await say('hello');
    const notice = screen.getByRole('status');
    expect(notice.textContent).toBe('This conversation reached its 30-message limit.');
    expect(notice.classList.contains('pf-fr-muted')).toBe(true);
    expect(document.querySelector('.pf-fr-count')).toBeNull();
    expect(screen.queryByText(/of 30 messages/)).toBeNull();
    expect(screen.queryByRole('group', { name: 'Open requests' })).toBeNull();
    // The agent still takes the answer to its final question; the backend enforces the limit.
    expect(screen.getByLabelText('Your message').hasAttribute('disabled')).toBe(false);
  });
  it('draws the greeting, cards and composer before the backend answers, then applies the profile', async () => {
    const backend = fakeBackend({ me: { effective: 'none' } });
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: typeof fetch = async (input, init) => { if (String(input).endsWith('/me')) await gate; return backend.fetch(input, init); };
    const client = new RequestsClient({ baseUrl: BASE, apikey: 'k', getToken: async () => 'jwt-token', fetch: slow });
    const anchor = document.createElement('button'); document.body.append(anchor);
    render(<Chat client={client} account={account} screen={screenInfo} anchor={anchor} onClose={() => {}} />);
    // Nothing waits on /me: the greeting, the three cards and the composer are already there.
    expect(log().textContent).toContain(GREETING);
    expect((await cards()).map(card => (card as HTMLButtonElement).disabled)).toEqual([false, false, false]);
    expect(screen.getByLabelText('Your message')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    release();
    await waitFor(() => expect((screen.getAllByRole('button', { name: /Report a problem/ })[0] as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getAllByRole('button', { name: /Get help/ })[0] as HTMLButtonElement).disabled).toBe(false);
  });
  it('resumes the remembered conversation on reopen without cards and continues it', async () => {
    const first = setup({ turns: [[text('Hi.'), briefEvent(featureBrief, 'Mirror'), done(1)], [text('Still here.'), done(2)]] });
    await say('Mirror');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(first.onClose).toHaveBeenCalled();
    expect(first.backend.conversations.get('conv-1')?.status).toBe('open');
    cleanup();
    const client = new RequestsClient({ baseUrl: BASE, apikey: 'k', getToken: async () => 'jwt-token', fetch: first.backend.fetch });
    render(<Chat client={client} account={account} screen={screenInfo} onClose={() => {}} />);
    await waitFor(() => expect(log().textContent).toContain('Hi.'));
    expect(log().textContent).toContain(GREETING);
    expect(log().textContent).toContain('Mirror');
    expect(screen.queryByRole('group', { name: CARDS })).toBeNull();
    expect(screen.queryByText(/I cannot mirror a selection/)).toBeNull();
    expect(first.backend.calls.filter(call => call.path === '/conversations')).toHaveLength(1);
    await say('more');
    expect(first.backend.calls.at(-1)?.path).toBe('/conversations/conv-1/messages');
    expect(readDrafts(account.id)[0]).toMatchObject({ conversationId: 'conv-1' });
  });
  it('keeps the conversation and the unsent draft while closed, and sends nothing on reopen', async () => {
    const { backend, view, anchor, client } = setup({ turns: [[text('Hi.'), done(1)]] });
    await say('Mirror');
    fireEvent.change(screen.getByLabelText('Your message'), { target: { value: 'not sent yet' } });
    const before = backend.calls.length;
    view.rerender(<Chat client={client} account={account} screen={screenInfo} anchor={anchor} onClose={() => {}} open={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(<Chat client={client} account={account} screen={screenInfo} anchor={anchor} onClose={() => {}} open />);
    expect(screen.getByRole('dialog', { name: 'AI Chat' })).toBeTruthy();
    expect(log().textContent).toContain('Hi.');
    expect((screen.getByLabelText('Your message') as HTMLTextAreaElement).value).toBe('not sent yet');
    expect(backend.calls.length).toBe(before);
  });
  it('keeps remembered drafts when the open-conversation list cannot be fetched', async () => {
    rememberDraft(account.id, { conversationId: 'conv-9', path: 'feature', title: 'Kept' });
    const backend = fakeBackend();
    const flaky: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith('/conversations/open') ? new Response('{"error":{"code":"unavailable","message":"down"}}', { status: 503 }) : backend.fetch(input, init);
    };
    const client = new RequestsClient({ baseUrl: BASE, apikey: 'k', getToken: async () => 'jwt-token', fetch: flaky });
    render(<Chat client={client} account={account} screen={screenInfo} onClose={() => {}} />);
    await screen.findByRole('group', { name: CARDS });
    expect(readDrafts(account.id).map(draft => draft.conversationId)).toEqual(['conv-9']);
  });
  it('forgets a filed or stale remembered conversation and greets instead', async () => {
    rememberDraft(account.id, { conversationId: 'gone', path: 'feature', title: 'Old' });
    const { backend } = setup();
    await screen.findByRole('group', { name: CARDS });
    await waitFor(() => expect(readDrafts(account.id)).toEqual([]));
    expect(backend.calls.filter(call => call.path === '/requests')).toHaveLength(0);
  });
  it('reports an unavailable backend with Retry, and an expired session as a sign-in prompt', async () => {
    const backend = fakeBackend();
    let failures = 1;
    const flaky: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/me') && failures-- > 0) return new Response('{"error":{"code":"unavailable","message":"down"}}', { status: 503 });
      return backend.fetch(input, init);
    };
    const client = new RequestsClient({ baseUrl: BASE, apikey: 'k', getToken: async () => 'jwt-token', fetch: flaky });
    render(<Chat client={client} account={account} screen={screenInfo} onClose={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toContain('down');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('group', { name: CARDS });
    cleanup();
    const signedOut = new RequestsClient({ baseUrl: BASE, apikey: 'k', getToken: async () => null, fetch: backend.fetch });
    render(<Chat client={signedOut} account={account} screen={screenInfo} onClose={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Sign in again to use AI Chat.');
  });
});

describe('document editing', () => {
  const LAYOUT = { type: 'layout', apiVersion: 1 } as const;
  const call = { id: 'c1', name: 'layout_apply_operations', input: { expectedRevision: 0, label: 'Title block', operations: [] } };
  const toolRequest: FakeTurn = { event: 'tool_request', data: { calls: [call] } };
  const awaiting: FakeTurn = { event: 'done', data: { messageCount: 1, limitReached: false, ended: false, awaitingTools: true } };
  it('sends the bound document, runs requested calls against it, posts the results and shows the change line between the replies', async () => {
    const run = vi.fn(() => ({ content: '{"ok":true,"revision":1}', isError: false, notice: 'Changed the document: Title block. Undo reverts it.' }));
    const documentTools = vi.fn(() => ({ document: LAYOUT, run }));
    const { backend } = setup({ turns: [[text('Adding a title block.'), toolRequest, awaiting], [text('Done: the title block is on page 1.'), done(1)]] }, { documentTools });
    await say('Add a title block');
    await waitFor(() => expect(log().textContent).toContain('Done: the title block is on page 1.'));
    expect(documentTools).toHaveBeenCalledTimes(1);
    expect(backend.calls.find(c => c.path.endsWith('/messages'))?.body).toMatchObject({ text: 'Add a title block', document: LAYOUT });
    expect(run).toHaveBeenCalledWith(call, expect.any(AbortSignal));
    expect(backend.calls.find(c => c.path.endsWith('/tool-results'))?.body).toEqual({ results: [{ toolUseId: 'c1', content: '{"ok":true,"revision":1}', isError: false }] });
    const lines = [...log().querySelectorAll('.pf-fr-message')].map(el => el.textContent ?? '');
    const at = (needle: string) => lines.findIndex(line => line.includes(needle));
    expect(at('Adding a title block.')).toBeLessThan(at('Changed the document: Title block.'));
    expect(at('Changed the document: Title block.')).toBeLessThan(at('Done: the title block'));
  });
  it('shows a reply split by tool calls under one Agent label and drops blank text before a call', async () => {
    const run = vi.fn(() => ({ content: '{"ok":true,"revision":1}', isError: false }));
    setup({ turns: [[text('\n\n'), toolRequest, awaiting], [text('Checking the page.'), toolRequest, awaiting], [text('Added the hallway.'), done(1)]] },
      { documentTools: () => ({ document: LAYOUT, run }) });
    await say('Add a hallway');
    await waitFor(() => expect(log().textContent).toContain('Added the hallway.'));
    const replies = [...log().querySelectorAll('.pf-fr-message.is-assistant')].slice(1);
    expect(replies.map(el => el.textContent)).toEqual(['AgentChecking the page.', 'Added the hallway.']);
    expect([...log().querySelectorAll('.pf-fr-role')].map(el => el.textContent)).toEqual(['Agent', 'You', 'Agent']);
  });
  it('answers with an error result when the editor throws, and sends no document when the tab offers none', async () => {
    const run = vi.fn(() => { throw new Error('boom'); });
    const { backend } = setup({ turns: [[toolRequest, awaiting], [text('That did not work.'), done(1)]] }, { documentTools: () => ({ document: LAYOUT, run }) });
    await say('Add a title block');
    await waitFor(() => expect(log().textContent).toContain('That did not work.'));
    expect(backend.calls.find(c => c.path.endsWith('/tool-results'))?.body).toEqual({ results: [{ toolUseId: 'c1', content: 'The editor could not run layout_apply_operations: boom', isError: true }] });
    cleanup();
    const home = setup({ turns: [[text('Hi.'), done(1)]] }, { documentTools: () => null });
    await say('hello');
    expect(home.backend.calls.find(c => c.path.endsWith('/messages'))?.body).toEqual({ text: 'hello' });
  });
});

describe('a conversation per document', () => {
  const kept = (id: string) => ({ id, kind: 'intake', path: 'feature' as const, status: 'open', title: 'Kept', brief: null,
    messages: [{ role: 'assistant', text: `Hello from ${id}`, at: '2026-10-25T10:00:00Z' }], messageCount: 1, requestId: null, updatedAt: '2026-10-25T10:00:00Z' });
  const open = () => [kept('conv-a'), kept('conv-old')];
  it('resumes only the conversation remembered for its own document; Home resumes drafts written before scopes', async () => {
    rememberDraft(account.id, { conversationId: 'conv-old', path: 'feature', title: 'Old' });
    rememberDraft(account.id, { conversationId: 'conv-a', path: 'feature', title: 'A', scope: 'document:a' });
    setup({ openConversations: open() }, { scope: 'document:b' });
    await screen.findByRole('group', { name: CARDS });
    await waitFor(() => expect(screen.getByLabelText('Your message')).toBeTruthy());
    expect(log().textContent).not.toContain('Hello from');
    cleanup();
    setup({ openConversations: open() }, { scope: 'document:a' });
    await waitFor(() => expect(log().textContent).toContain('Hello from conv-a'));
    cleanup();
    setup({ openConversations: open() });
    await waitFor(() => expect(log().textContent).toContain('Hello from conv-old'));
    expect(readDrafts(account.id).map(draft => draft.conversationId).sort()).toEqual(['conv-a', 'conv-old']);
  });
  it('remembers its conversation under its scope and re-files it when the document gets a lasting identity', async () => {
    const { client, anchor, onClose, view } = setup({ turns: [[text('Hi.'), done(1)]] }, { scope: 'tab:tab-2' });
    await say('hello');
    expect(readDrafts(account.id)).toMatchObject([{ conversationId: 'conv-1', scope: 'tab:tab-2' }]);
    view.rerender(<Chat client={client} account={account} screen={screenInfo} anchor={anchor} onClose={onClose} scope="document:cloud-9" />);
    await waitFor(() => expect(readDrafts(account.id)).toMatchObject([{ conversationId: 'conv-1', scope: 'document:cloud-9' }]));
    expect(log().textContent).toContain('Hi.');
  });
});

describe('Clear Chat and slash commands', () => {
  it('/clear discards the conversation on the server, forgets it here and returns to the greeting without asking the agent', async () => {
    const { backend } = setup({ turns: [[text('Hi.'), done(1)]] }, { scope: 'document:a' });
    await say('hello');
    expect(readDrafts(account.id)).toHaveLength(1);
    const sent = messagePaths(backend).length;
    fireEvent.change(screen.getByLabelText('Your message'), { target: { value: '/clear' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('group', { name: CARDS });
    expect(log().textContent).not.toContain('hello');
    expect((screen.getByLabelText('Your message') as HTMLTextAreaElement).value).toBe('');
    expect(messagePaths(backend)).toHaveLength(sent);
    await waitFor(() => expect(backend.calls.some(call => call.method === 'POST' && call.path === '/conversations/conv-1/discard')).toBe(true));
    expect(backend.conversations.get('conv-1')?.status).toBe('discarded');
    expect(readDrafts(account.id)).toEqual([]);
    await say('a fresh start');
    expect(backend.calls.filter(call => call.method === 'POST' && call.path === '/conversations')).toHaveLength(2);
  });
  it('lists matching commands as "/" is typed, runs one when clicked, and reports an unknown command without sending it', async () => {
    const { backend } = setup({ turns: [[text('Hi.'), done(1)]] });
    await say('hello');
    fireEvent.change(screen.getByLabelText('Your message'), { target: { value: '/' } });
    const list = screen.getByRole('group', { name: 'Chat commands' });
    expect(within(list).getAllByRole('button').map(button => button.textContent)).toEqual(['/clearClear this chat and start a new conversation for this document.']);
    fireEvent.change(screen.getByLabelText('Your message'), { target: { value: '/x' } });
    expect(screen.queryByRole('group', { name: 'Chat commands' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('status').textContent).toBe('Unknown command /x. Commands: /clear.');
    expect((screen.getByLabelText('Your message') as HTMLTextAreaElement).value).toBe('/x');
    expect(messagePaths(backend)).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Your message'), { target: { value: '/cl' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Chat commands' })).getByRole('button'));
    await screen.findByRole('group', { name: CARDS });
    expect(log().textContent).not.toContain('hello');
  });
  it('clears when the host raises the clear signal (the Clear Chat command), including a conversation only remembered from before', async () => {
    rememberDraft(account.id, { conversationId: 'conv-a', path: 'feature', title: 'A', scope: 'document:a' });
    rememberDraft(account.id, { conversationId: 'conv-b', path: 'feature', title: 'B', scope: 'document:b' });
    const remembered = (id: string) => ({ id, kind: 'intake', path: 'feature' as const, status: 'open', title: id, brief: null,
      messages: [{ role: 'assistant', text: `Hello from ${id}`, at: '2026-10-25T10:00:00Z' }], messageCount: 1, requestId: null, updatedAt: '2026-10-25T10:00:00Z' });
    const { client, anchor, onClose, view, backend } = setup({ openConversations: [remembered('conv-a'), remembered('conv-b')] }, { scope: 'document:a', clearSignal: 0 });
    await waitFor(() => expect(log().textContent).toContain('Hello from conv-a'));
    view.rerender(<Chat client={client} account={account} screen={screenInfo} anchor={anchor} onClose={onClose} scope="document:a" clearSignal={1} />);
    await waitFor(() => expect(backend.calls.some(call => call.path === '/conversations/conv-a/discard')).toBe(true));
    expect(readDrafts(account.id).map(draft => draft.conversationId)).toEqual(['conv-b']);
    expect(log().textContent).not.toContain('Hello from conv-a');
    expect(backend.conversations.get('conv-b')?.status).toBe('open');
  });
});

describe('Chat docked', () => {
  it('renders inline as a region with the same chat, no portal or fixed position, and focuses the composer', async () => {
    const { view } = setup({}, { placement: 'docked' });
    const region = await screen.findByRole('region', { name: 'AI Chat' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(region.classList.contains('pf-fr-docked')).toBe(true);
    expect(region.classList.contains('pf-fr-popover')).toBe(false);
    expect(view.container.contains(region)).toBe(true);
    expect(region.style.position).toBe('');
    expect((await cards()).map(button => button.querySelector('strong')?.textContent)).toEqual(CARD_NAMES);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Your message')));
  });
  it('stays open on a click outside or an Escape outside, hides on Escape inside and returns focus to its icon', async () => {
    const { anchor, onClose, view, client } = setup({}, { placement: 'docked' });
    const composer = await screen.findByLabelText('Your message');
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.change(composer, { target: { value: 'kept' } });
    fireEvent.keyDown(composer, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(anchor);
    view.rerender(<Chat client={client} account={account} screen={screenInfo} anchor={anchor} onClose={onClose} placement="docked" open={false} />);
    expect(screen.queryByRole('region', { name: 'AI Chat' })).toBeNull();
    fireEvent.keyDown(composer, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(<Chat client={client} account={account} screen={screenInfo} anchor={anchor} onClose={onClose} placement="docked" open />);
    expect((screen.getByLabelText('Your message') as HTMLTextAreaElement).value).toBe('kept');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Your message')));
  });
  it('shares the pop-down key isolation: workspace shortcuts never see keys typed inside and Enter sends', async () => {
    const { workspaceKeys, backend } = setup({}, { placement: 'docked' });
    const composer = await screen.findByLabelText('Your message');
    fireEvent.keyDown(composer, { key: 'Delete' });
    fireEvent.keyUp(composer, { key: 'Delete' });
    expect(workspaceKeys).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'r' });
    expect(workspaceKeys).toHaveBeenCalledTimes(1);
    fireEvent.change(composer, { target: { value: 'hello' } });
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
    expect(backend.calls.filter(call => call.path === '/conversations')).toHaveLength(0);
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(messagePaths(backend)).toHaveLength(1));
    await settled();
  });
});

describe('ticket images', () => {
  const chooseFiles = (...files: File[]): void => { fireEvent.change(screen.getByLabelText('Image files'), { target: { files } }); };
  const readyImages = async (): Promise<void> => { await waitFor(() => expect(screen.getByRole('button', { name: 'Upload images' }).hasAttribute('disabled')).toBe(false)); };
  it.each(['Report a problem', 'Request a feature'])('shows removable images on %s and uploads them before sending the confirmation', async label => {
    const captureScreenshot = vi.fn(async () => new Blob(['auto'], { type: 'image/png' }));
    const { backend } = setup({}, { captureScreenshot });
    await pick(label); await readyImages();
    expect(screen.getByRole('button', { name: 'Remove Current view.png' })).toBeTruthy();
    chooseFiles(new File(['image'], 'reference.png', { type: 'image/png' }));
    expect(backend.uploads.size).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Current view.png' }));
    await say('Yes, file this');
    expect(backend.attachments.get('conv-1')?.map(a => a.name)).toEqual(['reference.png']);
    const complete = backend.calls.findIndex(c => c.path.endsWith('/complete'));
    const message = backend.calls.findLastIndex(c => c.path.endsWith('/messages'));
    expect(complete).toBeGreaterThan(0); expect(complete).toBeLessThan(message);
    expect(captureScreenshot).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference.png' }));
    await waitFor(() => expect(backend.attachments.get('conv-1')).toEqual([]));
  });
  it('keeps replacement image previews after upload/messages and offers retry on a failed download', async () => {
    const create = vi.fn(() => `blob:preview-${create.mock.calls.length}`);
    const revoke = vi.fn();
    const NativeURL = URL;
    vi.stubGlobal('URL', class extends NativeURL {
      static override createObjectURL = create;
      static override revokeObjectURL = revoke;
    });
    const { client, view, anchor, onClose } = setup({}, { captureScreenshot: async () => new Blob(['auto'], { type: 'image/png' }) });
    const load = vi.spyOn(client, 'attachmentBlob').mockRejectedValueOnce(new Error('Preview unavailable'))
      .mockResolvedValue(new Blob(['replacement'], { type: 'image/png' }));
    await pick('Report a problem'); await readyImages();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Current view.png' }));
    chooseFiles(new File(['replacement'], 'replacement.png', { type: 'image/png' }));
    const local = screen.getByRole('img', { name: 'replacement.png' }).getAttribute('src');
    await say('Undo left the rectangle on the page.');
    expect(load).not.toHaveBeenCalled();
    view.unmount();
    render(<Chat client={client} account={account} screen={screenInfo} anchor={anchor} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry preview for replacement.png' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'replacement.png' }).getAttribute('src')).toMatch(/^blob:/));
    const uploaded = screen.getByRole('img', { name: 'replacement.png' }).getAttribute('src');
    expect(revoke).toHaveBeenCalledWith(local);
    await say('Yes, that is the problem.');
    expect(screen.getByRole('img', { name: 'replacement.png' }).getAttribute('src')).toBe(uploaded);
    expect(load).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove replacement.png' }));
    await waitFor(() => expect(screen.queryByRole('img', { name: 'replacement.png' })).toBeNull());
    expect(revoke).toHaveBeenCalledWith(uploaded);
  });
  it('validates image types and sizes, counts the automatic screenshot toward the limit and releases a removed slot', async () => {
    setup({}, { captureScreenshot: async () => new Blob(['auto'], { type: 'image/png' }) });
    await pick('Report a problem'); await readyImages();
    chooseFiles(new File(['<svg/>'], 'bad.svg', { type: 'image/svg+xml' }));
    expect(screen.getByRole('status').textContent).toContain('PNG, JPEG or WebP');
    chooseFiles(new File([], 'empty.png', { type: 'image/png' }));
    expect(screen.getByRole('status').textContent).toContain('1 byte');
    chooseFiles(...Array.from({ length: 5 }, (_, i) => new File(['png'], `${i}.png`, { type: 'image/png' })));
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Upload images' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Current view.png' }));
    await readyImages();
    expect(screen.queryByRole('button', { name: 'Attach this document' })).toBeNull();
  });
  it('retains an image after upload failure, blocks the message, and uploads it on retry', async () => {
    const { client, backend } = setup({}, { captureScreenshot: async () => new Blob(['auto'], { type: 'image/png' }) });
    await pick('Request a feature'); await readyImages();
    const sent = messagePaths(backend).length;
    vi.spyOn(client, 'attach').mockRejectedValueOnce(new Error('Upload unavailable'));
    await say('Please file it');
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Upload unavailable'));
    expect(messagePaths(backend)).toHaveLength(sent);
    expect(screen.getByRole('button', { name: 'Remove Current view.png' })).toBeTruthy();
    await say('Please file it again');
    expect(messagePaths(backend)).toHaveLength(sent + 1);
    expect(backend.attachments.get('conv-1')?.map(a => a.name)).toEqual(['Current view.png']);
  });
  it('does not reattach a removed automatic screenshot when the same conversation resumes', async () => {
    const captureScreenshot = vi.fn(async () => new Blob(['auto'], { type: 'image/png' }));
    const { client, view, anchor, onClose } = setup({}, { captureScreenshot });
    await pick('Request a feature'); await readyImages();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Current view.png' }));
    view.unmount();
    render(<Chat client={client} account={account} screen={screenInfo} anchor={anchor} onClose={onClose} captureScreenshot={captureScreenshot} />);
    await readyImages();
    expect(screen.queryByRole('button', { name: 'Remove Current view.png' })).toBeNull();
    expect(captureScreenshot).toHaveBeenCalledTimes(1);
  });
  it('does not block filing when capture fails, and never captures for ordinary help', async () => {
    const captureScreenshot = vi.fn(async () => { throw new Error('unavailable'); });
    setup({}, { captureScreenshot });
    await pick('Get help');
    expect(captureScreenshot).not.toHaveBeenCalled();
    cleanup();
    setup({}, { captureScreenshot });
    await pick('Report a problem'); await readyImages();
    expect(screen.getByRole('status').textContent).toContain('could not be captured');
    await say('The tool crashes');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});


it('shows instructions before waiting and cancels the old cue when the user sends another message', async () => {
  let signal: AbortSignal | undefined;
  const run = vi.fn((_call: unknown, boundSignal?: AbortSignal) => {
    signal = boundSignal;
    return new Promise<{ content: string; isError: boolean }>(resolve => {
      boundSignal?.addEventListener('abort', () => resolve({ content: '{"status":"cancelled"}', isError: false }), { once: true });
    });
  });
  const guideCall = { id: 'guide', name: 'ui_highlight', input: { targets: ['toolbar:line'], instruction: 'Choose Import, then select a PNG image.' } };
  const { backend } = setup({ turns: [[{ event: 'tool_request', data: { calls: [guideCall] } },
    { event: 'done', data: { messageCount: 1, limitReached: false, ended: false, awaitingTools: true } }], [text('We can try something else.'), done(2)]] },
    { documentTools: () => ({ document: { type: 'model', apiVersion: 1, guidance: 1 }, run }) });
  fireEvent.change(await screen.findByLabelText('Your message'), { target: { value: 'Teach me to draw.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(log().textContent).toContain('Choose Import, then select a PNG image.');
  expect(document.querySelector('.pf-ai-guidance-instruction')).toBeNull();
  expect((screen.getByLabelText('Your message') as HTMLTextAreaElement).disabled).toBe(false);
  await say('Try something else');
  expect(signal?.aborted).toBe(true);
  expect(log().textContent).toContain('We can try something else.');
  expect(backend.calls.some(call => call.path.endsWith('/tool-results'))).toBe(false);
  await act(async () => {});
});
