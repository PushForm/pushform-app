// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
export const PACKAGE = '@pushform/requests-core';

// Configuration
export * from './config/schema.ts';
export * from './config/load.ts';
export * from './config/sample.ts';
// Domain
export * from './domain/types.ts';
export * from './domain/roles.ts';
export * from './domain/eligibility.ts';
export * from './domain/states.ts';
export * from './domain/classes.ts';
export * from './domain/issue.ts';
// Adapters (architecture §6.3)
export * from './adapters/signature.ts';
export * from './adapters/tracker.ts';
export * from './adapters/linear.ts';
export * from './adapters/mail.ts';
export * from './adapters/resend.ts';
export * from './adapters/resend-receiving.ts';
export * from './adapters/standard-webhook.ts';
// Requester emails
export * from './mail/templates.ts';
// Backend handlers (workstream C)
export * from './backend/conversation.ts';
export * from './backend/webhooks.ts';
export * from './backend/sweeper.ts';
export * from './backend/db.ts';
export * from './backend/auth.ts';
export * from './backend/outbox.ts';
export * from './backend/effects.ts';
// Agents (workstream D)
export * from './agents/client.ts';
export * from './agents/help.ts';
export * from './agents/open.ts';
export * from './agents/intake.ts';
export * from './agents/problem.ts';
export * from './agents/digest.ts';
export * from './agents/brief.ts';
export * from './agents/store.ts';

export * from './guidance.ts';
