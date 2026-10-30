// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type JSX } from 'react';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_REPORT, formatBytes, RequestsError, SCREENSHOT_TYPES, type Attachment, type AttachmentFile, type Conversation, type ConversationPath, type ConversationSummary, type DocumentDescriptor, type IntentPath, type Me, type Message, type RequestsClient, type ScreenInfo, type ToolCall, type ToolCallResult } from './client';
import { draftScope, forgetDraft, HOME_SCOPE, readDrafts, rememberDraft } from './drafts';
import { DockedPanel } from './DockedPanel';
import { Popover } from './Popover';
import { MessageMarkdown } from './MessageMarkdown';

export interface ChatProps {
  readonly client: RequestsClient;
  /** The signed-in account: its id scopes remembered drafts, its email receives notifications. */
  readonly account: { readonly id: string; readonly email: string };
  readonly screen: ScreenInfo;
  /** The icon that opens the panel: the pop-down hangs under it; focus returns to it on close (docked: on Escape). */
  readonly anchor?: HTMLElement | null | undefined;
  /** 'popover' (default, Home) hangs under its icon; 'docked' fills an editor's side dock. */
  readonly placement?: 'popover' | 'docked' | undefined;
  readonly onClose: () => void;
  /** False hides the pop-down without unmounting it: the conversation stays in memory for the next open. */
  readonly open?: boolean | undefined;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null | undefined;
  /**
   * The document this panel's conversation belongs to: it resumes only a remembered conversation of the
   * same scope and remembers its own under it. Read on mount; a later change (an unsaved document receiving its cloud
   * identity) re-files the remembered conversation without restarting the chat. Defaults to Home's scope.
   */
  readonly scope?: string | undefined;
  /** Each increase clears this panel's conversation, as `/clear` does; the host's Clear Chat command raises it. */
  readonly clearSignal?: number | undefined;
  /**
   * The open document of the active tab, read when a message is sent: the turn's document tool calls
   * all run against what this returned then, whatever tab is active later. Null or absent offers no document tools.
   */
  readonly documentTools?: (() => DocumentToolSession | null) | undefined;
  /**
   * A copy of the active tab's document, made only when the requester asks to attach it to a problem report.
   * Null when no document is open; absent offers no document copy.
   */
  readonly captureScreenshot?: (() => Promise<Blob | null>) | undefined;
  /** Called once per message the requester sends to the agent (not for chat commands), for the host's usage count. */
  readonly onMessage?: (() => void) | undefined;
}

/** The active document as a file, for a problem report's attachment. */
export interface DocumentCopy { readonly name: string; readonly blob: Blob }

/** One tab's open document as the chat can use it. */
export interface DocumentToolSession {
  readonly document: DocumentDescriptor;
  /** Runs one call; failures are error results, never exceptions. `notice` is a transcript line for a change to the document. */
  run(call: ToolCall, signal?: AbortSignal): Promise<DocumentToolOutcome> | DocumentToolOutcome;
}
export interface DocumentToolOutcome { readonly content: string; readonly isError: boolean; readonly notice?: string | undefined }

type View =
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'chat' };

/** A transcript line: a persisted message, or a local system line such as "Filed as CUS-12". */
type Entry = Message | { readonly role: 'system'; readonly text: string; readonly at: string };

interface ChatState {
  /**
   * Null until the first message, which creates the conversation on the server with `path: 'open'`, and
   * again once the server has ended it (filed, added, closed): the next message then starts a new conversation
   * while the transcript stays on screen.
   */
  readonly conversation: Conversation | null;
  readonly transcript: readonly Entry[];
  readonly streaming: string | null;
  readonly path: ConversationPath;
  readonly messageCount: number;
  readonly limitReached: boolean;
}

/** The first assistant message, rendered locally and never persisted. */
export const GREETING = 'How can I help you?';
export const INTENT_CARDS: readonly { readonly intent: IntentPath; readonly label: string; readonly detail: string }[] = [
  { intent: 'help', label: 'Get help', detail: 'Ask how something works. Answers come from the product documentation.' },
  { intent: 'problem', label: 'Report a problem', detail: 'Something does not work as expected. The report includes your build and browser.' },
  { intent: 'feature', label: 'Request a feature or change', detail: 'Describe what you cannot do today and what should change.' },
];
const FILING_UNAVAILABLE = 'Filing is not available in this product for your account. You can still get help.';
/** Chat commands: a message starting with "/" runs here and is never sent to the agent. */
export const SLASH_COMMANDS: readonly { readonly name: string; readonly description: string }[] = [
  { name: 'clear', description: 'Clear this chat and start a new conversation for this document.' },
];
const slashName = (message: string): string => message.slice(1).split(/\s/, 1)[0]!.toLowerCase();
const visible = (messages: readonly Message[]): Message[] => messages.filter(message => message.role !== 'tool' && (message.role !== 'assistant' || !!message.text.trim()));
const errorText = (cause: unknown): string => cause instanceof Error ? cause.message : 'Something went wrong.';
const EMPTY: ChatState = { conversation: null, transcript: [], streaming: null, path: 'open', messageCount: 0, limitReached: false };
function fromConversation(conversation: Conversation): ChatState {
  return { ...EMPTY, conversation, transcript: visible(conversation.messages), path: conversation.path, messageCount: conversation.messageCount };
}

/**
 * AI Chat: a chat docked beside an editor or popped
 * down under the Home icon. It greets, offers three intent cards inside the conversation, and streams agent turns. Everything else
 * happens in the conversation: the agent gathers the brief, writes it back as text, asks for confirmation and
 * files on an explicit yes; the panel only shows the resulting "Filed as" or "Added you to" line. Closing keeps
 * the conversation; reopening resumes it; asking the agent to start over, Clear Chat or `/clear` discards it. There is no header row:
 * Escape or the icon hide it, and on Home also a click outside (user decisions 2026-10-24, 2026-10-25).
 */
export function Chat({ client, account, screen, anchor, placement = 'popover', onClose, open = true, storage, documentTools, captureScreenshot, onMessage, scope = HOME_SCOPE, clearSignal = 0 }: ChatProps): JSX.Element {
  // The greeting, cards and composer draw at once; the profile and any resumable conversation load behind them.
  const [view, setView] = useState<View>({ kind: 'chat' });
  const [me, setMe] = useState<Me | null>(null);
  const [chat, setChat] = useState<ChatState>(EMPTY);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [waitingForGuidance, setWaitingForGuidance] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; retry?: (() => void) | undefined } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const alive = useRef(true), composer = useRef<HTMLTextAreaElement>(null), transcriptEnd = useRef<HTMLDivElement>(null);
  /** The in-flight turn, aborted on unmount so a closed panel does not keep a stream open. */
  const turn = useRef<AbortController | null>(null);
  const draftStorage = storage === undefined ? undefined : storage;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  /** Bumped by Clear Chat: work started before it never touches the cleared chat. */
  const generation = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; turn.current?.abort(); }; }, []);

  // Resume the open conversation this browser remembers for the account; otherwise greet. Nothing waits on the
  // backend: the chat renders immediately, the remembered conversation is fetched in parallel with the profile and the
  // open list, and it replaces the greeting only while the requester has not started a new conversation here.
  const started = useRef(false);
  useEffect(() => {
    let current = true;
    started.current = false;
    setView({ kind: 'chat' });
    const drafts = readDrafts(account.id, draftStorage).filter(draft => draftScope(draft) === scopeRef.current);
    const remembered = drafts[0];
    const resuming = remembered ? client.getConversation(remembered.conversationId).then(c => fromConversation(c)).catch(() => null) : Promise.resolve(null);
    void (async () => {
      try {
        // A failed list (offline, 5xx) must not forget drafts: pruning happens only against a list the server answered.
        const [profile, listed, resumed] = await Promise.all([client.me(),
          client.listOpenConversations().then(items => ({ ok: true, items })).catch(() => ({ ok: false, items: [] as ConversationSummary[] })), resuming]);
        if (!current) return;
        setMe(profile);
        const open = listed.items;
        if (listed.ok) for (const draft of drafts) if (!open.some(item => item.id === draft.conversationId)) forgetDraft(account.id, draft.conversationId, draftStorage);
        const stillOpen = resumed && (!listed.ok || open.some(item => item.id === resumed.conversation?.id));
        if (resumed && !stillOpen && remembered) forgetDraft(account.id, remembered.conversationId, draftStorage);
        if (stillOpen && !started.current) setChat(resumed);
      } catch (cause) {
        if (current && !started.current) setView({ kind: 'unavailable', message: cause instanceof RequestsError && cause.code === 'unauthorized' ? 'Sign in again to use AI Chat.' : errorText(cause) });
      }
    })();
    return () => { current = false; };
  }, [client, account.id, draftStorage, retryTick]);
  useEffect(() => { transcriptEnd.current?.scrollIntoView?.({ block: 'end' }); }, [chat.transcript.length, chat.streaming, view.kind]);
  // Focus lands in the composer as soon as the chat is shown (the panel mounts on its loading state).
  useEffect(() => { if (open && view.kind === 'chat') composer.current?.focus(); }, [view.kind, open]);

  // Optimistic until the profile arrives; the backend enforces roles on every call.
  const filingAllowed = !me || (me.effective !== 'none' && !me.filingDisabled);
  const messageLimit = me?.limits.messagesPerConversation ?? 30;
  const run = async (action: () => Promise<void>): Promise<void> => {
    const gen = generation.current;
    const live = (): boolean => alive.current && generation.current === gen;
    setBusy(true); setError(null);
    try { await action(); } catch (cause) { if (live()) setError({ code: cause instanceof RequestsError ? cause.code : 'unknown', message: errorText(cause) }); }
    finally { if (live()) setBusy(false); }
  };
  const remember = (conversationId: string, path: ConversationPath, title: string | null): void => rememberDraft(account.id, { conversationId, path, title, scope: scopeRef.current }, draftStorage);
  // A document that gets its cloud identity keeps its conversation, now remembered under the lasting scope.
  const conversationId = chat.conversation?.id ?? null;
  useEffect(() => {
    if (conversationId && chat.conversation) rememberDraft(account.id, { conversationId, path: chat.path, title: chat.conversation.title, scope }, draftStorage);
    // Only a scope change re-files; every turn already remembers the conversation itself.
  }, [scope]);

  /**
   * Clear Chat and `/clear`: stop any turn, discard this document's conversation on the server, forget it
   * in this browser and show the greeting. Edits a stopped turn already applied stay in the document, undoable.
   */
  const clear = (): void => {
    generation.current += 1;
    turn.current?.abort(); turn.current = null;
    started.current = true;
    const ids = new Set<string>(chat.conversation ? [chat.conversation.id] : []);
    for (const draft of readDrafts(account.id, draftStorage)) if (draftScope(draft) === scopeRef.current) ids.add(draft.conversationId);
    for (const id of ids) { forgetDraft(account.id, id, draftStorage); void client.discardConversation(id).catch(() => {}); }
    setWaitingForGuidance(false);
    setChat(EMPTY); setText(''); setError(null); setNotice(null); setBusy(false);
  };
  const clearsSeen = useRef(0);
  useEffect(() => {
    if (clearSignal <= clearsSeen.current) return;
    clearsSeen.current = clearSignal;
    clear();
    // Only a new signal clears; `clear` reads the current chat when it runs.
  }, [clearSignal]);
  /** Runs a typed chat command; an unknown one leaves the text for correction and lists the commands. */
  const runSlash = (message: string): void => {
    const name = slashName(message);
    if (name === 'clear') { clear(); return; }
    setNotice(`Unknown command /${name}. Commands: ${SLASH_COMMANDS.map(command => `/${command.name}`).join(', ')}.`);
  };

  /** Sends a typed message or an intent card; the first one also creates the conversation with `path: 'open'`. */
  const send = (message: string, intent?: IntentPath): void => {
    const body = message.trim();
    if (!intent && body.startsWith('/')) { runSlash(body); return; }
    if ((busy && !waitingForGuidance) || !attachmentsReady) return;
    if (!body) return;
    if (waitingForGuidance) { generation.current += 1; turn.current?.abort(); setWaitingForGuidance(false); }
    onMessage?.();
    const at = new Date().toISOString();
    started.current = true;
    setText(''); setNotice(null); setError(null);
    setChat(current => ({ ...current, transcript: [...current.transcript, { role: 'user', text: body, at }], streaming: '' }));
    const controller = new AbortController(); turn.current = controller;
    const gen = generation.current;
    const live = (): boolean => alive.current && generation.current === gen;
    void run(async () => {
      let streamed = '', rateLimited = false, failed = false, resumed = false, conversation = chat.conversation;
      // A conversation the server ended (filed, added, closed) is left behind: this message starts a new one.
      let ended = false, startOver = false, path = conversation ? chat.path : 'open', title = conversation?.title ?? null;
      try {
        if (!conversation) {
          try {
            conversation = await client.startConversation({ kind: 'intake', path: 'open', screen });
            if (!live()) return;
            const started = conversation;
            setChat(current => ({ ...current, conversation: started, path: started.path, messageCount: 0, limitReached: false }));
            remember(started.id, started.path, started.title);
          } catch (cause) { failed = true; throw cause; }
        }
        const id = conversation.id;
        // Flush retained local images before the agent can file the confirmed ticket.
        for (const file of localImages) {
          const attached = await client.attach(id, file);
          if (!live()) return;
          uploadedPreviews.current.set(attached.id, file.blob);
          setAttachments(current => [...current, attached]);
          setLocalImages(current => current.filter(item => item !== file));
        }
        // The document is bound now; switching tabs later never retargets this turn's tool calls.
        const tools = documentTools?.() ?? null;
        let stream = client.sendMessage(id, body, { ...(intent ? { intent } : {}), document: tools?.document ?? null, signal: controller.signal });
        for (;;) {
          let requested: readonly ToolCall[] = [];
          for await (const event of stream) {
            if (!live()) return;
            switch (event.type) {
              case 'tool_request': requested = event.calls; break;
              case 'text': streamed += event.delta; setChat(current => ({ ...current, streaming: streamed })); break;
              // Only the path (and title, for the draft) matter here: the brief itself is what the agent writes into the chat.
              case 'brief': path = event.path ?? path; title = event.title ?? title; setChat(current => ({ ...current, path })); remember(id, path, title); break;
              case 'filed': case 'added': {
                const { request } = event;
                const line = event.type === 'filed' ? `Filed as ${request.issueKey}` : `Added you to ${request.issueKey}`;
                setChat(current => ({ ...current, transcript: [...current.transcript, { role: 'system', text: line, at: new Date().toISOString() }] }));
                forgetDraft(account.id, id, draftStorage);
                break;
              }
              case 'error':
                failed = true;
                if (event.code === 'rate_limited') rateLimited = true;
                else if (event.code === 'limit') setChat(current => ({ ...current, limitReached: true }));
                else if (event.code === 'tracker_unavailable') setError({ code: event.code, message: event.message, retry: intent ? undefined : () => send(body) });
                else setError({ code: event.code, message: event.message });
                break;
              case 'done':
                ended = event.ended; startOver = ended && event.reason === 'start_over';
                setChat(current => ({ ...current, messageCount: event.messageCount, limitReached: !ended && (event.limitReached || event.messageCount >= messageLimit) }));
                break;
            }
          }
          if (!requested.length || !tools || ended) break;
          // Run the calls against the bound document, then send the results; the turn continues in the next stream.
          const partial = streamed; streamed = '';
          const cueInstruction = requested.find(call => call.name === 'ui_highlight')?.input as { instruction?: unknown } | undefined;
          const instructionText = partial.trim() ? partial : typeof cueInstruction?.instruction === 'string' ? cueInstruction.instruction.slice(0, 400) : '';
          if (instructionText.trim()) setChat(current => ({ ...current, streaming: '', transcript: [...current.transcript, { role: 'assistant', text: instructionText, at: new Date().toISOString() }] }));
          const results: ToolCallResult[] = [], notices: string[] = [];
          for (const call of requested) {
            let outcome: DocumentToolOutcome;
            if (!live()) return;
            if (call.name === 'ui_highlight') setWaitingForGuidance(true);
            try { outcome = await tools.run(call, controller.signal); } catch (cause) { outcome = { content: `The editor could not run ${call.name}: ${errorText(cause)}`, isError: true }; }
            if (!live()) return;
            setWaitingForGuidance(false);
            results.push({ toolUseId: call.id, content: outcome.content, isError: outcome.isError });
            if (outcome.notice) notices.push(outcome.notice);
          }
          if (!live()) return;
          const shown = new Date().toISOString();
          setChat(current => ({ ...current, streaming: '', transcript: [...current.transcript,
            ...notices.map(text => ({ role: 'system' as const, text, at: shown }))] }));
          resumed = true;
          stream = client.sendToolResults(id, results, { signal: controller.signal });
        }
        // A card sets the path even when the server sends no brief event for the first turn.
        if (intent && path === 'open') { path = intent; setChat(current => current.path === 'open' ? { ...current, path: intent } : current); remember(id, intent, title); }
        if (ended) forgetDraft(account.id, id, draftStorage);
      } catch (cause) {
        if (!live()) return;
        failed = true;
        if (cause instanceof RequestsError && cause.code === 'rate_limited') rateLimited = true;
        else if (cause instanceof RequestsError && cause.code === 'limit') setChat(current => ({ ...current, limitReached: true }));
        else throw cause;
      } finally {
        if (turn.current === controller) turn.current = null;
        // A turn the server rejected before answering never received the message: the optimistic copy leaves the transcript.
        // Start over (the requester asked the agent to discard): the transcript goes too, so the greeting and cards return.
        if (live()) setChat(current => startOver ? EMPTY : ({ ...current, streaming: null,
          ...(ended ? { conversation: null, path: 'open' as const, messageCount: 0, limitReached: false } : {}),
          transcript: streamed.trim() ? [...current.transcript, { role: 'assistant', text: streamed, at: new Date().toISOString() }]
            : failed && !resumed ? current.transcript.filter(item => !(item.role === 'user' && item.at === at && item.text === body)) : current.transcript }));
      }
      if (rateLimited && live()) { setNotice('You are sending messages quickly. Please wait a minute and send again.'); if (!intent) setText(body); }
    });
  };
  const submit = (event: FormEvent): void => { event.preventDefault(); send(text); };

  // Local images remain removable before they are uploaded with the next message.
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const uploadedPreviews = useRef(new Map<string, Blob>());
  const [localImages, setLocalImages] = useState<readonly AttachmentFile[]>([]);
  const [attachmentsReady, setAttachmentsReady] = useState(true);
  const [attachmentRetry, setAttachmentRetry] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const capture = useRef(captureScreenshot); capture.current = captureScreenshot;
  const autoRemoved = useRef(new Set<string>());
  const reporting = conversationId !== null && (chat.path === 'problem' || chat.path === 'feature');
  const removalKey = (id: string) => `pf-screenshot-removed:${account.id}:${id}`;
  const wasRemoved = (id: string): boolean => {
    try { return autoRemoved.current.has(id) || (draftStorage === undefined ? window.localStorage : draftStorage)?.getItem(removalKey(id)) === 'yes'; }
    catch { return autoRemoved.current.has(id); }
  };
  const markRemoved = (id: string): void => {
    autoRemoved.current.add(id);
    try { (draftStorage === undefined ? window.localStorage : draftStorage)?.setItem(removalKey(id), 'yes'); } catch { /* session memory still prevents recapture */ }
  };
  useEffect(() => {
    setAttachments([]); setLocalImages([]); uploadedPreviews.current.clear();
    if (!conversationId || !reporting) { setAttachmentsReady(true); return; }
    let current = true;
    setAttachmentsReady(false);
    void (async () => {
      try {
        const items = await client.listAttachments(conversationId);
        if (!current) return;
        setAttachments(items);
        if (capture.current && !wasRemoved(conversationId) && items.length < ATTACHMENTS_PER_REPORT && !items.some(item => item.name === 'Current view.png')) {
          try {
            const blob = await capture.current();
            if (!current) return;
            if (!blob || !blob.size || blob.size > ATTACHMENT_MAX_BYTES) throw new Error('Capture unavailable');
            setLocalImages([{ kind: 'screenshot', name: 'Current view.png', mime: 'image/png', blob }]);
          } catch { if (current) setNotice('The current view could not be captured. You can upload an image instead.'); }
        }
      } catch (cause) {
        if (current) setError({ code: 'attachments', message: `Images could not be loaded: ${errorText(cause)}`, retry: () => setAttachmentRetry(n => n + 1) });
        return;
      }
      if (current) setAttachmentsReady(true);
    })();
    return () => { current = false; };
  }, [client, conversationId, reporting, attachmentRetry]);
  const full = attachments.length + localImages.length >= ATTACHMENTS_PER_REPORT;
  const pickImages = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []); event.target.value = '';
    const chosen: AttachmentFile[] = [];
    let warning: string | null = null;
    for (const file of files) {
      if (!SCREENSHOT_TYPES.includes(file.type)) { warning = 'Images must be PNG, JPEG or WebP.'; continue; }
      if (!file.size || file.size > ATTACHMENT_MAX_BYTES) { warning = `Images must be between 1 byte and ${formatBytes(ATTACHMENT_MAX_BYTES)}.`; continue; }
      if (attachments.length + localImages.length + chosen.length >= ATTACHMENTS_PER_REPORT) { warning = `A ticket takes at most ${ATTACHMENTS_PER_REPORT} images.`; break; }
      chosen.push({ kind: 'screenshot', name: file.name, mime: file.type, blob: file });
    }
    setLocalImages(current => [...current, ...chosen]); setNotice(warning);
  };
  const removeImage = (item: Attachment | AttachmentFile): void => {
    if (!conversationId) return;
    if (item.name === 'Current view.png') markRemoved(conversationId);
    if ('blob' in item) { setLocalImages(current => current.filter(file => file !== item)); return; }
    const gen = generation.current;
    void run(async () => {
      await client.removeAttachment(conversationId, item.id);
      if (alive.current && generation.current === gen) {
        uploadedPreviews.current.delete(item.id);
        setAttachments(current => current.filter(file => file.id !== item.id));
      }
    });
  };

  // Typing "/" lists the commands that match what follows it.
  const slashMatches = text.startsWith('/') && !/\s/.test(text) ? SLASH_COMMANDS.filter(command => command.name.startsWith(text.slice(1).toLowerCase())) : [];
  let body: JSX.Element;
  if (view.kind === 'unavailable') {
    body = <div className="pf-fr-screen"><p className="pf-fr-error" role="alert">{view.message}</p><button type="button" onClick={() => setRetryTick(value => value + 1)}>Retry</button></div>;
  } else {
    const current = chat;
    const greeted = current.transcript.length === 0 || current.transcript[0]?.role === 'user';
    const showCards = current.transcript.length === 0 && current.streaming === null;
    body = <div className="pf-fr-chat">
      <div className="pf-fr-transcript" role="log" aria-label="Conversation" aria-live="polite">
        {greeted ? <div className="pf-fr-message is-assistant"><span className="pf-fr-role">Agent</span><MessageMarkdown text={GREETING} /></div> : null}
        {showCards ? <div className="pf-fr-cards" role="group" aria-label="What would you like to do?">
          {INTENT_CARDS.map(card => {
            const enabled = card.intent === 'help' || filingAllowed;
            return <div key={card.intent} className="pf-fr-choice-wrap">
              <button type="button" className="pf-fr-choice" disabled={busy || !enabled} aria-describedby={enabled ? undefined : `pf-fr-${card.intent}-note`} onClick={() => send(card.label, card.intent)}>
                <strong>{card.label}</strong><span>{card.detail}</span>
              </button>
              {!enabled ? <p id={`pf-fr-${card.intent}-note`} className="pf-fr-choice-note">{FILING_UNAVAILABLE}</p> : null}
            </div>;
          })}
        </div> : null}
        {current.transcript.map((entry, index) => entry.role === 'system'
          ? <p key={index} className="pf-fr-message is-system pf-fr-muted" role="status">{entry.text}</p>
          // A reply split by tool calls reads as one message, under one label.
          : <div key={index} className={`pf-fr-message is-${entry.role}`}>{entry.role === 'assistant' && current.transcript[index - 1]?.role === 'assistant' ? null
            : <span className="pf-fr-role">{entry.role === 'user' ? 'You' : 'Agent'}</span>}
            {/* The requester's own words stay as typed; the agent's replies are Markdown. */}
            {entry.role === 'user' ? <p>{entry.text}</p> : <MessageMarkdown text={entry.text} />}</div>)}
        {current.streaming !== null && !waitingForGuidance ? <div className="pf-fr-message is-assistant is-streaming">{current.transcript.at(-1)?.role === 'assistant' ? null : <span className="pf-fr-role">Agent</span>}{current.streaming ? <MessageMarkdown text={current.streaming} /> : <p>…</p>}</div> : null}
        <div ref={transcriptEnd} />
      </div>
      {current.limitReached ? <p className="pf-fr-muted pf-fr-limit" role="status">This conversation reached its {messageLimit}-message limit.</p> : null}
      {notice ? <p className="pf-fr-notice" role="status">{notice}</p> : null}
      {slashMatches.length ? <div className="pf-fr-slash" role="group" aria-label="Chat commands">
        {slashMatches.map(command => <button key={command.name} type="button" onClick={() => runSlash(`/${command.name}`)}>
          <strong>/{command.name}</strong><span>{command.description}</span>
        </button>)}
      </div> : null}
      {error ? <p className="pf-fr-error" role="alert">{error.message}{error.retry ? <> <button type="button" disabled={busy} onClick={error.retry}>Retry</button></> : null}</p> : null}
      {reporting ? <div className="pf-fr-attachments" role="group" aria-label="Attachments">
        {!attachmentsReady ? <p role="status">Preparing images...</p> : null}
        <ul aria-label="Attached images">{[...attachments, ...localImages].map((item, index) => <li key={'id' in item ? item.id : `local-${index}`}>
          <AttachmentPreview item={item} client={client} blob={'id' in item ? uploadedPreviews.current.get(item.id) : item.blob} />
          <span>{item.name} ({formatBytes('blob' in item ? item.blob.size : item.size)})</span>
          <button type="button" aria-label={`Remove ${item.name}`} disabled={busy} onClick={() => removeImage(item)}>Remove</button>
        </li>)}</ul>
        <button type="button" disabled={busy || full || !attachmentsReady} onClick={() => picker.current?.click()}>Upload images</button>
        <input ref={picker} type="file" multiple accept={SCREENSHOT_TYPES.join(',')} hidden aria-label="Image files" onChange={pickImages} />
      </div> : null}
      <form className="pf-fr-composer" aria-label="Message" onSubmit={submit}>
        <textarea ref={composer} data-autofocus data-submit-on-enter aria-label="Your message" rows={1} value={text} maxLength={4000}
          disabled={busy && !waitingForGuidance && current.streaming !== null}
          placeholder={current.conversation ? 'Type your answer, or say skip' : 'Describe what you need'} onChange={event => setText(event.target.value)} />
        <button type="submit" className="pf-fr-primary pf-fr-send" disabled={(busy && !waitingForGuidance) || !attachmentsReady || !text.trim()}>Send</button>
      </form>
    </div>;
  }
  const Shell = placement === 'docked' ? DockedPanel : Popover;
  return <Shell label="AI Chat" className={`pf-fr-panel is-${view.kind}`} anchor={anchor} onClose={onClose} open={open}>
    {body}
  </Shell>;
}

/** CORS downloads become local previews, independent of signed-link expiry and COEP image blocking. */
function AttachmentPreview({ item, client, blob }: { item: Attachment | AttachmentFile; client: RequestsClient; blob: Blob | undefined }): JSX.Element | null {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true, local: string | null = null;
    setSrc(null); setFailed(false);
    const show = (blob: Blob): void => {
      if (!current || typeof URL.createObjectURL !== 'function') return;
      local = URL.createObjectURL(blob); setSrc(local);
    };
    if (blob) show(blob);
    else if ('id' in item) void client.attachmentBlob(item.id).then(show).catch(() => { if (current) setFailed(true); });
    return () => { current = false; if (local) URL.revokeObjectURL(local); };
  }, [item, client, blob, attempt]);
  if (failed) return <button type="button" onClick={() => setAttempt(n => n + 1)}>Retry preview for {item.name}</button>;
  return src ? <img src={src} alt={item.name} onError={() => setFailed(true)} /> : null;
}
