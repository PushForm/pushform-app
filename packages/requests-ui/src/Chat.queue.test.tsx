// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Chat, type ChatProps, type DocumentToolSession } from './Chat';
import { RequestsClient } from './client';
import { BASE, fakeBackend, type FakeTurn } from './fakeBackend';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
function setup(extra: Partial<ChatProps> = {}) {
  const backend = fakeBackend();
  const requests: { body: Record<string, unknown>; signal: AbortSignal; finish(events?: FakeTurn[]): void }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (!String(input).endsWith('/messages')) return backend.fetch(input, init);
    const signal = init!.signal as AbortSignal, body = JSON.parse(init!.body as string) as Record<string, unknown>;
    const number = requests.length + 1;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      let closed = false;
      const emit = (event: FakeTurn) => controller.enqueue(new TextEncoder().encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`));
      signal.addEventListener('abort', () => { if (!closed) { closed = true; controller.close(); } }, { once: true });
      emit({ event: 'text', data: { delta: `Reply ${number}` } });
      requests.push({ body, signal, finish(events = [{ event: 'done', data: { messageCount: number, limitReached: false } }]) {
        if (closed) return; for (const event of events) emit(event); closed = true; controller.close();
      } });
    } });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };
  const client = new RequestsClient({ baseUrl: BASE, apikey: 'k', getToken: async () => 'jwt-token', fetch: fetcher });
  const props: ChatProps = { client, account: { id: 'alice', email: 'alice@example.com' },
    screen: { editor: 'model', documentType: 'model', build: { version: 'test', commit: 'test' }, browser: 'TestBrowser', os: 'TestOS' }, onClose: vi.fn(), ...extra };
  const view = render(<Chat {...props}/>);
  return { requests, backend, props, view };
}
async function send(text: string, queued = false, enter = false) {
  const input = await screen.findByRole('textbox', { name: 'Your message' });
  fireEvent.change(input, { target: { value: text } });
  if (enter) fireEvent.keyDown(input, { key: 'Enter' });
  else fireEvent.click(screen.getByRole('button', { name: queued ? 'Queue message' : 'Send' }));
}
const pending = () => screen.getByRole('region', { name: 'Queued messages' });

it('queues with Enter, sends in order after replies, and keeps document binding and a newer draft', async () => {
  let tools: DocumentToolSession = { document: { type: 'model', apiVersion: 1 }, run: vi.fn() };
  const f = setup({ documentTools: () => tools });
  await send('First'); await waitFor(() => expect(f.requests).toHaveLength(1));
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Your message' });
  expect(input.disabled).toBe(false); expect(input.placeholder).toBe('Queue a follow-up message');
  await send('Second', true, true); await send('Third', true);
  expect(within(pending()).getAllByRole('listitem')).toHaveLength(2);
  expect(f.requests).toHaveLength(1);
  tools = { document: { type: 'layout', apiVersion: 1 }, run: vi.fn() };
  fireEvent.change(input, { target: { value: 'Still drafting' } });
  act(() => f.requests[0]!.finish());
  await waitFor(() => expect(f.requests).toHaveLength(2));
  expect(f.requests[1]!.body).toMatchObject({ text: 'Second', document: { type: 'model' } });
  expect(input.value).toBe('Still drafting');
  act(() => f.requests[1]!.finish());
  await waitFor(() => expect(f.requests).toHaveLength(3));
  expect(f.requests[2]!.body.text).toBe('Third');
  act(() => f.requests[2]!.finish());
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
  expect(f.backend.calls.filter(call => call.path === '/conversations')).toHaveLength(1);
});
it('removes pending messages and pauses the remaining queue when stopped', async () => {
  const f = setup(); await send('First'); await waitFor(() => expect(f.requests).toHaveLength(1));
  await send('Remove me', true); await send('Keep me', true);
  fireEvent.click(screen.getByRole('button', { name: 'Remove queued message: Remove me' }));
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await screen.findByRole('button', { name: 'Send next' });
  expect(f.requests[0]!.signal.aborted).toBe(true); expect(f.requests).toHaveLength(1);
  expect(pending().textContent).toContain('Keep me'); expect(pending().textContent).not.toContain('Remove me');
  fireEvent.click(screen.getByRole('button', { name: 'Send next' }));
  await waitFor(() => expect(f.requests).toHaveLength(2));
  expect(f.requests[1]!.body.text).toBe('Keep me');
});
it('pauses on failure and retains a rejected queued message for explicit retry', async () => {
  const f = setup(); await send('First'); await waitFor(() => expect(f.requests).toHaveLength(1));
  await send('Second', true);
  act(() => f.requests[0]!.finish([{ event: 'error', data: { code: 'unavailable', message: 'Try later' } }]));
  fireEvent.click(await screen.findByRole('button', { name: 'Send next' }));
  await waitFor(() => expect(f.requests).toHaveLength(2));
  act(() => f.requests[1]!.finish([{ event: 'error', data: { code: 'unavailable', message: 'Try later' } }]));
  await screen.findByRole('button', { name: 'Send next' });
  expect(pending().textContent).toContain('Second'); expect(f.requests).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Send next' }));
  await waitFor(() => expect(f.requests).toHaveLength(3));
  expect(f.requests[2]!.body.text).toBe('Second');
});
it('keeps a hidden queue and sends it when that conversation is shown again', async () => {
  const f = setup(); await send('First'); await waitFor(() => expect(f.requests).toHaveLength(1));
  await send('Second', true); f.view.rerender(<Chat {...f.props} open={false}/>);
  await act(async () => { f.requests[0]!.finish(); });
  expect(f.requests).toHaveLength(1);
  f.view.rerender(<Chat {...f.props} open/>);
  await waitFor(() => expect(f.requests).toHaveLength(2));
  expect(f.requests[1]!.body.text).toBe('Second');
});
it('does not send the next message when a stream closes without confirming completion', async () => {
  const f = setup(); await send('First'); await waitFor(() => expect(f.requests).toHaveLength(1));
  await send('Second', true);
  await act(async () => { f.requests[0]!.finish([]); });
  expect(f.requests).toHaveLength(1);
  expect(pending().textContent).toContain('Queued messages paused');
  expect(screen.getByRole('button', { name: 'Send next' })).toBeTruthy();
});
it('waits for explicit confirmation to send queued text after a conversation ends', async () => {
  const f = setup(); await send('First'); await waitFor(() => expect(f.requests).toHaveLength(1));
  await send('Another topic', true);
  await act(async () => { f.requests[0]!.finish([{ event: 'done', data: { messageCount: 1, limitReached: false, ended: true } }]); });
  expect(f.requests).toHaveLength(1); expect(pending().textContent).toContain('Another topic');
  fireEvent.click(await screen.findByRole('button', { name: 'Send next' }));
  await waitFor(() => expect(f.requests).toHaveLength(2));
  expect(f.backend.calls.filter(call => call.path === '/conversations')).toHaveLength(2);
  expect(f.requests[1]!.body.text).toBe('Another topic');
});
it.each(['clear', 'account'] as const)('discards pending messages on %s and cancels old work', async action => {
  const f = setup(); await send('First'); await waitFor(() => expect(f.requests).toHaveLength(1));
  await send('Never send this', true);
  if (action === 'clear') await send('/clear', true, true);
  else f.view.rerender(<Chat {...f.props} account={{ id: 'bob', email: 'bob@example.com' }}/>);
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Queued messages' })).toBeNull());
  expect(f.requests[0]!.signal.aborted).toBe(true);
  act(() => f.requests[0]!.finish());
  expect(f.requests).toHaveLength(1);
});
it('keeps pictures with a queued message and uploads them only before that message sends', async () => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }));
  const f = setup(); await send('First'); await waitFor(() => expect(f.requests).toHaveLength(1));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add picture' }).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Picture files'), { target: { files: [new File(['pixels'], 'part.png', { type: 'image/png' })] } });
  await screen.findByRole('list', { name: 'Pictures to send' });
  await send('Use this picture', true);
  expect(f.backend.calls.some(call => call.path.endsWith('/attachments'))).toBe(false);
  expect(pending().textContent).toContain('1 picture');
  act(() => f.requests[0]!.finish());
  await waitFor(() => expect(f.requests).toHaveLength(2));
  expect(f.requests[1]!.body).toMatchObject({ text: 'Use this picture', attachments: ['att-1'] });
});
