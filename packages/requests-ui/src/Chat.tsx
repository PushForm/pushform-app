// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type FormEvent, type JSX } from 'react';
import { CLONE_NAME_MAX_CHARS, CLONE_TOOL, HANDOFF_SUMMARY_MAX_CHARS, PUBLISH_TOOL, type CloneChoice, type PublishOutcome, type PublishProposal } from '@pushform/requests-core';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_REPORT, formatBytes, RequestsError, SCREENSHOT_TYPES, type Attachment, type AttachmentFile, type Conversation, type ConversationPath, type Credits, type ConversationSummary, type DocumentDescriptor, type Handoff, type IntentPath, type Me, type Message, type RequestsClient, type ScreenInfo, type ToolCall, type ToolCallResult, type ToolImage } from './client';
import { draftScope, forgetDraft, HOME_SCOPE, readDrafts, rememberDraft } from './drafts';
import { DockedPanel } from './DockedPanel';
import { Popover } from './Popover';
import { MessageMarkdown } from './MessageMarkdown';
import { useDictation } from './useDictation';
import { imageFiles, preparePicture, PICTURES_PER_MESSAGE } from './pictures';

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
  /**
   * The saved cloud document this panel's conversation is held in, once the document has one. The conversation is linked to it, so deleting
   * the document deletes the chat; an unsaved document has none.
   */
  readonly documentId?: string | undefined;
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
  /**
   * A clone's chat: on mount it shows where the clone came from and the agent's summary, then sends the request that made the
   * clone as its first message, without the greeting. Read once; `onHandoffStarted` tells the host it was used.
   */
  readonly handoff?: (Handoff & { readonly request: string }) | undefined;
  readonly onHandoffStarted?: (() => void) | undefined;
}

/** What the host made for a confirmed clone: its name and a way to bring its tab forward. */
export interface ClonedDocument { readonly name: string; show(): void }
/** A clone the agent proposed: the requester's chosen name, the agent's handoff summary and the request that asked for it. */
export interface CloneRequest { readonly name: string; readonly summary: string; readonly request: string }
/**
 * A Commons publication the agent proposed, after the host saved the version it publishes: what the card shows.
 * `host` is the host's own state for publishing it.
 */
export interface PreparedPublication {
  readonly revision: number; readonly savedLine: string; readonly update: boolean;
  readonly title: string; readonly description: string; readonly category: string;
  readonly license: { readonly name: string; readonly summary: string; readonly url: string | null } | null;
  readonly retained: readonly string[] | null;
  readonly collections: readonly { readonly name: string; readonly isNew: boolean }[];
  readonly picture?: string | undefined;
  readonly host: unknown;
}
/** A publication made from the card: its title, public page and any collection that could not be updated. */
export interface PublishedModel { readonly title: string; readonly url: string; readonly failedCollections: readonly string[] }

/** The active document as a file, for a problem report's attachment. */
export interface DocumentCopy { readonly name: string; readonly blob: Blob }

/** One tab's open document as the chat can use it. */
export interface DocumentToolSession {
  readonly document: DocumentDescriptor;
  /** Runs one call; failures are error results, never exceptions. `notice` is a transcript line for a change to the document. */
  run(call: ToolCall, signal?: AbortSignal): Promise<DocumentToolOutcome> | DocumentToolOutcome;
  /** What the chat shows while a call runs, for a call that takes noticeable time; undefined keeps the usual placeholder. */
  progress?(call: ToolCall): string | undefined;
  /** The open document's name, as a clone card names it. */
  readonly name?: string | undefined;
  /**
   * Clones the document into a new, active tab once the requester confirms on the chat's card; rejects with a readable
   * error when it cannot. A session that offers it says `clone: 1` in its descriptor.
   */
  clone?(request: CloneRequest): Promise<ClonedDocument>;
  /** Saves the version a proposed publication publishes and prepares its card; rejects with a readable reason. A session that offers it says `publish: 1`. */
  preparePublication?(proposal: PublishProposal): Promise<PreparedPublication>;
  /**
   * Opens the publishing dialog with the card's values. `auto` (Publish on the card) publishes as soon as it can.
   * Resolves with the publication, or null when the dialog closed without publishing.
   */
  publish?(prepared: PreparedPublication, auto: boolean): Promise<PublishedModel | null>;
}
/** `images` are a render's pictures for the agent, and `views` name them for the review line. */
/** `line` is a transcript line of its own, such as a save's "Saved version 4.", never merged into the change line. */
export interface DocumentToolOutcome {
  readonly content: string; readonly isError: boolean; readonly notice?: string | undefined; readonly line?: string | undefined;
  readonly images?: readonly ToolImage[] | undefined; readonly views?: readonly string[] | undefined;
}

type View =
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'chat' };

/** A transcript line: a persisted message, or a local system line such as "Filed as CUS-12". */
/** `local`: the pictures of a message sent from this panel, shown from their files until the conversation reloads. */
/**
 * `review`: a render review's line, with the pictures the agent saw while they are still in this panel (none after a
 * reload: the backend does not keep them). Review lines are transcript-only, never change lines.
 */
type Entry = (Message & { readonly local?: readonly AttachmentFile[] | undefined }) | { readonly role: 'system'; readonly text: string; readonly at: string }
  | { readonly role: 'review'; readonly views: readonly string[]; readonly images: readonly ToolImage[]; readonly at: string }
  | CloneCard | PublishCard;
/** `publish`: the card that proposes a Commons publication; only its Publish button (or the dialog's) publishes. */
interface PublishCard {
  readonly role: 'publish'; readonly id: string; readonly prepared: PreparedPublication;
  readonly state: 'pending' | 'open' | 'published' | 'not' | 'failed'; readonly result?: PublishedModel | undefined; readonly reason?: string | undefined; readonly at: string;
}
/**
 * `clone`: the card that asks before a clone. Pending, it offers Clone document, copying within this document and Cancel;
 * afterwards it reads what happened.
 */
interface CloneCard {
  readonly role: 'clone'; readonly id: string; readonly from: string; readonly name: string; readonly documentType: 'layout' | 'model';
  readonly state: 'pending' | 'cloning' | 'cloned' | 'copy' | 'not' | 'failed'; readonly reason?: string | undefined; readonly show?: (() => void) | undefined; readonly at: string;
}

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
  /** The server's sentence for why the conversation cannot continue; shown as the muted notice. */
  readonly limitMessage: string | null;
}

interface QueuedMessage { readonly id: number; readonly text: string; readonly pictures: readonly AttachmentFile[]; readonly tools: DocumentToolSession | null }

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
const visible = (messages: readonly Message[]): Entry[] => messages.flatMap((message): Entry[] => {
  if (message.role === 'tool' && message.published !== undefined) return [{ role: 'system', text: message.published ? `Published ${message.published.title}.` : 'Not published.', at: message.at }];
  if (message.role === 'tool' && message.cloned) return [{ role: 'system', text: message.cloned.name !== null ? `Cloned to ${message.cloned.name}.` : 'Not cloned.', at: message.at }];
  if (message.role === 'tool') return message.reviewed?.length ? [{ role: 'review', views: message.reviewed, images: [], at: message.at }] : [];
  if (message.role === 'user' && message.handoff) return handoffEntries(message.handoff, message.at, message);
  return message.role !== 'assistant' || !!message.text.trim() ? [message] : [];
});
/** A clone's chat opens with where it came from and the agent's summary, before the request that made it. */
function handoffEntries(handoff: Handoff, at: string, request: Entry): Entry[] {
  return [{ role: 'system', text: `Continued from ${handoff.from}`, at }, { role: 'assistant', text: handoff.summary, at }, request];
}
const cloneResult = (choice: CloneChoice, extra: { name?: string; error?: string } = {}): string => JSON.stringify({ ok: !extra.error, choice, ...extra });
const publishResult = (outcome: PublishOutcome, extra: { title?: string; url?: string; error?: string } = {}): string => JSON.stringify({ ok: !extra.error, outcome, ...extra });
/** The placeholder adds the turn's running time once the turn has run this long. */
export const ELAPSED_AFTER_SECONDS = 10;
/** Screen readers hear that the agent is still working at this interval, never every second. */
const ANNOUNCE_EVERY_SECONDS = 30;
const reviewProgress = (call: ToolCall): string | undefined => (call.review ? `Checking the result (review ${call.review.index} of ${call.review.limit})…` : undefined);
const errorText = (cause: unknown): string => cause instanceof Error ? cause.message : 'Something went wrong.';
/** Shown only when a server that predates the message field reports a limit without saying why. */
const LIMIT_FALLBACK = 'This conversation cannot take more messages right now.';
const EMPTY: ChatState = { conversation: null, transcript: [], streaming: null, path: 'open', messageCount: 0, limitReached: false, limitMessage: null };
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
export function Chat({ client, account, screen, anchor, placement = 'popover', onClose, open = true, storage, documentTools, captureScreenshot, onMessage, scope = HOME_SCOPE, documentId, clearSignal = 0, handoff, onHandoffStarted }: ChatProps): JSX.Element {
  // The greeting, cards and composer draw at once; the profile and any resumable conversation load behind them.
  const [view, setView] = useState<View>({ kind: 'chat' });
  const [me, setMe] = useState<Me | null>(null);
  /** The account's AI allowance: from the profile, then refreshed by each turn. */
  const [credits, setCredits] = useState<Credits | null>(null);
  const [chat, setChat] = useState<ChatState>(EMPTY);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<readonly QueuedMessage[]>([]);
  const queuedRef = useRef<readonly QueuedMessage[]>([]), nextQueuedId = useRef(0);
  const [queuePaused, setQueuePaused] = useState(false);
  const replaceQueue = (items: readonly QueuedMessage[]): void => { queuedRef.current = items; setQueued(items); };
  const [waitingForGuidance, setWaitingForGuidance] = useState(false);
  const [toolProgress, setToolProgress] = useState<string | null>(null);
  /** The backend's latest status line for the running turn; cleared when the agent's own words or a tool step take over. */
  const [statusLine, setStatusLine] = useState<string | null>(null);
  /** When the running turn started, for the elapsed time in its placeholder; null while no turn runs. */
  const [turnStarted, setTurnStarted] = useState<number | null>(null);
  const [error, setError] = useState<{ code: string; message: string; retry?: (() => void) | undefined } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const alive = useRef(true), composer = useRef<HTMLTextAreaElement>(null), transcriptEnd = useRef<HTMLDivElement>(null);
  /** The in-flight turn, aborted on unmount so a closed panel does not keep a stream open. */
  const turn = useRef<AbortController | null>(null);
  const draftStorage = storage === undefined ? undefined : storage;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const documentIdRef = useRef(documentId);
  documentIdRef.current = documentId;
  /** Bumped by Clear Chat: work started before it never touches the cleared chat. */
  const generation = useRef(0);
  useEffect(() => {
    replaceQueue([]); setQueuePaused(false); setChat(EMPTY); setText(''); setBusy(false);
    setTurnStarted(null); setWaitingForGuidance(false); setToolProgress(null); setStatusLine(null); setError(null);
    setPictures([]); setLocalImages([]); setAttachments([]); uploadedPreviews.current.clear();
    return () => { generation.current += 1; turn.current?.abort(); turn.current = null; };
  }, [client, account.id]);
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
        if (profile.credits) setCredits(profile.credits);
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
  // Link the conversation to its saved document: a chat started before the document was saved, or before chats were linked, gets its link as
  // soon as both are known. A failed link is tried again the next time this runs.
  const linked = useRef(new Set<string>());
  useEffect(() => {
    if (!documentId || !conversationId) return;
    const key = `${conversationId}:${documentId}`;
    if (linked.current.has(key)) return;
    linked.current.add(key);
    void client.linkConversationDocument(conversationId, documentId).catch(() => { linked.current.delete(key); });
  }, [client, conversationId, documentId]);

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
    setWaitingForGuidance(false); setToolProgress(null); setStatusLine(null); setTurnStarted(null);
    setChat(EMPTY); setText(''); setError(null); setNotice(null); setBusy(false);
    replaceQueue([]); setQueuePaused(false);
  };
  /** Stop: cancels the running turn and any batch in progress; what was already applied stays, undoable. */
  const stop = (): void => { setQueuePaused(true); turn.current?.abort(); };
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
  const send = (message: string, intent?: IntentPath, pending?: QueuedMessage, opening?: Handoff): void => {
    const body = message.trim();
    if (!intent && body.startsWith('/')) { runSlash(body); return; }
    if (!attachmentsReady) return;
    // Pictures in the composer go with a typed message, never with an intent card.
    const outgoing = intent ? [] : pending?.pictures ?? pictures;
    if (!body && !outgoing.length) return;
    if (!pending && !intent && ((turn.current && !waitingForGuidance) || queuedRef.current.length)) {
      replaceQueue([...queuedRef.current, { id: nextQueuedId.current++, text: body, pictures: outgoing, tools: documentTools?.() ?? null }]);
      setText(''); setPictures([]); setNotice(null);
      if (!turn.current) setQueuePaused(false);
      return;
    }
    if (busy && !waitingForGuidance) return;
    if (waitingForGuidance) { generation.current += 1; turn.current?.abort(); setWaitingForGuidance(false); }
    // A handoff forwards the request that made the clone; the requester did not send it again.
    if (!opening) onMessage?.();
    const at = new Date().toISOString();
    started.current = true;
    if (!pending && !opening) { setText(''); if (outgoing.length) setPictures([]); }
    setNotice(null); setError(null); setQueuePaused(false);
    const sent: Entry = { role: 'user', text: body, at, ...(outgoing.length ? { local: outgoing } : {}) };
    setChat(current => ({ ...current, transcript: [...current.transcript, ...(opening ? handoffEntries(opening, at, sent) : [sent])], streaming: '' }));
    const controller = new AbortController(); turn.current = controller;
    const gen = generation.current;
    const live = (): boolean => alive.current && generation.current === gen;
    /** Stop ends the turn here: the calls of a stopped round are never answered. */
    const stopped = (): void => { if (controller.signal.aborted) throw new DOMException('Stopped', 'AbortError'); };
    setToolProgress(null); setStatusLine(null); setTurnStarted(Date.now());
    void run(async () => {
      let streamed = '', rateLimited = false, failed = false, resumed = false, completed = false, conversation = chat.conversation;
      // A conversation the server ended (filed, added, closed) is left behind: this message starts a new one.
      let ended = false, startOver = false, path = conversation ? chat.path : 'open', title = conversation?.title ?? null;
      const pictureIds: string[] = [];
      try {
        if (!conversation) {
          try {
            conversation = await client.startConversation({ kind: 'intake', path: 'open', screen, ...(documentIdRef.current ? { documentId: documentIdRef.current } : {}) });
            if (!live()) return;
            const started = conversation;
            setChat(current => ({ ...current, conversation: started, path: started.path, messageCount: 0, limitReached: false, limitMessage: null }));
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
        // The message's pictures are uploaded before the message is sent; on a filing path they are the ticket's images too.
        for (const file of outgoing) {
          let attached: Attachment;
          try { attached = await client.attach(id, file); } catch (cause) { failed = true; throw cause; }
          if (!live()) return;
          uploadedPreviews.current.set(attached.id, file.blob);
          pictureIds.push(attached.id);
          if (path === 'problem' || path === 'feature') setAttachments(current => [...current, attached]);
        }
        // The document is bound now; switching tabs later never retargets this turn's tool calls.
        const tools = pending ? pending.tools : documentTools?.() ?? null;
        // The turn's one change line, as the transcript holds it and in its newest wording: each applied change
        // updates it in place rather than adding a line.
        let shownChange = null as Entry | null, change = null as Entry | null;
        let stream = client.sendMessage(id, body, { ...(intent ? { intent } : {}), ...(opening ? { handoff: opening } : {}), document: tools?.document ?? null, signal: controller.signal, attachments: pictureIds });
        for (;;) {
          let requested: readonly ToolCall[] = [];
          for await (const event of stream) {
            if (!live()) return;
            switch (event.type) {
              case 'tool_request': requested = event.calls; break;
              case 'text': streamed += event.delta; setStatusLine(null); setChat(current => ({ ...current, streaming: streamed })); break;
              case 'status': setStatusLine(event.text); break;
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
                else if (event.code === 'limit') setChat(current => ({ ...current, limitReached: true, limitMessage: event.message }));
                else if (event.code === 'tracker_unavailable') setError({ code: event.code, message: event.message, retry: intent ? undefined : pending ? () => setQueuePaused(false) : () => send(body) });
                else setError({ code: event.code, message: event.message });
                break;
              case 'done':
                completed = !event.awaitingTools;
                ended = event.ended; startOver = ended && event.reason === 'start_over';
                setChat(current => ({ ...current, messageCount: event.messageCount, limitReached: !ended && event.limitReached, limitMessage: !ended && event.limitReached ? event.limitMessage : null }));
                if (event.credits) setCredits(event.credits);
                break;
            }
          }
          if (!requested.length || !tools || ended) break;
          // Run the calls against the bound document, then send the results; the turn continues in the next stream.
          const partial = streamed; streamed = '';
          const cueInstruction = requested.find(call => call.name === 'ui_highlight')?.input as { instruction?: unknown } | undefined;
          const instructionText = partial.trim() ? partial : typeof cueInstruction?.instruction === 'string' ? cueInstruction.instruction.slice(0, 400) : '';
          if (instructionText.trim()) setChat(current => ({ ...current, streaming: '', transcript: [...current.transcript, { role: 'assistant', text: instructionText, at: new Date().toISOString() }] }));
          const results: ToolCallResult[] = [], lines: Entry[] = [];
          for (const call of requested) {
            let outcome: DocumentToolOutcome;
            if (!live()) return;
            stopped();
            if (call.name === 'ui_highlight') setWaitingForGuidance(true);
            // The placeholder keeps the last step's text until a step with its own text, or the reply, replaces it.
            const progress = reviewProgress(call) ?? tools.progress?.(call);
            setStatusLine(null);
            if (progress) setToolProgress(progress);
            try {
              outcome = call.name === CLONE_TOOL && tools.clone ? await askClone(call, tools, body, controller.signal)
                : call.name === PUBLISH_TOOL && tools.preparePublication && tools.publish ? await askPublish(call, tools, controller.signal)
                : await tools.run(call, controller.signal);
            }
            catch (cause) { outcome = { content: `The editor could not run ${call.name}: ${errorText(cause)}`, isError: true }; }
            if (!live()) return;
            setWaitingForGuidance(false);
            stopped();
            results.push({ toolUseId: call.id, content: outcome.content, isError: outcome.isError, ...(outcome.images?.length ? { images: outcome.images } : {}) });
            const at = new Date().toISOString();
            if (outcome.notice) {
              const line: Entry = { role: 'system', text: outcome.notice, at: change?.at ?? at }, index = change ? lines.indexOf(change) : -1;
              if (index >= 0) lines[index] = line;
              else if (!change) lines.push(line);
              change = line;
            }
            if (outcome.line) lines.push({ role: 'system', text: outcome.line, at });
            if (outcome.images?.length) lines.push({ role: 'review', views: outcome.views ?? [], images: outcome.images, at });
          }
          if (!live()) return;
          const replaced = shownChange, updated = change;
          setChat(current => ({ ...current, streaming: '', transcript: [...(replaced && updated !== replaced ? current.transcript.map(item => item === replaced ? updated! : item) : current.transcript), ...lines] }));
          shownChange = change;
          resumed = true;
          stream = client.sendToolResults(id, results, { signal: controller.signal });
        }
        // A card sets the path even when the server sends no brief event for the first turn.
        if (intent && path === 'open') { path = intent; setChat(current => current.path === 'open' ? { ...current, path: intent } : current); remember(id, intent, title); }
        if (ended) forgetDraft(account.id, id, draftStorage);
      } catch (cause) {
        if (!live()) return;
        // Stopped by the requester: the reply so far stays, with no error.
        if (controller.signal.aborted) return;
        failed = true;
        if (cause instanceof RequestsError && cause.code === 'rate_limited') rateLimited = true;
        else if (cause instanceof RequestsError && cause.code === 'limit') setChat(current => ({ ...current, limitReached: true, limitMessage: cause.message }));
        else throw cause;
      } finally {
        if (turn.current === controller) turn.current = null;
        if (live()) { setToolProgress(null); setStatusLine(null); setTurnStarted(null); setWaitingForGuidance(false); }
        if (live() && (!completed || failed || rateLimited || ended || controller.signal.aborted)) setQueuePaused(true);
        if (live() && pending && failed && !resumed) replaceQueue([pending, ...queuedRef.current]);
        // A turn the server rejected before answering never received the message: the optimistic copy leaves the transcript.
        // Start over (the requester asked the agent to discard): the transcript goes too, so the greeting and cards return.
        // A message that never reached the agent keeps its pictures in the composer for retry; its uploads are released.
        if (failed && !resumed && outgoing.length && live()) {
          if (!pending) { setPictures(current => [...outgoing, ...current].slice(0, PICTURES_PER_MESSAGE)); if (!intent) setText(current => current || body); }
          const released = [...pictureIds], from = conversation?.id;
          if (from) for (const attachmentId of released) void client.removeAttachment(from, attachmentId).catch(() => {});
          setAttachments(current => current.filter(item => !released.includes(item.id)));
        }
        if (live()) setChat(current => startOver ? EMPTY : ({ ...current, streaming: null,
          ...(ended ? { conversation: null, path: 'open' as const, messageCount: 0, limitReached: false, limitMessage: null } : {}),
          transcript: streamed.trim() ? [...current.transcript, { role: 'assistant', text: streamed, at: new Date().toISOString() }]
            : failed && !resumed ? current.transcript.filter(item => !(item.role === 'user' && item.at === at && item.text === body)) : current.transcript }));
      }
      if (rateLimited && live()) { setNotice('You are sending messages quickly. Please wait a minute and send again.'); if (!intent && !pending) setText(body); }
    });
  };
  const submit = (event: FormEvent): void => { event.preventDefault(); send(text); };

  /** The requester's answer to each pending clone card, by tool call id, and the name typed on it. */
  const cloneAnswers = useRef(new Map<string, (choice: CloneChoice) => void>());
  const cloneNames = useRef(new Map<string, string>());
  const updateCard = (id: string, patch: Partial<CloneCard>): void => setChat(current => ({ ...current,
    transcript: current.transcript.map(item => item.role === 'clone' && item.id === id ? { ...item, ...patch } : item) }));
  /**
   * A proposed clone: the card asks first. A new message, Stop or Clear Chat aborts the turn and leaves the card unanswered,
   * read as not cloned. Clone document makes the copy through the host; its chat carries on from the handoff.
   */
  const askClone = async (call: ToolCall, tools: DocumentToolSession, request: string, signal: AbortSignal): Promise<DocumentToolOutcome> => {
    const input = (call.input ?? {}) as { name?: unknown; summary?: unknown };
    const proposed = (typeof input.name === 'string' ? input.name.trim() : '').slice(0, CLONE_NAME_MAX_CHARS) || `${tools.name ?? 'Document'} copy`;
    const summary = (typeof input.summary === 'string' ? input.summary.trim() : '').slice(0, HANDOFF_SUMMARY_MAX_CHARS);
    cloneNames.current.set(call.id, proposed);
    const card: CloneCard = { role: 'clone', id: call.id, from: tools.name ?? 'this document', name: proposed, documentType: tools.document.type, state: 'pending', at: new Date().toISOString() };
    setChat(current => ({ ...current, transcript: [...current.transcript, card] }));
    setWaitingForGuidance(true);
    const choice = await new Promise<CloneChoice | 'aborted'>(resolve => {
      if (signal.aborted) { resolve('aborted'); return; }
      signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      cloneAnswers.current.set(call.id, resolve);
    });
    cloneAnswers.current.delete(call.id);
    setWaitingForGuidance(false);
    if (choice === 'aborted' || choice === 'cancel') {
      updateCard(call.id, { state: 'not' });
      return { content: cloneResult('cancel'), isError: false };
    }
    if (choice === 'copy') { updateCard(call.id, { state: 'copy' }); return { content: cloneResult('copy'), isError: false }; }
    const name = (cloneNames.current.get(call.id) ?? proposed).trim().slice(0, CLONE_NAME_MAX_CHARS) || proposed;
    updateCard(call.id, { state: 'cloning', name });
    try {
      if (!tools.clone || !summary) throw new Error(summary ? 'This editor cannot clone documents.' : 'The proposal had no summary to hand over.');
      const made = await tools.clone({ name, summary, request });
      updateCard(call.id, { state: 'cloned', name: made.name, show: () => made.show() });
      return { content: cloneResult('clone', { name: made.name }), isError: false };
    } catch (cause) {
      const reason = errorText(cause);
      updateCard(call.id, { state: 'failed', reason });
      return { content: cloneResult('clone', { error: reason }), isError: true };
    }
  };
  /** The requester's answer to each pending publication card, by tool call id. */
  const publishAnswers = useRef(new Map<string, (choice: 'publish' | 'edit' | 'cancel') => void>());
  const updatePublishCard = (id: string, patch: Partial<PublishCard>): void => setChat(current => ({ ...current,
    transcript: current.transcript.map(item => item.role === 'publish' && item.id === id ? { ...item, ...patch } : item) }));
  /**
   * A proposed publication: the host saves the version it publishes, then the card waits. Publish opens the publishing
   * dialog and publishes as soon as it can; Edit details opens it to review first. A dialog closed without publishing
   * leaves the card available. A new message, Stop or Clear Chat leaves it not published.
   */
  const askPublish = async (call: ToolCall, tools: DocumentToolSession, signal: AbortSignal): Promise<DocumentToolOutcome> => {
    let prepared: PreparedPublication;
    try { prepared = await tools.preparePublication!((call.input ?? {}) as PublishProposal); }
    catch (cause) { return { content: publishResult('unavailable', { error: errorText(cause) }), isError: true }; }
    const card: PublishCard = { role: 'publish', id: call.id, prepared, state: 'pending', at: new Date().toISOString() };
    setChat(current => ({ ...current, transcript: [...current.transcript, { role: 'system', text: prepared.savedLine, at: card.at }, card] }));
    setWaitingForGuidance(true);
    try {
      for (;;) {
        const choice = await new Promise<'publish' | 'edit' | 'cancel' | 'aborted'>(resolve => {
          if (signal.aborted) { resolve('aborted'); return; }
          signal.addEventListener('abort', () => resolve('aborted'), { once: true });
          publishAnswers.current.set(call.id, resolve);
        });
        publishAnswers.current.delete(call.id);
        if (choice === 'aborted' || choice === 'cancel') { updatePublishCard(call.id, { state: 'not' }); return { content: publishResult('cancel'), isError: false }; }
        updatePublishCard(call.id, { state: 'open' });
        let made: PublishedModel | null;
        try { made = await tools.publish!(prepared, choice === 'publish'); }
        catch (cause) {
          const reason = errorText(cause);
          updatePublishCard(call.id, { state: 'failed', reason });
          return { content: publishResult('failed', { error: reason }), isError: true };
        }
        if (made) {
          updatePublishCard(call.id, { state: 'published', result: made });
          return { content: publishResult('published', { title: made.title, url: made.url }), isError: false };
        }
        if (signal.aborted) { updatePublishCard(call.id, { state: 'not' }); return { content: publishResult('cancel'), isError: false }; }
        updatePublishCard(call.id, { state: 'pending' });
      }
    } finally { setWaitingForGuidance(false); }
  };
  // A clone's chat sends the request that made it once the chat is ready, as its first message.
  const handedOff = useRef(false);
  useEffect(() => {
    if (!handoff || handedOff.current || view.kind !== 'chat') return;
    handedOff.current = true;
    onHandoffStarted?.();
    sendRef.current(handoff.request, undefined, undefined, { from: handoff.from, summary: handoff.summary });
  }, [handoff, view.kind]);

  // Local images remain removable before they are uploaded with the next message.
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const uploadedPreviews = useRef(new Map<string, Blob>());
  const [localImages, setLocalImages] = useState<readonly AttachmentFile[]>([]);
  const [attachmentsReady, setAttachmentsReady] = useState(true);
  const [attachmentRetry, setAttachmentRetry] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  // Pictures waiting in the composer for the next message, on every path.
  const [pictures, setPictures] = useState<readonly AttachmentFile[]>([]);
  const [dropping, setDropping] = useState(false);
  const picturePicker = useRef<HTMLInputElement>(null);
  const addPictures = (files: readonly File[]): void => {
    if (!files.length) return;
    void (async () => {
      const prepared = await Promise.all(files.map(file => preparePicture(file, file.name || 'Pasted picture.png')));
      if (!alive.current) return;
      const refused = prepared.flatMap(p => (p.ok ? [] : [p.reason]));
      const ready = prepared.flatMap(p => (p.ok ? [p.file] : []));
      setPictures(current => {
        const room = PICTURES_PER_MESSAGE - current.length;
        if (ready.length > room) refused.push(`A message takes at most ${PICTURES_PER_MESSAGE} pictures.`);
        return [...current, ...ready.slice(0, Math.max(0, room))];
      });
      setNotice(refused.length ? refused.join(' ') : null);
    })();
  };
  const pickPictures = (event: ChangeEvent<HTMLInputElement>): void => { const files = Array.from(event.target.files ?? []); event.target.value = ''; addPictures(files); };
  const pastePictures = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = imageFiles(event.clipboardData?.files);
    if (files.length) { event.preventDefault(); addPictures(files); }
  };
  const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  const dragOver = (event: DragEvent<HTMLDivElement>): void => { if (hasFiles(event)) { event.preventDefault(); setDropping(true); } };
  const drop = (event: DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(event)) return;
    event.preventDefault(); setDropping(false);
    addPictures(imageFiles(event.dataTransfer.files));
  };
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

  // Dictated phrases join the draft with a space, as if typed.
  const dictation = useDictation(phrase => setText(draft => draft && !/\s$/.test(draft) ? `${draft} ${phrase}` : draft + phrase));
  // A turn runs until its last stream ends; the requester can queue another message meanwhile.
  const working = turnStarted !== null;
  const textLocked = busy && !working;
  const sendRef = useRef(send); sendRef.current = send;
  useEffect(() => {
    if (!open || busy || queuePaused || turn.current || !attachmentsReady) return;
    const next = queuedRef.current[0]; if (!next) return;
    replaceQueue(queuedRef.current.slice(1)); sendRef.current(next.text, undefined, next);
  }, [open, busy, queued, queuePaused, attachmentsReady]);
  useEffect(() => { if (textLocked || !open) dictation.stop(); }, [textLocked, open]);
  // The composer grows with its text up to its CSS max-height, then scrolls.
  useLayoutEffect(() => {
    const box = composer.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight}px`;
  }, [text, view.kind]);

  // Typing "/" lists the commands that match what follows it.
  const slashMatches = text.startsWith('/') && !/\s/.test(text) ? SLASH_COMMANDS.filter(command => command.name.startsWith(text.slice(1).toLowerCase())) : [];
  let body: JSX.Element;
  if (view.kind === 'unavailable') {
    body = <div className="pf-fr-screen"><p className="pf-fr-error" role="alert">{view.message}</p><button type="button" onClick={() => setRetryTick(value => value + 1)}>Retry</button></div>;
  } else {
    const current = chat;
    const greeted = current.transcript.length === 0 || current.transcript[0]?.role === 'user';
    const showCards = current.transcript.length === 0 && current.streaming === null;
    body = <div className={`pf-fr-chat${dropping ? ' is-dropping' : ''}`} onDragOver={dragOver} onDragLeave={() => setDropping(false)} onDrop={drop}>
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
        {current.transcript.map((entry, index) => entry.role === 'review' ? <ReviewLine key={index} entry={entry} />
          : entry.role === 'publish' ? <PublishCardView key={entry.id} card={entry} answer={choice => publishAnswers.current.get(entry.id)?.(choice)} />
          : entry.role === 'clone' ? <CloneCardView key={entry.id} card={entry} names={cloneNames.current} answer={choice => cloneAnswers.current.get(entry.id)?.(choice)} />
          : entry.role === 'system'
          ? <p key={index} className="pf-fr-message is-system pf-fr-muted" role="status">{entry.text}</p>
          // A reply split by tool calls reads as one message, under one label.
          : <div key={index} className={`pf-fr-message is-${entry.role}`}>{entry.role === 'assistant' && current.transcript[index - 1]?.role === 'assistant' ? null
            : <span className="pf-fr-role">{entry.role === 'user' ? 'You' : 'Agent'}</span>}
            {/* The requester's own words stay as typed; the agent's replies are Markdown. */}
            {entry.role === 'user' ? <>{entry.text ? <p>{entry.text}</p> : null}<SentPictures entry={entry} client={client} previews={uploadedPreviews.current} /></> : <MessageMarkdown text={entry.text} />}</div>)}
        {current.streaming !== null && !waitingForGuidance ? <div className="pf-fr-message is-assistant is-streaming">{current.transcript.at(-1)?.role === 'assistant' ? null : <span className="pf-fr-role">Agent</span>}{current.streaming ? <>
          <MessageMarkdown text={current.streaming} />
          {/* A status line that arrives after the agent's words (it started writing a change, say) shows beneath them. */}
          {statusLine ? <div className="pf-fr-working is-after"><p role="status">{statusLine}</p></div> : null}
        </> : <div className="pf-fr-working">
          {statusLine ?? toolProgress ? <p role="status">{statusLine ?? toolProgress}</p> : <p className="pf-fr-thinking" role="status" aria-label="Agent is thinking"><span /><span /><span /></p>}
          {turnStarted !== null ? <Elapsed since={turnStarted} /> : null}
        </div>}</div> : null}
        <div ref={transcriptEnd} />
      </div>
      {current.limitReached ? <p className="pf-fr-muted pf-fr-limit" role="status">{current.limitMessage ?? LIMIT_FALLBACK}</p>
        : credits && credits.remaining > 0 && credits.remaining * 10 <= credits.allowance ? <p className="pf-fr-muted pf-fr-limit" role="status">{credits.plan === 'free' ? 'You are running low on your free AI credits.' : 'You are running low on this month\'s AI credits.'}</p> : null}
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
      {dictation.error ? <p className="pf-fr-notice" role="status">{dictation.error}</p> : null}
      {pictures.length ? <ul className="pf-fr-pictures" aria-label="Pictures to send">{pictures.map((file, index) => <li key={`${file.name}-${index}`}>
        <AttachmentPreview item={file} client={client} blob={file.blob} />
        <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setPictures(current => current.filter(item => item !== file))}>×</button>
      </li>)}</ul> : null}
      {queued.length > 0 && <section className="pf-fr-queued" aria-label="Queued messages">
        <p role="status">{queuePaused ? 'Queued messages paused' : `Queued messages (${queued.length})`}</p>
        <ol>{queued.map(item => <li key={item.id}><span>{item.text || 'Pictures'}{item.pictures.length > 0 ? ` (${item.pictures.length} ${item.pictures.length === 1 ? 'picture' : 'pictures'})` : ''}</span>
          <button type="button" aria-label={`Remove queued message: ${item.text || 'Pictures'}`} onClick={() => replaceQueue(queuedRef.current.filter(queued => queued.id !== item.id))}>Remove</button></li>)}</ol>
        {queuePaused && !working && <button type="button" disabled={busy || !attachmentsReady} onClick={() => setQueuePaused(false)}>Send next</button>}
      </section>}
      <form className="pf-fr-composer" aria-label="Message" onSubmit={submit}>
        <button type="button" className="pf-fr-icon" aria-label="Add picture" title="Add picture (or paste or drop an image)"
          disabled={textLocked || pictures.length >= PICTURES_PER_MESSAGE} onClick={() => picturePicker.current?.click()}>{PLUS_ICON}</button>
        <input ref={picturePicker} type="file" multiple accept={SCREENSHOT_TYPES.join(',')} hidden aria-label="Picture files" onChange={pickPictures} />
        <textarea ref={composer} data-autofocus data-submit-on-enter aria-label="Your message" rows={1} value={text} maxLength={4000}
          disabled={textLocked} onPaste={pastePictures}
          placeholder={working && !waitingForGuidance ? 'Queue a follow-up message' : !current.conversation ? 'Describe what you need' : reporting ? 'Type your answer, or say skip' : 'Ask a follow-up question'} onChange={event => setText(event.target.value)} />
        {working ? <button type="button" className="pf-fr-stop" aria-label="Stop" title="Stop" onClick={stop}><span aria-hidden="true" /></button> : null}
        {/* Enter sends and Shift+Enter starts a new line; the return key appears once there is something to send. */}
        {text.trim() || pictures.length ? <button type="submit" className="pf-fr-icon" aria-label={working && !waitingForGuidance ? 'Queue message' : 'Send'} title={working && !waitingForGuidance ? 'Queue message (Enter)' : 'Send (Enter)'} disabled={textLocked || !attachmentsReady}>{RETURN_ICON}</button> : null}
        <button type="button" className={`pf-fr-icon${dictation.listening ? ' is-listening' : ''}`} aria-label={dictation.listening ? 'Stop dictation' : 'Dictate'} aria-pressed={dictation.listening}
          title={dictation.supported ? (dictation.listening ? 'Stop dictation' : 'Dictate') : 'Dictation is not available here'}
          disabled={!dictation.supported || textLocked} onClick={dictation.toggle}>{MIC_ICON}</button>
      </form>
    </div>;
  }
  const Shell = placement === 'docked' ? DockedPanel : Popover;
  return <Shell label="AI Chat" className={`pf-fr-panel is-${view.kind}`} anchor={anchor} onClose={onClose} open={open}>
    {body}
  </Shell>;
}

/**
 * The running time of a turn, once it has run 10 seconds, updated each second. It is for the eye only: screen readers
 * hear a short "still working" note every 30 seconds instead of every tick.
 */
function Elapsed({ since }: { since: number }): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < ELAPSED_AFTER_SECONDS) return null;
  return <>
    <span className="pf-fr-elapsed" aria-hidden="true"> {seconds} s</span>
    {seconds >= ANNOUNCE_EVERY_SECONDS ? <span className="pf-fr-sr">Still working, {Math.floor(seconds / ANNOUNCE_EVERY_SECONDS) * ANNOUNCE_EVERY_SECONDS} seconds.</span> : null}
  </>;
}

/**
 * A render review in the transcript: "Checked the result" with small previews, collapsed, opening to the full pictures.
 * The pictures are the ones the browser drew for the agent; after a reload only the views are named.
 */
/** The card that proposes a Commons publication of the version just saved, with what will become public. */
function PublishCardView({ card, answer }: { card: PublishCard; answer: (choice: 'publish' | 'edit' | 'cancel') => void }): JSX.Element {
  const { prepared } = card;
  if (card.state === 'published' && card.result) {
    const failed = card.result.failedCollections;
    return <p className="pf-fr-message is-system pf-fr-muted" role="status">Published <a href={card.result.url} target="_blank" rel="noreferrer">{card.result.title}</a>.
      {failed.length ? ` Some collections were not updated: ${failed.join(' ')}` : ''}</p>;
  }
  if (card.state === 'not') return <p className="pf-fr-message is-system pf-fr-muted" role="status">Not published.</p>;
  if (card.state === 'failed') return <p className="pf-fr-message is-system pf-fr-muted" role="status">Not published. {card.reason}</p>;
  const license = prepared.license;
  return <section className="pf-fr-publish" aria-label="Publish to Commons">
    <h3>Publish to Commons</h3>
    <p className="pf-fr-muted">Private cloud revision {prepared.revision}</p>
    {prepared.picture ? <img className="pf-fr-publish-picture" src={prepared.picture} alt="Listing picture: the current view" /> : null}
    <dl>
      <dt>Title</dt><dd>{prepared.title}</dd>
      <dt>Description</dt><dd className="pf-fr-publish-description">{prepared.description || 'None'}</dd>
      <dt>Category</dt><dd>{prepared.category}</dd>
      <dt>License</dt><dd>{license ? <>{license.url ? <a href={license.url} target="_blank" rel="noreferrer">{license.name}</a> : license.name}. {license.summary}</> : `Keeps its source licenses: ${(prepared.retained ?? []).join(', ')}`}</dd>
      <dt>Collections</dt><dd>{prepared.collections.length ? prepared.collections.map(collection => collection.isNew ? `${collection.name} (new, private)` : collection.name).join(', ') : 'None'}</dd>
    </dl>
    <p className="pf-fr-muted">Publishing makes this model public{license ? ` under ${license.name}` : ' under its source licenses'}. Copies others make keep that license even if you unpublish it later. Publishing confirms you have the right to share it.</p>
    <div className="pf-fr-clone-actions">
      <button type="button" className="pf-fr-primary" disabled={card.state !== 'pending'} onClick={() => answer('publish')}>{prepared.update ? 'Publish changes' : 'Publish model'}</button>
      <button type="button" disabled={card.state !== 'pending'} onClick={() => answer('edit')}>Edit details</button>
      <button type="button" disabled={card.state !== 'pending'} onClick={() => answer('cancel')}>Cancel</button>
    </div>
    {card.state === 'open' ? <p role="status" className="pf-fr-muted">Publishing in the dialog…</p> : null}
  </section>;
}

/**
 * The card that asks before a clone. The clone's name can be changed until it is confirmed. Copying within the document
 * is offered beside cloning, since "copy this" can mean either.
 */
function CloneCardView({ card, names, answer }: { card: CloneCard; names: Map<string, string>; answer: (choice: CloneChoice) => void }): JSX.Element {
  const [name, setName] = useState(names.get(card.id) ?? card.name);
  const within = card.documentType === 'layout' ? 'Copy within this drawing' : 'Copy within this model';
  if (card.state !== 'pending') {
    const text = card.state === 'cloning' ? `Cloning to ${card.name}…` : card.state === 'cloned' ? `Cloned to ${card.name}.`
      : card.state === 'copy' ? 'Copying within this document instead.' : card.state === 'failed' ? `Not cloned. ${card.reason ?? ''}`.trim() : 'Not cloned.';
    return <p className="pf-fr-message is-system pf-fr-muted pf-fr-clone-result" role="status">{text}{card.state === 'cloned' && card.show
      ? <> <button type="button" className="pf-fr-link" onClick={card.show}>Show it</button></> : null}</p>;
  }
  return <section className="pf-fr-clone" aria-label="Clone this document?">
    <h3>Clone this document?</h3>
    <p>A copy of <strong>{card.from}</strong> opens in a new tab as an unsaved document, and the chat continues there. {card.from} does not change.</p>
    <label>Name of the copy<input value={name} maxLength={CLONE_NAME_MAX_CHARS} onChange={event => { setName(event.target.value); names.set(card.id, event.target.value); }} /></label>
    <div className="pf-fr-clone-actions">
      <button type="button" className="pf-fr-primary" disabled={!name.trim()} onClick={() => answer('clone')}>Clone document</button>
      <button type="button" onClick={() => answer('copy')}>{within}</button>
      <button type="button" onClick={() => answer('cancel')}>Cancel</button>
    </div>
  </section>;
}
function ReviewLine({ entry }: { entry: Extract<Entry, { role: 'review' }> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const src = (image: ToolImage): string => `data:${image.mime};base64,${image.data}`;
  const named = (index: number): string => entry.views[index] ?? `view ${index + 1}`;
  return <div className="pf-fr-message is-system pf-fr-review">
    <button type="button" className="pf-fr-review-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span>Checked the result</span>
      {entry.images.length ? <span className="pf-fr-review-thumbs" aria-hidden="true">{entry.images.map((image, index) => <img key={index} src={src(image)} alt="" />)}</span> : null}
    </button>
    {open ? (entry.images.length
      ? <div className="pf-fr-review-pictures">{entry.images.map((image, index) => <figure key={index}><img src={src(image)} alt={`Render, ${named(index)}`} /><figcaption>{named(index)}</figcaption></figure>)}</div>
      : <p className="pf-fr-muted">Pictures are not kept after the reply. Views: {entry.views.join('; ')}.</p>) : null}
  </div>;
}

/** The pictures of a sent message: from their files when sent here, otherwise downloaded by id. */
function SentPictures({ entry, client, previews }: { entry: Message & { readonly local?: readonly AttachmentFile[] | undefined }; client: RequestsClient; previews: ReadonlyMap<string, Blob> }): JSX.Element | null {
  const items = entry.local ?? entry.pictures ?? [];
  if (!items.length) return null;
  return <ul className="pf-fr-sent-pictures" aria-label="Pictures">{items.map((item, index) => <li key={'id' in item ? item.id : `local-${index}`}>
    <AttachmentPreview item={item} client={client} blob={'blob' in item ? item.blob : previews.get(item.id)} />
  </li>)}</ul>;
}

/** CORS downloads become local previews, independent of signed-link expiry and COEP image blocking. */
function AttachmentPreview({ item, client, blob }: { item: Attachment | AttachmentFile | { readonly id: string; readonly name: string }; client: RequestsClient; blob: Blob | undefined }): JSX.Element | null {
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

const icon = (path: JSX.Element): JSX.Element => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{path}</svg>;
const PLUS_ICON = icon(<path d="M12 5v14M5 12h14" />);
const RETURN_ICON = icon(<path d="M19 6v5a3 3 0 0 1-3 3H6m4-4-4 4 4 4" />);
const MIC_ICON = icon(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></>);
