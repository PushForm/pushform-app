// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
// @pushform/requests-ui: AI Chat, docked in editors and popped down on Home
export const PACKAGE = '@pushform/requests-ui';

export { RequestsClient, RequestsError, parseEventStream, normalizeConversation, formatBytes, ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_REPORT, DOCUMENT_TYPE, SCREENSHOT_TYPES } from './client';
export type {
  RequestsClientOptions, ErrorCode, ConversationKind, ConversationPath, IntentPath, ConversationStatus, EffectiveRole, ChangeClass, Area,
  FeatureBrief, ProblemReport, Brief, ScreenInfo, Me, ConversationSummary, Message, Conversation, FiledRequest, StreamEvent,
  DocumentDescriptor, ToolCall, ToolCallResult, Attachment, AttachmentKind, AttachmentFile,
} from './client';
export { readDrafts, rememberDraft, forgetDraft, draftScope, DRAFT_TTL_MS, HOME_SCOPE } from './drafts';
export type { DraftRecord } from './drafts';
export { Chat } from './Chat';
export type { ChatProps, DocumentCopy, DocumentToolSession, DocumentToolOutcome } from './Chat';
export { Popover } from './Popover';
export type { PopoverProps } from './Popover';
export { DockedPanel } from './DockedPanel';
export type { DockedPanelProps } from './DockedPanel';
export { useKeyIsolation } from './useKeyIsolation';
export type { KeyIsolationOptions } from './useKeyIsolation';
